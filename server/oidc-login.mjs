import { setTimeout as delay } from "node:timers/promises";
import { defaultFetch, fetchWithRetry, isPreconnectNetworkError, isTlsError, isTransientResponse } from "./network.mjs";

const BUILDER_START_URL = "https://view.awsapps.com/start";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// Public AWS SSO OIDC scopes; deliberately exclude sso:account:access.
const SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
];
const REGIONS = new Set([
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "af-south-1",
  "ap-east-1",
  "ap-east-2",
  "ap-south-1",
  "ap-south-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "il-central-1",
  "mx-central-1",
  "me-south-1",
  "me-central-1",
  "sa-east-1",
]);

export class OidcLoginError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OidcLoginError";
    this.code = code;
  }
}

function invalid(message) {
  return new OidcLoginError("invalid_response", message);
}

function endpoint(region) {
  if (!REGIONS.has(region))
    throw new OidcLoginError("invalid_region", "Unsupported AWS SSO OIDC region.");
  return `https://oidc.${region}.amazonaws.com`;
}

function portalUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    /* Handled below without echoing input. */
  }
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^[a-z0-9-]+\.awsapps\.com$/.test(url.hostname) ||
    !/^\/start\/?$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new OidcLoginError(
      "invalid_start_url",
      "Use an HTTPS AWS access portal URL ending in /start.",
    );
  return url.href.replace(/\/$/, "");
}

function verificationUrl(value, region) {
  let url;
  try {
    url = new URL(value);
  } catch {
    /* Handled below. */
  }
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      /^[a-z0-9-]+\.awsapps\.com$/.test(url.hostname) ||
      url.hostname === `device.sso.${region}.amazonaws.com`
    )
  )
    throw invalid("OIDC returned an untrusted verification URL.");
  return url.href;
}

function text(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 65536;
}

function seconds(value, max) {
  return Number.isInteger(value) && value > 0 && value <= max;
}

function options({
  signal,
  fetchImpl = defaultFetch,
  now = Date.now,
  requestTimeoutMs = 30000,
}) {
  signal?.throwIfAborted();
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120000)
    throw new OidcLoginError(
      "invalid_timeout",
      "OIDC request timeout must be between 1 and 120000 ms.",
    );
  return { signal, fetchImpl, now, requestTimeoutMs };
}

// Do not expose upstream descriptions or fetch error messages: they may contain codes/secrets.
async function post(base, path, body, opts, deadline = Infinity) {
  opts.signal?.throwIfAborted();
  const remaining = deadline - opts.now();
  if (remaining <= 0)
    throw new OidcLoginError("expired_token", "Device authorization expired; start login again.");
  const expiry = Number.isFinite(remaining) ? AbortSignal.timeout(Math.max(1, remaining)) : undefined;
  const signal = expiry && opts.signal ? AbortSignal.any([opts.signal, expiry]) : expiry ?? opts.signal;
  try {
    const responseData = await fetchWithRetry(opts.fetchImpl, base + path, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json", "user-agent": "omp-kiro" },
      body: JSON.stringify(body),
    }, {
      retry: opts.retry,
      idleTimeoutMs: Math.min(opts.requestTimeoutMs, remaining),
      // Only proven pre-connect failures or explicit rejection are replay-safe.
      retryNetwork: (error, { responseReceived }) => !responseReceived && isPreconnectNetworkError(error),
      retryStatus: (status, response) => body.grantType === "refresh_token" && (status === 429 || status === 503) &&
        isTransientResponse(status, response),
      async consume(response) {
        let result;
        try {
          result = await response.json();
        } catch {
          signal?.throwIfAborted();
          throw invalid("OIDC returned invalid JSON.");
        }
        opts.signal?.throwIfAborted();
        if (!result || typeof result !== "object" || Array.isArray(result))
          throw invalid("OIDC returned an invalid response.");
        return { response, result };
      },
    });
    const { response, result } = responseData;
    if (!response.ok) {
      const known = new Map([
        ["authorization_pending", "authorization_pending"],
        ["AuthorizationPendingException", "authorization_pending"],
        ["slow_down", "slow_down"],
        ["SlowDownException", "slow_down"],
        ["access_denied", "access_denied"],
        ["AccessDeniedException", "access_denied"],
        ["expired_token", "expired_token"],
        ["ExpiredTokenException", "expired_token"],
        ["invalid_client", "invalid_client"],
        ["InvalidClientException", "invalid_client"],
        ["invalid_grant", "invalid_grant"],
        ["InvalidGrantException", "invalid_grant"],
        ["unauthorized_client", "unauthorized_client"],
        ["UnauthorizedClientException", "unauthorized_client"],
      ]);
      const type = typeof result.__type === "string" ? result.__type.split("#").at(-1) : undefined;
      const code =
        known.get(result.error ?? type) ??
        (response.status === 503 || response.status === 429
          ? "temporarily_unavailable"
          : "request_failed");
      throw new OidcLoginError(code, `OIDC request failed (${code}, HTTP ${response.status}).`);
    }
    return result;
  } catch (error) {
    opts.signal?.throwIfAborted();
    if (error instanceof OidcLoginError) throw error;
    if (isTlsError(error))
      throw new OidcLoginError("tls_error", "OIDC TLS certificate verification failed; check the approved CA configuration.");
    if (expiry?.aborted)
      throw new OidcLoginError("expired_token", "Device authorization expired; start login again.");
    if (error.code === "ETIMEDOUT") throw new OidcLoginError("request_timeout", "OIDC request timed out.");
    throw new OidcLoginError(
      "network_error",
      "Cannot reach AWS SSO OIDC; check network/proxy connectivity.",
    );
  }
}

