import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { readAuthSnapshot, saveKiroAuth } from "../server/auth.mjs";
import { kiroCatalogAccountId, readKiroModelCatalog } from "../server/model-catalog.mjs";
import { crc32 } from "../server/eventstream.mjs";

// Replace only the host event-stream container. Catalog loading, HTTP request
// construction, auth, and response decoding run through the real extension.
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

test("version one snapshots retain native schemas without synthesizing absent controls", async (t) => {
  const f = await fixture(t);
  const schema = {
    type: "object",
    properties: {
      reasoning: { properties: { effort: { type: "string", enum: ["low", "high", "default"], default: "default" } } },
    },
    additionalProperties: false,
  };
  const rows = [
    { ...models[0], additionalModelRequestFieldsSchema: schema },
    { ...models[1], additionalModelRequestFieldsSchema: null },
  ];
  await writeFile(f.file, JSON.stringify({ ...f.snapshot, models: rows }));
  assert.deepEqual(await readKiroModelCatalog(f.file, { auth }), [
    rows[0], models[1],
  ]);
  for (const malformed of [[], "{}", false, { properties: [] }, {
    properties: { output_config: { properties: { effort: { enum: ["high", 1] } } } },
  }]) {
    await writeFile(f.file, JSON.stringify({
      ...f.snapshot, models: [{ ...models[0], additionalModelRequestFieldsSchema: malformed }],
    }));
    await assert.rejects(readKiroModelCatalog(f.file, { auth }), /malformed.*schema.*models\.cmd/);
  }
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

function profileCommandHost() {
  const h = registrationHost();
  h.commands = new Map();
  h.messages = [];
  h.selected = [];
  const catalogs = new Map();
  h.ctx = {
    model: cachedModel,
    isIdle: () => true,
    modelRegistry: {
      async refreshProvider(provider) {
        const { config } = h.providers.findLast((entry) => entry.id === provider);
        catalogs.set(provider, config.fetchDynamicModels ? await config.fetchDynamicModels() : config.models);
      },
      find: (provider, id) => {
        const model = catalogs.get(provider)?.find((model) => model.id === id);
        return model ? { ...model, provider, api: "kiro-cli-http" } : undefined;
      },
    },
  };
  h.pi.registerCommand = (name, command) => h.commands.set(name, command);
  h.pi.sendMessage = (message) => h.messages.push(message);
  h.pi.setModel = async (model) => {
    h.selected.push(model);
    h.ctx.model = model;
    return true;
  };
  return h;
}

test("default OMP transport registers authoritative HTTP account models offline without CLI discovery", async (t) => {
  noNetwork(t);
  const f = await fixture(t);
  setEnv(t, "OMP_KIRO_TRANSPORT", undefined);
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


function frame(event, payload) {
  const headers = Buffer.concat([
    [":message-type", "event"], [":event-type", event],
  ].map(([name, value]) => {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(Buffer.byteLength(value));
    return Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7]), size, Buffer.from(value)]);
  }));
  const body = Buffer.from(JSON.stringify(payload));
  const bytes = Buffer.alloc(16 + headers.length + body.length);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.writeUInt32BE(headers.length, 4);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
  headers.copy(bytes, 12);
  body.copy(bytes, 12 + headers.length);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
  return bytes;
}

const answer = (content) => frame("assistantResponseEvent", { content });
const reasoningEvent = (data) => frame("reasoningContentEvent", data);

function textResponse() {
  return new Response(answer("Kiro answer"));
}

const turnContext = { messages: [{ role: "user", content: "Say hello" }] };
const cachedModel = { id: "cached", provider: "kiro-http", api: "kiro-cli-http", reasoning: true };
const cachedSchema = {
  properties: { reasoning: { properties: { effort: { enum: ["low", "high", "none"] } } } },
};

