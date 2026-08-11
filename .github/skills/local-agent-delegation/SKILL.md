---
name: local-agent-delegation
description: Delegate bounded, independently verifiable work from a frontier Copilot CLI session to a loopback local model.
---

# Local Agent Delegation

Use a local GitHub Copilot CLI child as a bounded preparer while the frontier session remains the
guide, verifier, and authority.

## Use when

- the input is explicit and small;
- the output is cheap to verify;
- local inference is loopback and zero-marginal-cost;
- a wrong answer is recoverable;
- no decision advances without an independent gate.

Good tasks include exact extraction, bounded summarization, missing-input checks, and isolated
mechanical changes with targeted verification.

Do not delegate final security or compliance decisions, destructive work, broad exploration,
secrets to remote endpoints, or anything you would ship without inspection.

## Procedure

1. Seal one outcome, exact input paths, allowed scope, acceptance criteria, and stop conditions.
2. Pass every approved source file through `-InputPaths`. The launcher copies and hashes those
   files into an isolated child workspace and rewrites task references to exact staged paths.
3. Select the smallest profile:
   - `read`: `view`
   - `edit`: `view,glob,edit,create` and `-AllowWrites`
   - `code`: adds PowerShell and requires `-AllowWrites -AllowShell`
4. Use an isolated worktree for every mutating task.
5. Invoke `scripts/invoke_local_agent.ps1`.
6. Independently inspect the receipt and artifact. Record `kept`, `edited`, `redone`, or
   `escalated`.

Example:

```powershell
. .\tools\foundry-shim-lib.ps1
$shim = Start-LocalDelegationFoundryShim `
  -RepoRoot $PWD `
  -LogDirectory .\results `
  -Model qwen2.5-7b-instruct-generic-gpu `
  -FoundryAlias qwen2.5-7b-instruct-generic-gpu
try {
  .\.github\skills\local-agent-delegation\scripts\invoke_local_agent.ps1 `
    -Task "Use view to read fixture.md. Reply exactly RESULT: <contents>." `
    -WorkingDirectory C:\path\to\isolated-worktree `
    -InputPaths C:\path\to\fixture.md `
    -Profile read `
    -TaskMode prepare `
    -Model qwen2.5-7b-instruct-generic-gpu `
    -FoundryAlias qwen2.5-7b-instruct-generic-gpu `
    -MaxPromptTokens 16384 `
    -Stream on `
    -BaseUrl $shim.BaseUrl
} finally {
  Stop-LocalDelegationFoundryShim $shim
}
```

## Authority boundary

Local output is a proposal. Process exit zero, fluent prose, or local confidence are not evidence.
The caller must verify receipts, inspect artifacts directly, and run an independent gate.

`evidence-check` may propose a missing-input `BLOCK`; accept it only after confirming that the
named input is absent from the supplied evidence.

## Route governance

The launcher loads `references/approved-routes.json` and rejects every runtime/model/profile/budget
tuple not explicitly qualified there. This is stronger than a banned-model list: unknown routes
fail closed.

Do not point the launcher at LM Studio, Ollama, or another local server and assume locality makes
the route approved. A new route requires independent qualification. The
`-AllowUnqualifiedRoute` switch is a high-risk research override and is recorded in the receipt.

## Runtime boundary

Before first use, or after changing the model, runtime, stream mode, or Copilot CLI version, run:

```powershell
pwsh tools\local-agent-preflight.ps1 -StartFoundryShim `
  -Model qwen2.5-7b-instruct-generic-gpu `
  -MaxPromptTokens 16384
```

The Foundry stream shim is temporary and exists for
[`microsoft/foundry-local#874`](https://github.com/microsoft/foundry-local/issues/874). Remove it
only after direct-to-Foundry tool-call streaming is verified.

## Qualified research configuration

- Windows ARM64 Snapdragon X Elite
- Foundry Local CLI 0.10.3
- `qwen2.5-7b-instruct-generic-gpu`
- GitHub Copilot CLI 1.0.79
- one-tool `view` profile
- 16,384 prompt-token budget
- stream shim enabled

This qualifies one bounded read/evidence-check route, not general local autonomy.
