import assert from "node:assert/strict";
import { test } from "node:test";
import { loginDevice, refreshOidc, OidcLoginError } from "../server/oidc-login.mjs";

const INITIAL = Date.parse("2026-01-01T00:00:00Z");
const registration = {
  clientId: "fixture-client",
  clientSecret: "fixture-client-secret",
  clientSecretExpiresAt: INITIAL / 1000 + 86400,
};
const device = {
  deviceCode: "fixture-device-code",
  userCode: "FIXTURE-CODE",
  verificationUri: "https://view.awsapps.com/start/#/device",
  verificationUriComplete: "https://view.awsapps.com/start/#/device?user_code=FIXTURE-CODE",
  expiresIn: 600,
  interval: 1,
};
const issued = { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 3600 };
const existing = {
  kind: "oidc",
  provider: "identity-center",
  region: "eu-west-1",
  start_url: "https://fixture.awsapps.com/start",
  client_id: registration.clientId,
  client_secret: registration.clientSecret,
  registration_expires_at: "2026-01-02T00:00:00.000Z",
  access_token: "fixture-old-access",
  refresh_token: "fixture-old-refresh",
  expires_at: "2025-12-31T00:00:00.000Z",
  profile_arn: "fixture-profile",
};

function error(code, status = 400) {
  return Response.json({ error: code }, { status });
}
function fixture(replies = [registration, device, issued]) {
  let time = INITIAL;
  const requests = [],
    sleeps = [],
    instructions = [];
  return {
    requests,
    sleeps,
    instructions,
    advance(ms) {
      time += ms;
    },
    options: {
      now: () => time,
      sleep: async (ms, signal) => {
        signal?.throwIfAborted();
        sleeps.push(ms);
        time += ms;
      },
      onVerification: (value) => {
        instructions.push(value);
      },
      fetchImpl: async (url, request) => {
        requests.push({ url, ...request, body: JSON.parse(request.body) });
        assert.equal(request.redirect, "error");
        assert.equal(request.method, "POST");
        assert.equal(request.headers.authorization, undefined);
        const next = replies.shift();
        assert.notEqual(next, undefined, "unexpected request");
        if (typeof next === "function") return next(request);
        return next instanceof Response ? next : Response.json(next);
      },
    },
  };
}

for (const provider of ["builder-id", "identity-center"]) {
  test(`${provider} registers a public client and polls the device grant at fixed issuer host`, async () => {
    const f = fixture();
    const enterprise = provider === "identity-center";
    const region = enterprise ? "eu-west-1" : "us-east-1";
    const startUrl = enterprise ? "https://fixture.awsapps.com/start/" : undefined;
    const credential = await loginDevice({ ...f.options, provider, region, startUrl });
    assert.deepEqual(
      f.requests.map((r) => r.url),
      [
        `https://oidc.${region}.amazonaws.com/client/register`,
        `https://oidc.${region}.amazonaws.com/device_authorization`,
        `https://oidc.${region}.amazonaws.com/token`,
      ],
    );
    assert.deepEqual(f.requests[0].body, {
      clientName: "Kiro CLI",
      clientType: "public",
      scopes: [
        "codewhisperer:completions",
        "codewhisperer:analysis",
        "codewhisperer:conversations",
      ],
    });
    assert.deepEqual(f.requests[1].body, {
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      startUrl: enterprise ? "https://fixture.awsapps.com/start" : "https://view.awsapps.com/start",
    });
    assert.deepEqual(f.requests[2].body, {
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      deviceCode: device.deviceCode,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    });
    assert.deepEqual(f.sleeps, [1000]);
    assert.deepEqual(Object.keys(f.instructions[0]).sort(), [
      "expiresAt",
      "interval",
      "userCode",
      "verificationUri",
      "verificationUriComplete",
    ]);
    assert.equal(f.instructions[0].expiresAt, "2026-01-01T00:10:00.000Z");
    assert.equal(f.instructions[0].userCode, device.userCode);
    assert.equal(credential.kind, "oidc");
    assert.equal(credential.provider, provider);
    assert.equal(credential.region, region);
    assert.equal(credential.client_id, registration.clientId);
    assert.equal(credential.client_secret, registration.clientSecret);
    assert.equal(credential.registration_expires_at, "2026-01-02T00:00:00.000Z");
    assert.equal(credential.access_token, issued.accessToken);
    assert.equal(credential.refresh_token, issued.refreshToken);
    assert.equal(credential.expires_at, "2026-01-01T01:00:01.000Z");
    assert.equal(credential.device_code, undefined);
  });
}

