import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { spawnProcess } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { stopProcess } from "./tools.mjs";

const ajv = new Ajv({ strict: false, allErrors: true });
const MAX_FRAME = 2 * 1024 * 1024;

/** SDK process helpers, not the MCP SDK's platform-specific child launcher. */
class StdioTransport {
  constructor(config, context) {
    this.config = config;
    this.context = context;
    this.buffer = new ReadBuffer();
    this.frameBytes = 0;
  }
  async start() {
    if (this.child) throw new Error("MCP transport already started");
    this.child = spawnProcess(this.config.command, this.config.args ?? [], {
      cwd: this.context.cwd,
      env: { ...this.context.env, ...this.config.env },
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    const fail = (error) => {
      this.onerror?.(error);
      void this.close().catch((closeError) => this.onerror?.(closeError));
    };
    this.child.stderr.resume(); // Server diagnostics may contain secrets; never forward or persist them.
    this.child.on("error", fail);
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr])
      stream.on("error", fail);
    this.child.on("close", () => this.onclose?.());
    this.child.stdout.on("data", (chunk) => {
      try {
        // Bound both individual newline-delimited frames and partial frames.
        for (const part of chunk.toString("utf8").split(/(?<=\n)/)) {
          this.frameBytes += Buffer.byteLength(part);
          if (this.frameBytes > MAX_FRAME) throw new Error("MCP stdio frame exceeds 2 MiB");
          if (part.endsWith("\n")) this.frameBytes = 0;
        }
        this.buffer.append(chunk);
        let message;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) {
        fail(error);
      }
    });
  }
  async send(message) {
    if (!this.child?.stdin.writable) throw new Error("MCP server stdin is closed");
    await new Promise((resolve, reject) =>
      this.child.stdin.write(serializeMessage(message), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (!this.child) return;
      const child = this.child;
      child.stdin.end();
      await stopProcess(child);
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise((resolve) => child.once("close", resolve)),
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("MCP process did not terminate within 2 seconds")),
              2000,
            );
            timer.unref();
          }),
        ]);
      }
      this.buffer.clear();
    })();
    return this.closing;
  }
}

/**
 * Only server names supplied by the daemon are connected. Tool aliases are opaque,
 * collision-resistant names; policy checks always use the original server/tool pair.
 * @param {import('@getpaseo/plugin/server/provider').ProviderSessionConfig} config
 * @param {{signal:AbortSignal,fetchImpl?:typeof fetch}} options
 */
export async function connectMcpTools(config, { signal, fetchImpl }) {
  const clients = [];
  const tools = [];
  const close = async () => {
    const results = await Promise.allSettled(clients.map(({ client }) => client.close()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  try {
    for (const [server, serverConfig] of Object.entries(config.mcpServers)) {
      signal.throwIfAborted();
      const client = new Client({ name: "omp-kiro-paseo", version: "0.4.0" }, { capabilities: {} });
      let transport;
      if (serverConfig.type === "stdio") transport = new StdioTransport(serverConfig, config);
      else {
        const options = {
          requestInit: { headers: serverConfig.headers, redirect: "error" },
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
        };
        transport =
          serverConfig.type === "sse"
            ? new SSEClientTransport(new URL(serverConfig.url), options)
            : new StreamableHTTPClientTransport(new URL(serverConfig.url), options);
      }
      clients.push({ client, transport });
      const abort = () => {
        void client.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await client.connect(transport, { signal, timeout: 15000 });
        const cursors = new Set();
        let cursor;
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 15000 });
          for (const tool of page.tools) {
            if (tools.length >= 512) throw new Error("Injected MCP catalog exceeds 512 tools");
            const name = `mcp_${createHash("sha256")
              .update(JSON.stringify([server, tool.name]))
              .digest("hex")
              .slice(0, 40)}`;
            if (tools.some((existing) => existing.name === name))
              throw new Error("Duplicate injected MCP tool identity");
            const validate = ajv.compile(tool.inputSchema);
            tools.push({
              name,
              description: `[MCP ${server}/${tool.name}] ${tool.description ?? tool.name}`,
              parameters: tool.inputSchema,
              server,
              originalName: tool.name,
              validate,
              detail: (args) => ({
                type: "plain_text",
                label: `${server}/${tool.name}`,
                text: JSON.stringify(args),
              }),
              async execute(args, callSignal) {
                callSignal.throwIfAborted();
                if (!validate(args))
                  throw new Error(`Invalid MCP tool arguments: ${ajv.errorsText(validate.errors)}`);
                const result = await client.callTool(
                  { name: tool.name, arguments: args },
                  undefined,
                  { signal: callSignal, timeout: 120000 },
                );
                const text = JSON.stringify(result);
                if (Buffer.byteLength(text) > 128 * 1024)
                  throw new Error(
                    "MCP result exceeds 128 KiB; result omitted, request a smaller result",
                  );
                return {
                  text,
                  isError: result.isError === true,
                  detail: { type: "plain_text", label: `${server}/${tool.name}`, text },
                };
              },
            });
          }
          cursor = page.nextCursor;
          if (cursor) {
            if (cursors.has(cursor))
              throw new Error("Injected MCP catalog repeated a pagination cursor");
            cursors.add(cursor);
          }
        } while (cursor);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }
    return { tools, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
