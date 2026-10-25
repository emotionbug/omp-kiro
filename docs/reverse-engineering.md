# Kiro 2.28.0 protocol analysis

This record separates runtime observations, static reconstruction, and unverified generation behavior. Credential values, authorization headers, refresh-token values, and account/profile identifiers are excluded.

## Targets

The launcher invokes `kiro-cli-chat` for ACP. Exact installed Linux x86-64 artifact SHA-256 values:

- `kiro-cli`: `a629287174f294b52ec011300e08487afff36c6e00ff746b63ac85fceba9ba91`
- `kiro-cli-chat`: `ae5e172a905bd0078e9d2faded43837d05bd684615572af9917702fc349bbd4d`

REA opened the launcher with Ghidra, but string requests timed out at the MCP receive boundary. Rizin was unavailable. Subsequent REA process captures ran read-only byte scanners over the exact artifacts and sanitized metadata probes. String/schema observations are static evidence, not successful decompilation or intercepted generation traffic. The native target was closed after analysis.

## Persistent ACP/MCP

REA metadata observation `ev_f31208f66d435b49634e7381a0c62589aaa564d9475ef409f86ba16164446f47` launched an isolated bridge agent, issued `initialize`, `session/new`, and an already-current `session/set_model`, then cleaned up. No generation prompt was sent.

Observed:

- Kiro CLI Agent 2.28.0, ACP protocol version 1.
- HTTP MCP support; SSE not advertised.
- HTTP MCP initialize/initialized/tools-list discovery during session creation.
- Selected bridge mode and 22 model IDs.
- A native ACP session ID suitable for later calls.

Keeping that session and its in-flight prompt alive while OMP executes tools is the adapter design. Real-provider tool continuation was not observed because generation quota was known exhausted. Controlled child/HTTP peers exercised the state machine, including parallel calls, buffered text, cancellation, resets, and resource cleanup.

An actual OMP/Paseo runtime smoke verified one child across an OMP tool handoff and a subsequent user turn. The first ACP prompt was 8,903 characters; the second was 207; the tool continuation required no new prompt. These fixture sizes establish removal of replay/startup work in that scenario, not a production latency or billing benchmark.

The smoke also exposed mutable enumerable OMP runtime metadata on tool objects. Session reconciliation now fingerprints only the name/description/input-schema projection actually exposed through MCP, not the complete live tool instance.

## Direct HTTP and the model-catalog discrepancy

The original exploratory request used an old Q-service route and `origin=CLI`, returning two models. Further analysis found the current management target and `KIRO_CLI` origin. The current management route still returns two models with `CLI`, but all 22 with `KIRO_CLI`. The old routing is not retained as a fallback.

Current artifact-backed routing:

| Operation      | US East endpoint                                            | Target/origin                                                                                  |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Model metadata | `https://management.us-east-1.kiro.dev/`                    | `KiroControlPlaneBearerService.ListAvailableModels`, `KIRO_CLI`                                |
| Account quota  | `https://management.us-east-1.kiro.dev/`                    | `AmazonCodeWhispererService.GetUsageLimits`, `KIRO_CLI`, `resourceType: AGENTIC_REQUEST`       |
| Generation     | `https://runtime.us-east-1.kiro.dev/`                       | `AmazonCodeWhispererStreamingService.GenerateAssistantResponse`, native user origin `KIRO_CLI` |
| Social refresh | `https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken` | JSON refresh request                                                                           |
| Backend search | `https://runtime.us-east-1.kiro.dev/mcp`                   | InvokeMCP JSON-RPC `tools/list` / `tools/call`, remote tool `web_search`                      |

The artifact also contains EU Central management/runtime counterparts. That region is statically supported, not runtime exercised here. Other profile regions fail explicitly.

Key evidence:

- Current management target/origin: `ev_1f530371ada582fa6c197676af8ac351418b4a7ba43ae38e34c14f9368af40e1`.
- Current endpoint families: `ev_33000c28378bf8039eba78919eec6bdccc97bf2b947d73ee3018cd44745ccd7d`.
- Current runtime plus unchanged generation target/header markers: `ev_096b23345c503b53b3ecdac6136ad8c178abb4841718e0ecc3c2fc9bc18327d9`.
- Correct authenticated management request, HTTP 200, 22 models and token limits: `ev_6afec8dbc15e3ab3eb5e07d5395a12be54653d339b0694f873fccc5ec366ec16`.
- Independent comparison of the actual exported ACP and HTTP implementations: `ev_028b099c76f813cbb73de386e256c9bb50da5c2d690f08ea025d9b8a7bb33451`; `acpCount=22`, `httpCount=22`, identical sorted IDs, both set differences empty, exit 0.

