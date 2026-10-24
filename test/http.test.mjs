import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHttpRequest, createHttpTransport, discoverHttpModels } from "../http.mjs";
import { crc32, decodeEventStream } from "../eventstream.mjs";

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
  assert.equal(body.systemPrompt, "System instructions");
  assert.equal(body.conversationState.conversationId, "9ab9c10d-fd8d-4d76-b537-7cc0b6b9c5a0");
  assert.equal(body.conversationState.history[0].userInputMessage.content, "Read both");
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

test("OMP system prompt arrays normalize into one native instruction string", () => {
  const input = {
    model: "model",
    context: { ...context, systemPrompt: ["First instruction", "Second instruction"] },
  };
  assert.equal(buildHttpRequest(input).systemPrompt, "First instruction\n\nSecond instruction");
  const withDeveloper = buildHttpRequest({
    ...input,
    context: {
      ...input.context,
      messages: [
        { role: "developer", content: "Developer instruction" },
        ...input.context.messages,
      ],
    },
  });
  assert.equal(
    withDeveloper.systemPrompt,
    "[System instructions]\nFirst instruction\n\nSecond instruction\n\n[Developer instructions at conversation message 1]\nDeveloper instruction",
  );
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
  assert.equal(
    body.systemPrompt,
    "[System instructions]\nSystem instructions\n\n[Developer instructions at conversation message 1]\nUse relative paths.\n\n[Developer instructions at conversation message 4]\nDo not repeat the read.",
  );
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
          models: [{ modelId: "one", modelName: "One", tokenLimits: { maxInputTokens: 200000 } }],
          nextToken: "next",
        });
      assert.equal(url.searchParams.get("nextToken"), "next");
      return Response.json({
        models: [{ modelId: "two", modelName: "Two", tokenLimits: { maxOutputTokens: 8000 } }],
      });
    },
  });
  assert.deepEqual(models, [
    { id: "one", name: "One", contextWindow: 200000 },
    { id: "two", name: "Two", maxTokens: 8000 },
  ]);
});
