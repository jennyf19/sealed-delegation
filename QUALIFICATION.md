# Qualification boundary

## Accepted route

The following precise ARM64 route has cross-machine evidence:

- Windows ARM64 with Snapdragon X Elite
- Foundry Local CLI 0.10.3
- `qwen2.5-7b-instruct-generic-gpu`
- GitHub Copilot CLI 1.0.79
- stream mode enabled through the temporary #874 repair shim
- `view` as the only child tool
- 16,384 prompt-token budget
- bounded staged-file read followed by an exact independent gate
- route id `foundry-qwen25-7b-qualified` in the approved-route policy

ARM64 cross-machine receipts:

| Task | Result | Wall |
|---|---|---:|
| staged nonce canary | exact | 141.562s |
| synthetic-shaped missing-evidence proposal | exact and independently kept | 141.176s |

The Foundry service remained ready after both runs.

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