The capture's executable digest binds the caller's Node harness, and process trees are sampled. Network packets were not captured; authenticated request/status/schema observations came from the explicit harness. These limitations do not imply generation was exercised.

## Managed backend search and retry boundaries

Live REA observation `ev_cdd8e8ace141aea7d01c57401c240620479781c4fd9a99f431c91bb148edef94` exercised the authenticated Kiro `/mcp` backend with no model-generation request. The process exited naturally with status 0 in about two seconds and returned ten real search results. `tools/list` advertised `web_search` only; no remote `web_fetch` was observed. This establishes a working backend search path for that account/environment, not arbitrary-URL full-page fetch, all account-policy branches, or Windows package qualification.

Static canonical AWS SDK 1.0.45 schema evidence `ev_ce7668f08601a63eee8a88a2743928102734e20de3a8ce0b4a26947fcf9af55c` establishes that InvokeMCP's `profileArn` is bound to `x-amzn-kiro-profile-arn`, not a JSON body field. The client sends bearer authentication, that profile header when present, and JSON-RPC `tools/call` with `name: web_search` and `arguments: { query }`. This narrow wire-binding claim is not full SDK reconstruction.

The implementation accepts 1–200 Unicode code points, caps each search response at 1 MiB, preserves source URLs/snippets and source-specific `maxVerbatimWordLimit`, and rejects malformed/mismatched RPC responses. HTTP requests go only to the supported regional Kiro runtime `/mcp`; redirects are disabled. Returned source URLs are data, never follow-up HTTP targets. There is no Exa/Brave/direct-website fallback or invented `web_fetch`. The target therefore needs approved Kiro runtime/auth connectivity (including any deployment proxy/gateway and trust roots), not direct connectivity to result websites. Other workspace/MCP tools are outside that client's network boundary.

Public OMP 18.12.6 source was reviewed for the extension contract: `ToolDefinition` takes `parameters` and `execute(toolCallId, params, signal, onUpdate, ctx)` returning `content` plus `details`; the injected `pi.zod` facade supports `refine`, `describe`, and strict objects. The HTTP extension registers a single essential `web_search` with read approval. OMP's registry replaces same-named built-ins, rather than exposing two search tools; this implementation never calls the replaced native tool. Native Paseo marks search read-only, retaining Plan-mode access. Static contract review and controlled tests are not an actual new OMP-to-production search execution; JSON schema emission cannot encode the Unicode/blank refinement, so runtime validation remains authoritative.

Retry ownership changed in 0.4.2: the HTTP transport, not OMP's bounded host retry loop, owns outage recovery. Default `maxAttempts: null` means unbounded until abort, with a fixed 30000 ms delay after failures. Explicit 1–5 attempt policies and configurable short backoff remain available for bounded deployments/tests. Longer Retry-After extends the abortable delay beyond the backoff cap. Catalog/search/usage and OMP command wrappers have no shorter default total deadline; per-request response-data timeout remains separate.

Actual OMP generation opts into `continuePartial: true`. A failed published fragment is appended to local wire history after moving the prior current input/tool results once; a new continuation input preserves model/origin, tool schema, workspace context, and conversation identity without copying old toolResults. Future fragments append to the same host assistant message. Repeated partial failures create further continuations, not original-prompt/committed-output replays. This is implemented recovery behavior, not artifact evidence that the production service will always continue without textual overlap. Native Paseo instead uses `onRestart(info)` to replace provisional text. Tool calls remain buffered until a complete validated response; no host tool execution or entire tool turn is wrapped in retry. A lost response may represent already-billed upstream work; retry/continuation can incur another cloud charge, and no exactly-once inference claim is made.

Transient classification includes offline ENOTFOUND/EAI_AGAIN, proven connect failures, socket drops/timeouts, HTTP 408/429/500/502/503/504, and selected temporary framed errors. TLS/certificate/protocol failures, cancellation, authentication/permission/quota rejection, malformed frames/JSON, and incomplete tools are terminal. Auth safely retries DNS/pre-connect failures; refresh also retries explicit 429/503. Neither a lost/timeout single-use token response nor OIDC's polling loop replays ambiguously consumed credentials. Login/device expiry remains authoritative. Generation reloads expiring credentials during a long outage and rejects changed profile/account/issuer identity. Retry status metadata contains only attempt/limit/delay and never enters answer text.

