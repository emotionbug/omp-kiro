import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchWithRetry, isTransientNetworkError, retryAfterMs, retryOperation, retryPolicy,
} from "../server/network.mjs";

const fast = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };

test("retry policy accepts explicit configuration and rejects out-of-range inputs", () => {
  assert.deepEqual(retryPolicy({}, {
    OMP_KIRO_HTTP_MAX_ATTEMPTS: "2", OMP_KIRO_HTTP_RETRY_BASE_MS: "20", OMP_KIRO_HTTP_RETRY_MAX_MS: "40",
  }), { maxAttempts: 2, baseDelayMs: 20, maxDelayMs: 40 });
  assert.deepEqual(retryPolicy({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 30000 }, {}), {
    maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 30000,
  });
  for (const options of [{ maxAttempts: 0 }, { maxAttempts: 6 }, { baseDelayMs: -1 }, { maxDelayMs: Infinity }])
    assert.throws(() => retryPolicy(options, {}), RangeError);
});

test("Retry-After supports seconds and HTTP dates without exceeding the delay cap", async () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  assert.equal(retryAfterMs(new Headers({ "retry-after": "1.5" }), now), 1500);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Sun, 25 Oct 2026 00:00:02 GMT" }), now), 2000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "nonsense" }), now), undefined);
  let calls = 0;
  const response = await fetchWithRetry(async () => {
    calls++;
    return new Response(null, { status: 429, headers: { "retry-after": "3600" } });
  }, "https://fixture.invalid", {}, { retry: fast });
  assert.equal(calls, 1);
  assert.equal(response.status, 429);
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
