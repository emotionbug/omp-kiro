import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { refreshSocial } from "./social-login.mjs";
import { isKiroOidcRegion, refreshOidc } from "./oidc-login.mjs";
import { abortableRequest, defaultFetch, fetchWithRetry } from "./network.mjs";
import {
  KIRO_BOOTSTRAP_REGIONS, isKiroRegion, kiroCliServiceHeaders, kiroEndpoint, kiroProfileRegions,
  parseKiroProfileArn,
} from "./wire.mjs";

const refreshing = new Map();
const ACTIVE = "active";
const PROFILES = "profiles";
const REFRESH_LEASE = "refresh_lease";
const LEASE_MS = 30_000;
const LEASE_POLL_MS = 50;
const LEASE_RENEW_MS = 5_000;
const REFRESH_SKEW_MS = 60_000;
const MANAGEMENT_TIMEOUT_MS = 10_000;
const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_credential", "invalid_region", "login_expired", "registration_expired", "missing_refresh_state",
]);

export class KiroAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "KiroAuthError";
    if (code) this.code = code;
  }
}

export function authFilePath(value, env = process.env) {
  value ??= env.OMP_KIRO_AUTH_FILE;
  if (value) {
    if (!isAbsolute(value)) throw new KiroAuthError("OMP_KIRO_AUTH_FILE must be an absolute path.");
    return value;
  }
  const config = env.XDG_CONFIG_HOME;
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  const root = config && isAbsolute(config) ? config : join(home, ".config");
  return join(root, "omp-kiro", "auth.sqlite3");
}

