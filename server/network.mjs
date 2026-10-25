import { X509Certificate } from "node:crypto";
import { open } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import timers from "node:timers/promises";

const MAX_CA_BYTES = 4 * 1024 * 1024;
let approvedCaPath;
let approvedTls;

function invalidCa() {
  return Object.assign(new Error(
    "Kiro TLS CA configuration is unreadable or malformed; check NODE_EXTRA_CA_CERTS.",
  ), { code: "KIRO_TLS_CA_INVALID" });
}

async function readApprovedTls(file) {
  try {
    const handle = await open(file, "r");
    let pem;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CA_BYTES) throw invalidCa();
      // Match the bounded catalog-reader convention, including a growth sentinel.
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) throw invalidCa();
      pem = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } finally {
      await handle.close();
    }
    let end = 0;
    let count = 0;
    const certificates = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/g;
    for (const match of pem.matchAll(certificates)) {
      if (pem.slice(end, match.index).trim()) throw invalidCa();
      const encoded = match[1].replace(/\s/g, "");
      const der = Buffer.from(encoded, "base64");
      if (der.toString("base64") !== encoded || !new X509Certificate(der).raw.equals(der))
        throw invalidCa();
      count++;
      end = match.index + match[0].length;
    }
    if (!count || pem.slice(end).trim()) throw invalidCa();
    // Bun's explicit ca replaces its defaults: keep Mozilla roots as well.
    return { ca: [...rootCertificates, pem], rejectUnauthorized: true };
  } catch {
    // Never attach filesystem/OpenSSL causes: they may contain paths or PEM data.
    throw invalidCa();
  }
}

async function fetchWithApprovedCa(url, init, file) {
  const signal = init?.signal ?? (url instanceof Request ? url.signal : undefined);
  signal?.throwIfAborted();
  // The package writes immutable, hash-named bundles. Keep only the current
  // path's promise (including failures), sharing parsing across concurrent calls.
  if (approvedCaPath !== file) {
    approvedCaPath = file;
    approvedTls = readApprovedTls(file);
    // A cancelled waiter must not leave a later shared-load rejection unhandled.
    approvedTls.catch(() => {});
  }
  const pending = approvedTls;
  const tls = signal
    ? await abortableRequest(() => pending, signal)
    : await pending;
  signal?.throwIfAborted();
  return globalThis.fetch(url, { ...init, tls });
}

/** Only Bun needs an explicit CA option; Node keeps its native startup CA policy. */
export function defaultFetch(url, init) {
  if (!process.versions.bun || !process.env.NODE_EXTRA_CA_CERTS)
    return globalThis.fetch(url, init);
  return fetchWithApprovedCa(url, init, process.env.NODE_EXTRA_CA_CERTS);
}

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const transientCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND",
  "ENETDOWN", "ENETRESET", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ConnectionRefused", "FailedToOpenSocket", "DNSLookupFailed", "ETIMEOUT", "ConnectionClosed",
]);

// Only these failures establish that no connection accepted a single-use token.
const preconnectCodes = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "ConnectionRefused", "FailedToOpenSocket", "DNSLookupFailed",
]);

export const isTransientStatus = (status) => transientStatuses.has(status);

export function isPermanentServiceError(code, message = "") {
  return /quota|usage[_-]?limit[_-]?exceeded|credit|payment|invalid|denied|unauthor|forbidden|permission|modelnotfound|serialization|validation|malformed/i.test(code ?? "") ||
    /quota|monthly.*limit|insufficient.*credit|payment required/i.test(message);
}

export async function isTransientResponse(status, response) {
  if (!isTransientStatus(status)) return false;
  if (isPermanentServiceError(response.headers.get("x-amzn-errortype"))) return false;
  let data;
  try {
    data = await response.clone().json();
  } catch (error) {
    // Plain-text temporary HTTP responses are common. A lost body, unlike an
    // invalid JSON body on an explicit rejection, is not proof of safe delivery.
    if (!(error instanceof SyntaxError)) throw error;
  }
  return !isPermanentServiceError(
    data?.__type ?? data?.code ?? (typeof data?.error === "string" ? data.error : data?.error?.code),
    data?.message ?? data?.Message ?? data?.error_description ?? "",
  );
}

export function isTlsError(error) {
  const visited = new Set();
  for (let cause = error, depth = 0; cause && !visited.has(cause) && depth < 8; cause = cause.cause, depth++) {
    visited.add(cause);
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(cause.code ?? "")) return true;
    if (/certificate verif|self[- ]signed certificate|unable to verify.*certificate/i.test(cause.message ?? "")) return true;
  }
  return false;
}

export function isTransientNetworkError(error) {
  if (isTlsError(error)) return false;
  const visited = new Set();
  let transient = false;
  for (let cause = error, depth = 0; cause && !visited.has(cause) && depth < 8; cause = cause.cause, depth++) {
    visited.add(cause);
    // Never retry a certificate/trust/protocol failure disguised as fetch failed.
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(cause.code ?? "")) return false;
    if (cause.name === "AbortError" || cause.name === "TimeoutError") return false;
    if (transientCodes.has(cause.code)) transient = true;
  }
  return transient || (error instanceof TypeError && !error.cause && error.message === "fetch failed");
}

