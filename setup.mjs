#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { buildPaseoPlugin } from "./build-paseo.mjs";
import { discoverModels } from "./server/bridge.mjs";
import { discoverHttpModels } from "./server/http.mjs";
import { authFilePath, loadKiroAuth } from "./server/auth.mjs";

const packageDir = dirname(fileURLToPath(import.meta.url));

function absolutePath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(value);
}

function object(value, name) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object; no configuration was replaced.`);
  }
  return value;
}

async function readConfig(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function prepareProfile({ existingValue, profileId, command, profileEnv, catalog, provider, label }) {
  const existing = object(existingValue, `agents.providers.${profileId}`);
  const existingEnv = object(existing.env, `agents.providers.${profileId}.env`);
  if (
    existingValue !== undefined &&
    (existing.extends !== "omp" ||
      (provider === "kiro-http"
        ? existingEnv.OMP_KIRO_TRANSPORT !== "http"
        : existing.label !== label || (existingEnv.OMP_KIRO_TRANSPORT !== undefined && existingEnv.OMP_KIRO_TRANSPORT !== "acp")) ||
      (existing.command && !isDeepStrictEqual(existing.command, command)))
  ) {
    throw new Error(
      `Provider ${profileId} already has a different configuration. Choose another --profile; the existing provider and its history were not changed.`,
    );
  }
  for (const [key, value] of Object.entries(profileEnv)) {
    if (existingEnv[key] !== undefined && existingEnv[key] !== value) {
      throw new Error(
        `Provider ${profileId} already has a different ${key}. Choose another --profile or use its existing environment.`,
      );
    }
  }
  if (existing.models !== undefined && !Array.isArray(existing.models)) {
    throw new Error(`agents.providers.${profileId}.models must be an array.`);
  }
  const models = [...(existing.models ?? [])];
  for (const model of catalog) {
    const id = `${provider}/${model.id}`;
    if (!models.some((entry) => entry.id === id)) models.push({ id, label: model.name });
  }
  return {
    extends: "omp",
    label,
    enabled: true,
    ...existing,
    command,
    ...(Object.keys(existingEnv).length || Object.keys(profileEnv).length
      ? { env: { ...existingEnv, ...profileEnv } }
      : {}),
    models,
  };
}

export function prepareHttpProfile(existingValue, authFile, {
  profileId = "kiro-omp-http",
  command = ["omp"],
  profileEnv = {},
  catalog = [],
} = {}) {
  return prepareProfile({
    existingValue,
    profileId,
    command,
    profileEnv: { ...profileEnv, OMP_KIRO_TRANSPORT: "http", OMP_KIRO_AUTH_FILE: authFile },
    catalog,
    provider: "kiro-http",
    label: "Kiro HTTP (OMP)",
  });
}

export function prepareUsageInstall(config, enablePlugins = false) {
  if (config.pluginsEnabled !== true && !enablePlugins) {
    throw new Error(
      "External Passession plugins are disabled. Re-run with --enable-plugins only if you trust unsandboxed plugin code to access this machine.",
    );
  }
  const plugins = object(config.plugins, "plugins");
  const installed = plugins["omp-kiro"];
  if (installed !== undefined) {
    object(installed, "plugins.omp-kiro");
    if (
      installed.source !== "directory" ||
      typeof installed.path !== "string" ||
      resolve(installed.path) !== packageDir
    ) {
      throw new Error(
        "omp-kiro is installed from another source. Update that installation explicitly; no source or settings were replaced.",
      );
    }
  }
  return {
    installed,
    enableExisting: installed?.enabled === false && enablePlugins,
    reloadExisting: installed !== undefined && installed.enabled !== false,
  };
}

export function requireNativePaseoVersion(output) {
  const match = /^paseo\s+(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?\s*$/i.exec(output.trim());
  const version = match?.slice(1).map(Number);
  if (!version || !(version[0] > 0 || version[1] > 13 || (version[1] === 13 && version[2] >= 13))) {
    throw new Error(
      "The native usage plugin requires Passession (paseo CLI and daemon) 0.13.13 or newer. Upgrade the host before setup; no configuration was changed.",
    );
  }
}

async function saveConfig({ configPath, original, next }) {
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  if (contents === original) return;
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    const mode = original === null ? 0o600 : (await stat(configPath)).mode & 0o777;
    await writeFile(temporary, contents, { flag: "wx", mode });
    if ((await readConfig(configPath)) !== original) {
      throw new Error("Passession config changed during setup; rerun to merge its latest contents.");
    }
    await rename(temporary, configPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function paseo(command, args) {
  const child = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(
      `Paseo ${args[0]} failed (${child.signal || child.status}): ${child.stderr.trim() || "check paseo plugin logs omp-kiro"}`,
    );
  return child.stdout;
}

async function installUsage({ values, configPath, config, profileId, profile, previous }) {
  const command = values["paseo-command"];
  const home = dirname(configPath);
  const { installed } = prepareUsageInstall(config, values["enable-plugins"]);
  await buildPaseoPlugin();
  if (!installed) paseo(command, ["plugin", "install", packageDir, "--home", home, "--json"]);
  const original = await readConfig(configPath);
  const latest = object(original === null ? {} : JSON.parse(original), "config.json");
  const latestAgents = object(latest.agents, "agents");
  const latestProviders = object(latestAgents.providers, "agents.providers");
  if (profileId && !isDeepStrictEqual(latestProviders[profileId], previous)) {
    throw new Error(`The ${profileId} provider changed during setup. Re-run to merge the latest settings.`);
  }
  const plan = prepareUsageInstall(latest, values["enable-plugins"]);
  if (!plan.installed) throw new Error("The plugin installation changed during setup; rerun setup.");
  await saveConfig({
    configPath,
    original,
    next: {
      ...latest,
      ...(values["enable-plugins"] ? {
        pluginsEnabled: true,
        plugins: {
          ...object(latest.plugins, "plugins"),
          "omp-kiro": { ...plan.installed, enabled: true },
        },
      } : {}),
      ...(profileId ? {
        agents: { ...latestAgents, providers: { ...latestProviders, [profileId]: profile } },
      } : {}),
    },
  });
  paseo(command, ["daemon", "reload", "--home", home, "--json"]);
  if (plan.enableExisting || (installed && plan.reloadExisting)) {
    paseo(command, ["plugin", plan.enableExisting ? "enable" : "reload", "omp-kiro", "--home", home, "--json"]);
  }
  console.log("Installed the native Kiro account-usage source. OMP remains the coding-agent harness.");
  if (plan.installed.enabled === false && !plan.enableExisting) {
    console.log("The existing plugin remains disabled. To trust and enable it, rerun with --usage-only --enable-plugins.");
  }
  console.log(`Usage: paseo usage ls --refresh --home ${JSON.stringify(home)}`);
  console.log("Global usage uses the daemon's OMP_KIRO_AUTH_FILE/XDG/HOME environment; session usage uses that OMP profile's environment. Align custom auth stores explicitly.");
  console.log("Configuration/plugin reload only; setup did not restart the daemon or remove session history.");
}

export async function runSetup(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "paseo-home": { type: "string" },
      "omp-agent-dir": { type: "string" },
      "omp-command": { type: "string", default: "omp" },
      profile: { type: "string" },
      http: { type: "boolean" },
      "usage-only": { type: "boolean" },
      "paseo-command": { type: "string", default: "paseo" },
      "auth-file": { type: "string" },
      "enable-plugins": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(`Usage: node setup.mjs --paseo-home <directory> [options]

  --paseo-home <directory>    Passession config directory (or PASEO_HOME; required)
  --omp-agent-dir <directory> OMP agent directory (or PI_CODING_AGENT_DIR)
  --omp-command <executable>  OMP executable, not shell arguments (default: omp)
  --profile <id>             OMP profile ID (default: kiro-omp / kiro-omp-http)
  --http                     Set up OMP HTTP profile plus native account usage
  --usage-only               Install only usage; no OMP install, discovery, or auth refresh
  --auth-file <path>          HTTP profile's managed auth store
  --enable-plugins           Trust unsandboxed plugins; enable global switch and this plugin
  --paseo-command <executable> Paseo CLI executable (default: paseo)