An event-stream clean EOF between valid frames is an unresolved transport edge: there is no authenticated terminal marker in this reconstruction. After at least one event and complete buffered tools it may be accepted as completion even if text is truncated; partial frames and stream exceptions are detected separately. Search responses must still form complete JSON. The current account's known exhausted generation quota prevented new live generation probes; it was not spent re-confirming that failure. Latest source changes await isolated CI, not local checks under severe memory pressure.

Source contract for cold/offline startup (0.4.3): when the host explicitly supplies `OMP_KIRO_MODEL_CATALOG_FILE`, the async OMP extension registers authoritative static rows from genuine account-bound metadata before model resolution and omits `fetchDynamicModels`. This prevents host offline/background discovery from replacing account rows with an authoritative empty dynamic set or starting detached live discovery. Refresh requires `models.cmd` plus extension/session reload; `/kiro-models` remains an explicit live query. Native catalog/session startup uses the same helper and checks the exact selected ID. Read-only managed auth establishes identity even when expired, without refresh/network/CLI side effects. The bounded version-1 snapshot contains only fetched metadata and a SHA-256 account binding, not tokens. Profile-preserving token renewal is accepted; without a profile ARN, refresh-token rotation (or access-token rotation without refresh) requires refreshed metadata. Missing/malformed/mismatched snapshots fail closed with `models.cmd` guidance. Empty remains empty, and no TTL-generated model or credential fallback exists. Without an explicit snapshot, startup/dynamic discovery retain live discovery and its 30-second transient retry/cancellation contract. Generation continues to use managed auth refresh and its existing account-change guard. Packaged readiness and real Windows/OMP proof remain the host integration's responsibility, not evidence of live generation acceptance.


## Account quota and slash commands

Exact-artifact field/operation observations `ev_a4ba2eac9fff89e034422fdaa2030ab44b4e115dd3d552dfae759c4697ce1926` and `ev_f00d13779f98fee27ce93ad7438858f87d1b98baa9331b46a447e18e8ff6b6a7` identified current usage, bonus, trial, add-on, and overage structures. The quota operation retains an `AmazonCodeWhispererService` target even though model discovery uses `KiroControlPlaneBearerService`; that does not imply the old Q hostname is correct.

Live read-only `ev_73f9529862dccd2a9c3641a0bdd025c99e7eb58df0cd0d213f4b027db43f49d2` and `ev_69b10794b2389df79bec3dc01c07ded0845f8b5c6d3d6a60555a3bbd4585df88` received HTTP 200 from the current management route. Requests disabled email inclusion; the observing harness suppressed account/profile identity and credentials. These were explicit HTTPS harness requests, not intercepted CLI traffic.

The live response returned the same purchased credit pool in both `addOnMetadata.addOns` and `overageCredits`. They are alternative projections, not extra allocations. Precision fields supersede rounded integer fields. Monthly, trial, bonus, purchased, and on-demand amounts are distinct; a service overage cap is not assumed to be spendable quota. Reset/expiry dates come from authoritative Unix-second fields. Unknown quota shapes and missing dates fail explicitly, not as zero/free usage. Live paid-account purchase/base branches were observed; optional trial/bonus and EU-region branches have controlled coverage, not live-account proof. No purchase, overage configuration change, or generation was performed.

Packaged guide observations `ev_993885c4ee305f3280c07117c053efeafaa078189acebfaaac850748d148c0ad` and `ev_9ab0f259df5ee2cd1617aa0e35b4aa39a373ba879495846c70a98f58c2615f52` show engine-specific slash inventories. Some `/help` variants invoke an AI help agent. Consequently the integration implements local help and explicit account/model queries instead of forwarding arbitrary slash text to Kiro. OMP keeps its own history, compaction, tool-trust, and model machinery; ACP reset closes only the current bridge connection.

## Authentication acquisition and storage

### Current social device protocol

Exact-artifact social strings identify `/oauth/device/authorization`, `/oauth/device/poll`, and the current `https://app.kiro.dev/signin` portal:

- Device schema/path markers: `ev_45b3e7289ec3115102f8323912181ede782965d10a0e1fad70de96b948ee355c`.
- Portal/PKCE/redirect markers: `ev_8880d65d9498d3ca58fe82ec5078c5830c0f66cbd25374ea41f614735d576241`.

Live safe initiation at the fixed desktop-auth service:

- Google: `ev_bb35ca579b3ff67c0aaccc920b9fb8277133ce6eb4bfd60d42294faf11ced9c6`.
- GitHub: `ev_173b9e8db290744ad9e60ac3f713241ef6b43c9b66d3da9614712c501e157ffb`.

