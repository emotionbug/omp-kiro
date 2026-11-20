import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KiroAuthError,
  loadKiroAuth,
  logoutKiroAuth,
  readAuthSnapshot,
  saveKiroAuth,
} from "../server/auth.mjs";
import {
  fetchKiroProfileUsage,
  listKiroProfiles,
  selectKiroProfile,
} from "../server/profiles.mjs";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const A = "arn:aws:codewhisperer:us-east-1:123456789012:profile/personal";
const B = "arn:aws:codewhisperer:eu-central-1:987654321098:profile/work";
const credential = {
  kind: "social",
  provider: "google",
  access_token: "fixture-profile-access-secret",
  refresh_token: "fixture-profile-refresh-secret",
  expires_at: "2026-10-26T00:00:00Z",
  profile_arn: A,
  telemetry_generation: 7,
};
const profiles = [
  { arn: A, profileName: "Personal" },
  { arn: B, profileName: "Work" },
];
const retry = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 1000 };
const isCatalog = (request) => request.headers?.["x-amz-target"]?.endsWith(".ListAvailableProfiles");
const usagePayload = (limit = 100, plan = "Q_DEVELOPER_STANDALONE_FREE") => ({
  nextDateReset: Date.parse("2026-11-01T00:00:00Z") / 1000,
  subscriptionInfo: { type: plan },
  usageBreakdownList: [{
    resourceType: "CREDIT",
    unit: "INVOCATIONS",
    currentUsage: 10,
    usageLimit: limit,
  }],
});
async function fixture(t, value = credential) {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-profiles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, "auth.sqlite3");
  await saveKiroAuth(value, { authFile });
  return {
    authFile,
    options: { authFile, now: () => NOW, retry },
    raw: () => readAuthSnapshot({ authFile }),
    read: async () => JSON.parse(await readAuthSnapshot({ authFile })),
    replace: (next) => saveKiroAuth(next, { authFile }),
  };
}
function noSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of [credential.access_token, credential.refresh_token, "service-secret"])
    assert.ok(!text.includes(secret));
}

test("profile listing collects every page, deduplicates ARNs, and preserves selection", async (t) => {
  const f = await fixture(t);
  const before = await f.raw();
  const pages = [];
  const report = await listKiroProfiles({
    ...f.options,
    fetchImpl: async (url, request) => {
      assert.match(url, /^https:\/\/management\.(us-east-1|eu-central-1)\.kiro\.dev\/$/);
      assert.equal(request.redirect, "error");
      assert.ok(isCatalog(request));
      assert.equal(request.headers.authorization, `Bearer ${credential.access_token}`);
      assert.equal(request.headers["x-amzn-codewhisperer-optout"], "true");
      assert.equal(request.headers["x-amz-target"], "AmazonCodeWhispererService.ListAvailableProfiles");
      const body = JSON.parse(request.body);
      pages.push({ url, body });
      if (url.includes("eu-central-1")) return Response.json({ profiles: [profiles[1]] });
      return Response.json(body.nextToken
        ? { profiles: [profiles[0]] }
        : { profiles: [profiles[0]], nextToken: "second-page" });
    },
  });
  assert.deepEqual(pages.filter(({ url }) => url.includes("us-east-1")).map(({ body }) => body), [
    {},
    { nextToken: "second-page" },
  ]);
  assert.deepEqual(pages.filter(({ url }) => url.includes("eu-central-1")).map(({ body }) => body), [{}]);
  assert.deepEqual(report, {
    selectedArn: A,
    profiles: [
      { arn: A, name: "Personal", region: "us-east-1", accountId: "123456789012" },
      { arn: B, name: "Work", region: "eu-central-1", accountId: "987654321098" },
    ],
  });
  assert.equal(await f.raw(), before);
  noSecrets(report);
});

test("listing zero, one, or multiple assigned profiles never selects an unresolved login", async (t) => {
  const unresolved = { ...credential };
  delete unresolved.profile_arn;
  for (const assigned of [[], profiles.slice(0, 1), profiles]) {
    const f = await fixture(t, unresolved);
    const before = await f.raw();
    const report = await listKiroProfiles({
      ...f.options, fetchImpl: async () => Response.json({ profiles: assigned }),
    });
    assert.equal(report.selectedArn, null);
    assert.equal(report.profiles.length, assigned.length);
    assert.equal(await f.raw(), before);
  }
});

test("OIDC issuer region does not replace the selected profile service region", async (t) => {
  const f = await fixture(t, {
    ...credential, kind: "oidc", provider: "identity-center", region: "ap-southeast-2",
    client_id: "fixture-client", client_secret: "fixture-client-secret", profile_arn: B,
  });
  const urls = [];
  const report = await listKiroProfiles({
    ...f.options,
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json({ profiles });
    },
  });
  assert.equal(report.selectedArn, B);
  assert.deepEqual(new Set(urls), new Set(["https://management.us-east-1.kiro.dev/", "https://management.eu-central-1.kiro.dev/"]));
});

