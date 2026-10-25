import { loadKiroAuth, refreshExpiredKiroAuth } from "./auth.mjs";
import { fetchWithRetry, isTransientNetworkError } from "./network.mjs";

const messages = {
  AUTH_REQUIRED: "Kiro usage requires a managed login; run omp-kiro login.",
  AUTH_EXPIRED: "The managed Kiro login has expired; refresh it before reading usage.",
  AUTH_INVALID: "The managed Kiro login has no valid access token or expiry.",
  UNSUPPORTED_REGION: "Kiro usage does not support this account profile region.",
  INVALID_RESPONSE: "Kiro returned an unrecognized usage response.",
  UNKNOWN_EXPIRY: "Kiro did not report a valid quota reset or expiry date.",
  NO_QUOTA: "Kiro did not report a supported account quota.",
  HTTP_ERROR: "Kiro rejected the usage request.",
  RATE_LIMITED: "Kiro usage is temporarily rate limited.",
  TIMEOUT: "The Kiro usage request timed out.",
  CANCELLED: "The Kiro usage request was cancelled.",
  NETWORK_ERROR: "The Kiro usage service could not be reached.",
};

export class KiroUsageError extends Error {
  constructor(code, { status } = {}) {
    super(messages[code] ?? messages.INVALID_RESPONSE);
    this.name = "KiroUsageError";
    this.code = Object.hasOwn(messages, code) ? code : "INVALID_RESPONSE";
    if (status !== undefined) this.status = status;
  }
}

const fail = (code = "INVALID_RESPONSE") => {
  throw new KiroUsageError(code);
};
const object = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value;
};
const list = (value) => {
  if (!Array.isArray(value)) fail();
  return value;
};
const number = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail();
  return value;
};
// The integer fields are rounded by the service. Never add both representations.
const precise = (value, name) => number(value[`${name}WithPrecision`] ?? value[name]);
const date = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail("UNKNOWN_EXPIRY");
  const parsed = new Date(value * 1000);
  if (!Number.isFinite(parsed.getTime())) fail("UNKNOWN_EXPIRY");
  return parsed.toISOString();
};

const plans = {
  Q_DEVELOPER_STANDALONE: "Kiro",
  Q_DEVELOPER_STANDALONE_FREE: "Kiro Free",
  Q_DEVELOPER_STANDALONE_PRO: "Kiro Pro",
  Q_DEVELOPER_STANDALONE_PRO_PLUS: "Kiro Pro+",
  Q_DEVELOPER_STANDALONE_PRO_MAX: "Kiro Pro Max",
  Q_DEVELOPER_STANDALONE_POWER: "Kiro Power",
  Q_DEVELOPER_STANDALONE_STUDENT: "Kiro Student",
};

