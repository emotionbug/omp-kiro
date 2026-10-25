# omp-kiro

Use Kiro in [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) or Paseo. OMP gets persistent ACP and direct HTTP model providers; Paseo gets a native HTTP coding agent and account-usage source.

HTTP authentication, model discovery, and generation do not require a Kiro executable. Both hosts share the managed login and HTTP implementation. No generation request falls back to another transport or model.

## Requirements

- **OMP extension:** OMP **18.12.6+**. The host supplies `@oh-my-pi/pi-ai`.
- **Native Paseo plugin:** Paseo **0.13.0+**, Node.js **22.13+**, and npm for installation preparation. Neither OMP nor Kiro CLI is required.
- **Standalone authentication:** Node.js **22.13+**. Bun's SQLite is used inside OMP.
- **ACP only:** an authenticated `kiro-cli` supporting HTTP MCP servers; developed with **Kiro CLI 2.28.0**.
- Available Kiro account quota. This project does not bypass subscription limits.
- Approved outbound HTTPS connectivity to Kiro runtime, management, and login services, directly or through the deployment's approved proxy/gateway and CA configuration. Search needs no direct access to external result websites.

## Install

```bash
kiro-cli login
omp install github:emotionbug/omp-kiro
omp models kiro-cli
omp --model kiro-cli/auto
```

For another model, select one returned by `omp models kiro-cli`, using the full `kiro-cli/<model-id>` selector. No API key or change to OMP's default model is required. Start a new OMP session after installing.

For development or the optional Paseo setup, use a local checkout instead:

```bash
git clone https://github.com/emotionbug/omp-kiro.git
omp install ./omp-kiro
```

OMP links local packages, so keep that checkout in place. GitHub-spec installations do not depend on a local checkout.

To use a non-default Kiro executable:

```bash
OMP_KIRO_COMMAND=/absolute/path/to/kiro-cli omp --model kiro-cli/auto
```

This variable names one executable, not a shell command. Kiro authenticates using its own login. OMP/Paseo must run as the same OS user, with the Kiro executable available on `PATH` or through this variable.

## Choose a transport

The default is `acp`: keep a Kiro process and ACP session for each OMP session, and return real OMP tool results through MCP.

```bash
omp --model kiro-cli/auto
```

Direct HTTP bypasses the CLI for authentication and generation. Sign in with the standalone command first:

```bash
npx github:emotionbug/omp-kiro login --provider google
OMP_KIRO_TRANSPORT=http omp --model kiro-http/auto
```

HTTP is an unofficial, version-dependent protocol. Selecting it does not fall back to ACP on errors and does not bypass account quota. Do not put bearer or refresh tokens in environment variables, OMP configuration, or this repository.

`kiro-cli` and `kiro-http` have separate OMP catalog caches, but their live model ID sets match. Both use the current `KIRO_CLI` origin.

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

## Paseo

### Native HTTP agent

From a checkout, authenticate and install:

```bash
npx github:emotionbug/omp-kiro login --provider google
npm run setup:paseo -- --http --enable-plugins --paseo-home "$HOME/.paseo"
paseo provider models kiro-http --home "$HOME/.paseo"
paseo usage --refresh --home "$HOME/.paseo"
```

`--enable-plugins` explicitly trusts unsandboxed plugin code and enables Paseo's external-plugin switch. That switch also starts other configured, enabled plugins. Omit it when the switch is already enabled. The installer reloads configuration and this plugin, **not the daemon**.

Select **Kiro HTTP** when creating an agent. Paseo model IDs are the live upstream IDs, such as `auto`; the `kiro-http/` prefix belongs to OMP model selectors, not the native Paseo model field. No static model list needs updating.

The agent streams responses and executes workspace read/list/write/edit/shell tools, managed Kiro search, and the MCP servers Paseo injects. **New native sessions default to Full access:** workspace changes/deletions, commands, and injected MCP tools execute without individual approval dialogs. Initial plugin trust and login still require the normal setup/authorization. An explicitly selected or restored **Ask** mode still requests approval before changes, commands, and MCP calls; **Plan** permits workspace reads and read-only Kiro search. Exact MCP preapproval in Ask does not approve another server/tool or native filesystem commands. These modes are not an OS sandbox.