Requires Node.js 22.13+. Native usage requires Passession 0.13.13+ and Rust 1.93+.
HTTP profiles require OMP and managed Kiro login, not Kiro CLI.
ACP requires OMP and an authenticated Kiro CLI login.
OMP_KIRO_COMMAND selects the ACP executable. OMP_KIRO_TRANSPORT=http selects --http.
Existing settings, disabled states, unrelated providers, and history are retained.
No daemon restart is sent. Custom global usage auth must match the daemon environment.`);
    return;
  }

  const paseoHome = values["paseo-home"] || process.env.PASEO_HOME;
  if (!paseoHome) throw new Error("Pass --paseo-home <directory> or set PASEO_HOME explicitly.");
  if (values["usage-only"] && (values.http || values.profile || values["auth-file"] || values["omp-agent-dir"])) {
    throw new Error("--usage-only does not configure an OMP profile; omit --http, --profile, --auth-file, and --omp-agent-dir. Custom global auth follows the daemon environment.");
  }
  const transport = values.http ? "http" : process.env.OMP_KIRO_TRANSPORT || "acp";
  if (!values["usage-only"] && !["acp", "http"].includes(transport)) {
    throw new Error("OMP_KIRO_TRANSPORT must be acp or http.");
  }
  const configPath = join(absolutePath(paseoHome), "config.json");
  const original = await readConfig(configPath);
  const config = object(original === null ? {} : JSON.parse(original), "config.json");
  const agents = object(config.agents, "agents");
  const providers = object(agents.providers, "agents.providers");
  const withUsage = values["usage-only"] || transport === "http";
  if (withUsage) {
    prepareUsageInstall(config, values["enable-plugins"]);
    requireNativePaseoVersion(paseo(values["paseo-command"], ["--version"]));
    const status = JSON.parse(paseo(values["paseo-command"], [
      "daemon", "status", "--home", dirname(configPath), "--json",
    ]));
    if (typeof status.daemonVersion !== "string") {
      throw new Error("Cannot verify the selected running daemon. Start Passession and rerun setup; no configuration was changed.");
    }
    requireNativePaseoVersion(`paseo ${status.daemonVersion}`);
  }
  if (values["usage-only"]) {
    await installUsage({ values, configPath, config });
    return;
  }
  if (!withUsage && (values["auth-file"] || values["enable-plugins"])) {
    throw new Error("--auth-file and --enable-plugins apply only to --http or --usage-only.");
  }
  const profileId = values.profile ?? (transport === "http" ? "kiro-omp-http" : "kiro-omp");
  if (
    !/^[a-z][a-z0-9-]*$/.test(profileId) ||
    ["claude", "codex", "copilot", "opencode", "pi", "omp"].includes(profileId)
  ) {
    throw new Error("--profile must be a custom provider ID matching [a-z][a-z0-9-]*.");
  }
  const ompCommand = values["omp-command"].includes("/")
    ? absolutePath(values["omp-command"])
    : values["omp-command"];
  if (!ompCommand) throw new Error("--omp-command must name an executable.");
  const previous = providers[profileId];
  const previousEnv = object(previous?.env, `agents.providers.${profileId}.env`);
  const env = { ...process.env, ...previousEnv };
  const agentDir = values["omp-agent-dir"] || env.PI_CODING_AGENT_DIR;
  if (agentDir) env.PI_CODING_AGENT_DIR = absolutePath(agentDir);
  const profileEnv = { OMP_KIRO_TRANSPORT: "acp" };
  for (const key of [
    "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "OMP_KIRO_COMMAND", "OMP_KIRO_AUTH_FILE",
  ]) {
    if (env[key]) profileEnv[key] = env[key];
  }
  let authFile;
  if (transport === "http") {
    authFile = authFilePath(values["auth-file"] ? absolutePath(values["auth-file"]) : undefined, env);
    profileEnv.OMP_KIRO_TRANSPORT = "http";
    profileEnv.OMP_KIRO_AUTH_FILE = authFile;
  }
  const provider = transport === "http" ? "kiro-http" : "kiro-cli";
  const prepare = (catalog) => transport === "http"
    ? prepareHttpProfile(previous, authFile, { profileId, command: [ompCommand], profileEnv, catalog })
    : prepareProfile({
      existingValue: previous, profileId, command: [ompCommand], profileEnv, catalog, provider,
      label: "Kiro (OMP)",
    });
  // Validate conflicts before discovery can refresh credentials or invoke Kiro.
  prepare([]);
  const catalog = transport === "http"
    ? await discoverHttpModels({ authProvider: (options) => loadKiroAuth({ ...options, authFile }) })
    : await discoverModels();
  if (!catalog.length) throw new Error("Kiro returned an empty model catalog; no configuration was changed.");
  const profile = prepare(catalog);
  const installed = spawnSync(ompCommand, ["install", packageDir], {
    env: { ...env, ...profileEnv }, stdio: "inherit",
  });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) {
    throw new Error(`OMP extension installation failed (${installed.signal || installed.status}); Passession configuration was not changed.`);
  }
  if (withUsage) {
    await installUsage({ values, configPath, config, profileId, profile, previous });
  } else {
    await saveConfig({ configPath, original, next: {
      ...config, agents: { ...agents, providers: { ...providers, [profileId]: profile } },
    } });
    console.log(`Reload configuration without restarting: paseo daemon reload --home ${JSON.stringify(dirname(configPath))}`);
    console.log("ACP setup did not reload or restart a daemon.");
  }
  console.log(`Registered ${profileId} (${profile.label}) in ${configPath}.`);
  console.log(`Models: ${catalog.map((model) => `${provider}/${model.id}`).join(", ")}`);
  console.log(`Standalone: ${transport === "http" ? `OMP_KIRO_TRANSPORT=http OMP_KIRO_AUTH_FILE=${JSON.stringify(authFile)} ` : ""}${JSON.stringify(ompCommand)} --model ${JSON.stringify(`${provider}/${catalog[0].id}`)}`);
  console.log("Use the same OMP environment for standalone sessions. Keep this checkout in place: OMP and the usage plugin link the local package.");
  if (profile.enabled === false) console.log("The existing OMP profile remains disabled; enable it explicitly to show it in Passession.");
  console.log(`Then select ${profile.label} in Passession. OMP owns tools, approvals, subagents, compaction, and history.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSetup().catch((error) => {
    console.error(`Kiro setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
