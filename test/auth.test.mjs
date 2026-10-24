import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KiroAuthError,
  getKiroAuthStatus,
  importCliAuth,
  loadKiroAuth,
  logoutKiroAuth,
  readAuthSnapshot,
  saveKiroAuth,
} from "../auth.mjs";

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
  kind: "social",
  provider: "google",
  access_token: "fixture-old-access",
  refresh_token: "fixture-old-refresh",
  expires_at: "2025-12-31T00:00:00Z",
  profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
  telemetry_generation: 7,
};
async function fixture(t, record = original) {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-managed-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, "private", "auth.sqlite3");
  if (record) await saveKiroAuth(record, { authFile });
  return {
    authFile,
    directory,
    read: async () => JSON.parse(await readAuthSnapshot({ authFile })),
    replace: (value) => saveKiroAuth(value, { authFile }),
  };
}

// No fixture contains a real account credential or contacts a real provider.
test("fresh managed login is used without consulting CLI storage or network", async (t) => {
  const value = { ...original, expires_at: "2026-01-02T00:00:00Z" };
  const f = await fixture(t, value);
  const token = await loadKiroAuth({
    authFile: f.authFile,
    now,
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  assert.deepEqual(token, value);
});

test("expired social login persists rotation and preserves unrelated credential metadata", async (t) => {
  const f = await fixture(t);
  const token = await loadKiroAuth({
    authFile: f.authFile,
    now,
    fetchImpl: async (url, request) => {
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
  assert.equal(token.access_token, "fixture-new-access");
  assert.equal(token.refresh_token, "fixture-new-refresh");
  assert.equal(token.telemetry_generation, 7);
  assert.equal(token.profile_arn, original.profile_arn);
  assert.equal(token.expires_at, "2026-01-01T01:00:00.000Z");
  assert.deepEqual(await f.read(), token);
});

test("omitted refresh token retains the existing refresh credential", async (t) => {
  const f = await fixture(t);
  const token = await loadKiroAuth({
    authFile: f.authFile,
    now,
    fetchImpl: async () => Response.json({ accessToken: "fixture-new-access", expiresIn: 3600 }),
  });
  assert.equal(token.refresh_token, original.refresh_token);
});

test("concurrent requests share one credential refresh", async (t) => {
  const f = await fixture(t);
  const ready = Promise.withResolvers();
  const started = Promise.withResolvers();
  let calls = 0;
  const options = {
    authFile: f.authFile,
    now,
    fetchImpl: async () => {
      calls++;
      started.resolve();
      await ready.promise;
      return Response.json({
        accessToken: "fixture-new-access",
        refreshToken: "fixture-new-refresh",
        expiresIn: 3600,
      });
    },
  };
  const first = loadKiroAuth(options);
  await started.promise;
  const second = loadKiroAuth(options);
  ready.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(b.refresh_token, "fixture-new-refresh");
});

test("refresh cannot overwrite a concurrent independent login", async (t) => {
  const f = await fixture(t);
  const replacement = {
    ...original,
    access_token: "fixture-new-login",
    expires_at: "2026-02-01T00:00:00Z",
  };
  await assert.rejects(
    loadKiroAuth({
      authFile: f.authFile,
      now,
      fetchImpl: async () => {
        await f.replace(replacement);
        return Response.json({
          accessToken: "fixture-stale-refresh",
          refreshToken: "fixture-rotated",
          expiresIn: 3600,
        });
      },
    }),
    KiroAuthError,
  );
  assert.deepEqual(await f.read(), replacement);
});

test("logout cannot be undone by a pending refresh", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    loadKiroAuth({
      authFile: f.authFile,
      now,
      fetchImpl: async () => {
        await logoutKiroAuth({ authFile: f.authFile });
        return Response.json({ accessToken: "fixture-stale-refresh", expiresIn: 3600 });
      },
    }),
    KiroAuthError,
  );
  assert.deepEqual(await getKiroAuthStatus({ authFile: f.authFile, now }), {
    loggedIn: false,
    authFile: f.authFile,
  });
});

test("logout while an initial login is pending prevents credential resurrection", async (t) => {
  const f = await fixture(t, null);
  const snapshot = await readAuthSnapshot({ authFile: f.authFile });
  assert.equal(snapshot, null);
  await logoutKiroAuth({ authFile: f.authFile });
  await assert.rejects(
    saveKiroAuth(original, { authFile: f.authFile, expectedRaw: snapshot }),
    KiroAuthError,
  );
  assert.equal((await getKiroAuthStatus({ authFile: f.authFile })).loggedIn, false);
});

test("missing managed login fails locally without silently using CLI credentials", async (t) => {
  const f = await fixture(t, null);
  await assert.rejects(
    loadKiroAuth({
      authFile: f.authFile,
      now,
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    }),
    KiroAuthError,
  );
  assert.equal((await getKiroAuthStatus({ authFile: f.authFile })).loggedIn, false);
});

test("refresh rejection does not expose token values or damage the stored login", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    loadKiroAuth({
      authFile: f.authFile,
      now,
      fetchImpl: async () => Response.json({ message: original.refresh_token }, { status: 401 }),
    }),
    (error) => !error.message.includes(original.refresh_token),
  );
  assert.deepEqual(await f.read(), original);
});

test("invalid refresh responses leave the current record untouched", async (t) => {
  for (const value of [
    { accessToken: "new" },
    { accessToken: "new", expiresIn: -1 },
    { accessToken: "new", expiresIn: 3600, refreshToken: 3 },
  ]) {
    const f = await fixture(t);
    await assert.rejects(
      loadKiroAuth({ authFile: f.authFile, now, fetchImpl: async () => Response.json(value) }),
    );
    assert.deepEqual(await f.read(), original);
  }
});

test("credential status exposes only safe status fields", async (t) => {
  const f = await fixture(t);
  const status = await getKiroAuthStatus({ authFile: f.authFile, now });
  assert.deepEqual(status, {
    loggedIn: true,
    authFile: f.authFile,
    kind: "social",
    provider: "google",
    expiresAt: original.expires_at,
    expired: true,
    refreshable: true,
  });
  assert.ok(!JSON.stringify(status).includes(original.access_token));
  assert.ok(!JSON.stringify(status).includes(original.refresh_token));
});

test(
  "managed credential file and newly created directory are private",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await stat(f.authFile)).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.directory, "private"))).mode & 0o777, 0o700);
  },
);

