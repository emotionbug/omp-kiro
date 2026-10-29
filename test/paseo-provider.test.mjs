import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { ProviderEventSchema, PROVIDER_CAPABILITIES } from "@getpaseo/plugin/server/provider";
import { createKiroHttpProvider } from "../server/provider.mjs";
import { createHttpTransport } from "../server/http.mjs";
import { crc32 } from "../server/eventstream.mjs";

const fixture = fileURLToPath(new URL("./fixtures/paseo-mcp.mjs", import.meta.url));
const auth = {
  access_token: "controlled-access-secret",
  refresh_token: "controlled-refresh-secret",
  profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/controlled-secret",
};

function frame(event, data) {
  const header = (name, value) => {
    const n = Buffer.from(name),
      v = Buffer.from(value);
    const bytes = Buffer.alloc(n.length + v.length + 4);
    bytes[0] = n.length;
    n.copy(bytes, 1);
    bytes[n.length + 1] = 7;
    bytes.writeUInt16BE(v.length, n.length + 2);
    v.copy(bytes, n.length + 4);
    return bytes;
  };
  const headers = Buffer.concat([header(":message-type", "event"), header(":event-type", event)]);
  const payload = Buffer.from(JSON.stringify(data));
  const bytes = Buffer.alloc(16 + headers.length + payload.length);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.writeUInt32BE(headers.length, 4);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
  headers.copy(bytes, 12);
  payload.copy(bytes, 12 + headers.length);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
  return bytes;
}
const textResponse = (text) => new Response(frame("assistantResponseEvent", { content: text }));
const toolResponse = (name, args, id = "call-1") =>
  new Response(
    Buffer.concat([
      frame("assistantResponseEvent", { content: "Working" }),
      frame("toolUseEvent", { toolUseId: id, name, input: JSON.stringify(args), stop: true }),
    ]),
  );

async function harness(t, generation, overrides = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "kiro-provider-"));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  const requests = [],
    authFiles = [],
    events = [],
    schemaErrors = [],
    waiters = new Set();
  const provider = createKiroHttpProvider({
    stateDir: path.join(root, "state"),
    transportFactory: createHttpTransport,
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    authProvider: async ({ authFile }) => {
      authFiles.push(authFile);
      return auth;
    },
    fetchImpl: async (url, init) => {
      if (init.headers["x-amz-target"] === "KiroControlPlaneBearerService.ListAvailableModels")
        return Response.json({
          models: [
            { modelId: "model-a", modelName: "Model A" },
            { modelId: "model-b", modelName: "Model B" },
          ],
        });
      const body = JSON.parse(init.body);
      requests.push(body);
      return generation(body, requests.length, init.signal);
    },
    ...overrides,
  });
  const connection = await provider.connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
    launch: {
      command: process.execPath,
      args: [],
      env: { ...process.env, OMP_KIRO_AUTH_FILE: path.join(root, "configured.sqlite3") },
    },
  });
  connection.onEvent((event) => {
    events.push(event);
    const parsed = ProviderEventSchema.safeParse(event);
    if (!parsed.success) schemaErrors.push(parsed.error.message);
    for (const waiter of waiters) waiter();
  });
  t.after(async () => {
    await connection.close();
    assert.deepEqual(schemaErrors, [], "every emitted event validates against the public SDK");
    await fs.rm(root, { recursive: true, force: true });
  });
  const waitFor = async (predicate) => {
    const existing = events.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const check = () => {
        const event = events.find(predicate);
        if (event) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(event);
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error("Timed out waiting for provider event"));
      }, 5000);
      waiters.add(check);
    });
  };
  const config = {
    cwd,
    env: {},
    mcpServers: {},
    model: "model-a",
    settings: {},
    persist: true,
  };
  const open = async (changes = {}, persistence, sessionId = "session") => {
    const requestId = `open:${sessionId}:${events.length}`;
    await connection.send({
      type: "session.open",
      requestId,
      sessionId,
      config: { ...config, ...changes },
      history: "replay",
      ...(persistence ? { persistence } : {}),
    });
    const event = await waitFor(
      (event) =>
        (event.type === "session.ready" || event.type === "request.failed") &&
        event.requestId === requestId,
    );
    assert.equal(event.type, "session.ready", event.error?.message);
    return events.find((event) => event.type === "session.opened" && event.sessionId === sessionId);
  };
  let sequence = 0;
  const prompt = async (text = "Work", sessionId = "session") => {
    const clientMessageId = `message-${++sequence}`;
    await connection.send({
      type: "session.prompt",
      sessionId,
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text }] },
      },
    });
    const result = await waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    assert.equal(result.result.type, "turn");
    return result.result.turnId;
  };
  const terminal = (turnId) =>
    waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
  return {
    root,
    cwd,
    provider,
    connection,
    config,
    events,
    requests,
    authFiles,
    waitFor,
    open,
    prompt,
    terminal,
  };
}

