import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readKiroAuth, saveKiroAuth } from "../server/auth.mjs";
import { runAuthCli } from "../auth-cli.mjs";
import { executeKiroQuery, registerKiroCommands } from "../server/commands.mjs";

const first = "arn:aws:codewhisperer:us-east-1:111111111111:profile/first";
const second = "arn:aws:codewhisperer:us-east-1:222222222222:profile/second";
async function fixture(t, profiles = [
  { arn: first, profileName: "Development" }, { arn: second, profileName: "Customer" },
]) {
  const dir = await mkdtemp(join(tmpdir(), "kiro-profile-command-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFile = join(dir, "auth.sqlite3");
  await saveKiroAuth({ kind: "social", provider: "google", access_token: "SECRET-access",
    refresh_token: "SECRET-refresh", expires_at: "2099-01-01T00:00:00Z", profile_arn: first }, { authFile });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const target = init.headers["x-amz-target"];
    if (target.endsWith("ListAvailableProfiles")) return Response.json({ profiles });
    if (target.endsWith("GetUsageLimits")) {
      const profile = JSON.parse(init.body).profileArn;
      assert.ok([first, second].includes(profile));
      return Response.json({ subscriptionInfo: { type: "Q_DEVELOPER_STANDALONE_PRO" },
        nextDateReset: Date.parse("2099-02-01T00:00:00Z") / 1000,
        overageConfiguration: { overageStatus: profile === first ? "ENABLED" : "DISABLED" },
        usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: profile === first ? 25 : 100,
          usageLimit: 100 }] });
    }
    throw new Error(`Unexpected network operation ${target}`);
  });
  return authFile;
}

test("CLI lists and compares both quotas without changing selection or exposing credentials", async (t) => {
  const authFile = await fixture(t);
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(line));
  await runAuthCli(["auth", "profiles", "--usage", "--json", "--auth-file", authFile]);
  const result = JSON.parse(lines.join("\n"));
  assert.equal(result.selectedArn, first);
  assert.deepEqual(result.profiles.map(p => [p.name, p.usage.balances[0].used, p.usage.balances[0].remaining]),
    [["Development", 25, 75], ["Customer", 100, 0]]);
  assert.doesNotMatch(lines.join("\n"), /SECRET/);
  assert.equal((await readKiroAuth({ authFile })).profile_arn, first);
});

test("CLI explicit profile selection persists exact name; rejected selection preserves it", async (t) => {
  const authFile = await fixture(t);
  const lines = [];
  t.mock.method(console, "log", line => lines.push(line));
  await runAuthCli(["auth", "profile", "--profile", "Customer", "--json", "--auth-file", authFile]);
  assert.equal(JSON.parse(lines[0]).arn, second);
  assert.equal((await readKiroAuth({ authFile })).profile_arn, second);
  await assert.rejects(runAuthCli(["auth", "profile", "--profile", "Missing", "--auth-file", authFile]));
  assert.equal((await readKiroAuth({ authFile })).profile_arn, second);
});

test("OMP profile comparison displays independent observed amounts without selecting a profile", async (t) => {
  const authFile = await fixture(t);
  const result = await executeKiroQuery("kiro-profiles", "", { authFile });
  assert.match(result.text, /Development/);
  assert.match(result.text, /Customer/);
  assert.match(result.text, /75/);
  assert.match(result.text, /100/);
  assert.match(result.text, /Enabled/);
  assert.match(result.text, /Disabled/);
  assert.doesNotMatch(result.text, /SECRET/);
  assert.equal((await readKiroAuth({ authFile })).profile_arn, first);
});

test("OMP refuses busy switches, persists idle switch, and does not generate", async (t) => {
  const authFile = await fixture(t);
  const commands = new Map();
  const messages = [];
  let idle = false;
  const pi = {
    on() {}, registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message) { messages.push(message.content); },
    sendUserMessage() { assert.fail("Profile commands must not generate"); },
  };
  const ctx = { isIdle: () => idle, hasUI: false,
    modelRegistry: { async refreshProvider() {} } };
  registerKiroCommands(pi, { authFile });
  await commands.get("kiro-profile").handler("Customer", ctx);
  assert.equal((await readKiroAuth({ authFile })).profile_arn, first);
  idle = true;
  await commands.get("kiro-profile").handler("Customer", ctx);
  assert.equal((await readKiroAuth({ authFile })).profile_arn, second);
  assert.doesNotMatch(messages.join("\n"), /SECRET/);
});

