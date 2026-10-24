#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { discoverModels } from "./bridge.mjs";
import { discoverHttpModels } from "./http.mjs";

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
  const transport = profileEnv.OMP_KIRO_TRANSPORT || "acp";
  if (transport !== "acp" && transport !== "http") {
    throw new Error("OMP_KIRO_TRANSPORT must be acp or http.");
  }
  const label = transport === "http" ? "Kiro (HTTP)" : "Kiro (OMP)";
  const provider = transport === "http" ? "kiro-http" : "kiro-cli";
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
  const catalog = await (transport === "http" ? discoverHttpModels() : discoverModels());
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
      throw new Error(
        "Paseo config changed during setup; rerun to merge its latest contents. The OMP extension is already installed.",
      );
    }
    await rename(temporary, configPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "paseo-home": { type: "string" },
      "omp-agent-dir": { type: "string" },
      "omp-command": { type: "string", default: "omp" },
      profile: { type: "string", default: "kiro-omp" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(`Usage: node setup.mjs --paseo-home <directory> [options]

  --paseo-home <directory>    Paseo config directory (or PASEO_HOME; required)
  --omp-agent-dir <directory> OMP agent directory (or PI_CODING_AGENT_DIR)
  --omp-command <executable>  OMP executable, not shell arguments (default: omp)
  --profile <id>             Paseo provider ID (default: kiro-omp)

Requires Node.js 22.13+, OMP, and an authenticated Kiro CLI login.
OMP_KIRO_COMMAND can select a different Kiro executable.
OMP_KIRO_TRANSPORT selects acp (default) or http.
Installs the local OMP extension and merges a matching Kiro profile into config.json.
Model discovery uses metadata only; no model prompt or daemon restart is sent.
Existing settings, other providers, and model defaults are retained.`);
    return;
  }

  const paseoHome = values["paseo-home"] || process.env.PASEO_HOME;
  if (!paseoHome) throw new Error("Pass --paseo-home <directory> or set PASEO_HOME explicitly.");
  const profileId = values.profile;
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
    "OMP_KIRO_TRANSPORT",
    "OMP_KIRO_AUTH_FILE",
  ]) {
    if (env[key]) profileEnv[key] = env[key];
  }

  const configPath = join(absolutePath(paseoHome), "config.json");
  const original = await readConfig(configPath);
  const config = object(original === null ? {} : JSON.parse(original), "config.json");
  const agents = object(config.agents, "agents");
  const providers = object(agents.providers, "agents.providers");
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
  const transportPrefix = provider === "kiro-http" ? "OMP_KIRO_TRANSPORT=http " : "";
  console.log(
    `Standalone: ${transportPrefix}${JSON.stringify(ompCommand)} --model ${JSON.stringify(`${provider}/${catalog[0].id}`)}`,
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

main().catch((error) => {
  console.error(`Kiro setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
