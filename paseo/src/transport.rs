use crate::{auth::Credential, normalize};
use chrono::Utc;
use paseo_plugin::usage::{Problem, Report};
use reqwest::{Certificate, Client};
use serde_json::{Value, json};
use std::{io::Read, path::Path, sync::LazyLock, time::Duration};

const MAX_CA_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const INVALID_CA: &str =
    "Kiro TLS CA configuration is unreadable or malformed; check NODE_EXTRA_CA_CERTS.";

pub(crate) fn error(message: &str) -> Report {
    Report::Error {
        error: message.into(),
    }
}

// Build on a blocking thread: native root loading and extra-CA reads may block.
// The default native roots remain enabled when approved extra roots are added.
pub(crate) fn client() -> Result<Client, &'static str> {
    static CLIENT: LazyLock<Result<Client, &'static str>> = LazyLock::new(|| {
        let extra = std::env::var_os("NODE_EXTRA_CA_CERTS").filter(|v| !v.is_empty());
        client_with_ca(extra.as_deref().map(Path::new))
    });
    CLIENT.clone()
}
fn client_with_ca(extra: Option<&Path>) -> Result<Client, &'static str> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12));
    if let Some(path) = extra {
        for certificate in read_extra_ca(path)? {
            builder = builder.add_root_certificate(certificate);
        }
    }
    builder.build().map_err(|_| {
        if extra.is_some() {
            INVALID_CA
        } else {
            "The Kiro usage service could not be reached."
        }
    })
}
fn read_extra_ca(path: &Path) -> Result<Vec<Certificate>, &'static str> {
    let file = std::fs::File::open(path).map_err(|_| INVALID_CA)?;
    let metadata = file.metadata().map_err(|_| INVALID_CA)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CA_BYTES {
        return Err(INVALID_CA);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize + 1);
    file.take(MAX_CA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| INVALID_CA)?;
    if bytes.len() as u64 != metadata.len() {
        return Err(INVALID_CA);
    }
    parse_extra_ca(&bytes)
}
fn parse_extra_ca(bytes: &[u8]) -> Result<Vec<Certificate>, &'static str> {
    let mut rest = std::str::from_utf8(bytes).map_err(|_| INVALID_CA)?.trim();
    let mut certificates = Vec::new();
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    while !rest.is_empty() {
        let content = rest.strip_prefix(BEGIN).ok_or(INVALID_CA)?;
        let end = content.find(END).ok_or(INVALID_CA)?;
        let encoded = &content[..end];
        if encoded.trim().is_empty()
            || !encoded.bytes().all(|b| {
                b.is_ascii_alphanumeric() || b"+/=".contains(&b) || b.is_ascii_whitespace()
            })
        {
            return Err(INVALID_CA);
        }
        let length = BEGIN.len() + end + END.len();
        certificates
            .push(Certificate::from_pem(rest[..length].as_bytes()).map_err(|_| INVALID_CA)?);
        rest = rest[length..].trim();
    }
    if certificates.is_empty() {
        return Err(INVALID_CA);
    }
    Ok(certificates)
}

enum Endpoint<'a> {
    Service(&'a str),
    #[cfg(test)]
    Fixture(&'a str),
}
impl Endpoint<'_> {
    fn url(&self) -> String {
        match self {
            Self::Service(region) => format!("https://management.{region}.kiro.dev/"),
            #[cfg(test)]
            Self::Fixture(url) => (*url).into(),
        }
    }
}

pub(crate) async fn fetch(client: Client, credential: &Credential) -> Report {
    let region = credential
        .profile_arn
        .as_deref()
        .and_then(|arn| arn.split(':').nth(3))
        .filter(|v| !v.is_empty())
        .unwrap_or("us-east-1");
    if !matches!(region, "us-east-1" | "eu-central-1") {
        return error("Kiro usage does not support this account profile region.");
    }
    request(client, credential, Endpoint::Service(region)).await
}

