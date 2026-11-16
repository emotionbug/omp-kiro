# omp-kiro

Use Kiro in [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi), including OMP-backed agents in [Passession](https://github.com/emotionbug/Passession) (the `paseo` CLI). OMP provides persistent ACP and direct HTTP model transports; Passession 0.13.18+ provides built-in Kiro account usage, not a separate coding-agent provider.

HTTP authentication, model discovery, and generation do not require a Kiro executable. OMP retains its tools, approvals, subagents, compaction, and history. No generation request falls back to another transport or model.

## Requirements

- **OMP extension:** OMP **18.12.6+**. The host supplies `@oh-my-pi/pi-ai`.
- **Passession built-in usage:** Passession CLI and running daemon **0.13.18+**, with an existing managed HTTP login. Profile setup requires Node.js **22.13+** and OMP; account usage itself does not require OMP or Kiro CLI.
- **Standalone authentication:** Node.js **22.13+**. Bun's SQLite is used inside OMP.
- **ACP only:** an authenticated `kiro-cli` supporting HTTP MCP servers; developed with **Kiro CLI 2.28.0**.
- Available Kiro account quota. This project does not bypass subscription limits.
- Approved outbound HTTPS connectivity to Kiro runtime, management, and login services, directly or through the deployment's approved proxy/gateway and CA configuration. Search needs no direct access to external result websites.

## Install

```bash
omp install github:emotionbug/omp-kiro
npx github:emotionbug/omp-kiro login --provider google
omp models kiro-http
omp --model kiro-http/auto
```

HTTP is the plugin default: no Kiro CLI or `OMP_KIRO_TRANSPORT` setting is required. For another model, select one returned by `omp models kiro-http`, using the full `kiro-http/<model-id>` selector. No API key or change to OMP's default model is required. Start a new OMP session after installing.

For development or the optional Paseo setup, use a local checkout instead:

```bash
git clone https://github.com/emotionbug/omp-kiro.git
omp install ./omp-kiro
```

OMP links local packages, so keep that checkout in place. GitHub-spec installations do not depend on a local checkout.

For explicitly selected ACP, use a non-default Kiro executable:

```bash
OMP_KIRO_TRANSPORT=acp OMP_KIRO_COMMAND=/absolute/path/to/kiro-cli omp --model kiro-cli/auto
```

This variable names one executable, not a shell command. ACP uses the CLI's separate login. OMP/Paseo must run as the same OS user, with the Kiro executable available on `PATH` or through this variable. The default HTTP provider never invokes that executable.

## Choose a transport

The default is `http`: authentication, model discovery, and generation use the managed HTTP login without a Kiro process. No environment variable or Paseo launch-environment change is needed.

```bash
omp --model kiro-http/auto
```

ACP is opt-in: it keeps a Kiro process and ACP session for each OMP session and returns real OMP tool results through MCP. Authenticate the CLI separately and explicitly select ACP:

```bash
kiro-cli login
OMP_KIRO_TRANSPORT=acp omp --model kiro-cli/auto
```

HTTP is an unofficial, version-dependent protocol. Selecting it does not fall back to ACP on errors and does not bypass account quota. Do not put bearer or refresh tokens in environment variables, OMP configuration, or this repository.

`kiro-cli` and `kiro-http` have separate OMP catalog caches and authentication stores. Both use the current `KIRO_CLI` origin, but different accounts and enterprise policies can return different model sets. HTTP never falls back to the CLI's account or catalog.

## HTTP reasoning effort

HTTP effort follows the selected model's native `additionalModelRequestFieldsSchema`, not a hardcoded model-name list. Models without a selectable effort schema expose no effort picker, even though the original Kiro CLI supports effort on other models. An internal `default` value is not offered as a level.

When your account advertises the model and its effort controls, use OMP's `--thinking` option, for example:

```bash
omp --model kiro-http/claude-opus-4.7 --thinking high
```

The HTTP request uses the schema's actual `output_config.effort` or `reasoning.effort` under `additionalModelRequestFields`. Unsupported values are not emulated with prompts, token budgets, or another model. Native Off is sent only through an advertised `none` effort or `thinking.type: disabled`.

The OMP adapter follows OMP's mandatory-reasoning policy: when the schema offers effort levels but no Off control, an omitted or disabled host setting (including Auto resolving to Off) uses the lowest advertised effort instead. Explicit supported positive levels remain unchanged. This normalization is required because OMP's custom-provider path bypasses its built-in reasoning normalization. Models that support Off still receive their native Off control. Direct transport callers retain the strict contract: unsupported Off is rejected and omitted effort retains native defaults.

After upgrading from a version without effort support, OMP can still restore old model rows with `reasoning: false` from its persistent cache. Refresh the catalog with `omp models refresh kiro-http`, then start a new session (or reload the host's model list). `omp models kiro-http --json` should show the advertised `thinking` levels for supported models. A plugin upgrade alone does not invalidate OMP's model cache.

On a host-cache hit, OMP may skip the plugin's model discovery callback entirely. The first HTTP turn then loads the native request schemas before building the request, sharing that load across concurrent turns and retaining it for the extension instance. Catalog failures stop the turn before generation rather than silently dropping effort. An explicit offline snapshot supplies these schemas without live model discovery.

For existing managed Passession profiles, rerun [HTTP profile setup](#omp-http-profile-and-built-in-account-usage) and reload configuration to refresh effort options on existing model rows. Labels and supported user defaults are retained; stale unsupported choices are removed. Offline snapshots retain the native schema too and require the usual snapshot refresh/session reload. This support is HTTP-only; ACP behavior is unchanged.

## Independent HTTP authentication

The standalone `omp-kiro` command does not invoke `kiro-cli`, read its credentials implicitly, launch an OS browser, or require an OS keychain. The default **device flow** prints an official verification link and user code. Open the link on any browser-capable device and approve it; the command polls until completion, expiry, denial, or Ctrl+C.

```bash
# Google or GitHub, including SSH/headless/container environments
npx github:emotionbug/omp-kiro login --provider google
npx github:emotionbug/omp-kiro login --provider github

# AWS Builder ID
npx github:emotionbug/omp-kiro login --provider builder-id

# IAM Identity Center: --region is the OIDC issuer region, not inference routing
npx github:emotionbug/omp-kiro login --provider identity-center \
  --start-url https://your-portal.awsapps.com/start --region us-east-1
```

From a checkout, use `npm run auth -- login ...` or `node auth-cli.mjs login ...`. GitHub installation through OMP does not necessarily put the command on your shell's `PATH`; the `npx` form works independently.

For social accounts where device authorization is disabled, explicitly choose another flow:

```bash
# Browser is on the same host; listen on a loopback callback
npx github:emotionbug/omp-kiro login --provider google --flow loopback

# Remote browser: after approval, paste its full redirected URL privately
npx github:emotionbug/omp-kiro login --provider google --flow manual
```

Manual mode does not bind a local port. A browser on another host may show a connection error for its loopback redirect; copy that full address from its address bar. It contains a short-lived authorization code: do not share or log it. Both callback modes validate state, exact redirect/provider, and S256 PKCE before exchanging the code. Device mode needs no local callback at all.

This removes local browser-launch, callback-port, CLI installation, and keychain dependencies. It does not bypass corporate network restrictions, TLS validation, disabled provider features, or organization approval policies. The user's original environment-specific CLI failure was not reproduced, so no particular cause is claimed.

### IAM profile resolution

Since 0.4.7, login and HTTP authentication resolve a missing Kiro profile through `ListAvailableProfiles` before requesting models or generation. A single assigned profile is selected and persisted automatically, including for older managed logins that lack `profile_arn`; another browser approval is not required while the login remains valid. The OIDC issuer region stays unchanged and is distinct from the Kiro region encoded in the selected profile ARN.

Multiple profiles are never resolved by arbitrarily picking the first. Inspect and compare them inside OMP (HTTP transport only):

```text
/kiro-profiles
/kiro-profile <exact-profile-name-or-arn>
```

`/kiro-profiles` lists every assigned profile, marks the current selection, and queries each profile's plan, used/remaining credit pools, limits, reset dates and on-demand settings. A failed usage lookup stays explicitly unavailable; it is not displayed as zero and does not hide other profiles. Listing does not change the selected profile. These are metadata requests, not model generation.

A Kiro profile is a service context associated with an AWS account and region, not an OMP configuration profile. Different profiles can return different usage, subscription settings and model access. The usage API reports values for the requested ARN, but does not establish whether pools are independent or shared across an organization. Do not add the displayed limits together or assume switching grants extra credits. Enabled on-demand usage can incur charges; these commands never enable it, purchase credits or change a subscription.

`/kiro-profile` accepts an exact ARN or unique exact name; ambiguous names are rejected. Switch only after the current turn finishes. Selection is saved in the managed auth store and affects **all sessions sharing that store**, not just this conversation. OMP history is retained. The command refreshes the current session's Kiro model catalog; other sessions must refresh theirs before continuing. If metadata refresh fails after a switch, the new selection remains saved and the command reports that separately. Offline snapshots are account-bound and must be regenerated for the newly selected profile rather than reused.

Standalone commands support the same inspection and selection:

```bash
npx github:emotionbug/omp-kiro auth profiles
npx github:emotionbug/omp-kiro auth profiles --usage
npx github:emotionbug/omp-kiro auth profiles --usage --json
npx github:emotionbug/omp-kiro auth profile
npx github:emotionbug/omp-kiro auth profile --profile "$PROFILE_ARN"
```

`auth profile` without `--profile` reports the saved selection without choosing one. `auth profiles` lists the complete catalog even when a profile is already selected; `--usage` compares quotas without switching. `--auth-file` chooses the managed store and `--json` returns non-secret structured results. `login --profile "$PROFILE_ARN"` also selects an assigned profile after authentication. Unassigned ARNs and empty catalogs fail explicitly. Selection uses a compare-and-swap guard so lookup cannot overwrite a concurrent login/logout or profile change. Token refresh can update credentials during metadata queries, but listing and comparison never choose a profile. Successfully rotated refresh credentials are saved before profile discovery so a later discovery failure cannot discard the rotation.

### Credential storage and migration

HTTP uses its own SQLite file at `$XDG_CONFIG_HOME/omp-kiro/auth.sqlite3`, or `~/.config/omp-kiro/auth.sqlite3` when XDG is unset. `OMP_KIRO_AUTH_FILE` must be an absolute path. Login's `--auth-file` selects a custom file; use the same file for later OMP/Paseo sessions.

On Windows the unset-XDG default is `<user-home>/.config/omp-kiro/auth.sqlite3`, not a CLI/AppData credential path. For a portable deployment, set `OMP_KIRO_AUTH_FILE` to its private absolute store path for both login and the OMP/Paseo process. The plugin never discovers a portable package's sibling auth file implicitly.

```bash
npx github:emotionbug/omp-kiro auth status --json
npx github:emotionbug/omp-kiro auth logout
```

Status never prints tokens. On POSIX the credential file is mode `0600`, with newly created directories mode `0700`; on Windows use a private user directory and appropriate ACLs. Refreshes persist rotation with compare-and-swap. Login/logout racing a refresh cannot be undone by that old operation. Logout changes only this plugin's store, not CLI or other service sessions.

Version 0.2 read CLI SQLite directly; 0.3 is a clean cutover. To migrate an existing social login explicitly instead of authenticating again:

```bash
npx github:emotionbug/omp-kiro auth import-cli
# Non-default source, read-only:
npx github:emotionbug/omp-kiro auth import-cli --database /absolute/path/data.sqlite3
```

Import copies into the managed store and does not modify the source DB. Copied refresh credentials can still share the original service session's rotation/revocation lifecycle; a new standalone login is preferable for independent credentials. Native OIDC/keychain import is not implemented; use the standalone device flow. `OMP_KIRO_AUTH_DB` is no longer a runtime setting.

Update a linked checkout with `git -C omp-kiro pull --ff-only`, then start a new OMP session. Remove the plugin with:

```bash
omp plugin uninstall omp-kiro
```

## Passession

### OMP HTTP profile and built-in account usage

Authenticate and configure the OMP-backed profile from a local checkout. Built-in account usage requires Passession CLI and daemon **0.13.18+**, independently of profile setup:

```bash
npm ci --ignore-scripts
node auth-cli.mjs login --provider google
npm run setup:paseo -- --http --paseo-home "$HOME/.paseo"
paseo daemon reload --home "$HOME/.paseo"
paseo provider models kiro-omp-http --home "$HOME/.paseo"
paseo usage ls --refresh --home "$HOME/.paseo"
```

Setup installs the OMP extension and registers **Kiro HTTP (OMP)**: profile `kiro-omp-http`, extending `omp`, with `OMP_KIRO_TRANSPORT=http`, an absolute `OMP_KIRO_AUTH_FILE`, and model IDs such as `kiro-http/auto`. It does not query the Passession daemon or install an account-usage implementation. Kiro CLI is not needed for HTTP, but OMP remains the coding-agent harness. Setup does not reload or restart a daemon; the explicit configuration reload above does not restart it.

`--profile another-id` chooses a separate OMP profile; `--omp-command /absolute/path/omp` selects the executable. Existing matching OMP profiles retain unrelated environment, settings, models, and disabled state. Conflicting commands, auth paths, transports, and non-OMP profiles are rejected rather than overwritten. The old direct-native `kiro-http` profile and its history are not converted or deleted.

### Usage for existing OMP sessions

No external plugin installation or external-plugin enablement is needed on Passession 0.13.18+. Built-in source `kiro` uses an existing managed HTTP login, including when an OMP session uses ACP:

```bash
paseo usage ls --refresh --home "$HOME/.paseo"
# A specific agent's account scope:
paseo usage ls --agent AGENT_ID --refresh --home "$HOME/.paseo"
```

Usage fetches read credentials only: they never rotate tokens, write authentication, purchase credits, or change billing. Expired credentials require an explicit login or an OMP metadata operation that refreshes authentication before refreshing usage again. The OMP `/kiro-usage` command remains available independently of Passession's built-in source.

The standard **Usage** panel displays account credits, plan, reset/expiry dates, and on-demand usage. Monthly, trial, bonus, and purchased pools remain separate; duplicate purchase projections are not added twice. **Account quota is not per-turn token usage**: missing reported token/cost fields are not an estimate of account credits or a claim of free usage.

### Auth alignment and migration

`--auth-file /absolute/path/auth.sqlite3` sets the HTTP OMP profile's store. **Global discovery follows the daemon process's** `OMP_KIRO_AUTH_FILE`, absolute `XDG_CONFIG_HOME`, and `HOME`, not the setup shell or profile. **Session discovery uses only that OMP session's environment**, including its `OMP_KIRO_AUTH_FILE`; it does not fall back to the daemon's account selection. With a custom store, align login, the OMP profile, and the daemon's launch environment explicitly. Setup never copies tokens into Passession config or changes the daemon's launch environment.

The obsolete external native usage implementation is no longer distributed here. Passession's daemon migration retires its `omp-kiro` plugin registration in favor of built-in source `kiro`; it does **not** delete the old plugin's source checkout or saved plugin settings, managed authentication, OMP profiles, or session history. Setup leaves those old plugin records/settings untouched and does not enable other external plugins. Do not remove a running old daemon's executable before completing your planned daemon upgrade; updating this checkout is not itself a daemon rollout.

For subsequent OMP extension updates, update the linked checkout and start a new OMP session. Keep the checkout in place while OMP links it. No native usage build or external plugin reload is required.

### OMP-backed ACP profile

```bash
npm run setup:paseo -- --paseo-home "$HOME/.paseo"
paseo daemon reload --home "$HOME/.paseo"
```

Select **Kiro (OMP)**. ACP setup retains the existing OMP-backed behavior and does not configure account usage. Passession 0.13.18+ discovers built-in usage separately through managed HTTP authentication. Rerun ACP setup to add newly discovered models. `--profile another-id` selects a separate ACP profile.

`PI_CONFIG_DIR` selects an isolated OMP configuration; `--omp-agent-dir` / `PI_CODING_AGENT_DIR` select agent state, not the plugin installation. `PASEO_HOME` can replace `--paseo-home`. Setup preserves the selected OMP environment.

## Kiro commands

Available in OMP, including OMP-backed Passession sessions:

| Command                 | Operation                                                    |
| ----------------------- | ------------------------------------------------------------ |
| `/kiro`                 | Local help and transport information                         |
| `/kiro-status`          | HTTP login status without refreshing; ACP metadata handshake |
| `/kiro-models [filter]` | Live transport-specific model catalog                        |
| `/kiro-model <id>`      | Change the actual session model                              |
| `/kiro-usage`           | Managed HTTP account quota, credits, and reset dates         |
| `/kiro-profiles`        | HTTP only: list profiles and compare their reported quotas   |
| `/kiro-profile <name-or-arn>` | HTTP only: select a profile in the shared managed auth store |
| `/kiro-reset`           | ACP only: close this connection, retaining OMP history       |

These commands do not start model generation. ACP and HTTP can be logged into different accounts; ACP `/kiro-usage` explicitly identifies the separate managed HTTP login. Commands do not log in automatically, purchase credits, enable overage billing, change host tool trust, or delete history. OMP's existing `/model`, `/compact`, and other host commands are not replaced.

## Transport and limitations

### Persistent ACP/MCP

1. Start one isolated Kiro child, ACP session, and token-addressed loopback MCP relay per stable OMP session ID.
2. Send the initial OMP system instructions and conversation as a serialized transcript. Kiro's workspace tools are disabled; ACP filesystem/terminal requests are denied.
3. Return requested tools to OMP while leaving the corresponding MCP requests pending. OMP applies its own policy and executes the tools.
4. Answer those pending MCP requests with the actual matching OMP results, continuing the same Kiro prompt.
5. Send only new messages for subsequent user turns. Changed history, system instructions, tool schemas, model, or cwd causes a clean reset rather than stale context reuse.

Without an OMP session ID, the adapter uses a bounded short-lived session. Active invocations have a ten-minute deadline; inactive sessions expire after fifteen minutes. Shutdown, explicit close, and confirmed aborted assistant completion dispose the relevant connection. A completed model call's signal does not cancel a suspended tool handoff. ACP transcript replay is not identical to native system/user/assistant role reconstruction.

### Direct HTTP

Generation uses the current Kiro runtime HTTPS endpoint; model discovery uses the management endpoint. OMP tools become native tool specifications, assistant tool uses, and actual tool results.

Since 0.4.8, system-prompt arrays are joined and prepended once to the first wire user input. Developer instructions retain their role labels and conversation positions instead of being moved ahead of earlier turns. The feature-gated top-level `systemPrompt` field is not sent: it caused HTTP 400 `ValidationException: Improperly formed request` on the live Identity Center account. Instructions are preserved as an explicit text projection, **not upstream-enforced system/developer channels**; host tool permission decisions remain authoritative.

The transport decodes checksum-validated AWS event-stream frames, assembles interleaved tool argument fragments, and forwards text, reported usage, errors, and cancellation. OMP performs approved tool execution; the transport never executes tools, replaces the selected model, or falls back to ACP. Region routing is restricted to the artifact-backed US East and EU Central Kiro endpoint families.

**Retry ownership (0.4.2):** HTTP recovery stays inside the shared transport, including actual OMP generation. Transient failures retry **until caller cancellation**, waiting **30 seconds after each failure** by default. OMP enables the explicit `continuePartial: true` turn option: after published text is interrupted, the transport moves the current input and completed tool results into local wire history once, appends the assistant fragment, and requests only continuation. The continuation retains model, origin, conversation ID, system instructions, workspace context, and tool schema, but never copies old `toolResults` into its current message. Subsequent text appends to the same OMP assistant message; repeated outages do not depend on OMP's bounded host recovery.

The standalone transport supports explicit `onRestart` for consumers that can genuinely replace provisional text; without continuation or restart, failure after published text is terminal. Before new text, retries retain the exact serialized request.

Transient network failures include offline DNS (`ENOTFOUND`, `EAI_AGAIN`), unreachable/refused connections, socket drops, and response-data timeouts. HTTP 408/429/500/502/503/504 and selected framed temporary service errors are retryable. `retry.maxAttempts: null` explicitly means unlimited attempts until abort (the default); a numeric 1–5 retains an explicitly finite policy. `OMP_KIRO_HTTP_MAX_ATTEMPTS` accepts `unlimited` or 1–5. `baseDelayMs`/`maxDelayMs` (environment: `OMP_KIRO_HTTP_RETRY_BASE_MS`/`OMP_KIRO_HTTP_RETRY_MAX_MS`) accept 0–30000; custom policies retain exponential backoff capped at `maxDelayMs`, while both defaults are 30000 for fixed cadence. A longer server `Retry-After` extends the wait instead of causing an early retry or failure, and all waits are abortable. The per-attempt response-data timeout defaults to 45 seconds (`OMP_KIRO_HTTP_IDLE_TIMEOUT_MS`: 1–300000). Catalog/search/usage and command wrappers impose no shorter default total deadline; usage callers may still set an explicit `timeoutMs`.

Cancellation, TLS/certificate/protocol failures, authentication/permission failures, known quota rejection, malformed frames/JSON, and incomplete tool calls are not transient retries. OAuth requests retry only proven DNS/pre-connect failures; refresh additionally retries explicit HTTP 429/503 rejection. A dropped or timed-out single-use exchange/refresh response is never replayed, including by OIDC's outer polling loop. Pending/slow-down and explicit safe device-poll rejections still follow the login protocol; interactive login/device expiry remains enforced. Generation reloads managed credentials if a long outage outlives the access token, but refuses an account/profile/issuer-region change rather than silently switching identity. **A generation request may already have been processed and charged before its response is lost; a retry or continuation can incur another cloud charge.** Retaining a conversation ID does not establish exactly-once upstream inference.

**Compiled Bun CA handling (0.4.4):** every default HTTP client (login/refresh, catalog, generation, usage, and backend search) passes `NODE_EXTRA_CA_CERTS` explicitly through Bun's supported fetch `tls.ca` option. Because explicit `ca` replaces Bun's defaults, the approved bundle is combined with `node:tls`'s builtin Mozilla `rootCertificates`; certificate-chain and hostname validation remain enabled. No Bun installation, global fetch patch, hostname override, or TLS bypass is required. Node and other non-Bun runtimes keep their normal fetch behavior, including Node's startup CA loading; an injected `fetchImpl` remains authoritative.

The Bun bundle must be a readable regular UTF-8 PEM file containing only certificates and whitespace, between 1 byte and 4 MiB. Empty, oversized, unreadable, or malformed bundles fail closed before a network request; diagnostics never include the configured path or PEM contents. Parsing is shared and cached for the current immutable bundle path, including failures. Publish a new hash-named path and restart the host when approved roots change; do not overwrite a cached bundle. Waiting for CA loading honors caller cancellation and cannot start a request after cancellation.

**Clean EOF limitation:** an abrupt stream exception or partial frame is detected, but a clean EOF exactly between valid frames has no authenticated end-of-response marker in this reconstruction. If at least one event arrived and all buffered tools are complete, it can be accepted as completion even when text was cut short. No transparent retry or complete-answer guarantee is claimed for that case.

**Offline startup integration (0.4.3):** a packaged host can set the absolute `OMP_KIRO_MODEL_CATALOG_FILE` path to its real account snapshot written by `models.cmd`. Before registering HTTP models, the async OMP factory reads current managed auth **without refreshing it** and validates that snapshot. The configured snapshot is authoritative: OMP does not register a dynamic discovery callback, so host offline/background refresh cannot erase its account rows or initiate a detached live discovery. Run `models.cmd` and reload/restart the packaged OMP session to refresh registered metadata; `/kiro-models` remains an explicitly requested live query. With no explicit path, OMP retains live discovery. A bad, missing, or wrong-account configured snapshot fails closed and asks you to refresh `models.cmd`, never silently using live discovery or invented models.

The shared `server/model-catalog.mjs` API exports `kiroCatalogAccountId(auth)` and `readKiroModelCatalog(file, { auth })`. The latter returns unchanged raw model rows from a bounded (4 MiB) JSON envelope `{version:1,fetchedAt,accountId,models:[{id,name,contextWindow?,maxTokens?,additionalModelRequestFieldsSchema?}]}`. `accountId` is a SHA-256 binding to managed provider/auth kind, region, client registration, and profile ARN; without an ARN it conservatively binds the refresh token, or access token if no refresh token exists. No token is written to the catalog. Renewal under the same profile preserves the binding; no-profile refresh-token rotation requires a new snapshot. IDs, names, advertised limits, and native capability schemas are preserved; unknown envelope/model-row fields, malformed rows, duplicate IDs, and account mismatches are rejected. An empty account catalog stays empty. Do not invent capability schemas to enable controls the account did not advertise.

Snapshot age is not credential validity: genuine metadata has no synthetic TTL fallback, and expired managed auth can seed offline startup. Generation still loads/refreshes current managed credentials normally, retries only transient failures on the 30-second policy, and retains the account-change guard. The snapshot never supplies HTTP credentials or guarantees quota/model availability. Package login/logout/import must invalidate it and `models.cmd` must bind metadata to the same auth used for discovery. Hosts without a snapshot must keep readiness pending during transient live discovery outages, while retaining process-exit and caller-cancellation cleanup.

### Managed backend web search

In HTTP mode, the OMP extension registers one `web_search` override using the host's extension-tool contract; it does not delegate to OMP's native external search provider. Queries contain 1–200 Unicode characters.

The search client sends authenticated JSON-RPC `tools/call` requests for `web_search` to the selected Kiro runtime's `/mcp`, using the managed bearer login and the profile header. Returned source URLs, snippets, dates, and `maxVerbatimWordLimit` are retained. It does **not** open or fetch those URLs, follow redirects, or fall back to Exa, Brave, or direct website retrieval. This is backend search, **not arbitrary-URL full-page fetch**. The observed remote tool inventory advertised `web_search` only, not `web_fetch`; the plugin does not invent that capability. Account/organization web-tool policy can reject search independently of model catalog access.

The target machine still needs approved Kiro service/proxy/gateway access and any login/refresh access its credentials require. Kiro's service performs the web search; external result websites need not be reachable from the search client. This restriction describes this search implementation, not a network sandbox for other host tools or user-configured MCP servers.

### Shared limits

- **Text only:** images and unsupported content are rejected. Thinking blocks are not forwarded as conversation text.
- **Reasoning output:** effort selection does not add native reasoning-event rendering or signed-reasoning history replay; those output/history behaviors remain unchanged.
- **Usage:** unreported token/cost fields remain numeric defaults, not a claim of free usage. HTTP forwards token counts only when upstream reports them.
- **Planning limits:** ACP supplies no numeric limits, so it uses conservative 128,000-token context and 16,000-token output metadata. HTTP uses the live advertised limits, with conservative defaults for missing fields.
- **Trust:** these are unsandboxed host plugins. ACP launches Kiro; HTTP uses the separate managed credential store. The selected host owns tool permission decisions.

A successful model listing only proves catalog access. Authentication, quota, or service restrictions can still prevent generation. Monthly quota errors are surfaced as errors; reinstalling or logging in again does not restore quota.

## Development and verification

```bash
npm ci --ignore-scripts
npm run check
npm run lint
npm test
```

Historical 0.5 native-plugin tests covered scoped accounts, read-only SQLite, expiry/rejection, precise quota pools, and duplicate purchase projections with controlled HTTP peers. An isolated Linux Passession 0.13.13 smoke verified that former plugin's setup, persisted enablement across reload, Kiro source discovery, and expired-login reporting with byte-identical authentication storage. That executable and its tests are now removed; these observations do not verify the new built-in source or a daemon upgrade.

The Node suite covers child/HTTP handoffs, cancellation/process cleanup, synthetic SQLite credentials, refresh races, event framing, model routing, setup profile preservation/version prerequisites/configuration errors, and Kiro-only search requests that never fetch source URLs. Retry cases include fake-time fixed 30-second cadence beyond the old three-attempt limit, cancellation during sleep, longer Retry-After, repeated committed-text continuation with completed tools retained exactly once, credential refresh/identity checks, and safe single-use auth phases. Synthetic transient fixtures use explicit fast finite policies unless deliberately exercising the unbounded default with fake timers. Tests do not use account prompt quota.

Historical OMP RPC verification exercised command output, 22 live models, and a real session model change without generation. Earlier direct-native provider and external usage-plugin checks do not qualify Passession's built-in usage; those external implementations are no longer shipped here.

Live independent Google/GitHub device initiation and pending polling, plus Builder ID registration/device initiation, succeeded without browser approval. The actual standalone CLI also obtained a live verification link with Kiro absent from its `PATH`, then cancelled cleanly without saving credentials. A controlled CLI-to-OMP smoke exercised approval responses, private persistence, refresh rotation, actual Bun consumption, and logout. Successful new production approval/token issuance and enterprise approval interactions remain unverified; they require user approval and service entitlement. Real inference with an existing managed Identity Center login is verified below.

A live authenticated Kiro `/mcp` smoke completed naturally with ten real search results, preserving source attribution; its tool inventory exposed only `web_search`. That is live search evidence, not successful model generation, arbitrary-page fetch, or complete Windows package qualification.

For 0.4.4, [isolated CI](https://github.com/emotionbug/omp-kiro/actions/runs/40170019535) passed Node 22/24 syntax/type/lint/test/package checks and three real Bun 1.3.11 CA-boundary cases: approved trust, rejection of untrusted chains and mismatched hostnames, malformed/unreadable bundles, and caller cancellation. [Complete Windows package qualification](https://github.com/emotionbug/kiro-cli-internal/actions/runs/40178277860) passed the actual ZIP's account-bound cold startup, compiled OMP Full access writes, two 30-second recoveries without repeated completed tools, Kiro-only search/citations, usage, ConPTY TUI, unauthenticated Chrome shell, owned shutdown, and complete file integrity. Browser authentication interactions and real-provider generation are not inferred from those controlled fixtures. No local user OMP/Paseo process was started or stopped for these checks.

**Real-provider generation verified for 0.4.8:** the installed Windows OMP 18.16.0 executable used `kiro-http/claude-opus-5.5` with `OMP_KIRO_TRANSPORT` absent and `OMP_KIRO_COMMAND` pointing to a nonexistent executable. A custom system-prompt request returned its exact requested marker; the default OMP system prompt and default tool catalog also succeeded. A separate default-system run executed the real `read` tool exactly once on an isolated synthetic file, returned the actual tool result upstream, and produced the exact unpredictable file content as its final answer. No operational daemon restart or existing-session termination was required. This establishes text generation and a real read/result continuation, not every model, tool, instruction-priority guarantee, or account-policy branch. See [protocol findings and evidence boundaries](docs/reverse-engineering.md).

## License

Apache-2.0. This integration originated in the Paseo checkout; the source license notice is retained in [LICENSE](LICENSE).
