# Foundry Local Session API adapter experiment

This experiment tests a shim-free path for Sealed Delegation by translating the OpenAI-compatible
requests emitted by Copilot CLI into Foundry Local 2.0.1 typed `ChatSession` requests.

It is **unqualified research**. The existing `foundry-qwen25-7b-qualified` route still uses Foundry
Local CLI 0.10.3 plus `tools/foundry-stream-shim.mjs`.

## Why this exists

Foundry Local issue #874 still affects the CLI's OpenAI-compatible REST streaming path. The 2.0.1
Session API returns typed `toolCall` items directly, so this adapter can emit clean OpenAI
`delta.tool_calls` without parsing model-authored `<tool_call>` markup.

## Setup

Install dependencies:

```powershell
$env:FOUNDRY_LOCAL_SKIP_INSTALL = "1"
npm install
```

`foundry-local-sdk` normally downloads its native dependencies from NuGet. If that is unavailable,
download the official `foundry-local-win-x64.zip` v2.0.1 release and set:

```powershell
$env:FOUNDRY_LIBRARY_PATH = "C:\path\to\foundry-local-win-x64\lib"
$env:FOUNDRY_MODEL_CACHE = (foundry cache location -o json | ConvertFrom-Json).path
```

## Run

```powershell
$env:FOUNDRY_ADAPTER_PORT = "53381"
npm run serve
```

The adapter binds to loopback only and prints its `/v1` base URL when ready.

Run the staged-file canary without the legacy stream shim:

```powershell
pwsh ..\local-agent-preflight.ps1 `
  -BaseUrl http://127.0.0.1:53381/v1 `
  -RuntimeId foundry-local-session `
  -Model qwen2.5-7b-instruct-generic-gpu `
  -Stream on `
  -AllowUnqualifiedRoute
```

Do not add this route to `approved-routes.json` until it passes repeated canaries, the frozen
evidence-check gate, failure-path tests, and a threat-model review.

## Experimental persistent sessions (issue #10)

**Status: unqualified prototype. Not promotable. Off by default.**

By default — and in every qualified path — the adapter still builds one `ChatSession` per request.
Issue #10 measured a 66.49% total wall-time reduction on a three-turn Qwen2.5 7B workflow when one
`ChatSession` was retained across turns, so this mode exists to test whether that benefit can be
taken safely. It changes nothing unless it is switched on explicitly.

### Enabling

```powershell
$env:FOUNDRY_ADAPTER_PERSISTENT_SESSIONS = "1"   # required; anything else keeps the default mode
$env:FOUNDRY_ADAPTER_CONTEXT_LIMIT_TOKENS = "32768"
$env:FOUNDRY_ADAPTER_RESERVED_CONTEXT_TOKENS = "512"
$env:FOUNDRY_ADAPTER_CHARACTERS_PER_TOKEN = "3"
npm run serve
```

`startAdapter` and `startAdapterServer` also accept an explicit `persistence` option, which is what
the tests use. The `READY` line reports `persistentSessions`.

### Request contract

| Header | Meaning |
|---|---|
| `x-sealed-conversation-id` | Child/conversation identity. Required for every task request in persistent mode. `[A-Za-z0-9._:-]{1,128}` |
| `x-sealed-request-purpose` | `task` (default) or `health`. A `health` request always runs on an ephemeral session and never touches retained state |
| `x-sealed-usage-trust` | Response header. `untrusted-cumulative` on persistent turns |

`POST /v1/sessions/release` with `x-sealed-conversation-id` disposes one retained session. The
endpoint exists only in persistent mode and inherits the adapter's loopback-only bind. A release
retires the identity immediately: any turn still queued for it is rejected with `409
session_unusable`, the underlying session is disposed once the in-flight turn finishes, and a later
request reusing the same id starts a new session from an empty history.

### Fail-closed rules

- **Missing identity.** A task request without `x-sealed-conversation-id` is rejected with `400
  missing_conversation_id`; no session is created.
- **Replay prefix.** OpenAI-compatible clients resend the whole conversation while `ChatSession`
  already retains it. The adapter keeps the last accepted normalized sequence plus its own answer,
  requires the next request to repeat it exactly, and submits only the delta. Divergence, truncation
  and empty deltas are rejected with `409 replay_prefix_mismatch` / `409 empty_replay_delta`. History
  is never silently reset, because retained SDK history cannot be rewound.
- **Tool definitions and scope.** Definitions live in the session, so each name is registered once.
  A changed definition is rejected with `409 tool_definition_conflict`. Removing a previously
  registered tool or narrowing a later turn to a subset is rejected with `409
  tool_scope_narrowing_unsupported`, because the SDK session would otherwise retain the omitted
  tools. Newly named non-conflicting tools are still accepted.
- **Output ceilings.** SDK 2.0.1 treated `maxOutputTokens` on a retained session as an absolute
  session-position ceiling: a static value that worked on turn one produced immediate `length`
  terminals later. `nextPersistentOutputCeiling` in `persistent-session.mjs` raises each later turn's
  ceiling above the cumulative position plus an over-estimated prompt delta, and fails with `409
  output_ceiling_exhausted` before inference when no safe headroom remains. The first persistent turn
  and the whole default mode keep ordinary per-request output semantics.
- **Serialization.** One session per identity, and turns within an identity run one at a time.
- **Poisoned sessions.** If a turn fails after submission, the retained session is retired and every
  later request for that identity is rejected with `409 session_unusable`.

### Untrusted telemetry

Later-turn `completionTokens` on a retained session looked cumulative rather than newly generated.
Persistent turns therefore carry `usage_trust: untrusted-cumulative` in provider receipts and the
`x-sealed-usage-trust` response header, and must not be used for cost accounting until SDK semantics
are documented or corrected. Receipts record conversation id, request purpose, session mode, turn
number and the computed ceiling — never prompt or response content.

### Threat boundary

- The adapter still binds loopback only, and the release endpoint adds no new reachability.
- Conversation identity is **caller-asserted**, not authenticated. Any process that can reach the
  loopback port can name any conversation id, so persistence is only as isolated as the port. Do not
  run this mode with more than one mutually distrusting caller on the host.
- Cross-identity isolation is enforced by one session per id plus prefix validation, and is covered
  by tests; it is not a substitute for authentication.
- Retained sessions hold accepted-state content in the SDK process for the lifetime of the
  conversation, which widens the blast radius of a compromised adapter compared to the default mode.
- Health probes are separated by an explicit caller-supplied purpose header. A caller that omits it
  is treated as a task request and fails closed on identity, but a caller that mislabels a task as
  `health` loses persistence for that turn — the header is a contract, not a defence.

### Prototype limitations (deferred)

- No idle timeout, cancellation hook, or per-identity quota: sessions live until an explicit release
  or adapter close.
- The launcher in `.github/skills/local-agent-delegation` is unchanged, so it does not yet send the
  conversation or purpose headers; this mode is driven manually for now.
- Prefix matching compares the adapter's own emitted assistant message with the client's replay of
  it. A client that rewrites, truncates, or summarizes history fails closed rather than recovering.
- Token accounting for persistent turns remains unreconciled, so the qualification harness must keep
  using the default one-session-per-request mode.

Tests use fake sessions and never require a live Foundry runtime:

```powershell
npm test
```

The qualification harness is in
[`../foundry-session-qualification`](../foundry-session-qualification). It starts the adapter on an
ephemeral loopback port immediately before the serial run and closes it immediately afterward.
Per-request telemetry records the requested and resolved model IDs, terminal reason, and token
usage without recording prompts or response content. This telemetry is required because an
exact-looking response with SDK terminal reason `length` must still fail closed.
