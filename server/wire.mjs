import { randomUUID } from "node:crypto";

export const KIRO_BOOTSTRAP_REGIONS = Object.freeze(["us-east-1", "eu-central-1"]);
const GOVCLOUD_REGIONS = Object.freeze(["us-gov-west-1", "us-gov-east-1"]);
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/;
const PROFILE_ARN = /^arn:(aws|aws-us-gov):codewhisperer:([a-z]{2}(?:-[a-z0-9]+)+-\d+):(\d+):profile\/([A-Za-z0-9_-]+)$/;

export function isKiroRegion(value) {
  return typeof value === "string" && REGION.test(value);
}

export function kiroProfileRegions(auth) {
  return auth?.kind === "oidc" && auth.provider === "identity-center" && auth.region?.startsWith("us-gov-")
    ? GOVCLOUD_REGIONS
    : KIRO_BOOTSTRAP_REGIONS;
}

export function parseKiroProfileArn(arn) {
  if (typeof arn !== "string") return null;
  const parts = PROFILE_ARN.exec(arn);
  if (!parts || (parts[1] === "aws-us-gov") !== parts[2].startsWith("us-gov-")) return null;
  return { region: parts[2], accountId: parts[3], profileId: parts[4] };
}

export function kiroEndpoint(auth, service = "runtime") {
  const profileRegion = parseKiroProfileArn(auth.profile_arn)?.region;
  const regions = kiroProfileRegions(auth);
  const region = auth.kind === "api-key" ? auth.region : profileRegion ?? regions[0];
  if (auth.kind === "api-key" ? !isKiroRegion(region) :
    (auth.profile_arn && !profileRegion) || !regions.includes(region)) {
    throw new Error("Kiro HTTP does not support this account profile region.");
  }
  return `https://${service}.${region}.kiro.dev/`;
}

const OPTOUT = { "x-amzn-codewhisperer-optout": "true" };
const RUNTIME = "api/codewhispererruntime/0.1.19636";
const OPERATIONS = {
  GenerateAssistantResponse: ["AmazonCodeWhispererStreamingService.GenerateAssistantResponse", "api/codewhispererstreaming/0.1.19636", "F"],
  ListAvailableModels: ["KiroControlPlaneBearerService.ListAvailableModels", "api/kirocontrolplanebearer/0.1.0", "F,C"],
  ListAvailableProfiles: ["AmazonCodeWhispererService.ListAvailableProfiles", RUNTIME, "F"],
  GetUsageLimits: ["AmazonCodeWhispererService.GetUsageLimits", RUNTIME, "F"],
};
const FAMILY = { linux: "linux", darwin: "macos", win32: "windows" }[process.platform] ?? "other";
const APP = "app/AmazonQ-For-CLI";

function userAgents(api, features, appVersion = true) {
  const base = `aws-sdk-rust/1.6.0 ua/2.1 ${api} os/${FAMILY} lang/rust/1.94.1`;
  return {
    "user-agent": `${base} ${appVersion ? "md/appVersion-3.2.0" : `m/${features}`} ${APP}`,
    "x-amz-user-agent": `${base} m/${features} ${APP}`,
  };
}

function sdkRequest(attempt, maxAttempts) {
  return {
    "amz-sdk-request": `attempt=${attempt}; max=${maxAttempts}`,
    "amz-sdk-invocation-id": randomUUID(),
    accept: "*/*",
    "accept-encoding": "gzip",
  };
}

function bearer(token) {
  return { authorization: `Bearer ${token}`, ...(token.startsWith("ksk_") ? { tokentype: "API_KEY" } : {}) };
}

export function kiroCliServiceHeaders(operation, token, { attempt = 1, maxAttempts = 1 } = {}) {
  const [target, api, features] = OPERATIONS[operation];
  return {
    "content-type": "application/x-amz-json-1.0",
    "x-amz-target": target,
    ...userAgents(api, features),
    ...OPTOUT,
    ...(operation === "GenerateAssistantResponse" ? {
      "x-amzn-kiro-attempt": `${attempt};max=${maxAttempts}`,
      "x-amzn-kiro-fallback": "0;max=0",
    } : {}),
    ...bearer(token),
    ...sdkRequest(attempt, maxAttempts),
  };
}

export function kiroCliOidcHeaders({ attempt = 1, maxAttempts = 1 } = {}) {
  return {
    "content-type": "application/json",
    ...userAgents("api/ssooidc/1.100.0", "E,N", false),
    ...OPTOUT,
    ...sdkRequest(attempt, maxAttempts),
  };
}

export const KIRO_CLI_SOCIAL_HEADERS = Object.freeze({
  "content-type": "application/json",
  "user-agent": "Kiro-CLI",
  accept: "*/*",
  "accept-encoding": "gzip",
  ...OPTOUT,
});

export function kiroCliWebHeaders(auth, { attempt = 1, maxAttempts = 1 } = {}) {
  return {
    "content-type": "application/json",
    ...userAgents(RUNTIME, "F"),
    ...OPTOUT,
    ...bearer(auth.access_token),
    ...(auth.profile_arn ? { "x-amzn-kiro-profile-arn": auth.profile_arn } : {}),
    ...sdkRequest(attempt, maxAttempts),
    accept: "application/json",
  };
}
