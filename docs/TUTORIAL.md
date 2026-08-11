# Tutorial: set up and use Sealed Delegation

This walkthrough starts with a clean Windows machine and ends with:

1. a verified local-model runtime;
2. the `local-agent-delegation` skill installed;
3. a synthetic sealed evidence check;
4. an optional Workshop frontier desk that can delegate eligible subtasks locally.

## 1. Install the prerequisites

Install these yourself before asking an agent to run the project:

- **PowerShell 7**
- **Node.js 20 or newer**
- **GitHub Copilot CLI 1.0.79**
- **Foundry Local CLI 0.10.3**

Foundry Local is distributed as a signed installer. Windows may require an interactive
`Add-AppxPackage` confirmation or administrator policy approval. An agent cannot bypass that.

After installation:

```powershell
pwsh --version
node --version
copilot --version
foundry --version
```

The qualified versions are recorded in [`QUALIFICATION.md`](../QUALIFICATION.md). If your Copilot
CLI version differs, you must complete the preflight successfully before using the launcher.

## 2. Authenticate Copilot CLI

Run Copilot once:

```powershell
copilot
```

Complete any browser/device-code authentication yourself. Do not give credentials or browser codes
to a local model.

## 3. Clone this repository

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

The first load downloads several gigabytes and compiles for your hardware. This is manual setup and
can take several minutes. Keep the machine awake.

## 5. Run static checks

```powershell
pwsh .\run-checks.ps1 -SkipLive
```

This checks:

- launcher policy;
- loopback refusal;
- task-secret screening;
- staged-input behavior;
- runtime port rediscovery;
- stream-shim repair and de-duplication.

## 6. Run the complete check

```powershell
pwsh .\run-checks.ps1
```

This performs:

1. a Copilot CLI staged-file canary through the local model;
2. a sealed synthetic evidence classification;
3. an independent exact gate.

Success ends with:

```text
PASS: full sealed-delegation checks
```

Receipts are written below `results/`, which is git-ignored.

## 7. Install the skill

```powershell
copilot skill add .\.github\skills\local-agent-delegation
```

The component name intentionally remains `local-agent-delegation`.

## 8. Delegate a bounded file task

Use the skill from a frontier Copilot session. The caller should provide:

- one outcome;
- exact input paths;
- a minimal tool profile;
- an acceptance test;
- a stop condition.

Start with `read` tasks only. The example in the skill shows the full qualified tuple and temporary
shim lifecycle.

After the child finishes, inspect:

- `run.json`;
- staged-input hashes;
- `stdout.txt` and `stderr.txt`;
- the independent gate receipt.

Do not act merely because the child exited successfully.

## 9. Try the synthetic example directly

```powershell
pwsh .\examples\evidence-check\run-demo.ps1
```

The sealed example is faster and more stable than a full agentic loop. It demonstrates evidence
classification and independent gating, not a general model benchmark.

## 10. Optional: use it from The Workshop

Do not replace a Workshop desk's frontier model with the local model. The qualified architecture
keeps the frontier desk as the user-facing partner and delegates only bounded subtasks.

Install the skill on the machine that runs the Workshop:

```powershell
copilot skill add C:\path\to\sealed-delegation\.github\skills\local-agent-delegation
```

Open the desk normally with Cairn's `repo` or `connected` profile. Then ask the frontier desk to use
`local-agent-delegation` for a bounded, independently verifiable subtask.

The current Workshop release has no Local Delegation toggle. The planned toggle changes whether
the frontier desk may invoke the local worker; it does not change which model owns the desk.

See [`WORKSHOP-INTEGRATION.md`](WORKSHOP-INTEGRATION.md) for the product contract.

## What remains manual

Humans must:

- install and approve signed runtimes;
- complete GitHub/Copilot authentication;
- decide which files may cross the task seal;
- review potential-secret warnings;
- approve any high-risk overrides;
- run or inspect the independent gate;
- decide whether output advances real work.

Those are authority boundaries, not missing automation.
