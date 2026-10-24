import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  closeAllSessions,
  closeSession,
  createToolRelay,
  discoverModels,
  openKiro,
  renderContext,
  runTurn,
} from "../server/bridge.mjs";

const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }];
const context = {
  systemPrompt: "Keep the workspace unchanged.",
  tools,
  messages: [
    { role: "user", content: "Read the file." },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Reading it." },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_file",
      isError: true,
      content: "not found",
    },
    {
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "read_file",
      isError: false,
      content: [{ type: "text", text: "contents" }],
    },
  ],
};

// A controllable ACP peer, not a model: exercises the actual child-process,
// JSON-RPC and HTTP transports without using Kiro's account or prompt quota.
async function kiroPeer({ mode, statePath, transcriptPath }) {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const { createServer } = await import("node:http");
  const send = (message, callback) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`, callback);
  const reply = (id, result) => send({ id, result });
  const text = (value, callback) =>
    send(
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: value },
          },
        },
      },
      callback,
    );
  let relayUrl;
  let promptId;
  let permissionDenied = false;
  let filesystemDenied = false;
  const starts = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).starts : [];
  const state = {
    pid: process.pid,
    cwd: process.cwd(),
    config: JSON.parse(readFileSync(".kiro/agents/omp-kiro-bridge.json", "utf8")),
    starts: [...starts, { pid: process.pid, cwd: process.cwd() }],
    prompts: [],
    results: [],
  };
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  if (mode === "persistent" || mode === "parallel") {
    const control = createServer((_request, response) => {
      text("Buffered ", () => response.end("sent"));
    });
    await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
    state.controlUrl = `http://127.0.0.1:${control.address().port}`;
  }
  save();
  if (mode === "hang" || mode === "init-hang") process.on("SIGTERM", () => {});
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (mode === "init-hang") {
        text("initializing");
        return;
      }
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: { mcpCapabilities: { http: true } },
      });
    } else if (message.method === "session/new") {
      relayUrl = message.params.mcpServers[0]?.url;
      state.relayUrl = relayUrl;
      save();
      reply(message.id, {
        sessionId: "session-1",
        modes: { currentModeId: "omp-kiro-bridge" },
        models: {
          currentModelId: "model-a",
          availableModels: [
            { modelId: "model-a", name: "Model A" },
            { modelId: "model-b", name: "Model B" },
          ],
        },
      });
    } else if (message.method === "session/set_model") {
      if (message.params.modelId !== "model-b") process.exit(3);
      reply(message.id, {});
    } else if (message.method === "session/prompt") {
      writeFileSync(transcriptPath, message.params.prompt[0].text);
      state.prompts.push(message.params.prompt[0].text);
      save();
      promptId = message.id;
      if (mode === "hang") {
        text("ready");
        return;
      }
      if (mode === "eof") {
        process.stdout.end();
        return;
      }
      if (mode === "exit") process.exit(7);
      if (mode === "error") {
        send({ id: promptId, error: { message: "quota exceeded", data: { code: "quota" } } });
        return;
      }
      // Server and client IDs are independent, even when they collide.
      send({ id: promptId, method: "session/request_permission", params: {} });
      send({ id: -1, method: "fs/read_text_file", params: { path: "/should-not-read" } });
    } else if (message.id === promptId) {
      permissionDenied = message.result?.outcome?.outcome === "cancelled";
    } else if (message.id === -1) {
      filesystemDenied = message.error?.code === -32601;
    }
    if (permissionDenied && filesystemDenied) {
      permissionDenied = false;
      filesystemDenied = false;
      text("Hello ");
      text("world");
      if (
        mode === "tool" ||
        ((mode === "persistent" || mode === "parallel") && state.prompts.length === 1)
      ) {
        const count = mode === "parallel" ? 2 : 1;
        await Promise.all(
          Array.from({ length: count }, async (_, index) => {
            const response = await fetch(relayUrl, {
              method: "POST",
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: index + 1,
                method: "tools/call",
                params: { name: "omp_0", arguments: { path: index ? "second.txt" : "actual.txt" } },
              }),
            }).catch(() => undefined);
            if (!response) return;
            state.results.push(await response.json());
            save();
          }),
        );
        if (mode !== "tool") {
          text("Tool complete.");
          reply(promptId, { stopReason: "end_turn" });
        }
      } else reply(promptId, { stopReason: "end_turn" });
    }
  });
}