test("host cache hits recover native effort schemas in each new extension instance", async (t) => {
  const f = await fixture(t, { ...auth, expires_at: "2999-01-01T00:00:00Z" });
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", undefined);
  let discoveries = 0;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname.startsWith("management.")) {
      discoveries++;
      return Response.json({ models: [
        { modelId: "cached", additionalModelRequestFieldsSchema: cachedSchema },
        { modelId: "plain" },
      ] });
    }
    requests.push(JSON.parse(init.body));
    return textResponse();
  });
  for (let instance = 1; instance <= 2; instance++) {
    const h = registrationHost();
    await kiroExtension(h.pi);
    const { config } = h.providers[0];
    assert.equal(discoveries, instance - 1, "registration stays lazy");
    // OMP restored its own model cache, so fetchDynamicModels is never invoked.
    for (const options of [{ reasoning: "high" }, { forceReasoningOff: true }]) {
      const result = await config.streamSimple(cachedModel, turnContext, options).result();
      assert.equal(result.type, "done");
      assert.deepEqual(result.message.content, [{ type: "text", text: "Kiro answer" }]);
    }
    const plain = await config.streamSimple({ ...cachedModel, id: "plain", reasoning: false }, turnContext).result();
    assert.equal(plain.type, "done");
    assert.equal(discoveries, instance, "one catalog load also covers models without schemas");
  }
  assert.deepEqual(requests.map((request) => request.additionalModelRequestFields), [
    { reasoning: { effort: "high" } }, { reasoning: { effort: "none" } }, undefined,
    { reasoning: { effort: "high" } }, { reasoning: { effort: "none" } }, undefined,
  ]);
  for (const request of requests) {
    assert.equal(request.conversationState.currentMessage.userInputMessage.content, "Say hello");
    assert.deepEqual(request.conversationState.history, []);
  }
});

test("snapshot effort generation uses its native schema without live model discovery", async (t) => {
  const f = await fixture(t, { ...auth, expires_at: "2999-01-01T00:00:00Z" });
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", f.file);
  await writeFile(f.file, JSON.stringify({
    ...f.snapshot,
    models: [{ id: "cached", name: "Cached", additionalModelRequestFieldsSchema: cachedSchema }],
  }));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).hostname, "runtime.us-east-1.kiro.dev");
    requests.push(JSON.parse(init.body).additionalModelRequestFields);
    return textResponse();
  });
  const h = registrationHost();
  await kiroExtension(h.pi);
  const result = await h.providers[0].config.streamSimple(cachedModel, turnContext, { reasoning: "low" }).result();
  assert.equal(result.type, "done");
  assert.deepEqual(result.message.content, [{ type: "text", text: "Kiro answer" }]);
  assert.deepEqual(requests, [{ reasoning: { effort: "low" } }]);
});

test("failed cache hydration rejects the turn before generation and can be retried", async (t) => {
  const f = await fixture(t, { ...auth, expires_at: "2999-01-01T00:00:00Z" });
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", undefined);
  let discoveries = 0;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname.startsWith("management.")) {
      if (++discoveries === 1) return new Response(null, { status: 403 });
      return Response.json({ models: [{ modelId: "cached", additionalModelRequestFieldsSchema: cachedSchema }] });
    }
    requests.push(JSON.parse(init.body).additionalModelRequestFields);
    return textResponse();
  });
  const h = registrationHost();
  await kiroExtension(h.pi);
  const { config } = h.providers[0];
  const failure = await config.streamSimple(cachedModel, turnContext, { reasoning: "high" }).result();
  assert.equal(failure.type, "error");
  assert.match(failure.error.errorMessage, /model catalog failed \(HTTP 403\)/);
  assert.deepEqual(requests, []);
  const recovered = await config.streamSimple(cachedModel, turnContext, { reasoning: "high" }).result();
  assert.equal(recovered.type, "done");
  assert.deepEqual(requests, [{ reasoning: { effort: "high" } }]);
  assert.equal(discoveries, 2);
});

