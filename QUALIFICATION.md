# Qualification boundary

Sealed Delegation qualifies **exact routes on measured hosts**. A route is the combination of
runtime, model, Copilot CLI version, stream mode, tools, prompt budget, and acceptance task. Passing
on one host does not silently approve every Windows machine or every newer CLI build.

## Qualified route shape

Both measured hosts below used this route shape:

- Foundry Local CLI 0.10.3
- `qwen2.5-7b-instruct-generic-gpu`
- stream mode on through the temporary Foundry Local #874 repair shim
- `view` as the only child tool for agentic paths
- 16,384 prompt-token budget
- bounded staged-file read followed by an exact independent gate
- route id `foundry-qwen25-7b-qualified` in the approved-route policy

## Measured hosts

### Windows ARM64 (Snapdragon X Elite)

Cross-machine external validation, including a re-run under the shipped schema-classification
prompt:

| Task | Result | Wall | Notes |
|---|---|---:|---|
| staged nonce canary | exact | 141.562s | earlier cross-machine receipt |
| synthetic missing-evidence proposal | exact and independently kept | 141.176s | earlier cross-machine receipt |
| staged nonce canary | exact | 135.027s | 2026-08-14 re-run (`20260814-074934-8b5b8fa1`) |
| sealed direct missing-evidence proposal | exact and independently kept | 7.911s | 2026-08-14 re-run under shipped schema prompt |
| agentic staged-file missing-evidence proposal | exact and independently kept | 157.847s | 2026-08-14 (`20260814-075546-0df3d1b1`), Copilot skill installed |

GitHub Copilot CLI on the original ARM64 qualification path: **1.0.79**. The 2026-08-14 validator
re-run passed full package checks on that host's current CLI install. Treat any CLI change as
requiring preflight before claiming the route.

### Windows x64 (Intel Core Ultra development host)

Same route shape on an x64 development machine with GitHub Copilot CLI **1.0.80**:

| Task | Result | Wall | Notes |
|---|---|---:|---|
| staged nonce canary | exact | 154.665s | 2026-08-14 |
| sealed direct missing-evidence proposal | exact and independently kept | 20.612s | 2026-08-14 |
| agentic staged-file missing-evidence proposal | exact and independently kept | 213.680s | 2026-08-14 |

The x64 run also exposed a Windows path-depth failure when the isolated child home lived under a
very long run directory (SQLite `unable to open database file` before inference). Durable receipts
still land at the caller's run root; the ephemeral child home uses a short temporary path and is
removed after the child exits.

## How to read these tables

- **ARM64 and x64 are both measured.** ARM64 is not the only tested platform.
- **Qualified means "this exact route passed these checks,"** not "any local model is fine."
- **Copilot CLI versions other than the measured ones** need a successful preflight before use.
- **Local blocked/complete answers remain proposals.** The caller must still run or inspect the
  independent gate before advancing real work.

## Prior semantic evidence

In prior internal research, a frozen 20-case synthetic corpus of partnership-framed missing-input
checks produced:

- 20/20 exact named missing inputs;
- zero fabricated answers;
- zero false passes.

A local `BLOCK` remains a proposal. The caller must independently confirm the named input is absent.
The corpus and raw receipts are not shipped in this preview; a public reproduction kit is follow-up
work. Do not treat this claim as independently reproducible from the current package.

## Not qualified

- edit or shell profiles;
- broad repository discovery;
- large-context synthesis;
- final security, compliance, merge, or deployment decisions;
- arbitrary models, runtimes, tool sets, or prompt budgets;
- LM Studio, Ollama, or any other route not explicitly listed in `approved-routes.json`;
- claims of dollar savings.

## Measurement rule

Compare routes by all-in cost per independently verified success, including failed attempts,
retries, verification, wall time, and coverage. `Handled locally` is utilization, not savings.
