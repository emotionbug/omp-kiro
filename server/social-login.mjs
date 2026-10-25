import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fetchWithRetry, isPreconnectNetworkError, isTlsError, isTransientResponse } from "./network.mjs";

const AUTH = "https://prod.us-east-1.auth.desktop.kiro.dev";
const PORTAL = "https://app.kiro.dev/signin";
const PROVIDERS = { google: "Google", github: "Github" };

export class SocialLoginError extends Error {
  constructor(message) {
    super(message);
    this.name = "SocialLoginError";
  }
}

function fail(message) {
  return new SocialLoginError(message);
}

function positive(value) {
  return Number.isFinite(value) && value > 0;
}

function requiredString(value) {
  return typeof value === "string" && value.length > 0;
}

function scope(signal, timeoutMs, message) {
  if (!positive(timeoutMs) || timeoutMs > 2_147_483_647)
    throw fail("Invalid authentication timeout.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(fail(message)), timeoutMs);
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

// User interaction hooks are cancellable even when a host hook ignores its signal.
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
  });
}

async function post(path, body, { signal, fetchImpl, requestTimeoutMs, retry }) {
  if (!positive(requestTimeoutMs) || requestTimeoutMs > 300_000)
    throw fail("Invalid authentication timeout.");
  try {
    return await fetchWithRetry(fetchImpl, `${AUTH}${path}`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json", "user-agent": "omp-kiro" },
      body: JSON.stringify(body),
    }, {
      retry,
      idleTimeoutMs: requestTimeoutMs,
      // DNS/connect failures cannot have consumed this single-use credential.
      // Once connected, a lost response or timeout must never replay it.
      retryNetwork: (error, { responseReceived }) => !responseReceived && isPreconnectNetworkError(error),
      retryStatus: (status, response) => path === "/refreshToken" && (status === 429 || status === 503) &&
        isTransientResponse(status, response),
      async consume(response) {
        let result;
        try {
          result = await response.json();
        } catch {
          signal?.throwIfAborted();
          throw fail(`Kiro authentication returned invalid JSON (HTTP ${response.status}).`);
        }
        if (!result || typeof result !== "object" || Array.isArray(result))
          throw fail("Kiro authentication returned an invalid response.");
        return { response, result };
      },
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SocialLoginError) throw error;
    if (isTlsError(error))
      throw fail("Kiro authentication TLS certificate verification failed; check the approved CA configuration.");
    if (error.code === "ETIMEDOUT") throw fail("Kiro authentication request timed out.");
    // Never retain a fetch error/cause containing request URLs, codes or tokens.
    throw fail("Cannot reach Kiro authentication service.");
  }
}

function providerName(provider) {
  if (!Object.hasOwn(PROVIDERS, provider))
    throw fail("Social authentication supports only Google and GitHub.");
  return PROVIDERS[provider];
}

function credentials(result, provider, now, previous) {
  if (
    !requiredString(result.accessToken) ||
    !requiredString(result.refreshToken ?? previous?.refresh_token) ||
    (result.refreshToken !== undefined && !requiredString(result.refreshToken)) ||
    !positive(result.expiresIn) ||
    !Number.isFinite(now() + result.expiresIn * 1000) ||
    (result.profileArn != null && !requiredString(result.profileArn))
  )
    throw fail("Kiro authentication returned incomplete credentials.");
  const expires = new Date(now() + result.expiresIn * 1000);
  if (!Number.isFinite(expires.getTime()))
    throw fail("Kiro authentication returned an invalid expiry.");
  return {
    kind: "social",
    provider,
    access_token: result.accessToken,
    refresh_token: result.refreshToken ?? previous?.refresh_token,
    expires_at: expires.toISOString(),
    region: "us-east-1",
    ...((result.profileArn ?? previous?.profile_arn)
      ? { profile_arn: result.profileArn ?? previous.profile_arn }
      : {}),
  };
}

/** Refreshes a canonical Google/GitHub record; never persists credentials. */
export async function refreshSocial({
  credential,
  signal,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  requestTimeoutMs = 30_000,
  retry,
} = {}) {
  providerName(credential?.provider);
  if (credential.kind !== "social" || !requiredString(credential.refresh_token))
    throw fail("No social refresh credential is available; sign in again.");
  const { response, result } = await post(
    "/refreshToken",
    {
      refreshToken: credential.refresh_token,
    },
    { signal, fetchImpl, requestTimeoutMs, retry },
  );
  if (!response.ok)
    throw fail(`Kiro credential refresh failed (HTTP ${response.status}); sign in again.`);
  signal?.throwIfAborted();
  return credentials(result, credential.provider, now, credential);
}

function verificationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("Invalid Kiro device verification URL.");
  }
  if (
    url.origin !== "https://app.kiro.dev" ||
    url.pathname !== "/account/device" ||
    url.username ||
    url.password ||
    url.hash
  )
    throw fail("Invalid Kiro device verification URL.");
  return url.href;
}

async function deviceLogin(options) {
  const { provider, signal, now, onInstructions, sleep } = options;
  const { response, result } = await post(
    "/oauth/device/authorization",
    {
      clientId: "kiro-cli",
      loginProvider: providerName(provider),
    },
    options,
  );
  if (!response.ok) throw fail(`Kiro device authorization failed (HTTP ${response.status}).`);
  if (
    !requiredString(result.deviceCode) ||
    !requiredString(result.userCode) ||
    !positive(result.expiresInMilliseconds) ||
    !positive(result.intervalInMilliseconds)
  )
    throw fail("Kiro device authorization returned incomplete instructions.");
  const expires = now() + result.expiresInMilliseconds;
  if (!Number.isFinite(new Date(expires).getTime()))
    throw fail("Kiro device authorization returned an invalid expiry.");
  const device = scope(
    signal,
    Math.min(result.expiresInMilliseconds, 2_147_483_647),
    "Kiro device authorization expired; start a new login.",
  );
  try {
    const deviceOptions = { ...options, signal: device.signal };
    await abortable(
      onInstructions({
        completionMode: "device",
        authorizationUrl: verificationUrl(result.verificationUriComplete),
        verificationUri: verificationUrl(result.verificationUri),
        userCode: result.userCode,
        expiresAt: new Date(expires).toISOString(),
      }),
      device.signal,
    );
    let interval = result.intervalInMilliseconds;
    for (;;) {
      if (now() + interval >= expires)
        throw fail("Kiro device authorization expired; start a new login.");
      await abortable(sleep(interval, { signal: device.signal }), device.signal);
      const poll = await post(
        "/oauth/device/poll",
        {
          clientId: "kiro-cli",
          deviceCode: result.deviceCode,
        },
        deviceOptions,
      );
      const status = poll.result.status ?? poll.result.error;
      if (status === "authorization_pending") {
        if (!poll.response.ok && poll.response.status !== 400)
          throw fail(`Kiro device polling failed (HTTP ${poll.response.status}).`);
        continue;
      }
      if (status === "slow_down" || poll.response.status === 429) {
        interval += 5000;
        continue;
      }
      if (status === "access_denied") throw fail("Kiro authorization was denied.");
      if (status === "expired_token" || status === "invalid_token")
        throw fail("Kiro device authorization expired or is invalid; start a new login.");
      if (!poll.response.ok)
        throw fail(`Kiro device polling failed (HTTP ${poll.response.status}).`);
      if (!requiredString(poll.result.accessToken) || !requiredString(poll.result.refreshToken))
        throw fail("Kiro device authorization returned incomplete credentials.");
      if (
        poll.result.identityProvider != null &&
        (typeof poll.result.identityProvider !== "string" ||
          poll.result.identityProvider.toLowerCase() !== provider)
      )
        throw fail("Kiro authorized a different sign-in provider.");
      // The observed pending schema has no expiry. Obtain authoritative expiresIn
      // through the shared refresh service instead of guessing a token lifetime.
      if (poll.result.expiresIn == null) {
        return await refreshSocial({
          ...deviceOptions,
          credential: {
            kind: "social",
            provider,
            refresh_token: poll.result.refreshToken,
            profile_arn: poll.result.profileArn,
          },
        });
      }
      return credentials(poll.result, provider, now);
    }
  } finally {
    device.close();
  }
}

function sameState(actual, expected) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function callbackCode(value, redirectUri, state, provider) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("Invalid authentication callback URL.");
  }
  const expected = new URL(redirectUri);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password ||
    url.hash
  )
    throw fail("Authentication callback does not match the requested redirect.");
  for (const key of ["state", "code", "error", "login_option"])
    if (url.searchParams.getAll(key).length > 1)
      throw fail("Authentication callback contains duplicate parameters.");
  if (!sameState(url.searchParams.get("state"), state))
    throw fail("Authentication callback state did not match.");
  if (url.searchParams.get("login_option") !== provider)
    throw fail("Authentication callback provider did not match.");
  if (url.searchParams.has("error")) {
    if (url.searchParams.get("error") === "access_denied")
      throw fail("Kiro authorization was denied.");
    throw fail("Kiro authorization failed.");
  }
  const code = url.searchParams.get("code");
  if (!requiredString(code)) throw fail("Authentication callback is missing its code.");
  return code;
}

