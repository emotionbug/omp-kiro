import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  KiroAuthError,
  getKiroAuthStatus,
  importCliAuth,
  loadKiroAuth,
  logoutKiroAuth,
  pinnedKiroAuth,
  queryKiroProfiles,
  readAuthSnapshot,
  refreshExpiredKiroAuth,
  readKiroAuth,
  readProfileCatalog,
  resolveKiroApiKeyCredential,
  saveKiroAuth,
  saveProfileCatalog,
} from "../server/auth.mjs";
import { createHttpTransport, discoverHttpModels } from "../server/http.mjs";

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

async function withDatabase(authFile, operation) {
  const db = await sqlite(authFile);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function leaseRow(authFile) {
  return withDatabase(authFile, (db) =>
    db.prepare("SELECT value FROM credentials WHERE id = ?").get("refresh_lease")?.value ?? null);
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

test("read-only access preserves expired credentials without refreshing or rewriting storage", async (t) => {
  const f = await fixture(t);
  const before = await stat(f.authFile);
  assert.deepEqual(await readKiroAuth({ authFile: f.authFile }), original);
  assert.equal((await stat(f.authFile)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await f.read(), original);
  await logoutKiroAuth({ authFile: f.authFile });
  await assert.rejects(readKiroAuth({ authFile: f.authFile }), KiroAuthError);
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

test("a refresh lease held by a different process is honored and cleaned up", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const script = `
    (async () => {
      const { once } = await import("node:events");
      const { loadKiroAuth } = await import(${JSON.stringify(new URL("../server/auth.mjs", import.meta.url).href)});
      const value = await loadKiroAuth({
        authFile: process.env.FIXTURE_AUTH_FILE, useEnv: false,
        now: () => ${now()},
        fetchImpl: async () => {
          const release = once(process.stdin, "data");
          process.stdout.write("holding");
          await release;
          process.stdin.pause();
          return Response.json({ accessToken: "child-access", refreshToken: "child-refresh", expiresIn: 3600 });
        },
      });
      if (value.refresh_token !== "child-refresh") process.exitCode = 1;
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, FIXTURE_AUTH_FILE: f.authFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  t.after(() => child.kill());
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const [message] = await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
  assert.equal(message.toString(), "holding");
  const held = JSON.parse(await leaseRow(f.authFile));
  assert.equal(typeof held.owner, "string");
  assert.ok(held.expiresAt > Date.now() && held.expiresAt <= Date.now() + 30_000);

  let localRequests = 0;
  const contender = loadKiroAuth({
    authFile: f.authFile, now,
    fetchImpl: async () => {
      localRequests++;
      assert.fail("contender must not spend the child's rotating token");
    },
  });
  const earlyCompletion = contender.then(() => "finished", () => "rejected");
  assert.equal(await Promise.race([earlyCompletion, delay(120, "waiting")]), "waiting");
  assert.equal(JSON.parse(await leaseRow(f.authFile)).owner, held.owner);
  child.stdin.end("release");
  const [[code], token] = await Promise.all([exit, contender]);
  assert.equal(code, 0, errors);
  assert.equal(localRequests, 0);
  assert.equal(token.refresh_token, "child-refresh");
  assert.deepEqual(await f.read(), token);
  assert.equal(await leaseRow(f.authFile), null);
});

test("a renewed cross-process refresh lease outlives a waiter's original deadline and allows cancellation", async (t) => {
  const f = await fixture(t);
  const setLease = (expiresAt) => withDatabase(f.authFile, (db) => db.prepare(
    "INSERT OR REPLACE INTO credentials (id, value) VALUES (?, ?)",
  ).run("refresh_lease", JSON.stringify({ owner: "another-process", expiresAt })));
  await setLease(Date.now() + 30_000);
  const realNow = performance.now.bind(performance);
  let elapsed = 0;
  t.mock.method(performance, "now", () => realNow() + elapsed);
  const controller = new AbortController();
  const pending = loadKiroAuth({
    authFile: f.authFile, now, signal: controller.signal,
    fetchImpl: async () => assert.fail("a live owner still holds the refresh lease"),
  });
  const settled = pending.then(() => "resolved", () => "rejected");
  assert.equal(await Promise.race([settled, delay(125, "waiting")]), "waiting");
  await setLease(Date.now() + 60_000);
  elapsed = 31_000;
  assert.equal(await Promise.race([settled, delay(125, "waiting")]), "waiting");
  const reason = new Error("wait cancelled by caller");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(JSON.parse(await leaseRow(f.authFile)).owner, "another-process");
});

test("an expired lease can be taken over, and a failed exchange releases it", async (t) => {
  const f = await fixture(t);
  await withDatabase(f.authFile, (db) => db.prepare("INSERT INTO credentials (id, value) VALUES (?, ?)")
    .run("refresh_lease", JSON.stringify({ owner: "stale-owner", expiresAt: Date.now() - 1 })));
  let owner;
  await assert.rejects(loadKiroAuth({
    authFile: f.authFile, now,
    fetchImpl: async () => {
      owner = JSON.parse(await leaseRow(f.authFile)).owner;
      return Response.json({ error: "temporarily_unavailable" }, { status: 502 });
    },
  }), /HTTP 502/);
  assert.notEqual(owner, "stale-owner");
  assert.equal(typeof owner, "string");
  assert.equal(await leaseRow(f.authFile), null);
  assert.deepEqual(await f.read(), original);
});

test("login replacement and logout both roll back if clearing the old profile catalog fails", async (t) => {
  const f = await fixture(t);
  await saveProfileCatalog([{ arn: original.profile_arn, name: "Saved" }], {
    authFile: f.authFile, credential: original,
  });
  const catalog = await readProfileCatalog({ authFile: f.authFile });
  await withDatabase(f.authFile, (db) => db.exec(`
    CREATE TRIGGER block_catalog_delete BEFORE DELETE ON credentials WHEN old.id = 'profiles'
    BEGIN SELECT RAISE(ABORT, 'catalog deletion failed'); END;
  `));
  const replacement = { ...original, access_token: "new-login" };
  await assert.rejects(saveKiroAuth(replacement, { authFile: f.authFile, replacesLogin: true }), /catalog deletion failed/);
  assert.deepEqual(await f.read(), original);
  assert.deepEqual(await readProfileCatalog({ authFile: f.authFile }), catalog);
  await assert.rejects(logoutKiroAuth({ authFile: f.authFile }), /catalog deletion failed/);
  assert.deepEqual(await f.read(), original);
  assert.deepEqual(await readProfileCatalog({ authFile: f.authFile }), catalog);
});

test("an old lease owner cannot commit a refresh or remove a different owner's lease", async (t) => {
  const f = await fixture(t);
  const nextOwner = JSON.stringify({ owner: "other-process", expiresAt: Date.now() + 30_000 });
  await assert.rejects(loadKiroAuth({
    authFile: f.authFile, now,
    fetchImpl: async () => {
      await withDatabase(f.authFile, (db) => db.prepare("UPDATE credentials SET value = ? WHERE id = ?")
        .run(nextOwner, "refresh_lease"));
      return Response.json({ accessToken: "stale-result", expiresIn: 3600 });
    },
  }), { code: "credential_changed" });
  assert.deepEqual(await f.read(), original);
  assert.equal(await leaseRow(f.authFile), nextOwner);
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

test("definitive social rejection CAS-disables the grant without exposing tokens", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const options = {
    authFile: f.authFile, now,
    fetchImpl: async () => {
      calls++;
      return new Response(original.refresh_token, { status: 401 });
    },
  };
  for (const access of [() => loadKiroAuth(options), () => readKiroAuth(options), () => loadKiroAuth(options)]) {
    await assert.rejects(access(), (error) => {
      assert.equal(error.code, "credential_disabled");
      assert.match(error.message, /sign in again/);
      assert.ok(!error.message.includes(original.refresh_token));
      return true;
    });
  }
  assert.equal(calls, 1);
  assert.deepEqual(await f.read(), { ...original, disabled: "login_expired" });
  assert.equal(await leaseRow(f.authFile), null);
  const status = await getKiroAuthStatus(options);
  assert.equal(status.loggedIn, true);
  assert.equal(status.refreshable, false);
  assert.equal(status.disabled, "login_expired");
  assert.ok(!JSON.stringify(status).includes(original.access_token));
  assert.ok(!JSON.stringify(status).includes(original.refresh_token));

  const replacement = { ...original, access_token: "new-login", expires_at: "2026-02-01T00:00:00Z" };
  await saveKiroAuth(replacement, {
    authFile: f.authFile, expectedRaw: await readAuthSnapshot(options), replacesLogin: true,
  });
  assert.deepEqual(await readKiroAuth(options), replacement);
  assert.equal((await getKiroAuthStatus(options)).disabled, undefined);
});

test("terminal refresh cannot disable a newer login", async (t) => {
  const f = await fixture(t);
  const replacement = { ...original, access_token: "new-login", expires_at: "2026-02-01T00:00:00Z" };
  await assert.rejects(loadKiroAuth({
    authFile: f.authFile, now,
    fetchImpl: async () => {
      await f.replace(replacement);
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    },
  }), { code: "credential_changed" });
  assert.deepEqual(await f.read(), replacement);
  assert.equal(await leaseRow(f.authFile), null);
});

test("expired OAuth grants with missing refresh state are disabled without network", async (t) => {
  for (const [record, reason] of [
    [{ ...original, refresh_token: undefined }, "missing_refresh_state"],
    [{ ...unresolvedOidc(), client_secret: undefined, expires_at: original.expires_at }, "invalid_credential"],
  ]) {
    const f = await fixture(t, record);
    let calls = 0;
    await assert.rejects(loadKiroAuth({
      authFile: f.authFile, now,
      fetchImpl: async () => { calls++; return Response.json({}); },
    }), { code: "credential_disabled" });
    assert.equal(calls, 0);
    assert.equal((await f.read()).disabled, reason);
  }
});

test("an OIDC modeled grant rejection disables the login, but an unknown HTTP 400 does not", async (t) => {
  for (const [body, reason] of [
    [{ error: "unknown_failure" }, undefined],
    [{ __type: "com.amazonaws.ssooidc#ExpiredTokenException" }, "login_expired"],
    [{ error: "InvalidGrantException" }, "login_expired"],
    [{ error: "invalid_client" }, "registration_expired"],
  ]) {
    const f = await fixture(t, { ...unresolvedOidc(), expires_at: original.expires_at });
    await assert.rejects(loadKiroAuth({
      authFile: f.authFile, now,
      fetchImpl: async () => Response.json(body, { status: 400 }),
    }), { code: reason ? "credential_disabled" : "request_failed" });
    assert.equal((await f.read()).disabled, reason);
    assert.equal(await leaseRow(f.authFile), null);
  }
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

test("a canceled waiter does not wait for or cancel another request's pending refresh", async (t) => {
  const f = await fixture(t);
  const ready = Promise.withResolvers(), started = Promise.withResolvers();
  let calls = 0;
  const options = {
    authFile: f.authFile, now,
    fetchImpl: async () => {
      calls++;
      started.resolve();
      await ready.promise;
      return Response.json({ accessToken: "fixture-new-access", expiresIn: 3600 });
    },
  };
  const owner = loadKiroAuth(options);
  await started.promise;
  const controller = new AbortController(), reason = new Error("waiter canceled");
  const waiter = loadKiroAuth({ ...options, signal: controller.signal });
  const rejected = assert.rejects(waiter, (error) => error === reason);
  await new Promise(setImmediate);
  controller.abort(reason);
  try {
    await rejected;
    assert.equal(calls, 1);
  } finally {
    ready.resolve();
    await owner;
  }
});

test("refresh cannot change the selected account profile or persist the changed identity", async (t) => {
  const f = await fixture(t);
  await assert.rejects(loadKiroAuth({
    authFile: f.authFile, now,
    fetchImpl: async () => Response.json({
      accessToken: "fixture-new-access", expiresIn: 3600,
      profileArn: "arn:aws:codewhisperer:eu-central-1:987:profile/other",
    }),
  }), /profile changed/);
  assert.deepEqual(await f.read(), original);
});

test("an outage cannot silently adopt an independent login without a profile ARN", async (t) => {
  const previous = { ...original };
  delete previous.profile_arn;
  const f = await fixture(t, previous);
  const replacement = {
    ...previous, access_token: "other-account-access", refresh_token: "other-account-refresh",
    expires_at: "2026-02-01T00:00:00Z",
  };
  await f.replace(replacement);
  await assert.rejects(refreshExpiredKiroAuth(previous, {
    authFile: f.authFile, now,
    fetchImpl: async () => assert.fail("must not refresh the independent login"),
  }), /login or region changed/);
  assert.deepEqual(await f.read(), replacement);
});

function unresolvedOidc() {
  const credential = {
    ...original, kind: "oidc", provider: "identity-center", region: "ap-northeast-2",
    client_id: "fixture-client", client_secret: "fixture-client-secret",
    expires_at: "2026-01-02T00:00:00Z",
  };
  delete credential.profile_arn;
  return credential;
}
const assignedProfile = original.profile_arn;

test("IAM model discovery resolves and persists its Kiro profile independently of the SSO issuer region", async (t) => {
  const f = await fixture(t, unresolvedOidc());
  let profileCalls = 0;
  const fetchImpl = async (url, request) => {
    if (request.headers["x-amz-target"].endsWith(".ListAvailableProfiles")) {
      profileCalls++;
      assert.equal(request.headers["x-amz-target"], "AmazonCodeWhispererService.ListAvailableProfiles");
      assert.deepEqual(JSON.parse(request.body), {});
      return Response.json({ profiles: url === "https://management.us-east-1.kiro.dev/"
        ? [{ arn: assignedProfile, profileName: "Team" }] : [] });
    }
    const input = JSON.parse(request.body);
    if (input.profileArn !== assignedProfile)
      return Response.json({ message: "Invalid profileArn" }, { status: 400 });
    return Response.json({ models: [
      { modelId: "auto" }, { modelId: "claude-opus-5.5", tokenLimits: { maxInputTokens: 1000000 } },
    ] });
  };
  const authProvider = (options) => loadKiroAuth({ ...options, authFile: f.authFile, now });
  const options = { fetchImpl, authProvider };
  assert.deepEqual((await discoverHttpModels(options)).map((m) => m.id), ["auto", "claude-opus-5.5"]);
  assert.deepEqual((await discoverHttpModels(options)).map((m) => m.id), ["auto", "claude-opus-5.5"]);
  assert.equal(profileCalls, 2);
  assert.deepEqual(await f.read(), { ...unresolvedOidc(), profile_arn: assignedProfile });
});

test("parallel metadata requests share one initial profile lookup", async (t) => {
  const f = await fixture(t, unresolvedOidc());
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const options = {
    authFile: f.authFile, now,
    fetchImpl: async () => {
      calls++;
      started.resolve();
      await release.promise;
      return Response.json({ profiles: [{ arn: assignedProfile }] });
    },
  };
  const first = loadKiroAuth(options);
  await started.promise;
  const second = loadKiroAuth(options);
  release.resolve();
  const values = await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.deepEqual(values[0], values[1]);
  assert.equal(values[0].profile_arn, assignedProfile);
});

test("an identical profile commit from another process is accepted without replacing it", async (t) => {
  const credential = unresolvedOidc();
  const resolved = { ...credential, profile_arn: assignedProfile };
  const f = await fixture(t, credential);
  const result = await loadKiroAuth({
    authFile: f.authFile, now,
    fetchImpl: async (url) => {
      if (url !== "https://management.us-east-1.kiro.dev/") return Response.json({ profiles: [] });
      await f.replace(resolved);
      return Response.json({ profiles: [{ arn: assignedProfile }] });
    },
  });
  assert.deepEqual(result, resolved);
  assert.deepEqual(await f.read(), resolved);
});

test("profile lookup cannot overwrite an independent login or resurrect a logout", async (t) => {
  for (const logout of [false, true]) {
    const f = await fixture(t, unresolvedOidc());
    const replacement = { ...unresolvedOidc(), access_token: "independent-login" };
    await assert.rejects(loadKiroAuth({
      authFile: f.authFile, now,
      fetchImpl: async (url) => {
        if (url !== "https://management.us-east-1.kiro.dev/") return Response.json({ profiles: [] });
        if (logout) await logoutKiroAuth({ authFile: f.authFile });
        else await f.replace(replacement);
        return Response.json({ profiles: [{ arn: assignedProfile }] });
      },
    }), { code: "credential_changed" });
    if (logout) assert.equal((await getKiroAuthStatus({ authFile: f.authFile })).loggedIn, false);
    else assert.deepEqual(await f.read(), replacement);
  }
});

test("multiple profiles require an assigned explicit selection and include later pages", async (t) => {
  const credential = unresolvedOidc();
  const other = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/other";
  const f = await fixture(t, credential);
  const options = {
    authFile: f.authFile, now,
    fetchImpl: async (_url, request) => JSON.parse(request.body).nextToken
      ? Response.json({ profiles: [{ arn: other, profileName: "Other team" }] })
      : Response.json({ profiles: [{ arn: assignedProfile, profileName: "Team" }], nextToken: "page-two" }),
  };
  await assert.rejects(loadKiroAuth(options), (error) => {
    assert.deepEqual(error.profiles.map((p) => p.arn), [assignedProfile, other]);
    assert.ok(!JSON.stringify(error).includes(assignedProfile));
    return error instanceof KiroAuthError;
  });
  assert.deepEqual(await f.read(), credential);
  await assert.rejects(loadKiroAuth({ ...options, profileArn: `${other}-not-assigned` }), KiroAuthError);
  assert.deepEqual(await f.read(), credential);
  const selected = await loadKiroAuth({ ...options, profileArn: other });
  assert.equal(selected.profile_arn, other);
  assert.equal((await f.read()).profile_arn, other);
});

test("empty or cyclic profile catalogs do not mutate the managed login", async (t) => {
  for (const response of [
    { profiles: [] },
    { profiles: [{ arn: assignedProfile }], nextToken: "same-page" },
  ]) {
    const credential = unresolvedOidc();
    const f = await fixture(t, credential);
    await assert.rejects(loadKiroAuth({
      authFile: f.authFile, now, fetchImpl: async () => Response.json(response),
    }), KiroAuthError);
    assert.deepEqual(await f.read(), credential);
  }
});

test("failed profile resolution retains a successfully rotated OIDC refresh credential", async (t) => {
  const credential = { ...unresolvedOidc(), expires_at: original.expires_at };
  const f = await fixture(t, credential);
  await assert.rejects(loadKiroAuth({
    authFile: f.authFile, now,
    fetchImpl: async (url) => String(url).includes("oidc.ap-northeast-2.amazonaws.com")
      ? Response.json({ accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600 })
      : Response.json({ profiles: [] }),
  }), KiroAuthError);
  const saved = await f.read();
  assert.equal(saved.access_token, "rotated-access");
  assert.equal(saved.refresh_token, "rotated-refresh");
  assert.equal(saved.profile_arn, undefined);
});

test("API-key region uses explicit, environment, or one pass across commercial candidates", async () => {
  const key = "ksk_fixture-api-key";
  const noNetwork = async () => assert.fail("a known region should not need a probe");
  assert.deepEqual(await resolveKiroApiKeyCredential(` ${key} `, {
    region: "us-gov-east-1", env: { KIRO_API_REGION: "eu-central-1" }, fetchImpl: noNetwork,
  }), { kind: "api-key", provider: "api-key", access_token: key, region: "us-gov-east-1" });
  assert.equal((await resolveKiroApiKeyCredential(key, {
    env: { KIRO_API_REGION: "eu-central-1" }, fetchImpl: noNetwork,
  })).region, "eu-central-1");

  const targets = [];
  const resolved = await resolveKiroApiKeyCredential(key, {
    env: {},
    fetchImpl: async (url, request) => {
      targets.push(url);
      assert.equal(request.redirect, "error");
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      assert.equal(request.headers.tokentype, "API_KEY");
      assert.equal(request.headers["x-amz-target"], "KiroControlPlaneBearerService.ListAvailableModels");
      assert.equal(request.headers["amz-sdk-request"], "attempt=1; max=1");
      assert.deepEqual(JSON.parse(request.body), { origin: "KIRO_CLI" });
      if (url.includes("eu-central-1")) return Response.json({ models: [] });
      return new Response(key, { status: 503 });
    },
  });
  assert.deepEqual(targets.sort(), ["https://management.eu-central-1.kiro.dev/", "https://management.us-east-1.kiro.dev/"]);
  assert.equal(resolved.region, "eu-central-1");
});

test("API-key probes reject ambiguity, redact transport errors, and observe cancellation", async () => {
  const key = "ksk_fixture-secret";
  for (const fetchImpl of [async () => Response.json({ models: [] }), async () => { throw new Error(key); }]) {
    await assert.rejects(resolveKiroApiKeyCredential(key, { env: {}, fetchImpl }), (error) => {
      assert.match(error.message, /set KIRO_API_REGION/);
      assert.ok(!error.message.includes(key));
      assert.equal(error.cause, undefined);
      return error instanceof KiroAuthError;
    });
  }
  await assert.rejects(resolveKiroApiKeyCredential(key, { region: `${key}.invalid`, env: {} }), (error) =>
    /valid AWS region/.test(error.message) && !error.message.includes(key));
  await assert.rejects(resolveKiroApiKeyCredential("fixture-not-a-key", { env: {} }), /ksk_/);
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const pending = resolveKiroApiKeyCredential(key, {
    env: {}, signal: controller.signal,
    fetchImpl: () => {
      started.resolve();
      return new Promise(() => {});
    },
  });
  await started.promise;
  const reason = new Error("canceled probe");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("API-key env override is local for read/status; load probes without mutating the saved login", async (t) => {
  const key = "ksk_fixture-environment";
  const env = { KIRO_API_KEY: key };
  const record = { kind: "api-key", provider: "api-key", access_token: key };
  assert.deepEqual(await readKiroAuth({ env }), record);
  const defaultStatus = await getKiroAuthStatus({ env });
  assert.equal(defaultStatus.kind, "api-key");
  assert.equal(defaultStatus.expiresAt, undefined);
  assert.equal(defaultStatus.expired, false);
  assert.equal(defaultStatus.refreshable, false);
  assert.ok(!JSON.stringify(defaultStatus).includes(key));

  const f = await fixture(t);
  const explicit = { authFile: f.authFile, env };
  assert.deepEqual(await readKiroAuth(explicit), original);
  assert.equal((await getKiroAuthStatus(explicit)).kind, "social");
  const options = { ...explicit, useEnv: true };
  assert.deepEqual(await readKiroAuth(options), record);
  assert.equal((await getKiroAuthStatus(options)).kind, "api-key");
  let probes = 0;
  const fetchImpl = async (url) => {
    probes++;
    return url.includes("us-east-1") ? Response.json({ models: [] }) : new Response(null, { status: 403 });
  };
  const resolved = await loadKiroAuth({ ...options, fetchImpl });
  assert.deepEqual(resolved, { ...record, region: "us-east-1" });
  assert.equal(probes, 2);
  assert.deepEqual(await refreshExpiredKiroAuth(resolved, {
    authProvider: (request) => loadKiroAuth({ ...options, ...request, authFile: f.authFile }),
    fetchImpl,
  }), resolved);
  assert.equal(probes, 2, "an unchanged key does not probe again before replay");
  assert.deepEqual(await f.read(), original);
});

test("profile-free pin selects only API keys and preserves key identity during recovery", async (t) => {
  const key = { kind: "api-key", provider: "api-key", access_token: "ksk_fixture", region: "eu-central-1" };
  const f = await fixture(t, key);
  const pinned = pinnedKiroAuth({ authFile: f.authFile, useEnv: false, profileArn: undefined });
  const fetchImpl = async () => assert.fail("a stored API key has no expiry or profile lookup");
  assert.deepEqual(await pinned({ fetchImpl }), key);
  assert.deepEqual(await refreshExpiredKiroAuth(key, { authProvider: pinned, fetchImpl }), key);
  assert.equal((await getKiroAuthStatus({ authFile: f.authFile, now })).expired, false);
  await assert.rejects(queryKiroProfiles(key, { fetchImpl }), /API keys do not use profiles/);
  await assert.rejects(f.replace({ ...key, region: undefined }), /Invalid stored Kiro API key/);
  await assert.rejects(f.replace({ ...key, profile_arn: assignedProfile }), /Invalid stored Kiro API key/);
  await assert.rejects(f.replace({ ...key, expires_at: original.expires_at }), /Invalid stored Kiro API key/);

  const envPinned = pinnedKiroAuth({ authFile: f.authFile, useEnv: true, profileArn: undefined });
  assert.deepEqual(await envPinned({
    fetchImpl, env: { KIRO_API_KEY: "ksk_fixture-env", KIRO_API_REGION: "us-east-1" },
  }), { ...key, access_token: "ksk_fixture-env", region: "us-east-1" });
  await f.replace({ ...key, access_token: "ksk_fixture-replacement" });
  await assert.rejects(pinned({ fetchImpl, expectedCredential: key }), /login or region changed/);
  await f.replace(original);
  await assert.rejects(pinned({ fetchImpl }), /login or region changed/);
});

test("runtime retries re-read API keys and stop after store logout, replacement, or env override changes", async (t) => {
  const key = { kind: "api-key", provider: "api-key", access_token: "ksk_fixture", region: "eu-central-1" };
  for (const action of ["logout", "replace-store", "replace-env", "unset-env", "unset-env-region"]) {
    const f = await fixture(t, key);
    const useEnv = action.endsWith("-env") || action === "unset-env-region";
    const env = useEnv ? { KIRO_API_KEY: key.access_token, KIRO_API_REGION: key.region } : {};
    let sent = 0;
    const run = createHttpTransport({
      retry: { maxAttempts: 2, baseDelayMs: 0 },
      authProvider: (options) => loadKiroAuth({ ...options, authFile: f.authFile, useEnv, env }),
      async fetchImpl(_url, init) {
        assert.equal(++sent, 1, action);
        assert.equal(init.headers.authorization, `Bearer ${key.access_token}`);
        if (action === "logout") await logoutKiroAuth({ authFile: f.authFile });
        else if (action === "replace-store")
          await saveKiroAuth({ ...key, access_token: "ksk_replacement" }, { authFile: f.authFile, replacesLogin: true });
        else if (action === "replace-env") env.KIRO_API_KEY = "ksk_replacement";
        else if (action === "unset-env") delete env.KIRO_API_KEY; // The identical saved key is still a different source.
        else delete env.KIRO_API_REGION;
        return new Response(null, { status: 503 });
      },
    });
    await assert.rejects(run({ model: "auto", context: { messages: [{ role: "user", content: "fixture" }] } }), KiroAuthError);
    assert.equal(sent, 1, action);
  }
});

test("GovCloud Identity Center discovers only GovCloud profiles and preserves the selected ARN", async (t) => {
  const credential = { ...unresolvedOidc(), region: "us-gov-west-1" };
  const arn = "arn:aws-us-gov:codewhisperer:us-gov-east-1:123456789012:profile/team";
  const f = await fixture(t, credential);
  const urls = [];
  const result = await loadKiroAuth({
    authFile: f.authFile, now,
    fetchImpl: async (url, request) => {
      urls.push(url);
      assert.equal(request.headers["x-amz-target"], "AmazonCodeWhispererService.ListAvailableProfiles");
      assert.equal(request.headers.authorization, `Bearer ${credential.access_token}`);
      assert.deepEqual(JSON.parse(request.body), {});
      return Response.json({ profiles: url.includes("us-gov-east-1") ? [{ arn, profileName: "Gov team" }] : [] });
    },
  });
  assert.deepEqual(urls.sort(), ["https://management.us-gov-east-1.kiro.dev/", "https://management.us-gov-west-1.kiro.dev/"]);
  assert.deepEqual(result, { ...credential, profile_arn: arn });
  assert.deepEqual(await f.read(), result);
  const pin = pinnedKiroAuth({ authFile: f.authFile, profileArn: arn });
  assert.deepEqual(await pin({ now, fetchImpl: async () => assert.fail("valid cached profile needs no lookup") }), result);
});

test("cached and listed profiles cannot cross the OAuth partition or use unsupported regions", async (t) => {
  const scenarios = [
    [unresolvedOidc(), "arn:aws-us-gov:codewhisperer:us-gov-east-1:123456789012:profile/team"],
    [{ ...unresolvedOidc(), region: "us-gov-west-1" }, assignedProfile],
    [{ ...unresolvedOidc(), region: "us-gov-west-1" }, "arn:aws:codewhisperer:us-gov-east-1:123456789012:profile/team"],
    [unresolvedOidc(), "arn:aws:codewhisperer:cn-north-1:123456789012:profile/team"],
    [original, "arn:aws-us-gov:codewhisperer:us-gov-west-1:123456789012:profile/team"],
  ];
  for (const [credential, arn] of scenarios) {
    const f = await fixture(t, credential);
    await assert.rejects(queryKiroProfiles(credential, {
      fetchImpl: async () => Response.json({ profiles: [{ arn }] }),
    }), /profile ARN or region/);
    const malformed = { ...credential, profile_arn: arn };
    await assert.rejects(f.replace(malformed), /profile ARN or region/);
    await withDatabase(f.authFile, (db) => db.prepare("UPDATE credentials SET value = ? WHERE id = ?")
      .run(JSON.stringify(malformed), "active"));
    await assert.rejects(readKiroAuth({ authFile: f.authFile }), /profile ARN or region/);
    let calls = 0;
    await assert.rejects(loadKiroAuth({
      authFile: f.authFile, now,
      fetchImpl: async () => { calls++; return Response.json({}); },
    }), /profile ARN or region/);
    assert.equal(calls, 0);
  }
});

test("same-partition profiles outside supported service regions can be listed but not selected", async (t) => {
  const credential = unresolvedOidc();
  const arn = "arn:aws:codewhisperer:ap-southeast-2:123456789012:profile/team";
  const f = await fixture(t, credential);
  const fetchImpl = async () => Response.json({ profiles: [{ arn, profileName: "Other region" }] });
  assert.deepEqual(await queryKiroProfiles(credential, { fetchImpl }), { complete: true, profiles: [
    { arn, name: "Other region", region: "ap-southeast-2", accountId: "123456789012" },
  ] });
  await assert.rejects(loadKiroAuth({ authFile: f.authFile, now, fetchImpl }), /profile ARN or region/);
  await assert.rejects(f.replace({ ...credential, profile_arn: arn }), /profile ARN or region/);
  assert.deepEqual(await f.read(), credential);
});

test("replay preparation cannot use a disabled bearer from an injected reader", async () => {
  const disabled = { ...original, expires_at: "2026-02-01T00:00:00Z", disabled: "login_expired" };
  let reloads = 0;
  const authProvider = async () => {
    reloads++;
    return disabled;
  };
  await assert.rejects(refreshExpiredKiroAuth(disabled, { now, authProvider }), { code: "credential_disabled" });
  assert.equal(reloads, 0);
  await assert.rejects(refreshExpiredKiroAuth(original, { now, authProvider }), { code: "credential_disabled" });
  assert.equal(reloads, 1);
});
