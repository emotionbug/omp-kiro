import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { buildHttpRequest, createHttpTransport, discoverHttpModels } from "../server/http.mjs";
import { crc32, decodeEventStream } from "../server/eventstream.mjs";

const auth = {
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
};
const context = {
  systemPrompt: "System instructions",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
};
const effortSchema = {
  type: "object",
  properties: { output_config: { properties: { effort: { enum: ["low", "high", "none"], default: "high" } } } },
};

function frame(event, data, kind = "event") {
  const header = (name, value) => {
    const n = Buffer.from(name);
    const v = Buffer.from(value);
    const result = Buffer.alloc(n.length + v.length + 4);
    result[0] = n.length;
    n.copy(result, 1);
    result[n.length + 1] = 7;
    result.writeUInt16BE(v.length, n.length + 2);
    v.copy(result, n.length + 4);
    return result;
  };
  const headers = Buffer.concat([
    header(":message-type", kind),
    header(kind === "exception" ? ":exception-type" : ":event-type", event),
  ]);
  const payload = Buffer.from(JSON.stringify(data));
  const output = Buffer.alloc(16 + headers.length + payload.length);
  output.writeUInt32BE(output.length, 0);
  output.writeUInt32BE(headers.length, 4);
  output.writeUInt32BE(crc32(output.subarray(0, 8)), 8);
  headers.copy(output, 12);
  payload.copy(output, 12 + headers.length);
  output.writeUInt32BE(crc32(output.subarray(0, -4)), output.length - 4);
  return output;
}

function response(frames, chunkSize = 13) {
  const bytes = Buffer.concat(frames);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize)
          controller.enqueue(bytes.subarray(i, i + chunkSize));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/vnd.amazon.eventstream" } },
  );
}

function transport(fetchImpl) {
  return createHttpTransport({ fetchImpl, authProvider: async () => auth });
}

test("native request preserves system, assistant tool uses and real parallel tool results", () => {
  const body = buildHttpRequest({
    model: "claude-sonnet-4.5",
    cwd: "/work",
    sessionId: "9ab9c10d-fd8d-4d76-b537-7cc0b6b9c5a0",
    context: {
      ...context,
      messages: [
        { role: "user", content: "Read both" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Reading" },
            { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
            { type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
          ],
        },
        { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "actual a" }] },
        { role: "toolResult", toolCallId: "b", isError: true, content: "actual error" },
      ],
    },
  });
  assert.equal(Object.hasOwn(body, "systemPrompt"), false);
  assert.ok(body.conversationState.history[0].userInputMessage.content.includes(context.systemPrompt));
  assert.equal(body.conversationState.conversationId, "9ab9c10d-fd8d-4d76-b537-7cc0b6b9c5a0");
  assert.ok(body.conversationState.history[0].userInputMessage.content.endsWith("Read both"));
  assert.equal(body.conversationState.history[1].assistantResponseMessage.toolUses.length, 2);
  const current = body.conversationState.currentMessage.userInputMessage;
  assert.deepEqual(current.userInputMessageContext.toolResults, [
    { toolUseId: "a", content: [{ text: "actual a" }], status: "success" },
    { toolUseId: "b", content: [{ text: "actual error" }], status: "error" },
  ]);
  assert.deepEqual(
    current.userInputMessageContext.tools[0].toolSpecification.inputSchema.json,
    context.tools[0].parameters,
  );
  assert.equal(current.userInputMessageContext.additionalContext[0].innerContext, "/work");
});

test("system prompt arrays precede user input without changing host history", () => {
  const input = {
    model: "model",
    context: { ...context, systemPrompt: ["First instruction", "Second instruction"] },
  };
  const original = structuredClone(input);
  const body = buildHttpRequest(input);
  assert.equal(Object.hasOwn(body, "systemPrompt"), false);
  assert.deepEqual(body.conversationState.history, [], "no fabricated acknowledgement");
  const content = body.conversationState.currentMessage.userInputMessage.content;
  assert.ok(content.indexOf("First instruction") >= 0);
  assert.ok(content.indexOf("First instruction") < content.indexOf("Second instruction"));
  assert.ok(content.indexOf("Second instruction") < content.indexOf("Hello"));
  assert.deepEqual(input, original);
});

test("developer instructions retain labels and order across a native tool handoff", () => {
  const input = {
    model: "model",
    sessionId: "subagent-worker-name",
    context: {
      ...context,
      messages: [
        { role: "developer", content: "Use relative paths." },
        { role: "user", content: "Read a" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "a", name: "read", arguments: { path: "a" } }],
        },
        { role: "developer", content: [{ type: "text", text: "Do not repeat the read." }] },
        { role: "toolResult", toolCallId: "a", content: "actual a" },
      ],
    },
  };
  const body = buildHttpRequest(input);
  assert.equal(Object.hasOwn(body, "systemPrompt"), false);
  const first = body.conversationState.history[0].userInputMessage.content;
  const current = body.conversationState.currentMessage.userInputMessage.content;
  assert.ok(first.indexOf(context.systemPrompt) >= 0);
  assert.ok(first.indexOf(context.systemPrompt) < first.indexOf("Use relative paths."));
  assert.ok(first.indexOf("Use relative paths.") < first.indexOf("Read a"));
  assert.ok(!first.includes("Do not repeat the read."));
  assert.ok(current.includes("Do not repeat the read."));
  assert.equal(body.conversationState.history.length, 2);
  assert.equal(
    body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0]
      .toolUseId,
    "a",
  );
  assert.match(
    body.conversationState.conversationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    buildHttpRequest(input).conversationState.conversationId,
    body.conversationState.conversationId,
  );
  assert.notEqual(
    buildHttpRequest({ ...input, sessionId: "different-worker" }).conversationState.conversationId,
    body.conversationState.conversationId,
  );
});

test("developer instructions cannot manufacture a turn after an assistant response", () => {
  assert.throws(() => buildHttpRequest({
    model: "model",
    context: {
      messages: [
        { role: "user", content: "Original request" },
        { role: "assistant", content: "Completed response" },
        { role: "developer", content: "A later instruction" },
      ],
    },
  }), /must end with a user message or actual tool results/);
});

