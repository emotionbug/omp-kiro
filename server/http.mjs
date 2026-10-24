import { createHash, randomUUID } from "node:crypto";
import { loadKiroAuth } from "./auth.mjs";
import { decodeEventStream } from "./eventstream.mjs";

export class KiroHttpError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "KiroHttpError";
    this.status = status;
    this.code = code;
  }
}

function endpointFor(auth, service = "runtime") {
  const region = auth.profile_arn?.split(":")[3] || "us-east-1";
  if (region === "us-east-1" || region === "eu-central-1")
    return `https://${service}.${region}.kiro.dev/`;
  throw new KiroHttpError("Kiro HTTP transport does not support this account profile region.");
}

function textContent(message) {
  if (typeof message.content === "string") return message.content;
  const text = [];
  for (const block of message.content ?? []) {
    if (block.type === "text") text.push(block.text);
    else if (!["toolCall", "thinking", "redactedThinking"].includes(block.type)) {
      throw new KiroHttpError(
        `Kiro HTTP transport cannot forward ${block.type} content; only text and tool calls are supported.`,
      );
    }
  }
  return text.join("\n");
}

function conversationId(sessionId) {
  if (!sessionId) return randomUUID();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId))
    return sessionId;
  // Stable RFC 4122 UUIDv5 in the DNS namespace for arbitrary OMP session IDs.
  const hash = createHash("sha1")
    .update(Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"))
    .update(`omp-kiro:${sessionId}`)
    .digest();
  hash[6] = (hash[6] & 15) | 0x50;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildHttpRequest({ model, context, cwd, sessionId }) {
  const messages = [];
  const instructions = [];
  const systemPrompt = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.join("\n\n")
    : context.systemPrompt;
  if (systemPrompt) instructions.push(`[System instructions]\n${systemPrompt}`);
  const userMessage = (content = "") => ({ content, modelId: model, origin: "KIRO_CLI" });
  for (const [index, message] of context.messages.entries()) {
    const content = textContent(message);
    if (message.role === "developer") {
      // This service has no developer history variant; retain its priority and
      // original position explicitly in the native instruction channel.
      instructions.push(
        `[Developer instructions at conversation message ${index + 1}]\n${content}`,
      );
    } else if (message.role === "user") {
      const previous = messages.at(-1)?.userInputMessage;
      if (previous) previous.content += `${previous.content && content ? "\n\n" : ""}${content}`;
      else messages.push({ userInputMessage: userMessage(content) });
    } else if (message.role === "assistant") {
      const toolUses =
        typeof message.content === "string"
          ? []
          : (message.content ?? [])
              .filter((block) => block.type === "toolCall")
              .map((block) => ({ toolUseId: block.id, name: block.name, input: block.arguments }));
      const previous = messages.at(-1)?.assistantResponseMessage;
      if (previous) {
        previous.content += `${previous.content && content ? "\n\n" : ""}${content}`;
        if (toolUses.length) previous.toolUses = [...(previous.toolUses ?? []), ...toolUses];
      } else {
        messages.push({
          assistantResponseMessage: { content, ...(toolUses.length ? { toolUses } : {}) },
        });
      }
    } else if (message.role === "toolResult") {
      let previous = messages.at(-1)?.userInputMessage;
      if (!previous) {
        previous = userMessage();
        messages.push({ userInputMessage: previous });
      }
      previous.userInputMessageContext ??= {};
      previous.userInputMessageContext.toolResults ??= [];
      previous.userInputMessageContext.toolResults.push({
        toolUseId: message.toolCallId,
        content: [{ text: content }],
        status: message.isError ? "error" : "success",
      });
    } else {
      throw new KiroHttpError(`Unsupported Kiro HTTP message role: ${message.role}`);
    }
  }
  const currentMessage = messages.pop();
  if (!currentMessage?.userInputMessage)
    throw new KiroHttpError("Kiro HTTP turn must end with a user message or actual tool results.");
  const current = currentMessage.userInputMessage;
  current.userInputMessageContext ??= {};
  if (context.tools?.length) {
    current.userInputMessageContext.tools = context.tools.map((tool) => ({
      toolSpecification: {
        name: tool.name,
        description: tool.description,
        inputSchema: { json: tool.parameters },
      },
    }));
  }
  if (cwd) {
    current.userInputMessageContext.additionalContext = [
      {
        name: "workspace",
        description: "The working directory; the host executes requested tools.",
        innerContext: cwd,
      },
    ];
  }
  return {
    conversationState: {
      conversationId: conversationId(sessionId),
      chatTriggerType: "MANUAL",
      history: messages,
      currentMessage,
    },
    ...(instructions.length
      ? {
          systemPrompt: context.messages.some((message) => message.role === "developer")
            ? instructions.join("\n\n")
            : systemPrompt,
        }
      : {}),
  };
}

function safeMessage(value, auth) {
  let message = typeof value === "string" ? value : "Kiro request failed";
  for (const secret of [auth.access_token, auth.refresh_token, auth.profile_arn]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.slice(0, 2000);
}

function reportedUsage(tokens) {
  if (!tokens || typeof tokens !== "object") return undefined;
  const fields = {
    input: tokens.uncachedInputTokens,
    output: tokens.outputTokens,
    cacheRead: tokens.cacheReadInputTokens,
    cacheWrite: tokens.cacheWriteInputTokens,
    totalTokens: tokens.totalTokens,
  };
  if (!Object.values(fields).some((value) => Number.isFinite(value) && value >= 0))
    return undefined;
  // Unreported fields remain OMP's zero/default values, never estimated counts.
  return {
    ...Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        Number.isFinite(value) && value >= 0 ? value : 0,
      ]),
    ),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createHttpTransport({
  fetchImpl = (...args) => globalThis.fetch(...args),
  authProvider = loadKiroAuth,
} = {}) {
  return async function runHttpTurn({ model, context, cwd, signal, onText = () => {}, sessionId }) {
    signal?.throwIfAborted();
    const body = buildHttpRequest({ model, context, cwd, sessionId });
    const auth = await authProvider({ signal, fetchImpl });
    signal?.throwIfAborted();
    if (auth.profile_arn) body.profileArn = auth.profile_arn;
    const response = await fetchImpl(endpointFor(auth), {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${auth.access_token}`,
        "content-type": "application/x-amz-json-1.0",
        accept: "application/vnd.amazon.eventstream",
        "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
        ...(auth.profile_arn ? { "x-amzn-kiro-profile-arn": auth.profile_arn } : {}),
        "user-agent": "omp-kiro",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let error;
      try {
        error = await response.json();
      } catch {
        /* Status still identifies non-JSON errors. */
      }
      signal?.throwIfAborted();
      const code = error?.__type ?? error?.code ?? response.headers.get("x-amzn-errortype");
      throw new KiroHttpError(
        `Kiro HTTP ${response.status}${code ? ` (${safeMessage(code, auth)})` : ""}: ${safeMessage(error?.message ?? error?.Message, auth)}`,
        { status: response.status, code: safeMessage(code ?? "HttpError", auth) },
      );
    }
    const calls = new Map();
    let usage;
    let stopReason = "stop";
    let seenEvent = false;
    for await (const { headers, data } of decodeEventStream(response.body, signal)) {
      seenEvent = true;
      const kind = headers[":message-type"];
      const event = headers[":event-type"];
      if (kind === "exception" || kind === "error") {
        const code = headers[":exception-type"] ?? headers[":error-code"] ?? "StreamError";
        throw new KiroHttpError(
          `Kiro ${safeMessage(code, auth)}: ${safeMessage(data.message ?? data.Message ?? headers[":error-message"], auth)}`,
          { code: safeMessage(code, auth) },
        );
      }
      if (kind !== "event") throw new KiroHttpError("Invalid Kiro event-stream message type.");
      if (event === "assistantResponseEvent") {
        if (typeof data.content === "string" && data.content) onText(data.content);
      } else if (event === "toolUseEvent") {
        const id = data.toolUseId;
        if (typeof id !== "string" || !id)
          throw new KiroHttpError("Kiro tool event omitted its toolUseId.");
        let call = calls.get(id);
        if (!call) {
          call = { id, name: data.name, input: "", stopped: false };
          calls.set(id, call);
        }
        if (call.stopped)
          throw new KiroHttpError("Kiro sent tool arguments after the tool completed.");
        if (data.name) {
          if (call.name && call.name !== data.name)
            throw new KiroHttpError("Kiro changed a tool name during streaming.");
          call.name = data.name;
        }
        if (data.input !== undefined) {
          if (typeof data.input !== "string")
            throw new KiroHttpError("Invalid Kiro tool argument fragment.");
          call.input += data.input;
        }
        if (data.stop) call.stopped = true;
      } else if (event === "metadataEvent") {
        usage = reportedUsage(data.tokenUsage) ?? usage;
      } else if (event === "invalidStateEvent") {
        throw new KiroHttpError(
          `Kiro invalid state: ${safeMessage(data.reason ?? data.message, auth)}`,
          { code: "InvalidState" },
        );
      }
      if (data.stopReason === "max_tokens" || data.stopReason === "length") stopReason = "length";
    }
    signal?.throwIfAborted();
    if (!seenEvent) throw new KiroHttpError("Kiro returned no response events.");
    const toolCalls = [...calls.values()].map((call) => {
      if (!call.stopped || !call.name)
        throw new KiroHttpError("Kiro returned an incomplete tool call.");
      let args;
      try {
        args = JSON.parse(call.input || "{}");
      } catch {
        throw new KiroHttpError("Kiro returned invalid JSON tool arguments.");
      }
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new KiroHttpError("Kiro tool arguments must be a JSON object.");
      if (!context.tools?.some((tool) => tool.name === call.name))
        throw new KiroHttpError("Kiro requested a tool not supplied by OMP.");
      return { type: "toolCall", id: call.id, name: call.name, arguments: args };
    });
    return {
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(usage ? { usage } : {}),
      stopReason: toolCalls.length ? "toolUse" : stopReason,
    };
  };
}

export const runHttpTurn = createHttpTransport();

export async function discoverHttpModels({
  signal,
  fetchImpl = (...args) => globalThis.fetch(...args),
  authProvider = loadKiroAuth,
} = {}) {
  const auth = await authProvider({ signal, fetchImpl });
  const models = [];
  const seenTokens = new Set();
  let nextToken;
  do {
    signal?.throwIfAborted();
    const input = {
      origin: "KIRO_CLI",
      ...(auth.profile_arn ? { profileArn: auth.profile_arn } : {}),
      ...(nextToken ? { nextToken } : {}),
    };
    const url = new URL(endpointFor(auth, "management"));
    for (const [key, value] of Object.entries(input)) url.searchParams.set(key, value);
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${auth.access_token}`,
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "KiroControlPlaneBearerService.ListAvailableModels",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new KiroHttpError(`Kiro model catalog failed (HTTP ${response.status}).`, {
        status: response.status,
      });
    }
    const data = await response.json();
    if (!Array.isArray(data.models))
      throw new KiroHttpError("Kiro model catalog returned no models array.");
    for (const model of data.models) {
      if (typeof model.modelId !== "string" || !model.modelId)
        throw new KiroHttpError("Kiro model catalog returned an invalid model ID.");
      const inputLimit = model.tokenLimits?.maxInputTokens;
      const outputLimit = model.tokenLimits?.maxOutputTokens;
      models.push({
        id: model.modelId,
        name: model.modelName || model.modelId,
        ...(Number.isFinite(inputLimit) && inputLimit > 0 ? { contextWindow: inputLimit } : {}),
        ...(Number.isFinite(outputLimit) && outputLimit > 0 ? { maxTokens: outputLimit } : {}),
      });
    }
    nextToken = data.nextToken;
    if (nextToken) {
      if (typeof nextToken !== "string" || seenTokens.has(nextToken))
        throw new KiroHttpError("Kiro model catalog returned an invalid pagination token.");
      seenTokens.add(nextToken);
    }
  } while (nextToken);
  return models;
}