test("cancelling one concurrent cache-hit turn leaves the shared schema load usable", async (t) => {
  const f = await fixture(t, { ...auth, expires_at: "2999-01-01T00:00:00Z" });
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", undefined);
  const discovery = Promise.withResolvers();
  const started = Promise.withResolvers();
  let discoveries = 0;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname.startsWith("management.")) {
      discoveries++;
      started.resolve();
      return discovery.promise;
    }
    requests.push(JSON.parse(init.body).additionalModelRequestFields);
    return textResponse();
  });
  const h = registrationHost();
  await kiroExtension(h.pi);
  const { config } = h.providers[0];
  const controller = new AbortController();
  const cancelled = config.streamSimple(cachedModel, turnContext, {
    reasoning: "high", signal: controller.signal,
  });
  const continuing = config.streamSimple(cachedModel, turnContext, { reasoning: "low" });
  await started.promise;
  controller.abort();
  const aborted = await cancelled.result();
  assert.equal(aborted.type, "error");
  assert.equal(aborted.error.stopReason, "aborted");
  assert.deepEqual(requests, []);
  discovery.resolve(Response.json({
    models: [{ modelId: "cached", additionalModelRequestFieldsSchema: cachedSchema }],
  }));
  const completed = await continuing.result();
  assert.equal(completed.type, "done");
  assert.deepEqual(completed.message.content, [{ type: "text", text: "Kiro answer" }]);
  assert.deepEqual(requests, [{ reasoning: { effort: "low" } }]);
  assert.equal(discoveries, 1);
});

test("OMP Auto/off uses the native minimum for mandatory reasoning, not the model default", async (t) => {
  const f = await fixture(t, { ...auth, expires_at: "2999-01-01T00:00:00Z" });
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", undefined);
  let schema;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname.startsWith("management."))
      return Response.json({ models: [{ modelId: "cached", additionalModelRequestFieldsSchema: schema }] });
    requests.push(JSON.parse(init.body).additionalModelRequestFields);
    return textResponse();
  });
  for (const [path, levels, minimum] of [
    ["output_config", ["max", "high", "low", "medium", "xhigh"], "low"],
    ["reasoning", ["max", "high", "medium"], "medium"],
  ]) {
    schema = { properties: {
      [path]: { properties: { effort: { enum: levels, default: "high" } } },
      thinking: { properties: { type: { enum: ["adaptive"] } } },
    } };
    const h = registrationHost();
    await kiroExtension(h.pi);
    const { config } = h.providers[0];
    const start = requests.length;
    // No dynamic discovery callback: the request schema must also be hydrated
    // when the host supplies a cached model with missing thinking metadata.
    for (const options of [
      {},
      { disableReasoning: true },
      { reasoning: "high", forceReasoningOff: true },
      { reasoning: "high", disableReasoning: true, forceReasoningOff: true },
      { reasoning: "high" },
    ]) {
      const before = structuredClone(options);
      const result = await config.streamSimple(cachedModel, turnContext, options).result();
      assert.equal(result.type, "done");
      assert.deepEqual(result.message.content, [{ type: "text", text: "Kiro answer" }]);
      assert.deepEqual(options, before);
    }
    assert.deepEqual(requests.slice(start), [
      { [path]: { effort: minimum } },
      { [path]: { effort: minimum } },
      { [path]: { effort: minimum } },
      { [path]: { effort: minimum } },
      { [path]: { effort: "high" } },
    ]);
    const count = requests.length;
    const unsupported = await config.streamSimple(cachedModel, turnContext, { reasoning: "minimal" }).result();
    assert.equal(unsupported.type, "error");
    assert.match(unsupported.error.errorMessage, /does not advertise requested effort: minimal/);
    assert.equal(requests.length, count, "unsupported positive effort must not generate");
  }
});

test("OMP Auto/off preserves advertised native off controls and omitted defaults", async (t) => {
  const f = await fixture(t, { ...auth, expires_at: "2999-01-01T00:00:00Z" });
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", undefined);
  let schema;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname.startsWith("management."))
      return Response.json({ models: [{ modelId: "cached", additionalModelRequestFieldsSchema: schema }] });
    requests.push(JSON.parse(init.body).additionalModelRequestFields);
    return textResponse();
  });
  for (const [native, off] of [
    [{ properties: {
      output_config: { properties: { effort: { enum: ["low", "high"] } } },
      thinking: { properties: { type: { enum: ["adaptive", "disabled"] } } },
    } }, { thinking: { type: "disabled" } }],
    [cachedSchema, { reasoning: { effort: "none" } }],
  ]) {
    schema = native;
    const h = registrationHost();
    await kiroExtension(h.pi);
    const { config } = h.providers[0];
    const start = requests.length;
    for (const options of [
      { reasoning: "high", disableReasoning: true },
      { reasoning: "high", forceReasoningOff: true },
      {},
    ]) {
      const result = await config.streamSimple(cachedModel, turnContext, options).result();
      assert.equal(result.type, "done");
      assert.deepEqual(result.message.content, [{ type: "text", text: "Kiro answer" }]);
    }
    assert.deepEqual(requests.slice(start), [off, off, undefined]);
  }
});

