import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saveKiroAuth } from "../server/auth.mjs";
import { executeKiroQuery, registerKiroCommands } from "../server/commands.mjs";

function host(options = {}) {
  const commands = new Map();
  const events = new Map();
  const messages = [];
  const selected = [];
  const pi = {
    registerCommand(name, value) {
      commands.set(name, value);
    },
    on(name, handler) {
      events.set(name, handler);
    },
    sendMessage(message, delivery) {
      messages.push({ message, delivery });
    },
    sendUserMessage() {
      throw new Error("Commands must not start model generation");
    },
    async setModel(model) {
      selected.push(model);
      return true;
    },
    ...options,
  };
  const ctx = {
    isIdle: () => true,
    hasUI: false,
    sessionManager: { getSessionId: () => "own-session" },
    modelRegistry: {
      async refreshProvider() {},
      find: (provider, id) => ({ provider, id, api: "kiro-test" }),
    },
  };
  return { pi, ctx, commands, events, messages, selected };
}

test("help is local and rejects invalid and action-only query names", async () => {
  const help = await executeKiroQuery("/kiro", "", { transport: "http" });
  assert.match(help.text, /direct HTTP/);
  assert.match(help.text, /\/kiro-model <id>/);
  assert.doesNotMatch(help.text, /kiro-reset/);
  await assert.rejects(executeKiroQuery("kiro-model", "id"), { code: "unknown_command" });
  await assert.rejects(executeKiroQuery("clear"), { code: "unknown_command" });
  await assert.rejects(executeKiroQuery("kiro-status", "logout"), { code: "invalid_arguments" });
});

test("HTTP status reads the explicit managed store without exposing credentials or auto-login", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-commands-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, "auth.sqlite3");
  const signedOut = await executeKiroQuery("kiro-status", "", { transport: "http", authFile });
  assert.match(signedOut.text, /signed out/);
  assert.match(signedOut.text, /omp-kiro login/);
  await saveKiroAuth(
    {
      kind: "social",
      provider: "google",
      access_token: "SECRET-ACCESS",
      refresh_token: "SECRET-REFRESH",
      expires_at: "2000-01-01T00:00:00Z",
    },
    { authFile },
  );
  const expired = await executeKiroQuery("kiro-status", "", { transport: "http", authFile });
  assert.match(expired.text, /expired/);
  assert.match(expired.text, /Refresh credential: available/);
  assert.doesNotMatch(expired.text, /SECRET|profile|@/);
});

test("HTTP model catalog uses configured auth provider and filters IDs and names", async (t) => {
  const authProvider = async () => ({ access_token: "catalog-secret" });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return Response.json({
      models: [
        { modelId: "one", modelName: "First Model" },
        { modelId: "two", modelName: "Other" },
      ],
    });
  });
  const controller = new AbortController();
  const result = await executeKiroQuery("/kiro-models", "FIRST", {
    transport: "http",
    authProvider,
    signal: controller.signal,
  });
  assert.equal(result.text, "one — First Model");
  assert.equal(requests.length, 1);
  assert.match(String(requests[0].url), /management\.us-east-1\.kiro\.dev/);
  assert.equal(requests[0].options.signal, controller.signal);
  assert.match(requests[0].options.headers["x-amz-target"], /ListAvailableModels/);
  assert.doesNotMatch(result.text, /catalog-secret/);
});

test("ACP invalid metadata still closes the connection", async () => {
  let closed = false;
  await assert.rejects(
    executeKiroQuery("kiro-models", "", {
      transport: "acp",
      services: {
        async openKiro() {
          return {
            session: {},
            async close() {
              closed = true;
            },
          };
        },
      },
    }),
    { code: "invalid_catalog" },
  );
  assert.equal(closed, true);
});

