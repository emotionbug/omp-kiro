import { createHash, randomUUID } from "node:crypto";
import { loadKiroAuth, refreshExpiredKiroAuth } from "./auth.mjs";
import { decodeEventStream } from "./eventstream.mjs";
import { kiroEffortFields, kiroThinkingConfig } from "./effort.mjs";
import {
  abortableRequest, defaultFetch, fetchWithRetry, isPermanentServiceError, isTransientNetworkError, isTransientStatus,
  requestScope, retryAfterMs, retryOperation, retryPolicy,
} from "./network.mjs";
import { kiroCliServiceHeaders, kiroEndpoint as endpointFor } from "./wire.mjs";

export { endpointFor };

// Native ChatResponseStream union error members, named by `:exception-type`
// on exception frames or by `:event-type` when sent as event variants.
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

const INPUT_TOO_LONG = "Input is too long";
const CONTENT_LENGTH_EXCEEDS_THRESHOLD = "CONTENT_LENGTH_EXCEEDS_THRESHOLD";
const TOOL_RESULT_MAX_BYTES = 800_000;
const TOOL_RESULT_SHRUNK_BYTES = 25_000;
const BUDGET_BASE_BYTES = 850_000;
const BUDGET_BASE_TOKENS = 200_000;
const UTF8 = new TextEncoder();
const CONTINUATION_PROMPT = "Please proceed with the task.";
const CURRENT_TOOL_RESULT_IMAGE = "(see attached image)";
const HISTORICAL_IMAGE = "(image omitted from history)";
const IMAGE_FORMATS = new Map([
  ["image/jpeg", "jpeg"], ["image/jpg", "jpeg"], ["image/png", "png"],
  ["image/gif", "gif"], ["image/webp", "webp"],
]);

function contextOverflow(detail, properties) {
  const error = new KiroHttpError(`Kiro prompt is too long${detail ? `: ${detail}` : "."}`, properties);
  error.contextOverflow = true;
  return error;
}

function isOverflowRejection(code, reason, body) {
  return reason === CONTENT_LENGTH_EXCEEDS_THRESHOLD ||
    (typeof code === "string" && code.split("#").at(-1) === CONTENT_LENGTH_EXCEEDS_THRESHOLD) ||
    body.includes(INPUT_TOO_LONG);
}

const isKiroHttpMessage = (message) => message.provider === "kiro-http" && message.api === "kiro-cli-http";

function textContent(message) {
  if (typeof message.content === "string") return message.content.toWellFormed();
  const text = [];
  for (const block of message.content ?? []) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "image" && message.role !== "assistant") continue;
    else if (!["toolCall", "thinking", "redactedThinking"].includes(block.type)) {
      throw new KiroHttpError(
        `Kiro HTTP transport cannot forward ${block.type} content.`,
      );
    }
  }
  // Kiro HTTP text blocks split by reasoning phases were one native text stream.
  return text.join(message.role === "assistant" && isKiroHttpMessage(message) ? "" : "\n").toWellFormed();
}

// Historical images are never encoded or validated; only the current turn carries bytes.
function collectImages(message, output) {
  if (!Array.isArray(message.content)) return false;
  let found = false;
  for (const block of message.content) {
    if (block.type !== "image") continue;
    if (!output) return true;
    const format = typeof block.mimeType === "string" && IMAGE_FORMATS.get(block.mimeType.toLowerCase());
    if (!format) throw new KiroHttpError(`Kiro does not support image type: ${block.mimeType}`);
    found = true;
    output.push({ format, source: { bytes: block.data } });
  }
  return found;
}

