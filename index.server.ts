import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createKiroHttpProvider } from "./server/provider.mjs";
import { createKiroUsageSource } from "./server/usage-source.mjs";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createKiroHttpProvider());
  server.registerUsageSource(createKiroUsageSource());
  return () => {};
}