test("profile switch bypasses an old snapshot and replaces native schemas without choosing another model", async (t) => {
  const credential = { ...auth, expires_at: "2999-01-01T00:00:00Z" };
  const f = await fixture(t, credential);
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", f.file);
  await writeFile(f.file, JSON.stringify({
    ...f.snapshot,
    models: [{ id: "cached", name: "Cached", additionalModelRequestFieldsSchema: cachedSchema }],
  }));
  const nextArn = `${auth.profile_arn}-next`;
  const nextSchema = {
    properties: { output_config: { properties: { effort: { enum: ["high", "none"] } } } },
  };
  let discoveries = 0;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init.headers["x-amz-target"]?.endsWith(".ListAvailableProfiles"))
      return Response.json({ profiles: [
        { arn: auth.profile_arn, profileName: "Original" },
        { arn: nextArn, profileName: "Next Profile" },
      ] });
    if (new URL(url).hostname.startsWith("management.")) {
      discoveries++;
      return Response.json({ models: [
        { modelId: "cached", additionalModelRequestFieldsSchema: nextSchema },
        { modelId: "unrelated" },
      ] });
    }
    requests.push(JSON.parse(init.body).additionalModelRequestFields);
    return textResponse();
  });
  const h = profileCommandHost();
  await kiroExtension(h.pi);
  const originalConfig = h.providers[0].config;
  const before = await originalConfig.streamSimple(cachedModel, turnContext, { reasoning: "high" }).result();
  assert.equal(before.type, "done");
  await h.commands.get("kiro-profile").handler("Next Profile", h.ctx);
  assert.match(h.messages.at(-1).content, /Kiro profile selected/);
  assert.match(h.messages.at(-1).content, /snapshot.*bypassed.*models\.cmd/);
  assert.match(h.messages.at(-1).content, /all sessions sharing this managed auth store/);
  assert.equal(discoveries, 1);
  assert.equal(h.selected.length, 1);
  assert.equal(h.selected[0].id, "cached");
  const unpinned = h.providers.findLast(({ id }) => id === "kiro-http").config;
  assert.deepEqual(unpinned.models, []);
  assert.equal(typeof unpinned.fetchDynamicModels, "function");
  // Listing saved the store's two profiles, so each now also has a pinned provider.
  assert.deepEqual(h.providers.slice(-2).map(({ id }) => id), [
    "kiro-default-catalogfixture", "kiro-default-catalogfixturenext",
  ]);
  // Even an old host stream closure must resolve the new profile's schema.
  const after = await originalConfig.streamSimple(h.ctx.model, turnContext, { reasoning: "high" }).result();
  assert.equal(after.type, "done");
  assert.deepEqual(requests, [
    { reasoning: { effort: "high" } },
    { output_config: { effort: "high" } },
  ]);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).accountId, f.snapshot.accountId);
});

test("external profile selection blocks old native schemas until an explicit model refresh", async (t) => {
  const credential = { ...auth, expires_at: "2999-01-01T00:00:00Z" };
  const f = await fixture(t, credential);
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", undefined);
  const nextSchema = {
    properties: { output_config: { properties: { effort: { enum: ["high", "none"] } } } },
  };
  let discoveries = 0;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname.startsWith("management.")) {
      discoveries++;
      return Response.json({ models: [{
        modelId: "cached",
        additionalModelRequestFieldsSchema: discoveries === 1 ? cachedSchema : nextSchema,
      }] });
    }
    requests.push(JSON.parse(init.body).additionalModelRequestFields);
    return textResponse();
  });
  const h = profileCommandHost();
  await kiroExtension(h.pi);
  const originalConfig = h.providers[0].config;
  assert.equal((await originalConfig.streamSimple(cachedModel, turnContext, { reasoning: "high" }).result()).type, "done");
  await saveKiroAuth({ ...credential, profile_arn: `${auth.profile_arn}-external` }, { authFile: f.authFile });
  const blocked = await originalConfig.streamSimple(cachedModel, turnContext, { reasoning: "high" }).result();
  assert.equal(blocked.type, "error");
  assert.match(blocked.error.errorMessage, /profile changed.*\/kiro-model/);
  assert.equal(discoveries, 1);
  assert.equal(requests.length, 1, "stale schemas must not reach generation");
  await h.commands.get("kiro-model").handler("cached", h.ctx);
  assert.match(h.messages.at(-1).content, /Kiro model selected/);
  assert.equal(h.selected[0].id, "cached");
  assert.equal((await originalConfig.streamSimple(h.ctx.model, turnContext, { reasoning: "high" }).result()).type, "done");
  assert.deepEqual(requests, [
    { reasoning: { effort: "high" } },
    { output_config: { effort: "high" } },
  ]);
  assert.equal(discoveries, 2);
});

