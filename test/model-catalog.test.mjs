import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { PROVIDER_CAPABILITIES } from "@getpaseo/plugin/server/provider";
import { readAuthSnapshot, saveKiroAuth } from "../server/auth.mjs";
import { kiroCatalogAccountId, readKiroModelCatalog } from "../server/model-catalog.mjs";
import { createKiroHttpProvider } from "../server/provider.mjs";

// Only the unused stream constructor is substituted: registration executes the real
// extension, auth store, bounded catalog reader, commands, and web-tool registration.
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@oh-my-pi/pi-ai") return {
      url: "data:text/javascript,export class AssistantMessageEventStream { constructor() { throw new Error('Registration test must not generate'); } }",
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { default: kiroExtension } = await import("../index.js");

const auth = {
  kind: "social",
  provider: "google",
  profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/catalog-fixture",
  access_token: "catalog-access-secret",
  refresh_token: "catalog-refresh-secret",
  expires_at: "2000-01-01T00:00:00Z",
};
const models = [
  { id: "vendor.Exact-ID:2026/v2", name: "Exact model · name", contextWindow: 234567, maxTokens: 12345 },
  { id: "second", name: "Second" },
];
async function fixture(t, credential = auth) {
  const root = await mkdtemp(join(tmpdir(), "kiro-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "models.json");
  const authFile = join(root, "auth.sqlite3");
  const snapshot = {
    version: 1,
    fetchedAt: "2001-01-01T00:00:00.000Z",
    accountId: kiroCatalogAccountId(credential),
    models,
  };
  await writeFile(file, JSON.stringify(snapshot));
  await saveKiroAuth(credential, { authFile });
  return { root, file, authFile, snapshot };
}

function noNetwork(t) {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("Catalog startup must not contact the network");
  });
  t.after(() => assert.equal(calls, 0));
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

test("bounded account snapshot preserves exact rows and old metadata without auth or network side effects", async (t) => {
  noNetwork(t);
  const f = await fixture(t);
  const before = await readAuthSnapshot({ authFile: f.authFile });
  const modified = (await stat(f.authFile)).mtimeMs;
  assert.deepEqual(await readKiroModelCatalog(f.file, { auth }), models);
  assert.equal(await readAuthSnapshot({ authFile: f.authFile }), before);
  assert.equal((await stat(f.authFile)).mtimeMs, modified);
  assert.doesNotMatch(await readFile(f.file, "utf8"), /catalog-access-secret|catalog-refresh-secret|arn:aws/);
});

test("profile-preserving token renewal is accepted but provider/profile/issuer changes are rejected", async (t) => {
  const f = await fixture(t);
  const renewed = { ...auth, access_token: "new-access", refresh_token: "new-refresh" };
  assert.equal(kiroCatalogAccountId(renewed), kiroCatalogAccountId(auth));
  assert.deepEqual(await readKiroModelCatalog(f.file, { auth: renewed }), models);
  for (const changed of [
    { ...auth, profile_arn: `${auth.profile_arn}-other` },
    { ...auth, provider: "github" },
    { ...auth, region: "eu-central-1" },
    { ...auth, kind: "oidc", provider: "builder-id", region: "us-east-1", client_id: "other-client" },
  ]) await assert.rejects(readKiroModelCatalog(f.file, { auth: changed }), /different managed account.*models\.cmd/);
});

test("without a profile ARN refresh-token rotation fails closed; access-only identities bind access tokens", async (t) => {
  const unprofiled = { ...auth };
  delete unprofiled.profile_arn;
  const f = await fixture(t, unprofiled);
  assert.deepEqual(await readKiroModelCatalog(f.file, {
    auth: { ...unprofiled, access_token: "rotated-access-only" },
  }), models);
  await assert.rejects(readKiroModelCatalog(f.file, {
    auth: { ...unprofiled, refresh_token: "rotated-refresh" },
  }), /different managed account.*models\.cmd/);
  const accessOnly = { ...unprofiled };
  delete accessOnly.refresh_token;
  assert.notEqual(kiroCatalogAccountId(accessOnly), kiroCatalogAccountId({ ...accessOnly, access_token: "other" }));
  assert.throws(() => kiroCatalogAccountId({ kind: "social", provider: "google" }), /models\.cmd/);
});

test("empty stays empty; malformed, secret-bearing, oversized, and missing catalogs fail closed", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ ...f.snapshot, models: [] }));
  assert.deepEqual(await readKiroModelCatalog(f.file, { auth }), []);
  for (const invalid of [
    "not JSON", "\ufffd", JSON.stringify({ ...f.snapshot, version: 2 }),
    JSON.stringify({ ...f.snapshot, fetchedAt: "yesterday" }),
    JSON.stringify({ ...f.snapshot, accountId: undefined }),
    JSON.stringify({ ...f.snapshot, access_token: "must-not-be-a-catalog-field" }),
    JSON.stringify({ ...f.snapshot, models: [{ id: "", name: "Missing ID" }] }),
    JSON.stringify({ ...f.snapshot, models: [{ id: "one", name: " " }] }),
    JSON.stringify({ ...f.snapshot, models: [{ id: "one", name: "One", contextWindow: 0 }] }),
    JSON.stringify({ ...f.snapshot, models: [{ id: "one", name: "One", maxTokens: 1.5 }] }),
    JSON.stringify({ ...f.snapshot, models: [models[0], models[0]] }),
    JSON.stringify({ ...f.snapshot, models: [{ ...models[0], token: "secret" }] }),
    " ".repeat(4 * 1024 * 1024 + 1),
  ]) {
    await writeFile(f.file, invalid);
    await assert.rejects(readKiroModelCatalog(f.file, { auth }), /models\.cmd/);
  }
  await writeFile(f.file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readKiroModelCatalog(f.file, { auth }), /models\.cmd/);
  await assert.rejects(readKiroModelCatalog(join(f.root, "missing.json"), { auth }), /models\.cmd/);
  await assert.rejects(readKiroModelCatalog("relative.json", { auth }), /models\.cmd/);
});

