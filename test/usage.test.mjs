import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchKiroUsage, KiroUsageError } from "../server/usage.mjs";
import { saveKiroAuth } from "../server/auth.mjs";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const RESET = Date.parse("2026-11-01T00:00:00Z") / 1000;
const EXPIRY = Date.parse("2027-01-01T00:00:00Z") / 1000;
const auth = {
  access_token: "fixture-access-secret",
  refresh_token: "fixture-refresh-secret",
  expires_at: "2026-10-26T00:00:00Z",
  profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/private-profile",
};
const base = () => ({
  resourceType: "CREDIT",
  unit: "INVOCATIONS",
  currency: "USD",
  currentUsage: 12,
  currentUsageWithPrecision: 12.375,
  usageLimit: 100,
  usageLimitWithPrecision: 100.5,
  nextDateReset: RESET,
  currentOverages: 0,
  currentOveragesWithPrecision: 0.125,
  overageCharges: 0.005,
  overageRate: 0.04,
  overageCap: 10000,
  overageCapWithPrecision: 10000.5,
  bonuses: [],
});
const payload = (row = base()) => ({
  nextDateReset: RESET,
  subscriptionInfo: { type: "Q_DEVELOPER_STANDALONE_PRO_PLUS", subscriptionTitle: "KIRO PRO+" },
  overageConfiguration: { overageStatus: "DISABLED" },
  usageBreakdownList: [row],
  userInfo: { userId: "private-user", email: "private@example.invalid" },
});
const options = (value, extra = {}) => ({
  now: () => NOW,
  authProvider: async () => auth,
  fetchImpl: async () => Response.json(value),
  ...extra,
});
const expectCode = (code, status) => (error) => {
  assert.ok(error instanceof KiroUsageError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  for (const secret of [
    auth.access_token,
    auth.refresh_token,
    auth.profile_arn,
    "private-user",
    "private@example.invalid",
  ])
    assert.ok(!JSON.stringify(error).includes(secret) && !error.message.includes(secret));
  return true;
};

test("current management usage returns precise SDK balances without exposing identity", async () => {
  let calls = 0;
  const report = await fetchKiroUsage(
    options(payload(), {
      fetchImpl: async (url, init) => {
        calls++;
        assert.equal(url, "https://management.us-east-1.kiro.dev/");
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.equal(init.headers["x-amz-target"], "AmazonCodeWhispererService.GetUsageLimits");
        assert.equal(init.headers.authorization, `Bearer ${auth.access_token}`);
        assert.deepEqual(JSON.parse(init.body), {
          origin: "KIRO_CLI",
          resourceType: "AGENTIC_REQUEST",
          isEmailRequired: false,
          profileArn: auth.profile_arn,
        });
        return Response.json(payload());
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(report.status, "available");
  assert.equal(report.planLabel, "Kiro Pro+");
  assert.deepEqual(report.balances[0], {
    id: "credits-base",
    label: "Monthly credits",
    used: 12.375,
    remaining: 88.125,
    limit: 100.5,
    unit: "credits",
    resetsAt: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(report.windows[0].summary, true);
  assert.equal(report.windows[0].usedPct, (12.375 / 100.5) * 100);
  assert.equal(report.windows[0].remainingPct, (88.125 / 100.5) * 100);
  assert.equal(report.balances.find((b) => b.id === "credits-overage").used, 0.125);
  assert.equal(report.balances.find((b) => b.unit === "usd").used, 0.005);
  assert.equal(report.details.find((d) => d.id === "credits-overage-cap").value, "10000.5");
  const output = JSON.stringify(report);
  for (const identity of [
    auth.access_token,
    auth.refresh_token,
    auth.profile_arn,
    "private-user",
    "private@example.invalid",
  ])
    assert.ok(!output.includes(identity));
});

test("free plan base, trial, bonus and purchases remain separate; purchase projections are not counted twice", async () => {
  const row = base();
  row.freeTrialInfo = {
    freeTrialStatus: "ACTIVE",
    freeTrialExpiry: EXPIRY,
    currentUsage: 3,
    currentUsageWithPrecision: 3.25,
    usageLimit: 500,
  };
  row.bonuses = [
    {
      bonusCode: "private-code",
      displayName: "private@example.invalid",
      description: auth.access_token,
      status: "ACTIVE",
      expiresAt: EXPIRY,
      currentUsage: 1.125,
      usageLimit: 50,
    },
  ];
  row.addOnMetadata = {
    addOnTotalUsage: 4.5,
    addOnTotalLimit: 250,
    addOns: [{ currentUsage: 4.5, usageLimit: 250, expiresAt: EXPIRY, source: "private-source" }],
  };
  row.overageCredits = [{ currentUsage: 4.5, usageLimit: 250, expiresAt: EXPIRY }];
  const body = payload(row);
  body.subscriptionInfo.type = "Q_DEVELOPER_STANDALONE_FREE";
  const report = await fetchKiroUsage(options(body));
  assert.equal(report.planLabel, "Kiro Free");
  assert.deepEqual(
    report.windows.map((w) => w.id),
    ["credits-base", "credits-trial", "credits-bonus-1", "credits-addon-1"],
  );
  assert.equal(report.balances.filter((b) => b.id.includes("addon")).length, 1);
  assert.equal(report.balances.find((b) => b.id === "credits-trial").remaining, 496.75);
  assert.equal(report.balances.find((b) => b.id === "credits-base").limit, 100.5);
  assert.ok(!JSON.stringify(report).includes("private"));
  assert.ok(!JSON.stringify(report).includes(auth.access_token));
});

test("legacy purchase list works without the current metadata, with exact expiry", async () => {
  const row = base();
  row.overageCredits = [{ currentUsage: 7.75, usageLimit: 10, expiresAt: EXPIRY + 0.125 }];
  const report = await fetchKiroUsage(options(payload(row)));
  assert.deepEqual(
    report.balances.find((b) => b.id === "credits-addon-1"),
    {
      id: "credits-addon-1",
      label: "Add-on credits 1",
      used: 7.75,
      remaining: 2.25,
      limit: 10,
      unit: "credits",
      resetsAt: "2027-01-01T00:00:00.125Z",
    },
  );
});

test("expired pools preserve historical consumption but never imply spendable quota", async () => {
  const row = base();
  const expired = NOW / 1000 - 1;
  row.freeTrialInfo = {
    freeTrialStatus: "EXPIRED",
    freeTrialExpiry: expired,
    currentUsage: 20,
    usageLimit: 100,
  };
  row.bonuses = [{ status: "ACTIVE", expiresAt: expired, currentUsage: 2, usageLimit: 25 }];
  row.overageCredits = [{ expiresAt: expired, currentUsage: 1, usageLimit: 50 }];
  const report = await fetchKiroUsage(options(payload(row)));
  assert.equal(report.windows.length, 1);
  for (const id of ["credits-trial", "credits-bonus-1", "credits-addon-1"]) {
    const balance = report.balances.find((b) => b.id === id);
    assert.equal(balance.remaining, 0);
    assert.match(balance.label, /expired/);
    assert.ok(balance.limit > balance.used);
  }
});

test("explicit zero quota is distinct from missing quota and does not divide by zero", async () => {
  const row = base();
  row.currentUsage =
    row.currentUsageWithPrecision =
    row.usageLimit =
    row.usageLimitWithPrecision =
      0;
  const report = await fetchKiroUsage(options(payload(row)));
  assert.equal(report.balances[0].limit, 0);
  assert.equal(report.balances[0].remaining, 0);
  assert.equal(report.windows[0].usedPct, null);
  assert.equal(report.windows[0].remainingPct, null);
});

test("exhausted quota preserves above-limit usage and clamps remaining to zero", async () => {
  const row = base();
  row.currentUsageWithPrecision = 150.75;
  const report = await fetchKiroUsage(options(payload(row)));
  assert.equal(report.balances[0].used, 150.75);
  assert.equal(report.balances[0].remaining, 0);
  assert.equal(report.windows[0].usedPct, 150);
  assert.equal(report.windows[0].remainingPct, 0);
});

test("older rounded values and top-level reset are accepted without inventing precision", async () => {
  const row = base();
  delete row.currentUsageWithPrecision;
  delete row.usageLimitWithPrecision;
  delete row.nextDateReset;
  const body = payload(row);
  body.subscriptionInfo = { type: "FUTURE_PLAN", subscriptionTitle: "private@example.invalid" };
  const report = await fetchKiroUsage(options(body));
  assert.equal(report.balances[0].used, 12);
  assert.equal(report.balances[0].limit, 100);
  assert.equal(report.balances[0].resetsAt, "2026-11-01T00:00:00.000Z");
  assert.equal(report.planLabel, undefined);
});

for (const [name, change, code] of [
  [
    "missing breakdown",
    (p) => {
      delete p.usageBreakdownList;
    },
    "INVALID_RESPONSE",
  ],
  [
    "empty quota",
    (p) => {
      p.usageBreakdownList = [];
    },
    "NO_QUOTA",
  ],
  [
    "unsupported quota dimension",
    (p) => {
      p.usageBreakdownList[0].resourceType = "FUTURE_QUOTA";
    },
    "NO_QUOTA",
  ],
  [
    "missing used",
    (p) => {
      delete p.usageBreakdownList[0].currentUsage;
      delete p.usageBreakdownList[0].currentUsageWithPrecision;
    },
    "INVALID_RESPONSE",
  ],
  [
    "invalid precision cannot fall back",
    (p) => {
      p.usageBreakdownList[0].currentUsageWithPrecision = "12.5";
    },
    "INVALID_RESPONSE",
  ],
  [
    "negative quota",
    (p) => {
      p.usageBreakdownList[0].usageLimitWithPrecision = -1;
    },
    "INVALID_RESPONSE",
  ],
  [
    "missing reset",
    (p) => {
      delete p.nextDateReset;
      delete p.usageBreakdownList[0].nextDateReset;
    },
    "UNKNOWN_EXPIRY",
  ],
  [
    "unknown reset format",
    (p) => {
      p.usageBreakdownList[0].nextDateReset = "2026-11-01";
    },
    "UNKNOWN_EXPIRY",
  ],
  [
    "stale reset",
    (p) => {
      p.usageBreakdownList[0].nextDateReset = NOW / 1000;
    },
    "UNKNOWN_EXPIRY",
  ],
  [
    "unknown trial status",
    (p) => {
      p.usageBreakdownList[0].freeTrialInfo = { freeTrialStatus: "FUTURE" };
    },
    "INVALID_RESPONSE",
  ],
  [
    "unknown purchase expiry",
    (p) => {
      p.usageBreakdownList[0].overageCredits = [{ currentUsage: 0, usageLimit: 1 }];
    },
    "UNKNOWN_EXPIRY",
  ],
  [
    "incomplete purchase projection",
    (p) => {
      p.usageBreakdownList[0].addOnMetadata = {
        addOns: [],
        addOnTotalUsage: 0,
        addOnTotalLimit: 500,
      };
    },
    "INVALID_RESPONSE",
  ],
  [
    "unknown billing currency",
    (p) => {
      p.usageBreakdownList[0].currency = "FUTURE";
    },
    "INVALID_RESPONSE",
  ],
  [
    "unexpected continuation cannot silently truncate",
    (p) => {
      p.nextToken = "opaque-private-token";
    },
    "INVALID_RESPONSE",
  ],
])
  test(`usage fails explicitly for ${name}`, async () => {
    const body = payload();
    change(body);
    await assert.rejects(fetchKiroUsage(options(body)), expectCode(code));
  });

for (const status of [401, 403, 429, 500])
  test(`HTTP ${status} retains status without reflecting secret server errors`, async () => {
    await assert.rejects(
      fetchKiroUsage(
        options(null, {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                message: `${auth.access_token} ${auth.refresh_token} ${auth.profile_arn} private@example.invalid`,
              }),
              { status },
            ),
        }),
      ),
      expectCode(status === 429 ? "RATE_LIMITED" : "HTTP_ERROR", status),
    );
  });

test("invalid JSON and network exceptions never expose upstream text", async () => {
  await assert.rejects(
    fetchKiroUsage(options(null, { fetchImpl: async () => new Response(auth.access_token) })),
    expectCode("INVALID_RESPONSE"),
  );
  await assert.rejects(
    fetchKiroUsage(
      options(null, {
        fetchImpl: async () => {
          throw new Error(auth.access_token);
        },
      }),
    ),
    expectCode("NETWORK_ERROR"),
  );
  await assert.rejects(
    fetchKiroUsage(
      options(null, {
        authProvider: async () => {
          throw new Error(auth.refresh_token);
        },
      }),
    ),
    expectCode("AUTH_REQUIRED"),
  );
});

for (const [name, credential, code] of [
  ["expired", { ...auth, expires_at: "2026-10-24T00:00:00Z" }, "AUTH_EXPIRED"],
  ["missing expiry", { ...auth, expires_at: undefined }, "AUTH_INVALID"],
  ["missing token", { ...auth, access_token: "" }, "AUTH_INVALID"],
  [
    "unsupported profile region",
    { ...auth, profile_arn: "arn:aws:codewhisperer:ap-northeast-2:123456789012:profile/fixture" },
    "UNSUPPORTED_REGION",
  ],
])
  test(`${name} never makes a usage request`, async () => {
    await assert.rejects(
      fetchKiroUsage(
        options(null, {
          authProvider: async () => credential,
          fetchImpl: async () => {
            assert.fail("must not contact service");
          },
        }),
      ),
      expectCode(code),
    );
  });

test("EU account uses the current EU management origin", async () => {
  const report = await fetchKiroUsage(
    options(payload(), {
      authProvider: async () => ({
        ...auth,
        profile_arn: auth.profile_arn.replace("us-east-1", "eu-central-1"),
      }),
      fetchImpl: async (url) => {
        assert.equal(url, "https://management.eu-central-1.kiro.dev/");
        return Response.json(payload());
      },
    }),
  );
  assert.equal(report.status, "available");
});

test("already-cancelled request does not read auth or contact service", async () => {
  const controller = new AbortController();
  controller.abort(new Error(auth.access_token));
  let called = false;
  await assert.rejects(
    fetchKiroUsage(
      options(null, {
        signal: controller.signal,
        authProvider: async () => {
          called = true;
          return auth;
        },
      }),
    ),
    expectCode("CANCELLED"),
  );
  assert.equal(called, false);
});

test("caller cancellation stops a pending request even if injected fetch ignores abort", async () => {
  const controller = new AbortController();
  await assert.rejects(
    fetchKiroUsage(
      options(null, {
        signal: controller.signal,
        fetchImpl: () => {
          controller.abort(new Error(auth.access_token));
          return new Promise(() => {});
        },
      }),
    ),
    expectCode("CANCELLED"),
  );
});

test("deadline bounds auth, network and response decoding independently", async () => {
  for (const extra of [
    { authProvider: () => new Promise(() => {}) },
    { fetchImpl: () => new Promise(() => {}) },
    { fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) },
  ])
    await assert.rejects(
      fetchKiroUsage(options(null, { timeoutMs: 5, ...extra })),
      expectCode("TIMEOUT"),
    );
});

test("explicit managed auth store is used without changing environment or valid storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-kiro-usage-"));
  const authFile = join(directory, "auth.sqlite3");
  const originalEnv = process.env.OMP_KIRO_AUTH_FILE;
  try {
    await saveKiroAuth(
      {
        ...auth,
        expires_at: new Date(Math.max(Date.now(), NOW) + 86_400_000).toISOString(),
        kind: "social",
        provider: "github",
      },
      { authFile },
    );
    const before = await readFile(authFile);
    const report = await fetchKiroUsage({
      authFile,
      now: () => NOW,
      fetchImpl: async () => Response.json(payload()),
    });
    assert.equal(report.status, "available");
    assert.deepEqual(await readFile(authFile), before);
    assert.equal(process.env.OMP_KIRO_AUTH_FILE, originalEnv);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
