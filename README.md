frontier-guided delegation to a local model

<p align="center">
  <img src="assets/sealed-delegation.svg" width="112" alt="Sealed Delegation — a sealed task packet" />
</p>

# Sealed Delegation

**Keep frontier judgment at the boundary. Send bounded, verifiable work home.**

Sealed Delegation lets a frontier GitHub Copilot CLI session launch a second Copilot CLI process
whose model runs locally. The frontier session chooses the task, seals the approved inputs, and
keeps authority. The local child prepares a proposal. An independent gate decides whether that
proposal is kept, edited, rejected, or escalated.

The installable skill remains named **`local-agent-delegation`**.

This is not autonomous local development and it is not a savings claim.

## Why "sealed"?

A delegated task should be a sealed packet:

- one bounded outcome;
- explicit input files;
- recorded hashes;
- a minimal tool surface;
- a known acceptance test;
- no authority hidden inside the handoff.

The local model can work inside the packet. The frontier partner decides what leaves it.

## Architecture

```text
frontier Copilot CLI
  -> seals one bounded task and approved input files
  -> launcher hashes inputs into an isolated workspace
  -> local Copilot CLI child uses a minimal tool allowlist
  -> child returns output plus receipts
  -> deterministic/frontier gate accepts, edits, rejects, or escalates
```

## What's here

| Path | Purpose |
|---|---|
| `.github/skills/local-agent-delegation/` | Installable skill and isolated launcher |
| `tools/local-agent-preflight.ps1` | End-to-end staged-file canary |
| `tools/foundry-stream-shim.mjs` | Temporary repair for Foundry Local #874 |
| `examples/evidence-check/` | Synthetic sealed task, gate, and optional agentic variant |
| `run-checks.ps1` | Static checks and optional live validation |
| `QUALIFICATION.md` | Exact measured boundary and known limits |
| `docs/TUTORIAL.md` | Step-by-step setup and manual authority boundaries |
| `docs/WORKSHOP-INTEGRATION.md` | Current manual local desk path and Cairn integration contract |
| `THREAT-MODEL.md` | Assets, boundaries, threats, controls, residual risks |
| `SECURITY.md` | Boundary summary and vulnerability reporting |

## Requirements

- Windows with PowerShell 7
- Node.js 20 or newer
- GitHub Copilot CLI 1.0.79 (qualified); any other version requires a successful preflight
- Foundry Local CLI 0.10.3
- a cached tool-capable local model with at least a 16K practical context budget

Qualified model:

```text
qwen2.5-7b-instruct-generic-gpu
```

## Try it

Run static checks:

```powershell
pwsh .\run-checks.ps1 -SkipLive
```

Run the staged-file canary and sealed evidence-check example:

```powershell
pwsh .\run-checks.ps1
```

New to the project? Follow the [step-by-step tutorial](docs/TUTORIAL.md).

Install the skill:

```powershell
copilot skill add .\.github\skills\local-agent-delegation
```

The optional agentic transport and format-compliance example is:

```powershell
pwsh .\examples\evidence-check\run-agentic-demo.ps1
```

It is deliberately not the default acceptance path. The preflight owns tool-transport
qualification; the sealed example demonstrates bounded input, response formatting, and gate
wiring. Neither is a general semantic benchmark.

## Safe operating rule

Use local only when the task is bounded, the evidence is explicit, and the result has a cheap
independent check. Local output is a proposal. Never treat process exit zero, confidence, or fluent
prose as authority.

## Status

Private research preview. The qualified route is intentionally narrow; see
[`QUALIFICATION.md`](QUALIFICATION.md) before changing the model, runtime, Copilot CLI version,
tool set, or token budget.

## License

[MIT](LICENSE)
