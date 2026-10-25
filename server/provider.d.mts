import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type { createHttpTransport } from "./http.mjs";
import type { loadKiroAuth } from "./auth.mjs";

export interface KiroHttpProviderOptions {
  stateDir?: string;
  fetchImpl?: typeof fetch;
  authProvider?: typeof loadKiroAuth;
  transportFactory?: typeof createHttpTransport;
  retry?: { maxAttempts?: number | null; baseDelayMs?: number; maxDelayMs?: number };
}

export function createKiroHttpProvider(options?: KiroHttpProviderOptions): ProviderRegistration;
