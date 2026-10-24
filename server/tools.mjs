import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import Ajv from "ajv";

const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 128 * 1024;
const ajv = new Ajv({ strict: false, allErrors: true });
const object = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const filePath = { type: "string", minLength: 1, maxLength: 4096 };
const text = { type: "string", maxLength: MAX_FILE };
const definitions = [
  {
    name: "read_file",
    description: "Read a UTF-8 workspace file. Returns an explicit next offset for paged reads.",
    parameters: object(
      {
        path: filePath,
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 65536 },
      },
      ["path"],
    ),
    readOnly: true,
  },
  {
    name: "list_directory",
    description:
      "List a workspace directory. Fails explicitly if more than 2000 entries; choose a narrower directory.",
    parameters: object({ path: filePath }, ["path"]),
    readOnly: true,
  },
  {
    name: "write_file",
    description:
      "Atomically create or replace a UTF-8 workspace file (maximum 1 MiB). Parent directory must exist.",
    parameters: object({ path: filePath, content: text }, ["path", "content"]),
  },
  {
    name: "edit_file",
    description:
      "Replace exactly one occurrence of oldText in a UTF-8 workspace file. Fails on missing or ambiguous matches.",
    parameters: object({ path: filePath, oldText: { ...text, minLength: 1 }, newText: text }, [
      "path",
      "oldText",
      "newText",
    ]),
  },
  {
    name: "run_command",
    description:
      "Execute a shell command in the workspace with a bounded timeout and output. Overflow terminates the command and is reported as an error.",
    parameters: object(
      {
        command: { type: "string", minLength: 1, maxLength: 32768 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
      },
      ["command"],
    ),
  },
];

/** @param {import('node:child_process').ChildProcess} child */
export async function stopProcess(child) {
  // SDK terminateProcess handles Windows trees; a dedicated POSIX group also owns shell grandchildren.
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  await terminateProcess(child);
}

/** @param {string} cwd @param {string} name @param {boolean} [writing] */
async function workspacePath(cwd, name, writing = false) {
  const root = await fs.realpath(cwd);
  const candidate = path.resolve(root, name);
  const within = (value) =>
    value === root ||
    (!path.relative(root, value).startsWith(`..${path.sep}`) &&
      path.relative(root, value) !== ".." &&
      !path.isAbsolute(path.relative(root, value)));
  if (!within(candidate)) throw new Error("Tool path must stay within the workspace");
  let resolved;
  try {
    resolved = await fs.realpath(candidate);
  } catch (error) {
    if (!writing || error.code !== "ENOENT") throw error;
    resolved = path.join(await fs.realpath(path.dirname(candidate)), path.basename(candidate));
  }
  if (!within(resolved)) throw new Error("Tool path resolves outside the workspace");
  return resolved;
}

async function readBounded(file) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Expected a regular file");
    if (stat.size > MAX_FILE)
      throw new Error(
        "File exceeds 1 MiB tool limit; use an approved command to inspect a bounded range",
      );
    const bytes = Buffer.alloc(MAX_FILE + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_FILE) throw new Error("File exceeds 1 MiB tool limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function atomicFile(file, content, signal) {
  if (Buffer.byteLength(content) > MAX_FILE) throw new Error("Content exceeds 1 MiB tool limit");
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let mode = 0o600;
  try {
    mode = (await fs.stat(file)).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fs.writeFile(temp, content, { flag: "wx", mode, signal });
    signal.throwIfAborted();
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** @param {{cwd:string,env:Readonly<Record<string,string>>}} config */
export function createWorkspaceTools(config) {
  return definitions.map((definition) => {
    const validate = ajv.compile(definition.parameters);
    return {
      ...definition,
      validate,
      /** @param {Record<string, unknown>} args */
      detail(args) {
        const file = typeof args.path === "string" ? args.path : "";
        switch (definition.name) {
          case "read_file":
            return { type: "read", filePath: file };
          case "write_file":
            return { type: "write", filePath: file, content: args.content };
          case "edit_file":
            return {
              type: "edit",
              filePath: file,
              oldString: args.oldText,
              newString: args.newText,
            };
          case "run_command":
            return { type: "shell", command: args.command, cwd: config.cwd };
          default:
            return { type: "plain_text", label: definition.name, text: JSON.stringify(args) };
        }
      },
      async execute(args, signal) {
        signal.throwIfAborted();
        if (!validate(args))
          throw new Error(
            `Invalid ${definition.name} arguments: ${ajv.errorsText(validate.errors)}`,
          );
        if (definition.name === "run_command") return executeCommand(args, config, signal);
        const file = await workspacePath(config.cwd, args.path, definition.name === "write_file");
        signal.throwIfAborted();
        if (definition.name === "list_directory") {
          const entries = await fs.readdir(file, { withFileTypes: true });
          if (entries.length > 2000)
            throw new Error("Directory exceeds 2000 entries; no entries omitted silently");
          return {
            text: entries
              .map(
                (entry) =>
                  `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? " [symlink]" : ""}`,
              )
              .sort()
              .join("\n"),
          };
        }
        if (definition.name === "read_file") {
          const content = await readBounded(file);
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 65536;
          const selected = content.slice(offset, offset + limit);
          return {
            text: JSON.stringify({
              path: args.path,
              offset,
              content: selected,
              totalCharacters: content.length,
              nextOffset:
                offset + selected.length < content.length ? offset + selected.length : null,
            }),
            detail: { type: "read", filePath: file, content: selected, offset, limit },
          };
        }
        if (definition.name === "write_file") {
          await atomicFile(file, args.content, signal);
          return {
            text: `Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}`,
            detail: { type: "write", filePath: file, content: args.content },
          };
        }
        const content = await readBounded(file);
        const index = content.indexOf(args.oldText);
        if (index < 0 || content.indexOf(args.oldText, index + 1) >= 0)
          throw new Error("oldText must match exactly one occurrence; file was not changed");
        await atomicFile(
          file,
          content.slice(0, index) + args.newText + content.slice(index + args.oldText.length),
          signal,
        );
        return {
          text: `Edited ${args.path}`,
          detail: {
            type: "edit",
            filePath: file,
            oldString: args.oldText,
            newString: args.newText,
          },
        };
      },
    };
  });
}

async function executeCommand(args, config, signal) {
  const windows = process.platform === "win32";
  const child = spawnProcess(
    windows ? config.env.ComSpec || "cmd.exe" : "/bin/sh",
    windows ? ["/d", "/s", "/c", args.command] : ["-lc", args.command],
    { cwd: config.cwd, env: { ...config.env }, stdio: "pipe", detached: !windows },
  );
  child.stdin.end();
  let bytes = 0;
  const chunks = [];
  let failure;
  const stop = (message) => {
    failure ??= message;
    void stopProcess(child).catch(() => {});
  };
  const abort = () => stop("Command canceled");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => stop("Command exceeded timeout"), args.timeoutMs ?? 30000);
  const collect = (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_OUTPUT) chunks.push(chunk);
    else stop("Command exceeded 128 KiB output limit; process terminated (output incomplete)");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    signal.throwIfAborted();
    const output = Buffer.concat(chunks).toString("utf8");
    return {
      text: `${failure ? `${failure}\n` : ""}${output}\nExit code: ${exitCode}`,
      isError: Boolean(failure) || exitCode !== 0,
      detail: {
        type: "shell",
        command: args.command,
        cwd: config.cwd,
        output: `${failure ? `${failure}\n` : ""}${output}`,
        exitCode,
      },
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await stopProcess(child);
  }
}
