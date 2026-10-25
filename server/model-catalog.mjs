import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const REFRESH = "Refresh the account model catalog with models.cmd, then start again.";
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));

function invalid(reason) {
  return new Error(`Kiro model catalog ${reason}. ${REFRESH}`);
}

/** Stable account binding; the digest never includes tokens when a profile ARN exists. */
export function kiroCatalogAccountId(auth) {
  const social = auth?.kind === "social" && ["google", "github"].includes(auth.provider);
  const oidc = auth?.kind === "oidc" && ["builder-id", "identity-center"].includes(auth.provider);
  if (!social && !oidc) throw invalid("has no supported managed account identity");
  for (const key of ["region", "client_id", "profile_arn", "refresh_token"]) {
    if (auth[key] !== undefined && !nonempty(auth[key]))
      throw invalid("has an incomplete managed account identity");
  }
  if (oidc && (!nonempty(auth.region) || !nonempty(auth.client_id)))
    throw invalid("has an incomplete managed account identity");
  const binding = auth.profile_arn
    ? ["profile", auth.profile_arn]
    : auth.refresh_token
      ? ["refresh", auth.refresh_token]
      : ["access", auth.access_token];
  if (!nonempty(binding[1])) throw invalid("has no managed account binding");
  return createHash("sha256").update(JSON.stringify([
    auth.kind,
    auth.provider,
    auth.region ?? "us-east-1",
    auth.client_id ?? null,
    binding,
  ])).digest("hex");
}

/** Read only explicit, bounded, account-bound metadata. Never refresh auth or contact Kiro. */
export async function readKiroModelCatalog(file, { auth } = {}) {
  if (typeof file !== "string" || !isAbsolute(file))
    throw invalid("path must be absolute");
  let data;
  try {
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES)
        throw invalid("must be a regular file of at most 4 MiB");
      // One sentinel byte detects growth without an unbounded readFile allocation.
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > stat.size) throw invalid("changed while being read");
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    } finally {
      await handle.close();
    }
  } catch {
    throw invalid("cannot be read as bounded valid JSON");
  }
  if (
    !record(data) || !onlyKeys(data, ["version", "fetchedAt", "accountId", "models"]) ||
    data.version !== 1 || typeof data.fetchedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(data.fetchedAt) || !Number.isFinite(Date.parse(data.fetchedAt)) ||
    typeof data.accountId !== "string" || !/^[a-f0-9]{64}$/.test(data.accountId) ||
    !Array.isArray(data.models)
  ) throw invalid("has an invalid snapshot schema");
  const ids = new Set();
  for (const model of data.models) {
    if (
      !record(model) || !onlyKeys(model, ["id", "name", "contextWindow", "maxTokens"]) ||
      !nonempty(model.id) || !nonempty(model.name) || ids.has(model.id) ||
      ["contextWindow", "maxTokens"].some((key) =>
        Object.hasOwn(model, key) && (!Number.isSafeInteger(model[key]) || model[key] <= 0))
    ) throw invalid("contains invalid or duplicate model metadata");
    ids.add(model.id);
  }
  if (data.accountId !== kiroCatalogAccountId(auth))
    throw invalid("belongs to a different managed account");
  return data.models;
}
