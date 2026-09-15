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

The qualification harness is in
[`../foundry-session-qualification`](../foundry-session-qualification). It starts the adapter on an
ephemeral loopback port immediately before the serial run and closes it immediately afterward.
Per-request telemetry records the requested and resolved model IDs, terminal reason, and token
usage without recording prompts or response content. This telemetry is required because an
exact-looking response with SDK terminal reason `length` must still fail closed.