test("catalog pagination cycles and malformed profiles fail without modifying credentials", async (t) => {
  for (const payload of [
    { profiles, nextToken: "cycle" },
    { profiles: [{ arn: "arn:aws:codewhisperer:broken" }] },
    { profiles: null },
  ]) {
    const f = await fixture(t);
    const before = await f.raw();
    await assert.rejects(listKiroProfiles({
      ...f.options, fetchImpl: async () => Response.json(payload),
    }), KiroAuthError);
    assert.equal(await f.raw(), before);
  }
});

test("comparison reports distinct per-profile plans and quotas without storing an override", async (t) => {
  const f = await fixture(t);
  const before = await f.raw();
  const requested = [];
  const report = await fetchKiroProfileUsage({
    ...f.options,
    fetchImpl: async (url, request) => {
      if (isCatalog(request)) return Response.json({ profiles });
      const { profileArn } = JSON.parse(request.body);
      requested.push(profileArn);
      assert.equal((await f.read()).profile_arn, A);
      assert.equal(url, `https://management.${profileArn === A ? "us-east-1" : "eu-central-1"}.kiro.dev/`);
      return Response.json(usagePayload(profileArn === A ? 50 : 1000,
        profileArn === A ? "Q_DEVELOPER_STANDALONE_FREE" : "Q_DEVELOPER_STANDALONE_PRO_PLUS"));
    },
  });
  assert.deepEqual(requested, [A, B]);
  assert.equal(report.selectedArn, A);
  assert.deepEqual(report.profiles.map((p) => p.usage.balances[0].limit), [50, 1000]);
  assert.deepEqual(report.profiles.map((p) => p.usage.planLabel), ["Kiro Free", "Kiro Pro+"]);
  assert.equal(await f.raw(), before);
  noSecrets(report);
});

test("comparison without a selected profile keeps the login unresolved", async (t) => {
  const unresolved = { ...credential };
  delete unresolved.profile_arn;
  const f = await fixture(t, unresolved);
  const before = await f.raw();
  const report = await fetchKiroProfileUsage({
    ...f.options,
    fetchImpl: async (_url, request) => Response.json(isCatalog(request) ? { profiles } : usagePayload()),
  });
  assert.equal(report.selectedArn, null);
  assert.equal(report.profiles.filter((p) => p.usage).length, 2);
  assert.equal(await f.raw(), before);
});

test("a denied profile has a sanitized error while other profile quotas remain available", async (t) => {
  const f = await fixture(t);
  const report = await fetchKiroProfileUsage({
    ...f.options,
    fetchImpl: async (_url, request) => {
      if (isCatalog(request)) return Response.json({ profiles });
      return JSON.parse(request.body).profileArn === A
        ? Response.json({ message: `service-secret ${credential.access_token}` }, { status: 403 })
        : Response.json(usagePayload(1000));
    },
  });
  assert.equal(report.profiles[0].usage, undefined);
  assert.equal(report.profiles[0].error, "Kiro rejected the usage request.");
  assert.equal(report.profiles[1].usage.balances[0].limit, 1000);
  noSecrets(report);
  assert.deepEqual(await f.read(), credential);
});

test("profile operations propagate pre-cancellation without requests or writes", async (t) => {
  const f = await fixture(t);
  const before = await f.raw();
  for (const run of [listKiroProfiles, fetchKiroProfileUsage,
    (options) => selectKiroProfile(B, options)]) {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(run({
      ...f.options, signal: controller.signal,
      fetchImpl: async () => { throw new Error("must not request"); },
    }), { name: "AbortError" });
  }
  assert.equal(await f.raw(), before);
});

test("cancellation during pagination or quota comparison aborts the whole report", async (t) => {
  for (const comparing of [false, true]) {
    const f = await fixture(t);
    const before = await f.raw();
    const controller = new AbortController();
    const started = Promise.withResolvers();
    let calls = 0;
    const pending = (comparing ? fetchKiroProfileUsage : listKiroProfiles)({
      ...f.options, signal: controller.signal,
      fetchImpl: async (url, request) => {
        if (isCatalog(request) && url.includes("eu-central-1")) return Response.json({ profiles: [] });
        calls++;
        if (calls === 1)
          return Response.json({ profiles, ...(comparing ? {} : { nextToken: "next" }) });
        assert.equal(isCatalog(request), !comparing);
        started.resolve();
        return new Promise(() => {});
      },
    });
    await started.promise;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(calls, 2);
    assert.equal(await f.raw(), before);
  }
});