test("usage renders reported zero and unknown values distinctly, with explicit account source", async () => {
  const signal = new AbortController().signal;
  const services = {
    async fetchKiroUsage(options) {
      assert.equal(options.authFile, "/explicit/store.sqlite3");
      assert.equal(options.signal, signal);
      return {
        status: "available",
        planLabel: "Free",
        windows: [
          {
            id: "monthly",
            label: "Monthly",
            usedPct: 100,
            remainingPct: 0,
            resetsAt: "2099-01-01T00:00:00Z",
          },
          { id: "unknown", label: "Unknown" },
        ],
        balances: [{ id: "credits", label: "Credits", remaining: 0, unit: "credits" }],
        details: [{ id: "overage", label: "Overage", value: "disabled" }],
      };
    },
  };
  const result = await executeKiroQuery("kiro-usage", "", {
    transport: "acp",
    authFile: "/explicit/store.sqlite3",
    signal,
    services,
  });
  assert.match(result.text, /may differ from Kiro CLI login/);
  assert.match(result.text, /Monthly: 100% used; 0% remaining; resets/);
  assert.match(result.text, /Unknown: quota not reported/);
  assert.match(result.text, /Credits \(credits\): 0 remaining/);
  assert.match(result.text, /Overage: disabled/);
});

test("upstream failures are actionable and never echo arbitrary service text", async () => {
  const services = {
    async fetchKiroUsage() {
      throw Object.assign(new Error("Bearer SECRET user@example.com arn:profile"), { status: 401 });
    },
  };
  await assert.rejects(
    executeKiroQuery("kiro-usage", "", { transport: "http", services }),
    (error) => {
      assert.equal(error.code, "auth_required");
      assert.match(error.message, /omp-kiro login/);
      assert.doesNotMatch(error.message, /SECRET|example|arn:/);
      return true;
    },
  );
});

test("cancellation prevents work and propagates through an active ACP metadata handshake", async () => {
  const cancelled = AbortSignal.abort();
  await assert.rejects(executeKiroQuery("kiro", "", { signal: cancelled }), { name: "AbortError" });
  const controller = new AbortController();
  let closed = false;
  const services = {
    async openKiro() {
      controller.abort();
      return {
        session: {},
        async close() {
          closed = true;
        },
      };
    },
  };
  await assert.rejects(
    executeKiroQuery("kiro-models", "", { transport: "acp", services, signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(closed, true);
});

test("host session shutdown cancels in-flight metadata requests", async () => {
  const h = host();
  let started;
  let activeSignal;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const services = {
    async fetchKiroUsage({ signal }) {
      activeSignal = signal;
      started();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
  };
  registerKiroCommands(h.pi, { transport: "http", services });
  const request = h.commands.get("kiro-usage").handler("", h.ctx);
  await ready;
  h.events.get("session_shutdown")();
  await request;
  assert.equal(activeSignal.aborted, true);
  assert.equal(activeSignal.reason.name, "AbortError");
});

test("usage typed authentication and lifecycle errors retain actionable semantics", async () => {
  for (const code of ["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_EXPIRED"]) {
    await assert.rejects(
      executeKiroQuery("kiro-usage", "", {
        transport: "http",
        services: {
          async fetchKiroUsage() {
            throw Object.assign(new Error("Do not echo this service response"), { code });
          },
        },
      }),
      (error) => {
        assert.equal(error.code, "auth_required");
        assert.match(error.message, /omp-kiro login/);
        assert.doesNotMatch(error.message, /service response/);
        return true;
      },
    );
  }
  await assert.rejects(
    executeKiroQuery("kiro-usage", "", {
      transport: "http",
      services: {
        async fetchKiroUsage() {
          throw Object.assign(new Error(), { code: "TIMEOUT" });
        },
      },
    }),
    { code: "request_timeout" },
  );
  await assert.rejects(
    executeKiroQuery("kiro-usage", "", {
      transport: "http",
      services: {
        async fetchKiroUsage() {
          throw Object.assign(new Error(), { code: "CANCELLED" });
        },
      },
    }),
    { name: "AbortError" },
  );
});

test("HTTP catalog loads the explicitly selected store without changing environment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-command-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, "chosen.sqlite3");
  await saveKiroAuth(
    {
      kind: "social",
      provider: "github",
      access_token: "chosen-store-secret",
      expires_at: "2099-01-01T00:00:00Z",
    },
    { authFile },
  );
  const before = process.env.OMP_KIRO_AUTH_FILE;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers.authorization, "Bearer chosen-store-secret");
    return Response.json({ models: [{ modelId: "chosen-id", modelName: "Chosen model" }] });
  });
  const result = await executeKiroQuery("kiro-models", "", { transport: "http", authFile });
  assert.equal(result.text, "chosen-id — Chosen model");
  assert.equal(process.env.OMP_KIRO_AUTH_FILE, before);
  assert.doesNotMatch(result.text, /chosen-store-secret/);
});
