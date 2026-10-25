import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { loginSocial, refreshSocial, SocialLoginError } from "../server/social-login.mjs";

const AUTH = "https://prod.us-east-1.auth.desktop.kiro.dev";
const time = Date.parse("2026-01-01T00:00:00Z");
const token = {
  accessToken: "fixture-access",
  refreshToken: "fixture-refresh",
  expiresIn: 3600,
  profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
};
const device = {
  deviceCode: "fixture-private-device",
  userCode: "FIXT-URE1",
  verificationUri: "https://app.kiro.dev/account/device",
  verificationUriComplete: "https://app.kiro.dev/account/device?user_code=FIXT-URE1",
  expiresInMilliseconds: 300_000,
  intervalInMilliseconds: 5000,
};

async function upstream(t, handle) {
  const calls = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ path: request.url, body });
      const answer = await handle(request.url, body, calls.length);
      response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    } catch {
      response.writeHead(500).end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    fetchImpl(url, options) {
      assert.equal(new URL(url).origin, AUTH);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["content-type"], "application/json");
      assert.ok(options.signal);
      return fetch(`${origin}${new URL(url).pathname}`, options);
    },
  };
}

function callback(instructions, changes = {}) {
  const authorization = new URL(instructions.authorizationUrl);
  const result = new URL(instructions.redirectUri);
  result.searchParams.set("state", authorization.searchParams.get("state"));
  result.searchParams.set("code", "fixture-secret-code");
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) result.searchParams.delete(key);
    else result.searchParams.set(key, value);
  }
  return result.href;
}

function clock() {
  let elapsed = 0;
  const waits = [];
  return {
    now: () => time + elapsed,
    waits,
    async sleep(ms, { signal }) {
      signal.throwIfAborted();
      waits.push(ms);
      elapsed += ms;
    },
  };
}

test("social device flow uses real mock HTTP, provider-specific initiation and pending/slow_down timing", async (t) => {
  const f = await upstream(t, (path, body, count) => {
    if (path.endsWith("authorization")) {
      assert.deepEqual(body, { clientId: "kiro-cli", loginProvider: "Github" });
      return { body: device };
    }
    assert.deepEqual(body, { clientId: "kiro-cli", deviceCode: device.deviceCode });
    return {
      body:
        count === 2
          ? { status: "authorization_pending" }
          : count === 3
            ? { status: "slow_down" }
            : { ...token, identityProvider: "Github", status: "authorized" },
    };
  });
  const c = clock();
  let instructions;
  const result = await loginSocial({
    provider: "github",
    fetchImpl: f.fetchImpl,
    ...c,
    onInstructions: (value) => {
      instructions = value;
    },
  });
  assert.equal(instructions.completionMode, "device");
  assert.equal(instructions.authorizationUrl, device.verificationUriComplete);
  assert.equal(instructions.userCode, device.userCode);
  assert.equal("deviceCode" in instructions, false);
  assert.deepEqual(c.waits, [5000, 5000, 10000]);
  assert.equal(result.kind, "social");
  assert.equal(result.provider, "github");
  assert.equal(result.expires_at, new Date(time + 20_000 + 3_600_000).toISOString());
});

test("device success without expiry obtains authoritative lifetime through refresh", async (t) => {
  const f = await upstream(t, (path) => ({
    body: path.endsWith("authorization")
      ? device
      : path.endsWith("poll")
        ? { accessToken: token.accessToken, refreshToken: token.refreshToken, status: "authorized" }
        : token,
  }));
  const result = await loginSocial({ ...clock(), fetchImpl: f.fetchImpl, onInstructions() {} });
  assert.equal(result.access_token, token.accessToken);
  assert.equal(f.calls[2].path, "/refreshToken");
  assert.deepEqual(f.calls[2].body, { refreshToken: token.refreshToken });
});