async function openDatabase(path, readOnly) {
  try {
    let db;
    if (process.versions.bun) {
      const { Database } = await import("bun:sqlite");
      db = new Database(path, { readonly: readOnly, create: false });
    } else {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(path, { readOnly });
    }
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  } catch {
    throw new KiroAuthError(
      "Cannot open authentication storage; use Node >=22.13 or Bun and check file permissions.",
    );
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writableDatabase(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await chmod(path, 0o600);
  const db = await openDatabase(path, false);
  try {
    db.exec("PRAGMA secure_delete = ON");
    db.exec("CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function isApiKey(key) {
  return typeof key === "string" && /^ksk_[!-~]+$/.test(key);
}

function apiKeyCredential(key, region) {
  const token = typeof key === "string" ? key.trim() : key;
  if (!isApiKey(token))
    throw new KiroAuthError("Kiro API keys must use the ksk_… format.");
  if (region !== undefined && !isKiroRegion(region))
    throw new KiroAuthError("Use a valid AWS region for the Kiro API key (KIRO_API_REGION).");
  return {
    kind: "api-key", provider: "api-key", access_token: token,
    ...(region === undefined ? {} : { region }),
  };
}

function envCredential(useEnv, env) {
  if (useEnv && env.KIRO_API_KEY !== undefined && env.KIRO_API_KEY !== "")
    return apiKeyCredential(env.KIRO_API_KEY, env.KIRO_API_REGION);
  return null;
}

/** Resolve an API-key region without persisting the key or disclosing probe errors. */
export async function resolveKiroApiKeyCredential(key, {
  region, env = process.env, fetchImpl = defaultFetch, signal,
} = {}) {
  signal?.throwIfAborted();
  const credential = apiKeyCredential(key, region === undefined ? env.KIRO_API_REGION : region);
  if (credential.region) return credential;
  const timeout = AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS);
  const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const hits = await Promise.all(KIRO_BOOTSTRAP_REGIONS.map(async (candidate) => {
    try {
      const found = await fetchWithRetry(fetchImpl, kiroEndpoint({ ...credential, region: candidate }, "management"), {
        method: "POST",
        redirect: "error",
        signal: probeSignal,
        headers: kiroCliServiceHeaders("ListAvailableModels", credential.access_token),
        body: JSON.stringify({ origin: "KIRO_CLI" }),
      }, {
        retry: { maxAttempts: 1 },
        idleTimeoutMs: MANAGEMENT_TIMEOUT_MS,
        retryNetwork: false,
        retryStatus: () => false,
        async consume(response) {
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            return false;
          }
          const data = await response.json();
          return data !== null && typeof data === "object" && !Array.isArray(data);
        },
      });
      return found ? candidate : undefined;
    } catch {
      return undefined;
    }
  }));
  signal?.throwIfAborted();
  const matches = hits.filter(Boolean);
  if (matches.length !== 1)
    throw new KiroAuthError("Kiro API key did not resolve to one region; set KIRO_API_REGION to the key's AWS region.");
  return { ...credential, region: matches[0] };
}

function profileArnFor(credential, arn, routable = true) {
  const profile = parseKiroProfileArn(arn);
  const regions = kiroProfileRegions(credential);
  const supported = profile && (routable ? regions.includes(profile.region) :
    isKiroOidcRegion(profile.region) && regions[0].startsWith("us-gov-") === profile.region.startsWith("us-gov-"));
  if (!supported) throw new KiroAuthError("Kiro HTTP does not support this account profile ARN or region.");
  return profile;
}

function validateRoute(credential) {
  if (credential.kind === "oidc" && (
    !isKiroOidcRegion(credential.region) ||
    (credential.provider === "builder-id" && credential.region !== "us-east-1")
  )) throw new KiroAuthError("Unsupported AWS SSO OIDC issuer region; sign in again.");
  if (credential.profile_arn !== undefined) profileArnFor(credential, credential.profile_arn);
  return credential;
}

function disabledCredential() {
  return new KiroAuthError(
    "Kiro login can no longer be refreshed; sign in again with omp-kiro login.",
    "credential_disabled",
  );
}

function changedCredential() {
  return new KiroAuthError(
    "Kiro login changed during authentication or refresh; the newer login/logout was preserved.",
    "credential_changed",
  );
}

function validateCredential(value) {
  if (!value || typeof value !== "object" || value.kind === "logged-out") {
    throw new KiroAuthError("Not logged in. Run omp-kiro login for the HTTP transport.");
  }
  if (value.disabled !== undefined && (typeof value.disabled !== "string" || !value.disabled))
    throw new KiroAuthError("Invalid managed credential record; run omp-kiro login again.");
  if (value.kind === "api-key" && value.provider === "api-key") {
    if (!isApiKey(value.access_token) || !isKiroRegion(value.region) || value.disabled !== undefined ||
        value.profile_arn !== undefined || value.expires_at !== undefined || value.refresh_token !== undefined)
      throw new KiroAuthError("Invalid stored Kiro API key; configure the key and its region again.");
    return value;
  }
  const social = value.kind === "social" && ["google", "github"].includes(value.provider);
  const oidc = value.kind === "oidc" && ["builder-id", "identity-center"].includes(value.provider);
  if (!social && !oidc)
    throw new KiroAuthError("Unsupported managed Kiro login type; run omp-kiro login again.");
  if (
    typeof value.access_token !== "string" ||
    !value.access_token ||
    !Number.isFinite(Date.parse(value.expires_at))
  ) {
    throw new KiroAuthError("Incomplete managed Kiro credentials; run omp-kiro login again.");
  }
  // Registration and refresh state may be missing in an older row. Inspect
  // those fields during the leased refresh so it can disable the exact row.
  return value;
}

async function readRow(id, { authFile, signal }) {
  signal?.throwIfAborted();
  if (!(await exists(authFile))) return null;
  const db = await openDatabase(authFile, true);
  try {
    if (
      !db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("credentials")
    )
      return null;
    return db.prepare("SELECT value FROM credentials WHERE id = ?").get(id)?.value ?? null;
  } finally {
    db.close();
  }
}

export async function readAuthSnapshot({ authFile = authFilePath(), signal } = {}) {
  return readRow(ACTIVE, { authFile, signal });
}

function parseCredential(raw, { allowSignedOut = false, allowDisabled = false } = {}) {
  let credential;
  try {
    credential = raw === null ? null : JSON.parse(raw);
  } catch {
    throw new KiroAuthError("Invalid managed credential record; run omp-kiro login again.");
  }
  if (allowSignedOut && (credential === null || credential.kind === "logged-out")) return null;
  credential = validateCredential(credential);
  if (credential.disabled && !allowDisabled) throw disabledCredential();
  return credential;
}

// Usage-source fetches must never rotate or persist a credential.
export async function readKiroAuth({
  authFile = authFilePath(), useEnv = authFile === authFilePath(), env = process.env, signal,
} = {}) {
  signal?.throwIfAborted();
  return envCredential(useEnv, env) ?? validateRoute(parseCredential(await readAuthSnapshot({ authFile, signal })));
}

export async function saveKiroAuth(
  credential,
  { authFile = authFilePath(), expectedRaw, signal, replacesLogin = false } = {},
) {
  signal?.throwIfAborted();
  validateRoute(validateCredential(credential));
  const value = JSON.stringify(credential);
  const db = await writableDatabase(authFile);
  try {
    signal?.throwIfAborted();
    let result;
    if (expectedRaw === null) {
      result = db
        .prepare("INSERT OR IGNORE INTO credentials (id, value) VALUES (?, ?)")
        .run(ACTIVE, value);
    } else if (expectedRaw !== undefined) {
      result = db
        .prepare("UPDATE credentials SET value = ? WHERE id = ? AND value = ?")
        .run(value, ACTIVE, expectedRaw);
    } else {
      result = db
        .prepare(
          "INSERT INTO credentials (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
        )
        .run(ACTIVE, value);
    }
    if (Number(result.changes) !== 1) throw changedCredential();
    // A new login must not inherit the previous login's profile catalog.
    if (replacesLogin) db.prepare("DELETE FROM credentials WHERE id = ?").run(PROFILES);
    return credential;
  } finally {
    db.close();
  }
}

export async function logoutKiroAuth({ authFile = authFilePath(), signal } = {}) {
  signal?.throwIfAborted();
  const db = await writableDatabase(authFile);
  try {
    // A tombstone prevents an earlier login/refresh from resurrecting credentials.
    const value = JSON.stringify({ kind: "logged-out", revision: randomUUID() });
    db.prepare(
      "INSERT INTO credentials (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
    ).run(ACTIVE, value);
    db.prepare("DELETE FROM credentials WHERE id = ?").run(PROFILES);
  } finally {
    db.close();
  }
}

export async function getKiroAuthStatus({
  authFile = authFilePath(), useEnv = authFile === authFilePath(), env = process.env, now = Date.now, signal,
} = {}) {
  signal?.throwIfAborted();
  const credential = envCredential(useEnv, env) ?? parseCredential(await readAuthSnapshot({ authFile, signal }), {
    allowSignedOut: true, allowDisabled: true,
  });
  if (!credential) return { loggedIn: false, authFile };
  return {
    loggedIn: true,
    authFile,
    kind: credential.kind,
    provider: credential.provider,
    ...(credential.kind === "api-key" ? {} : { expiresAt: credential.expires_at }),
    expired: credential.kind !== "api-key" && Date.parse(credential.expires_at) <= now(),
    refreshable: !credential.disabled && credential.kind !== "api-key" &&
      typeof credential.refresh_token === "string" && Boolean(credential.refresh_token),
    ...(credential.disabled ? { disabled: credential.disabled } : {}),
  };
}

/** Non-secret profile catalog that profile listing saved for this store's login. */
export async function readProfileCatalog({ authFile = authFilePath(), signal } = {}) {
  const raw = await readRow(PROFILES, { authFile, signal });
  if (raw === null) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    value?.version !== 1 || typeof value.fetchedAt !== "string" || !Array.isArray(value.profiles) ||
    !value.profiles.every((profile) =>
      typeof profile?.name === "string" && parseKiroProfileArn(profile.arn))
  )
    return null;
  return {
    fetchedAt: value.fetchedAt,
    profiles: value.profiles.map((profile) => profileRecord(profile.arn, profile.name)),
  };
}

/** Save a listed catalog only while the login that listed it is still the store's active login. */
export async function saveProfileCatalog(profiles, { authFile = authFilePath(), credential, signal } = {}) {
  signal?.throwIfAborted();
  const value = JSON.stringify({
    version: 1,
    fetchedAt: new Date().toISOString(),
    profiles: profiles.map(({ arn, name }) => ({ arn, name })),
  });
  const db = await writableDatabase(authFile);
  try {
    const result = db.prepare(
      "INSERT INTO credentials (id, value) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM credentials WHERE id = ? AND value = ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
    ).run(PROFILES, value, ACTIVE, JSON.stringify(credential));
    return Number(result.changes) === 1;
  } finally {
    db.close();
  }
}

function profileRecord(arn, name, { region, accountId } = parseKiroProfileArn(arn)) {
  return { arn, name, region, accountId };
}

export async function queryKiroProfiles(credential, {
  signal, fetchImpl = defaultFetch, retry,
} = {}) {
  signal?.throwIfAborted();
  if (credential.disabled) throw disabledCredential();
  if (credential.kind === "api-key")
    throw new KiroAuthError("Kiro API keys do not use profiles.");
  validateRoute(credential);
  const catalogs = await Promise.allSettled(kiroProfileRegions(credential).map(async (region) => {
    const profiles = [];
    const seenTokens = new Set();
    let nextToken;
    do {
      const timeout = AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS);
      const data = await fetchWithRetry(fetchImpl, `https://management.${region}.kiro.dev/`, {
        method: "POST",
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: kiroCliServiceHeaders("ListAvailableProfiles", credential.access_token),
        body: JSON.stringify(nextToken ? { nextToken } : {}),
      }, {
        retry,
        async consume(response) {
          if (!response.ok) {
            await response.body?.cancel();
            throw new KiroAuthError(`Kiro profile lookup failed (HTTP ${response.status}).`);
          }
          return response.json();
        },
      });
      if (!Array.isArray(data?.profiles))
        throw new KiroAuthError("Kiro returned an invalid profile catalog.");
      for (const profile of data.profiles) {
        const parsed = profileArnFor(credential, profile?.arn, false);
        profiles.push(profileRecord(profile.arn,
          typeof profile.profileName === "string" ? profile.profileName : profile.arn, parsed));
      }
      nextToken = data.nextToken;
      if (nextToken) {
        if (typeof nextToken !== "string" || seenTokens.has(nextToken))
          throw new KiroAuthError("Kiro returned an invalid profile pagination token.");
        seenTokens.add(nextToken);
      }
    } while (nextToken);
    return profiles;
  }));
  signal?.throwIfAborted();
  const profiles = new Map();
  for (const catalog of catalogs) {
    if (catalog.status !== "fulfilled") continue;
    for (const profile of catalog.value) {
      if (!profiles.has(profile.arn)) profiles.set(profile.arn, profile);
    }
  }
  // An empty catalog is reliable only when every allowed region answered.
  const failure = catalogs.find(({ status }) => status === "rejected");
  if (!profiles.size && failure) throw failure.reason;
  return [...profiles.values()];
}