async function peer(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-test-"));
  t.after(async () => {
    await closeAllSessions();
    await rm(directory, { recursive: true, force: true });
  });
  const command = join(directory, "kiro-peer.mjs");
  const statePath = join(directory, "state.json");
  const transcriptPath = join(directory, "transcript.txt");
  await writeFile(
    command,
    `#!${process.execPath}\n(${kiroPeer.toString()})(${JSON.stringify({ mode, statePath, transcriptPath })});\n`,
  );
  await chmod(command, 0o700);
  const previous = process.env.OMP_KIRO_COMMAND;
  process.env.OMP_KIRO_COMMAND = command;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_KIRO_COMMAND;
    else process.env.OMP_KIRO_COMMAND = previous;
  });
  return {
    command,
    state: async () => JSON.parse(await readFile(statePath, "utf8")),
    transcript: () => readFile(transcriptPath, "utf8"),
  };
}

async function assertStopped(state) {
  assert.throws(() => process.kill(state.pid, 0), { code: "ESRCH" });
  await assert.rejects(readFile(join(state.cwd, ".kiro/agents/omp-kiro-bridge.json")), {
    code: "ENOENT",
  });
}

// The executable peer uses a POSIX shebang, matching Kiro's supported CLI hosts.
const processTest = { skip: process.platform === "win32", timeout: 10_000 };

test("context keeps tool identity and actual result status for string and block content", () => {
  const rendered = renderContext(context, "/workspace");
  const transcript = JSON.parse(rendered.split("\n\n").at(-1));
  assert.deepEqual(transcript, {
    cwd: "/workspace",
    systemPrompt: context.systemPrompt,
    messages: [
      context.messages[0],
      { role: "assistant", content: context.messages[1].content.slice(1) },
      context.messages[2],
      context.messages[3],
    ],
  });
  assert.throws(
    () =>
      renderContext(
        { messages: [{ role: "user", content: [{ type: "image", data: "bytes" }] }] },
        "/workspace",
      ),
    /cannot forward image/,
  );
});

test(
  "HTTP relay keeps every call pending until its actual matching result arrives",
  { timeout: 5000 },
  async (t) => {
    const bothCalls = Promise.withResolvers();
    let captured = 0;
    const relay = await createToolRelay(tools, () => {
      if (++captured === 2) bothCalls.resolve();
    });
    t.after(() => relay.close());
    const rpc = async (message) => {
      const response = await fetch(relay.url, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await rpc({ method: "tools/list" }), {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "omp_0", description: "read_file: Read a file", inputSchema: { type: "object" } },
        ],
      },
    });
    const invalid = await fetch(relay.url, {
      method: "POST",
      body: JSON.stringify({ id: 2, method: "tools/call", params: { name: "missing" } }),
    });
    assert.equal(invalid.status, 400);
    await invalid.text();
    const args = { path: "한글.txt" };
    const bytes = Buffer.from(
      JSON.stringify({ id: 3, method: "tools/call", params: { name: "omp_0", arguments: args } }),
    );
    const split = bytes.indexOf(Buffer.from("한")) + 1;
    let responses = 0;
    const received = Promise.withResolvers();
    const pending = request(relay.url, { method: "POST" });
    pending.on("response", async (response) => {
      responses++;
      let body = "";
      for await (const chunk of response) body += chunk;
      received.resolve(JSON.parse(body));
    });
    pending.on("error", (error) => received.reject(error));
    pending.write(bytes.subarray(0, split));
    // Yield between chunks so the server must preserve a split UTF-8 codepoint.
    await new Promise((resolve) => setImmediate(resolve));
    pending.end(bytes.subarray(split));
    const call = await relay.called;
    assert.match(call.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(call, { type: "toolCall", id: call.id, name: "read_file", arguments: args });
    const second = request(relay.url, { method: "POST" });
    second.on("response", (response) => {
      responses++;
      response.resume();
    });
    const secondDisconnected = new Promise((resolve) => second.once("error", resolve));
    second.end(
      JSON.stringify({
        id: 4,
        method: "tools/call",
        params: { name: "omp_0", arguments: { path: "second.txt" } },
      }),
    );
    await bothCalls.promise;
    assert.deepEqual(await relay.called, call);
    const calls = relay.takeCalls();
    assert.equal(calls.length, 2);
    assert.equal(responses, 0);
    assert.deepEqual(
      calls.map((entry) => entry.arguments),
      [args, { path: "second.txt" }],
    );
    relay.respond({
      toolCallId: calls[0].id,
      toolName: "read_file",
      content: "actual contents",
      isError: false,
    });
    assert.deepEqual(await received.promise, {
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "actual contents" }], isError: false },
    });
    await Promise.all([relay.close(), relay.close(), secondDisconnected]);
    assert.equal(responses, 1);
  },
);

