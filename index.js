import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { discoverModels, runTurn } from "./bridge.mjs";

function streamKiro(model, context, options = {}) {
  const stream = new AssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    // ACP supplies no token/cost accounting. These required fields are not a
    // claim of free usage; Kiro's subscription and quota remain authoritative.
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
      const { toolCall } = await runTurn({
        model: model.id,
        context,
        cwd: options.cwd ?? process.cwd(),
        signal: options.signal,
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
      if (toolCall) {
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
        message.stopReason = "toolUse";
      }
      stream.push({ type: "done", reason: message.stopReason, message });
    } catch (error) {
      message.stopReason = options.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      stream.end();
    }
  }
  void run();
  return stream;
}

export default function kiroExtension(pi) {
  pi.registerProvider("kiro-cli", {
    baseUrl: "https://kiro-cli.invalid/",
    apiKey: "kiro-cli-managed-auth",
    api: "kiro-cli-acp",
    streamSimple: streamKiro,
    async fetchDynamicModels() {
      const models = await discoverModels();
      return models.map(({ id, name }) => ({
        id,
        name: `Kiro · ${name}`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // ACP advertises model IDs but no numeric context/output limits. Use
        // conservative OMP planning limits rather than infer them from names.
        contextWindow: 128000,
        maxTokens: 16000,
      }));
    },
  });
}
