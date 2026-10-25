import { randomUUID } from "node:crypto";
import { loadKiroAuth, refreshExpiredKiroAuth } from "./auth.mjs";
import { endpointFor } from "./http.mjs";
import { fetchWithRetry, isTlsError } from "./network.mjs";

const MAX_RESPONSE = 1024 * 1024;
export class KiroWebError extends Error {
  constructor(message, { code = "INVALID_RESPONSE", status } = {}) {
    super(message);
    this.name = "KiroWebError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

async function responseJson(response, touch) {
  if (!response.body) throw new KiroWebError("Kiro web service returned no body.");
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw new KiroWebError("Kiro web response exceeds the 1 MiB limit.");
      parts.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(parts, size).toString("utf8"));
    } catch {
      throw new KiroWebError("Kiro web service returned invalid JSON.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createKiroWebClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  authProvider = loadKiroAuth,
  retry,
} = {}) {
  async function request(method, params, signal) {
    signal?.throwIfAborted();
    let auth = await authProvider({ signal, fetchImpl, retry });
    const id = randomUUID();
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    try {
      const payload = await fetchWithRetry(fetchImpl, new URL("mcp", endpointFor(auth)), {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${auth.access_token}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "omp-kiro",
          ...(auth.profile_arn ? { "x-amzn-kiro-profile-arn": auth.profile_arn } : {}),
        },
        body,
      }, {
        retry,
        async prepareRequest(init) {
          auth = await refreshExpiredKiroAuth(auth, { signal, fetchImpl, retry, authProvider });
          return { ...init, headers: { ...init.headers, authorization: `Bearer ${auth.access_token}` } };
        },
        async consume(response, touch) {
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new KiroWebError(`Kiro web service rejected the request (HTTP ${response.status}).`, {
              code: "HTTP_ERROR", status: response.status,
            });
          }
          return responseJson(response, touch);
        },
      });
      if (!payload || payload.id !== id || (payload.jsonrpc !== undefined && payload.jsonrpc !== "2.0"))
        throw new KiroWebError("Kiro web service returned a mismatched JSON-RPC response.");
      if (payload.error || payload.result?.isError)
        throw new KiroWebError("Kiro web search was rejected; check account and organization web-tool policy.", { code: "SEARCH_REJECTED" });
      if (!payload.result || typeof payload.result !== "object")
        throw new KiroWebError("Kiro web service omitted its result.");
      return payload.result;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof KiroWebError) throw error;
      if (isTlsError(error))
        throw new KiroWebError("Kiro TLS certificate verification failed; check the approved CA configuration.", { code: "TLS_ERROR" });
      throw new KiroWebError("Kiro web service request failed; check approved connectivity and account configuration.", { code: "NETWORK_ERROR" });
    }
  }
  return {
    async listTools({ signal } = {}) {
      const result = await request("tools/list", undefined, signal);
      if (!Array.isArray(result.tools)) throw new KiroWebError("Kiro web service returned no tool inventory.");
      return result.tools;
    },
    async search(query, { signal } = {}) {
      if (typeof query !== "string" || !query.trim() || [...query].length > 200)
        throw new KiroWebError("Search query must contain 1–200 characters.", { code: "INVALID_QUERY" });
      const result = await request("tools/call", { name: "web_search", arguments: { query } }, signal);
      let data = result.structuredContent;
      if (!data) {
        const text = Array.isArray(result.content)
          ? result.content.find((entry) => entry?.type === "text")?.text
          : undefined;
        try { data = JSON.parse(text); } catch {
          throw new KiroWebError("Kiro web search returned an unrecognized result.");
        }
      }
      if (!Array.isArray(data?.results) || data.results.some((row) =>
        !row || typeof row !== "object" || typeof row.url !== "string" || !/^https?:\/\//i.test(row.url)))
        throw new KiroWebError("Kiro web search returned invalid source results.");
      // Preserve citations, publication dates and source-specific reproduction limits.
      return data;
    },
  };
}

export function createKiroSearchTool(options = {}) {
  const client = createKiroWebClient(options);
  return {
    name: "web_search",
    description: "Search the public web through the authenticated Kiro backend. Returns source URLs, snippets and per-source usage limits, not full-page content. The client does not open returned source URLs.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,
    validate: (args) =>
      args !== null && typeof args === "object" && !Array.isArray(args) &&
      Object.keys(args).length === 1 && typeof args.query === "string" &&
      Boolean(args.query.trim()) && [...args.query].length <= 200,
    detail: ({ query }) => ({ type: "plain_text", label: "Kiro web search", text: query }),
    async execute({ query }, signal) {
      const result = await client.search(query, { signal });
      const text = JSON.stringify(result);
      return { text, detail: { type: "plain_text", label: "Kiro web search", text } };
    },
  };
}

export function registerKiroWebSearch(pi, options = {}) {
  const tool = createKiroSearchTool(options);
  pi.registerTool({
    name: tool.name,
    label: "Kiro Web Search",
    description: tool.description,
    approval: "read",
    loadMode: "essential",
    parameters: pi.zod.object({
      query: pi.zod.string().min(1).refine(
        (value) => Boolean(value.trim()) && [...value].length <= 200,
        "Search query must contain 1–200 Unicode characters and not be blank.",
      ).describe("Search query, 1–200 Unicode characters."),
    }).strict(),
    async execute(_id, params, signal) {
      const result = await tool.execute(params, signal);
      return { content: [{ type: "text", text: result.text }], details: { provider: "kiro" } };
    },
  });
}