test("selection requires an exact available ARN or unique exact name", async (t) => {
  const f = await fixture(t);
  const before = await f.raw();
  const options = {
    ...f.options,
    fetchImpl: async () => Response.json({ profiles: [
      { ...profiles[0], profileName: "Team" }, { ...profiles[1], profileName: "Team" },
    ] }),
  };
  for (const selector of [undefined, "", 1])
    await assert.rejects(selectKiroProfile(selector, options), { code: "invalid_profile" });
  for (const selector of ["team", "Tea", `${B}-missing`])
    await assert.rejects(selectKiroProfile(selector, options), { code: "unknown_profile" });
  await assert.rejects(selectKiroProfile("Team", options), { code: "ambiguous_profile" });
  assert.equal(await f.raw(), before);
  assert.equal((await selectKiroProfile(B, options)).arn, B);
});

test("successful selection persists exactly the requested profile and preserves metadata", async (t) => {
  const f = await fixture(t);
  const selected = await selectKiroProfile("Work", {
    ...f.options, fetchImpl: async () => Response.json({ profiles }),
  });
  assert.deepEqual(selected, { arn: B, name: "Work", region: "eu-central-1", accountId: "987654321098" });
  assert.deepEqual(await f.read(), { ...credential, profile_arn: B });
  noSecrets(selected);
});

test("unsupported profile regions are visible but cannot be selected", async (t) => {
  const f = await fixture(t);
  const unsupported = "arn:aws:codewhisperer:ap-southeast-2:123456789012:profile/unsupported";
  const options = { ...f.options, fetchImpl: async () => Response.json({ profiles: [{ arn: unsupported }] }) };
  assert.equal((await listKiroProfiles(options)).profiles[0].region, "ap-southeast-2");
  await assert.rejects(selectKiroProfile(unsupported, options), { code: "unsupported_profile_region" });
  assert.deepEqual(await f.read(), credential);
});

test("selection CAS preserves a concurrent login, logout, selection, rotation, or generation change", async (t) => {
  for (const replacement of [
    null,
    { ...credential, access_token: "new-login", refresh_token: "new-login-refresh" },
    { ...credential, profile_arn: B },
    { ...credential, access_token: "rotated-access", refresh_token: "rotated-refresh" },
    { ...credential, telemetry_generation: 8 },
  ]) {
    const f = await fixture(t);
    let saved;
    await assert.rejects(selectKiroProfile(B, {
      ...f.options,
      fetchImpl: async () => {
        if (replacement) await f.replace(replacement);
        else await logoutKiroAuth({ authFile: f.authFile });
        saved = await f.raw();
        return Response.json({ profiles });
      },
    }), { code: "credential_changed" });
    assert.equal(await f.raw(), saved);
  }
});

test("listing refreshes without resolving or adopting a refresh-returned profile", async (t) => {
  const expired = { ...credential, expires_at: "2026-10-24T00:00:00Z" };
  delete expired.profile_arn;
  const f = await fixture(t, expired);
  let refreshes = 0, catalogs = 0;
  const report = await listKiroProfiles({
    ...f.options,
    fetchImpl: async (_url, request) => {
      if (isCatalog(request)) {
        catalogs++;
        assert.equal(request.headers.authorization, "Bearer rotated-access");
        return Response.json({ profiles });
      }
      refreshes++;
      return Response.json({
        accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600, profileArn: A,
      });
    },
  });
  assert.equal(refreshes, 1);
  assert.equal(catalogs, 2);
  assert.equal(report.selectedArn, null);
  const saved = await f.read();
  assert.equal(saved.profile_arn, undefined);
  assert.equal(saved.access_token, "rotated-access");
  assert.equal(saved.refresh_token, "rotated-refresh");
  assert.equal(saved.telemetry_generation, 7);
});

test("failed catalog lookup or selection keeps successfully rotated single-use tokens", async (t) => {
  for (const selecting of [false, true]) {
    const f = await fixture(t, { ...credential, expires_at: "2026-10-24T00:00:00Z" });
    const options = {
      ...f.options,
      fetchImpl: async (_url, request) => isCatalog(request)
        ? selecting ? Response.json({ profiles }) : Response.json({}, { status: 403 })
        : Response.json({ accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600 }),
    };
    await assert.rejects(selecting ? selectKiroProfile("missing", options) : listKiroProfiles(options), KiroAuthError);
    const saved = await f.read();
    assert.equal(saved.access_token, "rotated-access");
    assert.equal(saved.refresh_token, "rotated-refresh");
    assert.equal(saved.profile_arn, A);
  }
});

