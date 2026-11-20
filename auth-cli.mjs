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
  loadKiroAuth,
  logoutKiroAuth,
  readAuthSnapshot,
  resolveKiroApiKeyCredential,
  saveKiroAuth,
} from "./server/auth.mjs";
import { loginSocial } from "./server/social-login.mjs";
import { loginDevice } from "./server/oidc-login.mjs";
import { fetchKiroProfileUsage, listKiroProfiles, selectKiroProfile } from "./server/profiles.mjs";
import { executeKiroQuery } from "./server/commands.mjs";
import {
  DEFAULT_ACCOUNT,
  kiroAccountTargets,
  kiroAccountAuthFile,
  kiroTargetProvider,
  listKiroAccounts,
  pinnedKiroTargets,
} from "./server/accounts.mjs";

function usage() {
  console.log(`Usage: omp-kiro <command> [options]

Commands:
  login                 Authenticate without invoking Kiro CLI
  accounts              List every local account, its profiles and model providers
  auth status           Show non-secret local login status
  auth logout           Remove this plugin's active login (not CLI login)
  auth profiles         List all HTTP profiles; --usage compares their quotas
  auth profile          Show selected profile; --profile selects an ARN or exact name
  auth import-cli       Explicitly import an existing CLI social login

Login options:
  --provider <name>     google (default), github, builder-id, identity-center, api-key
  --flow <name>         device (default); social accounts also loopback or manual
  --start-url <url>     Identity Center start URL
  --region <region>     OIDC issuer region (default: us-east-1) or API-key service region
  --profile <arn|name>  Select an assigned Kiro profile (login accepts an ARN)
  --usage               Include per-profile plan, credits and reset (auth profiles)
  --timeout <seconds>   Overall deadline (default: 600)

Storage options:
  --account <name>      Named account next to the default store (default: default)
  --auth-file <path>    Default plugin SQLite file (or OMP_KIRO_AUTH_FILE)
  --database <path>     Source CLI SQLite file for auth import-cli only
  --json                Machine-readable accounts, auth status, profiles or profile

Each account is a separate login stored in accounts/<name>.sqlite3 beside the
default store. Once a named account exists, or one account has several
profiles, every account profile gets its own OMP model provider
(kiro-<account>-<profile id>/<model>) so a session can pin it.

No browser is launched automatically. Open the displayed authorization link on
any device for the default device flow. Passwords and tokens are never requested
on the command line. HTTP generation uses this plugin's login, not CLI storage.`);
  console.log("API-key login reads one secret line from stdin (hidden on a terminal), never from arguments.");
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

async function readApiKey(signal) {
  signal.throwIfAborted();
  const tty = process.stdin.isTTY === true;
  // A terminal interface with no output handles editing and raw input
  // without echoing the secret. Piped input has no prompt at all.
  const input = createInterface({ input: process.stdin, terminal: tty });
  let interrupted = false;
  const close = () => input.close();
  signal.addEventListener("abort", close, { once: true });
  input.on("SIGINT", () => { interrupted = true; close(); });
  if (tty) process.stderr.write("Kiro API key: ");
  try {
    for await (const line of input) {
      signal.throwIfAborted();
      return line.trim();
    }
    signal.throwIfAborted();
    if (interrupted) throw new DOMException("Authentication cancelled", "AbortError");
    throw new Error("No Kiro API key was supplied on stdin.");
  } finally {
    input.close();
    signal.removeEventListener("abort", close);
    if (tty) process.stderr.write("\n");
  }
}

export async function runAuthCli(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        provider: { type: "string", default: "google" },
        flow: { type: "string", default: "device" },
        "start-url": { type: "string" },
        region: { type: "string" },
        profile: { type: "string" },
        timeout: { type: "string", default: "600" },
        "auth-file": { type: "string" },
        account: { type: "string" },
        database: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        usage: { type: "boolean" },
      },
    });
  } catch {
    // Option parser errors may quote arbitrary arguments. Never echo a
    // mistakenly supplied key, even when rejecting unsupported flags.
    throw new Error("Invalid authentication options; use --help.");
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    usage();
    return;
  }
  const command = positionals.join(" ");
  if (!["login", "accounts", "auth status", "auth logout", "auth import-cli", "auth profile", "auth profiles"].includes(command))
    throw new Error("Unknown authentication command; use --help.");
  if (values.json && !["accounts", "auth status", "auth profile", "auth profiles"].includes(command))
    throw new Error("--json is supported only for accounts and auth status/profile/profiles; credentials are never printed.");
  if (values.usage && command !== "auth profiles")
    throw new Error("--usage is supported only for auth profiles.");
  if (values.database && command !== "auth import-cli")
    throw new Error("--database is only a source for auth import-cli.");
  if (values.profile && !["login", "auth profile"].includes(command))
    throw new Error("--profile is supported only for login or auth profile.");
  if (values.account !== undefined && command === "accounts")
    throw new Error("accounts lists every account; --account selects one for the other commands.");
  const defaultAuthFile = values["auth-file"] ? resolve(values["auth-file"]) : authFilePath();
  const account = values.account ?? DEFAULT_ACCOUNT;
  const authFile = kiroAccountAuthFile(account, { authFile: defaultAuthFile });
  const useEnv = account === DEFAULT_ACCOUNT && defaultAuthFile === authFilePath();
  const authOptions = { authFile, useEnv };
  if (command === "accounts") {
    if (values.json) {
      const accounts = await listKiroAccounts({ authFile: defaultAuthFile });
      const { targets, collisions } = kiroAccountTargets(accounts);
      const pinned = new Set(pinnedKiroTargets(targets).map((target) => target.provider));
      console.log(JSON.stringify({
        accounts, targets: targets.map((target) => ({ ...target, pinned: pinned.has(target.provider) })), collisions,
      }));
    } else console.log((await executeKiroQuery("kiro-accounts", "", { authFile: defaultAuthFile })).text);
    return;
  }
  if (command === "auth status") {
    const status = await getKiroAuthStatus(authOptions);
    if (values.json) console.log(JSON.stringify(status));
    else if (status.loggedIn)
      console.log(
        status.disabled ? `Signed in: ${status.provider} (${status.kind}); sign in again to use this account.`
          : `Logged in: ${status.provider} (${status.kind})${status.expiresAt ? `; expires ${status.expiresAt}${status.expired ? " (expired)" : ""}` : ""}`,
      );
    else console.log("Not logged in. Run omp-kiro login.");
    return;
  }
  if (command === "auth logout") {
    await logoutKiroAuth({ authFile });
    console.log("Plugin login removed. Kiro CLI login was not changed.");
    if (useEnv && process.env.KIRO_API_KEY) console.log("Unset KIRO_API_KEY to stop using the environment key.");
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
    if (command === "auth profiles") {
      if (values.json) {
        const query = values.usage ? fetchKiroProfileUsage : listKiroProfiles;
        console.log(JSON.stringify(await query({ ...authOptions, signal })));
      } else if (values.usage) {
        const result = await executeKiroQuery("kiro-profiles", "", { ...authOptions, signal });
        console.log(result.text);
      } else {
        const catalog = await listKiroProfiles({ ...authOptions, signal });
        if (catalog.apiKey) {
          console.log("Kiro API keys have no profiles.");
          return;
        }
        if (!catalog.complete)
          console.log("Profile lookup was incomplete; some profiles may be missing. The saved catalog was not replaced.");
        for (const profile of catalog.profiles)
          console.log(`${profile.arn === catalog.selectedArn ? "* " : "  "}${JSON.stringify(profile.name)}\n  ${profile.arn}`);
        if (!catalog.selectedArn) console.log("No profile selected.");
      }
      return;
    }
    if (command === "auth profile") {
      const profile = values.profile
        ? await selectKiroProfile(values.profile, { ...authOptions, signal })
        : await listKiroProfiles({ ...authOptions, signal }).then(({ selectedArn, apiKey }) =>
          apiKey ? { arn: null, apiKey: true } : { arn: selectedArn ?? null });
      if (values.json) console.log(JSON.stringify(profile));
      else {
        console.log(profile.apiKey ? "Kiro API keys have no profiles." : `Selected Kiro profile: ${JSON.stringify(profile.arn)}`);
        if (values.profile)
          console.log("Applies to all sessions sharing this auth store. Refresh the Kiro model catalog in other sessions before their next turn.");
      }
      return;
    }
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
    if (provider === "api-key") {
      if (values["start-url"] || values.profile || values.flow !== "device")
        throw new Error("API-key login does not use a start URL, profile, or OAuth flow.");
      credential = await resolveKiroApiKeyCredential(await readApiKey(signal), { region: values.region, signal });
    } else if (["google", "github"].includes(provider)) {
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
        region: values.region ?? "us-east-1",
        signal,
        onVerification: instructions,
      });
    } else
      throw new Error(
        "Unsupported provider; choose google, github, builder-id, identity-center, or api-key.",
      );
    await saveKiroAuth(credential, { authFile, expectedRaw, signal, replacesLogin: true });
    if (provider === "api-key") {
      console.log(`Authenticated API key. Credentials saved to ${authFile}.`);
      if (account === DEFAULT_ACCOUNT) {
        if (useEnv && process.env.KIRO_API_KEY)
          console.log("KIRO_API_KEY takes precedence over the saved default. Unset it to use this key.");
        console.log(`For this store, set OMP_KIRO_AUTH_FILE to ${authFile}.`);
        console.log("Use: omp --model kiro-http/auto");
      } else {
        console.log(`Named accounts are found beside ${defaultAuthFile}; OMP and Passession must use that same default store.`);
        console.log(`Use: omp --model ${kiroTargetProvider(account, null, "api-key")}/auto`);
      }
      return;
    }
    let unselected = false;
    try {
      await loadKiroAuth({
        authFile, signal, profileArn: values.profile, useEnv: false,
        expectedCredential: { ...credential, profile_arn: undefined },
      });
    } catch (error) {
      // An ambiguous or incomplete list leaves the saved login unselected.
      if (values.profile || !error.profiles) throw error;
      console.log(error.message);
      unselected = true;
    }
    console.log(`Authenticated ${credential.provider}. Credentials saved to ${authFile}.`);
    try {
      const catalog = await listKiroProfiles({ authFile, signal, useEnv: false });
      if (!catalog.complete)
        console.log("Profile lookup was incomplete; some profiles may be missing. The saved catalog was not replaced.");
    } catch (error) {
      signal.throwIfAborted();
      if (error?.code === "credential_changed") throw error;
      console.log(`Profiles could not be listed; run omp-kiro auth profiles --account ${account} to name its model providers.`);
    }
    const { targets } = kiroAccountTargets(await listKiroAccounts({ authFile: defaultAuthFile }));
    const pins = pinnedKiroTargets(targets).filter((target) => target.account === account);
    for (const target of pins)
      console.log(`Model provider: ${target.provider}/… — ${JSON.stringify(target.name)}`);
    if (account === DEFAULT_ACCOUNT) {
      console.log(`For this store, set OMP_KIRO_AUTH_FILE to ${authFile}.`);
      if (useEnv && process.env.KIRO_API_KEY)
        console.log("KIRO_API_KEY takes precedence over the saved default. Unset it to use this login.");
      if (unselected)
        console.log("No profile was selected: select an assigned ARN for kiro-http, or run omp-kiro accounts to see available pinned providers and collisions.");
      else console.log("Use: omp --model kiro-http/auto");
    } else {
      console.log(`Named accounts are found beside ${defaultAuthFile}; OMP and Passession must use that same default store.`);
      if (pins.length) console.log(`Use: omp --model ${pins[0].provider}/auto`);
    }
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
    if (error.profiles)
      for (const profile of error.profiles) console.error(JSON.stringify(profile));
    process.exitCode = error.name === "AbortError" ? 130 : 1;
  });
}
