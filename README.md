# omp-kiro

Use your Kiro CLI login as an [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) model provider. OMP owns tool execution, approvals, and subagents.

This is an OMP extension package (`package.json#omp.extensions`). It offers a persistent ACP/MCP transport and an explicit opt-in direct HTTP transport. It works without Paseo; the optional setup adds a Paseo provider profile.

## Requirements

- OMP **18.12.6+**.
- Node.js **22.13+** (the OMP host supplies Bun's SQLite implementation at runtime).
- **ACP only:** an authenticated `kiro-cli` supporting HTTP MCP servers; developed with **Kiro CLI 2.28.0**. HTTP authentication and generation do not require the Kiro executable.
- Available Kiro account quota. This project does not bypass subscription limits.

The host OMP installation supplies `@oh-my-pi/pi-ai`; no npm dependency installation or build is needed for a local checkout.

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

## Paseo (optional)

Run from the plugin checkout:

```bash
npm run setup:paseo -- --paseo-home "$HOME/.paseo"
paseo daemon reload --home "$HOME/.paseo"
```

Select **Kiro (OMP)** and a discovered model when creating an agent. Setup installs the OMP plugin and merges `agents.providers.kiro-omp`, extending `omp`. It preserves unrelated configuration and existing model defaults. It does not restart the daemon or send a model prompt.

To expose direct HTTP as a separate Paseo profile:

```bash
OMP_KIRO_TRANSPORT=http npm run setup:paseo -- \
  --paseo-home "$HOME/.paseo" --profile kiro-http
paseo daemon reload --home "$HOME/.paseo"
```

Select **Kiro (HTTP)** with a `kiro-http/...` model. Complete standalone login before setup. Setup stores transport and optional `OMP_KIRO_AUTH_FILE`, never credentials, in the profile environment.

A conflicting profile is rejected instead of overwritten. Use `--profile another-id` for a separate profile. An existing disabled profile stays disabled. Rerun setup to add newly discovered Kiro models to Paseo.

For isolated configuration:

```bash
PI_CONFIG_DIR=.omp-kiro-test node setup.mjs --paseo-home /tmp/paseo-kiro
PI_CONFIG_DIR=.omp-kiro-test omp --model kiro-cli/auto
```

`PI_CONFIG_DIR` selects a separate OMP configuration directory under your home, including its plugins. `--omp-agent-dir` / `PI_CODING_AGENT_DIR` select agent state only, not a separate plugin installation. `PASEO_HOME` can replace `--paseo-home`. Unset named-profile variables (`OMP_PROFILE` / `PI_PROFILE`) when using the isolation example. Setup preserves the selected OMP configuration environment in the Paseo profile. `--omp-command /absolute/path/to/omp` selects a custom OMP executable.

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

The adapter decodes checksum-validated AWS event-stream frames, assembles interleaved tool argument fragments, and forwards text, reported usage, errors, and cancellation to OMP. It does not run tools, retry generation, replace models, or fall back to ACP. Region routing is restricted to the artifact-backed US East and EU Central Kiro endpoint families.

### Shared limits

- **Text only:** images and unsupported content are rejected. Thinking blocks are not forwarded as conversation text.
- **Usage:** unreported token/cost fields remain numeric defaults, not a claim of free usage. HTTP forwards token counts only when upstream reports them.
- **Planning limits:** ACP supplies no numeric limits, so it uses conservative 128,000-token context and 16,000-token output metadata. HTTP uses the live advertised limits, with conservative defaults for missing fields.
- **Trust:** this is an unsandboxed OMP extension. ACP launches Kiro; HTTP uses the separate managed credential store. OMP owns tool permission decisions; the bridge is not an OS sandbox.

A successful model listing only proves catalog access. Authentication, quota, or service restrictions can still prevent generation. Monthly quota errors are surfaced as errors; reinstalling or logging in again does not restore quota.

## Development and verification

```bash
npm ci --ignore-scripts
npm run check
npm run lint
npm test
```

The Node suite covers actual child/HTTP handoffs, persistence and resets, cancellation/cleanup, synthetic SQLite credentials and refresh races, native role/tool mapping, framing checks, interleaved calls, and model routing/pagination. Tests do not use account prompt quota.

Actual OMP/Paseo runtime smokes exercised both transports with controlled ACP/HTTP peers, including real OMP file writes and forwarding actual tool results. The persistent smoke used one child across a tool handoff and a later user turn; only two ACP prompts were sent (8,903 and 207 characters in that fixture). Live authentication refresh and both model catalogs were verified; the two catalogs returned exactly the same 22 IDs.

Live independent Google/GitHub device initiation and pending polling, plus Builder ID registration/device initiation, succeeded without browser approval. The actual standalone CLI also obtained a live verification link with Kiro absent from its `PATH`, then cancelled cleanly without saving credentials. A controlled CLI-to-OMP smoke exercised approval responses, private persistence, refresh rotation, actual Bun consumption, and logout. Successful new production approval/token issuance, enterprise approval, and inference using newly issued credentials remain unverified; they require user approval and service entitlement.

**Real-provider generation remains unverified** because the account's monthly quota is known exhausted; it was not retried. The new generation payload's `systemPrompt` field/type is artifact-supported reconstruction, not captured live request acceptance. See [REA findings and evidence boundaries](docs/reverse-engineering.md).

## License

Apache-2.0. This integration originated in the Paseo checkout; the source license notice is retained in [LICENSE](LICENSE).
