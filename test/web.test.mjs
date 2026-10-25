import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createKiroSearchTool, createKiroWebClient, KiroWebError, registerKiroWebSearch } from "../server/web.mjs";

const auth = { access_token: "private-access", profile_arn: "arn:aws:codewhisperer:us-east-1:123:profile/private" };
const fast = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };
const sources = { results: [{ title: "Documentation", url: "https://kiro.dev/docs/", snippet: "Public search excerpt", maxVerbatimWordLimit: 30, publicDomain: false }] };
function response(init, data = sources) {
  return Response.json({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } });
}

test("Kiro search retries a temporary rejection with one RPC identity and preserves citation limits", async () => {
  const requests = [];
  const client = createKiroWebClient({
    authProvider: async () => auth,
    retry: fast,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return requests.length === 1 ? new Response(null, { status: 503 }) : response(init);
    },
  });
  assert.deepEqual(await client.search("Kiro documentation"), sources);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.equal(requests[1].url, "https://runtime.us-east-1.kiro.dev/mcp");
  assert.equal(requests[1].init.headers.authorization, "Bearer private-access");
  assert.equal(requests[1].init.headers["x-amzn-kiro-profile-arn"], auth.profile_arn);
  const body = JSON.parse(requests[1].init.body);
  assert.equal(body.method, "tools/call");
  assert.deepEqual(body.params, { name: "web_search", arguments: { query: "Kiro documentation" } });
  assert.equal(body.profileArn, undefined, "profile is a header, not a JSON body field");
});

test("search does not leak rejection bodies or bypass account policy with another provider", async () => {
  let calls = 0;
  const client = createKiroWebClient({
    authProvider: async () => auth, retry: fast,
    fetchImpl: async () => { calls++; return new Response(auth.access_token + auth.profile_arn, { status: 403 }); },
  });
  await assert.rejects(client.search("public query"), (error) => {
    assert.equal(error.status, 403);
    assert.ok(!error.message.includes(auth.access_token));
    assert.ok(!error.message.includes(auth.profile_arn));
    return error instanceof KiroWebError;
  });
  assert.equal(calls, 1);
});

test("search rejects mismatched RPC identities and malformed source lists without a retry", async () => {
  for (const value of [
    { jsonrpc: "2.0", id: "different", result: { content: [] } },
    { error: { code: -32000, message: auth.access_token } },
    { result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: "file:///private" }] }) }] } },
  ]) {
    let calls = 0;
    const client = createKiroWebClient({
      authProvider: async () => auth, retry: fast,
      fetchImpl: async (_url, init) => { calls++; return Response.json({ id: JSON.parse(init.body).id, ...value }); },
    });
    await assert.rejects(client.search("public query"), KiroWebError);
    assert.equal(calls, 1);
  }
});

test("query validation happens before authentication and counts Unicode code points", async () => {
  let authCalls = 0, fetchCalls = 0;
  const client = createKiroWebClient({
    authProvider: async () => { authCalls++; return auth; },
    fetchImpl: async (_url, init) => { fetchCalls++; return response(init, { results: [] }); },
  });
  for (const query of ["", "  ", "x".repeat(201), "😀".repeat(201)])
    await assert.rejects(client.search(query), (error) => error.code === "INVALID_QUERY");
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(await client.search("😀".repeat(200)), { results: [] });
  assert.equal(fetchCalls, 1);
});

test("search cancellation interrupts a pending request without another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createKiroWebClient({
    authProvider: async () => auth, retry: fast,
    fetchImpl: async () => { calls++; controller.abort(new Error("cancelled by caller")); return new Promise(() => {}); },
  });
  await assert.rejects(client.search("public query", { signal: controller.signal }), /cancelled by caller/);
  assert.equal(calls, 1);
});

test("web response bound cancels the stream rather than publishing truncated search results", async () => {
  let cancelled = false;
  const client = createKiroWebClient({
    authProvider: async () => auth, retry: fast,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    })),
  });
  await assert.rejects(client.search("public query"), /1 MiB/);
  assert.equal(cancelled, true);
});

