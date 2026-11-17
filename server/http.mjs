import { createHash, randomUUID } from "node:crypto";
import { loadKiroAuth, refreshExpiredKiroAuth } from "./auth.mjs";
import { decodeEventStream } from "./eventstream.mjs";
import { kiroEffortFields, kiroThinkingConfig } from "./effort.mjs";
import {
  abortableRequest, defaultFetch, fetchWithRetry, isPermanentServiceError, isTransientNetworkError, isTransientStatus,
  requestScope, retryAfterMs, retryOperation,
} from "./network.mjs";

// Native ChatResponseStream union members can also arrive as event variants.
const STREAM_ERRORS = new Map([
  ["error", "InternalServerException"],
  ["throttlingError", "ThrottlingException"],
  ["validationError", "ValidationException"],
  ["serviceUnavailableError", "ServiceUnavailableException"],
]);

export class KiroHttpError extends Error {
  constructor(message, { status, code, reason, retryAfter, stopDetails } = {}) {
    super(message);
    this.name = "KiroHttpError";
    this.status = status;
    this.code = code;
    this.reason = reason;
    if (stopDetails) this.stopDetails = stopDetails;
    this.retryAfterMs = retryAfter;
  }
}

export function endpointFor(auth, service = "runtime") {
  const region = auth.profile_arn?.split(":")[3] || "us-east-1";
  if (region === "us-east-1" || region === "eu-central-1")
    return `https://${service}.${region}.kiro.dev/`;
  throw new KiroHttpError("Kiro HTTP transport does not support this account profile region.");
}

const isKiroHttpMessage = (message) => message.provider === "kiro-http" && message.api === "kiro-cli-http";

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
  // Kiro HTTP text blocks split by reasoning phases were one native text stream.
  return text.join(message.role === "assistant" && isKiroHttpMessage(message) ? "" : "\n");
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

// Native reasoning is replayed only to the model that produced and signed it.
// Kiro carries one scalar per assistant message: the last complete phase.
function replayableReasoning(message, model) {
  if (!isKiroHttpMessage(message) || message.model !== model ||
    message.stopReason === "error" || message.stopReason === "aborted" ||
    (message.upstreamModel != null && message.upstreamModel !== model) ||
    !Array.isArray(message.content)) return undefined;
  const block = message.content.findLast(({ type }) => type === "thinking" || type === "redactedThinking");
  if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking &&
    typeof block.thinkingSignature === "string" && block.thinkingSignature)
    return { reasoningText: { text: block.thinking, signature: block.thinkingSignature } };
  if (block?.type === "redactedThinking" && typeof block.data === "string" && block.data)
    return { redactedContent: block.data };
}