test(
  "turn streams text, preserves transcript and refuses ACP workspace access",
  processTest,
  async (t) => {
    const fixture = await peer(t, "text");
    const chunks = [];
    assert.deepEqual(
      await runTurn({
        model: "model-b",
        context,
        cwd: "/workspace",
        onText: (text) => chunks.push(text),
      }),
      {},
    );
    assert.deepEqual(chunks, ["Hello ", "world"]);
    assert.equal(await fixture.transcript(), renderContext(context, "/workspace"));
    const state = await fixture.state();
    assert.notEqual(state.cwd, "/workspace");
    assert.deepEqual(state.config.tools, ["@omp"]);
    assert.deepEqual(state.config.allowedTools, ["@omp"]);
    assert.deepEqual(state.config.mcpServers, {});
    assert.equal(state.config.includeMcpJson, false);
    await assertStopped(state);
    await assert.rejects(fetch(state.relayUrl), /fetch failed/);
  },
);

test(
  "turn returns a real relay call to OMP while Kiro is still awaiting the tool result",
  processTest,
  async (t) => {
    const fixture = await peer(t, "tool");
    const result = await runTurn({ model: "model-a", context, cwd: "/workspace" });
    assert.match(result.toolCalls[0].id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(result, {
      toolCalls: [
        {
          type: "toolCall",
          id: result.toolCalls[0].id,
          name: "read_file",
          arguments: { path: "actual.txt" },
        },
      ],
    });
    const state = await fixture.state();
    await assertStopped(state);
    await assert.rejects(fetch(state.relayUrl), /fetch failed/);
  },
);

test("abort escalates a SIGTERM-resistant child and closes the relay", processTest, async (t) => {
  const fixture = await peer(t, "hang");
  const controller = new AbortController();
  const reason = new Error("user cancelled");
  await assert.rejects(
    runTurn({
      model: "model-a",
      context,
      cwd: "/workspace",
      signal: controller.signal,
      onText: () => controller.abort(reason),
    }),
    (error) => error === reason,
  );
  const state = await fixture.state();
  await assertStopped(state);
  await assert.rejects(fetch(state.relayUrl), /fetch failed/);
});

test(
  "missing binary rejects without waiting for a nonexistent exit event",
  { timeout: 5000 },
  async () => {
    await assert.rejects(
      openKiro({
        command: join(tmpdir(), "nonexistent-omp-kiro", "cli"),
        signal: AbortSignal.timeout(2000),
      }),
      { code: "ENOENT" },
    );
  },
);

test("pre-aborted turns never start Kiro", processTest, async (t) => {
  const fixture = await peer(t, "text");
  const reason = new Error("already cancelled");
  await assert.rejects(
    runTurn({ model: "model-a", context, cwd: "/workspace", signal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
  await assert.rejects(fixture.state(), { code: "ENOENT" });
});

test(
  "abort during initialization tears down before openKiro returns a connection",
  processTest,
  async (t) => {
    const fixture = await peer(t, "init-hang");
    const controller = new AbortController();
    const reason = new Error("cancel initialization");
    await assert.rejects(
      openKiro({
        command: fixture.command,
        signal: controller.signal,
        onText: () => controller.abort(reason),
      }),
      (error) => error === reason,
    );
    await assertStopped(await fixture.state());
  },
);

for (const [mode, expected] of [
  ["eof", /closed its ACP output/],
  ["exit", /Kiro (exited|closed its ACP output)/],
  ["error", /quota exceeded/],
]) {
  test(`${mode} rejects the pending turn and releases resources`, processTest, async (t) => {
    const fixture = await peer(t, mode);
    await assert.rejects(runTurn({ model: "model-a", context, cwd: "/workspace" }), expected);
    const state = await fixture.state();
    await assertStopped(state);
    await assert.rejects(fetch(state.relayUrl), /fetch failed/);
  });
}

test("discovery returns the ACP catalog and close is idempotent", processTest, async (t) => {
  const fixture = await peer(t, "text");
  assert.deepEqual(await discoverModels(), [
    { id: "model-a", name: "Model A" },
    { id: "model-b", name: "Model B" },
  ]);
  await assertStopped(await fixture.state());
  const connection = await openKiro({
    command: fixture.command,
    signal: AbortSignal.timeout(5000),
  });
  await Promise.all([connection.close(), connection.close()]);
  await assertStopped(await fixture.state());
});

function freshContext() {
  return {
    systemPrompt: "Use only OMP tools.",
    tools,
    messages: [{ role: "user", content: "Read actual.txt." }],
  };
}

function appendAssistant(context, text, toolCalls = []) {
  context.messages.push({
    role: "assistant",
    content: [...(text ? [{ type: "text", text }] : []), ...toolCalls],
  });
}

function appendResults(context, calls) {
  for (const call of calls) {
    context.messages.push({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      isError: call.arguments.path === "second.txt",
      content: `actual:${call.arguments.path}`,
    });
  }
}

test(
  "persistent session resumes the same MCP request and sends only later user messages",
  processTest,
  async (t) => {
    const fixture = await peer(t, "persistent");
    const history = freshContext();
    const firstText = [];
    const controller = new AbortController();
    const options = {
      model: "model-a",
      context: history,
      cwd: "/workspace",
      sessionId: "persistent",
    };
    const first = await runTurn({
      ...options,
      signal: controller.signal,
      onText: (text) => firstText.push(text),
    });
    assert.equal(first.toolCalls.length, 1);
    assert.deepEqual(firstText, ["Hello ", "world"]);
    const initial = await fixture.state();
    assert.equal(initial.results.length, 0);
    // A completed stream's signal must not own the child while OMP runs tools.
    controller.abort(new Error("old invocation ended"));
    const buffered = await fetch(initial.controlUrl);
    await buffered.text();
    appendAssistant(history, firstText.join(""), first.toolCalls);
    appendResults(history, first.toolCalls);
    const secondText = [];
    assert.deepEqual(await runTurn({ ...options, onText: (text) => secondText.push(text) }), {});
    assert.equal(secondText.join(""), "Buffered Tool complete.");
    assert.deepEqual(firstText, ["Hello ", "world"]);
    const resumed = await fixture.state();
    assert.equal(resumed.pid, initial.pid);
    assert.equal(resumed.prompts.length, 1);
    assert.deepEqual(resumed.results, [
      {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "actual:actual.txt" }], isError: false },
      },
    ]);
    appendAssistant(history, secondText.join(""));
    const latest = { role: "user", content: "Now answer the next question." };
    history.messages.push(latest);
    const thirdText = [];
    assert.deepEqual(await runTurn({ ...options, onText: (text) => thirdText.push(text) }), {});
    assert.equal(thirdText.join(""), "Hello world");
    const completed = await fixture.state();
    assert.equal(completed.pid, initial.pid);
    assert.equal(completed.starts.length, 1);
    assert.equal(completed.prompts.length, 2);
    assert.deepEqual(JSON.parse(completed.prompts[1].split("\n\n").at(-1)), { messages: [latest] });
    await Promise.all([closeSession("persistent"), closeSession("persistent")]);
    await assertStopped(initial);
    await assert.rejects(fetch(initial.relayUrl), /fetch failed/);
  },
);

test(
  "parallel pending MCP calls all receive their own real results without replay",
  processTest,
  async (t) => {
    const fixture = await peer(t, "parallel");
    const history = freshContext();
    const ids = new Set();
    let outcome;
    do {
      const chunks = [];
      outcome = await runTurn({
        model: "model-a",
        context: history,
        cwd: "/workspace",
        sessionId: "parallel",
        onText: (text) => chunks.push(text),
      });
      appendAssistant(history, chunks.join(""), outcome.toolCalls);
      for (const call of outcome.toolCalls ?? []) {
        assert.equal(ids.has(call.id), false);
        ids.add(call.id);
      }
      appendResults(history, outcome.toolCalls ?? []);
    } while (outcome.toolCalls?.length);
    const state = await fixture.state();
    assert.equal(ids.size, 2);
    assert.equal(state.starts.length, 1);
    assert.equal(state.prompts.length, 1);
    assert.deepEqual(
      state.results.sort((a, b) => a.id - b.id),
      [
        {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "actual:actual.txt" }], isError: false },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "actual:second.txt" }], isError: true },
        },
      ],
    );
    await closeAllSessions();
    await assertStopped(state);
  },
);

