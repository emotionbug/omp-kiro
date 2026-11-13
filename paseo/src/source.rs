use crate::{auth, transport};
use chrono::{SecondsFormat, Utc};
use paseo_plugin::{
    CancellationToken,
    usage::{Account, Problem, Report, Scope, hash_account_key},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

const LOGIN_UNAVAILABLE: &str =
    "Kiro HTTP login unavailable. Run omp-kiro login, then refresh usage.";
const CANCELLED: &str = "The Kiro usage request was cancelled.";
const TIMEOUT: &str = "The Kiro usage request timed out.";

fn scope_env(
    scope: Scope,
    global: impl FnOnce() -> BTreeMap<String, String>,
) -> Option<BTreeMap<String, String>> {
    match scope {
        Scope::Global => Some(global()),
        Scope::Session {
            provider,
            model,
            env,
        } => {
            // Preserve the OMP HTTP markers, without claiming CLI/non-HTTP sessions.
            if provider == "kiro-http"
                || env.get("OMP_KIRO_TRANSPORT").is_some_and(|v| v == "http")
                || model
                    .as_deref()
                    .is_some_and(|v| v.starts_with("kiro-http/"))
            {
                Some(env)
            } else {
                None
            }
        }
    }
}

pub(crate) async fn discover(value: Value, cancellation: &CancellationToken) -> Vec<Account> {
    let scope: Scope = match serde_json::from_value(value) {
        Ok(scope) => scope,
        Err(_) => return Vec::new(),
    };
    let env = match scope_env(scope, || {
        ["OMP_KIRO_AUTH_FILE", "XDG_CONFIG_HOME", "HOME"]
            .into_iter()
            .filter_map(|key| Some((key.into(), std::env::var(key).ok()?)))
            .collect()
    }) {
        Some(env) => env,
        None => return Vec::new(),
    };
    discover_env(env, cancellation).await
}
async fn discover_env(
    env: BTreeMap<String, String>,
    cancellation: &CancellationToken,
) -> Vec<Account> {
    if cancellation.is_cancelled() {
        return Vec::new();
    }
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Vec::new(),
        _ = tokio::time::sleep(Duration::from_secs(3)) => Vec::new(),
        result = tokio::task::spawn_blocking(move || {
            let path = auth::auth_path(&env).ok()?.canonicalize().ok()?;
            let credential = auth::read(&path).ok()?;
            let path = path.to_str()?;
            Some(Account {
                key: hash_account_key(path),
                label: Some(format!("Kiro HTTP · {}", credential.provider)),
                harness: Some("Kiro HTTP".into()),
                input: json!({"authFile":path}),
            })
        }) => result.ok().flatten().into_iter().collect(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    auth_file: String,
}

pub(crate) async fn fetch(input: Value, cancellation: &CancellationToken) -> Report {
    let input: Input = match serde_json::from_value(input) {
        Ok(input) => input,
        Err(_) => return transport::error("Invalid Kiro authentication store locator."),
    };
    let path = PathBuf::from(input.auth_file);
    if !path.is_absolute() {
        return transport::error("Invalid Kiro authentication store locator.");
    }
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => transport::error(CANCELLED),
        _ = tokio::time::sleep(Duration::from_secs(15)) => transport::error(TIMEOUT),
        report = fetch_path(path) => report,
    }
}
async fn fetch_path(path: PathBuf) -> Report {
    let credential = match tokio::task::spawn_blocking(move || auth::read(&path)).await {
        Ok(Ok(credential)) => credential,
        _ => return transport::error(LOGIN_UNAVAILABLE),
    };
    if credential.expires_at <= Utc::now() {
        return Report::Unavailable {
            problem: Problem::Expired {
                expires_at: credential
                    .expires_at
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
                refreshed_by: Some("omp-kiro".into()),
            },
        };
    }
    let client = match tokio::task::spawn_blocking(transport::client).await {
        Ok(Ok(client)) => client,
        Ok(Err(message)) => return transport::error(message),
        Err(_) => return transport::error("The Kiro usage service could not be reached."),
    };
    // auth::read has dropped its connection before TLS setup or any HTTP await.
    transport::fetch(client, &credential).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::Path;

    fn store(path: &Path, provider: &str, expires_at: &str) {
        let db = Connection::open(path).unwrap();
        db.execute(
            "CREATE TABLE credentials (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO credentials VALUES ('active', ?1)", [json!({"kind":"social","provider":provider,"access_token":"private-access-token","expires_at":expires_at}).to_string()]).unwrap();
    }
    fn scoped(path: &Path) -> Scope {
        Scope::Session {
            provider: "omp".into(),
            model: Some("kiro-http/auto".into()),
            env: BTreeMap::from([("OMP_KIRO_AUTH_FILE".into(), path.to_str().unwrap().into())]),
        }
    }

    #[tokio::test]
    async fn source_session_auth_is_isolated_and_account_has_no_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = dir.path().join("daemon.db");
        let session = dir.path().join("session.db");
        store(&daemon, "google", "2099-01-01T00:00:00Z");
        store(&session, "github", "2099-01-01T00:00:00Z");
        let env = scope_env(scoped(&session), || {
            panic!("session must not inspect daemon environment")
        })
        .unwrap();
        let accounts = discover_env(env, &CancellationToken::new()).await;
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].label.as_deref(), Some("Kiro HTTP · github"));
        let canonical = session.canonicalize().unwrap();
        assert_eq!(
            accounts[0].key,
            hash_account_key(canonical.to_str().unwrap())
        );
        assert_eq!(
            accounts[0].input,
            json!({"authFile":canonical.to_str().unwrap()})
        );
        assert!(
            !serde_json::to_string(&accounts)
                .unwrap()
                .contains("private-access-token")
        );
        let global = scope_env(Scope::Global, || {
            BTreeMap::from([("OMP_KIRO_AUTH_FILE".into(), daemon.to_str().unwrap().into())])
        })
        .unwrap();
        let accounts = discover_env(global, &CancellationToken::new()).await;
        assert_eq!(accounts[0].label.as_deref(), Some("Kiro HTTP · google"));
        let missing = dir.path().join("missing.db");
        let env = scope_env(scoped(&missing), || panic!("no daemon fallback")).unwrap();
        assert!(
            discover_env(env, &CancellationToken::new())
                .await
                .is_empty()
        );
        assert!(!missing.exists());
    }

    #[test]
    fn source_only_claims_http_scope_markers() {
        for marker in 0..3 {
            let scope = Scope::Session {
                provider: if marker == 0 { "kiro-http" } else { "omp" }.into(),
                model: (marker == 1).then(|| "kiro-http/auto".into()),
                env: if marker == 2 {
                    BTreeMap::from([("OMP_KIRO_TRANSPORT".into(), "http".into())])
                } else {
                    BTreeMap::new()
                },
            };
            assert!(scope_env(scope, || panic!("no global fallback")).is_some());
        }
        assert!(
            scope_env(
                Scope::Session {
                    provider: "omp".into(),
                    model: Some("kiro/auto".into()),
                    env: BTreeMap::new()
                },
                || panic!("no global fallback")
            )
            .is_none()
        );
    }

    #[tokio::test]
    async fn source_expired_is_discovered_and_reported_without_refresh_or_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.db");
        store(&path, "github", "2000-01-01T00:00:00Z");
        let before = std::fs::read(&path).unwrap();
        let env = scope_env(scoped(&path), BTreeMap::new).unwrap();
        let accounts = discover_env(env, &CancellationToken::new()).await;
        assert_eq!(accounts.len(), 1);
        let result = fetch(accounts[0].input.clone(), &CancellationToken::new()).await;
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"status":"unavailable","problem":{"kind":"expired","expiresAt":"2000-01-01T00:00:00.000Z","refreshedBy":"omp-kiro"}})
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn source_input_and_store_errors_are_strict_and_sanitized() {
        for input in [
            Value::Null,
            json!({}),
            json!({"authFile":"relative"}),
            json!({"authFile":123}),
            json!({"authFile":"/valid","accessToken":"private-access-token"}),
        ] {
            let value =
                serde_json::to_value(fetch(input, &CancellationToken::new()).await).unwrap();
            assert_eq!(
                value,
                json!({"status":"error","error":"Invalid Kiro authentication store locator."})
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private-auth-path.db");
        std::fs::write(&path, b"private-access-token invalid sqlite").unwrap();
        let report = fetch(
            json!({"authFile":path.to_str().unwrap()}),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            json!({"status":"error","error":LOGIN_UNAVAILABLE})
        );
    }

    #[tokio::test]
    async fn source_cancellation_precedes_storage_and_network_work() {
        let token = CancellationToken::new();
        token.cancel();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.db");
        let report = fetch(json!({"authFile":path.to_str().unwrap()}), &token).await;
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            json!({"status":"error","error":CANCELLED})
        );
        assert!(!path.exists());
        assert!(discover_env(BTreeMap::new(), &token).await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn source_canonical_aliases_share_an_account_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.db");
        let alias = dir.path().join("alias.db");
        store(&path, "github", "2099-01-01T00:00:00Z");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        let first = discover_env(
            scope_env(scoped(&path), BTreeMap::new).unwrap(),
            &CancellationToken::new(),
        )
        .await;
        let second = discover_env(
            scope_env(scoped(&alias), BTreeMap::new).unwrap(),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(first[0].key, second[0].key);
        assert_eq!(first[0].input, second[0].input);
    }
}
