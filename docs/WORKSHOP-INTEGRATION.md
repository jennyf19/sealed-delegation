# Workshop integration

## Current state

Cairn currently supports two desk launch profiles:

- `repo` — suppress ambient plugin MCPs;
- `connected` — retain configured MCPs.

Those profiles control tool connectivity. They do not select a local model. There is no local-mode
button in the current Workshop release.

Sealed Delegation ships `tools/start-local-copilot.ps1` as the stable manual launch boundary.

## Proposed Cairn profile

Add a separate `local` profile rather than overloading `repo`:

```text
open     -> frontier Copilot, repo MCP profile
connected -> frontier Copilot, connected MCP profile
local    -> Sealed Delegation wrapper, local model, read-only tools
```

The Workshop launcher should invoke:

```powershell
pwsh -NoProfile -File <sealed-delegation>\tools\start-local-copilot.ps1 `
  -WorkingDirectory <desk-path> `
  -WorkshopDir <workshop-root> `
  -Name <desk-name>-local
```

## Configuration contract

Proposed environment variable:

```text
WORKSHOP_LOCAL_LAUNCHER=C:\path\to\sealed-delegation\tools\start-local-copilot.ps1
```

Cairn should show the local button only when:

- the path is absolute;
- the file exists;
- the extension is `.ps1`;
- the selected platform is Windows.

The extension must pass each argument through `spawn` argv, never shell concatenation.

## Preview boundary

The first local profile is read-only:

```text
view,glob
```

It is suitable for reading journals, extracting facts, and preparing bounded proposals. It is not
a replacement for a frontier desk and cannot write signals or persistent desk memory.

Write-enabled local desks require a separate qualification.

## Ownership

The wrapper and runtime contract live in Sealed Delegation. The button and launch-profile UI belong
in The Workshop. Keeping that seam explicit lets each repository version its own responsibility.