test("direct HTTP writes a real workspace file, returns actual results, streams snapshots, and persists/replays", async (t) => {
  const h = await harness(t, (body, count) => {
    if (count === 1)
      return toolResponse("write_file", { path: "hello.txt", content: "real workspace content" });
    const current = body.conversationState.currentMessage.userInputMessage;
    assert.equal(current.userInputMessageContext.toolResults[0].status, "success");
    assert.match(current.userInputMessageContext.toolResults[0].content[0].text, /Wrote 22 bytes/);
    return textResponse(`Done ${auth.access_token}`);
  });
  const opened = await h.open();
  const turn = await h.prompt();
  assert.equal((await h.terminal(turn)).state, "completed");
  assert.equal(await fs.readFile(path.join(h.cwd, "hello.txt"), "utf8"), "real workspace content");
  assert.ok(
    h.events.some(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed",
    ),
  );
  assert.equal(h.events.filter((event) => event.type === "session.prompt_result").length, 1);
  assert.equal(
    h.events.filter((event) => event.type === "session.turn" && event.state !== "started").length,
    1,
  );
  const key = opened.persistence.data.nativeSessionId;
  const saved = await fs.readFile(path.join(h.root, "state", `${key}.json`), "utf8");
  assert.ok(!saved.includes(auth.access_token));
  assert.ok(!saved.includes(auth.refresh_token));
  assert.ok(!saved.includes(auth.profile_arn));
  assert.ok(h.authFiles.every((file) => file === path.join(h.root, "configured.sqlite3")));
  await h.connection.send({
    type: "session.configure",
    sessionId: "session",
    requestId: "model-change",
    changes: { model: "model-b", mode: "ask" },
  });
  await h.waitFor(
    (event) => event.type === "request.completed" && event.requestId === "model-change",
  );
  const configIndex = h.events.findLastIndex((event) => event.type === "session.config");
  const completionIndex = h.events.findIndex(
    (event) => event.type === "request.completed" && event.requestId === "model-change",
  );
  assert.ok(configIndex < completionIndex);
  assert.equal(h.events[configIndex].config.model, "model-b");
  await h.connection.send({
    type: "session.close",
    sessionId: "session",
    requestId: "close-first",
  });
  await h.waitFor(
    (event) => event.type === "request.completed" && event.requestId === "close-first",
  );
  await h.open({ model: undefined, mode: undefined }, opened.persistence, "restored");
  assert.ok(
    h.events.some(
      (event) =>
        event.type === "timeline.item" &&
        event.sessionId === "restored" &&
        event.item.type === "assistant_message" &&
        event.item.text.includes("[redacted]"),
    ),
  );
  assert.equal(
    h.events.findLast((event) => event.type === "session.config").config.model,
    "model-b",
  );
});

test("new sessions default to full access and execute real writes and commands without approval", async (t) => {
  const command = `${JSON.stringify(process.execPath)} -e "require('fs').appendFileSync('default-access.txt','+command')"`;
  const h = await harness(t, (body, count) => {
    if (count === 1)
      return toolResponse("write_file", { path: "default-access.txt", content: "written" }, "default-write");
    const results = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults;
    assert.equal(results[0].status, "success");
    if (count === 2) return toolResponse("run_command", { command }, "default-command");
    return textResponse("Executed with default full access");
  });
  await h.connection.send({ type: "catalog", requestId: "default-policy" });
  const catalog = await h.waitFor((event) => event.type === "catalog" && event.requestId === "default-policy");
  assert.equal(catalog.catalog.defaultMode, "full");
  await h.open();
  const configuration = await h.waitFor((event) => event.type === "session.config" && event.sessionId === "session");
  assert.equal(configuration.config.mode, "full");
  assert.equal((await h.terminal(await h.prompt())).state, "completed");
  assert.equal(await fs.readFile(path.join(h.cwd, "default-access.txt"), "utf8"), "written+command");
  assert.equal(h.events.filter((event) => event.type === "session.permission").length, 0);
  assert.deepEqual(h.events.filter((event) => event.type === "timeline.item" &&
    event.item.type === "tool_call" && event.item.status === "completed")
    .map((event) => event.item.callId), ["default-write", "default-command"]);
});

test("absolute Unicode tool paths through a workspace alias resolve to the same physical workspace", async (t) => {
  let calls;
  const h = await harness(t, (body, count) => {
    if (count > 1) {
      const results = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults;
      assert.equal(results[0].status, "success", results[0].content[0].text);
    }
    const call = calls[count - 1];
    return call ? toolResponse(call[0], call[1], `alias-${count}`) : textResponse("Alias tools completed");
  });
  const alias = path.join(h.root, "workspace alias 작업");
  // Junctions exercise actual Windows canonicalization without requiring symlink privileges.
  await fs.symlink(h.cwd, alias, process.platform === "win32" ? "junction" : "dir");
  const output = path.join(alias, "chain result 한글.txt");
  assert.equal(await fs.realpath(alias), await fs.realpath(h.cwd));
  assert.ok(path.relative(await fs.realpath(h.cwd), output).startsWith(`..${path.sep}`));
  calls = [
    ["write_file", { path: output, content: "original 한글" }],
    ["read_file", { path: output }],
    ["edit_file", { path: output, oldText: "original", newText: "updated" }],
    ["list_directory", { path: alias }],
  ];
  await h.open({ cwd: alias });
  assert.equal((await h.terminal(await h.prompt())).state, "completed");
  assert.equal(await fs.readFile(path.join(h.cwd, "chain result 한글.txt"), "utf8"), "updated 한글");
  assert.equal(h.events.filter((event) => event.type === "timeline.item" &&
    event.item.type === "tool_call" && event.item.status === "completed").length, calls.length);
  assert.equal(h.events.filter((event) => event.type === "session.permission").length, 0);
});

