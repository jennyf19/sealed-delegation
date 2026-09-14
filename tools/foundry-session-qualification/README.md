# Qwen2.5 Session route qualification

This directory implements the public qualification harness for issue #5. It tests exactly:

- Foundry Local SDK 2.0.1 Session adapter;
- `qwen2.5-7b-instruct-generic-gpu:4`;
- the executable-reported Copilot CLI version captured in `environment.json`;
- stream mode on;
- `view` only;
- 16,384 prompt tokens;
- `read` / `evidence-check`.

It does not modify `approved-routes.json` and cannot approve the route.

## 1. Validate and review the frozen corpus

This command performs no model request:

```powershell
node tools\foundry-session-qualification\runner.mjs --validate-only
```

JM reviews all 20 files under `corpus\sources`, their tasks and exact expected JSON in
`corpus\manifest.json`, and the prompt in `prompt-template.txt`. The printed corpus SHA-256 is the
approval boundary. Any corpus or prompt edit changes it.

## 2. Run deterministic failure injection

This command uses local fault servers and synthetic receipts; it does not start the model:

```powershell
node tools\foundry-session-qualification\failure-injection.mjs `
  --manifest tools\foundry-session-qualification\corpus\manifest.json `
  --output results\session-qualification\failure-injection
```

All ten cases must report `gate_accepted=false`, `authority_advanced=false`, and a non-success
failure-injection exit. Transport failures are exercised against ephemeral loopback servers.
SDK `length` and `error` observability is also covered by
`tools\foundry-session-probe\adapter.test.mjs`.

## 3. Run the serial corpus after approval

Install the adapter dependency if needed:

```powershell
$env:FOUNDRY_LOCAL_SKIP_INSTALL = "1"
npm install --prefix tools\foundry-session-probe
```

Commit the harness first so the environment receipt can require a clean worktree. Then pass the
exact hash JM approved:

```powershell
node tools\foundry-session-qualification\runner.mjs `
  --approved-corpus-sha256 <approved-sha256> `
  --results results\session-qualification
```

The runner:

- records the commit, tool versions, model cache metadata, hardware, adapter settings, and file
  hashes in `environment.json`;
- starts the Session adapter on an ephemeral loopback port;
- stages one fixture and invokes `local-agent-delegation` with the frozen tuple;
- writes `attempt.json` before launching each child;
- captures provider terminal reasons and token usage without prompts or response content;
- writes `gate.json` for every attempt;
- closes and unloads the adapter in `finally`;
- writes `analysis.json`.

The runner never silently retries. Resume skips every fixture with an existing attempt:

```powershell
node tools\foundry-session-qualification\runner.mjs `
  --approved-corpus-sha256 <approved-sha256> `
  --results results\session-qualification `
  --resume
```

An operator-authorized retry must name each fixture:

```powershell
node tools\foundry-session-qualification\runner.mjs `
  --approved-corpus-sha256 <approved-sha256> `
  --results results\session-qualification `
  --resume `
  --retry timezone-source-zone
```

The first attempt remains preserved and remains the promotion attempt.

## 4. Record threat review and decision

Before a `PROMOTE` recommendation, create `results\session-qualification\threat-review.json`:

```json
{
  "reviewed_at": "2026-09-14T00:00:00Z",
  "reviewers": ["JM", "Bridge"],
  "unresolved_high_severity": 0,
  "notes": "Reviewed SDK/runtime trust and ephemeral loopback adapter lifecycle."
}
```

Re-run `report.mjs` after the failure-injection and threat-review receipts exist. JM owns the final
`PROMOTE`, `HOLD`, or `REJECT` decision. Promotion, if authorized, belongs in a separate PR.
