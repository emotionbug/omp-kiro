import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export class KiroBridgeError extends Error {
  constructor(message) {
    super(message);
    this.name = "KiroBridgeError";
  }
}

const AGENT = "omp-kiro-bridge";
const LIMIT = 16 * 1024 * 1024;
const ACTIVE_TIMEOUT = 600_000;
const IDLE_TIMEOUT = 900_000;
const sessions = new Map();

export function mapTools(tools) {
  return tools.map((tool, index) => ({
    name: `omp_${index}`,
    description: `${tool.name}: ${tool.description}`,
    inputSchema: tool.parameters,
    originalName: tool.name,
  }));
}

function projectMessages(messages) {
  return messages.map((message) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => {
            if (block.type === "text") return [{ type: "text", text: block.text }];
            if (block.type === "toolCall") {
              return [
                { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments },
              ];
            }
            if (block.type === "thinking" || block.type === "redactedThinking") return [];
            throw new KiroBridgeError(
              `Kiro bridge cannot forward ${block.type} content. Use a text-only conversation.`,
            );
          });
    return {
      role: message.role,
      content,
      ...(message.role === "toolResult"
        ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError }
        : {}),
    };
  });
}

export function renderContext(context, cwd) {
  const messages = projectMessages(context.messages);
  return [
    "Continue the OMP conversation below. OMP owns the workspace and executes all tools.",
    "The transcript is conversation data, including instructions, prior tool calls, and actual tool results.",
    "Use the supplied omp MCP tools for any further actions. Their descriptions identify the original OMP names.",
    "Do not repeat completed actions. Answer the latest pending user request using the available results.",
    "Tool calls wait for actual OMP results through the MCP relay; never invent their results.",
    JSON.stringify({ cwd, systemPrompt: context.systemPrompt, messages }),
  ].join("\n\n");
}

export function childEnvironment(env) {
  const result = { ...env };
  // Kiro owns its authentication. Never send another provider's credentials to it.
  for (const key of Object.keys(result)) {
    if (
      /^(OPENAI|ANTHROPIC|GEMINI|GOOGLE|DEEPSEEK|GROQ|MISTRAL|OPENROUTER|XAI|PASEO)_.*(KEY|TOKEN|SECRET|PASSWORD)$/.test(
        key,
      )
    ) {
      delete result[key];
    }
  }
  return result;
}