test("a catalog refresh failure after switching does not misreport or undo persisted selection", async (t) => {
  const authFile = await fixture(t);
  const commands = new Map();
  const messages = [];
  registerKiroCommands({
    on() {}, registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message) { messages.push(message.content); },
  }, { authFile });
  await commands.get("kiro-profile").handler("Customer", {
    isIdle: () => true, hasUI: false,
    modelRegistry: { async refreshProvider() { throw new Error("SECRET upstream body"); } },
  });
  assert.equal((await readKiroAuth({ authFile })).profile_arn, second);
  assert.match(messages.join("\n"), /Customer/);
  assert.match(messages.join("\n"), /refresh/i);
  assert.doesNotMatch(messages.join("\n"), /SECRET/);
});

function pickerHost(authFile, { idle = true, select } = {}) {
  const commands = new Map();
  const messages = [];
  const refreshed = [];
  const dialogs = [];
  registerKiroCommands({
    on() {}, registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message) { messages.push(message.content); },
    sendUserMessage() { assert.fail("Profile commands must not generate"); },
  }, { authFile });
  const ctx = {
    isIdle: () => idle, hasUI: true,
    ui: { async select(title, options, dialogOptions) {
      dialogs.push({ title, options, dialogOptions });
      return select(options);
    } },
    modelRegistry: { async refreshProvider(provider) { refreshed.push(provider); } },
  };
  return { messages, refreshed, dialogs, run: () => commands.get("kiro-profile").handler("", ctx) };
}

test("profile picker labels each profile and switches through the shared selection path", async (t) => {
  const authFile = await fixture(t);
  const host = pickerHost(authFile, { select: (options) => options.find((o) => o.startsWith("Customer")) });
  await host.run();
  assert.deepEqual(host.dialogs[0].options, [
    "Development · us-east-1 · 111111111111 (current)",
    "Customer · us-east-1 · 222222222222",
  ]);
  assert.ok(host.dialogs[0].dialogOptions.signal instanceof AbortSignal);
  assert.equal((await readKiroAuth({ authFile })).profile_arn, second);
  assert.deepEqual(host.refreshed, ["kiro-http"]);
  assert.match(host.messages[0], /^Kiro profile selected\n\nCustomer — arn:.*profile\/second\nSelection is persisted/);
  assert.doesNotMatch(host.messages.join("\n"), /SECRET/);
});

test("cancelling the profile picker or picking the current profile changes nothing", async (t) => {
  const authFile = await fixture(t);
  for (const select of [() => undefined, (options) => options[0]]) {
    const host = pickerHost(authFile, { select });
    await host.run();
    assert.equal((await readKiroAuth({ authFile })).profile_arn, first);
    assert.deepEqual(host.refreshed, []);
    assert.match(host.messages[0], /^Kiro profile unchanged\n\n/);
    assert.doesNotMatch(host.messages[0], /failed/i);
  }
});

test("profile picker keeps repeated names distinct and maps the chosen label to its ARN", async (t) => {
  const third = "arn:aws:codewhisperer:us-east-1:111111111111:profile/third";
  const authFile = await fixture(t, [
    { arn: first, profileName: "Shared" }, { arn: second, profileName: "Shared" },
    { arn: third, profileName: "Shared" },
  ]);
  const host = pickerHost(authFile, { select: (options) => options.find((o) => o.endsWith("profile/third")) });
  await host.run();
  const options = host.dialogs[0].options;
  assert.equal(new Set(options).size, 3);
  assert.ok(options.includes("Shared · us-east-1 · 222222222222"));
  assert.equal((await readKiroAuth({ authFile })).profile_arn, third);
});

test("profile picker refuses a busy session before showing a dialog", async (t) => {
  const authFile = await fixture(t);
  const host = pickerHost(authFile, { idle: false, select: () => assert.fail("No dialog while busy") });
  await host.run();
  assert.deepEqual(host.dialogs, []);
  assert.match(host.messages[0], /Wait for the current turn to finish/);
  assert.equal((await readKiroAuth({ authFile })).profile_arn, first);
});

test("without interactive UI, /kiro-profile keeps listing profiles as text", async (t) => {
  const authFile = await fixture(t);
  const messages = [];
  const commands = new Map();
  registerKiroCommands({
    on() {}, registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message) { messages.push(message.content); },
  }, { authFile });
  for (const ctx of [{ isIdle: () => true, hasUI: false, ui: { select: () => assert.fail("No dialog") } },
    { isIdle: () => false, hasUI: true, ui: {} }])
    await commands.get("kiro-profile").handler("", ctx);
  for (const message of messages) {
    assert.match(message, /^Kiro profile selection\n\nSelected profile: arn:.*profile\/first/);
    assert.match(message, /\* Development — arn:/);
    assert.match(message, /Switch while idle with \/kiro-profile <exact-name-or-arn>/);
  }
  assert.equal(messages.length, 2);
  assert.equal((await readKiroAuth({ authFile })).profile_arn, first);
});
