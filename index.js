import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { closeSession, discoverModels, runTurn } from "./server/bridge.mjs";
import { createHttpTransport, discoverHttpModels, runHttpTurn } from "./server/http.mjs";
import { registerKiroCommands } from "./server/commands.mjs";
import { abortableRequest, isTransientNetworkError, isTlsError } from "./server/network.mjs";
import { registerKiroWebSearch } from "./server/web.mjs";
import { pinnedKiroAuth, readKiroAuth } from "./server/auth.mjs";
import { DEFAULT_ACCOUNT, kiroAccountTargets, listKiroAccounts, pinnedKiroTargets } from "./server/accounts.mjs";
import { kiroCatalogAccountId, readKiroModelCatalog } from "./server/model-catalog.mjs";
import { kiroThinkingConfig } from "./server/effort.mjs";

const unavailableAccount = () =>
  new Error("This Kiro account profile is no longer usable. Sign in again or choose another Kiro model; no replacement model was selected.");

function streamKiro(model, context, options = {}, transport, route) {
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
    // Each content block keeps the index where it was appended; text and
    // reasoning phases alternate as separate blocks in wire order.
    let text;
    let textIndex;
    let thinking;
    let thinkingIndex;
    const append = (block) => message.content.push(block) - 1;
    const endText = () => {
      if (!text) return;
      stream.push({ type: "text_end", contentIndex: textIndex, content: text.text, partial: message });
      text = undefined;
    };
    const endThinking = () => {
      if (!thinking) return;
      stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking.thinking, partial: message });
      thinking = undefined;
    };
    stream.push({ type: "start", partial: message });
    try {
      options.signal?.throwIfAborted();
      if (!route) throw unavailableAccount();
      const modelRequestFieldsSchema = transport === "http"
        ? await route.resolveModelSchema(model.id, options.signal)
        : undefined;
      const thinkingConfig = transport === "http" ? kiroThinkingConfig(modelRequestFieldsSchema) : undefined;
      // Custom streamSimple providers bypass OMP's mandatory-reasoning clamp.
      // Auto/off must use the native floor when this model cannot disable reasoning.
      const useMinimumEffort = thinkingConfig?.requiresEffort &&
        (options.reasoning === undefined || options.disableReasoning || options.forceReasoningOff);
      const runTransport = route.runTurn;
      const outcome = await runTransport({
        model: model.id,
        context,
        cwd: options.cwd ?? process.cwd(),
        signal: options.signal,
        sessionId: options.sessionId,
        ...(transport === "http" ? {
          contextWindow: model.contextWindow,
          continuePartial: true,
          modelRequestFieldsSchema,
          reasoning: useMinimumEffort ? thinkingConfig.efforts[0] : options.reasoning,
          disableReasoning: !useMinimumEffort && model.reasoning ? options.disableReasoning : undefined,
          forceReasoningOff: useMinimumEffort ? undefined : options.forceReasoningOff,
          // The transport owns each block and has already applied text and
          // signature updates; signatures and opaque data never become deltas.
          onReasoning({ type, block, delta }) {
            if (type === "start") {
              endText();
              endThinking();
              thinking = block;
              thinkingIndex = append(block);
              stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: message });
            } else if (type === "delta") {
              if (block === thinking && delta)
                stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: message });
            } else if (type === "end") {
              if (block === thinking) endThinking();
            } else if (type === "redacted") {
              endText();
              endThinking();
              append(block);
            }
          },
        } : {}),
        onText(delta) {
          if (!delta) return;
          endThinking();
          if (!text) {
            text = { type: "text", text: "" };
            textIndex = append(text);
            stream.push({ type: "text_start", contentIndex: textIndex, partial: message });
          }
          text.text += delta;
          stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: message });
        },
      });
      options.signal?.throwIfAborted();
      endText();
      endThinking();
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
      if (outcome.upstreamModel) message.upstreamModel = outcome.upstreamModel;
      if (outcome.stopDetails) message.stopDetails = outcome.stopDetails;
      message.stopReason = toolCalls.length ? "toolUse" : (outcome.stopReason ?? "stop");
      stream.push({ type: "done", reason: message.stopReason, message });
    } catch (error) {
      endText();
      endThinking();
      message.stopReason = options.signal?.aborted ? "aborted" : "error";
      const billedFailure = transport === "http" && message.stopReason === "error" &&
        error?.metered;
      if (transport === "http") {
        if (error?.stopDetails) message.stopDetails = error.stopDetails;
        if (error?.usage) {
          const { usage } = error;
          // Failed-attempt input counts can independently trigger host
          // compaction. Keep output and credits without that replay cue.
          const input = usage.input + usage.cacheRead + usage.cacheWrite;
          message.usage = billedFailure && model.contextWindow > 0 &&
            Math.max(usage.contextTokens ?? 0, input) > model.contextWindow
            ? { ...usage, input: 0, cacheRead: 0, cacheWrite: 0, contextTokens: undefined }
            : usage;
        }
        if (error?.upstreamModel) message.upstreamModel = error.upstreamModel;
        // Both OMP 18.22.1 and upstream classify "prompt is too long" as
        // context overflow, but an HTTP 429 status vetoes that text evidence.
        if (!error?.contextOverflow && !billedFailure && Number.isFinite(error?.status))
          message.errorStatus = error.status;
      }
      // OMP can replay context overflows too. Do not hand it any retry
      // evidence after billing, even when a distinct continuation overflowed.
      if (billedFailure)
        message.errorMessage = "Kiro did not finish the billed response. It was not replayed.";
      else if (error?.contextOverflow)
        message.errorMessage = error.message;
      else if (transport === "http" && !options.signal?.aborted && isTransientNetworkError(error))
        message.errorMessage = "Kiro HTTP network error: The socket connection was closed unexpectedly before the response completed.";
      else if (transport === "http" && isTlsError(error))
        message.errorMessage = "Kiro TLS certificate verification failed; check the approved CA configuration.";
      else
        message.errorMessage = error instanceof Error ? error.message : String(error);
      if (transport === "http" && !billedFailure && !error?.contextOverflow &&
          Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0)
        message.errorMessage += ` retry-after-ms=${Math.ceil(error.retryAfterMs)}`;
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      stream.end();
    }
  }
  void run();
  return stream;
}

