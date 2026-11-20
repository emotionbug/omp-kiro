import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  authFilePath,
  getKiroAuthStatus,
  KiroAuthError,
  readKiroAuth,
  readProfileCatalog,
} from "./auth.mjs";
import { kiroProfileRegions, parseKiroProfileArn } from "./wire.mjs";

export const DEFAULT_ACCOUNT = "default";
const ACCOUNT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// `kiro-http` and `kiro-cli` are the unpinned model providers.
const RESERVED = new Set(["http", "cli"]);

function validName(name) {
  return typeof name === "string" && ACCOUNT_NAME.test(name) && !RESERVED.has(name);
}

/** Named account stores live next to the default store. */
export function kiroAccountsDirectory(authFile = authFilePath()) {
  return join(dirname(authFile), "accounts");
}

export function kiroAccountAuthFile(name, { authFile = authFilePath() } = {}) {
  if (name === DEFAULT_ACCOUNT) return authFile;
  if (!validName(name))
    throw new KiroAuthError(
      "Account names use 1–32 lowercase letters, digits or inner hyphens; http and cli are reserved.",
    );
  return join(kiroAccountsDirectory(authFile), `${name}.sqlite3`);
}

/**
 * Model provider for one account profile: `kiro-<account>-<profile ID>`.
 * The profile ID is the ARN's final segment, lowercased and reduced to
 * letters and digits, so it stays stable when Kiro renames the profile.
 */
export function kiroTargetProvider(account, arn, kind) {
  const id = kind === "api-key" ? "key" :
    parseKiroProfileArn(arn)?.profileId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return id ? `kiro-${account}-${id}` : undefined;
}

async function readAccount(name, authFile, now, useEnv) {
  try {
    const status = await getKiroAuthStatus({ authFile, now, useEnv });
    if (!status.loggedIn || status.disabled || status.kind === "api-key")
      return { name, authFile, status, selectedArn: null, catalog: null };
    const [credential, catalog] = await Promise.all([
      readKiroAuth({ authFile, useEnv }),
      readProfileCatalog({ authFile }),
    ]);
    return {
      name, authFile,
      status: credential.provider === "identity-center" ? { ...status, region: credential.region } : status,
      selectedArn: credential.profile_arn ?? null, catalog,
    };
  } catch (error) {
    return {
      name,
      authFile,
      error: error instanceof KiroAuthError ? error.message : "The account store could not be read.",
    };
  }
}

/** Local, network-free inventory: the default store first, then named stores by name. */
export async function listKiroAccounts({ authFile = authFilePath(), now = Date.now, useEnv = authFile === authFilePath() } = {}) {
  const directory = kiroAccountsDirectory(authFile);
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const names = entries
    .map((entry) => entry.isFile() && /^(.+)\.sqlite3$/.exec(entry.name)?.[1])
    .filter((name) => name && name !== DEFAULT_ACCOUNT && validName(name))
    .sort();
  return Promise.all([
    readAccount(DEFAULT_ACCOUNT, authFile, now, useEnv),
    ...names.map((name) => readAccount(name, join(directory, `${name}.sqlite3`), now, false)),
  ]);
}

function labelPart(value) {
  // Hosts split model names on "/" and ": "; keep account labels intact.
  return String(value).replace(/[\p{Cc}/:]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Every signed-in account profile usable over HTTP. A store without a listed
 * catalog contributes its saved selection, whose name is not known yet.
 */
export function kiroTargets(accounts) {
  const targets = [];
  const seen = new Set();
  for (const account of accounts) {
    if (!account.status?.loggedIn || account.status.disabled) continue;
    if (account.status.kind === "api-key") {
      const provider = kiroTargetProvider(account.name, null, "api-key");
      if (!seen.has(provider)) {
        seen.add(provider);
        targets.push({
          provider, account: account.name, authFile: account.authFile,
          arn: null, name: "API key", label: account.name,
        });
      }
      continue;
    }
    const listed = account.catalog?.profiles ?? (account.selectedArn ? [{ arn: account.selectedArn }] : []);
    const regions = kiroProfileRegions(account.status);
    const profiles = listed
      .filter((profile) => regions.includes(parseKiroProfileArn(profile.arn)?.region))
      .sort((left, right) => (left.arn < right.arn ? -1 : left.arn > right.arn ? 1 : 0));
    for (const profile of profiles) {
      const provider = kiroTargetProvider(account.name, profile.arn);
      if (!provider || seen.has(provider)) continue;
      seen.add(provider);
      const name = profile.name === undefined ? "" : labelPart(profile.name);
      targets.push({
        provider,
        account: account.name,
        authFile: account.authFile,
        arn: profile.arn,
        name: profile.name ?? null,
        label: profiles.length > 1 && name ? `${account.name} · ${name}` : account.name,
      });
    }
  }
  return targets;
}

/**
 * Pinned providers appear only when there is a choice to make: a named account
 * exists or one store has several profiles. A lone default profile stays
 * available as `kiro-http` without duplicating its models.
 */
export function pinnedKiroTargets(targets) {
  return targets.length > 1 || targets.some((target) => target.account !== DEFAULT_ACCOUNT)
    ? targets
    : [];
}