async function resolveProfile(credential, { signal, fetchImpl, retry, profileArn }) {
  if (profileArn !== undefined) profileArnFor(credential, profileArn);
  if (credential.profile_arn && (!profileArn || profileArn === credential.profile_arn))
    return credential;
  const profiles = await queryKiroProfiles(credential, { signal, fetchImpl, retry });
  if (!profiles.length)
    throw new KiroAuthError("No Kiro profile is assigned to this login; check your Kiro subscription.");
  const selected = profileArn ? profiles.find((profile) => profile.arn === profileArn)
    : profiles.length === 1 ? profiles[0] : undefined;
  if (!selected) {
    const error = new KiroAuthError(profileArn
      ? "The requested Kiro profile is not available to this login."
      : "Multiple Kiro profiles are available; run omp-kiro auth profile --profile <arn> to select one.");
    Object.defineProperty(error, "profiles", { value: profiles });
    throw error;
  }
  return { ...credential, profile_arn: selected.arn };
}

function assertExpectedCredential(credential, expected, profileArn) {
  if (!expected) return;
  if (credential.kind === "api-key" && expected.kind === "api-key") {
    if (credential.access_token === expected.access_token &&
        (!credential.region || !expected.region || credential.region === expected.region)) return;
  } else {
    const sameProfile = credential.profile_arn && credential.profile_arn === expected.profile_arn;
    const sameTokens = credential.access_token === expected.access_token &&
      credential.refresh_token === expected.refresh_token;
    const resolvedSameLogin = !expected.profile_arn && sameTokens &&
      authIdentity({ ...credential, profile_arn: undefined }) === authIdentity(expected);
    if ((resolvedSameLogin || authIdentity(credential) === authIdentity(expected)) &&
        (sameProfile || sameTokens) &&
        (!profileArn || !expected.profile_arn || profileArn === expected.profile_arn)) return;
  }
  throw changedDuringRecovery();
}

