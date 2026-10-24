#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
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

async function prepareProfile({ existingValue, profileId, command, profileEnv }) {
  const label = "Kiro (OMP)";
  const provider = "kiro-cli";
  const existing = object(existingValue, `agents.providers.${profileId}`);
  if (
    existingValue !== undefined &&
    (existing.extends !== "omp" ||
      existing.label !== label ||
      (existing.command && JSON.stringify(existing.command) !== JSON.stringify(command)))
  ) {
    throw new Error(
      `Provider ${profileId} already has a different configuration. Choose another --profile; the existing provider was not changed.`,
    );
  }
  const existingEnv = object(existing.env, `agents.providers.${profileId}.env`);
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
  const catalog = await discoverModels();
  if (catalog.length === 0)
    throw new Error("Kiro returned an empty model catalog; no configuration was changed.");
  const models = [...(existing.models ?? [])];
  for (const model of catalog) {
    const id = `${provider}/${model.id}`;
    if (!models.some((entry) => entry.id === id)) models.push({ id, label: model.name });
  }
  const profile = {
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
  return { profile, catalog, provider };
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
      throw new Error("Paseo config changed during setup; rerun to merge its latest contents.");
    }
    await rename(temporary, configPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function prepareHttpProfile(existingValue, authFile) {
  const existing = object(existingValue, "agents.providers.kiro-http");
  const env = object(existing.env, "agents.providers.kiro-http.env");
  const legacy =
    existing.extends === "omp" &&
    existing.label === "Kiro (HTTP)" &&
    env.OMP_KIRO_TRANSPORT === "http";
  if (existing.extends !== undefined && !legacy) {
    throw new Error(
      "kiro-http is configured for another provider; no existing configuration was replaced.",
    );
  }
  const next = {
    ...existing,
    enabled: existing.enabled ?? true,
    env: { ...env, OMP_KIRO_AUTH_FILE: authFile },
  };
  if (legacy) {
    for (const key of ["extends", "label", "command", "models"]) delete next[key];
    for (const key of [
      "OMP_KIRO_TRANSPORT",
      "OMP_KIRO_COMMAND",
      "PI_CODING_AGENT_DIR",
      "OMP_PROFILE",
      "PI_PROFILE",
      "PI_CONFIG_DIR",
    ])
      delete next.env[key];
  }
  return { profile: next, legacy };
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

async function installHttp({ values, configPath, config, providers }) {
  if (values.profile !== undefined && values.profile !== "kiro-http")
    throw new Error(
      "The native HTTP provider ID is kiro-http; --profile selects only OMP profiles.",
    );
  if (config.pluginsEnabled !== true && !values["enable-plugins"])
    throw new Error(
      "External Paseo plugins are disabled. Re-run with --enable-plugins only if you trust unsandboxed plugin code to access this machine.",
    );
  const command = values["paseo-command"];
  const home = dirname(configPath);
  const previous = providers["kiro-http"];
  const previousEnv = object(previous?.env, "agents.providers.kiro-http.env");
  const authFile = authFilePath(
    values["auth-file"] ? absolutePath(values["auth-file"]) : undefined,
    { ...process.env, ...previousEnv },
  );
  const { profile, legacy } = prepareHttpProfile(previous, authFile);
  if (legacy) {
    const sessions = JSON.parse(
      paseo(command, ["ls", "--all", "--global", "--json", "--home", home]),
    );
    if (!Array.isArray(sessions))
      throw new Error("Cannot inspect existing Paseo sessions; no configuration was replaced.");
    if (
      sessions.some(
        (session) => session.provider === "kiro-http" || session.provider?.startsWith("kiro-http/"),
      )
    )
      throw new Error(
        "Existing OMP-backed kiro-http sessions cannot resume as native HTTP sessions. Export and remove those sessions before switching; no session or profile was changed.",
      );
  }
  const configuredPlugins = object(config.plugins, "plugins");
  const installed = configuredPlugins["omp-kiro"];
  if (installed && (installed.source !== "directory" || resolve(installed.path) !== packageDir))
    throw new Error(
      "omp-kiro is installed from another source. Update that installation explicitly; no source was replaced.",
    );
  const catalog = await discoverHttpModels({
    authProvider: (options) => loadKiroAuth({ ...options, authFile }),
  });
  if (!catalog.length)
    throw new Error("Kiro returned an empty model catalog; no configuration was changed.");
  if (!installed) paseo(command, ["plugin", "install", packageDir, "--home", home, "--json"]);
  const original = await readConfig(configPath);
  const latest = object(JSON.parse(original), "config.json");
  const latestAgents = object(latest.agents, "agents");
  const latestProviders = object(latestAgents.providers, "agents.providers");
  if (!isDeepStrictEqual(latestProviders["kiro-http"], previous))
    throw new Error(
      "The kiro-http provider changed during setup. Re-run to merge the latest settings.",
    );
  await saveConfig({
    configPath,
    original,
    next: {
      ...latest,
      pluginsEnabled: true,
      agents: { ...latestAgents, providers: { ...latestProviders, "kiro-http": profile } },
    },
  });
  paseo(command, ["daemon", "reload", "--home", home, "--json"]);
  if (installed)
    paseo(command, [
      "plugin",
      installed.enabled === false ? "enable" : "reload",
      "omp-kiro",
      "--home",
      home,
      "--json",
    ]);
  console.log(
    `Installed the native kiro-http provider and Kiro usage source (${catalog.length} live models).`,
  );
  console.log(`Auth store: ${authFile}. Credentials were not copied into Paseo configuration.`);
  console.log("Select Kiro HTTP in Paseo; model IDs no longer include a kiro-http/ prefix.");
  console.log(`Usage: paseo usage --refresh --home ${JSON.stringify(home)}`);
  if (profile.enabled === false)
    console.log(
      "The existing provider remains disabled; enable agents.providers.kiro-http explicitly.",
    );
  console.log(
    "Configuration reloaded without restarting the daemon. No OMP/Kiro process or model prompt was started.",
  );
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
      "paseo-command": { type: "string", default: "paseo" },
      "auth-file": { type: "string" },
      "enable-plugins": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(`Usage: node setup.mjs --paseo-home <directory> [options]

  --paseo-home <directory>    Paseo config directory (or PASEO_HOME; required)
  --omp-agent-dir <directory> OMP agent directory (or PI_CODING_AGENT_DIR)
  --omp-command <executable>  OMP executable, not shell arguments (default: omp)
  --profile <id>             ACP/OMP provider ID (default: kiro-omp)
  --http                     Install the native Paseo HTTP provider (no OMP/Kiro CLI)
  --auth-file <path>          HTTP managed auth store (default: OMP_KIRO_AUTH_FILE)
  --enable-plugins            Trust and enable unsandboxed external Paseo plugins
  --paseo-command <executable> Paseo CLI executable (default: paseo)

Requires Node.js 22.13+. Native HTTP requires Paseo 0.13+ and managed Kiro login.
ACP requires OMP and an authenticated Kiro CLI login.
OMP_KIRO_COMMAND selects the ACP executable. OMP_KIRO_TRANSPORT=http selects --http.
Model discovery uses metadata only; no model prompt or daemon restart is sent.
Existing settings, other providers, and model defaults are retained.`);
    return;
  }

  const paseoHome = values["paseo-home"] || process.env.PASEO_HOME;
  if (!paseoHome) throw new Error("Pass --paseo-home <directory> or set PASEO_HOME explicitly.");
  const transport = values.http ? "http" : process.env.OMP_KIRO_TRANSPORT || "acp";
  if (!["acp", "http"].includes(transport))
    throw new Error("OMP_KIRO_TRANSPORT must be acp or http.");
  const configPath = join(absolutePath(paseoHome), "config.json");
  const original = await readConfig(configPath);
  const config = object(original === null ? {} : JSON.parse(original), "config.json");
  const agents = object(config.agents, "agents");
  const providers = object(agents.providers, "agents.providers");
  if (transport === "http") {
    await installHttp({ values, configPath, config, providers });
    return;
  }
  if (values["auth-file"] || values["enable-plugins"])
    throw new Error("--auth-file and --enable-plugins apply only to --http.");
  const profileId = values.profile ?? "kiro-omp";
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
  const env = { ...process.env };
  const agentDir = values["omp-agent-dir"] || env.PI_CODING_AGENT_DIR;
  if (agentDir) env.PI_CODING_AGENT_DIR = absolutePath(agentDir);
  const profileEnv = {};
  for (const key of [
    "PI_CODING_AGENT_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "OMP_KIRO_COMMAND",
    "OMP_KIRO_AUTH_FILE",
  ]) {
    if (env[key]) profileEnv[key] = env[key];
  }

  const { profile, catalog, provider } = await prepareProfile({
    existingValue: providers[profileId],
    profileId,
    command: [ompCommand],
    profileEnv,
  });

  const installed = spawnSync(ompCommand, ["install", packageDir], { env, stdio: "inherit" });
  if (installed.error) throw installed.error;
  if (installed.status !== 0)
    throw new Error(
      `OMP extension installation failed (${installed.signal || installed.status}); Paseo configuration was not changed.`,
    );

  const next = {
    ...config,
    agents: { ...agents, providers: { ...providers, [profileId]: profile } },
  };
  await saveConfig({ configPath, original, next });
  console.log(`Registered ${profileId} (${profile.label}) in ${configPath}.`);
  console.log(`Models: ${catalog.map((model) => `${provider}/${model.id}`).join(", ")}`);
  console.log(
    `Standalone: ${JSON.stringify(ompCommand)} --model ${JSON.stringify(`${provider}/${catalog[0].id}`)}`,
  );
  console.log(
    "Use the same OMP environment for standalone sessions. Keep this checkout in place: OMP links the local package.",
  );
  if (profile.enabled === false)
    console.log("The existing profile remains disabled; enable it explicitly to show it in Paseo.");
  console.log(
    `Reload configuration without restarting: paseo daemon reload --home ${JSON.stringify(dirname(configPath))}`,
  );
  console.log(`Then select ${profile.label} in Paseo. Setup did not reload or restart a daemon.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSetup().catch((error) => {
    console.error(`Kiro setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