async function browserLogin(options) {
  const { provider, signal, mode, port, requestCallback, onInstructions, now, timeoutMs } = options;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  let server, redirectBase, accept, reject;
  let callback = new Promise((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  // Register an observer before any asynchronous instructions can reject it.
  callback.catch(() => {});
  try {
    if (mode === "loopback") {
      server = createServer((request, response) => {
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.setHeader("connection", "close");
        if (
          request.method !== "GET" ||
          request.headers.host !== new URL(redirectBase).host ||
          !request.url?.startsWith("/oauth/callback?")
        ) {
          response.writeHead(404).end("Not found.");
          return;
        }
        try {
          const code = callbackCode(
            `${redirectBase}${request.url}`,
            redirectUri(),
            state,
            provider,
          );
          response.end("Authentication received. You can close this window.");
          accept(code);
        } catch (error) {
          response.writeHead(400).end("Invalid authentication callback.");
          // Ignore unsolicited/incorrect state, but deliver a valid-state denial.
          let url;
          try {
            url = new URL(request.url, redirectBase);
          } catch {
            return;
          }
          if (sameState(url.searchParams.get("state"), state) && url.searchParams.has("error"))
            reject(error);
        }
      });
      server.requestTimeout = 5000;
      server.headersTimeout = 5000;
      await abortable(
        new Promise((resolve, reject) => {
          server.once("error", () =>
            reject(fail("Cannot bind the loopback callback port; use device or manual login.")),
          );
          server.listen(port ?? 0, "127.0.0.1", resolve);
        }),
        signal,
      );
      redirectBase = `http://127.0.0.1:${server.address().port}`;
    } else {
      if (typeof requestCallback !== "function")
        throw fail("Manual login requires a requestCallback function.");
      redirectBase = `http://127.0.0.1:${port ?? 3128}`;
    }
    function redirectUri() {
      return `${redirectBase}/oauth/callback?login_option=${provider}`;
    }
    const authorization = new URL(PORTAL);
    authorization.search = new URLSearchParams({
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: redirectBase,
      redirect_from: "kirocli",
      signin_methods: provider,
    }).toString();
    const instructions = {
      completionMode: mode,
      authorizationUrl: authorization.href,
      redirectUri: redirectUri(),
      expiresAt: new Date(now() + timeoutMs).toISOString(),
    };
    await abortable(onInstructions(instructions), signal);
    if (mode === "manual") {
      callback = abortable(requestCallback({ ...instructions, signal }), signal).then((value) =>
        callbackCode(value, redirectUri(), state, provider),
      );
    }
    const code = await abortable(callback, signal);
    const { response, result } = await post(
      "/oauth/token",
      {
        code,
        codeVerifier: verifier,
        redirectUri: redirectUri(),
      },
      options,
    );
    if (!response.ok)
      throw fail(`Kiro authorization code exchange failed (HTTP ${response.status}).`);
    if (
      result.expiresIn == null &&
      requiredString(result.accessToken) &&
      requiredString(result.refreshToken)
    ) {
      return await refreshSocial({
        ...options,
        credential: {
          kind: "social",
          provider,
          refresh_token: result.refreshToken,
          profile_arn: result.profileArn,
        },
      });
    }
    return credentials(result, provider, now);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

/**
 * Own Kiro social acquisition. Default device mode needs no listener or browser
 * launcher. onInstructions receives {completionMode,authorizationUrl,expiresAt},
 * plus {verificationUri,userCode} for device or {redirectUri} for browser modes.
 * Manual mode calls requestCallback({...instructions,signal}) for a full URL.
 * Hosts may open the URL themselves; this module never launches another process.
 */
export async function loginSocial({
  provider = "google",
  mode = "device",
  signal,
  onInstructions,
  requestCallback,
  port,
  timeoutMs = 600_000,
  requestTimeoutMs = 30_000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms, { signal }) => delay(ms, undefined, { signal }),
} = {}) {
  providerName(provider);
  if (!["device", "loopback", "manual"].includes(mode))
    throw fail("Unsupported social authentication completion mode.");
  if (typeof onInstructions !== "function")
    throw fail("Social login requires an onInstructions function.");
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < (mode === "manual" ? 1 : 0) || port > 65535)
  )
    throw fail("Invalid loopback callback port.");
  const login = scope(signal, timeoutMs, "Kiro authentication timed out; start a new login.");
  try {
    const options = {
      provider,
      mode,
      signal: login.signal,
      onInstructions,
      requestCallback,
      port,
      timeoutMs,
      requestTimeoutMs,
      fetchImpl,
      now,
      sleep,
    };
    return await (mode === "device" ? deviceLogin(options) : browserLogin(options));
  } finally {
    login.close();
  }
}
