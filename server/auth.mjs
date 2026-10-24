import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { refreshSocial } from "./social-login.mjs";
import { refreshOidc } from "./oidc-login.mjs";

const refreshing = new Map();

export class KiroAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "KiroAuthError";
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

function validateCredential(value) {
  if (!value || typeof value !== "object" || value.kind === "logged-out") {
    throw new KiroAuthError("Not logged in. Run omp-kiro login for the HTTP transport.");
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
  if (
    oidc &&
    [value.client_id, value.client_secret, value.region].some(
      (field) => typeof field !== "string" || !field,
    )
  ) {
    throw new KiroAuthError("Missing OIDC registration; run omp-kiro login again.");
  }
  return value;
}

export async function readAuthSnapshot({ authFile = authFilePath(), signal } = {}) {
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
    return db.prepare("SELECT value FROM credentials WHERE id = ?").get("active")?.value ?? null;
  } finally {
    db.close();
  }
}

function parseCredential(raw, { allowSignedOut = false } = {}) {
  let credential;
  try {
    credential = raw === null ? null : JSON.parse(raw);
  } catch {
    throw new KiroAuthError("Invalid managed credential record; run omp-kiro login again.");
  }
  if (allowSignedOut && (credential === null || credential.kind === "logged-out")) return null;
  return validateCredential(credential);
}

// Usage-source fetches must never rotate or persist a credential.
export async function readKiroAuth({ authFile = authFilePath(), signal } = {}) {
  return parseCredential(await readAuthSnapshot({ authFile, signal }));
}

export async function saveKiroAuth(
  credential,
  { authFile = authFilePath(), expectedRaw, signal } = {},
) {
  signal?.throwIfAborted();
  validateCredential(credential);
  const value = JSON.stringify(credential);
  const db = await writableDatabase(authFile);
  try {
    signal?.throwIfAborted();
    let result;
    if (expectedRaw === null) {
      result = db
        .prepare("INSERT OR IGNORE INTO credentials (id, value) VALUES (?, ?)")
        .run("active", value);
    } else if (expectedRaw !== undefined) {
      result = db
        .prepare("UPDATE credentials SET value = ? WHERE id = ? AND value = ?")
        .run(value, "active", expectedRaw);
    } else {
      result = db
        .prepare(
          "INSERT INTO credentials (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
        )
        .run("active", value);
    }
    if (Number(result.changes) !== 1)
      throw new KiroAuthError(
        "Kiro login changed during authentication or refresh; the newer login/logout was preserved.",
      );
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
    ).run("active", value);
  } finally {
    db.close();
  }
}

export async function getKiroAuthStatus({ authFile = authFilePath(), now = Date.now } = {}) {
  const raw = await readAuthSnapshot({ authFile });
  const credential = parseCredential(raw, { allowSignedOut: true });
  if (!credential) return { loggedIn: false, authFile };
  return {
    loggedIn: true,
    authFile,
    kind: credential.kind,
    provider: credential.provider,
    expiresAt: credential.expires_at,
    expired: Date.parse(credential.expires_at) <= now(),
    refreshable: typeof credential.refresh_token === "string" && Boolean(credential.refresh_token),
  };
}

export async function loadKiroAuth({
  signal,
  fetchImpl = globalThis.fetch,
  authFile = authFilePath(),
  now = Date.now,
} = {}) {
  signal?.throwIfAborted();
  const raw = await readAuthSnapshot({ authFile, signal });
  const credential = parseCredential(raw);
  if (Date.parse(credential.expires_at) > now() + 60_000) return credential;
  if (refreshing.has(authFile)) {
    await refreshing.get(authFile);
    signal?.throwIfAborted();
    return loadKiroAuth({ signal, fetchImpl, authFile, now });
  }
  const refresh = async () => {
    if (typeof credential.refresh_token !== "string" || !credential.refresh_token) {
      throw new KiroAuthError(
        "Kiro login expired without a refresh credential; run omp-kiro login again.",
      );
    }
    const update = credential.kind === "social" ? refreshSocial : refreshOidc;
    const refreshed = await update({ credential, signal, fetchImpl, now });
    const updated = { ...credential, ...refreshed };
    await saveKiroAuth(updated, { authFile, expectedRaw: raw, signal });
    return updated;
  };
  const pending = refresh();
  refreshing.set(authFile, pending);
  try {
    return await pending;
  } finally {
    if (refreshing.get(authFile) === pending) refreshing.delete(authFile);
  }
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
  return saveKiroAuth(credential, { authFile, expectedRaw, signal });
}
