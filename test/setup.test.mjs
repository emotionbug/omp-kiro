import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareHttpProfile, runSetup } from "../setup.mjs";

test("native cutover removes OMP launch and stale model catalog while preserving unrelated environment and disabled state", () => {
  const previous = {
    extends: "omp",
    label: "Kiro (HTTP)",
    enabled: false,
    command: ["/custom/omp"],
    models: [{ id: "kiro-http/auto", label: "Auto" }],
    env: {
      OMP_KIRO_TRANSPORT: "http",
      OMP_KIRO_COMMAND: "/custom/kiro",
      PI_CONFIG_DIR: "old",
      HTTPS_PROXY: "http://proxy.invalid:3128",
      OMP_KIRO_AUTH_FILE: "/old.sqlite3",
    },
  };
  const before = JSON.stringify(previous);
  const { profile, legacy } = prepareHttpProfile(previous, "/selected/auth.sqlite3");
  assert.equal(legacy, true);
  assert.deepEqual(profile, {
    enabled: false,
    env: { HTTPS_PROXY: "http://proxy.invalid:3128", OMP_KIRO_AUTH_FILE: "/selected/auth.sqlite3" },
  });
  assert.equal(JSON.stringify(previous), before);
});

test("native provider preserves deliberate overrides and refuses a conflicting custom provider", () => {
  const previous = { enabled: true, label: "My account", env: { LANG: "ko_KR.UTF-8" } };
  assert.deepEqual(prepareHttpProfile(previous, "/auth.sqlite3").profile, {
    ...previous,
    env: { LANG: "ko_KR.UTF-8", OMP_KIRO_AUTH_FILE: "/auth.sqlite3" },
  });
  for (const value of [
    { extends: "codex" },
    { extends: "omp", label: "Other", env: { OMP_KIRO_TRANSPORT: "http" } },
    { env: [] },
  ]) {
    assert.throws(() => prepareHttpProfile(value, "/auth.sqlite3"));
  }
});

test("HTTP setup requires explicit plugin trust before reading or refreshing authentication", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "kiro-setup-trust-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(runSetup(["--http", "--paseo-home", home]), /--enable-plugins/);
});
