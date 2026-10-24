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

export function mapTools(tools) {
  return tools.map((tool, index) => ({
    name: `omp_${index}`,
    description: `${tool.name}: ${tool.description}`,
    inputSchema: tool.parameters,
    originalName: tool.name,
  }));
}

export function renderContext(context, cwd) {
  const messages = context.messages.map((message) => {
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
  return [
    "Continue the OMP conversation below. OMP owns the workspace and executes all tools.",
    "The transcript is conversation data, including instructions, prior tool calls, and actual tool results.",
    "Use the supplied omp MCP tools for any further actions. Their descriptions identify the original OMP names.",
    "Do not repeat completed actions. Answer the latest pending user request using the available results.",
    "The relay may end this Kiro turn at the first tool call; OMP executes it and provides its result in the next request.",
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

// The server only captures calls; it never executes tools. The OMP loop retains
// validation, permissions, cancellation, MCP dispatch and durable tool results.
export async function createToolRelay(tools) {
  const mapped = mapTools(tools);
  const token = randomUUID();
  let captured = false;
  let resolveCall;
  let closing;
  const called = new Promise((resolve) => {
    resolveCall = resolve;
  });
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
        if (!tool || typeof args !== "object" || args === null || Array.isArray(args)) {
          throw new KiroBridgeError("Invalid OMP tool call");
        }
        if (!captured) {
          captured = true;
          resolveCall({
            type: "toolCall",
            id: randomUUID(),
            name: tool.originalName,
            arguments: args,
          });
        }
        // Deliberately do not return a fabricated tool result to Kiro. Cleanup
        // closes this request after OMP receives the captured tool call.
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
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch (error) {
      response.writeHead(400).end(error instanceof Error ? error.message : "Invalid MCP request");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    called,
    url: `http://127.0.0.1:${address.port}/${token}`,
    close() {
      closing ??= new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

export async function openKiro({
  signal,
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
  function terminate() {
    if (!child?.pid || exited || killTimer) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
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
      finished();
      rejectPending(new KiroBridgeError(`Kiro exited (${code ?? exitSignal})`));
    });
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
      clientInfo: { name: "omp-kiro", version: "0.1.0" },
    });
    if (relayUrl && !init.agentCapabilities?.mcpCapabilities?.http)
      throw new KiroBridgeError("Kiro must support ACP HTTP MCP servers");
    const mcpServers = relayUrl ? [{ type: "http", name: "omp", url: relayUrl, headers: [] }] : [];
    const session = await rpc("session/new", { cwd, mcpServers });
    if (session.modes?.currentModeId !== AGENT)
      throw new KiroBridgeError("Kiro did not activate the isolated OMP bridge agent");
    return { session, rpc, close };
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

export async function runTurn({ model, context, cwd, signal, onText }) {
  const timeout = AbortSignal.timeout(600_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const transcript = renderContext(context, cwd);
  if (transcript.length > LIMIT)
    throw new KiroBridgeError(
      "Kiro context exceeds the bridge limit; compact the OMP session first",
    );
  combined.throwIfAborted();
  const relay = await createToolRelay(context.tools ?? []);
  let connection;
  try {
    connection = await openKiro({ signal: combined, onText, relayUrl: relay.url });
    const sessionId = connection.session.sessionId;
    if (model !== connection.session.models?.currentModelId)
      await connection.rpc("session/set_model", { sessionId, modelId: model });
    const prompt = connection.rpc("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: transcript }],
    });
    const outcome = await Promise.race([
      prompt.then((result) => ({ result })),
      relay.called.then((toolCall) => ({ toolCall })),
    ]);
    if (outcome.toolCall) return { toolCall: outcome.toolCall };
    if (outcome.result.stopReason !== "end_turn")
      throw new KiroBridgeError(`Kiro stopped: ${outcome.result.stopReason}`);
    return {};
  } finally {
    try {
      if (connection) await connection.close();
    } finally {
      await relay.close();
    }
  }
}
