# Tutorial: one sealed evidence check end to end

This is a learning walkthrough, not only an install checklist.

You will carry **one scenario** from a clean Windows machine through a successful run:

> Give a local model a synthetic release-evidence file and ask whether rollback evidence is joined
> for the predeclared release windows. The local child may read only that sealed file. A separate
> gate verifies the answer. Copilot keeps the final decision.

By the end you will know:

1. what you install once;
2. what you delegate;
3. what the local agent returns;
4. what Copilot (or the gate) verifies before anything is trusted.

## The scenario in one picture

```text
You / Copilot
  decide the job: "is rollback evidence joined?"
  choose the only allowed file: fixture.md
        |
        v
Local Copilot child
  reads the sealed file
  returns a structured proposal
        |
        v
Independent gate
  re-checks the sealed file hash
  compares the proposal to the expected answer
  records kept / edited / rejected / escalated
        |
        v
You / Copilot
  keep authority over any real decision
```

In the shipped synthetic example, the honest answer is **blocked**: the fixture does not contain
joined runtime and rollback evidence for the predeclared 30-day windows.

## 1. Install the prerequisites once

Install these yourself before asking an agent to run the project:

- **PowerShell 7**
- **Node.js 20 or newer**
- **GitHub Copilot CLI 1.0.79 or 1.0.80**
- **Foundry Local CLI 0.10.3**

Foundry Local is a signed installer. Windows may require an interactive `Add-AppxPackage`
confirmation or administrator approval. An agent cannot bypass that.

Check versions:

```powershell
pwsh --version
node --version
copilot --version
foundry --version
```

Exact tested hosts and versions live in [`QUALIFICATION.md`](../QUALIFICATION.md). If your Copilot
CLI version differs, complete the preflight successfully before trusting the launcher.

## 2. Authenticate Copilot CLI once

```powershell
copilot
```

Complete browser or device-code authentication yourself. Do not give credentials or browser codes
to a local model.

## 3. Clone the repository

While the repository is private:

```powershell
gh repo clone jennyf19/sealed-delegation
cd sealed-delegation
```

## 4. Load the qualified local model

```powershell
foundry server start
foundry model load qwen2.5-7b-instruct-generic-gpu
foundry status -o json
```

The first load downloads several gigabytes and compiles for your hardware. Keep the machine awake.

## 5. Prove the wiring with static checks

```powershell
pwsh .\run-checks.ps1 -SkipLive
```

This does not yet run the scenario. It confirms launcher policy, loopback refusal, route
allowlisting, staged-input behavior, and the temporary stream-shim repairs.

## 6. Run the scenario

```powershell
pwsh .\run-checks.ps1
```

### What you just delegated

`run-checks.ps1` runs two linked pieces of the same story:

1. **Staged-file canary.** The launcher seals a tiny file with a random nonce. The local child must
   read only that file and echo the nonce. This proves sealed input + local tool transport.
2. **Sealed evidence check.** The launcher (or direct sealed path) gives the local model the
   synthetic release-evidence fixture and asks whether rollback evidence is joined. The expected
   honest answer is blocked with a named missing input.

### What the local agent returns

You should see a structured proposal like:

```json
{
  "status": "blocked",
  "answer": null,
  "missing_input": "joined runtime and rollback evidence for the predeclared 30-day release windows",
  "source": "synthetic-release-evidence#observation-window"
}
```

That is a proposal, not a release decision.

### What Copilot / the gate verifies

The independent gate:

- re-checks the sealed input hash;
- parses the proposal;
- compares it to the expected blocked result;
- records `disposition: kept` only when the match is exact;
- records `authority_advanced: false` so the receipt shows no real-world decision was advanced.

Success ends with:

```text
PASS: full sealed-delegation checks
```

Receipts land under `results/` (git-ignored). Open `run.json`, the staged-input hashes, and the
gate receipt before you trust any later real task.

## 7. Optional: watch the agentic form of the same scenario

```powershell
pwsh .\examples\evidence-check\run-agentic-demo.ps1
```

This is the same missing-evidence story, but the local child must use `view` on the sealed fixture
before answering. It is a transport and format demo with an independent gate. It is not a general
semantic benchmark.

## 8. Install the skill for real frontier sessions

```powershell
copilot skill add .\.github\skills\local-agent-delegation
```

The component name remains `local-agent-delegation`.

From a frontier Copilot session, delegate only when you can supply:

- one outcome;
- exact input paths;
- a minimal tool profile (`read` / `view` first);
- an acceptance test;
- a stop condition.

After the child finishes, inspect the receipts. Do not act merely because the child exited
successfully.

## 9. Optional: use it from The Workshop

Do not replace a Workshop desk's frontier model with the local model. Keep the frontier desk as the
user-facing partner and delegate only bounded subtasks.

```powershell
copilot skill add C:\path\to\sealed-delegation\.github\skills\local-agent-delegation
```

See [`WORKSHOP-INTEGRATION.md`](WORKSHOP-INTEGRATION.md) for the product contract.

## What remains manual on purpose

Humans must:

- install and approve signed runtimes;
- complete GitHub/Copilot authentication;
- decide which files may cross the task seal;
- review potential-secret warnings;
- approve any high-risk overrides;
- run or inspect the independent gate;
- decide whether output advances real work.

Those are authority boundaries, not missing automation.

## Using another local runtime later

LM Studio, Ollama, and other loopback servers are not approved by default. Starting one does not
change Sealed Delegation's route.

Before evaluating another model, confirm your organization permits the runtime, model, account,
device, data classification, and intended use. This project's allowlist records technical evidence
only.

To research another runtime:

1. review license, provenance, runtime, model id, context, tools, and gate behavior;
2. run preflight and the frozen acceptance task;
3. add the route to `approved-routes.json` only after qualification.

`-AllowUnqualifiedRoute` is for isolated experiments. It is intentionally loud and recorded in
receipts. Do not use it for normal Workshop tasks or claim the route is qualified.