test("pending maintains interval and slow_down adds five seconds permanently", async () => {
  const f = fixture([
    registration,
    device,
    error("authorization_pending"),
    error("slow_down"),
    error("authorization_pending"),
    issued,
  ]);
  await loginDevice(f.options);
  assert.deepEqual(f.sleeps, [1000, 1000, 6000, 6000]);
});

test("explicit service rejection backs off without replaying an ambiguous token response", async () => {
  const f = fixture([registration, device, error("unrecognized", 503), issued]);
  await loginDevice(f.options);
  assert.deepEqual(f.sleeps, [1000, 2000]);
  const lost = fixture([registration, device, () => {
    throw new Error("fixture-secret-in-network-message");
  }, issued]);
  await assert.rejects(loginDevice(lost.options),
    (failure) => failure.code === "network_error" && !failure.message.includes("fixture-secret"));
  assert.equal(lost.requests.length, 3, "an ambiguously accepted device token is not polled again");
});

test("missing interval defaults to RFC 8628 five seconds", async () => {
  const f = fixture([registration, { ...device, interval: undefined }, issued]);
  await loginDevice(f.options);
  assert.deepEqual(f.sleeps, [5000]);
});

for (const code of [
  "access_denied",
  "expired_token",
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]) {
  test(`${code} terminates polling without another attempt`, async () => {
    const f = fixture([registration, device, error(code), issued]);
    await assert.rejects(
      loginDevice(f.options),
      (e) => e instanceof OidcLoginError && e.code === code,
    );
    assert.equal(f.requests.length, 3);
  });
}

test("Smithy modeled errors normalize without exposing response descriptions", async () => {
  const f = fixture([
    registration,
    device,
    Response.json(
      {
        __type: "com.amazonaws.ssooidc#AccessDeniedException",
        error_description: "fixture-secret",
      },
      { status: 400 },
    ),
  ]);
  await assert.rejects(
    loginDevice(f.options),
    (e) => e.code === "access_denied" && !e.message.includes("fixture-secret"),
  );
});

test("expiry bounds polling and never sends a request at the deadline", async () => {
  const f = fixture([registration, { ...device, expiresIn: 2 }, error("authorization_pending")]);
  await assert.rejects(loginDevice(f.options), { code: "expired_token" });
  assert.deepEqual(f.sleeps, [1000, 1000]);
  assert.equal(f.requests.length, 3);
});

test("time spent displaying instructions counts against device expiry", async () => {
  const f = fixture([registration, device]);
  await assert.rejects(
    loginDevice({
      ...f.options,
      onVerification() {
        f.advance(600000);
      },
    }),
    { code: "expired_token" },
  );
  assert.equal(f.requests.length, 2);
});

