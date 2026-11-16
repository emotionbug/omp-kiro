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
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "kiro-profile-command-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFile = join(dir, "auth.sqlite3");
  await saveKiroAuth({ kind: "social", provider: "google", access_token: "SECRET-access",
    refresh_token: "SECRET-refresh", expires_at: "2099-01-01T00:00:00Z", profile_arn: first }, { authFile });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const target = init.headers["x-amz-target"];
    if (target.endsWith("ListAvailableProfiles")) return Response.json({ profiles: [
      { arn: first, profileName: "Development" }, { arn: second, profileName: "Customer" },
    ] });
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
