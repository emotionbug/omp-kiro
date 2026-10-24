#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  authFilePath,
  getKiroAuthStatus,
  importCliAuth,
  logoutKiroAuth,
  readAuthSnapshot,
  saveKiroAuth,
} from "./server/auth.mjs";
import { loginSocial } from "./server/social-login.mjs";
import { loginDevice } from "./server/oidc-login.mjs";

function usage() {
  console.log(`Usage: omp-kiro <command> [options]

Commands:
  login                 Authenticate without invoking Kiro CLI
  auth status           Show non-secret local login status
  auth logout           Remove this plugin's active login (not CLI login)
  auth import-cli       Explicitly import an existing CLI social login

Login options:
  --provider <name>     google (default), github, builder-id, identity-center
  --flow <name>         device (default); social accounts also loopback or manual
  --start-url <url>     Identity Center start URL
  --region <region>     OIDC issuer region (default: us-east-1)
  --timeout <seconds>   Overall deadline (default: 600)

Storage options:
  --auth-file <path>    Dedicated plugin SQLite file (or OMP_KIRO_AUTH_FILE)
  --database <path>     Source CLI SQLite file for auth import-cli only
  --json                Machine-readable auth status only

No browser is launched automatically. Open the displayed authorization link on
any device for the default device flow. Passwords and tokens are never requested
on the command line. HTTP generation uses this plugin's login, not CLI storage.`);
}

function instructions(info) {
  console.log("Open this authorization URL in your browser:");
  console.log(info.authorizationUrl || info.verificationUriComplete || info.verificationUri);
  if (info.userCode) console.log(`Verification code: ${info.userCode}`);
  if (info.expiresAt) console.log(`Expires: ${info.expiresAt}`);
  if (info.completionMode === "manual")
    console.log("After approval, paste the full redirected URL below; do not share it.");
}

async function requestCallback({ signal }) {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  try {
    return await terminal.question("Redirected URL: ", { signal });
  } finally {
    terminal.close();
  }
}

export async function runAuthCli(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: "string", default: "google" },
      flow: { type: "string", default: "device" },
      "start-url": { type: "string" },
      region: { type: "string", default: "us-east-1" },
      timeout: { type: "string", default: "600" },
      "auth-file": { type: "string" },
      database: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length === 0) {
    usage();
    return;
  }
  const command = positionals.join(" ");
  if (!["login", "auth status", "auth logout", "auth import-cli"].includes(command))
    throw new Error("Unknown authentication command; use --help.");
  if (values.json && command !== "auth status")
    throw new Error("--json is supported only for auth status; credentials are never printed.");
  if (values.database && command !== "auth import-cli")
    throw new Error("--database is only a source for auth import-cli.");
  const authFile = values["auth-file"] ? resolve(values["auth-file"]) : authFilePath();
  if (command === "auth status") {
    const status = await getKiroAuthStatus({ authFile });
    if (values.json) console.log(JSON.stringify(status));
    else if (status.loggedIn)
      console.log(
        `Logged in: ${status.provider} (${status.kind}); expires ${status.expiresAt}${status.expired ? " (expired)" : ""}`,
      );
    else console.log("Not logged in. Run omp-kiro login.");
    return;
  }
  if (command === "auth logout") {
    await logoutKiroAuth({ authFile });
    console.log("Plugin login removed. Kiro CLI login was not changed.");
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Authentication cancelled", "AbortError"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647) {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    throw new Error("--timeout must be positive and fit a Node.js timer.");
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException("Authentication timed out", "TimeoutError")),
    timeout * 1000,
  );
  timer.unref();
  try {
    const signal = controller.signal;
    if (command === "auth import-cli") {
      await importCliAuth({
        authFile,
        signal,
        ...(values.database ? { databasePath: resolve(values.database) } : {}),
      });
      console.log(
        `CLI social login imported into ${authFile}; the source database was not changed.`,
      );
      return;
    }
    const expectedRaw = await readAuthSnapshot({ authFile, signal });
    const provider = values.provider;
    let credential;
    if (["google", "github"].includes(provider)) {
      if (values["start-url"])
        throw new Error("--start-url is for Identity Center, not social login.");
      if (!["device", "loopback", "manual"].includes(values.flow))
        throw new Error("--flow must be device, loopback, or manual.");
      credential = await loginSocial({
        provider,
        mode: values.flow,
        signal,
        onInstructions: instructions,
        requestCallback,
      });
    } else if (["builder-id", "identity-center"].includes(provider)) {
      if (values.flow !== "device")
        throw new Error("Builder ID and Identity Center use the device flow.");
      credential = await loginDevice({
        provider,
        startUrl: values["start-url"],
        region: values.region,
        signal,
        onVerification: instructions,
      });
    } else
      throw new Error(
        "Unsupported provider; choose google, github, builder-id, or identity-center.",
      );
    await saveKiroAuth(credential, { authFile, expectedRaw, signal });
    console.log(`Authenticated ${credential.provider}. Credentials saved to ${authFile}.`);
    console.log(`For this store, set OMP_KIRO_AUTH_FILE to ${authFile}.`);
    console.log("Use: OMP_KIRO_TRANSPORT=http omp --model kiro-http/auto");
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

const entrypoint = process.argv[1];
const isEntrypoint =
  entrypoint &&
  existsSync(entrypoint) &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entrypoint);
if (isEntrypoint) {
  runAuthCli().catch((error) => {
    console.error(`Kiro authentication failed: ${error.message}`);
    process.exitCode = error.name === "AbortError" ? 130 : 1;
  });
}