test("device denial, expired token, invalid token and unknown response stop polling without leaking data", async (t) => {
  for (const status of [
    "access_denied",
    "expired_token",
    "invalid_token",
    "unexpected-fixture-secret",
  ]) {
    const f = await upstream(t, (path) => ({
      body: path.endsWith("authorization") ? device : { status },
    }));
    await assert.rejects(
      loginSocial({ ...clock(), fetchImpl: f.fetchImpl, onInstructions() {} }),
      (error) => {
        assert.ok(error instanceof SocialLoginError);
        assert.doesNotMatch(error.message, /fixture-private|unexpected-fixture/);
        return true;
      },
    );
    assert.equal(f.calls.length, 2);
  }
});

test("device expiry stops before polling after the deadline", async (t) => {
  const f = await upstream(t, () => ({ body: { ...device, expiresInMilliseconds: 5000 } }));
  await assert.rejects(
    loginSocial({ ...clock(), fetchImpl: f.fetchImpl, onInstructions() {} }),
    /expired/,
  );
  assert.equal(f.calls.length, 1);
});

test("device verification links cannot redirect users to another host or protocol", async (t) => {
  for (const verificationUriComplete of [
    "http://app.kiro.dev/account/device",
    "https://evil.invalid/account/device",
  ]) {
    const f = await upstream(t, () => ({ body: { ...device, verificationUriComplete } }));
    let shown = false;
    await assert.rejects(
      loginSocial({
        ...clock(),
        fetchImpl: f.fetchImpl,
        onInstructions() {
          shown = true;
        },
      }),
      /verification URL/,
    );
    assert.equal(shown, false);
  }
});

test("device cancellation interrupts a noncooperative instruction hook", async (t) => {
  const f = await upstream(t, () => ({ body: device }));
  const controller = new AbortController();
  const pending = loginSocial({
    fetchImpl: f.fetchImpl,
    signal: controller.signal,
    onInstructions() {
      controller.abort();
      return new Promise(() => {});
    },
  });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.calls.length, 1);
});

test("actual loopback callback exchanges exact redirect and S256 PKCE and closes listener", async (t) => {
  let instructions;
  const f = await upstream(t, (path, body) => {
    assert.equal(path, "/oauth/token");
    assert.equal(body.code, "fixture-secret-code");
    assert.equal(body.redirectUri, instructions.redirectUri);
    assert.match(body.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
    const authorization = new URL(instructions.authorizationUrl);
    assert.equal(authorization.origin, "https://app.kiro.dev");
    assert.equal(authorization.pathname, "/signin");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      authorization.searchParams.get("code_challenge"),
      createHash("sha256").update(body.codeVerifier).digest("base64url"),
    );
    assert.equal(authorization.searchParams.get("redirect_from"), "kirocli");
    assert.equal(authorization.searchParams.get("signin_methods"), "google");
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      new URL(instructions.redirectUri).origin,
    );
    return { body: token };
  });
  const result = await loginSocial({
    mode: "loopback",
    now: () => time,
    fetchImpl: f.fetchImpl,
    async onInstructions(value) {
      instructions = value;
      const wrong = await fetch(callback(value, { state: "wrong-fixture-state" }));
      assert.equal(wrong.status, 400);
      assert.doesNotMatch(await wrong.text(), /wrong-fixture-state|fixture-secret-code/);
      const right = await fetch(callback(value));
      assert.equal(right.status, 200);
    },
  });
  assert.equal(result.access_token, token.accessToken);
  await assert.rejects(fetch(new URL(instructions.redirectUri).origin));
});

test("manual remote completion validates callback URL before sending its code", async (t) => {
  let instructions;
  const f = await upstream(t, () => ({ body: token }));
  const result = await loginSocial({
    provider: "github",
    mode: "manual",
    fetchImpl: f.fetchImpl,
    onInstructions(value) {
      instructions = value;
    },
    async requestCallback(value) {
      assert.equal(value.completionMode, "manual");
      assert.equal(value.redirectUri, instructions.redirectUri);
      assert.ok(value.signal);
      return callback(value);
    },
  });
  assert.equal(result.provider, "github");
  assert.equal(f.calls.length, 1);
});

