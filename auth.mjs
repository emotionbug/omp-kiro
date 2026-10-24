import { homedir } from "node:os";
import { join } from "node:path";

const SOCIAL_KEY = "kirocli:social:token";
const REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const refreshing = new Map();

export class KiroAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "KiroAuthError";
  }
}

async function openDatabase(path, readOnly) {
  try {
    if (process.versions.bun) {
      const { Database } = await import("bun:sqlite");
      return new Database(path, { readonly: readOnly, create: false });
    }
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(path, { readOnly });
  } catch {
    throw new KiroAuthError(
      "Cannot open Kiro authentication database; use Node >=22.13 or Bun and run kiro-cli login first.",
    );
  }
}

function readRecord(db) {
  const row = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get(SOCIAL_KEY);
  if (!row)
    throw new KiroAuthError(
      "No supported Kiro social login found. Run kiro-cli login with Google; other login modes are not supported by the HTTP transport.",
    );
  let token;
  try {
    token = JSON.parse(row.value);
  } catch {
    throw new KiroAuthError("Invalid Kiro social credential record; run kiro-cli login again.");
  }
  // Only this login provider was observed in the installed account's schema.
  if (token.provider !== "google")
    throw new KiroAuthError(
      "Unsupported Kiro social login provider; this HTTP transport currently supports the observed Google login only.",
    );
  if (
    typeof token.access_token !== "string" ||
    !token.access_token ||
    !Number.isFinite(Date.parse(token.expires_at))
  ) {
    throw new KiroAuthError("Incomplete Kiro social credential record; run kiro-cli login again.");
  }
  return { raw: row.value, token };
}

export async function loadKiroAuth({
  signal,
  fetchImpl = globalThis.fetch,
  databasePath = process.env.OMP_KIRO_AUTH_DB ||
    join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3"),
  now = Date.now,
} = {}) {
  signal?.throwIfAborted();
  let db = await openDatabase(databasePath, true);
  let record;
  try {
    record = readRecord(db);
  } finally {
    db.close();
  }
  if (Date.parse(record.token.expires_at) > now() + 60_000) return record.token;
  if (refreshing.has(databasePath)) {
    await refreshing.get(databasePath);
    signal?.throwIfAborted();
    return loadKiroAuth({ signal, fetchImpl, databasePath, now });
  }
  const refresh = async () => {
    const { token, raw } = record;
    if (typeof token.refresh_token !== "string" || !token.refresh_token)
      throw new KiroAuthError(
        "Kiro login expired without a refresh credential; run kiro-cli login again.",
      );
    const response = await fetchImpl(REFRESH_URL, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json", "user-agent": "omp-kiro" },
      body: JSON.stringify({ refreshToken: token.refresh_token }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new KiroAuthError(
        `Kiro credential refresh failed (HTTP ${response.status}); run kiro-cli login again.`,
      );
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new KiroAuthError("Kiro credential refresh returned invalid JSON.");
    }
    if (
      typeof result.accessToken !== "string" ||
      !result.accessToken ||
      !Number.isFinite(result.expiresIn) ||
      result.expiresIn <= 60 ||
      (result.refreshToken !== undefined &&
        (typeof result.refreshToken !== "string" || !result.refreshToken))
    ) {
      throw new KiroAuthError("Kiro credential refresh returned incomplete credentials.");
    }
    const updated = {
      ...token,
      access_token: result.accessToken,
      refresh_token: result.refreshToken ?? token.refresh_token,
      expires_at: new Date(now() + result.expiresIn * 1000).toISOString(),
      profile_arn: result.profileArn ?? token.profile_arn,
    };
    signal?.throwIfAborted();
    db = await openDatabase(databasePath, false);
    try {
      // A concurrent CLI login/logout must never be undone by our refresh.
      const change = db
        .prepare("UPDATE auth_kv SET value = ? WHERE key = ? AND value = ?")
        .run(JSON.stringify(updated), SOCIAL_KEY, raw);
      if (Number(change.changes) !== 1)
        throw new KiroAuthError(
          "Kiro login changed during refresh; retry using the current login.",
        );
    } finally {
      db.close();
    }
    return updated;
  };
  const pending = refresh();
  refreshing.set(databasePath, pending);
  try {
    return await pending;
  } finally {
    if (refreshing.get(databasePath) === pending) refreshing.delete(databasePath);
  }
}