test("abort before registration does not make a request", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(loginDevice({ ...f.options, signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(f.requests.length, 0);
});

test("abort during polling sleep stops before token exchange", async () => {
  const f = fixture(),
    controller = new AbortController();
  await assert.rejects(
    loginDevice({
      ...f.options,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(f.requests.length, 2);
});

test("abort during network I/O retains caller cancellation", async () => {
  const controller = new AbortController();
  const f = fixture([
    (request) =>
      new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
        controller.abort();
      }),
  ]);
  await assert.rejects(loginDevice({ ...f.options, signal: controller.signal }), {
    name: "AbortError",
  });
});

test("abort interrupts an asynchronous verification callback", async () => {
  const f = fixture(),
    controller = new AbortController();
  await assert.rejects(
    loginDevice({
      ...f.options,
      signal: controller.signal,
      onVerification: async () => {
        controller.abort();
        await new Promise(() => {});
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(f.requests.length, 2);
});

for (const overrides of [
  { provider: "google" },
  { region: "localhost" },
  { region: "us-east-1.evil.test" },
  { provider: "builder-id", region: "eu-west-1" },
  { provider: "identity-center" },
  { provider: "builder-id", startUrl: "https://fixture.awsapps.com/start" },
  { provider: "identity-center", startUrl: "http://fixture.awsapps.com/start" },
  { provider: "identity-center", startUrl: "https://fixture.awsapps.com.evil.test/start" },
  { provider: "identity-center", startUrl: "https://user:password@fixture.awsapps.com/start" },
  { provider: "identity-center", startUrl: "https://fixture.awsapps.com/start?redirect=evil" },
  { provider: "identity-center", startUrl: "https://fixture.awsapps.com/other" },
  { onVerification: undefined },
  { requestTimeoutMs: 0 },
  { requestTimeoutMs: 120001 },
]) {
  test(`rejects invalid login boundary ${JSON.stringify(overrides)}`, async () => {
    const f = fixture();
    await assert.rejects(loginDevice({ ...f.options, ...overrides }), OidcLoginError);
    assert.equal(f.requests.length, 0);
  });
}

for (const malformed of [
  { ...device, expiresIn: 0 },
  { ...device, expiresIn: 3601 },
  { ...device, interval: -1 },
  { ...device, interval: 0 },
  { ...device, interval: 999999999 },
  { ...device, deviceCode: "" },
  { ...device, verificationUri: "https://evil.test/device" },
  { ...device, verificationUriComplete: "http://view.awsapps.com/start" },
]) {
  test("rejects malformed device parameters before instructions or polling", async () => {
    const f = fixture([registration, malformed]);
    await assert.rejects(loginDevice(f.options), { code: "invalid_response" });
    assert.equal(f.instructions.length, 0);
    assert.equal(f.requests.length, 2);
  });
}

test("rejects incomplete registration and token responses", async () => {
  for (const replies of [
    [{ clientId: "fixture" }],
    [{ ...registration, clientSecretExpiresAt: INITIAL / 1000 }],
    [registration, device, { ...issued, refreshToken: undefined }],
    [registration, device, { ...issued, expiresIn: -1 }],
    [registration, device, new Response("not-json")],
  ]) {
    const f = fixture(replies);
    await assert.rejects(loginDevice(f.options), { code: "invalid_response" });
  }
});

test("refresh rotates tokens at the credential issuer region and retains registration metadata", async () => {
  const f = fixture([issued]);
  const refreshed = await refreshOidc({ ...f.options, credential: existing });
  assert.equal(f.requests[0].url, "https://oidc.eu-west-1.amazonaws.com/token");
  assert.deepEqual(f.requests[0].body, {
    clientId: existing.client_id,
    clientSecret: existing.client_secret,
    grantType: "refresh_token",
    refreshToken: existing.refresh_token,
  });
  assert.deepEqual(refreshed, {
    ...existing,
    access_token: issued.accessToken,
    refresh_token: issued.refreshToken,
    expires_at: "2026-01-01T01:00:00.000Z",
  });
});

test("refresh without rotation preserves the previous refresh token", async () => {
  const f = fixture([{ accessToken: "fixture-new", expiresIn: 3600 }]);
  const value = await refreshOidc({ ...f.options, credential: existing });
  assert.equal(value.refresh_token, existing.refresh_token);
});

test("expired registration fails before network with actionable login error", async () => {
  const f = fixture();
  await assert.rejects(
    refreshOidc({
      ...f.options,
      credential: { ...existing, registration_expires_at: "2025-01-01T00:00:00Z" },
    }),
    (e) => e.code === "registration_expired" && /log in again/.test(e.message),
  );
  assert.equal(f.requests.length, 0);
});

for (const [upstream, code] of [
  ["invalid_client", "registration_expired"],
  ["unauthorized_client", "registration_expired"],
  ["invalid_grant", "login_expired"],
]) {
  test(`refresh maps ${upstream} to actionable ${code}`, async () => {
    const f = fixture([error(upstream)]);
    await assert.rejects(refreshOidc({ ...f.options, credential: existing }), { code });
    assert.equal(f.requests.length, 1);
  });
}

test("refresh validates kind and rejects network errors without secret output", async () => {
  const f = fixture();
  await assert.rejects(refreshOidc({ ...f.options, credential: { ...existing, kind: "social" } }), {
    code: "invalid_credential",
  });
  assert.equal(f.requests.length, 0);
  await assert.rejects(
    refreshOidc({
      ...f.options,
      credential: existing,
      fetchImpl: async () => {
        throw new Error("fixture-secret");
      },
    }),
    (e) => e.code === "network_error" && !e.message.includes("fixture-secret"),
  );
});

test("request timeout is bounded and refresh reports it without upstream data", async () => {
  await assert.rejects(
    refreshOidc({
      credential: existing,
      now: () => INITIAL,
      requestTimeoutMs: 1,
      fetchImpl: async (_url, request) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        request.signal.throwIfAborted();
      },
    }),
    { code: "request_timeout" },
  );
});

test("timed-out token acquisition is terminal because the device code may already be consumed", async () => {
  const f = fixture([
    registration,
    device,
    async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      request.signal.throwIfAborted();
    },
    issued,
  ]);
  await assert.rejects(loginDevice({ ...f.options, requestTimeoutMs: 1 }), { code: "request_timeout" });
  assert.deepEqual(f.sleeps, [1000]);
  assert.equal(f.requests.length, 3);
});

test("refresh cancellation never becomes a network error", async () => {
  const controller = new AbortController();
  await assert.rejects(
    refreshOidc({
      credential: existing,
      now: () => INITIAL,
      signal: controller.signal,
      fetchImpl: async (_url, request) => {
        controller.abort();
        request.signal.throwIfAborted();
      },
    }),
    { name: "AbortError" },
  );
});

test("optional registration expiry remains absent instead of inventing an expiry", async () => {
  const f = fixture([
    { clientId: registration.clientId, clientSecret: registration.clientSecret },
    device,
    issued,
  ]);
  const credential = await loginDevice(f.options);
  assert.equal(Object.hasOwn(credential, "registration_expires_at"), false);
});

test("OIDC refresh retries explicit unavailability but never replays a lost rotating response", async () => {
  const f = fixture([
    new Response("temporarily unavailable", { status: 503, headers: { "retry-after": "0" } }),
    issued,
  ]);
  const value = await refreshOidc({
    ...f.options,
    credential: existing,
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
  });
  assert.equal(value.access_token, issued.accessToken);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].body, f.requests[1].body);
  let calls = 0;
  await assert.rejects(refreshOidc({
    credential: existing,
    now: () => INITIAL,
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: async () => {
      calls++;
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      });
    },
  }), { code: "network_error" });
  assert.equal(calls, 1);
});

test("OIDC device-code exchange remains owned by polling, without nested transport retries", async () => {
  const f = fixture([
    registration,
    device,
    error("temporarily_unavailable", 503),
    issued,
  ]);
  const credential = await loginDevice(f.options);
  assert.equal(credential.access_token, issued.accessToken);
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/token")).length, 2);
  assert.deepEqual(f.sleeps, [1000, 2000]);
});

test("OIDC refresh recovers a multi-attempt pre-connect outage with the same single-use credential", async () => {
  const requests = [];
  const refreshed = await refreshOidc({
    credential: existing, now: () => INITIAL,
    retry: { maxAttempts: null, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: init.body });
      if (requests.length <= 4) throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("private DNS failure"), { code: "ENOTFOUND" }),
      });
      return Response.json(issued);
    },
  });
  assert.equal(refreshed.access_token, issued.accessToken);
  assert.equal(requests.length, 5);
  assert.ok(requests.every((request) => request.url === requests[0].url && request.body === requests[0].body));
});

test("OIDC token response-body loss is not treated as a new pre-connect attempt", async () => {
  let calls = 0;
  await assert.rejects(refreshOidc({
    credential: existing, now: () => INITIAL,
    retry: { maxAttempts: null, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) {
        controller.error(Object.assign(new Error("private response loss"), { code: "UND_ERR_CONNECT_TIMEOUT" }));
      } }));
    },
  }), (failure) => !failure.message.includes("private"));
  assert.equal(calls, 1);
});

test("OIDC refresh reports a permanent grant failure immediately even when HTTP status is 503", async () => {
  let calls = 0;
  await assert.rejects(refreshOidc({
    credential: existing, now: () => INITIAL,
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: async () => {
      calls++;
      return error("invalid_grant", 503);
    },
  }), { code: "login_expired" });
  assert.equal(calls, 1);
});
