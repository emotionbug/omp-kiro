import { setTimeout as delay } from "node:timers/promises";

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const transientCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
  "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ConnectionRefused", "FailedToOpenSocket", "ETIMEOUT", "ConnectionClosed",
]);

export const isTransientStatus = (status) => transientStatuses.has(status);

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
  return {
    maxAttempts: bounded(options.maxAttempts ?? env.OMP_KIRO_HTTP_MAX_ATTEMPTS, 3, 1, 5),
    baseDelayMs: bounded(options.baseDelayMs ?? env.OMP_KIRO_HTTP_RETRY_BASE_MS, 500, 0, 30_000),
    maxDelayMs: bounded(options.maxDelayMs ?? env.OMP_KIRO_HTTP_RETRY_MAX_MS, 10_000, 0, 30_000),
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

// Call only around a replay-safe boundary. Never wrap a host tool execution or
// an entire multi-tool turn. The caller closes this gate after publishing output.
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
      if (attempt >= policy.maxAttempts || !shouldRetry(error)) throw error;
      const after = error.retryAfterMs ?? retryAfterMs(error.response?.headers);
      // Do not retry earlier than Retry-After, nor wait beyond our finite cap.
      if (after !== undefined && (!Number.isFinite(after) || after > policy.maxDelayMs)) throw error;
      const wait = Math.max(after ?? 0, Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)));
      await error.response?.body?.cancel().catch(() => {});
      signal?.throwIfAborted();
      if (onRetry) {
        const info = { attempt: attempt + 1, maxAttempts: policy.maxAttempts, delayMs: wait };
        if (signal) await abortableRequest(() => onRetry(info), signal);
        else await onRetry(info);
        signal?.throwIfAborted();
      }
      try {
        await delay(wait, undefined, { signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }
  }
}

export async function fetchWithRetry(fetchImpl, url, init, {
  retry, retryNetwork = true, consume = (response) => response, retryStatus = isTransientStatus, idleTimeoutMs,
} = {}) {
  try {
    return await retryOperation(async () => {
      const request = requestScope(init.signal, idleTimeoutMs);
      try {
        const response = await abortableRequest(
          () => fetchImpl(url, { ...init, signal: request.signal }), request.signal,
        );
        request.touch();
        if (retryStatus(response.status)) {
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
      shouldRetry: (error) => Boolean(error.response) || (retryNetwork && isTransientNetworkError(error)),
    });
  } catch (error) {
    if (error.response) return consume(error.response);
    throw error;
  }
}
