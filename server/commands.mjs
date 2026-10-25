import { getKiroAuthStatus, loadKiroAuth } from "./auth.mjs";
import { closeSession, openKiro } from "./bridge.mjs";
import { discoverHttpModels } from "./http.mjs";
import { fetchKiroUsage } from "./usage.mjs";

export class KiroCommandError extends Error {
  constructor(message, { code = "command_failed", status } = {}) {
    super(message);
    this.name = "KiroCommandError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function checkTransport(transport) {
  if (transport !== "http" && transport !== "acp")
    throw new KiroCommandError("Kiro transport must be http or acp.", {
      code: "invalid_transport",
    });
}

export function getKiroCommands({ transport = "acp" } = {}) {
  checkTransport(transport);
  return [
    { name: "kiro", description: "Show Kiro commands and transport information", kind: "query" },
    {
      name: "kiro-status",
      description: "Check Kiro authentication and transport readiness",
      kind: "query",
    },
    {
      name: "kiro-models",
      description: "List the current Kiro model catalog",
      argumentHint: "[filter]",
      kind: "query",
    },
    {
      name: "kiro-usage",
      description: "Show managed Kiro account quota and credits",
      kind: "query",
    },
    {
      name: "kiro-model",
      description: "Select a Kiro model for this session",
      argumentHint: "<id>",
      kind: "action",
    },
    ...(transport === "acp"
      ? [
          {
            name: "kiro-reset",
            description: "Close this session's ACP connection; keep OMP history",
            kind: "action",
          },
        ]
      : []),
  ];
}

function singleLine(value) {
  return String(value).replace(/\p{Cc}/gu, " ");
}

function usageText(usage) {
  if (usage?.status !== "available")
    throw new KiroCommandError(
      "Kiro account usage is unavailable; check /kiro-status and try again.",
    );
  const lines = [];
  if (usage.planLabel) lines.push(`Plan: ${singleLine(usage.planLabel)}`);
  for (const window of usage.windows ?? []) {
    const values = [];
    if (Number.isFinite(window.usedPct)) values.push(`${window.usedPct}% used`);
    if (Number.isFinite(window.remainingPct)) values.push(`${window.remainingPct}% remaining`);
    if (window.resetsAt) values.push(`resets ${singleLine(window.resetsAt)}`);
    lines.push(`${singleLine(window.label)}: ${values.join("; ") || "quota not reported"}`);
  }
  for (const balance of usage.balances ?? []) {
    const values = [];
    if (Number.isFinite(balance.used)) values.push(`${balance.used} used`);
    if (Number.isFinite(balance.remaining)) values.push(`${balance.remaining} remaining`);
    if (Number.isFinite(balance.limit)) values.push(`${balance.limit} limit`);
    if (balance.resetsAt) values.push(`resets ${singleLine(balance.resetsAt)}`);
    lines.push(
      `${singleLine(balance.label)} (${singleLine(balance.unit)}): ${values.join("; ") || "balance not reported"}`,
    );
  }
  for (const detail of usage.details ?? [])
    lines.push(`${singleLine(detail.label)}: ${singleLine(detail.value)}`);
  return (
    lines.join("\n") ||
    "The account returned no quota values. Unknown quotas are not treated as zero."
  );
}

function safeFailure(error, transport, signal) {
  if (signal?.aborted) return signal.reason;
  if (error instanceof KiroCommandError) return error;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return error;
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  if (
    error?.name === "KiroAuthError" ||
    ["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_EXPIRED"].includes(error?.code) ||
    status === 401 ||
    status === 403
  )
    return new KiroCommandError(
      "Kiro authentication is missing, expired, or rejected. Run omp-kiro login (or import-cli) for the selected auth store, then try again.",
      { code: "auth_required", status },
    );
  if (error?.code === "CANCELLED") return new DOMException("Kiro command cancelled.", "AbortError");
  if (error?.code === "TIMEOUT")
    return new KiroCommandError(
      "Kiro metadata request timed out. Check your connection and try again.",
      { code: "request_timeout" },
    );
  if (status === 429 || error?.code === "RATE_LIMITED")
    return new KiroCommandError(
      "Kiro rejected this request due to a usage limit. Check /kiro-usage and retry after the limit resets.",
      { code: "usage_limit", status },
    );
  if (transport === "acp")
    return new KiroCommandError(
      "Kiro CLI metadata could not be read. Check that kiro-cli (or OMP_KIRO_COMMAND) is installed and signed in with kiro-cli login.",
      { code: "acp_unavailable", status },
    );
  return new KiroCommandError(
    `Kiro account metadata could not be read${status ? ` (HTTP ${status})` : ""}. Check /kiro-status and your network connection, then try again.`,
    { code: "metadata_unavailable", status },
  );
}

async function acpCatalog({ signal, services }) {
  const connection = await (services.openKiro ?? openKiro)({ signal });
  try {
    signal?.throwIfAborted();
    const models = connection.session.models?.availableModels;
    if (
      !Array.isArray(models) ||
      models.some(
        (model) =>
          typeof model.modelId !== "string" || !model.modelId || typeof model.name !== "string",
      )
    )
      throw new KiroCommandError(
        "Kiro CLI returned an invalid model catalog. Update Kiro CLI and try again.",
        { code: "invalid_catalog" },
      );
    return models.map(({ modelId, name }) => ({ id: modelId, name }));
  } finally {
    await connection.close();
  }
}

/** Account queries only: never submits a prompt or changes the host's session. */
export async function executeKiroQuery(
  name,
  args = "",
  { transport = "acp", authFile, signal, authProvider, services = {} } = {},
) {
  checkTransport(transport);
  signal?.throwIfAborted();
  name = String(name).replace(/^\//, "");
  args = String(args).trim();
  const command = getKiroCommands({ transport }).find(
    (item) => item.name === name && item.kind === "query",
  );
  if (!command)
    throw new KiroCommandError("Unknown Kiro query. Use /kiro to list supported commands.", {
      code: "unknown_command",
    });
  if (name !== "kiro-models" && args)
    throw new KiroCommandError(`/${name} does not accept arguments.`, {
      code: "invalid_arguments",
    });
  if (name === "kiro")
    return {
      title: "Kiro commands",
      text: [
        `Transport: ${transport === "http" ? "direct HTTP (no Kiro CLI required)" : "persistent Kiro CLI ACP"}`,
        ...getKiroCommands({ transport }).map(
          (item) =>
            `/${item.name}${item.argumentHint ? ` ${item.argumentHint}` : ""} — ${item.description}`,
        ),
        "These commands do not start model generation. The host owns conversation history, tools, approvals, and compaction.",
        ...(transport === "acp"
          ? ["Usage reads the separate managed HTTP account; it does not identify the CLI account."]
          : []),
      ].join("\n"),
    };
  try {
    if (name === "kiro-status") {
      if (transport === "acp") {
        const models = await acpCatalog({ signal, services });
        return {
          title: "Kiro status",
          text: `Transport: Kiro CLI ACP\nCLI metadata handshake: ready (${models.length} models)\nNo generation was requested. Usage uses the separate managed HTTP account.`,
        };
      }
      const status = await (services.getKiroAuthStatus ?? getKiroAuthStatus)({ authFile, signal });
      signal?.throwIfAborted();
      return {
        title: "Kiro status",
        text: [
          "Transport: direct HTTP (no Kiro CLI required)",
          `Authentication: ${!status.loggedIn ? "signed out" : status.expired ? "expired" : "signed in"}`,
          ...(status.loggedIn
            ? [
                `Login type: ${singleLine(status.kind)}${status.provider ? ` (${singleLine(status.provider)})` : ""}`,
                `Expires: ${singleLine(status.expiresAt)}`,
                `Refresh credential: ${status.refreshable ? "available" : "not available"}`,
              ]
            : []),
          ...(!status.loggedIn || status.expired
            ? [
                "Run omp-kiro login (or import-cli) for the selected auth store. Status never refreshes or signs in automatically.",
              ]
            : []),
          "This is local credential status, not a network or generation check.",
        ].join("\n"),
      };
    }
    if (name === "kiro-models") {
      const models =
        transport === "acp"
          ? await acpCatalog({ signal, services })
          : await (services.discoverHttpModels ?? discoverHttpModels)({
              signal,
              authProvider: authProvider ?? ((options) => loadKiroAuth({ ...options, authFile })),
            });
      signal?.throwIfAborted();
      const filter = args.toLowerCase();
      const selected = models.filter((model) =>
        `${model.id} ${model.name}`.toLowerCase().includes(filter),
      );
      return {
        title: "Kiro models",
        text: selected.length
          ? selected
              .map((model) => `${singleLine(model.id)} — ${singleLine(model.name)}`)
              .join("\n")
          : "No Kiro models match this filter. Use /kiro-models without a filter to see the full catalog.",
      };
    }
    const usage = await (services.fetchKiroUsage ?? fetchKiroUsage)({
      authFile,
      signal,
      ...(authProvider ? { authProvider } : {}),
    });
    signal?.throwIfAborted();
    return {
      title: "Kiro usage",
      text: `${transport === "acp" ? "Source: managed HTTP account (may differ from Kiro CLI login)\n" : ""}${usageText(usage)}`,
    };
  } catch (error) {
    throw safeFailure(error, name === "kiro-usage" ? "http" : transport, signal);
  }
}

/** Register real host actions separately from the reusable read-only queries. */
export function registerKiroCommands(pi, { transport = "acp", authFile, services = {} } = {}) {
  const commands = getKiroCommands({ transport });
  const pending = new Set();
  for (const event of ["session_shutdown", "session_before_switch"])
    pi.on(event, () => {
      for (const controller of pending) controller.abort();
    });
  for (const command of commands)
    pi.registerCommand(command.name, {
      description: `${command.description}${command.argumentHint ? ` (${command.argumentHint})` : ""}`,
      async handler(args, ctx) {
        const controller = new AbortController();
        pending.add(controller);
        const signal = AbortSignal.any([
          controller.signal,
          ...(ctx.signal ? [ctx.signal] : []),
        ]);
        let result;
        try {
          signal.throwIfAborted();
          if (command.kind === "query") {
            result = await executeKiroQuery(command.name, args, {
              transport,
              authFile,
              signal,
              services,
            });
            if (command.name === "kiro-status" && ctx.model)
              result.text += `\nSession model: ${singleLine(ctx.model.provider)}/${singleLine(ctx.model.id)}`;
          } else {
            if (!ctx.isIdle())
              throw new KiroCommandError(
                "Wait for the current turn to finish before changing the Kiro connection or model.",
                { code: "session_busy" },
              );
            if (command.name === "kiro-reset") {
              if (String(args).trim())
                throw new KiroCommandError("/kiro-reset does not accept arguments.", {
                  code: "invalid_arguments",
                });
              await (services.closeSession ?? closeSession)(ctx.sessionManager.getSessionId());
              result = {
                title: "Kiro connection reset",
                text: "The ACP connection is closed. OMP history is unchanged; the next turn reconnects with that history.",
              };
            } else {
              const id = String(args).trim();
              if (!id || /\s/.test(id))
                throw new KiroCommandError("Usage: /kiro-model <id>. List IDs with /kiro-models.", {
                  code: "invalid_arguments",
                });
              const provider = transport === "http" ? "kiro-http" : "kiro-cli";
              await ctx.modelRegistry.refreshProvider(provider);
              signal.throwIfAborted();
              const model = ctx.modelRegistry.find(provider, id);
              if (!model)
                throw new KiroCommandError(
                  "That Kiro model is not in the current host catalog. List IDs with /kiro-models.",
                  { code: "unknown_model" },
                );
              if (!(await pi.setModel(model)))
                throw new KiroCommandError(
                  "OMP could not select the Kiro model. Check the provider configuration and authentication.",
                  { code: "model_unavailable" },
                );
              result = {
                title: "Kiro model selected",
                text: `${provider}/${singleLine(model.id)} is now the session model. No generation was requested.`,
              };
            }
          }
          signal.throwIfAborted();
        } catch (error) {
          const failure = safeFailure(error, transport, signal);
          result = {
            title: "Kiro command failed",
            text:
              failure?.name === "TimeoutError"
                ? "Kiro metadata request timed out. Check your connection and try again."
                : signal.aborted || failure?.name === "AbortError"
                  ? "Kiro command cancelled."
                  : failure.message,
          };
        } finally {
          pending.delete(controller);
        }
        pi.sendMessage(
          {
            customType: "kiro-command",
            content: `${result.title}\n\n${result.text}`,
            display: true,
          },
          { triggerTurn: false },
        );
      },
    });
}