function registrationHost() {
  const providers = [];
  return {
    providers,
    pi: { zod: z, on() {}, registerCommand() {}, registerTool() {},
      registerProvider: (id, config) => providers.push({ id, config }) },
  };
}

test("actual async OMP extension registers authoritative account models offline without a dynamic refresh callback", async (t) => {
  noNetwork(t);
  const f = await fixture(t);
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", f.file);
  const h = registrationHost();
  await kiroExtension(h.pi);
  assert.equal(h.providers.length, 1);
  const { id, config } = h.providers[0];
  assert.equal(id, "kiro-http");
  assert.deepEqual(config.models.map(({ id, name, contextWindow, maxTokens }) => ({ id, name, contextWindow, maxTokens })), [
    { ...models[0], name: `Kiro · ${models[0].name}` },
    { ...models[1], name: `Kiro · ${models[1].name}`, contextWindow: 128000, maxTokens: 16000 },
  ]);
  assert.equal(Object.hasOwn(config, "fetchDynamicModels"), false);
  assert.equal(typeof config.streamSimple, "function");
  await writeFile(f.file, JSON.stringify({ ...f.snapshot, models: [] }));
  const empty = registrationHost();
  await kiroExtension(empty.pi);
  assert.deepEqual(empty.providers[0].config.models, []);
  assert.equal(Object.hasOwn(empty.providers[0].config, "fetchDynamicModels"), false);
});

test("OMP configured wrong-account snapshot rejects before registration; no explicit path keeps live discovery", async (t) => {
  noNetwork(t);
  const f = await fixture(t);
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", f.file);
  await saveKiroAuth({ ...auth, profile_arn: `${auth.profile_arn}-other` }, { authFile: f.authFile });
  const h = registrationHost();
  await assert.rejects(kiroExtension(h.pi), /different managed account.*models\.cmd/);
  assert.deepEqual(h.providers, []);
  delete process.env.OMP_KIRO_MODEL_CATALOG_FILE;
  await kiroExtension(h.pi);
  assert.equal(Object.hasOwn(h.providers[0].config, "models"), false);
  assert.equal(typeof h.providers[0].config.fetchDynamicModels, "function");
});