test("effort changes only native additional request fields, not instructions or history", () => {
  const input = { model: "model", context, sessionId: "effort-session", modelRequestFieldsSchema: effortSchema };
  const original = structuredClone(input);
  const defaults = buildHttpRequest(input);
  assert.equal(Object.hasOwn(defaults, "additionalModelRequestFields"), false);
  const positive = buildHttpRequest({ ...input, reasoning: "high" });
  assert.deepEqual(positive, {
    ...defaults, additionalModelRequestFields: { output_config: { effort: "high" } },
  });
  assert.deepEqual(buildHttpRequest({ ...input, reasoning: "high", forceReasoningOff: true }), {
    ...defaults, additionalModelRequestFields: { output_config: { effort: "none" } },
  });
  assert.deepEqual(input, original);
});

test("unsupported effort and native off fail before auth or generation", async () => {
  let calls = 0;
  const run = createHttpTransport({
    authProvider: async () => { calls++; return auth; },
    fetchImpl: async () => { calls++; throw new Error("must not send"); },
  });
  for (const options of [
    { reasoning: "minimal", modelRequestFieldsSchema: effortSchema },
    { reasoning: "high" },
    { disableReasoning: true, modelRequestFieldsSchema: {
      properties: { reasoning: { properties: { effort: { enum: ["high"] } } } },
    } },
  ]) await assert.rejects(run({ model: "model", context, ...options }), RangeError);
  await assert.rejects(run({ model: "model", context, modelRequestFieldsSchema: [] }), TypeError);
  assert.equal(calls, 0);
});

test("framed text and interleaved tool fragments assemble native calls and reported usage", async () => {
  const text = [];
  const run = transport(async (url, request) => {
    assert.equal(url, "https://runtime.us-east-1.kiro.dev/");
    assert.equal(request.headers.authorization, "Bearer fixture-access");
    assert.equal(request.redirect, "error");
    assert.equal(
      request.headers["x-amz-target"],
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    );
    assert.equal(JSON.parse(request.body).profileArn, auth.profile_arn);
    assert.equal(request.headers["x-amzn-kiro-profile-arn"], auth.profile_arn);
    assert.equal(
      JSON.parse(request.body).conversationState.currentMessage.userInputMessage.origin,
      "KIRO_CLI",
    );
    return response(
      [
        frame("assistantResponseEvent", { content: "한글 🙂" }),
        frame("toolUseEvent", { toolUseId: "a", name: "read", input: '{"path":' }),
        frame("toolUseEvent", { toolUseId: "b", name: "read", input: '{"path":"b"}', stop: true }),
        frame("toolUseEvent", { toolUseId: "a", input: '"a"}', stop: true }),
        frame("metadataEvent", {
          tokenUsage: {
            uncachedInputTokens: 10,
            outputTokens: 3,
            cacheReadInputTokens: 4,
            cacheWriteInputTokens: 5,
            totalTokens: 22,
          },
        }),
      ],
      1,
    );
  });
  const result = await run({
    model: "claude-sonnet-4.5",
    context,
    onText: (value) => text.push(value),
  });
  assert.deepEqual(text, ["한글 🙂"]);
  assert.deepEqual(result.toolCalls, [
    { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
    { type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
  ]);
  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.usage, {
    input: 10,
    output: 3,
    cacheRead: 4,
    cacheWrite: 5,
    totalTokens: 22,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("missing usage remains absent and reported length termination is preserved", async () => {
  const run = transport(async () =>
    response([frame("assistantResponseEvent", { content: "partial", stopReason: "max_tokens" })]),
  );
  const result = await run({ model: "model", context });
  assert.equal(result.usage, undefined);
  assert.equal(result.stopReason, "length");
});

test("HTTP and framed quota errors propagate without retries or secret leakage", async () => {
  let count = 0;
  const run = transport(async () => {
    count++;
    return Response.json(
      {
        __type: "ServiceQuotaExceededException",
        message: `Monthly quota exhausted ${auth.access_token}`,
      },
      { status: 402 },
    );
  });
  await assert.rejects(
    run({ model: "model", context }),
    (error) =>
      error.status === 402 &&
      /Monthly quota/.test(error.message) &&
      !error.message.includes(auth.access_token),
  );
  assert.equal(count, 1);
  const streamed = transport(async () =>
    response([frame("ServiceQuotaExceededException", { message: "Quota exhausted" }, "exception")]),
  );
  await assert.rejects(streamed({ model: "model", context }), /Quota exhausted/);
});

test("corrupt and truncated frames fail instead of accepting partial output", async () => {
  const valid = frame("assistantResponseEvent", { content: "text" });
  const corrupt = Buffer.from(valid);
  corrupt[corrupt.length - 5] ^= 1;
  await assert.rejects(
    transport(async () => response([corrupt]))({ model: "model", context }),
    /checksum/,
  );
  await assert.rejects(
    transport(async () => response([valid.subarray(0, -1)]))({ model: "model", context }),
    /Truncated/,
  );
  const oversized = Buffer.from(valid);
  oversized.writeUInt32BE(20 * 1024 * 1024, 0);
  await assert.rejects(
    transport(async () => response([oversized]))({ model: "model", context }),
    /frame length/,
  );
});

test("incomplete, invalid, or unknown tool calls are rejected", async () => {
  for (const [data, pattern] of [
    [{ toolUseId: "a", name: "read", input: "{}" }, /incomplete/],
    [{ toolUseId: "a", name: "read", input: "{", stop: true }, /invalid JSON/],
    [{ toolUseId: "a", name: "read", input: "[]", stop: true }, /JSON object/],
    [{ toolUseId: "a", name: "unknown", input: "{}", stop: true }, /not supplied/],
  ]) {
    await assert.rejects(
      transport(async () => response([frame("toolUseEvent", data)]))({ model: "model", context }),
      pattern,
    );
  }
});

test("abort cancels a stalled response reader promptly", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const iterator = decodeEventStream(body, controller.signal);
  const pending = iterator.next();
  controller.abort(new Error("cancelled by user"));
  await assert.rejects(pending, /cancelled by user/);
  assert.equal(cancelled, true);
});

test("pre-abort and unsupported regions never send authenticated requests", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const run = transport(async () => {
    called = true;
    throw new Error("must not fetch");
  });
  await assert.rejects(run({ model: "model", context, signal: controller.signal }), {
    name: "AbortError",
  });
  const unsupported = createHttpTransport({
    authProvider: async () => ({
      ...auth,
      profile_arn: "arn:aws:codewhisperer:evil.example:1:profile/x",
    }),
    fetchImpl: async () => {
      called = true;
    },
  });
  await assert.rejects(unsupported({ model: "model", context }), /profile region/);
  assert.equal(called, false);
});

test("image input and assistant-final transcripts fail explicitly", () => {
  assert.throws(
    () =>
      buildHttpRequest({
        model: "model",
        context: { messages: [{ role: "user", content: [{ type: "image", data: "image" }] }] },
      }),
    /cannot forward image/,
  );
  assert.throws(
    () =>
      buildHttpRequest({
        model: "model",
        context: { messages: [{ role: "assistant", content: "done" }] },
      }),
    /must end/,
  );
});

test("catalog uses direct metadata, preserves reported limits and follows pagination", async () => {
  let calls = 0;
  const models = await discoverHttpModels({
    authProvider: async () => auth,
    fetchImpl: async (url, request) => {
      assert.equal(url.origin, "https://management.us-east-1.kiro.dev");
      assert.equal(url.searchParams.get("origin"), "KIRO_CLI");
      assert.equal(
        request.headers["x-amz-target"],
        "KiroControlPlaneBearerService.ListAvailableModels",
      );
      if (calls++ === 0)
        return Response.json({
          models: [{
            modelId: "one", modelName: "One", tokenLimits: { maxInputTokens: 200000 },
            additionalModelRequestFieldsSchema: effortSchema,
          }],
          nextToken: "next",
        });
      assert.equal(url.searchParams.get("nextToken"), "next");
      return Response.json({
        models: [{
          modelId: "two", modelName: "Two", tokenLimits: { maxOutputTokens: 8000 },
          additionalModelRequestFieldsSchema: null,
        }],
      });
    },
  });
  assert.deepEqual(models, [
    { id: "one", name: "One", contextWindow: 200000, additionalModelRequestFieldsSchema: effortSchema },
    { id: "two", name: "Two", maxTokens: 8000 },
  ]);
});

test("discovery rejects malformed effort metadata rather than dropping it", async () => {
  for (const schema of [[], "{}", 1, { properties: { reasoning: { properties: { effort: { enum: "high" } } } } }]) {
    await assert.rejects(discoverHttpModels({
      authProvider: async () => auth,
      fetchImpl: async () => Response.json({
        models: [{ modelId: "model", additionalModelRequestFieldsSchema: schema }],
      }),
    }), TypeError);
  }
});

const fastRetry = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1000 };
const disconnected = () => Object.assign(new TypeError("terminated"), {
  cause: Object.assign(new Error("socket disconnected"), { code: "UND_ERR_SOCKET" }),
});

function interruptedResponse(frames = []) {
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (!sent && frames.length) {
        sent = true;
        controller.enqueue(Buffer.concat(frames));
      } else controller.error(disconnected());
    },
  }));
}

