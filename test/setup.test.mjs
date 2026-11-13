import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { KiroAuthError } from "../server/auth.mjs";
import { prepareHttpProfile, runSetup } from "../setup.mjs";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = [{ id: "auto", name: "Auto" }, { id: "model-new", name: "New model" }];

test("HTTP setup retains the OMP harness, existing models, settings, and disabled state", () => {
  const previous = {
    extends: "omp",
    label: "Kiro (HTTP)",
    enabled: false,
    command: ["/custom/omp"],
    models: [{ id: "kiro-http/auto", label: "My auto" }, { id: "other/model", label: "Other" }],
    params: { keep: "value" },
    env: {
      OMP_KIRO_TRANSPORT: "http",
      OMP_KIRO_COMMAND: "/custom/kiro",
      PI_CONFIG_DIR: "/isolated/omp",
      HTTPS_PROXY: "http://proxy.invalid:3128",
      OMP_KIRO_AUTH_FILE: "/selected/auth.sqlite3",
    },
  };
  const before = structuredClone(previous);
  const profile = prepareHttpProfile(previous, "/selected/auth.sqlite3", {
    command: ["/custom/omp"], catalog,
  });
  assert.equal(profile.extends, "omp");
  assert.equal(profile.enabled, false);
  assert.equal(profile.label, previous.label);
  assert.deepEqual(profile.command, previous.command);
  assert.deepEqual(profile.env, previous.env);
  assert.deepEqual(profile.params, previous.params);
  assert.deepEqual(profile.models, [...previous.models, { id: "kiro-http/model-new", label: "New model" }]);
  assert.deepEqual(previous, before);
});

test("a new HTTP profile uses OMP and prefixed model IDs", () => {
  const profile = prepareHttpProfile(undefined, "/auth.sqlite3", { catalog });
  assert.equal(profile.extends, "omp");
  assert.deepEqual(profile.command, ["omp"]);
  assert.deepEqual(profile.env, { OMP_KIRO_TRANSPORT: "http", OMP_KIRO_AUTH_FILE: "/auth.sqlite3" });
  assert.deepEqual(profile.models, catalog.map((model) => ({ id: `kiro-http/${model.id}`, label: model.name })));
});

test("HTTP setup refuses direct-native profiles, other harnesses, and launch/environment conflicts", () => {
  for (const existing of [
    { enabled: true, label: "Native Kiro", env: { OMP_KIRO_AUTH_FILE: "/auth.sqlite3" } },
    { extends: "codex" },
    { extends: "omp", env: { OMP_KIRO_TRANSPORT: "acp" } },
    { extends: "omp", command: ["/other/omp"], env: { OMP_KIRO_TRANSPORT: "http" } },
    { extends: "omp", env: { OMP_KIRO_TRANSPORT: "http", OMP_KIRO_AUTH_FILE: "/other.sqlite3" } },
    { extends: "omp", env: [] },
    { extends: "omp", env: { OMP_KIRO_TRANSPORT: "http" }, models: {} },
  ]) {
    const before = structuredClone(existing);
    assert.throws(() => prepareHttpProfile(existing, "/auth.sqlite3", { catalog }));
    assert.deepEqual(existing, before);
  }
});

test("HTTP setup reaches managed authentication without the Passession CLI or daemon", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "kiro-setup-auth-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "config.json");
  const original = JSON.stringify({
    pluginsEnabled: false,
    plugins: { "omp-kiro": { source: "directory", path: packageDir, enabled: false } },
    pluginSettings: { "omp-kiro": { keep: true } },
    agents: { providers: { "kiro-http": { env: { OMP_KIRO_AUTH_FILE: "/existing.sqlite3" } } } },
  });
  await writeFile(path, original);
  const previousPath = process.env.PATH;
  process.env.PATH = home;
  try {
    await assert.rejects(runSetup([
      "--http", "--paseo-home", home,
      "--auth-file", join(home, "missing.sqlite3"),
    ]), KiroAuthError);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.equal(await readFile(path, "utf8"), original);
});

test("setup rejects malformed config without replacing it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "kiro-setup-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "config.json");
  for (const original of ["{", "null", '{"agents":[]}', '{"agents":{"providers":[]}}']) {
    await writeFile(path, original);
    await assert.rejects(runSetup(["--paseo-home", home]));
    assert.equal(await readFile(path, "utf8"), original);
  }
});

test("ACP rejects HTTP-only auth selection without changing existing configuration", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "kiro-setup-acp-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "config.json");
  const original = '{"agents":{"providers":{"kiro-omp":{"extends":"omp","enabled":false}}}}';
  await writeFile(path, original);
  const transport = process.env.OMP_KIRO_TRANSPORT;
  process.env.OMP_KIRO_TRANSPORT = "acp";
  try {
    await assert.rejects(runSetup([
      "--paseo-home", home, "--auth-file", join(home, "missing.sqlite3"),
    ]), /--auth-file applies only to --http/);
  } finally {
    if (transport === undefined) delete process.env.OMP_KIRO_TRANSPORT;
    else process.env.OMP_KIRO_TRANSPORT = transport;
  }
  assert.equal(await readFile(path, "utf8"), original);
});