test(
  "history, system, tools, cwd and model changes reset instead of retaining stale context",
  processTest,
  async (t) => {
    const fixture = await peer(t, "text");
    let history = freshContext();
    let model = "model-a";
    let cwd = "/workspace";
    const turn = async () => {
      const chunks = [];
      await runTurn({
        model,
        context: history,
        cwd,
        sessionId: "reset",
        onText: (text) => chunks.push(text),
      });
      appendAssistant(history, chunks.join(""));
      return fixture.state();
    };
    let state = await turn();
    // OMP metadata and hidden reasoning do not change the semantic prefix.
    history.messages[1].timestamp = 42;
    history.messages[1].content.unshift({ type: "thinking", thinking: "not forwarded" });
    history.messages.push({ role: "user", content: "Next." });
    const reused = await turn();
    assert.equal(reused.pid, state.pid);
    const mutations = [
      () => {
        history.messages[0].content = "A different branch.";
      },
      () => {
        history.systemPrompt = "A changed system instruction.";
      },
      () => {
        history.tools = [{ ...tools[0], description: "A changed tool description" }];
      },
      () => {
        cwd = "/other-workspace";
      },
      () => {
        model = "model-b";
      },
      () => {
        history = { ...history, messages: [{ role: "user", content: "Compacted summary." }] };
      },
    ];
    for (const mutate of mutations) {
      state = await fixture.state();
      mutate();
      const replacement = await turn();
      assert.notEqual(replacement.pid, state.pid);
      await assertStopped(state);
      const sent = JSON.parse(replacement.prompts[0].split("\n\n").at(-1));
      assert.equal(sent.cwd, cwd);
      assert.equal(sent.systemPrompt, history.systemPrompt);
      assert.equal(sent.messages[0].content, history.messages[0].content);
    }
    await closeAllSessions();
    await assertStopped(await fixture.state());
  },
);