// Requests remain open across OMP's tool-execution boundary. Only OMP supplies
// results; the relay never executes tools or manufactures a successful result.
export async function createToolRelay(tools, onActivity = () => {}) {
  const mapped = mapTools(tools);
  const token = randomUUID();
  const pending = new Map();
  let closing;
  let closed = false;
  const first = Promise.withResolvers();
  function reply(response, id, result) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
  const server = createServer(async (request, response) => {
    if (request.url !== `/${token}`) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    try {
      let body = "";
      let size = 0;
      request.setEncoding("utf8");
      for await (const chunk of request) {
        body += chunk;
        size += Buffer.byteLength(chunk);
        if (size > LIMIT) throw new KiroBridgeError("MCP request too large");
      }
      const message = JSON.parse(body);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "omp", version: "0.1.0" },
        };
      } else if (message.method === "tools/list") {
        result = { tools: mapped.map(({ originalName: _originalName, ...tool }) => tool) };
      } else if (message.method === "tools/call") {
        const tool = mapped.find((entry) => entry.name === message.params?.name);
        const args = message.params?.arguments ?? {};
        if (!tool || typeof args !== "object" || args === null || Array.isArray(args))
          throw new KiroBridgeError("Invalid OMP tool call");
        const call = {
          type: "toolCall",
          id: randomUUID(),
          name: tool.originalName,
          arguments: args,
        };
        const entry = { call, response, rpcId: message.id, delivered: false };
        pending.set(call.id, entry);
        response.once("close", () => {
          if (!closed && pending.get(call.id) === entry)
            onActivity(new KiroBridgeError("Kiro disconnected while awaiting an OMP tool result"));
        });
        first.resolve(call);
        onActivity();
        return;
      } else if (message.method === "ping") {
        result = {};
      } else {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not supported" },
          }),
        );
        return;
      }
      reply(response, message.id, result);
    } catch (error) {
      response.writeHead(400).end(error instanceof Error ? error.message : "Invalid MCP request");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    called: first.promise,
    pending,
    url: `http://127.0.0.1:${server.address().port}/${token}`,
    takeCalls() {
      const calls = [];
      for (const entry of pending.values()) {
        if (!entry.delivered) {
          entry.delivered = true;
          calls.push(entry.call);
        }
      }
      return calls;
    },
    respond(message) {
      const entry = pending.get(message.toolCallId);
      if (!entry?.delivered || entry.call.name !== message.toolName)
        throw new KiroBridgeError("OMP tool result does not match a waiting Kiro tool call");
      const content =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content;
      if (!Array.isArray(content) || content.some((block) => block.type !== "text"))
        throw new KiroBridgeError("Kiro bridge requires text-only OMP tool results");
      pending.delete(entry.call.id);
      reply(entry.response, entry.rpcId, { content, isError: Boolean(message.isError) });
    },
    close() {
      closing ??= new Promise((resolve) => {
        closed = true;
        pending.clear();
        server.close(resolve);
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

export async function openKiro({
  signal = new AbortController().signal,
  onText = () => {},
  relayUrl,
  command = process.env.OMP_KIRO_COMMAND || "kiro-cli",
}) {
  signal.throwIfAborted();
  // An isolated cwd prevents Kiro from loading workspace hooks, steering, MCP
  // servers, or agent overrides. It sees the real cwd only through OMP context.
  const cwd = await mkdtemp(join(tmpdir(), "omp-kiro-"));
  let child;
  let lines;
  let processEnded;
  let exited = false;
  let killTimer;
  let closing;
  const pending = new Map();
  let nextId = 0;
  let ended = false;
  function rejectPending(error) {
    ended = true;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }
  function killChild(exitSignal) {
    try {
      if (process.platform === "win32") child.kill(exitSignal);
      else process.kill(-child.pid, exitSignal);
    } catch (error) {
      if (error.code !== "ESRCH") rejectPending(error);
    }
  }
  function terminate() {
    if (!child?.pid || exited || killTimer) return;
    killChild("SIGTERM");
    killTimer = setTimeout(() => killChild("SIGKILL"), 1000);
  }
  function abort() {
    rejectPending(signal.reason);
    terminate();
  }
  function close() {
    closing ??= (async () => {
      signal.removeEventListener("abort", abort);
      rejectPending(new KiroBridgeError("Kiro connection closed"));
      lines?.close();
      terminate();
      // A failed spawn emits error/close, not exit. Track it from spawn time,
      // before any request can fail or cancellation can race teardown.
      await processEnded;
      clearTimeout(killTimer);
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      await rm(cwd, { recursive: true, force: true });
    })();
    return closing;
  }
  function send(message) {
    if (!ended) child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function rpc(method, params) {
    signal.throwIfAborted();
    if (ended) return Promise.reject(new KiroBridgeError("Kiro process is no longer running"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }
  try {
    await mkdir(join(cwd, ".kiro", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".kiro", "agents", `${AGENT}.json`),
      JSON.stringify({
        name: AGENT,
        description: "Kiro model transport for OMP; all tools execute in OMP",
        prompt:
          "Continue the supplied OMP conversation. Use only the omp MCP relay tools. OMP handles all workspace actions.",
        tools: ["@omp"],
        allowedTools: ["@omp"],
        mcpServers: {},
        resources: [],
        includeMcpJson: false,
      }),
    );
    signal.throwIfAborted();
    child = spawn(command, ["acp", "--agent-engine", "v2", "--agent", AGENT], {
      cwd,
      env: childEnvironment(process.env),
      // The launcher can own a kiro-cli-chat descendant; terminate that whole
      // private process group rather than leaving its ACP process behind.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.resume();
    const lifecycle = Promise.withResolvers();
    processEnded = lifecycle.promise;
    function finished() {
      if (exited) return;
      exited = true;
      clearTimeout(killTimer);
      lifecycle.resolve();
    }
    child.on("error", (error) => {
      rejectPending(error);
      if (!child.pid) finished();
    });
    child.once("exit", (code, exitSignal) => {
      // Wait for close as well as exit: descendants can retain ACP pipe ends.
      rejectPending(new KiroBridgeError(`Kiro exited (${code ?? exitSignal})`));
    });
    child.once("close", finished);
    child.stdin.on("error", rejectPending);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    lines = createInterface({ input: child.stdout });
    lines.on("close", () => {
      if (!ended) {
        rejectPending(new KiroBridgeError("Kiro closed its ACP output"));
        terminate();
      }
    });
    lines.on("line", (line) => {
      if (ended) return;
      try {
        if (line.length > LIMIT) throw new KiroBridgeError("Kiro response too large");
        const message = JSON.parse(line);
        if (message.method === undefined && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (message.error)
            entry.reject(
              new KiroBridgeError(
                `${message.error.message}: ${JSON.stringify(message.error.data ?? "")}`,
              ),
            );
          else entry.resolve(message.result);
        } else if (message.method === "session/update") {
          const update = message.params.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
            onText(update.content.text);
        } else if (message.id !== undefined) {
          // Kiro must never execute native tools, read the workspace, or create
          // terminals through ACP. Only the private MCP relay is authorized.
          const reply =
            message.method === "session/request_permission"
              ? { result: { outcome: { outcome: "cancelled" } } }
              : { error: { code: -32601, message: "OMP owns tools and filesystem access" } };
          send({ jsonrpc: "2.0", id: message.id, ...reply });
        }
      } catch (error) {
        rejectPending(error);
        terminate();
      }
    });
    const init = await rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "omp-kiro", version: "0.2.0" },
    });
    if (relayUrl && !init.agentCapabilities?.mcpCapabilities?.http)
      throw new KiroBridgeError("Kiro must support ACP HTTP MCP servers");
    const mcpServers = relayUrl ? [{ type: "http", name: "omp", url: relayUrl, headers: [] }] : [];
    const session = await rpc("session/new", { cwd, mcpServers });
    if (session.modes?.currentModeId !== AGENT)
      throw new KiroBridgeError("Kiro did not activate the isolated OMP bridge agent");
    return {
      session,
      initialize: init,
      rpc,
      close,
      get closed() {
        return ended;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function discoverModels() {
  const connection = await openKiro({ signal: AbortSignal.timeout(12_000) });
  try {
    const models = connection.session.models?.availableModels;
    if (!Array.isArray(models)) throw new KiroBridgeError("Kiro returned no model catalog");
    return models.map((model) => {
      if (typeof model.modelId !== "string" || typeof model.name !== "string")
        throw new KiroBridgeError("Invalid Kiro model catalog");
      return { id: model.modelId, name: model.name };
    });
  } finally {
    await connection.close();
  }
}

function stableJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, item[key]]),
    );
  });
}

function messageKeys(messages) {
  return projectMessages(messages).map((message) => {
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    const content = [];
    for (const block of blocks) {
      if (block.type === "text") {
        if (!block.text) continue;
        if (content.at(-1)?.type === "text") content.at(-1).text += block.text;
        else content.push({ type: "text", text: block.text });
      } else content.push(block);
    }
    return stableJson({
      ...message,
      content,
      ...(message.role === "toolResult" ? { isError: Boolean(message.isError) } : {}),
    });
  });
}

function pulse(state, error) {
  if (error) state.failure ??= error;
  state.changed.resolve();
  state.changed = Promise.withResolvers();
}

function createSessionState(config, tools) {
  const state = {
    config,
    controller: new AbortController(),
    changed: Promise.withResolvers(),
    prefix: [],
    buffered: [],
    bufferedSize: 0,
    activeText: undefined,
  };
  state.ready = (async () => {
    state.relay = await createToolRelay(tools, (error) => pulse(state, error));
    state.controller.signal.throwIfAborted();
    state.connection = await openKiro({
      signal: state.controller.signal,
      relayUrl: state.relay.url,
      onText(text) {
        if (state.activeText) state.activeText(text);
        else {
          state.bufferedSize += Buffer.byteLength(text);
          if (state.bufferedSize > LIMIT)
            throw new KiroBridgeError("Kiro buffered response exceeds the bridge limit");
          state.buffered.push(text);
        }
      },
    });
  })();
  // An inactive process may fail while OMP is executing a tool. Retain the
  // failure for the next caller without an unhandled promise rejection.
  state.ready.catch((error) => pulse(state, error));
  return state;
}

function disposeState(state, reason = new KiroBridgeError("Kiro session closed")) {
  if (!state) return Promise.resolve();
  state.closing ??= (async () => {
    state.controller.abort(reason);
    pulse(state, reason);
    await Promise.all([
      state.relay?.close(),
      state.connection?.close(),
      state.ready.catch(() => {}),
    ]);
    // Initialization can publish its connection after teardown began.
    await Promise.all([state.connection?.close(), state.relay?.close()]);
    state.activeText = undefined;
    state.buffered = [];
  })();
  return state.closing;
}

function hasPrefix(prefix, messages) {
  return (
    prefix.length <= messages.length &&
    prefix.every((message, index) => message === messages[index])
  );
}

async function awaitOutcome(state, signal) {
  while (true) {
    signal.throwIfAborted();
    if (state.failure) throw state.failure;
    if ([...state.relay.pending.values()].some((entry) => !entry.delivered)) {
      // Collect parallel HTTP requests already arriving in this event-loop turn.
      // Later arrivals remain queued and are returned by the next invocation.
      await new Promise((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
      if (state.failure) throw state.failure;
      return { toolCalls: state.relay.takeCalls() };
    }
    if (state.prompt?.done) {
      const { result, error } = state.prompt;
      if (error) throw error;
      if (state.relay.pending.size)
        throw new KiroBridgeError("Kiro ended its prompt before receiving OMP tool results");
      if (result.stopReason !== "end_turn")
        throw new KiroBridgeError(`Kiro stopped: ${result.stopReason}`);
      state.prompt = undefined;
      return {};
    }
    await state.changed.promise;
  }
}

async function activeTurn(slot, { model, context, cwd, signal, onText = () => {} }) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Kiro request timed out", "TimeoutError")),
    ACTIVE_TIMEOUT,
  );
  timeout.unref();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let state;
  let emitted = "";
  function abort() {
    if (state) {
      state.controller.abort(combined.reason);
      pulse(state, combined.reason);
    }
  }
  try {
    combined.throwIfAborted();
    const keys = messageKeys(context.messages);
    const config = stableJson({
      model,
      cwd,
      systemPrompt: context.systemPrompt,
      tools: mapTools(context.tools ?? []).map(({ originalName: _originalName, ...tool }) => tool),
      command: process.env.OMP_KIRO_COMMAND || "kiro-cli",
    });
    state = slot.state;
    if (
      state &&
      (state.config !== config ||
        !hasPrefix(state.prefix, keys) ||
        state.closing ||
        state.failure ||
        state.connection?.closed)
    ) {
      await disposeState(state);
      state = slot.state = undefined;
      combined.throwIfAborted();
    }
    if (!state) state = slot.state = createSessionState(config, context.tools ?? []);
    state.activeText = (text) => {
      emitted += text;
      onText(text);
    };
    combined.addEventListener("abort", abort, { once: true });
    if (combined.aborted) abort();
    const buffered = state.buffered;
    state.buffered = [];
    state.bufferedSize = 0;
    for (const text of buffered) {
      combined.throwIfAborted();
      state.activeText(text);
    }
    await state.ready;
    combined.throwIfAborted();
    const connection = state.connection;
    const kiroSessionId = connection.session.sessionId;
    if (!state.started) {
      if (model !== connection.session.models?.currentModelId)
        await connection.rpc("session/set_model", { sessionId: kiroSessionId, modelId: model });
    }
    if (state.prompt) {
      const additions = projectMessages(context.messages.slice(state.prefix.length));
      const waiting = [...state.relay.pending.values()].filter((entry) => entry.delivered);
      const results = new Map(additions.map((message) => [message.toolCallId, message]));
      if (
        additions.some((message) => message.role !== "toolResult") ||
        results.size !== additions.length ||
        additions.length !== waiting.length ||
        waiting.some((entry) => results.get(entry.call.id)?.toolName !== entry.call.name)
      ) {
        throw new KiroBridgeError(
          "Continue the Kiro session with the actual matching results for all returned OMP tool calls",
        );
      }
      // Validate the complete handoff before answering any request.
      for (const message of additions) state.relay.respond(message);
    } else {
      const promptText = state.started
        ? "Continue with only these new OMP messages; the preceding conversation is already in this session.\n\n" +
          JSON.stringify({ messages: projectMessages(context.messages.slice(state.prefix.length)) })
        : renderContext(context, cwd);
      if (Buffer.byteLength(promptText) > LIMIT)
        throw new KiroBridgeError(
          "Kiro context exceeds the bridge limit; compact the OMP session first",
        );
      if (state.started && keys.length === state.prefix.length)
        throw new KiroBridgeError("No new OMP messages to send to the Kiro session");
      state.started = true;
      const prompt = {};
      state.prompt = prompt;
      connection
        .rpc("session/prompt", {
          sessionId: kiroSessionId,
          prompt: [{ type: "text", text: promptText }],
        })
        .then(
          (result) => {
            Object.assign(prompt, { done: true, result });
            pulse(state);
          },
          (error) => {
            Object.assign(prompt, { done: true, error });
            pulse(state);
          },
        );
    }
    state.prefix = keys;
    const outcome = await awaitOutcome(state, combined);
    const content = [
      ...(emitted ? [{ type: "text", text: emitted }] : []),
      ...(outcome.toolCalls ?? []),
    ];
    state.prefix = [...keys, ...messageKeys([{ role: "assistant", content }])];
    return outcome;
  } catch (error) {
    await disposeState(state, combined.aborted ? combined.reason : error);
    if (slot.state === state) slot.state = undefined;
    throw combined.aborted ? combined.reason : error;
  } finally {
    clearTimeout(timeout);
    combined.removeEventListener("abort", abort);
    if (state) state.activeText = undefined;
  }
}

async function closeSlot(slot) {
  slot.closed = true;
  clearTimeout(slot.idleTimer);
  if (sessions.get(slot.id) === slot) sessions.delete(slot.id);
  await disposeState(slot.state);
  await slot.tail;
}

export async function closeSession(sessionId) {
  const slot = sessions.get(sessionId);
  if (slot) await closeSlot(slot);
}

export async function closeAllSessions() {
  await Promise.all([...sessions.values()].map(closeSlot));
}

export async function runTurn(options) {
  options.signal?.throwIfAborted();
  const persistent = typeof options.sessionId === "string" && options.sessionId.length > 0;
  let slot = persistent ? sessions.get(options.sessionId) : undefined;
  if (!slot) {
    slot = { id: options.sessionId, tail: Promise.resolve(), closed: false };
    if (persistent) sessions.set(options.sessionId, slot);
  }
  const queuedAbort = Promise.withResolvers();
  let started = false;
  const abortQueued = () => {
    if (!started) queuedAbort.reject(options.signal.reason);
  };
  options.signal?.addEventListener("abort", abortQueued, { once: true });
  const operation = slot.tail.then(async () => {
    started = true;
    options.signal?.throwIfAborted();
    if (slot.closed) throw new KiroBridgeError("Kiro session closed");
    clearTimeout(slot.idleTimer);
    try {
      return await activeTurn(slot, options);
    } finally {
      if (!persistent) await disposeState(slot.state);
      else if (!slot.closed) {
        slot.idleTimer = setTimeout(() => {
          void closeSlot(slot);
        }, IDLE_TIMEOUT);
        slot.idleTimer.unref();
      }
    }
  });
  slot.tail = operation.catch(() => {});
  try {
    return await Promise.race([operation, queuedAbort.promise]);
  } finally {
    options.signal?.removeEventListener("abort", abortQueued);
  }
}
