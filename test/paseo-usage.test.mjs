import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAuthSnapshot, saveKiroAuth } from "../server/auth.mjs";
import { createKiroUsageSource } from "../server/usage-source.mjs";

const now = () => Date.parse("2026-10-25T00:00:00Z");
const credential = {
  kind: "social",
  provider: "google",
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  expires_at: "2026-10-26T00:00:00Z",
};
async function fixture(t, value = credential) {
  const directory = await mkdtemp(join(tmpdir(), "kiro-paseo-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, "omp-kiro", "auth.sqlite3");
  await saveKiroAuth(value, { authFile });
  return { directory, authFile };
}
function quota(used) {
  return {
    subscriptionInfo: { type: "Q_DEVELOPER_STANDALONE_PRO" },
    nextDateReset: Date.parse("2026-11-01T00:00:00Z") / 1000,
    usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: used, usageLimit: 100 }],
    userInfo: { email: "fixture-private@example.invalid" },
  };
}

test("session usage follows its explicit or XDG account, never associates native ACP login", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, { ...credential, provider: "github" });
  const source = createKiroUsageSource({ now });
  const a = await source.discover({
    kind: "session",
    provider: "kiro-http",
    env: { OMP_KIRO_AUTH_FILE: first.authFile },
  });
  const b = await source.discover({
    kind: "session",
    provider: "kiro-http",
    env: { XDG_CONFIG_HOME: second.directory },
  });
  assert.notEqual(a[0].key, b[0].key);
  assert.equal(a[0].input.authFile, first.authFile);
  assert.equal(b[0].input.authFile, second.authFile);
  assert.deepEqual(
    await source.discover({
      kind: "session",
      provider: "kiro-omp",
      model: "kiro-cli/auto",
      env: {},
    }),
    [],
  );
  assert.doesNotMatch(JSON.stringify([a, b]), /fixture-access|fixture-refresh/);
});

test("expired refreshable account is reported without network, rotation, or storage writes", async (t) => {
  const f = await fixture(t, { ...credential, expires_at: "2026-10-24T00:00:00Z" });
  const before = await readAuthSnapshot({ authFile: f.authFile });
  const modified = (await stat(f.authFile)).mtimeMs;
  const source = createKiroUsageSource({
    now,
    fetchImpl: () => {
      throw new Error("Usage must not refresh");
    },
  });
  const report = await source.fetch({ authFile: f.authFile });
  assert.equal(report.status, "unavailable");
  assert.equal(report.problem.kind, "expired");
  assert.equal(report.problem.expiresAt, "2026-10-24T00:00:00Z");
  assert.equal(await readAuthSnapshot({ authFile: f.authFile }), before);
  assert.equal((await stat(f.authFile)).mtimeMs, modified);
});

test("usage re-reads rotated login and displays new precise quota without persisting credentials", async (t) => {
  const f = await fixture(t);
  const source = createKiroUsageSource({
    now,
    fetchImpl: async (_url, options) =>
      Response.json(
        quota(options.headers.authorization === "Bearer rotated-access" ? 75.125 : 10.5),
      ),
  });
  const accounts = await source.discover({
    kind: "session",
    provider: "kiro-http",
    env: { OMP_KIRO_AUTH_FILE: f.authFile },
  });
  const first = await source.fetch(accounts[0].input);
  assert.equal(first.balances[0].remaining, 89.5);
  await saveKiroAuth({ ...credential, access_token: "rotated-access" }, { authFile: f.authFile });
  const snapshot = await readAuthSnapshot({ authFile: f.authFile });
  const second = await source.fetch(accounts[0].input);
  assert.equal(second.windows[0].usedPct, 75.125);
  assert.equal(second.balances[0].remaining, 24.875);
  assert.equal(await readAuthSnapshot({ authFile: f.authFile }), snapshot);
  assert.doesNotMatch(JSON.stringify(second), /fixture-private|rotated-access|fixture-refresh/);
});

test("rejected credentials expose typed unavailable state, not service error text", async (t) => {
  const f = await fixture(t);
  const source = createKiroUsageSource({
    now,
    fetchImpl: async () =>
      new Response("Bearer fixture-access fixture-private@example.invalid", { status: 401 }),
  });
  const report = await source.fetch({ authFile: f.authFile });
  assert.equal(report.status, "unavailable");
  assert.deepEqual(report.problem, { kind: "rejected", status: 401, refreshedBy: "omp-kiro" });
  assert.doesNotMatch(JSON.stringify(report), /fixture-access|fixture-private/);
  const invalid = await source.fetch({ authFile: "relative.sqlite3" });
  assert.equal(invalid.status, "error");
});