test("a real transient socket drop recovers the identical model, body and session", async (t) => {
  const requests = [];
  const server = createServer(async (request, reply) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(Buffer.concat(chunks).toString());
    reply.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    if (requests.length === 1) {
      reply.write(frame("metadataEvent", {}));
      setTimeout(() => reply.destroy(), 10);
    } else reply.end(frame("assistantResponseEvent", { content: "Recovered" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const text = [];
  const run = createHttpTransport({
    authProvider: async () => auth,
    retry: fastRetry,
    fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}/`, init),
  });
  await run({
    model: "selected-only", sessionId: "stable-session", context, onText: (s) => text.push(s),
    modelRequestFieldsSchema: effortSchema, reasoning: "low",
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.deepEqual(JSON.parse(requests[1]).additionalModelRequestFields, { output_config: { effort: "low" } });
  assert.equal(
    JSON.parse(requests[1]).conversationState.currentMessage.userInputMessage.modelId,
    "selected-only",
  );
  assert.deepEqual(text, ["Recovered"]);
});

test("buffered tools from a failed attempt are never executed or duplicated", async () => {
  let attempts = 0;
  const run = createHttpTransport({
    authProvider: async () => auth,
    retry: fastRetry,
    fetchImpl: async () => {
      attempts++;
      const tool = frame("toolUseEvent", {
        toolUseId: "call", name: "read", input: '{"path":"a"}', stop: true,
      });
      return attempts === 1 ? interruptedResponse([tool]) : response([tool]);
    },
  });
  let executed = 0;
  const outcome = await run({ model: "selected-only", context });
  for (const call of outcome.toolCalls) {
    assert.equal(call.id, "call");
    executed++;
  }
  assert.equal(attempts, 2);
  assert.equal(executed, 1);
});

test("partial text remains terminal unless the caller explicitly chooses continuation or restart", async () => {
  let attempts = 0;
  const text = [];
  const run = createHttpTransport({
    authProvider: async () => auth,
    retry: fastRetry,
    fetchImpl: async () => {
      attempts++;
      return interruptedResponse([
        frame("assistantResponseEvent", { content: "Committed" }),
        frame("toolUseEvent", { toolUseId: "call", name: "read", input: '{"path":' }),
      ]);
    },
  });
  await assert.rejects(
    run({ model: "selected-only", context, onText: (s) => text.push(s) }),
    (error) => error.cause?.code === "UND_ERR_SOCKET",
  );
  assert.deepEqual(text, ["Committed"]);
  assert.equal(attempts, 1);
});

test("cancellation during Retry-After backoff sends no further generation request", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during backoff");
  let attempts = 0;
  const run = createHttpTransport({
    authProvider: async () => auth,
    retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 2000 },
    fetchImpl: async () => {
      attempts++;
      setTimeout(() => controller.abort(reason), 0);
      return Response.json({ message: "Try later" }, { status: 503, headers: { "retry-after": "1" } });
    },
  });
  await assert.rejects(
    run({ model: "selected-only", context, signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(attempts, 1);
});

test("nonretryable HTTP, model, TLS, CRC and incomplete tool failures do not loop", async () => {
  const corrupt = frame("assistantResponseEvent", { content: "bad" });
  corrupt[corrupt.length - 5] ^= 1;
  const tls = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("trust failed"), { code: "CERT_HAS_EXPIRED" }),
  });
  for (const fixture of [
    () => Response.json({ message: "Unauthorized" }, { status: 401 }),
    () => Response.json({ message: "Forbidden" }, { status: 403 }),
    () => Response.json({ __type: "InvalidModelException" }, { status: 503 }),
    () => Response.json({ __type: "ThrottlingException", message: "Monthly quota exhausted" }, { status: 429 }),
    () => Response.json({ __type: "ServiceQuotaExceededException" }, { status: 503 }),
    () => { throw tls; },
    () => response([corrupt]),
    () => response([frame("toolUseEvent", { toolUseId: "call", name: "read", input: '{"path":' })]),
  ]) {
    let attempts = 0;
    const run = createHttpTransport({
      authProvider: async () => auth,
      retry: fastRetry,
      fetchImpl: async () => { attempts++; return fixture(); },
    });
    await assert.rejects(run({ model: "selected-only", context }));
    assert.equal(attempts, 1);
  }
});

test("explicit finite generation policy can disable retries independently of catalog recovery", async () => {
  let generationAttempts = 0;
  const run = createHttpTransport({
    authProvider: async () => auth,
    retry: fastRetry,
    fetchImpl: async () => { generationAttempts++; throw disconnected(); },
  });
  await assert.rejects(run({ model: "selected-only", context, retry: { maxAttempts: 1 } }));
  assert.equal(generationAttempts, 1);
  const bodies = [];
  const models = await discoverHttpModels({
    authProvider: async () => auth,
    retry: fastRetry,
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      if (bodies.length === 1) return Response.json({ models: [{ modelId: "one" }], nextToken: "page2" });
      if (bodies.length === 2) return interruptedResponse();
      return Response.json({ models: [{ modelId: "two" }] });
    },
  });
  assert.deepEqual(models.map((model) => model.id), ["one", "two"]);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[1], bodies[2]);
});

test("temporary HTTP and framed service rejections recover within one finite attempt budget", async () => {
  const bodies = [];
  const run = createHttpTransport({
    authProvider: async () => auth,
    retry: fastRetry,
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      if (bodies.length === 1)
        return Response.json({ __type: "ServiceUnavailableException" }, {
          status: 503, headers: { "retry-after": "0" },
        });
      if (bodies.length === 2)
        return response([frame("InternalServerException", { message: "Temporary service failure" }, "exception")]);
      return response([frame("assistantResponseEvent", { content: "Recovered" })]);
    },
  });
  const text = [];
  await run({ model: "selected-only", context, onText: (s) => text.push(s) });
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(text, ["Recovered"]);
});

test("native provisional text can explicitly reset before same-request recovery", async () => {
  const bodies = [];
  const restarts = [];
  let displayed = "";
  const run = createHttpTransport({
    authProvider: async () => auth,
    retry: fastRetry,
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      return bodies.length === 1
        ? interruptedResponse([
          frame("assistantResponseEvent", { content: "discard me" }),
          frame("toolUseEvent", { toolUseId: "discarded", name: "read", input: "{}" }),
        ])
        : response([
          frame("assistantResponseEvent", { content: "Recovered" }),
          frame("toolUseEvent", { toolUseId: "final", name: "read", input: "{}", stop: true }),
        ]);
    },
  });
  const outcome = await run({
    model: "selected-only",
    context,
    onText: (text) => { displayed += text; },
    onRestart(info) { restarts.push(info); displayed = ""; },
  });
  assert.equal(displayed, "Recovered");
  assert.deepEqual(restarts, [{ attempt: 2, maxAttempts: 3, delayMs: 0 }]);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(outcome.toolCalls.map((call) => call.id), ["final"]);
});

test("restart callback failure or cancellation prevents any replay", async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const reason = new Error("restart stopped");
    let calls = 0;
    const run = createHttpTransport({
      authProvider: async () => auth,
      retry: fastRetry,
      fetchImpl: async () => {
        calls++;
        return interruptedResponse([frame("assistantResponseEvent", { content: "provisional" })]);
      },
    });
    await assert.rejects(run({
      model: "selected-only", context, signal: controller.signal,
      onRestart() {
        if (abort) controller.abort(reason);
        else throw reason;
      },
    }), (error) => error === reason);
    assert.equal(calls, 1);
  }
});

test("OMP continuation survives repeated partial failures and preserves completed tools exactly once", async () => {
  const completed = {
    ...context,
    messages: [
      ...context.messages,
      { role: "assistant", content: [{ type: "toolCall", id: "completed", name: "read", arguments: { path: "a" } }] },
      { role: "toolResult", toolCallId: "completed", content: "already executed" },
    ],
  };
  const bodies = [];
  const text = [];
  const run = createHttpTransport({
    authProvider: async () => auth,
    retry: { maxAttempts: null, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length <= 5) {
        return interruptedResponse([
          frame("assistantResponseEvent", { content: `part${bodies.length} ` }),
          frame("toolUseEvent", { toolUseId: "discard", name: "read", input: '{"path":' }),
        ]);
      }
      if (bodies.length === 6) throw disconnected();
      return response([
        frame("assistantResponseEvent", { content: "done" }),
        frame("toolUseEvent", { toolUseId: "new-tool", name: "read", input: '{"path":"b"}', stop: true }),
      ]);
    },
  });
  const outcome = await run({
    model: "unchanged-model", sessionId: "unchanged-session", cwd: "/workspace",
    context: completed, continuePartial: true, onText: (fragment) => text.push(fragment),
    modelRequestFieldsSchema: effortSchema, reasoning: "high",
  });
  assert.equal(text.join(""), "part1 part2 part3 part4 part5 done");
  assert.equal(bodies.length, 7, "transport recovery is not limited by the host's three retries");
  assert.deepEqual(bodies[5], bodies[6], "no-output outage retries the identical continuation body");
  for (const [index, body] of bodies.entries()) {
    assert.equal(body.profileArn, auth.profile_arn);
    assert.deepEqual(body.additionalModelRequestFields, { output_config: { effort: "high" } });
    const state = body.conversationState;
    assert.equal(state.conversationId, bodies[0].conversationState.conversationId);
    const current = state.currentMessage.userInputMessage;
    assert.equal(current.modelId, "unchanged-model");
    assert.equal(current.origin, "KIRO_CLI");
    assert.deepEqual(current.userInputMessageContext.tools,
      bodies[0].conversationState.currentMessage.userInputMessage.userInputMessageContext.tools);
    const userInputs = [...state.history, state.currentMessage]
      .flatMap((message) => message.userInputMessage ? [message.userInputMessage] : []);
    assert.equal(userInputs.filter((message) => message.content.endsWith("Hello")).length, 1);
    assert.equal(userInputs.filter((message) => message.content.includes(context.systemPrompt)).length, 1);
    assert.equal(userInputs.flatMap((message) => message.userInputMessageContext?.toolResults ?? []).length, 1);
    assert.equal(state.history.flatMap((message) => message.assistantResponseMessage?.toolUses ?? []).length, 1);
    assert.ok(!JSON.stringify(body).includes("discard"), "buffered failed tools never become history");
    if (index > 0) assert.equal(current.userInputMessageContext.toolResults, undefined);
  }
  assert.deepEqual(outcome.toolCalls.map(({ id }) => id), ["new-tool"]);
  assert.deepEqual(completed.messages.at(-1), {
    role: "toolResult", toolCallId: "completed", content: "already executed",
  }, "wire-only continuation does not mutate host history");
});

test("generation waits through an offline outage longer than three default retry periods", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bodies = [];
  const notices = [];
  const run = createHttpTransport({
    authProvider: async () => auth,
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      if (bodies.length <= 4)
        throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("offline"), { code: "ENOTFOUND" }) });
      return response([frame("assistantResponseEvent", { content: "Online" })]);
    },
  });
  const text = [];
  const pending = run({ model: "selected-only", context, onRetry: (info) => notices.push(info),
    onText: (fragment) => text.push(fragment) });
  for (let attempt = 1; attempt <= 4; attempt++) {
    await new Promise(setImmediate);
    assert.equal(bodies.length, attempt);
    t.mock.timers.tick(30_000);
  }
  await pending;
  assert.equal(bodies.length, 5);
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(text, ["Online"], "retry notices never enter model text");
  assert.deepEqual(notices.map(({ delayMs, maxAttempts }) => [delayMs, maxAttempts]),
    Array.from({ length: 4 }, () => [30_000, null]));
  assert.ok(!JSON.stringify(notices).includes(auth.access_token));
});

test("long recovery reloads expired authentication without changing account, region, body or model", async (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  let reads = 0;
  const tokens = [], bodies = [];
  const run = createHttpTransport({
    authProvider: async () => {
      reads++;
      return { ...auth, access_token: reads === 1 ? "old-token" : "refreshed-token",
        expires_at: new Date(start + (reads === 1 ? 120_000 : 3_600_000)).toISOString() };
    },
    fetchImpl: async (_url, init) => {
      tokens.push(init.headers.authorization);
      bodies.push(init.body);
      if (bodies.length <= 4) throw disconnected();
      return response([frame("assistantResponseEvent", { content: "Online" })]);
    },
  });
  const pending = run({ model: "selected-only", context });
  for (let attempt = 1; attempt <= 4; attempt++) {
    await new Promise(setImmediate);
    t.mock.timers.tick(30_000);
  }
  await pending;
  assert.equal(reads, 2);
  assert.deepEqual(tokens, ["Bearer old-token", "Bearer old-token",
    "Bearer refreshed-token", "Bearer refreshed-token", "Bearer refreshed-token"]);
  assert.equal(new Set(bodies).size, 1);
});

test("recovery never silently switches accounts or regions during credential reload", async () => {
  for (const replacement of [
    { ...auth, profile_arn: "arn:aws:codewhisperer:eu-central-1:123:profile/new-account" },
    { ...auth, provider: "github" },
  ]) {
    let reads = 0, calls = 0;
    const original = { ...auth, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    const run = createHttpTransport({
      retry: fastRetry,
      authProvider: async () => ++reads === 1 ? original : replacement,
      fetchImpl: async () => { calls++; throw disconnected(); },
    });
    await assert.rejects(run({ model: "selected-only", context,
      onRetry() { original.expires_at = new Date(0).toISOString(); } }), /login or region changed/);
    assert.equal(calls, 1);
  }
});

test("committed continuation never turns malformed JSON, unknown tools or CRC into a retry", async () => {
  const corrupt = frame("metadataEvent", {});
  corrupt[corrupt.length - 5] ^= 1;
  for (const frames of [
    [frame("toolUseEvent", { toolUseId: "bad-json", name: "read", input: "{bad", stop: true })],
    [frame("toolUseEvent", { toolUseId: "not-supplied", name: "missing", input: "{}", stop: true })],
    [corrupt],
  ]) {
    let calls = 0;
    const text = [];
    const run = createHttpTransport({
      authProvider: async () => auth, retry: fastRetry,
      fetchImpl: async () => {
        calls++;
        return interruptedResponse([frame("assistantResponseEvent", { content: "Committed" }), ...frames]);
      },
    });
    await assert.rejects(run({ model: "selected-only", context, continuePartial: true,
      onText: (fragment) => text.push(fragment) }));
    assert.equal(calls, 1);
    assert.deepEqual(text, ["Committed"]);
  }
});

test("silent connect and response blackholes time out and recover before output", async () => {
  for (const stage of ["connect", "body"]) {
    let calls = 0;
    let cancelled = false;
    const run = createHttpTransport({
      authProvider: async () => auth,
      retry: fastRetry,
      idleTimeoutMs: 20,
      fetchImpl: async () => {
        calls++;
        if (calls > 1) return response([frame("assistantResponseEvent", { content: "Recovered" })]);
        if (stage === "connect") return new Promise(() => {});
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      },
    });
    const text = [];
    await run({ model: "selected-only", context, onText: (s) => text.push(s) });
    assert.equal(calls, 2);
    assert.deepEqual(text, ["Recovered"]);
    if (stage === "body") assert.equal(cancelled, true);
  }
});

test("generation idle timeout resets on bytes rather than imposing a total deadline", async () => {
  let timer;
  const run = createHttpTransport({
    authProvider: async () => auth,
    retry: fastRetry,
    idleTimeoutMs: 60,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        let chunks = 0;
        timer = setInterval(() => {
          controller.enqueue(frame("assistantResponseEvent", { content: "a" }));
          if (++chunks === 6) { clearInterval(timer); controller.close(); }
        }, 20);
      },
      cancel() { clearInterval(timer); },
    })),
  });
  const text = [];
  try {
    await run({ model: "selected-only", context, onText: (s) => text.push(s) });
    assert.equal(text.join(""), "aaaaaa");
  } finally {
    clearInterval(timer);
  }
});

const reasoningModel = "reasoning-model";
const reasoningFrame = (data) => frame("reasoningContentEvent", data);
const toolFrame = (id) => frame("toolUseEvent", { toolUseId: id, name: "read", input: '{"path":"a"}', stop: true });

// Mirrors the OMP provider: blocks enter content in wire order; the transport owns their fields.
function streamRecorder() {
  const events = [];
  const content = [];
  return {
    events,
    content,
    onReasoning(event) {
      if (event.type === "delta") assert.ok(event.block.thinking.endsWith(event.delta), "text is stored before its delta");
      events.push(event);
      if (event.type === "start" || event.type === "redacted") content.push(event.block);
    },
    onText(delta) {
      events.push({ type: "text", delta });
      const last = content.at(-1);
      if (last?.type === "text") last.text += delta;
      else content.push({ type: "text", text: delta });
    },
  };
}

function hostAssistant(content, outcome) {
  return {
    role: "assistant", provider: "kiro-http", api: "kiro-cli-http", model: reasoningModel,
    content: [...content, ...(outcome.toolCalls ?? [])],
    stopReason: outcome.stopReason,
    ...(outcome.upstreamModel ? { upstreamModel: outcome.upstreamModel } : {}),
  };
}

function followUp(assistant) {
  return buildHttpRequest({
    model: reasoningModel,
    context: {
      ...context,
      messages: [...context.messages, assistant, { role: "toolResult", toolCallId: "call", content: "actual a" }],
    },
  }).conversationState.history[1].assistantResponseMessage;
}

test("native reasoning phases stream in wire order without replaying an older signature for an unsigned tail", async () => {
  const stream = streamRecorder();
  const run = transport(async () => response([
    reasoningFrame({ text: "Plan " }),
    reasoningFrame({ text: "first" }),
    reasoningFrame({ signature: "sig-1" }),
    frame("assistantResponseEvent", { content: "Reading" }),
    reasoningFrame({ redactedContent: "b3BhcXVl" }),
    reasoningFrame({ text: "Check", signature: "sig-2-superseded" }),
    reasoningFrame({ signature: "sig-2" }),
    reasoningFrame({ text: "unsigned tail" }),
    toolFrame("call"),
  ], 7));
  const outcome = await run({
    model: reasoningModel, context, onText: stream.onText, onReasoning: stream.onReasoning,
  });
  const blocks = stream.content;
  assert.deepEqual(blocks, [
    { type: "thinking", thinking: "Plan first", thinkingSignature: "sig-1" },
    { type: "text", text: "Reading" },
    { type: "redactedThinking", data: "b3BhcXVl" },
    { type: "thinking", thinking: "Check", thinkingSignature: "sig-2" },
    { type: "thinking", thinking: "unsigned tail" },
  ]);
  assert.deepEqual(stream.events.map(({ type, block, delta }) => [type, blocks.indexOf(block), delta]), [
    ["start", 0, undefined], ["delta", 0, "Plan "], ["delta", 0, "first"], ["end", 0, undefined],
    ["text", -1, "Reading"],
    ["redacted", 2, undefined],
    ["start", 3, undefined], ["delta", 3, "Check"], ["end", 3, undefined],
    ["start", 4, undefined], ["delta", 4, "unsigned tail"], ["end", 4, undefined],
  ]);
  const visible = stream.events.map(({ delta }) => delta ?? "").join("");
  for (const hidden of ["sig-", "b3BhcXVl"]) assert.ok(!visible.includes(hidden));
  assert.equal(outcome.upstreamModel, undefined);
  assert.deepEqual(followUp(hostAssistant(blocks, outcome)), {
    content: "Reading",
    toolUses: [{ toolUseId: "call", name: "read", input: { path: "a" } }],
  });
});

test("reasoning history replays only the producing Kiro HTTP model's complete phases", () => {
  const kiro = (content, extra = {}) => ({
    role: "assistant", provider: "kiro-http", api: "kiro-cli-http", model: reasoningModel,
    stopReason: "stop", content, ...extra,
  });
  const signed = (text, signature) => ({ type: "thinking", thinking: text, thinkingSignature: signature });
  const text = (value) => ({ type: "text", text: value });
  const turns = [
    [kiro([signed("a", "sig-a"), { type: "redactedThinking", data: "b3BhcXVl" }, text("Hel"), text("lo")])],
    [kiro([signed("b", "sig-b"), text("other model")], { model: "other-model" })],
    [kiro([signed("c", "sig-c"), text("rerouted")], { upstreamModel: "other-model" })],
    [kiro([signed("d", "sig-d"), text("foreign")], { provider: "anthropic", api: "anthropic-messages" })],
    [kiro([signed("e", "sig-e"), text("failed")], { stopReason: "error" })],
    [kiro([signed("f", "sig-f"), { type: "redactedThinking", data: "" }, { type: "thinking", thinking: "unsigned" },
      text("invalidated")])],
    [kiro([signed("g", "sig-g"), text("merged")]), kiro([signed("h", "sig-h"), text("cancelled")], { stopReason: "aborted" })],
  ];
  const input = {
    model: reasoningModel,
    sessionId: "replay-session",
    context: {
      ...context,
      messages: [
        ...turns.flatMap((assistants, index) => [{ role: "user", content: `q${index}` }, ...assistants]),
        { role: "user", content: "final" },
      ],
    },
  };
  const original = structuredClone(input);
  const body = buildHttpRequest(input);
  const assistants = body.conversationState.history.flatMap((message) =>
    message.assistantResponseMessage ? [message.assistantResponseMessage] : []);
  assert.deepEqual(assistants.map(({ reasoningContent }) => reasoningContent), [
    { redactedContent: "b3BhcXVl" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined, // The latest phase is unsigned; an older signature is not a substitute.
    undefined, // A later aborted assistant turn cannot inherit the earlier turn's signature.
  ]);
  assert.equal(assistants[0].content, "Hello", "reasoning-split native text is one stream");
  assert.deepEqual(input, original);
  const withoutReasoning = structuredClone(body);
  for (const message of withoutReasoning.conversationState.history)
    delete message.assistantResponseMessage?.reasoningContent;
  assert.deepEqual(withoutReasoning, buildHttpRequest({
    ...input,
    context: {
      ...input.context,
      messages: input.context.messages.map((message) => message.role === "assistant"
        ? { ...message, content: message.content.filter(({ type }) => !["thinking", "redactedThinking"].includes(type)) }
        : message),
    },
  }), "text and tools are unchanged by reasoning replay");
});

test("retries never replay or re-sign reasoning from an abandoned attempt", async () => {
  for (const mode of ["continuePartial", "onRestart"]) {
    const bodies = [];
    const stream = streamRecorder();
    let restarts = 0;
    const run = createHttpTransport({
      authProvider: async () => auth,
      retry: fastRetry,
      fetchImpl: async (_url, init) => {
        bodies.push(init.body);
        return bodies.length === 1
          ? interruptedResponse([
            reasoningFrame({ text: "first" }),
            reasoningFrame({ signature: "sig-abandoned" }),
            reasoningFrame({ redactedContent: "YWJhbmRvbmVk" }),
            frame("assistantResponseEvent", { content: "Committed " }),
            reasoningFrame({ text: "open" }),
          ])
          : response([
            reasoningFrame({ text: "second" }),
            reasoningFrame({ signature: "sig-final" }),
            frame("assistantResponseEvent", { content: "done" }),
            toolFrame("call"),
          ]);
      },
    });
    const outcome = await run({
      model: reasoningModel, context, onText: stream.onText, onReasoning: stream.onReasoning,
      ...(mode === "continuePartial" ? { continuePartial: true } : { onRestart() { restarts++; } }),
    });
    assert.equal(bodies.length, 2);
    for (const hidden of ["sig-abandoned", "YWJhbmRvbmVk", "first"]) assert.ok(!bodies[1].includes(hidden));
    if (mode === "onRestart") {
      assert.equal(restarts, 1);
      assert.equal(bodies[0], bodies[1]);
    }
    const reasoningBlocks = stream.content.filter(({ type }) => type !== "text");
    assert.deepEqual(reasoningBlocks, [
      { type: "thinking", thinking: "first" },
      { type: "redactedThinking", data: "" },
      { type: "thinking", thinking: "open" },
      { type: "thinking", thinking: "second", thinkingSignature: "sig-final" },
    ]);
    for (const block of reasoningBlocks.filter(({ type }) => type === "thinking"))
      assert.equal(stream.events.filter((event) => event.type === "end" && event.block === block).length, 1);
    const replay = followUp(hostAssistant(stream.content, outcome));
    assert.deepEqual(replay.reasoningContent, { reasoningText: { text: "second", signature: "sig-final" } });
    assert.deepEqual(replay.toolUses.map(({ toolUseId }) => toolUseId), ["call"]);
  }
});

test("failed or cancelled reasoning ends once and keeps no replayable metadata", async () => {
  const valid = reasoningFrame({ text: "more" });
  const corrupt = Buffer.from(valid);
  corrupt[corrupt.length - 5] ^= 1;
  const reason = new Error("cancelled while thinking");
  const prefix = [
    reasoningFrame({ text: "signed" }),
    reasoningFrame({ signature: "sig" }),
    reasoningFrame({ redactedContent: "b3BhcXVl" }),
    reasoningFrame({ text: "open" }),
  ];
  for (const [respond, expected, cancel] of [
    [() => interruptedResponse(prefix), (error) => error.cause?.code === "UND_ERR_SOCKET"],
    [() => response([...prefix, corrupt]), /checksum/],
    [() => response([...prefix, valid.subarray(0, -1)]), /Truncated/],
    [() => response([...prefix, reasoningFrame({ signature: 7 })]), /Invalid Kiro reasoning event/],
    [() => response([...prefix, valid]), (error) => error === reason, true],
  ]) {
    const controller = new AbortController();
    const stream = streamRecorder();
    let attempts = 0;
    const run = createHttpTransport({
      authProvider: async () => auth,
      retry: fastRetry,
      fetchImpl: async () => { attempts++; return respond(); },
    });
    await assert.rejects(run({
      model: reasoningModel, context, signal: controller.signal, onText: stream.onText,
      onReasoning(event) {
        stream.onReasoning(event);
        if (cancel && event.delta === "open") controller.abort(reason);
      },
    }), expected);
    assert.equal(attempts, 1, "published reasoning without a recovery opt-in is terminal");
    assert.deepEqual(stream.content, [
      { type: "thinking", thinking: "signed" },
      { type: "redactedThinking", data: "" },
      { type: "thinking", thinking: "open" },
    ]);
    assert.deepEqual(
      stream.events.filter(({ type }) => type === "end").map(({ block }) => stream.content.indexOf(block)),
      [0, 2],
    );
  }
});

test("a different advertised response model is reported and blocks signature replay", async () => {
  for (const advertised of [reasoningModel, "rerouted-model"]) {
    const bodies = [];
    const stream = streamRecorder();
    const run = transport(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return response([
        reasoningFrame({ text: "think", signature: "sig" }),
        frame("assistantResponseEvent", { content: "Reading", modelId: advertised }),
        toolFrame("call"),
      ]);
    });
    const outcome = await run({
      model: reasoningModel, context, onText: stream.onText, onReasoning: stream.onReasoning,
    });
    const rerouted = advertised !== reasoningModel;
    assert.equal(bodies[0].conversationState.currentMessage.userInputMessage.modelId, reasoningModel);
    assert.equal(outcome.upstreamModel, rerouted ? advertised : undefined);
    assert.deepEqual(followUp(hostAssistant(stream.content, outcome)).reasoningContent,
      rerouted ? undefined : { reasoningText: { text: "think", signature: "sig" } });
  }
});

test("native uppercase stop reasons distinguish completion, truncation and real tool handoffs", async () => {
  for (const reason of ["MAX_TOKENS", "MODEL_CONTEXT_WINDOW_EXCEEDED", "max_tokens", "length", "END_TURN"]) {
    const result = await transport(async () => response([
      frame("assistantResponseEvent", { content: "partial" }),
      frame("metadataEvent", { stopReason: reason }),
    ]))({ model: "model", context });
    assert.equal(result.stopReason, reason === "END_TURN" ? "stop" : "length");
  }
  const result = await transport(async () => response([
    toolFrame("call"), frame("metadataEvent", { stopReason: "TOOL_USE" }),
  ]))({ model: "model", context });
  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.toolCalls, [{ type: "toolCall", id: "call", name: "read", arguments: { path: "a" } }]);
  await assert.rejects(transport(async () => response([
    frame("metadataEvent", { stopReason: "TOOL_USE" }),
  ]))({ model: "model", context }), /TOOL_USE without a tool call/);
});

test("refusal, paused turns, handoff compaction and unknown stops never release buffered tools or retry", async () => {
  for (const [stopReason, code] of [
    ["CONTENT_FILTERED", "ContentFiltered"], ["PAUSE_TURN", "PausedTurn"],
    ["COMPACTION_REQUIRED_FOR_MODEL_HANDOFF", "CompactionRequired"], ["UNKNOWN", "UnsupportedStopReason"],
  ]) {
    let attempts = 0;
    const stream = streamRecorder();
    const run = createHttpTransport({
      authProvider: async () => auth, retry: fastRetry,
      fetchImpl: async () => {
        attempts++;
        return response([
          reasoningFrame({ text: "Review", signature: "discarded-signature" }),
          toolFrame("unapproved"),
          frame("metadataEvent", {
            tokenUsage: { outputTokens: 8 },
            stopReason,
            stopDetails: { refusal: { category: "OTHER", explanation: `Not allowed ${auth.access_token}` } },
          }),
        ]);
      },
    });
    await assert.rejects(run({ model: "model", context, continuePartial: true, onReasoning: stream.onReasoning }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.usage.output, 8);
      assert.ok(!JSON.stringify(error).includes(auth.access_token));
      if (stopReason === "CONTENT_FILTERED") assert.deepEqual(error.stopDetails, {
        type: "refusal", category: "OTHER", explanation: "Not allowed [redacted]",
      });
      return true;
    });
    assert.equal(attempts, 1);
    assert.deepEqual(stream.content, [{ type: "thinking", thinking: "Review" }]);
  }
});

test("partial token metadata merges and credit metering never becomes dollars or estimated context tokens", async () => {
  const result = await transport(async () => response([
    frame("meteringEvent", { usage: 0.25, unit: "credit", unitPlural: "credits" }),
    frame("metadataEvent", { tokenUsage: { uncachedInputTokens: 10, cacheReadInputTokens: 4 } }),
    frame("contextUsageEvent", { contextUsagePercentage: 80 }),
    frame("metadataEvent", { tokenUsage: {
      outputTokens: 3, cacheWriteInputTokens: 5, totalTokens: 22, normalizedTokenUsage: 9000, contextUsagePercentage: 80,
    } }),
    frame("metadataEvent", { tokenUsage: { uncachedInputTokens: -1, outputTokens: "invalid" } }),
    frame("meteringEvent", { usage: 400, unit: "tokens" }),
    frame("assistantResponseEvent", { content: "Done" }),
  ]))({ model: "model", context });
  assert.deepEqual(result.usage, {
    input: 10, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 22,
    credits: { cost: 0.25 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("native event error variants honor transient versus quota classification", async () => {
  for (const [event, reason, retryable] of [
    ["error", undefined, true], ["serviceUnavailableError", undefined, true],
    ["throttlingError", "INSUFFICIENT_MODEL_CAPACITY", true],
    ["throttlingError", "MONTHLY_REQUEST_COUNT", false],
    ["throttlingError", "DAILY_REQUEST_COUNT", false],
    ["validationError", undefined, false],
  ]) {
    let attempts = 0;
    const run = createHttpTransport({
      authProvider: async () => auth, retry: fastRetry,
      fetchImpl: async () => ++attempts === 1
        ? response([frame(event, { message: `Request rejected ${auth.refresh_token}`, reason })])
        : response([frame("assistantResponseEvent", { content: "Recovered" })]),
    });
    const text = [];
    const turn = run({ model: "model", context, onText: (value) => text.push(value) });
    if (retryable) {
      await turn;
      assert.deepEqual(text, ["Recovered"]);
      assert.equal(attempts, 2);
    } else {
      await assert.rejects(turn, (error) => {
        assert.equal(error.reason, reason);
        assert.ok(!error.message.includes(auth.refresh_token));
        return true;
      });
      assert.deepEqual(text, []);
      assert.equal(attempts, 1);
    }
  }
});

test("a server-side tool result cannot impersonate an OMP-executed tool result", async () => {
  let attempts = 0;
  const run = createHttpTransport({
    authProvider: async () => auth, retry: fastRetry,
    fetchImpl: async () => {
      attempts++;
      return response([
        toolFrame("call"),
        frame("toolResultEvent", { toolResult: { toolUseId: "call", content: [{ text: "not executed by OMP" }] } }),
      ]);
    },
  });
  await assert.rejects(run({ model: "model", context, continuePartial: true }),
    (error) => error.code === "UnsupportedServerToolResult");
  assert.equal(attempts, 1);
});

test("native throttle delays use milliseconds and preserve the longer HTTP Retry-After", async () => {
  for (const [respond, expected] of [
    [() => Response.json({ __type: "ThrottlingException", retryAfterMilliseconds: 2500 }, { status: 429 }), 2500],
    [() => Response.json({ __type: "ThrottlingException" }, {
      status: 429, headers: { "x-amzn-kiro-ratelimit-retry-after": "3500", "retry-after": "2" },
    }), 3500],
    [() => Response.json({ __type: "ThrottlingException", retryAfterMilliseconds: 1000 }, {
      status: 429, headers: { "x-amzn-kiro-ratelimit-retry-after": "invalid", "retry-after": "4" },
    }), 4000],
    [() => response([frame("throttlingError", { message: "slow down", retryAfterMilliseconds: 1250 })]), 1250],
  ]) {
    const run = createHttpTransport({ authProvider: async () => auth, fetchImpl: async () => respond() });
    await assert.rejects(run({ model: "model", context, retry: { maxAttempts: 1 } }),
      (error) => error.retryAfterMs === expected);
  }
});