async fn request(client: Client, credential: &Credential, endpoint: Endpoint<'_>) -> Report {
    let mut body =
        json!({"origin":"KIRO_CLI","resourceType":"AGENTIC_REQUEST","isEmailRequired":false});
    if let Some(profile) = &credential.profile_arn {
        body["profileArn"] = json!(profile);
    }
    let response = client
        .post(endpoint.url())
        .bearer_auth(&credential.access_token)
        .header("content-type", "application/x-amz-json-1.0")
        .header("x-amz-target", "AmazonCodeWhispererService.GetUsageLimits")
        .json(&body)
        .send()
        .await;
    let mut response = match response {
        Ok(response) => response,
        Err(reason) => {
            return error(if reason.is_timeout() {
                "The Kiro usage request timed out."
            } else {
                "The Kiro usage service could not be reached."
            });
        }
    };
    let status = response.status().as_u16();
    // Never decode/forward failure bodies; upstream can echo identities or tokens.
    if status == 401 || status == 403 {
        return Report::Unavailable {
            problem: Problem::Rejected {
                status,
                refreshed_by: Some("omp-kiro".into()),
            },
        };
    }
    if status == 429 {
        return error("Kiro usage is temporarily rate limited.");
    }
    if !response.status().is_success() {
        return error("Kiro rejected the usage request.");
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return error(normalize::Failure::InvalidResponse.message());
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= MAX_RESPONSE_BYTES - bytes.len() => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(Some(_)) => return error(normalize::Failure::InvalidResponse.message()),
            Ok(None) => break,
            Err(reason) => {
                return error(if reason.is_timeout() {
                    "The Kiro usage request timed out."
                } else {
                    "The Kiro usage service could not be reached."
                });
            }
        }
    }
    let payload: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return error(normalize::Failure::InvalidResponse.message()),
    };
    match normalize::normalize(&payload, Utc::now()) {
        Ok(report) => report,
        Err(reason) => error(reason.message()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    // Endpoint injection is compiled only for tests; production always uses the
    // fixed regional HTTPS service, never process/session-controlled URLs.
    fn fixture(
        status: u16,
        response: String,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let count = socket.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(str::trim)
                                .and_then(|v| v.parse().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            tx.send(String::from_utf8(bytes).unwrap()).unwrap();
            write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        });
        (url, rx, handle)
    }
    fn credential() -> Credential {
        Credential {
            access_token: "private-access-token".into(),
            expires_at: chrono::DateTime::parse_from_rfc3339("2099-01-01T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            profile_arn: Some(
                "arn:aws:codewhisperer:eu-central-1:private-account:profile/private-profile".into(),
            ),
            provider: "github",
        }
    }
    fn test_client() -> Client {
        Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn transport_posts_exact_usage_operation_and_normalizes_real_response() {
        let payload = json!({"nextDateReset":4_000_000_000u64,"usageBreakdownList":[{"resourceType":"CREDIT","currentUsageWithPrecision":12.5,"usageLimitWithPrecision":100.0}]}).to_string();
        let (url, received, handle) = fixture(200, payload);
        let report = request(test_client(), &credential(), Endpoint::Fixture(&url)).await;
        let wire = received.recv_timeout(Duration::from_secs(5)).unwrap();
        handle.join().unwrap();
        let (headers, body) = wire.split_once("\r\n\r\n").unwrap();
        let headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with("post / http/1.1"));
        assert!(headers.contains("authorization: bearer private-access-token"));
        assert!(headers.contains("content-type: application/x-amz-json-1.0"));
        assert!(headers.contains("x-amz-target: amazoncodewhispererservice.getusagelimits"));
        assert_eq!(
            serde_json::from_str::<Value>(body).unwrap(),
            json!({"origin":"KIRO_CLI","resourceType":"AGENTIC_REQUEST","isEmailRequired":false,"profileArn":credential().profile_arn})
        );
        let result = serde_json::to_value(report).unwrap();
        assert_eq!(result["balances"][0]["used"], 12.5);
        assert!(!result.to_string().contains("private-"));
    }

    #[tokio::test]
    async fn transport_rejections_and_failures_never_echo_upstream_secrets() {
        for status in [401, 403, 429, 500, 302] {
            let (url, received, handle) =
                fixture(status, "private-access-token private-account".into());
            let report = request(test_client(), &credential(), Endpoint::Fixture(&url)).await;
            received.recv_timeout(Duration::from_secs(5)).unwrap();
            handle.join().unwrap();
            let value = serde_json::to_value(report).unwrap();
            if status == 401 || status == 403 {
                assert_eq!(value["problem"]["kind"], "rejected");
                assert_eq!(value["problem"]["status"], status);
            } else {
                assert_eq!(value["status"], "error");
            }
            assert!(!value.to_string().contains("private-"));
        }
    }

    #[tokio::test]
    async fn transport_malformed_success_and_unsupported_region_are_sanitized() {
        let (url, received, handle) = fixture(200, "private-token-not-json".into());
        let report = request(test_client(), &credential(), Endpoint::Fixture(&url)).await;
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        handle.join().unwrap();
        assert_eq!(
            serde_json::to_value(report).unwrap()["error"],
            normalize::Failure::InvalidResponse.message()
        );
        let mut credential = credential();
        credential.profile_arn = Some(
            "arn:aws:codewhisperer:unsupported:private-account:profile/private-profile".into(),
        );
        assert_eq!(
            serde_json::to_value(fetch(test_client(), &credential).await).unwrap()["error"],
            "Kiro usage does not support this account profile region."
        );
    }

    #[test]
    fn transport_ca_rejects_empty_garbage_keys_truncation_and_nonfiles() {
        for pem in [
            "",
            "garbage",
            "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
            "-----BEGIN CERTIFICATE-----\nAAAA",
            "-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----",
        ] {
            assert!(parse_extra_ca(pem.as_bytes()).is_err());
        }
        let dir = tempfile::tempdir().unwrap();
        assert!(read_extra_ca(dir.path()).is_err());
        assert!(read_extra_ca(&dir.path().join("missing.pem")).is_err());
    }

    #[test]
    fn transport_ca_accepts_public_pem_bundles_and_rejects_trailing_data_and_bad_der() {
        // Public ISRG Root X2, valid 2020-2040; no private test key is needed.
        const CA: &str = "-----BEGIN CERTIFICATE-----\n\
MIICGzCCAaGgAwIBAgIQQdKd0XLq7qeAwSxs6S+HUjAKBggqhkjOPQQDAzBPMQsw\n\
CQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJuZXQgU2VjdXJpdHkgUmVzZWFyY2gg\n\
R3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBYMjAeFw0yMDA5MDQwMDAwMDBaFw00\n\
MDA5MTcxNjAwMDBaME8xCzAJBgNVBAYTAlVTMSkwJwYDVQQKEyBJbnRlcm5ldCBT\n\
ZWN1cml0eSBSZXNlYXJjaCBHcm91cDEVMBMGA1UEAxMMSVNSRyBSb290IFgyMHYw\n\
EAYHKoZIzj0CAQYFK4EEACIDYgAEzZvVn4CDCuwJSvMWSj5cz3es3mcFDR0HttwW\n\
+1qLFNvicWDEukWVEYmO6gbf9yoWHKS5xcUy4APgHoIYOIvXRdgKam7mAHf7AlF9\n\
ItgKbppbd9/w+kHsOdx1ymgHDB/qo0IwQDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0T\n\
AQH/BAUwAwEB/zAdBgNVHQ4EFgQUfEKWrt5LSDv6kviejM9ti6lyN5UwCgYIKoZI\n\
zj0EAwMDaAAwZQIwe3lORlCEwkSHRhtFcP9Ymd70/aTSVaYgLXTWNLxBo1BfASdW\n\
tL4ndQavEi51mI38AjEAi/V3bNTIZargCyzuFJ0nN6T5U6VR5CmD1/iQMVtCnwr1\n\
/q4AaOeMSQ+2b1tbFfLn\n\
-----END CERTIFICATE-----\n";
        assert_eq!(parse_extra_ca(CA.as_bytes()).unwrap().len(), 1);
        assert_eq!(
            parse_extra_ca(format!("{CA}\n{CA}").as_bytes())
                .unwrap()
                .len(),
            2
        );
        assert!(parse_extra_ca(format!("{CA}private-trailing-payload").as_bytes()).is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ca.pem");
        std::fs::write(&path, CA).unwrap();
        assert!(client_with_ca(Some(&path)).is_ok());
        std::fs::write(
            &path,
            "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n",
        )
        .unwrap();
        assert!(client_with_ca(Some(&path)).is_err());
    }
}