`POST /oauth/device/authorization` with public `clientId: kiro-cli` and `loginProvider: Google|Github` returned HTTP 200. Observed fields were deviceCode, userCode, verificationUri, verificationUriComplete, expiresInMilliseconds, and intervalInMilliseconds. Observed expiry was five minutes and interval five seconds. A poll to `/oauth/device/poll` using the private device code returned HTTP 200 `authorization_pending`. No approval was performed; codes/tokens were not emitted.

This is a distinct social-device API, not the AWS OIDC device grant. Default standalone social login uses it without spawning CLI, opening a callback port, launching an OS browser, or reading a keychain.

### Current social portal and PKCE

Current portal release `7f6e24453bd10337` was inspected without authentication. Vendor JS SHA-256 was `510fd367579e0d01265758872d627b7234ff392bfec8f3f727a3683dc2f67d71`; DeviceLogin JS was `0211cc81f6bb515650645986aff762a9d0509474dedc1277ba79179936709c7c`.

`ev_284471afa0c76e1a9fa81c69514c6d323b0270f509445162bac7eb334328b93e` and `ev_e8419528d0d42872156813d71c0564378447d40d95b29b0b72662362e699dad4` support the portal's required state/code_challenge/S256/redirect_uri/redirect_from fields and provider selection. The current portal accepts loopback HTTP(S) and approved Kiro HTTPS origins, not arbitrary custom URI schemes. It sends Google/GitHub results to the loopback `/oauth/callback` with provider, state, and code; the local client retains its verifier for exchange.

The implementation's optional loopback/manual modes validate exact redirect, state, provider, duplicates, and S256 PKCE. Manual mode binds no port and accepts a full private callback URL from the user. The device page can be feature-disabled by account; no fallback is silently selected.

Successful new social approval and credential issuance remain unexercised against production. Pending response fields and token-exchange validation were observed; approved response decoding is protocol reconstruction. If an acquired response lacks lifetime, the implementation obtains authoritative expiry through the verified refresh endpoint rather than inventing one.

### Builder ID / IAM Identity Center

Static `ev_484e93766f0781f85c25b0bf02310bc37886579f085a7bcac08b082ec35187ee` and `ev_d7d69eacd631639c9c4433d596f9842907f2a45bd2dab66706704bdc8aba6b49` identify current AWS SSO OIDC operations, device/refresh grants, default Builder ID portal, registration fields, and issuer-region metadata.

Live independent REA probe `ev_13ea00fbbca7a06c8bc0caca60a49794b232bb87b08b3bb198a3a9df9c76b83e` observed:

1. `POST https://oidc.us-east-1.amazonaws.com/client/register` with public client registration → HTTP 200.
2. `/device_authorization` with that registration and Builder ID portal → HTTP 200; ten-minute expiry, one-second minimum interval.
3. `/token` with the device grant after waiting → HTTP 400 `authorization_pending`.

