import { getKiroAuthStatus, loadKiroAuth } from "./auth.mjs";
import { kiroTargets, listKiroAccounts, pinnedKiroTargets } from "./accounts.mjs";
import { closeSession, openKiro } from "./bridge.mjs";
import { discoverHttpModels } from "./http.mjs";
import { fetchKiroUsage } from "./usage.mjs";
import { fetchKiroProfileUsage, listKiroProfiles, selectKiroProfile } from "./profiles.mjs";

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

export function getKiroCommands({ transport = "http" } = {}) {
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
    ...(transport === "http"
      ? [
          {
            name: "kiro-profiles",
            description: "List Kiro profiles and their reported plans and quotas",
            kind: "query",
          },
          {
            name: "kiro-profile",
            description: "Change the managed Kiro profile for all sessions sharing this auth store",
            argumentHint: "[exact-name-or-arn]",
            kind: "action",
          },
          {
            name: "kiro-accounts",
            description: "List signed-in Kiro accounts, their profiles and pinned model providers",
            kind: "query",
          },
        ]
      : []),
    {
      name: "kiro-model",
      description: "Select a Kiro model for this session",
      argumentHint: "<id|provider/id>",
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

function profileListText({ selectedArn, profiles }, { usage = false } = {}) {
  const lines = [
    `Selected profile: ${selectedArn ? singleLine(selectedArn) : "none (listing does not select one)"}`,
    "Profiles represent service/account context. API values do not establish whether credit pools are independent or shared; do not sum profile quotas.",
    "Selection persists for all sessions sharing this managed auth store.",
  ];
  for (const profile of profiles) {
    lines.push(
      "",
      `${profile.arn === selectedArn ? "* " : ""}${singleLine(profile.name)} — ${singleLine(profile.arn)}`,
      `Region: ${singleLine(profile.region)}; account: ${singleLine(profile.accountId)}`,
    );
    if (usage) {
      if (profile.usage?.status === "available") lines.push(usageText(profile.usage));
      else lines.push(`Usage: unknown, not zero.${profile.error ? ` ${singleLine(profile.error)}` : ""}`);
    }
  }
  if (!profiles.length) lines.push("No profiles were reported for this login.");
  lines.push(
    "",
    "Switch while idle with /kiro-profile <exact-name-or-arn>. No generation is requested.",
  );
  return lines.join("\n");
}

function accountsText(accounts) {
  const pinned = new Set(pinnedKiroTargets(kiroTargets(accounts)).map((target) => target.provider));
  const lines = ["Each account is a separate login; each of its profiles can have its own model provider."];
  for (const account of accounts) {
    lines.push("", `${account.name} — ${singleLine(account.authFile)}`);
    if (account.error) {
      lines.push(`Status: unreadable. ${singleLine(account.error)}`);
      continue;
    }
    const { status } = account;
    if (!status.loggedIn) {
      lines.push("Status: signed out");
      continue;
    }
    lines.push(`Status: ${status.expired
      ? status.refreshable ? "expired; refreshes on next use" : "expired; sign in again"
      : "signed in"} (${singleLine(status.provider)}, ${singleLine(status.kind)})`);
    const targets = kiroTargets([account]);
    if (!account.catalog)
      lines.push(`Profiles: not listed yet; run omp-kiro auth profiles --account ${account.name}.`);
    else if (!targets.length) lines.push("Profiles: none usable over Kiro HTTP.");
    for (const target of targets)
      lines.push(
        `${pinned.has(target.provider) ? `${target.provider}/…` : "kiro-http/…"} — ${singleLine(target.name ?? target.arn)}${target.arn === account.selectedArn ? " (saved selection)" : ""}`,
      );
  }
  lines.push(
    "",
    "kiro-http/… follows the default account's saved profile (/kiro-profile). Pinned providers exist once a named account is signed in or one account has several profiles; pick their models per session. Add an account with omp-kiro login --account <name>.",
  );
  return lines.join("\n");
}

/** One unique, single-line label per profile, mapped back to that profile (and its ARN). */
function profileChoices({ selectedArn, profiles }) {
  const base = profiles.map((profile) =>
    [profile.name, profile.region, profile.accountId]
      .map((part) => singleLine(part ?? "").trim())
      .filter(Boolean)
      .join(" · "),
  );
  const choices = new Map();
  profiles.forEach((profile, index) => {
    const label = base.indexOf(base[index]) === base.lastIndexOf(base[index])
      ? base[index]
      : `${base[index]} · ${singleLine(profile.arn)}`;
    choices.set(`${label}${profile.arn === selectedArn ? " (current)" : ""}`, profile);
  });
  return choices;
}

function requireIdle(ctx) {
  if (!ctx.isIdle())
    throw new KiroCommandError(
      "Wait for the current turn to finish before changing the Kiro connection, model, or profile.",
      { code: "session_busy" },
    );
}

function safeFailure(error, transport, signal) {
  if (signal?.aborted) return signal.reason;
  if (error instanceof KiroCommandError) return error;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return error;
  const profileFailures = {
    invalid_profile: "Provide an exact Kiro profile ARN or unique profile name. Use /kiro-profiles to list profiles.",
    unknown_profile: "The requested Kiro profile is not available to this login. Use /kiro-profiles to list profiles.",
    ambiguous_profile: "The Kiro profile name is ambiguous; select an exact profile ARN.",
    unsupported_profile_region: "The requested Kiro profile uses an unsupported region.",
    credential_changed: "The managed credentials changed while selecting the profile. The newer login was preserved; list profiles and try again.",
  };
  if (Object.hasOwn(profileFailures, error?.code))
    return new KiroCommandError(profileFailures[error.code], { code: error.code });
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
  { transport = "http", authFile, signal, authProvider, services = {} } = {},
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
    if (name === "kiro-profiles") {
      const profiles = await (services.fetchKiroProfileUsage ?? fetchKiroProfileUsage)({
        authFile,
        signal,
      });
      signal?.throwIfAborted();
      return { title: "Kiro profiles", text: profileListText(profiles, { usage: true }) };
    }
    if (name === "kiro-accounts") {
      const accounts = await (services.listKiroAccounts ?? listKiroAccounts)({ authFile });
      signal?.throwIfAborted();
      return { title: "Kiro accounts", text: accountsText(accounts) };
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
export function registerKiroCommands(pi, { transport = "http", authFile, services = {} } = {}) {
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
        let profileChanged;
        let profileNotice;
        // Shared by `/kiro-profile <selector>` and the no-argument picker.
        const selectProfile = async (selector) => {
          profileChanged = await (services.selectKiroProfile ?? selectKiroProfile)(selector, {
            authFile,
            signal,
          });
          // Persistence has committed: invalidate local schemas even if this
          // command is cancelled before the host catalog can be refreshed.
          profileNotice = await services.onProfileChanged?.(profileChanged);
          signal.throwIfAborted();
          await ctx.modelRegistry.refreshProvider("kiro-http");
          signal.throwIfAborted();
          let modelText = "Use /kiro-models and /kiro-model <id> to choose a model.";
          if (ctx.model?.provider === "kiro-http") {
            const model = ctx.modelRegistry.find("kiro-http", ctx.model.id);
            if (model) {
              if (!(await pi.setModel(model)))
                throw new KiroCommandError(
                  "OMP could not refresh the current Kiro session model. Use /kiro-model <id> before continuing.",
                  { code: "model_unavailable" },
                );
              modelText = `The current model, kiro-http/${singleLine(model.id)}, was refreshed.`;
            } else {
              modelText = "The previous session model is unavailable for this profile. Use /kiro-models and /kiro-model <id> before continuing; no unrelated model was selected.";
            }
          }
          return {
            title: "Kiro profile selected",
            text: [
              `${singleLine(profileChanged.name)} — ${singleLine(profileChanged.arn)}`,
              "Selection is persisted for all sessions sharing this managed auth store. No generation was requested.",
              ...(profileNotice ? [profileNotice] : []),
              modelText,
            ].join("\n"),
          };
        };
        try {
          signal.throwIfAborted();
          if (command.kind === "query") {
            // A pinned session model scopes status, models and usage to its account profile.
            const pinned = ["kiro-status", "kiro-models", "kiro-usage"].includes(command.name)
              ? services.pinnedTarget?.(ctx.model?.provider)
              : undefined;
            result = await executeKiroQuery(command.name, args, {
              transport,
              authFile: pinned ? pinned.target.authFile : authFile,
              ...(pinned ? { authProvider: pinned.authProvider } : {}),
              signal,
              services,
            });
            if (pinned)
              result.text += `\nAccount profile: ${singleLine(pinned.target.label)} (${pinned.target.provider})`;
            if (command.name === "kiro-status" && ctx.model)
              result.text += `\nSession model: ${singleLine(ctx.model.provider)}/${singleLine(ctx.model.id)}`;
          } else if (command.name === "kiro-profile" && !String(args).trim()) {
            const interactive = ctx.hasUI === true && typeof ctx.ui?.select === "function";
            // Picking changes shared state: refuse before any dialog is shown.
            if (interactive) requireIdle(ctx);
            const profiles = await (services.listKiroProfiles ?? listKiroProfiles)({
              authFile,
              signal,
            });
            signal.throwIfAborted();
            if (!interactive || !profiles.profiles.length) {
              result = { title: "Kiro profile selection", text: profileListText(profiles) };
            } else {
              const choices = profileChoices(profiles);
              const label = await ctx.ui.select(
                "Select a Kiro profile (applies to all sessions sharing this auth store)",
                [...choices.keys()],
                { signal },
              );
              signal.throwIfAborted();
              const profile = choices.get(label);
              if (label === undefined)
                result = {
                  title: "Kiro profile unchanged",
                  text: "Selection cancelled. The Kiro profile is unchanged.",
                };
              else if (!profile)
                throw new KiroCommandError(
                  "The chosen option does not match a listed Kiro profile. The profile is unchanged.",
                  { code: "invalid_profile" },
                );
              else if (profile.arn === profiles.selectedArn)
                result = {
                  title: "Kiro profile unchanged",
                  text: `${singleLine(profile.name)} — ${singleLine(profile.arn)} is already selected. Nothing was changed.`,
                };
              else {
                // The dialog may have stayed open while a turn started.
                requireIdle(ctx);
                result = await selectProfile(profile.arn);
              }
            }
          } else {
            requireIdle(ctx);
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
            } else if (command.name === "kiro-profile") {
              result = await selectProfile(String(args).trim());
            } else {
              const value = String(args).trim();
              if (!value || /\s/.test(value))
                throw new KiroCommandError("Usage: /kiro-model <id|provider/id>. List IDs with /kiro-models.", {
                  code: "invalid_arguments",
                });
              const unpinned = transport === "http" ? "kiro-http" : "kiro-cli";
              // Model IDs may contain "/": only a known Kiro provider prefix qualifies one.
              const prefix = value.slice(0, Math.max(value.indexOf("/"), 0));
              const qualified = prefix === unpinned || Boolean(prefix && services.pinnedTarget?.(prefix));
              const provider = qualified ? prefix : unpinned;
              const id = qualified ? value.slice(prefix.length + 1) : value;
              if (provider === unpinned) await services.onBeforeModelRefresh?.();
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
          if (["kiro-accounts", "kiro-profiles", "kiro-profile"].includes(command.name))
            // Listing saved this store's catalog; register newly visible account profiles.
            await services.onAccountsChanged?.();
          signal.throwIfAborted();
        } catch (error) {
          const failure = safeFailure(error, transport, signal);
          result = {
            title: profileChanged ? "Kiro profile selected; host refresh incomplete" : "Kiro command failed",
            text:
              `${profileChanged ? `Selection already changed to ${singleLine(profileChanged.name)} (${singleLine(profileChanged.arn)}) for all sessions sharing this managed auth store. No generation was requested. The host catalog/current model refresh did not complete; use /kiro-models and /kiro-model <id> before continuing.\n${profileNotice ? `${profileNotice}\n` : ""}` : ""}` +
              (failure?.name === "TimeoutError"
                ? "Kiro metadata request timed out. Check your connection and try again."
                : signal.aborted || failure?.name === "AbortError"
                  ? "Kiro command cancelled."
                  : failure.message),
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
