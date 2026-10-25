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
  await run({ model: "selected-only", sessionId: "stable-session", context, onText: (s) => text.push(s) });
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
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

test("partial text disconnect remains an error for host continuation, never a success or replay", async () => {
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

test("host-owned generation retries can be disabled independently of catalog recovery", async () => {
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