The exact current CLI clientName/scope vector was not recovered. The implementation uses the live-accepted `Kiro CLI` name and three historical public CodeWhisperer scopes. This proves service acceptance of initiation, **not exact equality with every current CLI registration request or enterprise entitlement**. Primary supplementation: [public Builder ID implementation](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/chat-cli/src/auth/builder_id.rs), [scope constants](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/chat-cli/src/auth/consts.rs), [AWS regional OIDC endpoints](https://docs.aws.amazon.com/general/latest/gr/sso.html#awsssooidcservice_service).

Issuer region is not inference-runtime region. Enterprise approval, successful live OIDC issuance/refresh, and Kiro inference acceptance of newly issued OIDC credentials remain unexercised.

### Managed store, refresh, and migration

The HTTP transport now uses a separate owner-only SQLite store. Login acquisition returns credentials in memory; only the parent storage layer persists them. No OS keychain or CLI installation is required. Compare-and-swap guards refresh and pending-login races; logout writes a tombstone so an older pending operation cannot restore credentials.

The managed path is `$XDG_CONFIG_HOME/omp-kiro/auth.sqlite3`, defaulting to `~/.config/omp-kiro/auth.sqlite3` on both POSIX and Windows. An absolute `OMP_KIRO_AUTH_FILE` overrides it; login `--auth-file` and the later host must identify the same store. A portable package must supply its intended private path explicitly, not rely on implicit discovery beside its executable.

CLI SQLite is now an explicit read-only social-import source, not an implicit runtime fallback. Original schema/field evidence remains relevant to import:

- Schema: `ev_b5150013c85f00f6d05176da76be6b079927bff62e222a2e6b5a8ae3538b1809`.
- Token field names/provider/region only: `ev_dd9d1e9bd5d421bce92556ddfda6c7d6a5ed8bf90413be23688beccbdbd2bef5`.
- Successful Google refresh: `ev_7df5062c6a3e65de90711e61c9d4035047dda8bb073871a07b393746fe04bff8`; HTTP 200 with accessToken, expiresIn, profileArn, and refreshToken. Only schema predicates were emitted.

### Standalone command verification and environmental boundary

REA `ev_b5c79e19cf4db6f70409982243383b57b06fc35867c645e63e6bd53773b8190b` ran the actual new authentication CLI with a `PATH` excluding the local Kiro executable. It received an official live Google verification link, then was intentionally cancelled with SIGINT, exit 130; no credential file was created and no approval attempted. The observing harness suppressed actual verification codes/URLs and emitted predicates only.

A separate controlled real-HTTP/CLI smoke exercised initiation → pending → approved credential decoding → private store → refresh rotation → actual Bun-hosted OMP use → logout. It used synthetic credentials and a local upstream fixture, not production approval.

The user-reported environment-specific native CLI failure was not rerun. No specific root cause is asserted. Device acquisition removes local callback, browser-launch, and keychain dependencies; it still requires outbound HTTPS, provider feature availability, user approval, and applicable organization policy.

## Native Paseo runtime boundary

The native provider is a Paseo directory/Git plugin, not an OMP-derived profile. All imported implementation modules live under `server/`, as Paseo's runtime-ownership compiler requires. OMP and the standalone CLI import the same authentication and HTTP modules; no protocol copy or legacy forwarding shim remains.

New native sessions now default to `full` (unattended workspace changes, commands, and injected MCP execution), matching the user's explicit automatic-execution choice. Explicit or restored `ask`/`plan` remain authoritative; initial plugin trust and login authorization are unchanged. The controlled default-policy test writes a file and runs an actual append command without a session.permission event; the explicit Ask test checks that the file does not exist before approval. These new cases await isolated CI and are not new production execution evidence.

Actual isolated-daemon observation `ev_a2720ad1c9461378778134522fdcbb8b408b48f4a4ce9692ac48fb24bde41186` loaded the directory plugin, wrote a real workspace file through a controlled HTTP tool call, returned its actual result, denied a separate write, and approved the real injected `paseo/list_agents` MCP call. Metadata commands produced no additional generation. All account credentials and upstream generation were synthetic; non-loopback external requests were blocked.

An initial actual refresh exposed changing user IDs and missing query user rows. After correction, `ev_e99ce981599d92f28869eff93ab4243e19ca72c28907d44cdc23e60719735519` proved exact deep equality of all ten provider timeline items, including four user rows and stable tool IDs, across SDK refresh. Query commands stayed out of native generation history. Core-generated envelope timestamps and envelope turn IDs are not preserved by current Paseo rehydration; no exact-envelope claim is made.

The rendered standard Usage panel displayed the controlled Kiro Pro quota and fractional credit balance. Separately, the installed main-daemon plugin returned the actual 22-model catalog and real account quota without restarting the daemon or calling generation. SDK usage fetches read but never refresh/write the managed login. Current `PluginAgentSession` lacks `usageSession()`, so this release exposes account quota globally rather than claiming native per-agent quota association.

## Generation reconstruction and its limits

The direct transport maps native conversation history, tool specifications, assistant tool uses, and actual tool results. It decodes AWS event-stream prelude/header/payload framing with both CRCs. System-prompt arrays normalize to a string. Developer instructions are labeled in that native instruction channel; this is not a claim that upstream has a distinct developer-history role.

Current artifact `system_prompt`/`systemPrompt` observations support the new top-level field. Its precise serialization and server acceptance remain **artifact-supported inference**, not decompiled or captured generation-request evidence. Current generation endpoint/body acceptance, successful inference, and real generated event sequences were not exercised because the account's monthly quota is exhausted. No generation request was made to re-confirm that error.

The older public generated AWS SDK supplements native conversation/tool/event framing, not current endpoint/origin selection:

- [Generation operation](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-streaming-client/src/operation/generate_assistant_response.rs)
- [Conversation serialization](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-streaming-client/src/protocol_serde/shape_conversation_state.rs)
- [User context/tool serialization](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-streaming-client/src/protocol_serde/shape_user_input_message_context.rs)
- [Event stream serialization](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-streaming-client/src/event_stream_serde.rs)

Controlled HTTP fixtures, synthetic SQLite credentials, and the actual Bun-hosted OMP plugin exercised native payload mapping, fragmented framed responses, actual OMP file writes, returning real tool results, follow-up output, and usage handling. This validates adapter integration, not the unexercised production generation boundary.