test("absolute aliases do not permit sibling paths, relative traversal, or escaping directory links", async (t) => {
  let scenarios;
  const h = await harness(t, (body, count) => {
    if (count % 2 === 1)
      return toolResponse("write_file", { path: scenarios[(count - 1) / 2], content: "must not write" }, `escape-${count}`);
    const results = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults;
    assert.equal(results[0].status, "error");
    assert.match(results[0].content[0].text, /Tool path (?:must stay within|resolves outside) the workspace/);
    return textResponse("Escape rejected");
  });
  const outside = path.join(h.root, "workspace-other");
  const alias = path.join(h.root, "workspace alias");
  await fs.mkdir(outside);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(h.cwd, alias, linkType);
  await fs.symlink(outside, path.join(h.cwd, "escape"), linkType);
  scenarios = [
    path.join(outside, "absolute.txt"),
    "../relative.txt",
    path.join(alias, "escape", "linked.txt"),
    "escape/relative-linked.txt",
  ];
  await h.open({ cwd: alias });
  for (const name of scenarios)
    assert.equal((await h.terminal(await h.prompt(name))).state, "completed");
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.stat(path.join(h.root, "relative.txt")), { code: "ENOENT" });
});

test("ask denial does not write, exact approval runs once, and plan rejects writes without approval", async (t) => {
  let phase = 0;
  const h = await harness(t, (body, count) =>
    count % 2 === 1
      ? toolResponse("write_file", { path: "allowed.txt", content: "approved" }, `write-${++phase}`)
      : textResponse("Tool result received"),
  );
  await h.open({ mode: "ask" });
  const denied = await h.prompt();
  const permission = await h.waitFor((event) => event.type === "session.permission");
  await assert.rejects(fs.stat(path.join(h.cwd, "allowed.txt")), { code: "ENOENT" });
  assert.equal(h.requests.length, 1, "explicit ask blocks before executing the write");
  await h.connection.send({
    type: "session.permission",
    sessionId: "session",
    permissionId: permission.request.id,
    response: { behavior: "deny" },
  });
  await h.terminal(denied);
  await assert.rejects(fs.stat(path.join(h.cwd, "allowed.txt")), { code: "ENOENT" });
  assert.equal(
    h.requests[1].conversationState.currentMessage.userInputMessage.userInputMessageContext
      .toolResults[0].status,
    "error",
  );
  const allowed = await h.prompt();
  const second = await h.waitFor(
    (event) => event.type === "session.permission" && event.request.id !== permission.request.id,
  );
  await assert.rejects(fs.stat(path.join(h.cwd, "allowed.txt")), { code: "ENOENT" });
  assert.equal(h.requests.length, 3, "the second ask remains blocked until approval");
  await h.connection.send({
    type: "session.permission",
    sessionId: "session",
    permissionId: second.request.id,
    response: { behavior: "allow", selectedActionId: "allow" },
  });
  await h.terminal(allowed);
  assert.equal(await fs.readFile(path.join(h.cwd, "allowed.txt"), "utf8"), "approved");
  await fs.unlink(path.join(h.cwd, "allowed.txt"));
  await h.connection.send({
    type: "session.configure",
    requestId: "plan",
    sessionId: "session",
    changes: { mode: "plan" },
  });
  await h.waitFor((event) => event.type === "request.completed" && event.requestId === "plan");
  await h.terminal(await h.prompt());
  await assert.rejects(fs.stat(path.join(h.cwd, "allowed.txt")), { code: "ENOENT" });
  assert.equal(h.events.filter((event) => event.type === "session.permission").length, 2);
});