function normalizeUsage(payload, now) {
  object(payload);
  // GetUsageLimits is not paginated in the installed service model. Do not
  // silently render a partial quota if a future response adds continuation.
  if (payload.nextToken) fail();
  const rows = list(payload.usageBreakdownList);
  if (!rows.length) fail("NO_QUOTA");
  const report = { status: "available", windows: [], balances: [], details: [] };
  const plan = plans[payload.subscriptionInfo?.type];
  if (plan) report.planLabel = plan;
  const overageStatus = payload.overageConfiguration?.overageStatus;
  if (overageStatus !== undefined) {
    if (!["ENABLED", "DISABLED"].includes(overageStatus)) fail();
    report.details.push({
      id: "overage-status",
      label: "On-demand usage",
      value: overageStatus === "ENABLED" ? "Enabled" : "Disabled",
    });
  }

  function pool(id, label, source, expiry, { summary = false, expired = false } = {}) {
    object(source);
    const used = precise(source, "currentUsage");
    const limit = precise(source, "usageLimit");
    const resetsAt = date(expiry);
    expired ||= Date.parse(resetsAt) <= now;
    const remaining = expired ? 0 : Math.max(0, limit - used);
    report.balances.push({
      id,
      label: expired ? `${label} (expired)` : label,
      used,
      remaining,
      limit,
      unit: "credits",
      resetsAt,
    });
    if (!expired) {
      const usedPct = limit > 0 ? (used / limit) * 100 : null;
      if (usedPct !== null && !Number.isFinite(usedPct)) fail();
      report.windows.push({
        id,
        label,
        ...(summary ? { summary: true } : {}),
        usedPct,
        remainingPct: limit > 0 ? (remaining / limit) * 100 : null,
        resetsAt,
      });
    }
    return { used, limit };
  }

  rows.forEach((raw, index) => {
    const row = object(raw);
    if (row.resourceType !== "CREDIT") fail("NO_QUOTA");
    const prefix = rows.length === 1 ? "credits" : `credits-${index + 1}`;
    const suffix = rows.length === 1 ? "" : ` ${index + 1}`;
    const reset = row.nextDateReset ?? payload.nextDateReset;
    const resetsAt = date(reset);
    if (Date.parse(resetsAt) <= now) fail("UNKNOWN_EXPIRY");
    pool(`${prefix}-base`, `Monthly credits${suffix}`, row, reset, { summary: true });

    if (row.freeTrialInfo != null) {
      const trial = object(row.freeTrialInfo);
      if (!["ACTIVE", "EXPIRED"].includes(trial.freeTrialStatus)) fail();
      pool(`${prefix}-trial`, `Trial credits${suffix}`, trial, trial.freeTrialExpiry, {
        expired: trial.freeTrialStatus === "EXPIRED",
      });
    }
    if (row.bonuses != null)
      list(row.bonuses).forEach((rawBonus, i) => {
        const bonus = object(rawBonus);
        if (!["ACTIVE", "EXPIRED"].includes(bonus.status)) fail();
        // Never expose bonus codes, descriptions, or user-supplied display names.
        pool(
          `${prefix}-bonus-${i + 1}`,
          `Bonus credits${suffix} ${i + 1}`,
          bonus,
          bonus.expiresAt,
          { expired: bonus.status === "EXPIRED" },
        );
      });

    // addOnMetadata is the current projection of the legacy overageCredits
    // list. The live service returns both for the same purchase; choose ONE.
    const metadata = row.addOnMetadata == null ? null : object(row.addOnMetadata);
    const addOns = metadata ? list(metadata.addOns) : list(row.overageCredits ?? []);
    let addOnUsed = 0;
    let addOnLimit = 0;
    addOns.forEach((addOn, i) => {
      const { used, limit } = pool(
        `${prefix}-addon-${i + 1}`,
        `Add-on credits${suffix} ${i + 1}`,
        addOn,
        object(addOn).expiresAt,
      );
      addOnUsed += used;
      addOnLimit += limit;
    });
    // Aggregate metadata is a cross-check, not another credit pool. Tolerate
    // floating-point summation noise, but not missing purchases or truncation.
    if (metadata) {
      const matches = (a, b) => Math.abs(a - b) <= Math.max(1, a, b) * 1e-10;
      if (
        !matches(number(metadata.addOnTotalUsage), addOnUsed) ||
        !matches(number(metadata.addOnTotalLimit), addOnLimit)
      )
        fail();
    }

    if (row.currentOverages !== undefined || row.currentOveragesWithPrecision !== undefined) {
      report.balances.push({
        id: `${prefix}-overage`,
        label: `On-demand credits used${suffix}`,
        used: precise(row, "currentOverages"),
        unit: "credits",
        resetsAt,
      });
    }
    if (row.overageCharges !== undefined) {
      if (row.currency !== "USD") fail();
      report.balances.push({
        id: `${prefix}-charges`,
        label: `On-demand charges${suffix}`,
        used: number(row.overageCharges),
        unit: "usd",
        resetsAt,
      });
    }
    if (row.overageCap !== undefined || row.overageCapWithPrecision !== undefined)
      report.details.push({
        id: `${prefix}-overage-cap`,
        label: `Service overage cap${suffix}`,
        value: String(precise(row, "overageCap")),
      });
    if (row.overageRate !== undefined) {
      if (row.currency !== "USD") fail();
      report.details.push({
        id: `${prefix}-overage-rate`,
        label: `On-demand USD per credit${suffix}`,
        value: String(number(row.overageRate)),
      });
    }
  });
  if (payload.totalUsage != null) {
    const total = object(payload.totalUsage);
    if (total.maxOverageLimit !== undefined)
      report.details.push({
        id: "total-overage-limit",
        label: "Total service overage limit",
        value: String(number(total.maxOverageLimit)),
      });
    if (total.totalOverageCharges !== undefined)
      report.details.push({
        id: "total-overage-charges",
        label: "Total service overage charges",
        value: String(number(total.totalOverageCharges)),
      });
  }
  return report;
}

