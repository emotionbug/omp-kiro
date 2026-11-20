import {
  KiroAuthError,
  loadKiroAuth,
  queryKiroProfiles,
  readAuthSnapshot,
  readKiroAuth,
  saveKiroAuth,
  saveProfileCatalog,
} from "./auth.mjs";
import { fetchKiroUsage, KiroUsageError } from "./usage.mjs";
import { kiroProfileRegions } from "./wire.mjs";

/** Only a complete listing can replace the store's saved profile catalog. */
async function catalog(options) {
  // A key has no profiles regardless of whether its API region has been
  // resolved yet. Do not probe its region for a profile-only command.
  if ((await readKiroAuth(options)).kind === "api-key") return { profiles: [], apiKey: true };
  const credential = await loadKiroAuth({ ...options, resolveProfile: false });
  if (credential.kind === "api-key") return { profiles: [], apiKey: true };
  const { profiles, complete } = await queryKiroProfiles(credential, options);
  if (complete)
    await saveProfileCatalog(profiles, { authFile: options.authFile, credential, signal: options.signal });
  return { credential, profiles, complete };
}

/** Enumerate assigned profiles without choosing a default profile. */
export async function listKiroProfiles(options = {}) {
  const { credential, profiles, complete, apiKey } = await catalog(options);
  return { selectedArn: credential?.profile_arn ?? null, profiles, ...(apiKey ? { apiKey } : { complete }) };
}

/** Compare quotas with an in-memory selection; refresh only the stored identity. */
export async function fetchKiroProfileUsage(options = {}) {
  let { credential, profiles, complete, apiKey } = await catalog(options);
  if (apiKey) return { selectedArn: null, profiles, apiKey };
  const selectedArn = credential.profile_arn ?? null;
  const reports = [];
  for (const profile of profiles) {
    options.signal?.throwIfAborted();
    try {
      const usage = await fetchKiroUsage({
        ...options,
        authProvider: async ({ signal, fetchImpl, retry }) => {
          credential = await loadKiroAuth({
            ...options, signal, fetchImpl, retry,
            expectedCredential: credential,
            resolveProfile: false,
          });
          return { ...credential, profile_arn: profile.arn };
        },
      });
      reports.push({ ...profile, usage });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof KiroUsageError && error.code === "CANCELLED") throw error;
      reports.push({
        ...profile,
        error: error instanceof KiroUsageError
          ? error.message
          : "Kiro profile usage could not be read.",
      });
    }
  }
  options.signal?.throwIfAborted();
  return { selectedArn, profiles: reports, complete };
}

/** Commit only the credential snapshot whose catalog was used for selection. */
export async function selectKiroProfile(selector, options = {}) {
  if (typeof selector !== "string" || !selector)
    throw Object.assign(
      new KiroAuthError("Provide an exact Kiro profile ARN or unique profile name."),
      { code: "invalid_profile" },
    );
  const { credential, profiles, complete, apiKey } = await catalog(options);
  if (apiKey)
    throw Object.assign(new KiroAuthError("Kiro API keys have no profiles."), { code: "api_key_no_profiles" });
  const exactArn = profiles.find((profile) => profile.arn === selector);
  if (!exactArn && !complete)
    throw new KiroAuthError("Kiro profile lookup was incomplete; specify an available profile ARN or try again.", "partial_profiles");
  const matches = exactArn ? [exactArn] : profiles.filter((profile) => profile.name === selector);
  if (!matches.length)
    throw Object.assign(
      new KiroAuthError("The requested Kiro profile is not available to this login."),
      { code: "unknown_profile" },
    );
  if (matches.length !== 1)
    throw Object.assign(
      new KiroAuthError("The Kiro profile name is ambiguous; select an exact profile ARN."),
      { code: "ambiguous_profile" },
    );
  const selected = matches[0];
  if (!kiroProfileRegions(credential).includes(selected.region))
    throw Object.assign(
      new KiroAuthError("Kiro HTTP does not support this profile region."),
      { code: "unsupported_profile_region" },
    );

  const expectedRaw = await readAuthSnapshot(options);
  let sameCredential = false;
  try {
    sameCredential = expectedRaw !== null &&
      JSON.stringify(JSON.parse(expectedRaw)) === JSON.stringify(credential);
  } catch {
    // A malformed replacement is still a concurrent change, not our snapshot.
  }
  // Never adopt a concurrent login, logout, selection, rotation, or generation.
  if (!sameCredential) {
    const error = new KiroAuthError(
      "Kiro login changed during profile selection; the newer login/logout was preserved.",
    );
    error.code = "credential_changed";
    throw error;
  }
  await saveKiroAuth({ ...credential, profile_arn: selected.arn }, { ...options, expectedRaw });
  return selected;
}