test("search sends HTTP only to the regional Kiro MCP endpoint, never to source URLs", async () => {
  const data = { results: [
    { url: "https://external.example/article", snippet: "A returned citation" },
    { url: "http://another.example/page", maxVerbatimWordLimit: 12 },
  ] };
  for (const region of ["us-east-1", "eu-central-1"]) {
    const urls = [];
    const client = createKiroWebClient({
      authProvider: async () => ({ ...auth, profile_arn: `arn:aws:codewhisperer:${region}:123:profile/private` }),
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        assert.equal(init.redirect, "error", "Kiro cannot redirect the client to an external website");
        return response(init, data);
      },
    });
    assert.deepEqual(await client.search("public query"), data);
    assert.deepEqual(urls, [`https://runtime.${region}.kiro.dev/mcp`]);
  }
  let calls = 0;
  const unsupported = createKiroWebClient({
    authProvider: async () => ({ ...auth, profile_arn: "arn:aws:codewhisperer:ap-southeast-1:123:profile/private" }),
    fetchImpl: async () => { calls++; throw new Error("must not connect"); },
  });
  await assert.rejects(unsupported.search("public query"), KiroWebError);
  assert.equal(calls, 0);
});

test("search never retries TLS failures, authentication rejection, or RPC policy errors", async () => {
  for (const failure of [
    () => { throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("certificate trust"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
    }); },
    () => new Response(null, { status: 401 }),
    (_url, init) => Response.json({
      jsonrpc: "2.0", id: JSON.parse(init.body).id,
      error: { code: -32000, message: "Organization policy" },
    }),
  ]) {
    let calls = 0;
    const client = createKiroWebClient({
      authProvider: async () => auth, retry: fast,
      fetchImpl: async (...args) => { calls++; return failure(...args); },
    });
    await assert.rejects(client.search("public query"), KiroWebError);
    assert.equal(calls, 1);
  }
});

test("native search is read-only and retains structured source metadata", async () => {
  const tool = createKiroSearchTool({
    authProvider: async () => auth,
    fetchImpl: async (_url, init) => Response.json({
      jsonrpc: "2.0", id: JSON.parse(init.body).id,
      result: { structuredContent: sources },
    }),
  });
  assert.equal(tool.readOnly, true);
  assert.equal(tool.validate({ query: "public query" }), true);
  for (const args of [{ query: " " }, { query: "x".repeat(201) }, { query: "ok", url: "https://external.example" }])
    assert.equal(tool.validate(args), false);
  const result = await tool.execute({ query: "public query" });
  assert.deepEqual(JSON.parse(result.text), sources);
});

test("OMP web_search registers one essential read tool with a strict query schema and host result shape", async () => {
  const tools = [];
  registerKiroWebSearch({ zod: z, registerTool: (tool) => tools.push(tool) }, {
    authProvider: async () => auth,
    fetchImpl: async (_url, init) => response(init),
  });
  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.equal(tool.name, "web_search");
  assert.equal(tool.approval, "read");
  assert.equal(tool.loadMode, "essential");
  assert.deepEqual(tool.parameters.parse({ query: "😀".repeat(200) }), { query: "😀".repeat(200) });
  for (const args of [{ query: " " }, { query: "😀".repeat(201) }, { query: ["query"] }, { query: "ok", limit: 10 }])
    assert.equal(tool.parameters.safeParse(args).success, false);
  assert.deepEqual(await tool.execute("search-id", { query: "public query" }), {
    content: [{ type: "text", text: JSON.stringify(sources) }],
    details: { provider: "kiro" },
  });
});

test("malformed MCP content is a response error, not an unclassified transport exception", async () => {
  for (const content of [{ text: "not an MCP content array" }, [null], [{ type: "text", text: "not JSON" }]]) {
    const client = createKiroWebClient({
      authProvider: async () => auth,
      fetchImpl: async (_url, init) => Response.json({
        jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { content },
      }),
    });
    await assert.rejects(client.search("public query"), (error) =>
      error instanceof KiroWebError && error.code === "INVALID_RESPONSE");
  }
});