function abortable(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Read account quotas only; never generate, purchase credits, or enable overage.
 * authProvider may supply a strictly read-only credential reader for SDK usage
 * sources. The normal CLI/OMP path uses the managed auth refresher.
 */
export async function fetchKiroUsage({
  signal,
  fetchImpl = globalThis.fetch,
  authFile,
  authProvider = loadKiroAuth,
  timeoutMs,
  now = Date.now,
  retry,
} = {}) {
  const timer = new AbortController();
  // An explicit caller deadline remains supported; default outage recovery has
  // no total deadline that could expire before its first 30-second retry.
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => timer.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  try {
    let auth;
    try {
      auth = await abortable(
        () => authProvider({ authFile, signal: requestSignal, fetchImpl, retry }),
        requestSignal,
      );
    } catch {
      requestSignal.throwIfAborted();
      fail("AUTH_REQUIRED");
    }
    if (
      typeof auth?.access_token !== "string" ||
      !auth.access_token ||
      !Number.isFinite(Date.parse(auth.expires_at))
    )
      fail("AUTH_INVALID");
    if (Date.parse(auth.expires_at) <= now()) fail("AUTH_EXPIRED");
    const region = auth.profile_arn?.split(":")[3] || "us-east-1";
    if (!["us-east-1", "eu-central-1"].includes(region)) fail("UNSUPPORTED_REGION");
    const payload = await abortable(
      () =>
        fetchWithRetry(fetchImpl, `https://management.${region}.kiro.dev/`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${auth.access_token}`,
            "content-type": "application/x-amz-json-1.0",
            "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
          },
          body: JSON.stringify({
            origin: "KIRO_CLI",
            resourceType: "AGENTIC_REQUEST",
            isEmailRequired: false,
            ...(auth.profile_arn ? { profileArn: auth.profile_arn } : {}),
          }),
          signal: requestSignal,
          redirect: "error",
        }, {
          retry,
          async prepareRequest(init) {
            auth = await refreshExpiredKiroAuth(auth, {
              signal: requestSignal, fetchImpl, authFile, retry, authProvider, now,
            });
            return { ...init, headers: { ...init.headers, authorization: `Bearer ${auth.access_token}` } };
          },
          async consume(response) {
            if (!response.ok) {
              // Never parse/forward bodies that can echo credentials or identities.
              await response.body?.cancel().catch(() => {});
              throw new KiroUsageError(response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR", {
                status: response.status,
              });
            }
            try {
              return await abortable(() => response.json(), requestSignal);
            } catch (error) {
              requestSignal.throwIfAborted();
              if (isTransientNetworkError(error)) throw error;
              fail();
            }
          },
        }),
      requestSignal,
    );
    return normalizeUsage(payload, now());
  } catch (error) {
    if (signal?.aborted) throw new KiroUsageError("CANCELLED");
    if (timer.signal.aborted) throw new KiroUsageError("TIMEOUT");
    if (error instanceof KiroUsageError) throw error;
    throw new KiroUsageError("NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}