test("resolveProfile false survives shared refresh recursion without automatic selection", async (t) => {
  const expired = { ...credential, expires_at: "2026-10-24T00:00:00Z" };
  delete expired.profile_arn;
  const f = await fixture(t, expired);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const options = {
    ...f.options, resolveProfile: false,
    fetchImpl: async () => {
      calls++;
      started.resolve();
      await release.promise;
      return Response.json({ accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600 });
    },
  };
  const first = loadKiroAuth(options);
  await started.promise;
  const second = loadKiroAuth(options);
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  for (const result of results) assert.equal(result.profile_arn, undefined);
  assert.equal((await f.read()).profile_arn, undefined);
});

test("comparison refreshes a replay with the stored identity, not the in-memory profile", async (t) => {
  const f = await fixture(t, { ...credential, expires_at: new Date(NOW + 120_000).toISOString() });
  let clock = NOW, usageCalls = 0, refreshes = 0;
  const report = await fetchKiroProfileUsage({
    ...f.options, now: () => clock, retry: { ...retry, maxAttempts: 2 },
    fetchImpl: async (_url, request) => {
      if (isCatalog(request)) return Response.json({ profiles: [profiles[1], profiles[0]] });
      if (!request.headers?.["x-amz-target"]) {
        refreshes++;
        return Response.json({ accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600 });
      }
      usageCalls++;
      if (usageCalls === 1) {
        assert.equal(JSON.parse(request.body).profileArn, B);
        clock += 180_000;
        return Response.json({}, { status: 503 });
      }
      assert.equal(request.headers.authorization, "Bearer rotated-access");
      assert.equal((await f.read()).profile_arn, A);
      return Response.json(usagePayload(1000));
    },
  });
  assert.equal(refreshes, 1);
  assert.equal(usageCalls, 3);
  assert.equal(report.selectedArn, A);
  assert.ok(report.profiles.every((profile) => profile.usage));
  const saved = await f.read();
  assert.equal(saved.profile_arn, A);
  assert.equal(saved.refresh_token, "rotated-refresh");
});

test("comparison recovery refuses a concurrent stored-profile change", async (t) => {
  const f = await fixture(t, { ...credential, expires_at: new Date(NOW + 120_000).toISOString() });
  let clock = NOW, calls = 0;
  const replacement = { ...credential, profile_arn: B };
  const report = await fetchKiroProfileUsage({
    ...f.options, now: () => clock, retry: { ...retry, maxAttempts: 2 },
    fetchImpl: async (_url, request) => {
      if (isCatalog(request)) return Response.json({ profiles });
      calls++;
      await f.replace(replacement);
      clock += 180_000;
      return Response.json({}, { status: 503 });
    },
  });
  assert.equal(calls, 1);
  assert.ok(report.profiles.every((profile) => profile.error && !profile.usage));
  assert.deepEqual(await f.read(), replacement);
  noSecrets(report);
});

test("profile commands require no service request for an unresolved environment API key", async (t) => {
  const f = await fixture(t);
  const options = { ...f.options, useEnv: true, env: { KIRO_API_KEY: "ksk_fixture-key" },
    fetchImpl: async () => assert.fail("profile-only operations must not probe key regions") };
  const expected = { selectedArn: null, profiles: [], apiKey: true };
  assert.deepEqual(await listKiroProfiles(options), expected);
  assert.deepEqual(await fetchKiroProfileUsage(options), expected);
  await assert.rejects(selectKiroProfile(A, options), { code: "api_key_no_profiles" });
  assert.deepEqual(await f.read(), credential);
});

test("GovCloud selection respects issuer partition and uses the selected profile region", async (t) => {
  const gov = {
    ...credential, kind: "oidc", provider: "identity-center", region: "us-gov-west-1",
    client_id: "test-client", client_secret: "test-secret", profile_arn: undefined,
  };
  const f = await fixture(t, gov);
  const arn = "arn:aws-us-gov:codewhisperer:us-gov-east-1:123456789012:profile/gov";
  const regions = [];
  const options = { ...f.options, fetchImpl: async (url, request) => {
    if (isCatalog(request)) {
      regions.push(new URL(url).hostname);
      return Response.json({ profiles: url.includes("us-gov-east-1") ? [{ arn }] : [] });
    }
    assert.equal(url, "https://management.us-gov-east-1.kiro.dev/");
    assert.equal(JSON.parse(request.body).profileArn, arn);
    return Response.json(usagePayload());
  } };
  assert.deepEqual(await selectKiroProfile(arn, options), {
    arn, name: arn, region: "us-gov-east-1", accountId: "123456789012",
  });
  assert.deepEqual(new Set(regions), new Set(["management.us-gov-west-1.kiro.dev", "management.us-gov-east-1.kiro.dev"]));
  const report = await fetchKiroProfileUsage(options);
  assert.equal(report.profiles[0].usage.status, "available");
  assert.equal((await f.read()).profile_arn, arn);
});