const reasoningSchema = { properties: {
  output_config: { properties: { effort: { enum: ["low", "high"] } } },
  thinking: { properties: { type: { enum: ["adaptive"] }, display: { enum: ["summarized"] } } },
} };
const summarized = { type: "adaptive", display: "summarized" };
const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};
const opaque = "b3BhcXVlLXJlYXNvbmluZw==";

// Sends complete frames, then drops the socket or stays open until cancelled.
function partialResponse(frames, { hang = false } = {}) {
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(Buffer.concat(frames));
      } else if (hang) return new Promise(() => {});
      else controller.error(Object.assign(new TypeError("terminated"), {
        cause: Object.assign(new Error("socket disconnected"), { code: "UND_ERR_SOCKET" }),
      }));
    },
  }));
}

async function reasoningProvider(t, responses, { maxAttempts = "3" } = {}) {
  const f = await fixture(t, { ...auth, expires_at: "2999-01-01T00:00:00Z" });
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", undefined);
  setEnv(t, "OMP_KIRO_HTTP_MAX_ATTEMPTS", maxAttempts);
  setEnv(t, "OMP_KIRO_HTTP_RETRY_BASE_MS", "0");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname.startsWith("management."))
      return Response.json({ models: [{ modelId: "cached", additionalModelRequestFieldsSchema: reasoningSchema }] });
    requests.push(JSON.parse(init.body));
    return responses.shift();
  });
  const h = registrationHost();
  await kiroExtension(h.pi);
  return { requests, stream: (context, options) => h.providers[0].config.streamSimple(cachedModel, context, options) };
}

// Host-visible lifecycle: event type, content index, then delta or final content.
function lifecycle(events) {
  return events.map(({ type, contentIndex, delta, content }) => {
    if (contentIndex === undefined) return type;
    const value = delta ?? content;
    return typeof value === "string" ? [type, contentIndex, value] : [type, contentIndex];
  });
}

test("native reasoning phases stream around text with stable indices and replay the signed phase after tools", async (t) => {
  const p = await reasoningProvider(t, [
    new Response(Buffer.concat([
      reasoningEvent({ text: "Plan " }),
      reasoningEvent({ text: "steps" }),
      reasoningEvent({ signature: "sig-plan" }),
      answer("Answer"),
      reasoningEvent({ text: "Check" }),
      reasoningEvent({ signature: "sig-check" }),
      frame("toolUseEvent", { toolUseId: "tool-1", name: "read", input: "{\"path\":" }),
      frame("toolUseEvent", { toolUseId: "tool-1", input: "\"a\"}", stop: true }),
    ])),
    new Response(answer("Done")),
  ]);
  const context = { tools: [readTool], messages: [{ role: "user", content: "Read a" }] };
  const stream = p.stream(context, { reasoning: "high" });
  const result = await stream.result();
  assert.equal(result.type, "done");
  // Signature-only events never surface as deltas or text.
  assert.deepEqual(lifecycle(stream.events), [
    "start",
    ["thinking_start", 0], ["thinking_delta", 0, "Plan "], ["thinking_delta", 0, "steps"],
    ["thinking_end", 0, "Plan steps"],
    ["text_start", 1], ["text_delta", 1, "Answer"], ["text_end", 1, "Answer"],
    ["thinking_start", 2], ["thinking_delta", 2, "Check"], ["thinking_end", 2, "Check"],
    ["toolcall_start", 3], ["toolcall_delta", 3, "{\"path\":\"a\"}"], ["toolcall_end", 3],
    "done",
  ]);
  assert.equal(result.message.stopReason, "toolUse");
  assert.deepEqual(result.message.content, [
    { type: "thinking", thinking: "Plan steps", thinkingSignature: "sig-plan" },
    { type: "text", text: "Answer" },
    { type: "thinking", thinking: "Check", thinkingSignature: "sig-check" },
    { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a" } },
  ]);
  const followUp = await p.stream({ ...context, messages: [
    ...context.messages,
    result.message,
    { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "a" }], isError: false },
  ] }, { reasoning: "high" }).result();
  assert.equal(followUp.type, "done");
  assert.deepEqual(p.requests.map((request) => request.additionalModelRequestFields), [
    { output_config: { effort: "high" }, thinking: summarized },
    { output_config: { effort: "high" }, thinking: summarized },
  ]);
  // The native scalar carries the last complete signed phase, never a merge.
  assert.deepEqual(p.requests[1].conversationState.history[1], { assistantResponseMessage: {
    content: "Answer",
    toolUses: [{ toolUseId: "tool-1", name: "read", input: { path: "a" } }],
    reasoningContent: { reasoningText: { text: "Check", signature: "sig-check" } },
  } });
});