function truncateToolText(text, totalBytes, limit) {
  if (totalBytes <= limit) return text;
  const marker = (keptBytes) =>
    `\n\n[Tool result truncated: only the first ${keptBytes} of ${totalBytes} UTF-8 bytes were sent. Re-run the tool with a narrower scope if the omitted part is needed.]`;
  // Reserve room for the marker's widest kept-byte count. encodeInto never splits a code point.
  const { read, written } = UTF8.encodeInto(text, new Uint8Array(limit - marker(limit).length));
  return text.slice(0, read) + marker(written);
}

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function enforceRequestBudget({ body, contextWindow, historicalResults, currentResults }) {
  const { history, currentMessage: { userInputMessage: current } } = body.conversationState;
  const tokens = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : BUDGET_BASE_TOKENS;
  const limit = Math.floor(BUDGET_BASE_BYTES * (tokens / BUDGET_BASE_TOKENS));
  // Match Kiro's conversation budget: history, current text, images, and tool result text.
  let total = jsonBytes(history) + jsonBytes(current.content) + jsonBytes(current.images ?? []);
  for (const { part } of currentResults) total += jsonBytes(part.text);
  if (total <= limit) return;
  for (const results of [historicalResults, currentResults]) {
    for (const result of results) {
      if (result.shrunk || result.fullBytes <= TOOL_RESULT_SHRUNK_BYTES) continue;
      const before = jsonBytes(result.part.text);
      result.part.text = truncateToolText(result.full, result.fullBytes, TOOL_RESULT_SHRUNK_BYTES);
      result.shrunk = true;
      total += jsonBytes(result.part.text) - before;
      if (total <= limit) return;
    }
  }
  throw contextOverflow(`request exceeds the local limit of ${limit} UTF-8 bytes`);
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

// Native Kiro CLI placeholder (tool_index.json `dummy`). The backend rejects
// history tool uses whose names are absent from the current specifications.
const PLACEHOLDER_TOOL = {
  name: "dummy",
  description: "This is a dummy tool. If you are seeing this that means the tool associated with this tool call is not in the list of available tools. This could be because a wrong tool name was supplied or the list of tools has changed since the conversation has started. Do not show this when user asks you to list tools.",
  inputSchema: { json: { type: "object", properties: {}, required: [] } },
};

function prepareHttpRequest({
  model, context, contextWindow, cwd, sessionId, modelRequestFieldsSchema, reasoning, disableReasoning, forceReasoningOff,
}) {
  const additionalModelRequestFields = kiroEffortFields(modelRequestFieldsSchema, {
    reasoning, disableReasoning, forceReasoningOff,
  });
  const messages = [];
  const historicalResults = [];
  const currentResults = [];
  const historicalImageUsers = new Set();
  const currentImages = [];
  const toolImages = [];
  const lastAssistant = context.messages.findLastIndex((message) => message.role === "assistant");
  let currentUserHasImages = false;
  const advertised = new Set((context.tools ?? []).map((tool) => tool.name));
  let placeholderUsed = false;
  const systemPrompt = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.join("\n\n")
    : context.systemPrompt;
  const userMessage = (content = "") => ({ content, modelId: model, origin: "KIRO_CLI" });
  for (const [index, message] of context.messages.entries()) {
    const isCurrent = index > lastAssistant;
    const content = textContent(message);
    if (message.role === "user" || message.role === "developer") {
      const input = message.role === "developer"
        ? `[Developer instructions at conversation message ${index + 1}]\n${content}`
        : content;
      let previous = messages.at(-1)?.userInputMessage;
      if (previous) previous.content += `${previous.content && input ? "\n\n" : ""}${input}`;
      else {
        previous = userMessage(input);
        messages.push({ userInputMessage: previous });
      }
      if (collectImages(message, isCurrent ? currentImages : undefined)) {
        if (isCurrent) currentUserHasImages = true;
        else historicalImageUsers.add(previous);
      }
    } else if (message.role === "assistant") {
      const toolUses =
        typeof message.content === "string"
          ? []
          : (message.content ?? [])
              .filter((block) => block.type === "toolCall")
              .map((block) => {
                // OMP may dispatch unadvertised names (device routes) or answer
                // them as not found; history must still reference a sent spec.
                const known = advertised.has(block.name);
                if (!known) placeholderUsed = true;
                return { toolUseId: block.id, name: known ? block.name : PLACEHOLDER_TOOL.name, input: block.arguments };
              });
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
      const imageOnly = collectImages(message, isCurrent ? toolImages : undefined) && !content;
      const full = content || (imageOnly ? (isCurrent ? CURRENT_TOOL_RESULT_IMAGE : HISTORICAL_IMAGE) : "");
      const fullBytes = Buffer.byteLength(full, "utf8");
      const part = { text: truncateToolText(full, fullBytes, TOOL_RESULT_MAX_BYTES) };
      (isCurrent ? currentResults : historicalResults).push({ part, full, fullBytes, imageOnly });
      previous.userInputMessageContext.toolResults.push({
        toolUseId: message.toolCallId,
        content: [part],
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
  for (const user of historicalImageUsers) if (!user.content) user.content = HISTORICAL_IMAGE;
  const imageOnlyCurrentUser = currentUserHasImages && !current.content;
  if (systemPrompt) {
    // GenerateAssistantResponse rejects the feature-gated top-level systemPrompt
    // for ordinary accounts. Preserve host instructions in supported user text,
    // once before history, without inventing an assistant acknowledgement.
    const firstInput = messages.find((message) => message.userInputMessage)?.userInputMessage ?? current;
    firstInput.content = `[System instructions]\n${systemPrompt}\n\n${firstInput.content}`;
  }
  const historicalImageContent = imageOnlyCurrentUser ? current.content + HISTORICAL_IMAGE : undefined;
  if (!current.content.trim() && !currentResults.length) current.content = CONTINUATION_PROMPT;
  for (const image of toolImages) currentImages.push(image);
  if (currentImages.length) current.images = currentImages;
  current.userInputMessageContext ??= {};
  const tools = (context.tools ?? []).map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters },
    },
  }));
  if (placeholderUsed && !advertised.has(PLACEHOLDER_TOOL.name))
    tools.push({ toolSpecification: PLACEHOLDER_TOOL });
  if (tools.length) current.userInputMessageContext.tools = tools;
  if (cwd) {
    current.userInputMessageContext.additionalContext = [
      {
        name: "workspace",
        description: "The working directory; the host executes requested tools.",
        innerContext: cwd,
      },
    ];
  }
  const body = {
    ...(additionalModelRequestFields === undefined ? {} : { additionalModelRequestFields }),
    conversationState: {
      conversationId: conversationId(sessionId),
      chatTriggerType: "MANUAL",
      history: messages,
      currentMessage,
    },
  };
  const prepared = { body, contextWindow, historicalResults, currentResults, historicalImageContent };
  enforceRequestBudget(prepared);
  return prepared;
}