Native sessions persist owner-private history under `$XDG_STATE_HOME/omp-kiro/paseo`, defaulting to `~/.local/state/omp-kiro/paseo`. Restore replays stable message/tool IDs and command rows. Images, file attachments, steering, and OMP-specific compaction/subagent machinery are not implemented by the native provider.

The standard **Usage** panel displays account credits, plan, reset/expiry dates, and on-demand usage. Monthly, trial, bonus, and purchased pools stay separate; duplicate purchase projections are not added twice. Usage fetches never rotate credentials or change billing. If authentication expires, `/kiro-models` can refresh the managed login through metadata access, or sign in again, then refresh usage. Current Paseo exposes plugin usage globally, not through native per-agent usage scopes; account quota is distinct from reported per-turn token usage.

Setup converts the generated v0.3 `Kiro (HTTP)` OMP profile into the native provider, removing `extends: omp`, the OMP command, and its stale model list. Unrelated settings and an existing disabled state are retained. Other custom providers are rejected, not overwritten. Existing OMP-backed `kiro-http` sessions block cutover rather than being misread as native history.

`--auth-file /absolute/path/auth.sqlite3` selects the native provider's store. Global usage follows the plugin process's `OMP_KIRO_AUTH_FILE`/XDG environment; keep those aligned when using a custom store.

For a fresh Git-source installation instead of a linked checkout:

```bash
paseo plugin install git:emotionbug/omp-kiro --home "$HOME/.paseo"
# Only after accepting the unsandboxed-code trust described above:
paseo daemon config set pluginsEnabled true --home "$HOME/.paseo"
```

Update a directory source with `git pull --ff-only` in its checkout, then `paseo plugin reload omp-kiro`. Git-managed sources use `paseo plugin update omp-kiro`. Removal uses `paseo plugin remove omp-kiro`; removing a directory source does not delete its checkout or HTTP login.

### OMP-backed ACP profile

```bash
npm run setup:paseo -- --paseo-home "$HOME/.paseo"
paseo daemon reload --home "$HOME/.paseo"
```

Select **Kiro (OMP)**. This profile extends `omp`; OMP owns tools, approvals, subagents, and history. Rerun ACP setup to add newly discovered models to that profile. `--profile another-id` selects a separate ACP profile; `--omp-command /absolute/path/omp` selects its executable.

`PI_CONFIG_DIR` selects an isolated OMP configuration; `--omp-agent-dir` / `PI_CODING_AGENT_DIR` select agent state, not the plugin installation. `PASEO_HOME` can replace `--paseo-home`. Setup preserves the selected ACP environment.

## Kiro commands

Available in OMP and the native Paseo composer:

| Command                 | Operation                                                    |
| ----------------------- | ------------------------------------------------------------ |
| `/kiro`                 | Local help and transport information                         |
| `/kiro-status`          | HTTP login status without refreshing; ACP metadata handshake |
| `/kiro-models [filter]` | Live transport-specific model catalog                        |
| `/kiro-model <id>`      | Change the actual session model                              |
| `/kiro-usage`           | Managed HTTP account quota, credits, and reset dates         |
| `/kiro-reset`           | OMP/ACP only: close this connection, retaining OMP history   |

These commands do not start model generation. ACP and HTTP can be logged into different accounts; ACP `/kiro-usage` explicitly identifies the separate managed HTTP login. Commands do not log in automatically, purchase credits, enable overage billing, change native tool trust, or delete history. OMP's existing `/model`, `/compact`, and other host commands are not replaced.

## Transport and limitations

### Persistent ACP/MCP

1. Start one isolated Kiro child, ACP session, and token-addressed loopback MCP relay per stable OMP session ID.
2. Send the initial OMP system instructions and conversation as a serialized transcript. Kiro's workspace tools are disabled; ACP filesystem/terminal requests are denied.
3. Return requested tools to OMP while leaving the corresponding MCP requests pending. OMP applies its own policy and executes the tools.
4. Answer those pending MCP requests with the actual matching OMP results, continuing the same Kiro prompt.
5. Send only new messages for subsequent user turns. Changed history, system instructions, tool schemas, model, or cwd causes a clean reset rather than stale context reuse.