test("redacted reasoning stays opaque while a later unsigned phase is not replayed", async (t) => {
  const p = await reasoningProvider(t, [
    new Response(Buffer.concat([reasoningEvent({ redactedContent: opaque }), answer("Done")])),
    new Response(Buffer.concat([reasoningEvent({ text: "Visible summary" }), answer("Again")])),
    new Response(answer("Finished")),
  ]);
  const stream = p.stream(turnContext, {});
  const result = await stream.result();
  assert.equal(result.type, "done");
  assert.deepEqual(lifecycle(stream.events), [
    "start", ["text_start", 1], ["text_delta", 1, "Done"], ["text_end", 1, "Done"], "done",
  ]);
  assert.deepEqual(result.message.content, [
    { type: "redactedThinking", data: opaque },
    { type: "text", text: "Done" },
  ]);
  const nextContext = { messages: [
    ...turnContext.messages, result.message, { role: "user", content: "Again" },
  ] };
  const nextStream = p.stream(nextContext, {});
  const next = await nextStream.result();
  assert.equal(next.type, "done");
  assert.deepEqual(lifecycle(nextStream.events), [
    "start",
    ["thinking_start", 0], ["thinking_delta", 0, "Visible summary"], ["thinking_end", 0, "Visible summary"],
    ["text_start", 1], ["text_delta", 1, "Again"], ["text_end", 1, "Again"], "done",
  ]);
  // OMP Auto keeps the mandatory native minimum and asks for readable summaries.
  assert.deepEqual(p.requests[0].additionalModelRequestFields, {
    output_config: { effort: "low" }, thinking: summarized,
  });
  assert.deepEqual(p.requests[1].conversationState.history[1], {
    assistantResponseMessage: { content: "Done", reasoningContent: { redactedContent: opaque } },
  });
  await p.stream({ messages: [
    ...nextContext.messages, next.message, { role: "user", content: "Finish" },
  ] }, {}).result();
  assert.deepEqual(p.requests[2].conversationState.history[3], { assistantResponseMessage: { content: "Again" } });
});