export function isPreconnectNetworkError(error) {
  if (!isTransientNetworkError(error)) return false;
  const visited = new Set();
  let preconnect = false;
  for (let cause = error; cause && !visited.has(cause); cause = cause.cause) {
    visited.add(cause);
    if (preconnectCodes.has(cause.code) || (cause.code === "ETIMEDOUT" && cause.syscall === "connect"))
      preconnect = true;
    else if (transientCodes.has(cause.code)) return false;
  }
  return preconnect;
}

export function retryAfterMs(headers, now = Date.now()) {
  const value = headers?.get("retry-after");
  if (!value) return undefined;
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function bounded(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new RangeError(`Kiro HTTP network setting must be an integer between ${min} and ${max}.`);
  return number;
}

export function retryPolicy(options = {}, env = process.env) {
  const attempts = options.maxAttempts !== undefined ? options.maxAttempts : env.OMP_KIRO_HTTP_MAX_ATTEMPTS;
  // null is the public unbounded-until-abort policy, not a very large budget.
  const maxAttempts = attempts == null || attempts === "" || attempts === "unlimited"
    ? null
    : bounded(attempts, null, 1, 5);
  return {
    maxAttempts,
    baseDelayMs: bounded(options.baseDelayMs ?? env.OMP_KIRO_HTTP_RETRY_BASE_MS, 30_000, 0, 30_000),
    maxDelayMs: bounded(options.maxDelayMs ?? env.OMP_KIRO_HTTP_RETRY_MAX_MS, 30_000, 0, 30_000),
  };
}

export function requestScope(signal, idleTimeoutMs) {
  signal?.throwIfAborted();
  const timeoutMs = bounded(idleTimeoutMs ?? process.env.OMP_KIRO_HTTP_IDLE_TIMEOUT_MS, 45_000, 1, 300_000);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  const touch = () => {
    clearTimeout(timer);
    if (!combined.aborted) timer = setTimeout(() => controller.abort(
      Object.assign(new Error("Kiro HTTP socket timed out waiting for response data."), { code: "ETIMEDOUT" }),
    ), timeoutMs);
  };
  touch();
  return { signal: combined, touch, close: () => clearTimeout(timer) };
}

export async function abortableRequest(operation, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }),
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

// Call only around a replay-safe boundary, never a host tool execution or an
// entire multi-tool turn. Published output requires explicit continuation/reset.
export async function retryOperation(operation, {
  signal, retry, shouldRetry = isTransientNetworkError, onRetry,
} = {}) {
  const policy = retryPolicy(retry);
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      if ((policy.maxAttempts !== null && attempt >= policy.maxAttempts) || !shouldRetry(error)) throw error;
      const after = error.retryAfterMs ?? retryAfterMs(error.response?.headers);
      if (after !== undefined && (!Number.isFinite(after) || after < 0)) throw error;
      // Retry-After is a lower bound, even beyond the configured backoff cap.
      const backoff = policy.baseDelayMs === 0
        ? 0 : Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(attempt - 1, 30));
      const wait = Math.max(after ?? 0, backoff);
      await error.response?.body?.cancel().catch(() => {});
      signal?.throwIfAborted();
      if (onRetry) {
        const info = { attempt: attempt + 1, maxAttempts: policy.maxAttempts, delayMs: wait };
        if (signal) await abortableRequest(() => onRetry(info), signal);
        else await onRetry(info);
        signal?.throwIfAborted();
      }
      try {
        // Node timers overflow above 2^31-1 ms; preserve long server deadlines.
        for (let remaining = wait; remaining > 0;) {
          const chunk = Math.min(remaining, 2_147_483_647);
          await timers.setTimeout(chunk, undefined, { signal });
          remaining -= chunk;
        }
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }
  }
}

export async function fetchWithRetry(fetchImpl, url, init, {
  retry, retryNetwork = true, consume = (response) => response, retryStatus = isTransientResponse, idleTimeoutMs,
  prepareRequest = (request) => request,
} = {}) {
  let responseReceived = false;
  try {
    return await retryOperation(async () => {
      responseReceived = false;
      const prepared = await prepareRequest(init);
      const request = requestScope(init.signal, idleTimeoutMs);
      try {
        const response = await abortableRequest(
          () => fetchImpl(url, { ...prepared, signal: request.signal }), request.signal,
        );
        responseReceived = true;
        request.touch();
        if (await abortableRequest(() => retryStatus(response.status, response), request.signal)) {
          const error = new Error("Temporary Kiro HTTP failure");
          error.response = response;
          throw error;
        }
        return await abortableRequest(() => consume(response, request.touch), request.signal);
      } finally {
        request.close();
      }
    }, {
      signal: init.signal,
      retry,
      shouldRetry: (error) => Boolean(error.response) ||
        (typeof retryNetwork === "function"
          ? retryNetwork(error, { responseReceived }) : retryNetwork && isTransientNetworkError(error)),
    });
  } catch (error) {
    if (error.response) return consume(error.response);
    throw error;
  }
}
