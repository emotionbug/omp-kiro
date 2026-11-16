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


function textResponse() {
  const headers = Buffer.concat([
    [":message-type", "event"], [":event-type", "assistantResponseEvent"],
  ].map(([name, value]) => {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(Buffer.byteLength(value));
    return Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7]), size, Buffer.from(value)]);
  }));
  const payload = Buffer.from(JSON.stringify({ content: "Kiro answer" }));
  const bytes = Buffer.alloc(16 + headers.length + payload.length);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.writeUInt32BE(headers.length, 4);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
  headers.copy(bytes, 12);
  payload.copy(bytes, 12 + headers.length);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
  return new Response(bytes);
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
