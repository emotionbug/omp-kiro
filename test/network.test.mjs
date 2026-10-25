import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchWithRetry, isPreconnectNetworkError, isTransientNetworkError, isTransientStatus,
  retryAfterMs, retryOperation, retryPolicy,
} from "../server/network.mjs";

const fast = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };

test("retry policy accepts explicit configuration and rejects out-of-range inputs", () => {
  assert.deepEqual(retryPolicy({}, {}), { maxAttempts: null, baseDelayMs: 30000, maxDelayMs: 30000 });
  assert.equal(retryPolicy({ maxAttempts: null }, { OMP_KIRO_HTTP_MAX_ATTEMPTS: "1" }).maxAttempts, null);
  assert.equal(retryPolicy({}, { OMP_KIRO_HTTP_MAX_ATTEMPTS: "unlimited" }).maxAttempts, null);
  assert.deepEqual(retryPolicy({}, {
    OMP_KIRO_HTTP_MAX_ATTEMPTS: "2", OMP_KIRO_HTTP_RETRY_BASE_MS: "20", OMP_KIRO_HTTP_RETRY_MAX_MS: "40",
  }), { maxAttempts: 2, baseDelayMs: 20, maxDelayMs: 40 });
  assert.deepEqual(retryPolicy({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 30000 }, {}), {
    maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 30000,
  });
  for (const options of [{ maxAttempts: 0 }, { maxAttempts: 6 }, { baseDelayMs: -1 }, { maxDelayMs: Infinity }])
    assert.throws(() => retryPolicy(options, {}), RangeError);
});

test("Retry-After seconds and HTTP dates can extend beyond the backoff cap", async (t) => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  assert.equal(retryAfterMs(new Headers({ "retry-after": "1.5" }), now), 1500);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Sun, 25 Oct 2026 00:00:02 GMT" }), now), 2000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "nonsense" }), now), undefined);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = fetchWithRetry(async () => {
    calls++;
    return new Response(null, calls === 1
      ? { status: 429, headers: { "retry-after": "3600" } } : { status: 200 });
  }, "https://fixture.invalid", {}, { retry: fast });
  await new Promise(setImmediate);
  t.mock.timers.tick(3_599_999);
  await new Promise(setImmediate);
  assert.equal(calls, 1, "a long server delay is neither capped nor failed early");
  t.mock.timers.tick(1);
  assert.equal((await pending).status, 200);
  assert.equal(calls, 2);
});

test("network classification never retries cancellation, TLS trust, parsing or arbitrary exceptions", () => {
  assert.equal(isTransientNetworkError(Object.assign(new Error("reset"), { code: "ECONNRESET" })), true);
  assert.equal(isTransientNetworkError(new TypeError("fetch failed")), true);
  for (const error of [
    new DOMException("cancelled", "AbortError"),
    new Error("Truncated AWS event stream"),
    new SyntaxError("Invalid JSON"),
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("trust"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
    }),
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("trust"), {
        code: "ECONNRESET", cause: Object.assign(new Error("trust"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
      }),
    }),
  ]) assert.equal(isTransientNetworkError(error), false);
});

test("a replay-safe operation exhausts its configured attempt count", async () => {
  let calls = 0;
  const error = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  await assert.rejects(retryOperation(async () => { calls++; throw error; }, { retry: fast }),
    (failure) => failure === error);
  assert.equal(calls, 3);
});

test("status-only OAuth retry never replays an ambiguous network failure", async () => {
  let calls = 0;
  const error = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  await assert.rejects(fetchWithRetry(async () => { calls++; throw error; }, "https://fixture.invalid", {}, {
    retry: fast, retryNetwork: false,
  }), (failure) => failure === error);
  assert.equal(calls, 1);
});

test("default offline recovery retries past three attempts at a fixed 30-second cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const notices = [];
  const pending = retryOperation(async () => {
    calls++;
    if (calls <= 5) throw Object.assign(new Error("offline"), { code: "ENOTFOUND" });
    return "recovered";
  }, { onRetry: (info) => notices.push(info) });
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise(setImmediate);
    assert.equal(calls, attempt);
    t.mock.timers.tick(29_999);
    await new Promise(setImmediate);
    assert.equal(calls, attempt);
    t.mock.timers.tick(1);
  }
  assert.equal(await pending, "recovered");
  assert.deepEqual(notices.map(({ maxAttempts, delayMs }) => [maxAttempts, delayMs]),
    Array.from({ length: 5 }, () => [null, 30_000]));
});

test("cancellation interrupts the default 30-second sleep without another attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const reason = new Error("caller stopped");
  let calls = 0;
  const pending = retryOperation(async () => {
    calls++;
    throw Object.assign(new Error("offline"), { code: "EAI_AGAIN" });
  }, { signal: controller.signal });
  const rejected = assert.rejects(pending, (error) => error === reason);
  await new Promise(setImmediate);
  controller.abort(reason);
  await rejected;
  t.mock.timers.tick(30_000);
  assert.equal(calls, 1);
});

test("offline/connect failures are safe before auth delivery, socket drops and generic timeouts are not", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "DNSLookupFailed"]) {
    const error = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("private"), { code }) });
    assert.equal(isTransientNetworkError(error), true);
    assert.equal(isPreconnectNetworkError(error), true);
  }
  assert.equal(isPreconnectNetworkError(Object.assign(new Error("connect"), {
    code: "ETIMEDOUT", syscall: "connect",
  })), true);
  for (const code of ["ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO"])
    assert.equal(isPreconnectNetworkError(Object.assign(new Error("private"), { code })), false);
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isTransientStatus(status), true);
  for (const status of [400, 401, 403, 404, 501, 505]) assert.equal(isTransientStatus(status), false);
});

test("permanent service codes are terminal even when carried by a transient HTTP status", async () => {
  for (const [status, code] of [
    [429, "ServiceQuotaExceededException"], [503, "InvalidGrantException"],
    [500, "AccessDeniedException"], [503, "ValidationException"],
  ]) {
    let calls = 0;
    const result = await fetchWithRetry(async () => {
      calls++;
      return Response.json({ __type: code, message: "fixture-private-response" }, { status });
    }, "https://fixture.invalid", {}, { retry: fast });
    assert.equal(result.status, status);
    assert.equal((await result.json()).__type, code, "classification preserves the original response body");
    assert.equal(calls, 1);
  }
});

test("temporary rate limits are not mistaken for permanent quota rejection", async () => {
  let calls = 0;
  const result = await fetchWithRetry(async () => {
    calls++;
    return calls === 1
      ? Response.json({ __type: "RateLimitExceededException" }, { status: 429 })
      : Response.json({ recovered: true });
  }, "https://fixture.invalid", {}, { retry: fast });
  assert.equal(calls, 2);
  assert.deepEqual(await result.json(), { recovered: true });
});
