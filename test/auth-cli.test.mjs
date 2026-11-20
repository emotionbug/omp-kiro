import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { readKiroAuth, saveKiroAuth } from "../server/auth.mjs";
const run = promisify(execFile);
const entry = fileURLToPath(new URL("../auth-cli.mjs", import.meta.url));

test("standalone status and logout use the selected store without a Kiro executable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-auth-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, "auth.sqlite3");
  const credential = {
    kind: "social",
    provider: "google",
    access_token: "never-print-this-access",
    refresh_token: "never-print-this-refresh",
    expires_at: "2099-01-01T00:00:00Z",
  };
  await saveKiroAuth(credential, { authFile });
  const options = { env: { ...process.env, PATH: "/no-kiro-cli" }, timeout: 10000 };
  const before = await run(
    process.execPath,
    [entry, "auth", "status", "--auth-file", authFile, "--json"],
    options,
  );
  assert.deepEqual(JSON.parse(before.stdout), {
    loggedIn: true,
    authFile,
    kind: "social",
    provider: "google",
    expiresAt: credential.expires_at,
    expired: false,
    refreshable: true,
  });
  assert.ok(!before.stdout.includes(credential.access_token));
  assert.ok(!before.stdout.includes(credential.refresh_token));
  await run(process.execPath, [entry, "auth", "logout", "--auth-file", authFile], options);
  const after = await run(
    process.execPath,
    [entry, "auth", "status", "--auth-file", authFile, "--json"],
    options,
  );
  assert.deepEqual(JSON.parse(after.stdout), { loggedIn: false, authFile });
});

test("a new machine reports signed-out status without creating credential data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-auth-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, "new-machine", "auth.sqlite3");
  const result = await run(
    process.execPath,
    [entry, "auth", "status", "--auth-file", authFile, "--json"],
    { timeout: 10000 },
  );
  assert.deepEqual(JSON.parse(result.stdout), { loggedIn: false, authFile });
});

test(
  "installed symlink entry executes authentication status",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "omp-kiro-auth-bin-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bin = join(directory, "omp-kiro");
    const authFile = join(directory, "empty.sqlite3");
    await symlink(entry, bin);
    const result = await run(
      process.execPath,
      [bin, "auth", "status", "--auth-file", authFile, "--json"],
      { timeout: 10000 },
    );
    assert.deepEqual(JSON.parse(result.stdout), { loggedIn: false, authFile });
  },
);

test("standalone API-key login reads stdin and never prints the key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-api-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, "auth.sqlite3");
  const env = { ...process.env, KIRO_API_KEY: "", KIRO_API_REGION: "eu-central-1" };
  const preload = "data:text/javascript,globalThis.fetch=()=>{throw new Error('unexpected request')}";
  const key = "ksk_fixture-not-a-real-key";
  const args = ["--import", preload, entry, "login", "--provider", "api-key",
    "--account", "work", "--auth-file", authFile, "--region", "us-east-1"];
  const child = run(process.execPath, args, { env, timeout: 10000 });
  child.child.stdin.end(`${key}\n`);
  const { stdout, stderr } = await child;
  const output = stdout + stderr;
  assert.ok(!output.includes(key));
  assert.match(output, /kiro-work-key\/auto/);
  const workFile = join(directory, "accounts", "work.sqlite3");
  assert.deepEqual(await readKiroAuth({ authFile: workFile }), {
    kind: "api-key", provider: "api-key", access_token: key, region: "us-east-1",
  });
  const options = { env, timeout: 10000 };
  const status = await run(process.execPath, [entry, "auth", "status", "--account", "work",
    "--auth-file", authFile, "--json"], options);
  assert.equal(JSON.parse(status.stdout).kind, "api-key");
  assert.equal(JSON.parse(status.stdout).expiresAt, undefined);
  assert.ok(!status.stdout.includes(key));
  await assert.rejects(run(process.execPath, [...args, `--key=${key}`], options), (error) => {
    assert.match(error.stderr, /Invalid authentication options/);
    assert.ok(!error.stderr.includes(key));
    return true;
  });
});
