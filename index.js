import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { closeSession, discoverModels, runTurn } from "./server/bridge.mjs";
import { discoverHttpModels, runHttpTurn } from "./server/http.mjs";
import { registerKiroCommands } from "./server/commands.mjs";
import { isTransientNetworkError, isTlsError } from "./server/network.mjs";
import { registerKiroWebSearch } from "./server/web.mjs";

function streamKiro(model, context, options = {}, transport) {
  const stream = new AssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    // Missing upstream usage is unknown, not a claim of free requests.
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  async function run() {
    let text;
    stream.push({ type: "start", partial: message });
    try {
      const runTransport = transport === "http" ? runHttpTurn : runTurn;
      const outcome = await runTransport({
        model: model.id,
        context,
        cwd: options.cwd ?? process.cwd(),
        signal: options.signal,
        sessionId: options.sessionId,
        ...(transport === "http" ? { retry: { maxAttempts: 1 } } : {}),
        onText(delta) {
          if (!delta) return;
          if (!text) {
            text = { type: "text", text: "" };
            message.content.push(text);
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
          }
          text.text += delta;
          stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
        },
      });
      options.signal?.throwIfAborted();
      if (text)
        stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
      const toolCalls = outcome.toolCalls ?? (outcome.toolCall ? [outcome.toolCall] : []);
      for (const toolCall of toolCalls) {
        const contentIndex = message.content.length;
        message.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({
          type: "toolcall_delta",
          contentIndex,
          delta: JSON.stringify(toolCall.arguments),
          partial: message,
        });
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
      }
      if (outcome.usage) message.usage = outcome.usage;
      message.stopReason = toolCalls.length ? "toolUse" : (outcome.stopReason ?? "stop");
      stream.push({ type: "done", reason: message.stopReason, message });
    } catch (error) {
      message.stopReason = options.signal?.aborted ? "aborted" : "error";
      // OMP owns generation recovery (including committed-text continuation).
      // Preserve its recognized transient class without exposing URLs or credentials.
      message.errorMessage =
        transport === "http" && !options.signal?.aborted && isTransientNetworkError(error)
          ? "Kiro HTTP network error: The socket connection was closed unexpectedly before the response completed."
          : transport === "http" && isTlsError(error)
            ? "Kiro TLS certificate verification failed; check the approved CA configuration."
            : error instanceof Error
              ? error.message
              : String(error);
      if (transport === "http" && Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0)
        message.errorMessage += ` retry-after-ms=${Math.ceil(error.retryAfterMs)}`;
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      stream.end();
    }
  }
  void run();
  return stream;
}

export default function kiroExtension(pi) {
  const transport = process.env.OMP_KIRO_TRANSPORT || "acp";
  if (transport !== "acp" && transport !== "http") {
    throw new Error("OMP_KIRO_TRANSPORT must be acp or http");
  }
  pi.on("session_shutdown", (_event, ctx) => closeSession(ctx.sessionManager.getSessionId()));
  pi.on("agent_end", (event, ctx) => {
    const assistant = event.messages.findLast((message) => message.role === "assistant");
    if (assistant?.stopReason === "aborted") {
      return closeSession(ctx.sessionManager.getSessionId());
    }
  });
  pi.on("session_before_switch", (_event, ctx) => closeSession(ctx.sessionManager.getSessionId()));
  const provider = transport === "http" ? "kiro-http" : "kiro-cli";
  pi.registerProvider(provider, {
    baseUrl: "https://kiro-cli.invalid/",
    apiKey: "kiro-cli-managed-auth",
    api: `kiro-cli-${transport}`,
    streamSimple: (model, context, options) => streamKiro(model, context, options, transport),
    async fetchDynamicModels() {
      const models = await (transport === "http" ? discoverHttpModels() : discoverModels());
      return models.map(({ id, name, contextWindow, maxTokens }) => ({
        id,
        name: `Kiro · ${name}`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // ACP omits numeric limits; HTTP uses advertised limits when supplied.
        contextWindow: contextWindow ?? 128000,
        maxTokens: maxTokens ?? 16000,
      }));
    },
  });
  if (transport === "http") registerKiroWebSearch(pi);
  registerKiroCommands(pi, { transport });
}
