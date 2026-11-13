#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

/** Build the native usage source; never starts or reconfigures a daemon. */
export async function buildPaseoPlugin() {
  const cargo = process.env.CARGO || "cargo";
  await new Promise((resolve, reject) => {
    const child = spawn(cargo, [
      "build", "--release", "--locked", "--manifest-path", "paseo/Cargo.toml",
      "--target-dir", "paseo/target",
    ], { cwd: directory, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Native usage build failed (${signal || code}). Check Rust 1.93+ and Cargo.`));
    });
  });
  const binary = `omp-kiro-usage${process.platform === "win32" ? ".exe" : ""}`;
  const destination = join(directory, "paseo", "bin", binary);
  await mkdir(dirname(destination), { recursive: true });
  const manifestPath = join(directory, "paseo-plugin.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(join(directory, "paseo", "target", "release", binary), temporary);
    if (process.platform !== "win32") await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const executable = `paseo/bin/${binary}`;
  if (manifest.server.executable !== executable) {
    manifest.server.executable = executable;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPaseoPlugin().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
