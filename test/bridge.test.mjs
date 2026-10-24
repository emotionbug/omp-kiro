import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createToolRelay, discoverModels, openKiro, renderContext, runTurn } from "../bridge.mjs";

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
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const reply = (id, result) => send({ id, result });
  const text = (value) =>
    send({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: value },
        },
      },
    });
  let relayUrl;
  let promptId;
  let permissionDenied = false;
  let filesystemDenied = false;
  const state = {
    pid: process.pid,
    cwd: process.cwd(),
    config: JSON.parse(readFileSync(".kiro/agents/omp-kiro-bridge.json", "utf8")),
  };
  writeFileSync(statePath, JSON.stringify(state));
  if (mode === "hang" || mode === "init-hang") process.on("SIGTERM", () => {});
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (mode === "init-hang") {
        text("initializing");
        return;
      }
      reply(message.id, { agentCapabilities: { mcpCapabilities: { http: true } } });
    } else if (message.method === "session/new") {
      relayUrl = message.params.mcpServers[0]?.url;
      writeFileSync(statePath, JSON.stringify({ ...state, relayUrl }));
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
      promptId = message.id;
      if (mode === "hang") {
        text("ready");
        return;
      }
      if (mode === "eof") {
        process.stdout.end();
        return;
      }
      if (mode === "exit") {
        process.exit(7);
      }
      if (mode === "error") {
        send({ id: promptId, error: { message: "quota exceeded", data: { code: "quota" } } });
        return;
      }
      // Server and client request IDs are independent. Colliding IDs must not
      // turn a permission request into a successful prompt response.
      send({ id: promptId, method: "session/request_permission", params: {} });
      send({ id: -1, method: "fs/read_text_file", params: { path: "/should-not-read" } });
    } else if (message.id === promptId) {
      permissionDenied = message.result?.outcome?.outcome === "cancelled";
    } else if (message.id === -1) {
      filesystemDenied = message.error?.code === -32601;
    }
    if (permissionDenied && filesystemDenied) {
      permissionDenied = false;
      text("Hello ");
      text("world");
      if (mode === "tool") {
        await fetch(relayUrl, {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "omp_0", arguments: { path: "actual.txt" } },
          }),
        }).catch(() => {});
      } else {
        reply(promptId, { stopReason: "end_turn" });
      }
    }
  });
}

async function peer(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
  "HTTP relay exposes mapped tools and captures only the first call without a fabricated result",
  { timeout: 5000 },
  async (t) => {
    const relay = await createToolRelay(tools);
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
    const pending = request(relay.url, { method: "POST" });
    pending.on("response", (response) => {
      responses++;
      response.resume();
    });
    const disconnected = new Promise((resolve) => pending.once("error", resolve));
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
    await rpc({ method: "ping" });
    assert.deepEqual(await relay.called, call);
    await Promise.all([relay.close(), relay.close()]);
    await Promise.all([disconnected, secondDisconnected]);
    assert.equal(responses, 0);
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
    assert.match(result.toolCall.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(result, {
      toolCall: {
        type: "toolCall",
        id: result.toolCall.id,
        name: "read_file",
        arguments: { path: "actual.txt" },
      },
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