test("socket failure and cancellation close open reasoning and text blocks exactly once", async (t) => {
  const p = await reasoningProvider(t, [
    partialResponse([reasoningEvent({ text: "Half" }), reasoningEvent({ signature: "sig-lost" }), answer("Partial")]),
    partialResponse([reasoningEvent({ text: "Waiting" })], { hang: true }),
  ], { maxAttempts: "1" });
  const failedStream = p.stream(turnContext, { reasoning: "high" });
  const failed = await failedStream.result();
  assert.equal(failed.type, "error");
  assert.equal(failed.error.stopReason, "error");
  assert.match(failed.error.errorMessage, /Kiro HTTP network error/);
  assert.deepEqual(lifecycle(failedStream.events), [
    "start",
    ["thinking_start", 0], ["thinking_delta", 0, "Half"], ["thinking_end", 0, "Half"],
    ["text_start", 1], ["text_delta", 1, "Partial"], ["text_end", 1, "Partial"],
    "error",
  ]);
  // A failed attempt keeps its displayed summary but loses replay eligibility.
  assert.deepEqual(failed.error.content, [{ type: "thinking", thinking: "Half" }, { type: "text", text: "Partial" }]);

  const controller = new AbortController();
  const abortedStream = p.stream(turnContext, { reasoning: "high", signal: controller.signal });
  for (let waits = 0; !abortedStream.events.some((event) => event.type === "thinking_delta"); waits++) {
    assert.ok(waits < 5000, "reasoning delta was not streamed");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  controller.abort();
  const aborted = await abortedStream.result();
  assert.equal(aborted.type, "error");
  assert.equal(aborted.error.stopReason, "aborted");
  assert.deepEqual(lifecycle(abortedStream.events), [
    "start", ["thinking_start", 0], ["thinking_delta", 0, "Waiting"], ["thinking_end", 0, "Waiting"], "error",
  ]);
});

test("a retried attempt opens new reasoning blocks and never signs earlier output", async (t) => {
  const p = await reasoningProvider(t, [
    partialResponse([reasoningEvent({ text: "First" }), reasoningEvent({ signature: "sig-old" }), answer("Hel")]),
    new Response(Buffer.concat([
      reasoningEvent({ text: "Second" }), reasoningEvent({ signature: "sig-new" }), answer("lo"),
    ])),
    new Response(answer("Next")),
  ]);
  const stream = p.stream(turnContext, { reasoning: "high" });
  const result = await stream.result();
  assert.equal(result.type, "done");
  assert.deepEqual(lifecycle(stream.events), [
    "start",
    ["thinking_start", 0], ["thinking_delta", 0, "First"], ["thinking_end", 0, "First"],
    ["text_start", 1], ["text_delta", 1, "Hel"], ["text_end", 1, "Hel"],
    ["thinking_start", 2], ["thinking_delta", 2, "Second"], ["thinking_end", 2, "Second"],
    ["text_start", 3], ["text_delta", 3, "lo"], ["text_end", 3, "lo"],
    "done",
  ]);
  assert.deepEqual(result.message.content, [
    { type: "thinking", thinking: "First" },
    { type: "text", text: "Hel" },
    { type: "thinking", thinking: "Second", thinkingSignature: "sig-new" },
    { type: "text", text: "lo" },
  ]);
  // Continuation replays committed text only; the abandoned signature is gone.
  assert.deepEqual(p.requests[1].conversationState.history.at(-1), { assistantResponseMessage: { content: "Hel" } });
  const next = await p.stream({ messages: [
    ...turnContext.messages, result.message, { role: "user", content: "Next" },
  ] }, { reasoning: "high" }).result();
  assert.equal(next.type, "done");
  assert.deepEqual(p.requests[2].conversationState.history[1], { assistantResponseMessage: {
    content: "Hello",
    reasoningContent: { reasoningText: { text: "Second", signature: "sig-new" } },
  } });
});

test("native refusal reaches OMP as a structured error without releasing a buffered tool", async (t) => {
  const p = await reasoningProvider(t, [new Response(Buffer.concat([
    reasoningEvent({ text: "Review", signature: "not-replayable" }),
    frame("toolUseEvent", { toolUseId: "discarded", name: "read", input: "{}", stop: true }),
    frame("meteringEvent", { usage: 0.5, unit: "credits" }),
    frame("metadataEvent", {
      stopReason: "CONTENT_FILTERED", tokenUsage: { outputTokens: 7 },
      stopDetails: { refusal: { category: "OTHER", explanation: `Rejected ${auth.access_token}` } },
    }),
  ]))]);
  const stream = p.stream({ ...turnContext, tools: [readTool] }, { reasoning: "high" });
  const result = await stream.result();
  assert.equal(result.type, "error");
  assert.deepEqual(result.error.stopDetails, {
    type: "refusal", category: "OTHER", explanation: "Rejected [redacted]",
  });
  assert.deepEqual(result.error.content, [{ type: "thinking", thinking: "Review" }]);
  assert.equal(result.error.usage.output, 7);
  assert.deepEqual(result.error.usage.credits, { cost: 0.5 });
  assert.ok(!stream.events.some(({ type }) => type.startsWith("toolcall") || type === "done"));
  assert.equal(p.requests.length, 1);
});

test("ordinary answer tags and orphan signatures never manufacture thinking output", async (t) => {
  const literal = "<thinking>This is a quoted tag, not native reasoning.</thinking>";
  const p = await reasoningProvider(t, [new Response(Buffer.concat([
    reasoningEvent({ signature: "orphan" }), answer(literal),
  ]))]);
  const stream = p.stream(turnContext, { reasoning: "high" });
  const result = await stream.result();
  assert.equal(result.type, "done");
  assert.deepEqual(result.message.content, [{ type: "text", text: literal }]);
  assert.deepEqual(lifecycle(stream.events), [
    "start", ["text_start", 0], ["text_delta", 0, literal], ["text_end", 0, literal], "done",
  ]);
});

test("offline API-key snapshots retain image capability and bind the key and region", async (t) => {
  const key = { kind: "api-key", provider: "api-key", access_token: "ksk_fixture-key", region: "eu-central-1" };
  const f = await fixture(t, key);
  noNetwork(t);
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", f.file);
  setEnv(t, "KIRO_API_KEY", undefined);
  for (const changed of [{ ...key, region: "us-east-1" }, { ...key, access_token: "ksk_other-key" }])
    await assert.rejects(readKiroModelCatalog(f.file, { auth: changed }), /different managed account/);
  const rows = [
    { ...models[0], supportedInputTypes: ["TEXT", "IMAGE"] },
    { ...models[1], supportedInputTypes: ["TEXT"] },
  ];
  await writeFile(f.file, JSON.stringify({ ...f.snapshot, models: rows }));
  const h = registrationHost();
  await kiroExtension(h.pi);
  assert.deepEqual(h.providers[0].config.models.map((model) => model.input), [["text", "image"], ["text"]]);
});

test("Kiro HTTP 429 overflow reaches OMP as an overflow error without rate-limit replay cues", async (t) => {
  const p = await reasoningProvider(t, [new Response("Input is too long.", {
    status: 429, headers: { "retry-after": "30" },
  })]);
  const result = await p.stream(turnContext).result();
  assert.equal(result.type, "error");
  assert.equal(result.error.stopReason, "error");
  assert.equal(result.error.errorStatus, undefined);
  assert.match(result.error.errorMessage, /prompt is too long/i);
  assert.doesNotMatch(result.error.errorMessage, /429|retry-after/i);
  assert.equal(p.requests.length, 1);
});

test("a terminal metered disconnect does not hand OMP a replayable network error", async (t) => {
  const body = Buffer.concat([
    frame("meteringEvent", { usage: 0.5, unit: "credits" }),
    answer("unfinished").subarray(0, 20),
  ]);
  const p = await reasoningProvider(t, [new Response(body)]);
  const result = await p.stream(turnContext).result();
  assert.equal(result.type, "error");
  assert.equal(result.error.stopReason, "error");
  assert.equal(result.error.errorStatus, undefined);
  assert.equal(result.error.errorMessage, "Kiro did not finish the billed response. It was not replayed.");
  assert.deepEqual(result.error.usage.credits, { cost: 0.5 });
  assert.equal(p.requests.length, 1);
});

test("a disabled default account does not load its old snapshot or hide commands", async (t) => {
  const f = await fixture(t, { ...auth, disabled: "invalid_grant" });
  noNetwork(t);
  setEnv(t, "OMP_KIRO_TRANSPORT", "http");
  setEnv(t, "OMP_KIRO_AUTH_FILE", f.authFile);
  setEnv(t, "OMP_KIRO_MODEL_CATALOG_FILE", f.file);
  setEnv(t, "KIRO_API_KEY", undefined);
  const h = profileCommandHost();
  await kiroExtension(h.pi);
  assert.ok(!h.providers[0].config.models);
  await h.commands.get("kiro-status").handler("", h.ctx);
  assert.match(h.messages[0].content, /signed in; sign in again/);
  const result = await h.providers[0].config.streamSimple(cachedModel, turnContext).result();
  assert.equal(result.type, "error");
  assert.match(result.error.errorMessage, /sign in again/);
});
