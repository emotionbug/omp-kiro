import { createInterface } from "node:readline";
import { appendFile, writeFile } from "node:fs/promises";

const marker = process.argv[2];
const pidFile = process.argv[3];
if (pidFile) await writeFile(pidFile, String(process.pid));
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize")
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "controlled-fixture", version: "1.0.0" },
    };
  else if (request.method === "tools/list")
    result = {
      tools: [
        {
          name: "record",
          description: "Record a fixture value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
        {
          name: "other",
          description: "A different identity, never implicitly preapproved",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    };
  else if (request.method === "tools/call") {
    await appendFile(marker, `${request.params.name}:${request.params.arguments.value ?? ""}\n`);
    result = {
      content: [{ type: "text", text: `recorded:${request.params.arguments.value ?? ""}` }],
    };
  } else if (request.method === "ping") result = {};
  else {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Unknown method" },
      }) + "\n",
    );
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