Without an OMP session ID, the adapter uses a bounded short-lived session. Active invocations have a ten-minute deadline; inactive sessions expire after fifteen minutes. Shutdown, explicit close, and confirmed aborted assistant completion dispose the relevant connection. A completed model call's signal does not cancel a suspended tool handoff. ACP transcript replay is not identical to native system/user/assistant role reconstruction.

### Direct HTTP

Generation uses the current Kiro runtime HTTPS endpoint; model discovery uses the management endpoint. OMP tools become native tool specifications, assistant tool uses, and actual tool results. OMP system-prompt arrays become a native system string; developer instructions are included there with role labels and original message positions because upstream has no separate developer-history variant.

The transport decodes checksum-validated AWS event-stream frames, assembles interleaved tool argument fragments, and forwards text, reported usage, errors, and cancellation. OMP or the native Paseo provider performs approved tool execution; the transport never executes tools, replaces the selected model, or falls back to ACP. Region routing is restricted to the artifact-backed US East and EU Central Kiro endpoint families.

**Retry ownership (0.4.2):** HTTP recovery stays inside the shared transport, including actual OMP generation. Transient failures retry **until caller cancellation**, waiting **30 seconds after each failure** by default. OMP enables the explicit `continuePartial: true` turn option: after published text is interrupted, the transport moves the current input and completed tool results into local wire history once, appends the assistant fragment, and requests only continuation. The continuation retains model, origin, conversation ID, system instructions, workspace context, and tool schema, but never copies old `toolResults` into its current message. Subsequent text appends to the same OMP assistant message; repeated outages do not depend on OMP's bounded host recovery.

Native Paseo keeps its explicit `onRestart(info)` provisional-text replacement mode. Both modes discard tools buffered by a failed response. Tools become executable only after the entire response decodes and validates; completed host tools and whole multi-tool turns are never replayed. Without explicit continuation or restart, a failure after published text is terminal. Before any new text, retries preserve the exact serialized request body. Retry notifications are separate native timeline notifications or optional `onRetry(info)` callbacks, never model-answer text; their metadata contains only attempt count, limit, and delay, not credentials or upstream errors.

Transient network failures include offline DNS (`ENOTFOUND`, `EAI_AGAIN`), unreachable/refused connections, socket drops, and response-data timeouts. HTTP 408/429/500/502/503/504 and selected framed temporary service errors are retryable. `retry.maxAttempts: null` explicitly means unlimited attempts until abort (the default); a numeric 1–5 retains an explicitly finite policy. `OMP_KIRO_HTTP_MAX_ATTEMPTS` accepts `unlimited` or 1–5. `baseDelayMs`/`maxDelayMs` (environment: `OMP_KIRO_HTTP_RETRY_BASE_MS`/`OMP_KIRO_HTTP_RETRY_MAX_MS`) accept 0–30000; custom policies retain exponential backoff capped at `maxDelayMs`, while both defaults are 30000 for fixed cadence. A longer server `Retry-After` extends the wait instead of causing an early retry or failure, and all waits are abortable. The per-attempt response-data timeout defaults to 45 seconds (`OMP_KIRO_HTTP_IDLE_TIMEOUT_MS`: 1–300000). Catalog/search/usage and command wrappers impose no shorter default total deadline; usage callers may still set an explicit `timeoutMs`.

Cancellation, TLS/certificate/protocol failures, authentication/permission failures, known quota rejection, malformed frames/JSON, and incomplete tool calls are not transient retries. OAuth requests retry only proven DNS/pre-connect failures; refresh additionally retries explicit HTTP 429/503 rejection. A dropped or timed-out single-use exchange/refresh response is never replayed, including by OIDC's outer polling loop. Pending/slow-down and explicit safe device-poll rejections still follow the login protocol; interactive login/device expiry remains enforced. Generation reloads managed credentials if a long outage outlives the access token, but refuses an account/profile/issuer-region change rather than silently switching identity. **A generation request may already have been processed and charged before its response is lost; a retry or continuation can incur another cloud charge.** Retaining a conversation ID does not establish exactly-once upstream inference.