test("manual callbacks reject wrong redirect, state, provider, duplicates, missing code, and denial", async () => {
  for (const mutate of [
    (value) => callback(value).replace("127.0.0.1", "localhost"),
    (value) => callback(value).replace("/oauth/callback", "/other"),
    (value) => `${callback(value)}#fragment`,
    (value) => `${callback(value)}&code=duplicate-private-code`,
    (value) => callback(value, { state: "wrong-private-state" }),
    (value) => callback(value, { login_option: "github" }),
    (value) => callback(value, { code: null }),
    (value) => callback(value, { error: "access_denied", code: null }),
  ]) {
    let fetched = false;
    await assert.rejects(
      loginSocial({
        mode: "manual",
        onInstructions() {},
        requestCallback(value) {
          return mutate(value);
        },
        fetchImpl() {
          fetched = true;
          throw Error("must not fetch");
        },
      }),
      (error) => {
        assert.doesNotMatch(
          error.message,
          /fixture-secret-code|duplicate-private-code|wrong-private-state/,
        );
        return error instanceof SocialLoginError;
      },
    );
    assert.equal(fetched, false);
  }
});

test("valid-state denial arrives over actual loopback and cleans up", async () => {
  let uri;
  await assert.rejects(
    loginSocial({
      mode: "loopback",
      async onInstructions(value) {
        uri = value.redirectUri;
        const response = await fetch(callback(value, { code: null, error: "access_denied" }));
        assert.equal(response.status, 400);
      },
      fetchImpl() {
        throw Error("must not fetch");
      },
    }),
    /denied/,
  );
  await assert.rejects(fetch(new URL(uri).origin));
});

test("loopback bind conflict fails explicitly without displaying an unsafe redirect", async (t) => {
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  let shown = false;
  await assert.rejects(
    loginSocial({
      mode: "loopback",
      port: occupied.address().port,
      onInstructions() {
        shown = true;
      },
    }),
    /bind.*device or manual/,
  );
  assert.equal(shown, false);
});

test("loopback timeout and cancellation close the callback listener", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let uri;
    await assert.rejects(
      loginSocial({
        mode: "loopback",
        timeoutMs: 50,
        signal: controller.signal,
        onInstructions(value) {
          uri = value.redirectUri;
          if (cancel) controller.abort();
        },
      }),
      cancel ? { name: "AbortError" } : /timed out/,
    );
    assert.ok(uri);
    await assert.rejects(fetch(new URL(uri).origin));
  }
});

test("refresh is shared across social providers, preserves unrotated refresh/profile and uses fixed TLS endpoint", async (t) => {
  const f = await upstream(t, (path, body) => {
    assert.equal(path, "/refreshToken");
    assert.deepEqual(body, { refreshToken: token.refreshToken });
    return { body: { accessToken: "fixture-new", expiresIn: 600 } };
  });
  const result = await refreshSocial({
    now: () => time,
    fetchImpl: f.fetchImpl,
    credential: {
      kind: "social",
      provider: "github",
      refresh_token: token.refreshToken,
      profile_arn: token.profileArn,
    },
  });
  assert.equal(result.provider, "github");
  assert.equal(result.refresh_token, token.refreshToken);
  assert.equal(result.profile_arn, token.profileArn);
  assert.equal(result.expires_at, new Date(time + 600_000).toISOString());
});

test("refresh sanitizes HTTP and transport failures and rejects malformed token lifetime", async () => {
  const credential = { kind: "social", provider: "google", refresh_token: token.refreshToken };
  for (const fetchImpl of [
    async () => Response.json({ message: "fixture-private-response" }, { status: 401 }),
    async () => {
      throw Error("fixture-private-transport");
    },
    async () => Response.json({ ...token, expiresIn: -1 }),
    async () => Response.json({ ...token, refreshToken: null }),
  ]) {
    await assert.rejects(refreshSocial({ credential, fetchImpl }), (error) => {
      assert.doesNotMatch(error.message, /fixture-private/);
      return error instanceof SocialLoginError;
    });
  }
});