function changedDuringRecovery() {
  return new KiroAuthError("Kiro login or region changed during recovery; start a new turn.");
}

function missingOidcIssuer(credential) {
  return credential.kind === "oidc" && !credential.region;
}

function needsRefresh(credential, now) {
  return credential.kind !== "api-key" && (
    missingOidcIssuer(credential) ||
    Date.parse(credential.expires_at) <= now() + REFRESH_SKEW_MS
  );
}

function sqliteBusy(error) {
  return (error?.errcode & 0xff) === 5 || /^SQLITE_BUSY(?:_|$)/.test(error?.code ?? "") ||
    error?.errno === 5;
}

async function refreshUnderLease(initial, {
  authFile, signal, fetchImpl, now, retry, expectedCredential, profileArn, shouldResolveProfile,
}) {
  const owner = randomUUID();
  const deadline = performance.now() + LEASE_MS;
  const db = await openDatabase(authFile, false);
  let held, renewal;
  try {
    db.exec(`PRAGMA busy_timeout = ${LEASE_POLL_MS}; PRAGMA secure_delete = ON`);
    const expiresAt = `CASE WHEN json_valid(credentials.value)
      THEN COALESCE(CAST(json_extract(credentials.value, '$.expiresAt') AS INTEGER), 0)
      ELSE 0 END`;
    const read = db.prepare(`
      SELECT value, (SELECT ${expiresAt} FROM credentials WHERE id = ?) AS leaseExpiresAt
      FROM credentials WHERE id = ?
    `);
    // Check the active bytes for INSERT and UPDATE alike. This single write
    // elects one process even when several first see an absent or stale lease.
    const acquire = db.prepare(`
      INSERT INTO credentials (id, value)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM credentials WHERE id = ? AND value = ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
      WHERE (${expiresAt}) <= ?
    `);
    let raw, credential;
    for (;;) {
      signal?.throwIfAborted();
      if (performance.now() >= deadline)
        throw new KiroAuthError("Timed out waiting for the Kiro credential refresh; try again.", "refresh_timeout");
      try {
        const row = read.get(REFRESH_LEASE, ACTIVE);
        raw = row?.value ?? null;
        credential = parseCredential(raw);
        assertExpectedCredential(credential, expectedCredential, profileArn);
        if (!missingOidcIssuer(credential)) validateRoute(credential);
        // Use a peer's newly rotated token even if it was minted with a
        // lifetime shorter than our usual proactive refresh window.
        if (!needsRefresh(credential, now) || (!missingOidcIssuer(credential) && raw !== initial.raw &&
            (credential.access_token !== initial.credential.access_token ||
              credential.refresh_token !== initial.credential.refresh_token) &&
            Date.parse(credential.expires_at) > now())) return { credential, raw };
        const currentTime = Date.now();
        if (!(row.leaseExpiresAt > currentTime)) {
          const lease = JSON.stringify({ owner, expiresAt: currentTime + LEASE_MS });
          if (Number(acquire.run(REFRESH_LEASE, lease, ACTIVE, raw, currentTime).changes) === 1) {
            held = lease;
            break;
          }
        }
      } catch (error) {
        if (!sqliteBusy(error)) throw error;
      }
      try {
        await delay(Math.min(LEASE_POLL_MS, Math.max(0, deadline - performance.now())), undefined, { signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }

    signal?.throwIfAborted();
    const lostLease = new AbortController();
    const refreshSignal = signal ? AbortSignal.any([signal, lostLease.signal]) : lostLease.signal;
    const updateIfOwned = db.prepare(`
      UPDATE credentials SET value = ? WHERE id = ? AND value = ?
        AND EXISTS (SELECT 1 FROM credentials WHERE id = ? AND value = ?)
    `);
    // The 30s lease expires after a crash. While its owner is alive, renew it
    // through safe transport backoff without changing existing retry budgets.
    renewal = setInterval(() => {
      const next = JSON.stringify({ owner, expiresAt: Date.now() + LEASE_MS });
      try {
        if (Number(updateIfOwned.run(next, REFRESH_LEASE, held, ACTIVE, raw).changes) === 1) held = next;
        else lostLease.abort(changedCredential());
      } catch (error) {
        if (!sqliteBusy(error)) lostLease.abort(error);
      }
    }, LEASE_RENEW_MS);
    renewal.unref();
    let updated;
    try {
      if (typeof credential.refresh_token !== "string" || !credential.refresh_token)
        throw new KiroAuthError("Kiro login has no refresh credential.", "missing_refresh_state");
      const update = credential.kind === "social" ? refreshSocial : refreshOidc;
      const refreshed = await update({ credential, signal: refreshSignal, fetchImpl, now, retry });
      if (credential.profile_arn && refreshed.profile_arn && credential.profile_arn !== refreshed.profile_arn)
        throw new KiroAuthError("Kiro account profile changed during refresh; sign in again explicitly.");
      updated = validateRoute({ ...credential, ...refreshed });
      if (!shouldResolveProfile && !credential.profile_arn) delete updated.profile_arn;
    } catch (error) {
      signal?.throwIfAborted();
      lostLease.signal.throwIfAborted();
      if (!TERMINAL_REFRESH_ERRORS.has(error?.code)) throw error;
      updated = { ...credential, disabled: error.code };
    }

    // Persist a rotated token (or terminal marker) before releasing ownership
    // or doing profile discovery. Fence the CAS against both the old row and
    // the exact lease, so late owners cannot overwrite a newer login or grant.
    db.exec("PRAGMA busy_timeout = 5000");
    const value = JSON.stringify(updated);
    const result = updateIfOwned.run(value, ACTIVE, raw, REFRESH_LEASE, held);
    if (Number(result.changes) !== 1) throw changedCredential();
    if (updated.disabled) throw disabledCredential();
    return { credential: updated, raw: value };
  } finally {
    clearInterval(renewal);
    try {
      if (held) db.prepare("DELETE FROM credentials WHERE id = ? AND value = ?").run(REFRESH_LEASE, held);
    } catch {
      // Cleanup cannot invalidate a committed refresh or replace its error.
      // The ownership fence and expiry bound any lease left behind.
    } finally {
      db.close();
    }
  }
}

export async function loadKiroAuth({
  signal,
  fetchImpl = defaultFetch,
  authFile = authFilePath(),
  useEnv = authFile === authFilePath(),
  env = process.env,
  now = Date.now,
  retry,
  expectedCredential,
  profileArn,
  resolveProfile: shouldResolveProfile = true,
} = {}) {
  signal?.throwIfAborted();
  const fromEnv = envCredential(useEnv, env);
  const raw = fromEnv ? null : await readAuthSnapshot({ authFile, signal });
  const credential = fromEnv ?? parseCredential(raw);
  assertExpectedCredential(credential, expectedCredential, profileArn);
  if (credential.kind === "api-key") {
    if (profileArn !== undefined) throw new KiroAuthError("Kiro API keys do not use profiles.");
    const resolved = credential.region ? credential : await resolveKiroApiKeyCredential(credential.access_token, {
      env, signal, fetchImpl,
    });
    assertExpectedCredential(resolved, expectedCredential, profileArn);
    return resolved;
  }
  // A missing legacy issuer is definitive when refresh is needed. An
  // explicit but unsupported issuer/ARN must never get as far as a request.
  if (!missingOidcIssuer(credential)) validateRoute(credential);
  if (profileArn !== undefined) profileArnFor(credential, profileArn);
  if (!needsRefresh(credential, now) && (!shouldResolveProfile ||
    (credential.profile_arn && (!profileArn || credential.profile_arn === profileArn)))) return credential;
  const inFlight = refreshing.get(authFile);
  if (inFlight) {
    if (signal) await abortableRequest(() => inFlight, signal);
    else await inFlight;
    return loadKiroAuth({
      signal, fetchImpl, authFile, useEnv, env, now, retry, expectedCredential, profileArn,
      resolveProfile: shouldResolveProfile,
    });
  }
  const prepare = async () => {
    const { credential: updated, raw: expectedRaw } = needsRefresh(credential, now)
      ? await refreshUnderLease({ raw, credential }, {
        authFile, signal, fetchImpl, now, retry, expectedCredential, profileArn, shouldResolveProfile,
      })
      : { credential, raw };
    if (updated.kind === "api-key") {
      if (profileArn !== undefined) throw new KiroAuthError("Kiro API keys do not use profiles.");
      return updated;
    }
    const resolved = shouldResolveProfile
      ? await resolveProfile(updated, { signal, fetchImpl, retry, profileArn })
      : updated;
    if (resolved !== updated) {
      try {
        await saveKiroAuth(resolved, { authFile, expectedRaw, signal });
      } catch (error) {
        // Another process may have committed this identical profile resolution.
        if (error.code !== "credential_changed" ||
            await readAuthSnapshot({ authFile, signal }) !== JSON.stringify(resolved)) throw error;
      }
    }
    return resolved;
  };
  const pending = prepare();
  refreshing.set(authFile, pending);
  try {
    return await pending;
  } finally {
    if (refreshing.get(authFile) === pending) refreshing.delete(authFile);
  }
}

function authIdentity(auth) {
  if (auth.kind === "api-key") return JSON.stringify([auth.kind, auth.region, auth.access_token]);
  return JSON.stringify([
    auth.kind, auth.provider, auth.region ?? (auth.kind === "social" ? "us-east-1" : undefined),
    auth.profile_arn, auth.client_id,
  ]);
}

/** Refresh before a replay-safe HTTP attempt without silently changing identity. */
export async function refreshExpiredKiroAuth(credential, {
  signal, fetchImpl, authFile, retry, authProvider = loadKiroAuth, now = Date.now,
} = {}) {
  if (credential.disabled) throw disabledCredential();
  if (!(Date.parse(credential.expires_at) <= now() + REFRESH_SKEW_MS)) return credential;
  const refreshed = await authProvider({
    signal, fetchImpl, authFile, retry, now, expectedCredential: credential,
  });
  if (refreshed.disabled) throw disabledCredential();
  if (authIdentity(credential) !== authIdentity(refreshed))
    throw changedDuringRecovery();
  return refreshed;
}

/**
 * Auth for a fixed profile, or for an API-key selection when no ARN is given.
 * OAuth rotation may persist new tokens, but not the pinned profile selection.
 */
export function pinnedKiroAuth({ authFile, profileArn, useEnv }) {
  return async ({ expectedCredential, ...options } = {}) => {
    const selected = { ...options, authFile, useEnv, resolveProfile: false };
    if (profileArn === undefined) {
      const current = await readKiroAuth(selected);
      if (current.kind !== "api-key") throw changedDuringRecovery();
      return loadKiroAuth({ ...selected, expectedCredential: expectedCredential ?? current });
    }
    const credential = await loadKiroAuth({ ...selected, profileArn });
    const pinned = { ...credential, profile_arn: profileArn };
    if (expectedCredential && authIdentity(pinned) !== authIdentity(expectedCredential))
      throw changedDuringRecovery();
    return pinned;
  };
}

export async function importCliAuth({
  databasePath = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3"),
  authFile = authFilePath(),
  signal,
} = {}) {
  signal?.throwIfAborted();
  const expectedRaw = await readAuthSnapshot({ authFile, signal });
  const db = await openDatabase(databasePath, true);
  let raw;
  try {
    raw = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get("kirocli:social:token")?.value;
  } finally {
    db.close();
  }
  if (!raw)
    throw new KiroAuthError(
      "No social login found in the selected CLI database; use omp-kiro login instead.",
    );
  let source;
  try {
    source = JSON.parse(raw);
  } catch {
    throw new KiroAuthError("Invalid CLI social login record; use omp-kiro login instead.");
  }
  const credential = validateCredential({ ...source, kind: "social" });
  return saveKiroAuth(credential, { authFile, expectedRaw, signal, replacesLogin: true });
}
