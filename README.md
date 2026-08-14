<p align="center">
  <img src="assets/sealed-delegation.svg" width="112" alt="Sealed Delegation — a sealed task packet" />
</p>

<p align="center"><strong>Give a local model one bounded job. Keep the final decision in Copilot.</strong></p>

# Sealed Delegation

## The problem this solves

Some work is useful to offload to a local model: reading a few files you already chose, drafting a
structured answer, or naming missing evidence. That can keep private files on your machine and avoid
spending frontier capacity on narrow preparation.

The risk is also real. A fluent local answer is still only a proposal. If the local process can see
too much, use too many tools, or quietly "decide" a release, merge, or security outcome, the handoff
becomes unsafe.

Sealed Delegation is the narrow pattern that keeps the useful part and rejects the unsafe part:

- you choose one small job and the exact files it may see;
- a local Copilot CLI child works only inside that packet;
- a separate check verifies the answer;
- Copilot keeps the final decision.

This is not autonomous local development. It is not a savings claim.

The installable skill is still named **`local-agent-delegation`**.

## One concrete example

Give a local model three selected test reports and ask it to identify missing release evidence.

What happens:

1. Copilot seals only those three files into an isolated workspace.
2. The local child may read those files and nothing else.
3. It returns a structured proposal, such as "blocked until joined runtime and rollback evidence
   exists for the predeclared 30-day windows."
4. A separate gate checks the answer against the sealed evidence.
5. Copilot decides whether to keep, edit, reject, or escalate the proposal.

The local model never authorizes a release. It only prepares a checked answer from the files you
allowed.

The synthetic version of this example ships in [`examples/evidence-check/`](examples/evidence-check/).

## Try it

Requirements:

- Windows with PowerShell 7
- Node.js 20 or newer
- GitHub Copilot CLI 1.0.79 or 1.0.80; any other version needs a successful preflight first
- Foundry Local CLI 0.10.3
- cached `qwen2.5-7b-instruct-generic-gpu` with at least a 16K practical context budget

Static checks:

```powershell
pwsh .\run-checks.ps1 -SkipLive
```

Full live check (staged-file canary + sealed evidence example + independent gate):

```powershell
pwsh .\run-checks.ps1
```

Success ends with:

```text
PASS: full sealed-delegation checks
```

New here? Start with the [tutorial](docs/TUTORIAL.md). It walks one scenario from setup through
what you delegate, what the local agent returns, and what Copilot verifies.

Install the skill:

```powershell
copilot skill add .\.github\skills\local-agent-delegation
```

Optional agentic demo (transport + format + gate wiring, not a semantic benchmark):

```powershell
pwsh .\examples\evidence-check\run-agentic-demo.ps1
```

## How sealing and verification work

In plain language first:

1. **Seal the job.** Copilot writes one task and copies only the approved files into a temporary
   workspace. Each file is hashed so the receipt can prove what the child saw.
2. **Run locally.** A second Copilot CLI process uses the local model. By default it can only
   `view` the sealed files.
3. **Return a proposal.** The child prints an answer plus receipts. Exit code 0 means "the child
   finished," not "accept this."
4. **Verify separately.** A gate re-checks hashes and compares the answer to an expected result or
   another independent check. Only then does Copilot keep, edit, reject, or escalate.

```text
Copilot (frontier session)
  -> seals one task and approved files
  -> launcher hashes files into an isolated workspace
  -> local Copilot CLI child uses a minimal tool list
  -> child returns a proposal plus receipts
  -> separate gate accepts, edits, rejects, or escalates
```

Safe operating rule: use local only when the task is bounded, the evidence is explicit, and the
result has a cheap independent check. Never treat process exit zero, confidence, or fluent prose as
authority.

## Qualification, governance, and deeper docs

| Doc | When to read it |
|---|---|
| [`docs/TUTORIAL.md`](docs/TUTORIAL.md) | First run on a clean machine |
| [`QUALIFICATION.md`](QUALIFICATION.md) | Exact tested routes, hosts, and limits |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | Assets, threats, controls, residual risk |
| [`SECURITY.md`](SECURITY.md) | Boundary summary and vulnerability reporting |
| [`docs/WORKSHOP-INTEGRATION.md`](docs/WORKSHOP-INTEGRATION.md) | Using this from a Workshop frontier desk |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Contributor expectations |

Only exact routes in
[`.github/skills/local-agent-delegation/references/approved-routes.json`](.github/skills/local-agent-delegation/references/approved-routes.json)
run as qualified by default. Starting LM Studio, Ollama, or another local server does not make it
available automatically. An unlisted runtime, model, profile, stream mode, or prompt budget fails
before inference.

`-AllowUnqualifiedRoute` is a loud research override. Receipts record that the route was
unqualified; it must not inherit qualified claims.

This allowlist is **technical evidence only**. It is not employer, legal, privacy, export-control,
or procurement approval. Follow your organization's policies even when a route is technically
qualified here.

### What's in the package

| Path | Purpose |
|---|---|
| `.github/skills/local-agent-delegation/` | Installable skill and isolated launcher |
| `tools/local-agent-preflight.ps1` | End-to-end staged-file canary |
| `tools/foundry-stream-shim.mjs` | Temporary repair for Foundry Local #874 |
| `examples/evidence-check/` | Synthetic sealed task, gate, and agentic variant |
| `run-checks.ps1` | Static checks and optional live validation |

### Short glossary

Terms appear after plain language above. Use this when a receipt or deeper doc uses the shorter
label.

| Term | Plain meaning |
|---|---|
| **Frontier judgment** | The hosted Copilot session that talks with you and keeps final decisions |
| **Local child** | A second Copilot CLI process whose model runs on your machine |
| **Sealed task / packet** | One bounded job plus only the files approved for that job |
| **Staged hashes** | Checksums proving which files were copied into the child workspace |
| **Loopback** | Traffic stays on this machine (`127.0.0.1` / `localhost`), not a remote API |
| **Route tuple** | The exact runtime + model + stream mode + tool profile + token budget that was tested |
| **Independent gate** | A separate check that verifies the local answer; not the local model grading itself |
| **Authority boundary** | What may never be decided by the local child (merge, deploy, security disposition) |
| **Fail closed** | On doubt, missing evidence, or invalid output, stop or escalate instead of accepting |
| **Qualified route** | A route with measured receipts in `QUALIFICATION.md` and the approved-route allowlist |

## Status

Public research preview. The qualified route is intentionally narrow. Read
[`QUALIFICATION.md`](QUALIFICATION.md) before changing the model, runtime, Copilot CLI version,
tool set, or token budget.

## License

[MIT](LICENSE)

## Community

Participation is governed by the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