async function nativeConnection(t, f) {
  let generationAuthCalls = 0;
  const provider = createKiroHttpProvider({
    stateDir: join(f.root, "state"),
    authProvider: async () => {
      generationAuthCalls++;
      throw new Error("Current generation auth required; snapshot credentials are not usable");
    },
    fetchImpl: async () => { throw new Error("No network allowed during cached startup"); },
  });
  const connection = await provider.connect({
    versions: [1], capabilities: PROVIDER_CAPABILITIES,
    launch: { command: process.execPath, args: [], env: {
      OMP_KIRO_AUTH_FILE: f.authFile, OMP_KIRO_MODEL_CATALOG_FILE: f.file,
    } },
  });
  t.after(() => connection.close());
  const events = [];
  const pending = new Set();
  connection.onEvent((event) => {
    events.push(event);
    for (const check of pending) check();
  });
  const waitFor = (predicate) => {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(check); reject(new Error("Missing native event")); }, 5000);
      const check = () => {
        const result = events.find(predicate);
        if (!result) return;
        clearTimeout(timer);
        pending.delete(check);
        resolve(result);
      };
      pending.add(check);
    });
  };
  return { connection, events, waitFor, generationAuthCalls: () => generationAuthCalls };
}

test("native catalog and session initialize offline from real metadata, then require current auth for generation", async (t) => {
  noNetwork(t);
  const f = await fixture(t);
  const h = await nativeConnection(t, f);
  await h.connection.send({ type: "catalog", requestId: "catalog" });
  const catalog = await h.waitFor((e) => e.type === "catalog");
  assert.deepEqual(catalog.catalog.models, [
    { id: models[0].id, label: models[0].name, contextWindowMaxTokens: models[0].contextWindow },
    { id: models[1].id, label: models[1].name },
  ]);
  assert.equal(catalog.catalog.defaultMode, "full");
  await h.connection.send({
    type: "session.open", requestId: "open", sessionId: "offline", history: "replay",
    config: { cwd: f.root, env: {}, mcpServers: {}, model: models[0].id, settings: {}, persist: false },
  });
  await h.waitFor((e) => e.type === "session.ready" && e.requestId === "open");
  assert.equal(h.generationAuthCalls(), 0);
  const configuration = h.events.find((e) => e.type === "session.config");
  assert.equal(configuration.config.model, models[0].id);
  assert.equal(configuration.config.mode, "full");
  await h.connection.send({
    type: "session.prompt", sessionId: "offline",
    prompt: { clientMessageId: "needs-auth", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "Work" }] } },
  });
  const terminal = await h.waitFor((e) => e.type === "session.turn" && e.state === "failed");
  assert.match(terminal.error.message, /Current generation auth required/);
  assert.equal(h.generationAuthCalls(), 1);
});

test("native cached catalog rejects a switched account and startup rejects unadvertised model IDs", async (t) => {
  noNetwork(t);
  const f = await fixture(t);
  const h = await nativeConnection(t, f);
  await h.connection.send({
    type: "session.open", requestId: "bad-model", sessionId: "bad-model", history: "replay",
    config: { cwd: f.root, env: {}, mcpServers: {}, model: "invented", settings: {}, persist: false },
  });
  const invalid = await h.waitFor((e) => e.type === "request.failed" && e.requestId === "bad-model");
  assert.match(invalid.error.message, /exact Kiro model ID/);
  await saveKiroAuth({ ...auth, profile_arn: `${auth.profile_arn}-other` }, { authFile: f.authFile });
  await h.connection.send({ type: "catalog", requestId: "wrong-account" });
  const switched = await h.waitFor((e) => e.type === "request.failed" && e.requestId === "wrong-account");
  assert.match(switched.error.message, /different managed account.*models\.cmd/);
  assert.equal(h.generationAuthCalls(), 0);
});
