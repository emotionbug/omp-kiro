import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { closeSession, discoverModels, runTurn } from "./server/bridge.mjs";
import { discoverHttpModels, runHttpTurn } from "./server/http.mjs";
import { registerKiroCommands } from "./server/commands.mjs";
import { abortableRequest, isTransientNetworkError, isTlsError } from "./server/network.mjs";
import { registerKiroWebSearch } from "./server/web.mjs";
import { readKiroAuth } from "./server/auth.mjs";
import { kiroCatalogAccountId, readKiroModelCatalog } from "./server/model-catalog.mjs";
import { kiroThinkingConfig } from "./server/effort.mjs";

function streamKiro(model, context, options = {}, transport, resolveModelSchema) {
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
      options.signal?.throwIfAborted();
      const modelRequestFieldsSchema = transport === "http"
        ? await resolveModelSchema(model.id, options.signal)
        : undefined;
      const thinking = transport === "http" ? kiroThinkingConfig(modelRequestFieldsSchema) : undefined;
      // Custom streamSimple providers bypass OMP's mandatory-reasoning clamp.
      // Auto/off must use the native floor when this model cannot disable reasoning.
      const useMinimumEffort = thinking?.requiresEffort &&
        (options.reasoning === undefined || options.disableReasoning || options.forceReasoningOff);
      const runTransport = transport === "http" ? runHttpTurn : runTurn;
      const outcome = await runTransport({
        model: model.id,
        context,
        cwd: options.cwd ?? process.cwd(),
        signal: options.signal,
        sessionId: options.sessionId,
        ...(transport === "http" ? {
          continuePartial: true,
          modelRequestFieldsSchema,
          reasoning: useMinimumEffort ? thinking.efforts[0] : options.reasoning,
          disableReasoning: !useMinimumEffort && model.reasoning ? options.disableReasoning : undefined,
          forceReasoningOff: useMinimumEffort ? undefined : options.forceReasoningOff,
        } : {}),
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
      // Transient HTTP recovery/committed-text continuation stays inside the
      // transport. Terminal errors remain sanitized for the host.
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

function providerModels(models, transport) {
  return models.map(({ id, name, contextWindow, maxTokens, additionalModelRequestFieldsSchema }) => {
    const thinking = transport === "http" ? kiroThinkingConfig(additionalModelRequestFieldsSchema) : undefined;
    return {
      id,
      name: `Kiro · ${name}`,
      reasoning: Boolean(thinking),
      ...(thinking ? { thinking } : {}),
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // ACP omits numeric limits; HTTP uses advertised limits when supplied.
      contextWindow: contextWindow ?? 128000,
      maxTokens: maxTokens ?? 16000,
    };
  });
}

export default async function kiroExtension(pi) {
  const transport = process.env.OMP_KIRO_TRANSPORT || "http";
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
  // OMP's public model object need not carry the native request schema.
  const modelSchemas = new Map();
  const catalogModelIds = new Set();
  let catalogLoaded = false;
  let catalogFetch;
  let catalogVersion = 0;
  let catalogAccountId;
  let catalogRefreshRequired = false;
  let snapshotActive = false;
  const rememberModels = (catalog, accountId, version) => {
    if (version !== catalogVersion)
      throw new Error("Kiro profile changed during model discovery. Use /kiro-model <id> to refresh the session model.");
    modelSchemas.clear();
    catalogModelIds.clear();
    for (const model of catalog) {
      catalogModelIds.add(model.id);
      if (transport === "http" && model.additionalModelRequestFieldsSchema !== undefined)
        modelSchemas.set(model.id, model.additionalModelRequestFieldsSchema);
    }
    catalogAccountId = accountId;
    catalogLoaded = true;
    catalogRefreshRequired = false;
    return providerModels(catalog, transport);
  };
  const invalidateModels = () => {
    catalogVersion++;
    modelSchemas.clear();
    catalogModelIds.clear();
    catalogLoaded = false;
    catalogFetch = undefined;
    catalogRefreshRequired = true;
  };
  const fetchModels = () => {
    if (!catalogFetch) {
      const version = catalogVersion;
      const request = (async () => {
        const accountId = transport === "http"
          ? kiroCatalogAccountId(await readKiroAuth())
          : undefined;
        const catalog = await (transport === "http" ? discoverHttpModels() : discoverModels());
        if (transport === "http" && accountId !== kiroCatalogAccountId(await readKiroAuth()))
          throw new Error("Kiro profile changed during model discovery. Use /kiro-model <id> to refresh the session model.");
        return rememberModels(catalog, accountId, version);
      })();
      catalogFetch = request;
      void request.finally(() => {
        if (catalogFetch === request) catalogFetch = undefined;
      }).catch(() => {});
    }
    return catalogFetch;
  };
  const useLiveCatalog = () => {
    const notice = snapshotActive
      ? "The configured model snapshot belongs to the previous profile and is bypassed in this process. Regenerate it with models.cmd before restarting with that snapshot."
      : undefined;
    snapshotActive = false;
    registerProvider({ models: [], fetchDynamicModels: fetchModels });
    return notice;
  };
  const checkProfileIdentity = async () => {
    if (transport !== "http") return false;
    const accountId = kiroCatalogAccountId(await readKiroAuth());
    if (catalogAccountId !== undefined && catalogAccountId !== accountId) {
      invalidateModels();
      catalogAccountId = accountId;
      useLiveCatalog();
      return true;
    }
    return false;
  };
  const resolveModelSchema = async (id, signal) => {
    await checkProfileIdentity();
    if (catalogRefreshRequired)
      throw new Error("Kiro profile changed; the session model catalog must be refreshed. Use /kiro-models and /kiro-model <id> before continuing.");
    // Host cache hits skip fetchDynamicModels, so native schemas may not yet
    // have been loaded in this process.
    if (!catalogLoaded) {
      if (signal) await abortableRequest(fetchModels, signal);
      else await fetchModels();
    }
    if (!catalogModelIds.has(id))
      throw new Error("This model is unavailable for the selected Kiro profile. Use /kiro-models and /kiro-model <id>; no replacement model was selected.");
    return modelSchemas.get(id);
  };
  const registerProvider = (catalog) => pi.registerProvider(provider, {
    baseUrl: "https://kiro-cli.invalid/",
    apiKey: "kiro-cli-managed-auth",
    api: `kiro-cli-${transport}`,
    ...catalog,
    streamSimple: (model, context, options) =>
      streamKiro(model, context, options, transport, resolveModelSchema),
  });
  const catalogFile = process.env.OMP_KIRO_MODEL_CATALOG_FILE;
  let models;
  if (transport === "http" && catalogFile !== undefined) {
    const auth = await readKiroAuth();
    models = rememberModels(await readKiroModelCatalog(catalogFile, { auth }), kiroCatalogAccountId(auth), catalogVersion);
    snapshotActive = true;
  }
  // Startup snapshots remain authoritative until a profile change invalidates
  // their account binding; only then do we replace them with live discovery.
  registerProvider(models !== undefined ? { models } : { fetchDynamicModels: fetchModels });
  if (transport === "http") registerKiroWebSearch(pi);
  registerKiroCommands(pi, {
    transport,
    services: {
      onBeforeModelRefresh: checkProfileIdentity,
      async onProfileChanged() {
        invalidateModels();
        const notice = useLiveCatalog();
        catalogAccountId = kiroCatalogAccountId(await readKiroAuth());
        return notice;
      },
    },
  });
}