async function verificationCallback(callback, instructions, signal, remaining) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(Math.max(1, remaining));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let onAbort;
  try {
    await Promise.race([
      Promise.resolve().then(() => callback(instructions)),
      new Promise((_, reject) => {
        onAbort = () =>
          reject(
            signal?.aborted
              ? signal.reason
              : new OidcLoginError(
                  "expired_token",
                  "Device authorization expired; start login again.",
                ),
          );
        combined.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    combined.removeEventListener("abort", onAbort);
  }
}

function tokenRecord(result, credential, now) {
  if (
    !text(result.accessToken) ||
    !seconds(result.expiresIn, 31536000) ||
    (result.refreshToken !== undefined && !text(result.refreshToken)) ||
    (!result.refreshToken && !text(credential.refresh_token))
  )
    throw invalid("OIDC returned incomplete credentials.");
  return {
    ...credential,
    access_token: result.accessToken,
    refresh_token: result.refreshToken ?? credential.refresh_token,
    expires_at: new Date(now() + result.expiresIn * 1000).toISOString(),
    ...(text(result.profileArn) ? { profile_arn: result.profileArn } : {}),
  };
}

/** Public-client device authorization, with no browser, CLI or keychain dependency. */
export async function loginDevice({
  provider = "builder-id",
  startUrl,
  region = "us-east-1",
  onVerification,
  signal,
  fetchImpl,
  now,
  requestTimeoutMs,
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
} = {}) {
  const opts = options({ signal, fetchImpl, now, requestTimeoutMs });
  const base = endpoint(region);
  if (provider !== "builder-id" && provider !== "identity-center")
    throw new OidcLoginError(
      "invalid_provider",
      "Device login supports Builder ID or IAM Identity Center.",
    );
  if (typeof onVerification !== "function")
    throw new OidcLoginError(
      "verification_required",
      "Device login requires a verification-instructions callback.",
    );
  const start = portalUrl(startUrl ?? (provider === "builder-id" ? BUILDER_START_URL : ""));
  if ((provider === "builder-id") !== (start === BUILDER_START_URL))
    throw new OidcLoginError(
      "invalid_start_url",
      "The access portal must match the selected account provider.",
    );
  if (provider === "builder-id" && region !== "us-east-1")
    throw new OidcLoginError("invalid_region", "Builder ID device login uses us-east-1.");
  const registration = await post(
    base,
    "/client/register",
    {
      clientName: "Kiro CLI",
      clientType: "public",
      scopes: SCOPES,
    },
    opts,
  );
  if (!text(registration.clientId) || !text(registration.clientSecret))
    throw invalid("OIDC returned an incomplete client registration.");
  let registrationExpiresAt;
  if (registration.clientSecretExpiresAt !== undefined) {
    const expiry = registration.clientSecretExpiresAt * 1000;
    if (
      typeof registration.clientSecretExpiresAt !== "number" ||
      !Number.isFinite(expiry) ||
      expiry <= opts.now() ||
      expiry > 8640000000000000
    )
      throw invalid("OIDC returned an expired or invalid client registration.");
    registrationExpiresAt = new Date(expiry).toISOString();
  }
  const client = { clientId: registration.clientId, clientSecret: registration.clientSecret };
  const device = await post(base, "/device_authorization", { ...client, startUrl: start }, opts);
  if (
    !text(device.deviceCode) ||
    !text(device.userCode) ||
    !seconds(device.expiresIn, 3600) ||
    (device.interval !== undefined && !seconds(device.interval, 3600))
  )
    throw invalid("OIDC returned invalid device authorization parameters.");
  const deadline = opts.now() + device.expiresIn * 1000;
  let interval = (device.interval ?? 5) * 1000;
  await verificationCallback(
    onVerification,
    {
      verificationUri: verificationUrl(device.verificationUri, region),
      verificationUriComplete:
        device.verificationUriComplete === undefined
          ? undefined
          : verificationUrl(device.verificationUriComplete, region),
      userCode: device.userCode,
      expiresAt: new Date(deadline).toISOString(),
      interval: interval / 1000,
    },
    signal,
    deadline - opts.now(),
  );
  const credential = {
    kind: "oidc",
    provider,
    region,
    start_url: start,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    ...(registrationExpiresAt ? { registration_expires_at: registrationExpiresAt } : {}),
  };
  while (true) {
    signal?.throwIfAborted();
    const remaining = deadline - opts.now();
    if (remaining <= 0)
      throw new OidcLoginError("expired_token", "Device authorization expired; start login again.");
    await sleep(Math.min(interval, remaining), signal);
    signal?.throwIfAborted();
    if (opts.now() >= deadline)
      throw new OidcLoginError("expired_token", "Device authorization expired; start login again.");
    try {
      const result = await post(
        base,
        "/token",
        {
          ...client,
          deviceCode: device.deviceCode,
          grantType: DEVICE_GRANT,
        },
        opts,
        deadline,
      );
      if (opts.now() >= deadline)
        throw new OidcLoginError(
          "expired_token",
          "Device authorization expired; start login again.",
        );
      return tokenRecord(result, credential, opts.now);
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === "authorization_pending") continue;
      if (error.code === "slow_down") {
        interval += 5000;
        continue;
      }
      // Pending/explicit safe service rejection can be polled again; a lost
      // token response or timeout may already have consumed the device code.
      if (error.code === "temporarily_unavailable") {
        interval = Math.min(interval * 2, 3600000);
        continue;
      }
      throw error;
    }
  }
}

export async function refreshOidc({ credential, signal, fetchImpl, now, requestTimeoutMs, retry } = {}) {
  const opts = options({ signal, fetchImpl, now, requestTimeoutMs });
  opts.retry = retry;
  if (
    credential?.kind !== "oidc" ||
    !["builder-id", "identity-center"].includes(credential.provider) ||
    !text(credential.client_id) ||
    !text(credential.client_secret) ||
    !text(credential.refresh_token)
  )
    throw new OidcLoginError(
      "invalid_credential",
      "OIDC refresh needs a registered client and refresh credential; log in again.",
    );
  const base = endpoint(credential.region);
  if (
    credential.registration_expires_at !== undefined &&
    !(Date.parse(credential.registration_expires_at) > opts.now())
  )
    throw new OidcLoginError(
      "registration_expired",
      "OIDC client registration expired; log in again to register a new client.",
    );
  try {
    return tokenRecord(
      await post(
        base,
        "/token",
        {
          clientId: credential.client_id,
          clientSecret: credential.client_secret,
          grantType: "refresh_token",
          refreshToken: credential.refresh_token,
        },
        opts,
      ),
      credential,
      opts.now,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === "invalid_client" || error.code === "unauthorized_client")
      throw new OidcLoginError(
        "registration_expired",
        "OIDC client registration is expired or invalid; log in again.",
      );
    if (error.code === "invalid_grant")
      throw new OidcLoginError(
        "login_expired",
        "OIDC refresh credential expired or was revoked; log in again.",
      );
    throw error;
  }
}