test(
  "mutable OMP tool runtime metadata does not reset an unchanged wire tool schema",
  processTest,
  async (t) => {
    const fixture = await peer(t, "text");
    const history = freshContext();
    const tool = {
      ...tools[0],
      revision: 0,
      inputs: { value: "initial runtime input" },
      value: { pending: false },
    };
    history.tools = [tool];
    const options = {
      model: "model-a",
      context: history,
      cwd: "/workspace",
      sessionId: "tool-metadata",
    };
    const firstText = [];
    await runTurn({ ...options, onText: (text) => firstText.push(text) });
    const initial = await fixture.state();
    appendAssistant(history, firstText.join(""));
    history.messages.push({ role: "user", content: "Continue with the same tools." });
    tool.revision++;
    tool.inputs.value = "changed runtime input";
    tool.value.pending = true;
    const secondText = [];
    assert.deepEqual(await runTurn({ ...options, onText: (text) => secondText.push(text) }), {});
    assert.equal(secondText.join(""), "Hello world");
    const continued = await fixture.state();
    assert.equal(continued.pid, initial.pid);
    assert.equal(continued.starts.length, 1);
    assert.equal(continued.prompts.length, 2);
    assert.deepEqual(JSON.parse(continued.prompts[1].split("\n\n").at(-1)), {
      messages: [{ role: "user", content: "Continue with the same tools." }],
    });
    await closeSession("tool-metadata");
    await assertStopped(initial);
  },
);

