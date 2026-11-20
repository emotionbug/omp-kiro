import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { z } from "zod";
import {
  logoutKiroAuth,
  pinnedKiroAuth,
  readAuthSnapshot,
  readProfileCatalog,
  saveKiroAuth,
  saveProfileCatalog,
} from "../server/auth.mjs";
import {
  kiroAccountAuthFile,
  kiroTargetProvider,
  kiroTargets,
  listKiroAccounts,
  pinnedKiroTargets,
} from "../server/accounts.mjs";
import { listKiroProfiles } from "../server/profiles.mjs";
import { crc32 } from "../server/eventstream.mjs";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@oh-my-pi/pi-ai") return {
      url: "data:text/javascript," + encodeURIComponent(\`
        export class AssistantMessageEventStream {
          events = [];
          completion = Promise.withResolvers();
          push(event) { this.events.push(event); }
          end() { this.completion.resolve(this.events.at(-1)); }
          result() { return this.completion.promise; }
        }
      \`),
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { default: kiroExtension } = await import("../index.js");
const run = promisify(execFile);
const cli = fileURLToPath(new URL("../auth-cli.mjs", import.meta.url));

const arn = (region, id) => `arn:aws:codewhisperer:${region}:123456789012:profile/${id}`;
const DEFAULT_ARN = arn("us-east-1", "DEFAULT0001");
const PERSONAL_ARN = arn("us-east-1", "PERSONAL01");
const TEAM_ARN = arn("eu-central-1", "Team-02");
const TOKYO_ARN = arn("ap-northeast-1", "TOKYO00003");
const defaultLogin = {
  kind: "social",
  provider: "google",
  profile_arn: DEFAULT_ARN,
  access_token: "default-access",
  refresh_token: "default-refresh",
  expires_at: "2999-01-01T00:00:00Z",
};
const workLogin = {
  kind: "social",
  provider: "github",
  access_token: "work-access",
  refresh_token: "work-refresh",
  expires_at: "2999-01-01T00:00:00Z",
};

async function stores(t) {
  const root = await mkdtemp(join(tmpdir(), "kiro-accounts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authFile = join(root, "auth.sqlite3");
  const workFile = kiroAccountAuthFile("work", { authFile });
  await saveKiroAuth(defaultLogin, { authFile });
  await saveKiroAuth(workLogin, { authFile: workFile });
  await saveProfileCatalog([
    { arn: PERSONAL_ARN, name: "Personal" },
    { arn: TEAM_ARN, name: "Team: EU/1" },
    { arn: TOKYO_ARN, name: "Unsupported region" },
  ], { authFile: workFile, credential: workLogin });
  return { root, authFile, workFile };
}

function setEnv(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

function host() {
  const h = { providers: new Map(), removed: [], tools: new Map(), commands: new Map(), messages: [] };
  h.pi = {
    zod: z,
    on() {},
    registerTool: (tool) => h.tools.set(tool.name, tool),
    registerCommand: (name, command) => h.commands.set(name, command),
    registerProvider: (id, config) => h.providers.set(id, config),
    unregisterProvider: (id) => {
      h.removed.push(id);
      h.providers.delete(id);
    },
    sendMessage: (message) => h.messages.push(message),
    setModel: async (model) => {
      h.selected = model;
      return true;
    },
  };
  return h;
}

function frame(content) {
  const headers = Buffer.concat([
    [":message-type", "event"], [":event-type", "assistantResponseEvent"],
  ].map(([name, value]) => {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(Buffer.byteLength(value));
    return Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7]), size, Buffer.from(value)]);
  }));
  const body = Buffer.from(JSON.stringify({ content }));
  const bytes = Buffer.alloc(16 + headers.length + body.length);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.writeUInt32BE(headers.length, 4);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
  headers.copy(bytes, 12);
  body.copy(bytes, 12 + headers.length);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
  return bytes;
}

test("account profiles get stable providers, and pinning starts only when there is a choice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kiro-accounts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authFile = join(root, "auth.sqlite3");
  await saveKiroAuth(defaultLogin, { authFile });
  const alone = kiroTargets(await listKiroAccounts({ authFile }));
  // Without a listed catalog the saved selection is the account's one target.
  assert.deepEqual(alone.map(({ provider, label, name }) => ({ provider, label, name })), [
    { provider: "kiro-default-default0001", label: "default", name: null },
  ]);
  assert.deepEqual(pinnedKiroTargets(alone), [], "a lone default profile stays kiro-http only");

  const workFile = kiroAccountAuthFile("work", { authFile });
  assert.equal(workFile, join(root, "accounts", "work.sqlite3"));
  await saveKiroAuth(workLogin, { authFile: workFile });
  assert.equal(await saveProfileCatalog([{ arn: PERSONAL_ARN, name: "x" }], {
    authFile: workFile, credential: { ...workLogin, access_token: "another-login" },
  }), false, "a catalog listed by another login is not saved");
  await saveProfileCatalog([
    { arn: TEAM_ARN, name: "Team: EU/1" },
    { arn: PERSONAL_ARN, name: "Personal" },
    { arn: TOKYO_ARN, name: "Unsupported region" },
  ], { authFile: workFile, credential: workLogin });
  // Stray or reserved names never become accounts.
  for (const name of ["Work.sqlite3", "default.sqlite3", "http.sqlite3", "notes.txt"])
    await writeFile(join(root, "accounts", name), "");
  await mkdir(join(root, "accounts", "folder.sqlite3"));

  const accounts = await listKiroAccounts({ authFile });
  assert.deepEqual(accounts.map(({ name }) => name), ["default", "work"]);
  const targets = kiroTargets(accounts);
  assert.deepEqual(targets.map(({ provider, label, arn }) => ({ provider, label, arn })), [
    { provider: "kiro-default-default0001", label: "default", arn: DEFAULT_ARN },
    { provider: "kiro-work-team02", label: "work · Team EU 1", arn: TEAM_ARN },
    { provider: "kiro-work-personal01", label: "work · Personal", arn: PERSONAL_ARN },
  ]);
  assert.deepEqual(pinnedKiroTargets(targets), targets);
  assert.equal(kiroTargetProvider("work", PERSONAL_ARN), "kiro-work-personal01");
  for (const name of ["Work", "http", "cli", "-work", "work-", "a".repeat(33)])
    assert.throws(() => kiroAccountAuthFile(name, { authFile }), /Account names/);
  assert.equal(kiroAccountAuthFile("default", { authFile }), authFile);
});

test("listing saves the catalog; logout and a replacing login clear it", async (t) => {
  const { workFile } = await stores(t);
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.authorization, "Bearer work-access");
    return Response.json({ profiles: [{ arn: PERSONAL_ARN, profileName: "Renamed" }] });
  });
  await listKiroProfiles({ authFile: workFile });
  assert.deepEqual((await readProfileCatalog({ authFile: workFile })).profiles, [
    { arn: PERSONAL_ARN, name: "Renamed", region: "us-east-1", accountId: "123456789012" },
  ]);
  await saveKiroAuth({ ...workLogin, access_token: "next-login" }, { authFile: workFile, replacesLogin: true });
  assert.equal(await readProfileCatalog({ authFile: workFile }), null);
  await saveProfileCatalog([{ arn: PERSONAL_ARN, name: "Personal" }], {
    authFile: workFile, credential: { ...workLogin, access_token: "next-login" },
  });
  await logoutKiroAuth({ authFile: workFile });
  assert.equal(await readProfileCatalog({ authFile: workFile }), null);
});

test("pinned auth refreshes and persists tokens without changing the saved profile", async (t) => {
  const { authFile } = await stores(t);
  await saveKiroAuth({ ...defaultLogin, expires_at: "2000-01-01T00:00:00Z" }, { authFile });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
    return Response.json({ accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600 });
  });
  const provider = pinnedKiroAuth({ authFile, profileArn: PERSONAL_ARN });
  const pinned = await provider();
  assert.equal(pinned.profile_arn, PERSONAL_ARN);
  assert.equal(pinned.access_token, "rotated-access");
  const saved = JSON.parse(await readAuthSnapshot({ authFile }));
  assert.equal(saved.profile_arn, DEFAULT_ARN);
  assert.equal(saved.refresh_token, "rotated-refresh");
  await assert.rejects(
    provider({ expectedCredential: { ...pinned, provider: "github" } }),
    /changed during recovery/,
  );
});

test("pinned providers register offline and route generation, models, search and selection to their account", async (t) => {
  const { authFile } = await stores(t);
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", undefined);
  const requests = [];
  let online = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(online, "registration must not contact Kiro");
    const target = new URL(url);
    requests.push({
      host: target.hostname,
      path: target.pathname,
      token: init.headers.authorization,
      profile: target.searchParams.get("profileArn") ?? init.headers["x-amzn-kiro-profile-arn"] ??
        JSON.parse(init.body ?? "{}").profileArn,
    });
    if (target.hostname.startsWith("management."))
      return Response.json({ models: [{ modelId: "auto", modelName: "Auto" }] });
    if (target.pathname === "/mcp") {
      const { id } = JSON.parse(init.body);
      return Response.json({ jsonrpc: "2.0", id, result: { structuredContent: { results: [] } } });
    }
    return new Response(frame("work answer"));
  });
  const h = host();
  await kiroExtension(h.pi);
  assert.deepEqual([...h.providers.keys()], [
    "kiro-http", "kiro-default-default0001", "kiro-work-team02", "kiro-work-personal01",
  ]);
  online = true;

  const personal = h.providers.get("kiro-work-personal01");
  assert.deepEqual((await personal.fetchDynamicModels()).map(({ id, name }) => ({ id, name })), [
    { id: "auto", name: "Kiro · work · Personal · Auto" },
  ]);
  const model = { id: "auto", provider: "kiro-work-personal01", api: "kiro-cli-http", reasoning: false };
  const result = await personal.streamSimple(model, { messages: [{ role: "user", content: "hi" }] }).result();
  assert.equal(result.type, "done");
  assert.deepEqual(result.message.content, [{ type: "text", text: "work answer" }]);

  const ctx = {
    model,
    isIdle: () => true,
    modelRegistry: {
      refreshProvider: async () => {},
      find: (provider, id) => ({ id, provider, api: "kiro-cli-http" }),
    },
  };
  await h.commands.get("kiro-models").handler("", ctx);
  assert.match(h.messages.at(-1).content, /Account profile: work · Personal \(kiro-work-personal01\)/);
  await h.tools.get("web_search").execute("call", { query: "kiro" }, undefined, undefined, ctx);
  await h.commands.get("kiro-model").handler("kiro-work-team02/auto", ctx);
  assert.deepEqual(h.selected, { id: "auto", provider: "kiro-work-team02", api: "kiro-cli-http" });
  assert.match(h.messages.at(-1).content, /kiro-work-team02\/auto is now the session model/);

  assert.ok(requests.length >= 4);
  for (const request of requests) {
    assert.equal(request.token, "Bearer work-access", `${request.host}${request.path}`);
    assert.equal(request.profile, PERSONAL_ARN, `${request.host}${request.path}`);
  }
  assert.equal(JSON.parse(await readAuthSnapshot({ authFile })).profile_arn, DEFAULT_ARN);
});

test("signing an account out removes its providers, and its old models fail without falling back", async (t) => {
  const { authFile, workFile } = await stores(t);
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", undefined);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No request is expected");
  });
  const h = host();
  await kiroExtension(h.pi);
  const stale = h.providers.get("kiro-work-personal01");
  await logoutKiroAuth({ authFile: workFile });
  await h.commands.get("kiro-accounts").handler("", { isIdle: () => true });
  assert.match(h.messages.at(-1).content, /work — .*\nStatus: signed out/);
  // The default account alone is no longer a choice, so every pinned provider goes.
  assert.deepEqual(h.removed, ["kiro-default-default0001", "kiro-work-team02", "kiro-work-personal01"]);
  assert.deepEqual([...h.providers.keys()], ["kiro-http"]);
  const result = await stale.streamSimple(
    { id: "auto", provider: "kiro-work-personal01", api: "kiro-cli-http" },
    { messages: [{ role: "user", content: "hi" }] },
  ).result();
  assert.equal(result.type, "error");
  assert.match(result.error.errorMessage, /no longer signed in.*no replacement/);
});

test("the accounts command lists every store without printing credentials", async (t) => {
  const { authFile } = await stores(t);
  const options = { env: { ...process.env, PATH: "/no-kiro-cli" }, timeout: 10000 };
  const { stdout } = await run(process.execPath, [cli, "accounts", "--auth-file", authFile, "--json"], options);
  const listed = JSON.parse(stdout);
  assert.deepEqual(listed.accounts.map(({ name, selectedArn }) => ({ name, selectedArn })), [
    { name: "default", selectedArn: DEFAULT_ARN },
    { name: "work", selectedArn: null },
  ]);
  assert.deepEqual(listed.targets.map(({ provider, pinned }) => ({ provider, pinned })), [
    { provider: "kiro-default-default0001", pinned: true },
    { provider: "kiro-work-team02", pinned: true },
    { provider: "kiro-work-personal01", pinned: true },
  ]);
  const text = await run(process.execPath, [cli, "accounts", "--auth-file", authFile], options);
  for (const output of [stdout, text.stdout])
    for (const secret of ["default-access", "default-refresh", "work-access", "work-refresh"])
      assert.ok(!output.includes(secret));
  assert.match(text.stdout, /kiro-work-personal01\/… — Personal/);
  const status = await run(process.execPath, [cli, "auth", "status", "--auth-file", authFile, "--account", "work", "--json"], options);
  assert.equal(JSON.parse(status.stdout).provider, "github");
  await assert.rejects(
    run(process.execPath, [cli, "auth", "status", "--auth-file", authFile, "--account", "http"], options),
    /Account names/,
  );
});