export function buildHttpRequest(options) {
  return prepareHttpRequest(options).body;
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

async function httpResponseError(response, auth, signal) {
  const status = response.status;
  if (status === 413) {
    void response.body?.cancel().catch(() => {});
    return contextOverflow(undefined, { status });
  }
  let text = "";
  let data;
  try {
    text = await abortableRequest(() => response.text(), signal);
    data = JSON.parse(text);
  } catch {
    // Plain-text and empty responses carry no structured error metadata.
  }
  const code = data?.__type ?? data?.code ?? response.headers.get("x-amzn-errortype");
  const message = data?.message ?? data?.Message;
  const details = {
    status,
    code: safeMessage(code ?? "HttpError", auth),
    reason: typeof data?.reason === "string" ? safeMessage(data.reason, auth) : undefined,
  };
  if (isOverflowRejection(code, data?.reason, text) ||
    (typeof message === "string" && message.includes(INPUT_TOO_LONG))) {
    // Do not include HTTP status or untrusted body text in OMP's overflow evidence.
    return contextOverflow(undefined, details);
  }
  return new KiroHttpError(
    `Kiro HTTP ${status}${code ? ` (${safeMessage(code, auth)})` : ""}: ${safeMessage(message, auth)}`,
    { ...details, retryAfter: runtimeRetryAfterMs(response, data) },
  );
}

function isTransientHttpError(error) {
  if (error?.contextOverflow) return false;
  if (isTransientNetworkError(error)) return true;
  if (!(error instanceof KiroHttpError)) return false;
  if (isPermanentServiceError(error.code, error.message)) return false;
  if (["MONTHLY_REQUEST_COUNT", "DAILY_REQUEST_COUNT"].includes(error.reason)) return false;
  return isTransientStatus(error.status) ||
    ["EmptyResponse", "InternalServerException", "ServiceUnavailableException", "ThrottlingException"]
      .includes(error.code?.split("#").at(-1));
}

function continueHttpRequest(prepared, text) {
  const state = prepared.body.conversationState;
  const current = state.currentMessage.userInputMessage;
  // Move accepted input/results once. Images and tool specifications belong
  // only on the current turn; failed response tool calls never enter history.
  const { toolResults, ...userInputMessageContext } = current.userInputMessageContext ?? {};
  delete current.images;
  if (prepared.historicalImageContent !== undefined) current.content = prepared.historicalImageContent;
  if (toolResults) current.userInputMessageContext = { toolResults };
  else delete current.userInputMessageContext;
  state.history.push(state.currentMessage, { assistantResponseMessage: { content: text } });
  for (const result of prepared.currentResults) {
    if (result.imageOnly) result.part.text = HISTORICAL_IMAGE;
    prepared.historicalResults.push(result);
  }
  prepared.currentResults = [];
  prepared.historicalImageContent = undefined;
  state.currentMessage = {
    userInputMessage: {
      content: "Continue your response exactly where it stopped. Do not repeat already provided text or completed tools.",
      modelId: current.modelId,
      origin: current.origin,
      userInputMessageContext,
    },
  };
  enforceRequestBudget(prepared);
}

export function createHttpTransport({
  fetchImpl = defaultFetch,
  authProvider = loadKiroAuth,
  retry,
  idleTimeoutMs,
} = {}) {
  return async function runHttpTurn({
    model, context, contextWindow, cwd, signal, onText = () => {}, onReasoning = () => {}, sessionId, retry: turnRetry,
    onRestart, continuePartial = false, onRetry,
    modelRequestFieldsSchema, reasoning, disableReasoning, forceReasoningOff,
  }) {
    signal?.throwIfAborted();
    const prepared = prepareHttpRequest({
      model, context, contextWindow, cwd, sessionId, modelRequestFieldsSchema, reasoning, disableReasoning, forceReasoningOff,
    });
    const { body } = prepared;
    if (continuePartial && onRestart)
      throw new KiroHttpError("Choose committed-text continuation or provisional-text restart, not both.");
    const policy = turnRetry ?? retry;
    let auth = await authProvider({ signal, fetchImpl, retry: policy });
    signal?.throwIfAborted();
    if (auth.kind !== "api-key" && auth.profile_arn) body.profileArn = auth.profile_arn;
    let requestBody = JSON.stringify(body);
    const maxAttempts = retryPolicy(policy).maxAttempts ?? 0;
    let attempt = 0;
    let attemptText = "";
    let attemptReasoned = false;
    let attemptMetered = false;
    let turnMetered = false;
    let upstreamModel;
    return retryOperation(async () => {
      // Refresh can itself wait through an outage; do it outside socket timeout.
      auth = await refreshExpiredKiroAuth(auth, { signal, fetchImpl, retry: policy, authProvider });
      const request = requestScope(signal, idleTimeoutMs);
      // OMP blocks owned by this attempt. A new attempt never reuses or re-signs them.
      const reasoningBlocks = [];
      let thinking;
      let usage;
      const calls = new Map();
      let stoppedCalls = 0;
      let stopReason;
      let outputEnded = false;
      const finish = () => {
        const toolCalls = [...calls.values()].map((call) => {
          if (!call.stopped || !call.name)
            throw new KiroHttpError("Kiro returned an incomplete tool call.");
          return { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments };
        });
        if (stopReason === "toolUse" && !toolCalls.length)
          throw new KiroHttpError("Kiro reported TOOL_USE without a tool call.", { code: "InvalidToolStop" });
        if (attemptMetered && !toolCalls.length && !attemptText.trim())
          throw new KiroHttpError("Kiro returned no usable metered response.", { code: "EmptyMeteredResponse" });
        endThinking();
        return {
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(usage ? { usage } : {}),
          ...(upstreamModel ? { upstreamModel } : {}),
          stopReason: toolCalls.length ? "toolUse" : stopReason ?? "stop",
        };
      };
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
        headers: kiroCliServiceHeaders("GenerateAssistantResponse", auth.access_token, { attempt: ++attempt, maxAttempts }),
        body: requestBody,
      }), request.signal);
      request.touch();
      if (!response.ok) throw await httpResponseError(response, auth, request.signal);
      let seenEvent = false;
      for await (const { headers, data } of decodeEventStream(response.body, request.signal, request.touch)) {
        seenEvent = true;
        const kind = headers[":message-type"];
        const event = headers[":event-type"];
        if (kind === "exception" || kind === "error" || (kind === "event" && STREAM_ERRORS.has(event))) {
          // Exception frames name the union member (`:exception-type: error` is
          // InternalServerException, for example transient model overload).
          const type = headers[":exception-type"] ?? headers[":error-code"];
          const code = STREAM_ERRORS.get(type ?? event) ?? type ?? data.code ?? data.__type ?? "StreamError";
          const message = data.message ?? data.Message ?? headers[":error-message"];
          if (isOverflowRejection(code, data.reason, JSON.stringify(data)) ||
            (typeof message === "string" && message.includes(INPUT_TOO_LONG))) {
            throw contextOverflow(undefined, { code: safeMessage(code, auth) });
          }
          throw new KiroHttpError(
            `Kiro ${safeMessage(code, auth)}: ${safeMessage(message, auth)}`,
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
            outputEnded = false;
            endThinking();
            attemptText += data.content;
            onText(data.content);
          }
        } else if (event === "reasoningContentEvent") {
          const { text, signature, redactedContent } = data;
          if ([text, signature, redactedContent].some((value) => value != null && typeof value !== "string"))
            throw new KiroHttpError("Invalid Kiro reasoning event.");
          if (text) {
            outputEnded = false;
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
            outputEnded = false;
            endThinking();
            const block = { type: "redactedThinking", data: redactedContent };
            reasoningBlocks.push(block);
            attemptReasoned = true;
            onReasoning({ type: "redacted", block });
          }
        } else if (event === "toolUseEvent") {
          outputEnded = false;
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
          if (typeof data.input === "string") {
            if (!call.snapshot) call.input += data.input;
          } else if (data.input && typeof data.input === "object" && !Array.isArray(data.input)) {
            call.snapshot = data.input;
            call.input = "";
          } else if (data.input !== undefined) {
            throw new KiroHttpError("Invalid Kiro tool argument fragment.");
          }
          if (data.stop === true) {
            if (typeof call.name !== "string" || !call.name)
              throw new KiroHttpError("Kiro returned an incomplete tool call.");
            try {
              call.arguments = call.snapshot ?? JSON.parse(call.input.trim() || "{}");
            } catch {
              throw new KiroHttpError("Kiro returned invalid JSON tool arguments.");
            }
            if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))
              throw new KiroHttpError("Kiro tool arguments must be a JSON object.");
            call.stopped = true;
            stoppedCalls++;
          }
        } else if (event === "metadataEvent") {
          usage = reportedUsage(data.tokenUsage, usage);
        } else if (event === "contextUsageEvent") {
          const percentage = data.contextUsagePercentage;
          if (Number.isFinite(contextWindow) && contextWindow > 0 &&
            Number.isFinite(percentage) && percentage >= 0 && percentage <= 100) {
            (usage ??= emptyUsage()).contextTokens = Math.round((percentage / 100) * contextWindow);
          }
        } else if (event === "meteringEvent") {
          // The event itself acknowledges billing, even if its units are unrecognized.
          attemptMetered = true;
          turnMetered = true;
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
          if (isOverflowRejection(data.code, data.reason, JSON.stringify(data)))
            throw contextOverflow(undefined, { code: "InvalidState" });
          throw new KiroHttpError(
            `Kiro invalid state: ${safeMessage(data.reason ?? data.message, auth)}`,
            { code: "InvalidState" },
          );
        }
        if (event === "metadataEvent" || event === "initial-response" || event === "assistantResponseEvent") {
          if (data.stopReason !== undefined) {
            stopReason = reportedStop(data, auth);
            outputEnded = true;
          } else if (data.stopDetails?.refusal) {
            reportedStop({ ...data, stopReason: "refusal" }, auth);
          }
        }
      }
      signal?.throwIfAborted();
      if (!seenEvent)
        throw new KiroHttpError("Kiro returned no response events.", { code: "EmptyResponse" });
      return finish();
      } catch (error) {
        // Only a transport cut after an explicit, validated stop can count as
        // complete. A paid but unfinished attempt may not release buffered tools.
        if (attemptMetered && outputEnded && !signal?.aborted &&
          (isTransientNetworkError(error) || error?.message === "Truncated AWS event stream") &&
          stoppedCalls === calls.size &&
          (calls.size ? stopReason === "toolUse" : stopReason !== "toolUse" && attemptText.trim())) {
          return finish();
        }
        if (error instanceof Error && !signal?.aborted) {
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
        if (attemptMetered && !(continuePartial && attemptText.trim())) return false;
        if ((attemptText || attemptReasoned) && !continuePartial && typeof onRestart !== "function") return false;
        return isTransientHttpError(error);
      },
      async onRetry(info) {
        if (attemptText && continuePartial) {
          continueHttpRequest(prepared, attemptText);
          requestBody = JSON.stringify(body);
        } else if (onRestart) await onRestart(info);
        if (onRetry) await onRetry(info);
        signal?.throwIfAborted();
        attemptText = "";
        attemptReasoned = false;
        attemptMetered = false;
      },
    }).catch((error) => {
      // The outer OMP retry loop must not replay this turn either, including
      // when a distinct continuation failed after an earlier paid attempt.
      if (turnMetered && !signal?.aborted) {
        const billedError = error instanceof Error ? error : new KiroHttpError("Kiro did not finish the billed response.");
        billedError.metered = true;
        throw billedError;
      }
      throw error;
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
      ...(auth.kind !== "api-key" && auth.profile_arn ? { profileArn: auth.profile_arn } : {}),
      ...(nextToken ? { nextToken } : {}),
    };
    const url = new URL(endpointFor(auth, "management"));
    const data = await fetchWithRetry(fetchImpl, url, {
      method: "POST",
      redirect: "error",
      signal,
      body: JSON.stringify(input),
    }, {
      retry,
      async prepareRequest(init) {
        auth = await refreshExpiredKiroAuth(auth, { signal, fetchImpl, retry, authProvider });
        return { ...init, headers: kiroCliServiceHeaders("ListAvailableModels", auth.access_token) };
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
        ...(Array.isArray(model.supportedInputTypes) ? { supportedInputTypes: model.supportedInputTypes } : {}),
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