test("stdio MCP uses exact server/tool preapproval without approving another tool or native commands", async (t) => {
  let stage = 0;
  const h = await harness(t, (body) => {
    stage++;
    const tools =
      body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
    if (stage === 1)
      return toolResponse(
        tools.find((tool) => tool.toolSpecification.description.startsWith("[MCP fixture/record]"))
          .toolSpecification.name,
        { value: "first" },
      );
    if (stage === 2) {
      assert.match(
        body.conversationState.currentMessage.userInputMessage.userInputMessageContext
          .toolResults[0].content[0].text,
        /recorded:first/,
      );
      return toolResponse(
        tools.find((tool) => tool.toolSpecification.description.startsWith("[MCP fixture/other]"))
          .toolSpecification.name,
        {},
        "other-id",
      );
    }
    if (stage === 3)
      return toolResponse(
        "write_file",
        { path: "native.txt", content: "must not write" },
        "native-id",
      );
    return textResponse("Finished");
  });
  const marker = path.join(h.root, "mcp.log"),
    pidFile = path.join(h.root, "mcp.pid");
  await h.open({
    mode: "ask",
    mcpServers: {
      fixture: { type: "stdio", command: process.execPath, args: [fixture, marker, pidFile] },
    },
    toolPolicy: { preapproved: [{ kind: "mcp", server: "fixture", tool: "record" }] },
  });
  const turn = await h.prompt();
  const first = await h.waitFor((event) => event.type === "session.permission");
  assert.equal(first.request.title, "fixture/other");
  await h.connection.send({
    type: "session.permission",
    sessionId: "session",
    permissionId: first.request.id,
    response: { behavior: "deny" },
  });
  const second = await h.waitFor(
    (event) => event.type === "session.permission" && event.request.id !== first.request.id,
  );
  assert.equal(second.request.title, "write_file");
  await h.connection.send({
    type: "session.permission",
    sessionId: "session",
    permissionId: second.request.id,
    response: { behavior: "deny" },
  });
  assert.equal((await h.terminal(turn)).state, "completed");
  assert.equal(await fs.readFile(marker, "utf8"), "record:first\n");
  await assert.rejects(fs.stat(path.join(h.cwd, "native.txt")), { code: "ENOENT" });
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  await h.connection.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("HTTP MCP makes real initialize/list/call requests and wrong-server preapproval fails closed", async (t) => {
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    const message = JSON.parse(bytes);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === "initialize")
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "http-fixture", version: "1" },
      };
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "record",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      };
    else if (message.method === "tools/call") {
      calls.push(message.params);
      result = { content: [{ type: "text", text: "actual HTTP result" }] };
    } else result = {};
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const h = await harness(t, (body, count) => {
    const tools =
      body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
    return count % 2 === 1
      ? toolResponse(
          tools.find((tool) => tool.toolSpecification.description.startsWith("[MCP http/record]"))
            .toolSpecification.name,
          { value: "value" },
        )
      : textResponse("Done");
  });
  await h.open({
    mode: "ask",
    mcpServers: { http: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp` } },
    toolPolicy: { preapproved: [{ kind: "mcp", server: "different", tool: "record" }] },
  });
  const turn = await h.prompt();
  const permission = await h.waitFor((event) => event.type === "session.permission");
  assert.deepEqual(calls, []);
  await h.connection.send({
    type: "session.permission",
    sessionId: "session",
    permissionId: permission.request.id,
    response: { behavior: "allow" },
  });
  assert.equal((await h.terminal(turn)).state, "completed");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments, { value: "value" });
});

test("canceling a stream or approval produces one canceled terminal and releases pending tool state", async (t) => {
  let canceled = false,
    streaming = true;
  const h = await harness(t, () =>
    streaming
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(frame("assistantResponseEvent", { content: "partial" }));
            },
            cancel() {
              canceled = true;
            },
          }),
        )
      : toolResponse("write_file", { path: "canceled.txt", content: "no" }),
  );
  await h.open({ mode: "ask" });
  const turn = await h.prompt();
  await h.waitFor(
    (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
  );
  await h.connection.send({
    type: "session.interrupt",
    requestId: "interrupt-stream",
    sessionId: "session",
  });
  assert.equal((await h.terminal(turn)).state, "canceled");
  assert.ok(canceled);
  await h.waitFor(
    (event) => event.type === "request.completed" && event.requestId === "interrupt-stream",
  );
  streaming = false;
  const approvalTurn = await h.prompt();
  const permission = await h.waitFor((event) => event.type === "session.permission");
  await h.connection.send({
    type: "session.interrupt",
    requestId: "interrupt-permission",
    sessionId: "session",
  });
  assert.equal((await h.terminal(approvalTurn)).state, "canceled");
  await h.waitFor(
    (event) =>
      event.type === "session.permission_resolved" && event.permissionId === permission.request.id,
  );
  assert.ok(
    h.events.some(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "tool_call" &&
        event.item.status === "canceled",
    ),
  );
  await assert.rejects(fs.stat(path.join(h.cwd, "canceled.txt")), { code: "ENOENT" });
  assert.equal(
    h.events.filter(
      (event) =>
        event.type === "session.turn" && event.turnId === turn && event.state !== "started",
    ).length,
    1,
  );
});

test("schema-invalid arguments, unknown tools, workspace escapes, and command overflow fail explicitly", async (t) => {
  let choice = 0;
  const scenarios = [
    ["write_file", { path: "../escape.txt", content: "no" }],
    ["write_file", { path: "invalid.txt", content: 123 }],
    ["not_registered", {}],
    [
      "run_command",
      {
        command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(200000))"`,
      },
    ],
  ];
  let pendingResult = false;
  const h = await harness(t, () => {
    if (pendingResult) {
      pendingResult = false;
      return textResponse("Handled failure");
    }
    const [name, args] = scenarios[choice++];
    pendingResult = name !== "not_registered";
    return toolResponse(name, args, `bad-${choice}`);
  });
  await h.open();
  for (let i = 0; i < scenarios.length; i++) {
    const terminal = await h.terminal(await h.prompt());
    assert.equal(terminal.state, i === 2 ? "failed" : "completed");
  }
  await assert.rejects(fs.stat(path.join(h.root, "escape.txt")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(h.cwd, "invalid.txt")), { code: "ENOENT" });
  const failedTools = h.events.filter(
    (event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.status === "failed",
  );
  assert.ok(failedTools.some((event) => String(event.item.error).includes("128 KiB")));
  assert.ok(
    failedTools.some((event) => String(event.item.error).includes("Invalid tool arguments")),
  );
});