test(
  "concurrent turns serialize on the same child and route only to the active callback",
  processTest,
  async (t) => {
    const fixture = await peer(t, "text");
    const firstHistory = freshContext();
    const secondHistory = freshContext();
    appendAssistant(secondHistory, "Hello world");
    secondHistory.messages.push({ role: "user", content: "Second turn." });
    const firstText = [];
    const secondText = [];
    let second;
    const first = runTurn({
      model: "model-a",
      context: firstHistory,
      cwd: "/workspace",
      sessionId: "serialized",
      onText(text) {
        firstText.push(text);
        second ??= runTurn({
          model: "model-a",
          context: secondHistory,
          cwd: "/workspace",
          sessionId: "serialized",
          onText: (chunk) => secondText.push(chunk),
        });
      },
    });
    assert.deepEqual(await first, {});
    assert.deepEqual(await second, {});
    assert.deepEqual(firstText, ["Hello ", "world"]);
    assert.deepEqual(secondText, ["Hello ", "world"]);
    const state = await fixture.state();
    assert.equal(state.starts.length, 1);
    assert.equal(state.prompts.length, 2);
    await closeSession("serialized");
    await assertStopped(state);
  },
);

test("cancelling a queued turn does not cancel the active invocation", processTest, async (t) => {
  const fixture = await peer(t, "hang");
  const ready = Promise.withResolvers();
  const activeController = new AbortController();
  const active = runTurn({
    model: "model-a",
    context: freshContext(),
    cwd: "/workspace",
    sessionId: "queued",
    signal: activeController.signal,
    onText: () => ready.resolve(),
  });
  const activeRejected = assert.rejects(active, /cancel active/);
  await ready.promise;
  const queuedController = new AbortController();
  const queued = runTurn({
    model: "model-a",
    context: freshContext(),
    cwd: "/workspace",
    sessionId: "queued",
    signal: queuedController.signal,
  });
  queuedController.abort(new Error("cancel queued"));
  await assert.rejects(queued, /cancel queued/);
  const state = await fixture.state();
  assert.doesNotThrow(() => process.kill(state.pid, 0));
  activeController.abort(new Error("cancel active"));
  await activeRejected;
  await assertStopped(state);
  await assert.rejects(fetch(state.relayUrl), /fetch failed/);
});

test(
  "closing suspended sessions cannot asynchronously remove a newer replacement",
  processTest,
  async (t) => {
    const fixture = await peer(t, "persistent");
    const options = {
      model: "model-a",
      context: freshContext(),
      cwd: "/workspace",
      sessionId: "replace",
    };
    await runTurn(options);
    const previous = await fixture.state();
    const closing = closeSession("replace");
    const replacementText = [];
    const replacement = await runTurn({ ...options, onText: (text) => replacementText.push(text) });
    await closing;
    await assertStopped(previous);
    const current = await fixture.state();
    assert.notEqual(current.pid, previous.pid);
    assert.equal(current.starts.length, 2);
    appendAssistant(options.context, replacementText.join(""), replacement.toolCalls);
    appendResults(options.context, replacement.toolCalls);
    assert.deepEqual(await runTurn(options), {});
    assert.equal((await fixture.state()).pid, current.pid);
    await closeAllSessions();
    await assertStopped(current);
    await assert.rejects(fetch(current.relayUrl), /fetch failed/);
  },
);

test(
  "mismatched tool results close the suspended child instead of fabricating a continuation",
  processTest,
  async (t) => {
    const fixture = await peer(t, "persistent");
    const history = freshContext();
    const chunks = [];
    const options = {
      model: "model-a",
      context: history,
      cwd: "/workspace",
      sessionId: "mismatch",
    };
    const first = await runTurn({ ...options, onText: (text) => chunks.push(text) });
    appendAssistant(history, chunks.join(""), first.toolCalls);
    history.messages.push({
      role: "toolResult",
      toolCallId: "unrelated",
      toolName: "read_file",
      content: "not its result",
    });
    await assert.rejects(runTurn(options), /actual matching results/);
    const state = await fixture.state();
    assert.deepEqual(state.results, []);
    await assertStopped(state);
  },
);