**Compiled Bun CA handling (0.4.4):** every default HTTP client (login/refresh, catalog, generation, usage, and backend search) passes `NODE_EXTRA_CA_CERTS` explicitly through Bun's supported fetch `tls.ca` option. Because explicit `ca` replaces Bun's defaults, the approved bundle is combined with `node:tls`'s builtin Mozilla `rootCertificates`; certificate-chain and hostname validation remain enabled. No Bun installation, global fetch patch, hostname override, or TLS bypass is required. Node and other non-Bun runtimes keep their normal fetch behavior, including Node's startup CA loading; an injected `fetchImpl` remains authoritative.

The Bun bundle must be a readable regular UTF-8 PEM file containing only certificates and whitespace, between 1 byte and 4 MiB. Empty, oversized, unreadable, or malformed bundles fail closed before a network request; diagnostics never include the configured path or PEM contents. Parsing is shared and cached for the current immutable bundle path, including failures. Publish a new hash-named path and restart the host when approved roots change; do not overwrite a cached bundle. Waiting for CA loading honors caller cancellation and cannot start a request after cancellation.

**Clean EOF limitation:** an abrupt stream exception or partial frame is detected, but a clean EOF exactly between valid frames has no authenticated end-of-response marker in this reconstruction. If at least one event arrived and all buffered tools are complete, it can be accepted as completion even when text was cut short. No transparent retry or complete-answer guarantee is claimed for that case.

**Offline startup integration (0.4.3):** a packaged host can set the absolute `OMP_KIRO_MODEL_CATALOG_FILE` path to its real account snapshot written by `models.cmd`. Before registering HTTP models, the async OMP factory reads current managed auth **without refreshing it** and validates that snapshot. Native Paseo uses the same snapshot for its initial catalog and exact model validation. The configured snapshot is authoritative: OMP does not register a dynamic discovery callback, so host offline/background refresh cannot erase its account rows or initiate a detached live discovery. Run `models.cmd` and reload/restart the packaged session to refresh registered metadata; `/kiro-models` remains an explicitly requested live query. With no explicit path, both integrations retain live discovery. A bad, missing, or wrong-account configured snapshot fails closed and asks you to refresh `models.cmd`, never silently using live discovery or invented models.

The shared `server/model-catalog.mjs` API exports `kiroCatalogAccountId(auth)` and `readKiroModelCatalog(file, { auth })`. The latter returns unchanged raw model rows from a bounded (4 MiB) JSON envelope `{version:1,fetchedAt,accountId,models:[{id,name,contextWindow?,maxTokens?}]}`. `accountId` is a SHA-256 binding to managed provider/auth kind, region, client registration, and profile ARN; without an ARN it conservatively binds the refresh token, or access token if no refresh token exists. No token is written to the catalog. Renewal under the same profile preserves the binding; no-profile refresh-token rotation requires a new snapshot. IDs, names, and advertised limits are preserved; unknown fields, malformed rows, duplicate IDs, and account mismatches are rejected. An empty account catalog stays empty.

Snapshot age is not credential validity: genuine metadata has no synthetic TTL fallback, and expired managed auth can seed offline startup. Generation still loads/refreshes current managed credentials normally, retries only transient failures on the 30-second policy, and retains the account-change guard. The snapshot never supplies HTTP credentials or guarantees quota/model availability. Package login/logout/import must invalidate it and `models.cmd` must bind metadata to the same auth used for discovery. Hosts without a snapshot must keep readiness pending during transient live discovery outages, while retaining process-exit and caller-cancellation cleanup.

### Managed backend web search

In HTTP mode, the OMP extension registers one `web_search` override using the host's extension-tool contract; it does not delegate to OMP's native external search provider. The native Paseo provider exposes the same read-only search, including Plan mode. Queries contain 1–200 Unicode characters.

The search client sends authenticated JSON-RPC `tools/call` requests for `web_search` to the selected Kiro runtime's `/mcp`, using the managed bearer login and the profile header. Returned source URLs, snippets, dates, and `maxVerbatimWordLimit` are retained. It does **not** open or fetch those URLs, follow redirects, or fall back to Exa, Brave, or direct website retrieval. This is backend search, **not arbitrary-URL full-page fetch**. The observed remote tool inventory advertised `web_search` only, not `web_fetch`; the plugin does not invent that capability. Account/organization web-tool policy can reject search independently of model catalog access.