test("live catalog has no fallback, query/model commands do not generate, and attachments are explicitly rejected", async (t) => {
  const h = await harness(t, () => {
    throw new Error("Generation must not run");
  });
  await h.connection.send({ type: "catalog", requestId: "catalog" });
  const catalog = await h.waitFor((event) => event.type === "catalog");
  assert.deepEqual(
    catalog.catalog.models.map((model) => model.id),
    ["model-a", "model-b"],
  );
  await h.open();
  for (const [clientMessageId, name, args] of [
    ["help", "kiro", ""],
    ["model-command", "kiro-model", "model-b"],
  ]) {
    await h.connection.send({
      type: "session.prompt",
      sessionId: "session",
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "command", name, arguments: args },
      },
    });
    const result = await h.waitFor(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    assert.equal(result.result.type, "completed");
  }
  await h.connection.send({
    type: "session.prompt",
    sessionId: "session",
    prompt: {
      clientMessageId: "attachment",
      delivery: "auto",
      input: {
        type: "message",
        content: [
          {
            type: "uploaded_file",
            id: "file",
            fileName: "x.txt",
            mimeType: "text/plain",
            size: 1,
            path: "/tmp/x",
          },
        ],
      },
    },
  });
  const rejected = await h.waitFor(
    (event) => event.type === "session.prompt_result" && event.clientMessageId === "attachment",
  );
  assert.equal(rejected.result.type, "failed");
  assert.match(rejected.result.error.message, /text only/);
  assert.deepEqual(h.requests, []);
});

test("subprocess cancellation kills the owned process and reports canceled tool snapshots", async (t) => {
  const h = await harness(t, () =>
    toolResponse("run_command", {
      command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('command.pid',String(process.pid));setInterval(()=>{},1000)"`,
    }),
  );
  await h.open();
  const turn = await h.prompt();
  const pidPath = path.join(h.cwd, "command.pid");
  let pid;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      pid = Number(await fs.readFile(pidPath, "utf8"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pid, "real subprocess started");
  await h.connection.send({
    type: "session.interrupt",
    requestId: "interrupt-process",
    sessionId: "session",
  });
  assert.equal((await h.terminal(turn)).state, "canceled");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("catalog errors are surfaced without inventing models", async (t) => {
  const h = await harness(t, () => textResponse("not used"), {
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });
  await h.connection.send({ type: "catalog", requestId: "failed-catalog" });
  const failure = await h.waitFor(
    (event) => event.type === "request.failed" && event.requestId === "failed-catalog",
  );
  assert.match(failure.error.message, /503/);
  assert.equal(h.events.filter((event) => event.type === "catalog").length, 0);
});

test("native read/edit/list/command tools execute against the workspace and retain typed timeline details", async (t) => {
  const h = await harness(t, (body, count) => {
    const result =
      body.conversationState.currentMessage.userInputMessage.userInputMessageContext
        .toolResults?.[0];
    if (count === 1)
      return toolResponse("read_file", { path: "source.txt", offset: 0, limit: 3 }, "read");
    if (count === 2) {
      assert.deepEqual(JSON.parse(result.content[0].text), {
        path: "source.txt",
        offset: 0,
        content: "alp",
        totalCharacters: 10,
        nextOffset: 3,
      });
      return toolResponse(
        "edit_file",
        { path: "source.txt", oldText: "alpha", newText: "gamma" },
        "edit",
      );
    }
    if (count === 3)
      return toolResponse(
        "run_command",
        {
          command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('command-output.txt','actual');console.log('real command ran')"`,
        },
        "command",
      );
    if (count === 4) {
      assert.match(result.content[0].text, /real command ran/);
      return toolResponse("list_directory", { path: "." }, "list");
    }
    assert.match(result.content[0].text, /command-output.txt/);
    return textResponse("Finished real tools");
  });
  await fs.writeFile(path.join(h.cwd, "source.txt"), "alpha beta");
  await h.open();
  assert.equal((await h.terminal(await h.prompt())).state, "completed");
  assert.equal(await fs.readFile(path.join(h.cwd, "source.txt"), "utf8"), "gamma beta");
  assert.equal(await fs.readFile(path.join(h.cwd, "command-output.txt"), "utf8"), "actual");
  for (const type of ["read", "edit", "shell"])
    assert.ok(
      h.events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.status === "completed" &&
          event.item.detail.type === type,
      ),
    );
});

test("a fresh provider connection resumes durable history and native conversation context", async (t) => {
  const h = await harness(t, (body, count) => {
    if (count === 2)
      assert.equal(
        body.conversationState.history[0].userInputMessage.content,
        "persist across connections",
      );
    return textResponse(count === 1 ? "stored assistant response" : "resumed assistant response");
  });
  const opened = await h.open();
  await h.terminal(await h.prompt("persist across connections"));
  await h.connection.close();
  const connection = await h.provider.connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
    launch: {
      command: process.execPath,
      args: [],
      env: { ...process.env, OMP_KIRO_AUTH_FILE: path.join(h.root, "configured.sqlite3") },
    },
  });
  const events = [];
  const errors = [];
  const wait = (predicate) =>
    new Promise((resolve, reject) => {
      const existing = events.find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out restoring durable session"));
      }, 5000);
      const unsubscribe = connection.onEvent((event) => {
        if (predicate(event)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(event);
        }
      });
    });
  connection.onEvent((event) => {
    events.push(event);
    const result = ProviderEventSchema.safeParse(event);
    if (!result.success) errors.push(result.error.message);
  });
  try {
    await connection.send({
      type: "session.open",
      sessionId: "new-core-session",
      requestId: "restore-new-core",
      config: { ...h.config, model: undefined, mode: undefined },
      persistence: opened.persistence,
      history: "replay",
    });
    const ready = await wait(
      (event) =>
        (event.type === "session.ready" || event.type === "request.failed") &&
        event.requestId === "restore-new-core",
    );
    assert.equal(ready.type, "session.ready", ready.error?.message);
    assert.ok(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "assistant_message" &&
          event.item.text === "stored assistant response",
      ),
    );
    await connection.send({
      type: "session.prompt",
      sessionId: "new-core-session",
      prompt: {
        clientMessageId: "restored-prompt",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "continue" }] },
      },
    });
    const result = await wait((event) => event.type === "session.prompt_result");
    assert.equal(result.result.type, "turn");
    const terminal = await wait(
      (event) =>
        event.type === "session.turn" &&
        event.turnId === result.result.turnId &&
        event.state !== "started",
    );
    assert.equal(terminal.state, "completed");
    assert.deepEqual(errors, []);
  } finally {
    await connection.close();
  }
});

