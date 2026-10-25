import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  defaultFetch, fetchWithRetry, isPreconnectNetworkError, isTlsError, isTransientNetworkError, isTransientStatus,
  retryAfterMs, retryOperation, retryPolicy,
} from "../server/network.mjs";

const fast = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };

test("retry policy accepts explicit configuration and rejects out-of-range inputs", () => {
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

async function caBoundaryFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.NODE_EXTRA_CA_CERTS;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previous;
  });
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end("unexpected request");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())));
  return {
    directory,
    url: `http://127.0.0.1:${server.address().port}/`,
    requests: () => requests,
  };
}

test("Bun rejects unreadable or malformed approved CA bundles without sending a request", {
  skip: !process.versions.bun,
}, async (t) => {
  const fixture = await caBoundaryFixture(t);
  const invalid = [
    ["empty", ""],
    ["text", "private-malformed-certificate-payload"],
    ["utf8", Buffer.from([0xff])],
    ["der", "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n"],
    ["mixed", `${rootCertificates[0]}\nprivate-trailing-payload`],
  ];
  for (const [name, contents] of invalid)
    await writeFile(join(fixture.directory, name), contents);
  await mkdir(join(fixture.directory, "directory"));
  const oversized = join(fixture.directory, "oversized");
  await writeFile(oversized, "");
  await truncate(oversized, 4 * 1024 * 1024 + 1);
  for (const name of ["missing", "directory", "oversized", ...invalid.map(([name]) => name)]) {
    const path = join(fixture.directory, name);
    process.env.NODE_EXTRA_CA_CERTS = path;
    await assert.rejects(defaultFetch(fixture.url), (error) => {
      assert.equal(error.code, "KIRO_TLS_CA_INVALID");
      assert.equal(error.cause, undefined);
      assert.equal(error.message.includes(path), false);
      assert.equal(error.message.includes("private-"), false);
      assert.equal(isTransientNetworkError(error), false);
      return true;
    });
  }
  assert.equal(fixture.requests(), 0);
});

test("Bun preserves caller abort before and during approved CA loading without sending a request", {
  skip: !process.versions.bun,
}, async (t) => {
  const fixture = await caBoundaryFixture(t);
  process.env.NODE_EXTRA_CA_CERTS = join(fixture.directory, "missing");
  const stopped = new AbortController();
  const reason = new Error("caller stopped CA loading");
  stopped.abort(reason);
  await assert.rejects(defaultFetch(fixture.url, { signal: stopped.signal }), (error) => error === reason);
  const valid = join(fixture.directory, "approved.pem");
  await writeFile(valid, rootCertificates[0]);
  process.env.NODE_EXTRA_CA_CERTS = valid;
  const controller = new AbortController();
  const pending = defaultFetch(new Request(fixture.url, { signal: controller.signal }));
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(fixture.requests(), 0);
});

test("Bun trusts the approved CA but rejects untrusted chains and mismatched hostnames", {
  skip: !process.versions.bun,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.NODE_EXTRA_CA_CERTS;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previous;
  });
  const run = promisify(execFile);
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=Kiro CA boundary fixture",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-keyout", "ca.key", "-out", "ca.pem",
  ], { cwd: directory });
  await run("openssl", [
    "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1",
    "-keyout", "leaf.key", "-out", "leaf.csr",
  ], { cwd: directory });
  await writeFile(join(directory, "leaf.ext"),
    "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  await run("openssl", [
    "x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
    "-CAcreateserial", "-days", "1", "-extfile", "leaf.ext", "-out", "leaf.pem",
  ], { cwd: directory });
  let requests = 0;
  const server = createTlsServer({
    key: await readFile(join(directory, "leaf.key")),
    cert: await readFile(join(directory, "leaf.pem")),
  }, (_request, response) => {
    requests++;
    response.end("approved TLS reached the service");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  t.after(() => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())));
  const port = server.address().port;
  const init = { proxy: false };
  const wrongCa = join(directory, "unrelated.pem");
  await writeFile(wrongCa, rootCertificates[0]);
  process.env.NODE_EXTRA_CA_CERTS = wrongCa;
  await assert.rejects(defaultFetch(`https://127.0.0.1:${port}/`, init), (error) =>
    isTlsError(error) && !isTransientNetworkError(error));
  assert.equal(requests, 0, "An untrusted service received an HTTP request");
  process.env.NODE_EXTRA_CA_CERTS = join(directory, "ca.pem");
  const response = await defaultFetch(`https://127.0.0.1:${port}/`, init);
  assert.equal(await response.text(), "approved TLS reached the service");
  assert.equal(requests, 1);
  await assert.rejects(defaultFetch(`https://127.0.0.2:${port}/`, init), (error) =>
    isTlsError(error) && !isTransientNetworkError(error));
  assert.equal(requests, 1, "A mismatched hostname received an HTTP request");
});
