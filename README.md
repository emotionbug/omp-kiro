# omp-kiro

Use your Kiro CLI login as an [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) model provider. OMP owns the conversation, tool execution, approvals, and subagents; Kiro supplies model output through ACP.

This is an OMP extension package (`package.json#omp.extensions`), not a replacement agent or a proxy to an unofficial Kiro API. It works without Paseo. The optional Paseo setup adds a **Kiro (OMP)** provider profile.

## Requirements

- OMP **18.12.6+**.
- Node.js **22+**.
- An authenticated `kiro-cli` supporting ACP HTTP MCP servers; developed with **Kiro CLI 2.28.0**.
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

A conflicting profile is rejected instead of overwritten. Use `--profile another-id` for a separate profile. An existing disabled profile stays disabled. Rerun setup to add newly discovered Kiro models to Paseo.

For isolated configuration:

```bash
PI_CONFIG_DIR=.omp-kiro-test node setup.mjs --paseo-home /tmp/paseo-kiro
PI_CONFIG_DIR=.omp-kiro-test omp --model kiro-cli/auto
```

`PI_CONFIG_DIR` selects a separate OMP configuration directory under your home, including its plugins. `--omp-agent-dir` / `PI_CODING_AGENT_DIR` select agent state only, not a separate plugin installation. `PASEO_HOME` can replace `--paseo-home`. Unset named-profile variables (`OMP_PROFILE` / `PI_PROFILE`) when using the isolation example. Setup preserves the selected OMP configuration environment in the Paseo profile. `--omp-command /absolute/path/to/omp` selects a custom OMP executable.

## Transport and limitations

1. Each OMP model invocation starts an isolated Kiro ACP session and sends the serialized OMP system prompt and conversation.
2. OMP tools are exposed through a token-addressed loopback HTTP MCP relay. Kiro's workspace tools are disabled, and ACP filesystem/terminal requests are denied.
3. The relay captures the first tool call without executing it or inventing a tool result. Kiro is stopped, and OMP receives a native tool-call event.
4. OMP applies its own tool policy and executes the tool. The next invocation forwards the actual result.

- **Text only:** images and unsupported content are rejected. Thinking blocks are not forwarded as conversation text.
- **Fresh Kiro session per step:** startup and full-transcript overhead apply to each tool iteration; calls are handed back one at a time.
- **Usage accounting is unknown:** zero token/cost fields do not mean free requests. Kiro's quota remains authoritative.
- **Planning limits:** ACP does not supply numeric model limits. OMP receives conservative 128,000-token context and 16,000-token output metadata. Kiro controls generation and thinking internally.
- **Cancellation:** aborts terminate the child, escalate to SIGKILL when necessary, and close the relay and temporary directory. An invocation has a ten-minute deadline.
- **Trust:** this is an unsandboxed OMP extension. It launches your local Kiro executable and forwards the supplied conversation to it. Tool permission decisions stay with OMP; the bridge is not an OS sandbox for Kiro.

A successful model listing only proves catalog access. Authentication, quota, or service restrictions can still prevent generation. Monthly quota errors are surfaced as errors; reinstalling or logging in again does not restore quota.

## Development and verification

```bash
npm ci --ignore-scripts
npm run check
npm run lint
npm test
```

The dependency-free Node test suite exercises actual child processes and localhost HTTP with a controlled ACP peer. It covers transcript identity, real tool-call capture, permission denial, cancellation, failed startup, EOF, and errors. Tests do not use Kiro prompt quota.

The initial integration was also smoke-tested through real OMP and Paseo's OMP runtime: model selection, OMP file writes, forwarding tool results, error propagation, and cancellation. Those generation scenarios used a controlled ACP peer. Live Kiro model discovery succeeded; real Kiro generation was not verified because the account had exhausted its monthly quota.

## License

Apache-2.0. This integration originated in the Paseo checkout; the source license notice is retained in [LICENSE](LICENSE).