test("an invalid model command does not strand the session or prevent the next real turn", async (t) => {
  const h = await harness(t, () => textResponse("session remains usable"));
  await h.open();
  await h.connection.send({
    type: "session.prompt",
    sessionId: "session",
    prompt: {
      clientMessageId: "invalid-model",
      delivery: "auto",
      input: { type: "command", name: "kiro-model", arguments: "nonexistent-model" },
    },
  });
  const result = await h.waitFor(
    (event) => event.type === "session.prompt_result" && event.clientMessageId === "invalid-model",
  );
  assert.equal(result.result.type, "failed");
  assert.equal((await h.terminal(await h.prompt("continue after typo"))).state, "completed");
});

test("a closed MCP stdin becomes an open failure and cleans its child without uncaught EPIPE", async (t) => {
  const h = await harness(t, () => textResponse("not generated"));
  const pidFile = path.join(h.root, "broken-pipe.pid");
  const script = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.stdin.on('error', () => {});
    const reader = require('node:readline').createInterface({input:process.stdin});
    reader.once('line', line => {
      const message = JSON.parse(line);
      reader.close();
      process.stdin.pause();
      fs.closeSync(0);
      fs.writeSync(1, JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'closed-pipe',version:'1'}}})+'\\n');
      setInterval(() => {}, 1000);
    });
  `;
  await h.connection.send({
    type: "session.open",
    sessionId: "broken-pipe",
    requestId: "open-broken-pipe",
    history: "skip",
    config: {
      ...h.config,
      mcpServers: { broken: { type: "stdio", command: process.execPath, args: ["-e", script] } },
    },
  });
  const result = await h.waitFor(
    (event) => event.type === "request.failed" && event.requestId === "open-broken-pipe",
  );
  assert.equal(result.type, "request.failed");
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(h.requests, []);
});

test("query user rows retain optimistic IDs across restoration without entering generation history", async (t) => {
  const h = await harness(t, (body) => {
    assert.deepEqual(body.conversationState.history, []);
    assert.equal(
      body.conversationState.currentMessage.userInputMessage.content,
      "real generation after queries",
    );
    return textResponse("restored context clean");
  });
  const opened = await h.open();
  for (const [id, name, args] of [
    ["query-one", "kiro", ""],
    ["query-two", "kiro-model", "model-b"],
  ]) {
    await h.connection.send({
      type: "session.prompt",
      sessionId: "session",
      prompt: {
        clientMessageId: id,
        delivery: "auto",
        input: { type: "command", name, arguments: args },
      },
    });
    const result = await h.waitFor(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === id,
    );
    assert.equal(result.result.type, "completed");
  }
  const users = (sessionId) =>
    h.events
      .filter(
        (event) =>
          event.type === "timeline.item" &&
          event.sessionId === sessionId &&
          event.item.type === "user_message",
      )
      .map((event) => event.item);
  const before = users("session");
  assert.deepEqual(
    before.map((entry) => entry.messageId),
    ["query-one", "query-two"],
  );
  assert.deepEqual(h.requests, []);
  await h.connection.send({
    type: "session.close",
    requestId: "close-queries",
    sessionId: "session",
  });
  await h.waitFor(
    (event) => event.type === "request.completed" && event.requestId === "close-queries",
  );
  await h.open({ model: undefined, mode: undefined }, opened.persistence, "restored-queries");
  assert.deepEqual(users("restored-queries"), before);
  assert.equal(
    (await h.terminal(await h.prompt("real generation after queries", "restored-queries"))).state,
    "completed",
  );
});

test("native HTTP continues accepted snapshots through a real disconnect without replaying tools", async (t) => {
  const requests = [];
  let brokenResponse;
  const command = (text) =>
    `${JSON.stringify(process.execPath)} -e "require('fs').appendFileSync('retry-count.txt','${text}')"`;
  const server = createServer(async (request, response) => {
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    requests.push(JSON.parse(bytes));
    response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    if (requests.length === 1) {
      response.end(Buffer.concat([
        frame("assistantResponseEvent", { content: "Working" }),
        frame("toolUseEvent", {
          toolUseId: "completed-call", name: "run_command",
          input: JSON.stringify({ command: command("x") }), stop: true,
        }),
      ]));
    } else if (requests.length === 2) {
      brokenResponse = response;
      response.write(Buffer.concat([
        frame("toolUseEvent", {
          toolUseId: "discarded-call", name: "run_command",
          input: JSON.stringify({ command: command("discarded") }), stop: true,
        }),
        frame("toolUseEvent", {
          toolUseId: "fragmented-call", name: "run_command", input: '{"command":',
        }),
        // Seeing this snapshot proves the preceding buffered tool events were decoded.
        frame("assistantResponseEvent", { content: "Accepted prefix " }),
      ]));
    } else if (requests.length === 3) {
      response.end(Buffer.concat([
        frame("assistantResponseEvent", { content: "and recovered" }),
        frame("toolUseEvent", {
          toolUseId: "recovery-call", name: "run_command",
          input: JSON.stringify({ command: command("y") }), stop: true,
        }),
      ]));
    } else {
      response.end(frame("assistantResponseEvent", {
        content: requests.length === 4 ? "Final answer" : "Resumed coherently",
      }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const h = await harness(t, () => {
    throw new Error("Generation must use the real loopback HTTP server");
  }, {
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    fetchImpl: async (_url, init) => {
      if (init.headers["x-amz-target"] === "KiroControlPlaneBearerService.ListAvailableModels")
        return Response.json({ models: [{ modelId: "model-a", modelName: "Model A" }] });
      assert.equal(
        init.headers["x-amz-target"],
        "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      );
      return fetch(`http://127.0.0.1:${server.address().port}/`, init);
    },
  });
  const opened = await h.open();
  const turn = await h.prompt("Run each accepted command once");
  await h.waitFor(
    (event) =>
      event.type === "timeline.item" &&
      event.item.type === "assistant_message" &&
      event.item.text === "Accepted prefix ",
  );
  assert.equal(await fs.readFile(path.join(h.cwd, "retry-count.txt"), "utf8"), "x");
  brokenResponse.destroy();
  assert.equal((await h.terminal(turn)).state, "completed");
  assert.equal(await fs.readFile(path.join(h.cwd, "retry-count.txt"), "utf8"), "xy");
  assert.equal(requests.length, 4);

  const wireMessages = (body) =>
    [...body.conversationState.history, body.conversationState.currentMessage];
  const wireResults = (body) => wireMessages(body).flatMap(
    (message) => message.userInputMessage?.userInputMessageContext?.toolResults ?? [],
  );
  const wireCalls = (body) => wireMessages(body).flatMap(
    (message) => message.assistantResponseMessage?.toolUses ?? [],
  );
  for (const body of requests) {
    assert.equal(body.conversationState.conversationId, requests[0].conversationState.conversationId);
    assert.equal(body.conversationState.currentMessage.userInputMessage.modelId, "model-a");
    assert.equal(body.systemPrompt, requests[0].systemPrompt);
    assert.ok(!JSON.stringify(body).includes("discarded-call"));
    assert.ok(!JSON.stringify(body).includes("fragmented-call"));
  }
  const retry = requests[2];
  assert.equal(
    wireMessages(retry).filter(
      (message) => message.assistantResponseMessage?.content === "Accepted prefix ",
    ).length,
    1,
    "the retry wire carries the already accepted prefix exactly once",
  );
  assert.deepEqual(wireResults(retry).map((result) => result.toolUseId), ["completed-call"]);
  assert.equal(wireResults(retry)[0].status, "success");
  assert.deepEqual(wireCalls(retry).map((call) => call.toolUseId), ["completed-call"]);
  assert.equal(
    retry.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults,
    undefined,
    "completed results move to history instead of being copied into the continuation",
  );
  assert.deepEqual(
    retry.conversationState.history.slice(0, -1),
    requests[1].conversationState.history.concat(requests[1].conversationState.currentMessage),
  );
  assert.deepEqual(
    retry.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools,
    requests[1].conversationState.currentMessage.userInputMessage.userInputMessageContext.tools,
  );
  assert.deepEqual(
    wireResults(requests[3]).map((result) => result.toolUseId),
    ["completed-call", "recovery-call"],
  );

  const snapshots = h.events
    .filter((event) => event.type === "timeline.item" && event.item.type === "assistant_message")
    .map((event) => event.item);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.text),
    ["Working", "Accepted prefix ", "Accepted prefix and recovered", "Final answer"],
  );
  const displayed = new Map();
  for (const snapshot of snapshots) {
    const previous = displayed.get(snapshot.messageId) ?? "";
    assert.ok(snapshot.text.startsWith(previous), "append-only consumers never need a retraction");
    assert.ok(snapshot.text.length > previous.length, "retries emit no empty reset snapshot");
    displayed.set(snapshot.messageId, previous + snapshot.text.slice(previous.length));
  }
  assert.equal(snapshots[1].messageId, snapshots[2].messageId);
  assert.equal(displayed.get(snapshots[1].messageId), "Accepted prefix and recovered");
  assert.equal(
    h.events.filter((event) =>
      event.type === "timeline.item" && event.item.type === "notification" &&
      event.item.id.startsWith("network-retry:"),
    ).length,
    1,
  );
  assert.deepEqual(
    h.events.filter((event) =>
      event.type === "timeline.item" && event.item.type === "tool_call" &&
      event.item.status === "completed",
    ).map((event) => event.item.callId),
    ["completed-call", "recovery-call"],
  );
  assert.equal(
    h.events.filter((event) =>
      event.type === "session.turn" && event.turnId === turn && event.state !== "started",
    ).length,
    1,
  );
  const key = opened.persistence.data.nativeSessionId;
  const saved = JSON.parse(await fs.readFile(path.join(h.root, "state", `${key}.json`), "utf8"));
  assert.equal(saved.model, "model-a");
  assert.deepEqual(
    saved.messages.filter((message) => message.role === "assistant")
      .flatMap((message) => message.content.filter((part) => part.type === "text"))
      .map((part) => part.text),
    ["Working", "Accepted prefix and recovered", "Final answer"],
  );
  assert.deepEqual(
    saved.messages.filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId),
    ["completed-call", "recovery-call"],
  );
  assert.ok(!JSON.stringify(saved).includes("discarded-call"));
  assert.ok(!JSON.stringify(saved).includes("fragmented-call"));
  assert.ok(!JSON.stringify(saved).includes("Continue your response exactly"));
  assert.deepEqual(
    saved.timeline.filter((entry) => entry.type === "assistant_message")
      .map((entry) => [entry.messageId, entry.text]),
    [...displayed],
  );
  await h.connection.send({
    type: "session.close", requestId: "close-recovered-session", sessionId: "session",
  });
  await h.waitFor((event) =>
    event.type === "request.completed" && event.requestId === "close-recovered-session",
  );
  await h.open({ model: undefined, mode: undefined }, opened.persistence, "restored-recovery");
  assert.deepEqual(
    h.events.filter((event) =>
      event.type === "timeline.item" && event.sessionId === "restored-recovery" &&
      event.item.type === "assistant_message",
    ).map((event) => [event.item.messageId, event.item.text]),
    [...displayed],
  );
  assert.equal(
    (await h.terminal(await h.prompt("Continue after reconnect", "restored-recovery"))).state,
    "completed",
  );
  assert.equal(requests.length, 5);
  const restored = requests[4];
  assert.equal(restored.conversationState.conversationId, requests[0].conversationState.conversationId);
  assert.equal(restored.conversationState.currentMessage.userInputMessage.modelId, "model-a");
  assert.deepEqual(
    wireResults(restored).map((result) => result.toolUseId),
    ["completed-call", "recovery-call"],
  );
  assert.deepEqual(
    wireMessages(restored).flatMap((message) =>
      message.assistantResponseMessage ? [message.assistantResponseMessage.content] : [],
    ),
    ["Working", "Accepted prefix and recovered", "Final answer"],
  );
  assert.equal(await fs.readFile(path.join(h.cwd, "retry-count.txt"), "utf8"), "xy");
});