export function buildHttpRequest({
  model, context, cwd, sessionId, modelRequestFieldsSchema, reasoning, disableReasoning, forceReasoningOff,
}) {
  const additionalModelRequestFields = kiroEffortFields(modelRequestFieldsSchema, {
    reasoning, disableReasoning, forceReasoningOff,
  });
  const messages = [];
  const systemPrompt = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.join("\n\n")
    : context.systemPrompt;
  const userMessage = (content = "") => ({ content, modelId: model, origin: "KIRO_CLI" });
  for (const [index, message] of context.messages.entries()) {
    const content = textContent(message);
    if (message.role === "user" || message.role === "developer") {
      const input = message.role === "developer"
        ? `[Developer instructions at conversation message ${index + 1}]\n${content}`
        : content;
      const previous = messages.at(-1)?.userInputMessage;
      if (previous) previous.content += `${previous.content && input ? "\n\n" : ""}${input}`;
      else messages.push({ userInputMessage: userMessage(input) });
    } else if (message.role === "assistant") {
      const toolUses =
        typeof message.content === "string"
          ? []
          : (message.content ?? [])
              .filter((block) => block.type === "toolCall")
              .map((block) => ({ toolUseId: block.id, name: block.name, input: block.arguments }));
      const reasoningContent = replayableReasoning(message, model);
      const previous = messages.at(-1)?.assistantResponseMessage;
      if (previous) {
        previous.content += `${previous.content && content ? "\n\n" : ""}${content}`;
        if (toolUses.length) previous.toolUses = [...(previous.toolUses ?? []), ...toolUses];
        if (reasoningContent) previous.reasoningContent = reasoningContent;
        else delete previous.reasoningContent;
      } else {
        messages.push({
          assistantResponseMessage: {
            content,
            ...(toolUses.length ? { toolUses } : {}),
            ...(reasoningContent ? { reasoningContent } : {}),
          },
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
  const lastInput = context.messages.findLast((message) => message.role !== "developer");
  if (!currentMessage?.userInputMessage || !["user", "toolResult"].includes(lastInput?.role))
    throw new KiroHttpError("Kiro HTTP turn must end with a user message or actual tool results.");
  const current = currentMessage.userInputMessage;
  if (systemPrompt) {
    // GenerateAssistantResponse rejects the feature-gated top-level systemPrompt
    // for ordinary accounts. Preserve host instructions in supported user text,
    // once before history, without inventing an assistant acknowledgement.
    const firstInput = messages.find((message) => message.userInputMessage)?.userInputMessage ?? current;
    firstInput.content = `[System instructions]\n${systemPrompt}\n\n${firstInput.content}`;
  }
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
    ...(additionalModelRequestFields === undefined ? {} : { additionalModelRequestFields }),
    conversationState: {
      conversationId: conversationId(sessionId),
      chatTriggerType: "MANUAL",
      history: messages,
      currentMessage,
    },
  };
}

function safeMessage(value, auth) {
  let message = typeof value === "string" ? value : "Kiro request failed";
  for (const secret of [auth.access_token, auth.refresh_token, auth.profile_arn]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.slice(0, 2000);
}

function emptyUsage() {
  // Unreported fields remain OMP's zero/default values, never estimated counts.
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function reportedUsage(tokens, previous) {
  if (!tokens || typeof tokens !== "object") return previous;
  const fields = {
    input: tokens.uncachedInputTokens,
    output: tokens.outputTokens,
    cacheRead: tokens.cacheReadInputTokens,
    cacheWrite: tokens.cacheWriteInputTokens,
    totalTokens: tokens.totalTokens,
  };
  const reported = Object.entries(fields).filter(([, value]) => Number.isFinite(value) && value >= 0);
  return reported.length ? { ...(previous ?? emptyUsage()), ...Object.fromEntries(reported) } : previous;
}

function reportedStop(data, auth) {
  if (typeof data.stopReason !== "string")
    throw new KiroHttpError("Invalid Kiro stop reason.", { code: "InvalidStopReason" });
  switch (data.stopReason.toLowerCase()) {
    case "end_turn":
    case "stop":
      return "stop";
    case "max_tokens":
    case "length":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "toolUse";
    case "content_filtered":
    case "refusal": {
      const refusal = data.stopDetails?.refusal;
      const stopDetails = {
        type: "refusal",
        ...(typeof refusal?.category === "string" ? { category: safeMessage(refusal.category, auth) } : {}),
        ...(typeof refusal?.explanation === "string" ? { explanation: safeMessage(refusal.explanation, auth) } : {}),
      };
      throw new KiroHttpError(`Kiro refused the response${stopDetails.explanation ? `: ${stopDetails.explanation}` : "."}`, {
        code: "ContentFiltered", stopDetails,
      });
    }
    case "pause_turn":
      throw new KiroHttpError("Kiro paused the response; native paused-turn resumption is not supported.", {
        code: "PausedTurn",
      });
    case "compaction_required_for_model_handoff":
      throw new KiroHttpError("Kiro requires conversation compaction before a model handoff; compact the conversation explicitly.", {
        code: "CompactionRequired",
      });
    default:
      throw new KiroHttpError(`Kiro reported an unsupported stop reason: ${safeMessage(data.stopReason, auth)}`, {
        code: "UnsupportedStopReason",
      });
  }
}

function runtimeRetryAfterMs(response, data) {
  // The native Smithy header/payload is milliseconds, unlike HTTP Retry-After.
  const native = response.headers.get("x-amzn-kiro-ratelimit-retry-after");
  const delays = [
    retryAfterMs(response.headers),
    data?.retryAfterMilliseconds,
    native !== null && /^\s*\d+(?:\.\d+)?\s*$/.test(native) ? Number(native) : undefined,
  ].filter((value) => Number.isFinite(value) && value >= 0);
  return delays.length ? Math.max(...delays) : undefined;
}

function isTransientHttpError(error) {
  if (isTransientNetworkError(error)) return true;
  if (!(error instanceof KiroHttpError)) return false;
  if (isPermanentServiceError(error.code, error.message)) return false;
  if (["MONTHLY_REQUEST_COUNT", "DAILY_REQUEST_COUNT"].includes(error.reason)) return false;
  return isTransientStatus(error.status) ||
    ["EmptyResponse", "InternalServerException", "ServiceUnavailableException", "ThrottlingException"]
      .includes(error.code?.split("#").at(-1));
}

function continueHttpRequest(body, text) {
  const state = body.conversationState;
  const current = state.currentMessage.userInputMessage;
  // Move the accepted input/results once. Never copy prior toolResults into a
  // continuation, and never manufacture tool uses from a failed response.
  state.history.push(state.currentMessage, { assistantResponseMessage: { content: text } });
  const { toolResults: _completed, ...userInputMessageContext } = current.userInputMessageContext ?? {};
  state.currentMessage = {
    userInputMessage: {
      content: "Continue your response exactly where it stopped. Do not repeat already provided text or completed tools.",
      modelId: current.modelId,
      origin: current.origin,
      userInputMessageContext,
    },
  };
}

export function createHttpTransport({
  fetchImpl = defaultFetch,
  authProvider = loadKiroAuth,
  retry,
  idleTimeoutMs,
} = {}) {
  return async function runHttpTurn({
    model, context, cwd, signal, onText = () => {}, onReasoning = () => {}, sessionId, retry: turnRetry,
    onRestart, continuePartial = false, onRetry,
    modelRequestFieldsSchema, reasoning, disableReasoning, forceReasoningOff,
  }) {
    signal?.throwIfAborted();
    const body = buildHttpRequest({
      model, context, cwd, sessionId, modelRequestFieldsSchema, reasoning, disableReasoning, forceReasoningOff,
    });
    if (continuePartial && onRestart)
      throw new KiroHttpError("Choose committed-text continuation or provisional-text restart, not both.");
    const policy = turnRetry ?? retry;
    let auth = await authProvider({ signal, fetchImpl, retry: policy });
    signal?.throwIfAborted();
    if (auth.profile_arn) body.profileArn = auth.profile_arn;
    let requestBody = JSON.stringify(body);
    let attemptText = "";
    let attemptReasoned = false;
    let upstreamModel;
    return retryOperation(async () => {
      // Refresh can itself wait through an outage; do it outside socket timeout.
      auth = await refreshExpiredKiroAuth(auth, { signal, fetchImpl, retry: policy, authProvider });
      const request = requestScope(signal, idleTimeoutMs);
      // OMP blocks owned by this attempt. A new attempt never reuses or re-signs them.
      const reasoningBlocks = [];
      let thinking;
      let usage;
      const endThinking = () => {
        if (!thinking) return;
        const block = thinking;
        thinking = undefined;
        onReasoning({ type: "end", block });
      };
      try {
      const response = await abortableRequest(() => fetchImpl(endpointFor(auth), {
        method: "POST",
        redirect: "error",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${auth.access_token}`,
          "content-type": "application/x-amz-json-1.0",
          accept: "application/vnd.amazon.eventstream",
          "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
          ...(auth.profile_arn ? { "x-amzn-kiro-profile-arn": auth.profile_arn } : {}),
          "user-agent": "omp-kiro",
        },
        body: requestBody,
      }), request.signal);
      request.touch();
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
          {
            status: response.status,
            code: safeMessage(code ?? "HttpError", auth),
            reason: typeof error?.reason === "string" ? safeMessage(error.reason, auth) : undefined,
            retryAfter: runtimeRetryAfterMs(response, error),
          },
        );
      }
      const calls = new Map();
      let stopReason = "stop";
      let seenEvent = false;
      for await (const { headers, data } of decodeEventStream(response.body, request.signal, request.touch)) {
        seenEvent = true;
        const kind = headers[":message-type"];
        const event = headers[":event-type"];
        if (kind === "exception" || kind === "error" || (kind === "event" && STREAM_ERRORS.has(event))) {
          const code = headers[":exception-type"] ?? headers[":error-code"] ?? STREAM_ERRORS.get(event) ?? "StreamError";
          throw new KiroHttpError(
            `Kiro ${safeMessage(code, auth)}: ${safeMessage(data.message ?? data.Message ?? headers[":error-message"], auth)}`,
            {
              code: safeMessage(code, auth),
              reason: typeof data.reason === "string" ? safeMessage(data.reason, auth) : undefined,
              retryAfter: runtimeRetryAfterMs(response, data),
            },
          );
        }
        if (kind !== "event") throw new KiroHttpError("Invalid Kiro event-stream message type.");
        if (event === "assistantResponseEvent") {
          if (typeof data.modelId === "string" && data.modelId && data.modelId !== model)
            upstreamModel = data.modelId;
          if (typeof data.content === "string" && data.content) {
            endThinking();
            attemptText += data.content;
            onText(data.content);
          }
        } else if (event === "reasoningContentEvent") {
          const { text, signature, redactedContent } = data;
          if ([text, signature, redactedContent].some((value) => value != null && typeof value !== "string"))
            throw new KiroHttpError("Invalid Kiro reasoning event.");
          if (text) {
            // A signature seals its phase; later text is a new phase, never re-signed.
            if (thinking && Object.hasOwn(thinking, "thinkingSignature")) endThinking();
            if (!thinking) {
              thinking = { type: "thinking", thinking: "" };
              reasoningBlocks.push(thinking);
              attemptReasoned = true;
              onReasoning({ type: "start", block: thinking });
            }
            thinking.thinking += text;
            onReasoning({ type: "delta", block: thinking, delta: text });
          }
          // Native signatures are complete values: replace, never concatenate or display.
          if (signature && thinking) thinking.thinkingSignature = signature;
          if (redactedContent) {
            endThinking();
            const block = { type: "redactedThinking", data: redactedContent };
            reasoningBlocks.push(block);
            attemptReasoned = true;
            onReasoning({ type: "redacted", block });
          }
        } else if (event === "toolUseEvent") {
          endThinking();
          // Tools stay buffered until this entire attempt decodes and validates.
          // Retrying here cannot repeat a tool execution in the host.
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
          if (data.stop) {
            call.stopped = true;
            if (!call.name) throw new KiroHttpError("Kiro returned an incomplete tool call.");
            try {
              call.arguments = JSON.parse(call.input || "{}");
            } catch {
              throw new KiroHttpError("Kiro returned invalid JSON tool arguments.");
            }
            if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))
              throw new KiroHttpError("Kiro tool arguments must be a JSON object.");
            if (!context.tools?.some((tool) => tool.name === call.name))
              throw new KiroHttpError("Kiro requested a tool not supplied by OMP.");
          }
        } else if (event === "metadataEvent") {
          usage = reportedUsage(data.tokenUsage, usage);
        } else if (event === "meteringEvent") {
          // Credits are not dollars or token counts. Unknown meter units stay unmapped.
          if (Number.isFinite(data.usage) && data.usage >= 0 &&
            typeof data.unit === "string" && /^credits?$/i.test(data.unit)) {
            usage = { ...(usage ?? emptyUsage()), credits: { cost: data.usage } };
          }
        } else if (event === "toolResultEvent") {
          throw new KiroHttpError("Kiro returned a server-side tool result; only actual OMP-executed tool results are supported.", {
            code: "UnsupportedServerToolResult",
          });
        } else if (event === "invalidStateEvent") {
          throw new KiroHttpError(
            `Kiro invalid state: ${safeMessage(data.reason ?? data.message, auth)}`,
            { code: "InvalidState" },
          );
        }
        if ((event === "metadataEvent" || event === "assistantResponseEvent") && data.stopReason !== undefined)
          stopReason = reportedStop(data, auth);
      }
      signal?.throwIfAborted();
      if (!seenEvent)
        throw new KiroHttpError("Kiro returned no response events.", { code: "EmptyResponse" });
      const toolCalls = [...calls.values()].map((call) => {
        if (!call.stopped || !call.name)
          throw new KiroHttpError("Kiro returned an incomplete tool call.");
        return { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments };
      });
      if (stopReason === "toolUse" && !toolCalls.length)
        throw new KiroHttpError("Kiro reported TOOL_USE without a tool call.", { code: "InvalidToolStop" });
      endThinking();
      return {
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(usage ? { usage } : {}),
        ...(upstreamModel ? { upstreamModel } : {}),
        stopReason: toolCalls.length ? "toolUse" : stopReason,
      };
      } catch (error) {
        if (error instanceof KiroHttpError) {
          if (usage) error.usage = usage;
          if (upstreamModel) error.upstreamModel = upstreamModel;
        }
        // Failed-attempt reasoning stays display-only: no signature or opaque replay.
        for (const block of reasoningBlocks) {
          if (block.type === "thinking") delete block.thinkingSignature;
          else block.data = "";
        }
        try {
          endThinking();
        } catch {
          /* The attempt's own failure remains the reported error. */
        }
        throw error;
      } finally {
        request.close();
      }
    }, {
      signal,
      retry: policy,
      shouldRetry(error) {
        if ((attemptText || attemptReasoned) && !continuePartial && typeof onRestart !== "function") return false;
        return isTransientHttpError(error);
      },
      async onRetry(info) {
        if (attemptText && continuePartial) {
          continueHttpRequest(body, attemptText);
          requestBody = JSON.stringify(body);
        } else if (onRestart) await onRestart(info);
        if (onRetry) await onRetry(info);
        signal?.throwIfAborted();
        attemptText = "";
        attemptReasoned = false;
      },
    });
  };
}

export const runHttpTurn = createHttpTransport();

export async function discoverHttpModels({
  signal,
  fetchImpl = defaultFetch,
  authProvider = loadKiroAuth,
  retry,
} = {}) {
  let auth = await authProvider({ signal, fetchImpl, retry });
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
    const data = await fetchWithRetry(fetchImpl, url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${auth.access_token}`,
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "KiroControlPlaneBearerService.ListAvailableModels",
      },
      body: JSON.stringify(input),
    }, {
      retry,
      async prepareRequest(init) {
        auth = await refreshExpiredKiroAuth(auth, { signal, fetchImpl, retry, authProvider });
        return { ...init, headers: { ...init.headers, authorization: `Bearer ${auth.access_token}` } };
      },
      async consume(response) {
        if (!response.ok) {
          await response.body?.cancel();
          throw new KiroHttpError(`Kiro model catalog failed (HTTP ${response.status}).`, {
            status: response.status,
          });
        }
        return response.json();
      },
    });
    if (!Array.isArray(data.models))
      throw new KiroHttpError("Kiro model catalog returned no models array.");
    for (const model of data.models) {
      if (typeof model.modelId !== "string" || !model.modelId)
        throw new KiroHttpError("Kiro model catalog returned an invalid model ID.");
      const inputLimit = model.tokenLimits?.maxInputTokens;
      const outputLimit = model.tokenLimits?.maxOutputTokens;
      const schema = model.additionalModelRequestFieldsSchema;
      kiroThinkingConfig(schema);
      models.push({
        id: model.modelId,
        name: model.modelName || model.modelId,
        ...(Number.isFinite(inputLimit) && inputLimit > 0 ? { contextWindow: inputLimit } : {}),
        ...(Number.isFinite(outputLimit) && outputLimit > 0 ? { maxTokens: outputLimit } : {}),
        ...(schema == null ? {} : { additionalModelRequestFieldsSchema: schema }),
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