function providerModels(models, transport, label) {
  return models.map(({ id, name, contextWindow, maxTokens, additionalModelRequestFieldsSchema, supportedInputTypes }) => {
    const thinking = transport === "http" ? kiroThinkingConfig(additionalModelRequestFieldsSchema) : undefined;
    return {
      id,
      name: `Kiro · ${label ? `${label} · ` : ""}${name}`,
      reasoning: Boolean(thinking),
      ...(thinking ? { thinking } : {}),
      input: transport === "http" && supportedInputTypes?.includes("IMAGE") ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // ACP omits numeric limits; HTTP uses advertised limits when supplied.
      contextWindow: contextWindow ?? 128000,
      maxTokens: maxTokens ?? 16000,
    };
  });
}

/** One account profile with its own auth, model catalog and native schemas. */
function pinnedProvider(target) {
  const authProvider = pinnedKiroAuth({
    authFile: target.authFile,
    profileArn: target.arn ?? undefined,
    useEnv: target.account === DEFAULT_ACCOUNT,
  });
  const schemas = new Map();
  let ids;
  let pending;
  const discover = () => {
    if (!pending) {
      const request = discoverHttpModels({ authProvider }).then((catalog) => {
        schemas.clear();
        for (const model of catalog)
          if (model.additionalModelRequestFieldsSchema !== undefined)
            schemas.set(model.id, model.additionalModelRequestFieldsSchema);
        ids = new Set(catalog.map((model) => model.id));
        return providerModels(catalog, "http", target.label);
      });
      pending = request;
      void request.finally(() => {
        if (pending === request) pending = undefined;
      }).catch(() => {});
    }
    return pending;
  };
  return {
    target,
    authProvider,
    discover,
    route: {
      runTurn: createHttpTransport({ authProvider, provider: target.provider }),
      async resolveModelSchema(id, signal) {
        // Host cache hits skip fetchDynamicModels in a new process.
        if (!ids) {
          if (signal) await abortableRequest(discover, signal);
          else await discover();
        }
        if (!ids.has(id))
          throw new Error(`This model is unavailable for Kiro ${target.label}. List its models with /kiro-models; no replacement model was selected.`);
        return schemas.get(id);
      },
    },
  };
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
  // Every Kiro provider shares one API; the model's provider selects its account route.
  const routes = new Map();
  const streamSimple = (model, context, options) =>
    streamKiro(model, context, options, transport, routes.get(model.provider));
  const providerConfig = (catalog) => ({
    baseUrl: "https://kiro-cli.invalid/",
    apiKey: "kiro-cli-managed-auth",
    api: `kiro-cli-${transport}`,
    ...catalog,
    streamSimple,
  });
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
  const registerProvider = (catalog) => pi.registerProvider(provider, providerConfig(catalog));
  routes.set(provider, { resolveModelSchema, runTurn: transport === "http" ? runHttpTurn : runTurn });
  const pinned = new Map();
  const pendingPinRefresh = new Set();
  const reconcilePinned = async (registry, signal) => {
    let targets;
    try {
      const { targets: routes } = kiroAccountTargets(await listKiroAccounts());
      targets = pinnedKiroTargets(routes);
    } catch {
      // An unreadable accounts directory keeps the current registrations.
      return;
    }
    signal?.throwIfAborted();
    const wanted = new Map(targets.map((target) => [target.provider, target]));
    for (const [name, entry] of pinned) {
      const next = wanted.get(name);
      if (next && next.authFile === entry.target.authFile && next.arn === entry.target.arn &&
          next.label === entry.target.label) {
        wanted.delete(name);
        continue;
      }
      pinned.delete(name);
      routes.delete(name);
      if (!next) {
        pendingPinRefresh.delete(name);
        pi.unregisterProvider(name);
      }
    }
    for (const target of wanted.values()) {
      const entry = pinnedProvider(target);
      pinned.set(target.provider, entry);
      routes.set(target.provider, entry.route);
      pi.registerProvider(target.provider, providerConfig({ fetchDynamicModels: entry.discover }));
      if (registry) pendingPinRefresh.add(target.provider);
    }
    if (!registry || !pendingPinRefresh.size) return;
    // Runtime registration installs the dynamic callbacks but does not load
    // them into OMP's available models. Restrict refresh to these providers.
    if (typeof registry.refreshDiscoverableProviders === "function") {
      await registry.refreshDiscoverableProviders([...pendingPinRefresh], "online");
      pendingPinRefresh.clear();
    } else {
      for (const name of pendingPinRefresh) {
        signal?.throwIfAborted();
        await registry.refreshProvider(name);
        pendingPinRefresh.delete(name);
      }
    }
  };
  let syncing = Promise.resolve();
  const syncPinnedProviders = (registry, signal) => {
    const reconcile = () => reconcilePinned(registry, signal);
    return (syncing = syncing.then(reconcile, reconcile));
  };
  const catalogFile = process.env.OMP_KIRO_MODEL_CATALOG_FILE;
  let models;
  if (transport === "http" && catalogFile !== undefined) {
    try {
      const auth = await readKiroAuth();
      models = rememberModels(await readKiroModelCatalog(catalogFile, { auth }), kiroCatalogAccountId(auth), catalogVersion);
      snapshotActive = true;
    } catch (error) {
      // Keep the snapshot registration offline even when this login is dead.
      // An explicit model refresh can adopt a replacement login.
      if (error?.code !== "credential_disabled") throw error;
      models = [];
      catalogAccountId = null;
      snapshotActive = true;
    }
  }
  // Startup snapshots remain authoritative until a profile change invalidates
  // their account binding; only then do we replace them with live discovery.
  registerProvider(models !== undefined ? { models } : { fetchDynamicModels: fetchModels });
  if (transport === "http") {
    // A host may discover every dynamic registration on its startup drain.
    // A default-account snapshot cannot seed other accounts; explicitly
    // reconcile those providers with /kiro-accounts when ready to go online.
    if (catalogFile === undefined) await syncPinnedProviders();
    registerKiroWebSearch(pi, {
      authProviderFor(model) {
        if (model?.api !== "kiro-cli-http" || model.provider === provider) return undefined;
        return pinned.get(model.provider)?.authProvider ?? (() => { throw unavailableAccount(); });
      },
    });
  }
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
      pinnedTarget: (name) => pinned.get(name),
      onAccountsChanged: syncPinnedProviders,
    },
  });
}