test("explicit CLI import copies credentials without changing the CLI database", async (t) => {
  const f = await fixture(t, null);
  const source = join(f.directory, "cli.sqlite3");
  const db = await sqlite(source);
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  const cli = { ...original };
  delete cli.kind;
  const raw = JSON.stringify(cli);
  db.prepare("INSERT INTO auth_kv VALUES (?,?)").run("kirocli:social:token", raw);
  await importCliAuth({ databasePath: source, authFile: f.authFile });
  assert.deepEqual(await f.read(), original);
  assert.equal(
    db.prepare("SELECT value FROM auth_kv WHERE key=?").get("kirocli:social:token").value,
    raw,
  );
  db.close();
});

test("an empty interrupted store can be initialized by a new login", async (t) => {
  const f = await fixture(t, null);
  const source = join(f.directory, "empty.sqlite3");
  await writeFile(source, "");
  assert.equal(await readAuthSnapshot({ authFile: source }), null);
  await saveKiroAuth(original, { authFile: source, expectedRaw: null });
  assert.equal((await getKiroAuthStatus({ authFile: source, now })).provider, "google");
});

test("pre-aborted loading never creates storage", async (t) => {
  const f = await fixture(t, null);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    loadKiroAuth({ authFile: f.authFile, signal: controller.signal }),
    (error) => error === controller.signal.reason,
  );
  await assert.rejects(stat(f.authFile), { code: "ENOENT" });
});