test("Paseo plan mode executes managed Kiro search and returns source attribution to the model", async (t) => {
  const result = { results: [{ title: "Kiro docs", url: "https://kiro.dev/docs/", snippet: "Public documentation", maxVerbatimWordLimit: 30 }] };
  const h = await harness(t, (body) => {
    if (body.method === "tools/call") {
      assert.equal(body.params.name, "web_search");
      assert.equal(body.params.arguments.query, "Kiro documentation");
      return Response.json({
        jsonrpc: "2.0", id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      });
    }
    const returned = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults;
    if (returned?.length) {
      assert.equal(returned[0].status, "success");
      assert.deepEqual(JSON.parse(returned[0].content[0].text), result);
      return textResponse("Found the original documentation source");
    }
    return toolResponse("web_search", { query: "Kiro documentation" }, "search-one");
  });
  await h.open({ mode: "plan" });
  assert.equal((await h.terminal(await h.prompt("Search Kiro documentation"))).state, "completed");
  assert.equal(h.requests.filter((body) => body.method === "tools/call").length, 1);
  assert.equal(h.events.filter((event) => event.type === "session.permission").length, 0);
  assert.ok(h.events.some((event) =>
    event.type === "timeline.item" && event.item.type === "tool_call" &&
    event.item.callId === "search-one" && event.item.status === "completed"));
});
