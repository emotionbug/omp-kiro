import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadKiroAuth } from "../auth.mjs";

async function sqlite(path) {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    return new Database(path);
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path);
}

const now = () => Date.parse("2026-01-01T00:00:00Z");
const original = {
  access_token: "fixture-old-access",
  refresh_token: "fixture-old-refresh",
  expires_at: "2025-12-31T00:00:00Z",
  provider: "google",
  profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
  telemetry_generation: 7,
};

async function fixture(t, record = original, key = "kirocli:social:token") {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "data.sqlite3");
  const db = await sqlite(databasePath);
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(key, JSON.stringify(record));
  db.close();
  return {
    databasePath,
    async read() {
      const db = await sqlite(databasePath);
      try {
        return JSON.parse(db.prepare("SELECT value FROM auth_kv WHERE key = ?").get(key).value);
      } finally {
        db.close();
      }
    },
    async replace(record) {
      const db = await sqlite(databasePath);
      try {
        db.prepare("UPDATE auth_kv SET value = ? WHERE key = ?").run(JSON.stringify(record), key);
      } finally {
        db.close();
      }
    },
  };
}

test("valid local Google token is read without network access", async (t) => {
  const value = { ...original, expires_at: "2026-01-02T00:00:00Z" };
  const f = await fixture(t, value);
  const token = await loadKiroAuth({
    databasePath: f.databasePath,
    now,
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  assert.deepEqual(token, value);
});

test("expired Google login refreshes at fixed TLS endpoint and atomically persists rotation", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const token = await loadKiroAuth({
    databasePath: f.databasePath,
    now,
    fetchImpl: async (url, request) => {
      calls++;
      assert.equal(url, "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
      assert.equal(request.redirect, "error");
      assert.deepEqual(JSON.parse(request.body), { refreshToken: original.refresh_token });
      return Response.json({
        accessToken: "fixture-new-access",
        refreshToken: "fixture-new-refresh",
        expiresIn: 3600,
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(token.access_token, "fixture-new-access");
  assert.equal(token.refresh_token, "fixture-new-refresh");
  assert.equal(token.profile_arn, original.profile_arn);
  assert.equal(token.telemetry_generation, 7);
  assert.equal(token.expires_at, "2026-01-01T01:00:00.000Z");
  assert.deepEqual(await f.read(), token);
});

test("omitted refresh token retains the current refresh credential", async (t) => {
  const f = await fixture(t);
  const token = await loadKiroAuth({
    databasePath: f.databasePath,
    now,
    fetchImpl: async () => Response.json({ accessToken: "fixture-new-access", expiresIn: 3600 }),
  });
  assert.equal(token.refresh_token, original.refresh_token);
});

test("concurrent turns share one refresh without losing rotation", async (t) => {
  const f = await fixture(t);
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const options = {
    databasePath: f.databasePath,
    now,
    fetchImpl: async () => {
      calls++;
      entered();
      await ready;
      return Response.json({
        accessToken: "fixture-new-access",
        refreshToken: "fixture-new-refresh",
        expiresIn: 3600,
      });
    },
  };
  const first = loadKiroAuth(options);
  await started;
  const second = loadKiroAuth(options);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a.access_token, b.access_token);
  assert.equal(b.refresh_token, "fixture-new-refresh");
});

test("a concurrent CLI login is not overwritten by a completed refresh", async (t) => {
  const f = await fixture(t);
  const newLogin = {
    ...original,
    access_token: "fixture-other-login",
    expires_at: "2026-02-01T00:00:00Z",
  };
  await assert.rejects(
    loadKiroAuth({
      databasePath: f.databasePath,
      now,
      fetchImpl: async () => {
        await f.replace(newLogin);
        return Response.json({
          accessToken: "fixture-stale-refresh",
          refreshToken: "fixture-new-refresh",
          expiresIn: 3600,
        });
      },
    }),
    /login changed during refresh/,
  );
  assert.deepEqual(await f.read(), newLogin);
});

test("refresh failures never expose upstream credential-bearing response bodies", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    loadKiroAuth({
      databasePath: f.databasePath,
      now,
      fetchImpl: async () => Response.json({ message: original.refresh_token }, { status: 401 }),
    }),
    (error) => /HTTP 401/.test(error.message) && !error.message.includes(original.refresh_token),
  );
  assert.deepEqual(await f.read(), original);
});

test("invalid refresh response never damages stored credentials", async (t) => {
  for (const result of [
    { accessToken: "new" },
    { accessToken: "new", expiresIn: -1 },
    { accessToken: "new", expiresIn: 3600, refreshToken: 3 },
  ]) {
    const f = await fixture(t);
    await assert.rejects(
      loadKiroAuth({
        databasePath: f.databasePath,
        now,
        fetchImpl: async () => Response.json(result),
      }),
      /incomplete credentials/,
    );
    assert.deepEqual(await f.read(), original);
  }
});

test("unknown login modes, providers and malformed local credentials fail explicitly", async (t) => {
  const cases = [
    [
      { ...original, provider: "unknown" },
      "kirocli:social:token",
      /Unsupported Kiro social login provider/,
    ],
    [original, "kirocli:odic:token", /No supported Kiro social login/],
    [{ ...original, expires_at: "invalid" }, "kirocli:social:token", /Incomplete Kiro/],
    [
      { ...original, refresh_token: undefined },
      "kirocli:social:token",
      /without a refresh credential/,
    ],
  ];
  for (const [value, key, pattern] of cases) {
    const f = await fixture(t, value, key);
    await assert.rejects(
      loadKiroAuth({
        databasePath: f.databasePath,
        now,
        fetchImpl: async () => {
          throw new Error("must not fetch");
        },
      }),
      pattern,
    );
  }
});

test("pre-aborted credential loading does not open storage or fetch", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    loadKiroAuth({
      databasePath: "/must/not/open",
      signal: controller.signal,
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    }),
    /cancelled/,
  );
});
