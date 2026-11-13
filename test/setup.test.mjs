import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { prepareHttpProfile, prepareUsageInstall, requireNativePaseoVersion, runSetup } from "../setup.mjs";

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

test("plugin trust is explicit and preserves a disabled directory install unless authorized", () => {
  const installed = { source: "directory", path: packageDir, enabled: false };
  const config = {
    pluginsEnabled: true,
    plugins: { "omp-kiro": installed, other: { source: "directory", path: "/other", enabled: false } },
    pluginSettings: { "omp-kiro": { retained: true } },
    agents: { providers: { "kiro-http": { enabled: false, env: { KEEP: "yes" } } } },
  };
  const before = structuredClone(config);
  assert.deepEqual(prepareUsageInstall(config), { installed, enableExisting: false, reloadExisting: false });
  assert.deepEqual(prepareUsageInstall(config, true), { installed, enableExisting: true, reloadExisting: false });
  assert.throws(() => prepareUsageInstall({ ...config, pluginsEnabled: false }), /--enable-plugins/);
  assert.equal(prepareUsageInstall({ ...config, pluginsEnabled: false }, true).enableExisting, true);
  assert.deepEqual(config, before);
});

test("usage installation reloads enabled same-root installs without replacing other sources", () => {
  const installed = { source: "directory", path: packageDir, enabled: true };
  assert.deepEqual(prepareUsageInstall({ pluginsEnabled: true, plugins: { "omp-kiro": installed } }), {
    installed, enableExisting: false, reloadExisting: true,
  });
  assert.equal(prepareUsageInstall({ pluginsEnabled: true }).installed, undefined);
  for (const source of [
    { source: "directory", path: "/another/checkout" },
    { source: "git", path: packageDir },
    null,
  ]) {
    assert.throws(() => prepareUsageInstall({ pluginsEnabled: true, plugins: { "omp-kiro": source } }));
  }
});

test("native usage rejects old, prerelease, and unrecognized hosts", () => {
  for (const version of ["paseo 0.13.0", "paseo 0.13.12", "paseo 0.13.13-beta.1", "v22.13.0", "unknown"]) {
    assert.throws(() => requireNativePaseoVersion(version), /0\.13\.13/);
  }
});

test("HTTP and usage-only require trust before reading or refreshing authentication", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "kiro-setup-trust-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const mode of ["--http", "--usage-only"]) {
    await assert.rejects(runSetup([mode, "--paseo-home", home]), /--enable-plugins/);
  }
});

test("usage-only rejects unsupported executables before modifying existing profiles or plugin settings", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "kiro-setup-version-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "config.json");
  const original = JSON.stringify({
    pluginsEnabled: true,
    plugins: { "omp-kiro": { source: "directory", path: packageDir, enabled: false } },
    pluginSettings: { "omp-kiro": { keep: true } },
    agents: { providers: { "kiro-http": { env: { OMP_KIRO_AUTH_FILE: "/existing.sqlite3" } } } },
  });
  await writeFile(path, original);
  // Node's real --version is not a compatible Passession host; no fake CLI or daemon is started.
  await assert.rejects(runSetup([
    "--usage-only", "--paseo-home", home, "--paseo-command", process.execPath,
  ]), /0\.13\.13/);
  assert.equal(await readFile(path, "utf8"), original);
});

test("usage-only cannot silently apply profile or authentication changes", async () => {
  for (const option of [["--http"], ["--profile", "existing"], ["--auth-file", "/another.sqlite3"], ["--omp-agent-dir", "/state"]]) {
    await assert.rejects(runSetup(["--usage-only", "--paseo-home", "/unused", ...option]), /does not configure an OMP profile/);
  }
});
