import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { authFilePath, getKiroAuthStatus, readKiroAuth } from "./auth.mjs";
import { fetchKiroUsage, KiroUsageError } from "./usage.mjs";

const inputSchema = z.object({ authFile: z.string().refine(isAbsolute) }).strict();

/** @returns {import("@getpaseo/plugin/server/usage").UsageSourceRegistration} */
export function createKiroUsageSource({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  return {
    id: "kiro",
    label: "Kiro HTTP",
    icon: "icon.svg",
    input: inputSchema,
    async discover(scope) {
      if (
        scope.kind === "session" &&
        scope.provider !== "kiro-http" &&
        scope.env.OMP_KIRO_TRANSPORT !== "http" &&
        !scope.model?.startsWith("kiro-http/")
      )
        return [];
      const authFile = authFilePath(undefined, scope.kind === "session" ? scope.env : process.env);
      try {
        const status = await getKiroAuthStatus({ authFile, now });
        if (!status.loggedIn) return [];
        const path = await realpath(authFile);
        return [
          {
            key: createHash("sha256").update(path).digest("hex"),
            label: `Kiro HTTP · ${status.provider}`,
            harness: "Kiro HTTP",
            input: { authFile: path },
          },
        ];
      } catch {
        return [];
      }
    },
    async fetch(input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success)
        return { status: "error", error: "Invalid Kiro authentication store locator." };
      const { authFile } = parsed.data;
      try {
        // SDK usage sources re-read the store but must never rotate or write credentials.
        const credential = await readKiroAuth({ authFile });
        if (Date.parse(credential.expires_at) <= now()) {
          return {
            status: "unavailable",
            problem: { kind: "expired", expiresAt: credential.expires_at, refreshedBy: "omp-kiro" },
          };
        }
        return await fetchKiroUsage({
          authFile,
          fetchImpl,
          now,
          authProvider: async () => credential,
        });
      } catch (error) {
        if (error instanceof KiroUsageError && [401, 403].includes(error.status)) {
          return {
            status: "unavailable",
            problem: { kind: "rejected", status: error.status, refreshedBy: "omp-kiro" },
          };
        }
        return {
          status: "error",
          error:
            error instanceof KiroUsageError
              ? error.message
              : "Kiro HTTP login unavailable. Run omp-kiro login, then refresh usage.",
        };
      }
    },
  };
}