test("network timeout and pre-aborted login stop without credentials or invocation", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  await assert.rejects(
    loginSocial({
      signal: controller.signal,
      onInstructions() {},
      fetchImpl() {
        fetched = true;
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(fetched, false);
  await assert.rejects(
    loginSocial({
      requestTimeoutMs: 10,
      onInstructions() {},
      fetchImpl: () => new Promise(() => {}),
    }),
    /request timed out/,
  );
});

test("refresh retries explicit temporary rejection with identical credential, not ambiguous disconnects", async () => {
  const credential = { kind: "social", provider: "google", refresh_token: token.refreshToken };
  const bodies = [];
  const refreshed = await refreshSocial({
    credential,
    now: () => time,
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      if (bodies.length === 1)
        return new Response("temporarily unavailable", { status: 503, headers: { "retry-after": "0" } });
      return Response.json(token);
    },
  });
  assert.equal(refreshed.access_token, token.accessToken);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  let calls = 0;
  await assert.rejects(refreshSocial({
    credential,
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: async () => {
      calls++;
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error(token.refreshToken), { code: "ECONNRESET" }),
      });
    },
  }), (error) => error instanceof SocialLoginError && !error.message.includes(token.refreshToken));
  assert.equal(calls, 1);
});

test("a single-use social authorization code is never automatically exchanged twice", async () => {
  let calls = 0;
  await assert.rejects(loginSocial({
    mode: "manual",
    onInstructions() {},
    requestCallback: async (instructions) => callback(instructions),
    fetchImpl: async () => {
      calls++;
      return Response.json({ message: "Temporary rejection" }, { status: 503 });
    },
  }), SocialLoginError);
  assert.equal(calls, 1);
});

test("social refresh waits through a long DNS outage at the default 30-second cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bodies = [];
  const pending = refreshSocial({
    credential: { kind: "social", provider: "google", refresh_token: token.refreshToken },
    now: () => time,
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      if (bodies.length <= 4) throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("private DNS"), { code: "EAI_AGAIN" }),
      });
      return Response.json(token);
    },
  });
  for (let attempt = 1; attempt <= 4; attempt++) {
    await new Promise(setImmediate);
    assert.equal(bodies.length, attempt);
    t.mock.timers.tick(30_000);
  }
  assert.equal((await pending).access_token, token.accessToken);
  assert.equal(bodies.length, 5);
  assert.equal(new Set(bodies).size, 1);
});

test("authorization-code exchange retries only before connection, never after an ambiguous drop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bodies = [];
  const pending = loginSocial({
    mode: "manual", now: () => time, onInstructions() {},
    requestCallback: async (instructions) => callback(instructions),
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      if (bodies.length === 1) throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("private"), { code: "ECONNREFUSED" }),
      });
      return Response.json(token);
    },
  });
  await new Promise(setImmediate);
  assert.equal(bodies.length, 1);
  t.mock.timers.tick(30_000);
  assert.equal((await pending).access_token, token.accessToken);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  let calls = 0;
  await assert.rejects(loginSocial({
    mode: "manual", onInstructions() {},
    requestCallback: async (instructions) => callback(instructions),
    fetchImpl: async () => {
      calls++;
      throw Object.assign(new Error(token.refreshToken), { code: "ECONNRESET" });
    },
  }), (failure) => failure instanceof SocialLoginError && !failure.message.includes(token.refreshToken));
  assert.equal(calls, 1);
});

test("social refresh does not hide permanent credential rejection behind HTTP 503", async () => {
  let calls = 0;
  await assert.rejects(refreshSocial({
    credential: { kind: "social", provider: "google", refresh_token: token.refreshToken },
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: async () => {
      calls++;
      return Response.json({ error: "invalid_grant", message: token.refreshToken }, { status: 503 });
    },
  }), (error) => error instanceof SocialLoginError && !error.message.includes(token.refreshToken));
  assert.equal(calls, 1);
});
