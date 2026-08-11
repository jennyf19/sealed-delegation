# Workshop integration

## Architectural rule

The frontier desk remains the desk.

Local Delegation is an optional worker lane for eligible subtasks. It is orthogonal to Cairn's
existing launch profiles:

```text
repo / connected        = which MCPs and tools the frontier desk can see
Local Delegation off/on = whether the frontier desk may invoke a bounded local worker
```

The local worker never receives the entire interactive session, owns the user conversation, or
becomes the authority.

## Current setup

Install the skill on the Workshop host:

```powershell
copilot skill add C:\path\to\sealed-delegation\.github\skills\local-agent-delegation
```

Open desks normally through Cairn. The frontier desk can then invoke the installed skill when a
task matches the qualified boundary.

## Proposed Cairn control

Add a **Local Delegation** toggle to desk launch:

| Toggle | Behavior |
|---|---|
| Off | Frontier desk performs all work. |
| On | Frontier desk may delegate cleared, bounded subtasks through `local-agent-delegation`. |

The toggle must not silently fall back or count savings when:

- the skill is unavailable;
- preflight has not passed for the configured tuple;
- the task class is not qualified;
- the local output fails its independent gate.

## Suggested launch contract

Cairn can expose the operator's intent to the frontier desk with:

```text
WORKSHOP_LOCAL_DELEGATION=enabled
```

The desk instruction should say:

> Local Delegation is available for bounded, independently verifiable subtasks. Keep the user
> conversation, decomposition, judgment, and final answer in the frontier desk. Local output is a
> proposal and receives no savings credit unless the independent gate accepts it.

The skill and runtime remain owned by Sealed Delegation. Cairn owns only the toggle, availability
check, and visible state.

## Not the first version

Do not add a `local` desk profile that replaces the frontier model. Whole-session local desks,
write-enabled workers, and local tool authoring require separate qualification.