The target machine still needs approved Kiro service/proxy/gateway access and any login/refresh access its credentials require. Kiro's service performs the web search; external result websites need not be reachable from the search client. This restriction describes this search implementation, not a network sandbox for other host tools or user-configured MCP servers.

### Shared limits

- **Text only:** images and unsupported content are rejected. Thinking blocks are not forwarded as conversation text.
- **Usage:** unreported token/cost fields remain numeric defaults, not a claim of free usage. HTTP forwards token counts only when upstream reports them.
- **Planning limits:** ACP supplies no numeric limits, so it uses conservative 128,000-token context and 16,000-token output metadata. HTTP uses the live advertised limits, with conservative defaults for missing fields.
- **Trust:** these are unsandboxed host plugins. ACP launches Kiro; HTTP uses the separate managed credential store. The selected host owns tool permission decisions.

A successful model listing only proves catalog access. Authentication, quota, or service restrictions can still prevent generation. Monthly quota errors are surfaced as errors; reinstalling or logging in again does not restore quota.

## Development and verification

```bash
npm ci --ignore-scripts
npm run check
npm run typecheck
npm run lint
npm test
```

The Node suite covers child/HTTP handoffs, native workspace and real HTTP/stdio MCP effects, default automatic writes/commands and explicit Ask/Plan boundaries, restoration, cancellation/process cleanup, synthetic SQLite credentials, refresh races, event framing, model routing, and Kiro-only search requests that never fetch source URLs. Retry cases include fake-time fixed 30-second cadence beyond the old three-attempt limit, cancellation during sleep, longer Retry-After, repeated committed-text continuation with completed tools retained exactly once, credential refresh/identity checks, and safe single-use auth phases. Synthetic transient fixtures use explicit fast finite policies unless deliberately exercising the unbounded default with fake timers. Tests do not use account prompt quota.

Actual OMP RPC verified command output, 22 live models, and a real session model change without generation. An isolated Paseo daemon loaded the directory plugin and exercised a controlled HTTP write/tool-result loop, denied writes, approved injected MCP, and restoration with identical provider items and all query user rows. The rendered usage surface uses the standard Paseo panel. Main-daemon native catalog and account usage were also checked without restarting it.

Live independent Google/GitHub device initiation and pending polling, plus Builder ID registration/device initiation, succeeded without browser approval. The actual standalone CLI also obtained a live verification link with Kiro absent from its `PATH`, then cancelled cleanly without saving credentials. A controlled CLI-to-OMP smoke exercised approval responses, private persistence, refresh rotation, actual Bun consumption, and logout. Successful new production approval/token issuance, enterprise approval, and inference using newly issued credentials remain unverified; they require user approval and service entitlement.

A live authenticated Kiro `/mcp` smoke completed naturally with ten real search results, preserving source attribution; its tool inventory exposed only `web_search`. That is live search evidence, not successful model generation, arbitrary-page fetch, or complete Windows package qualification.

For 0.4.4, [isolated CI](https://github.com/emotionbug/omp-kiro/actions/runs/40170019535) passed Node 22/24 syntax/type/lint/test/package checks and three real Bun 1.3.11 CA-boundary cases: approved trust, rejection of untrusted chains and mismatched hostnames, malformed/unreadable bundles, and caller cancellation. [Complete Windows package qualification](https://github.com/emotionbug/kiro-cli-internal/actions/runs/40178277860) passed the actual ZIP's account-bound cold startup, compiled OMP Full access writes, two 30-second recoveries without repeated completed tools, Kiro-only search/citations, usage, ConPTY TUI, unauthenticated Chrome shell, owned shutdown, and complete file integrity. Browser authentication interactions and real-provider generation are not inferred from those controlled fixtures. No local user OMP/Paseo process was started or stopped for these checks.

**Real-provider generation remains unverified** because the account's monthly quota is known exhausted; it was not retried. The new generation payload's `systemPrompt` field/type is artifact-supported reconstruction, not captured live request acceptance. See [REA findings and evidence boundaries](docs/reverse-engineering.md).

## License

Apache-2.0. This integration originated in the Paseo checkout; the source license notice is retained in [LICENSE](LICENSE).
