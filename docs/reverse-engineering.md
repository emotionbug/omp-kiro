# Kiro 2.28.0 transport analysis

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
| Generation     | `https://runtime.us-east-1.kiro.dev/`                       | `AmazonCodeWhispererStreamingService.GenerateAssistantResponse`, native user origin `KIRO_CLI` |
| Social refresh | `https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken` | JSON refresh request                                                                           |

The artifact also contains EU Central management/runtime counterparts. That region is statically supported, not runtime exercised here. Other profile regions fail explicitly.

Key evidence:

- Current management target/origin: `ev_1f530371ada582fa6c197676af8ac351418b4a7ba43ae38e34c14f9368af40e1`.
- Current endpoint families: `ev_33000c28378bf8039eba78919eec6bdccc97bf2b947d73ee3018cd44745ccd7d`.
- Current runtime plus unchanged generation target/header markers: `ev_096b23345c503b53b3ecdac6136ad8c178abb4841718e0ecc3c2fc9bc18327d9`.
- Correct authenticated management request, HTTP 200, 22 models and token limits: `ev_6afec8dbc15e3ab3eb5e07d5395a12be54653d339b0694f873fccc5ec366ec16`.
- Independent comparison of the actual exported ACP and HTTP implementations: `ev_028b099c76f813cbb73de386e256c9bb50da5c2d690f08ea025d9b8a7bb33451`; `acpCount=22`, `httpCount=22`, identical sorted IDs, both set differences empty, exit 0.

The capture's executable digest binds the caller's Node harness, and process trees are sampled. Network packets were not captured; authenticated request/status/schema observations came from the explicit harness. These limitations do not imply generation was exercised.

## Authentication

REA observed the Linux SQLite `auth_kv(key,value)` schema and the social-token record's field names without emitting values. Only the local Google social-login mode was observed and implemented. Other login providers, Builder ID, enterprise/OIDC, and non-Linux keychain storage are rejected rather than guessed.

- Schema: `ev_b5150013c85f00f6d05176da76be6b079927bff62e222a2e6b5a8ae3538b1809`.
- Token field names/provider/region only: `ev_dd9d1e9bd5d421bce92556ddfda6c7d6a5ed8bf90413be23688beccbdbd2bef5`.
- Normal successful refresh: `ev_7df5062c6a3e65de90711e61c9d4035047dda8bb073871a07b393746fe04bff8`.

Refresh returned HTTP 200 with `accessToken`, numeric `expiresIn`, `profileArn`, and `refreshToken`. The probe emitted schema/type predicates only. Rotated credentials were persisted using compare-and-swap against the original raw record; unrelated record fields were preserved. No generation occurred.

## Generation reconstruction and its limits

The direct transport maps native conversation history, tool specifications, assistant tool uses, and actual tool results. It decodes AWS event-stream prelude/header/payload framing with both CRCs. System-prompt arrays normalize to a string. Developer instructions are labeled in that native instruction channel; this is not a claim that upstream has a distinct developer-history role.

Current artifact `system_prompt`/`systemPrompt` observations support the new top-level field. Its precise serialization and server acceptance remain **artifact-supported inference**, not decompiled or captured generation-request evidence. Current generation endpoint/body acceptance, successful inference, and real generated event sequences were not exercised because the account's monthly quota is exhausted. No generation request was made to re-confirm that error.

The older public generated AWS SDK supplements native conversation/tool/event framing, not current endpoint/origin selection:

- [Generation operation](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-streaming-client/src/operation/generate_assistant_response.rs)
- [Conversation serialization](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-streaming-client/src/protocol_serde/shape_conversation_state.rs)
- [User context/tool serialization](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-streaming-client/src/protocol_serde/shape_user_input_message_context.rs)
- [Event stream serialization](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-streaming-client/src/event_stream_serde.rs)

Controlled HTTP fixtures, synthetic SQLite credentials, and the actual Bun-hosted OMP plugin exercised native payload mapping, fragmented framed responses, actual OMP file writes, returning real tool results, follow-up output, and usage handling. This validates adapter integration, not the unexercised production generation boundary.
