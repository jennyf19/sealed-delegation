# Threat model

**Review status:** Two-party review completed 2026-08-11 for the qualified CLI/shim route.
The Foundry Local SDK 2.0.1 Session adapter is a separate, unqualified route under issue #5; its
addendum below requires review before promotion.

## System in one sentence

A trusted frontier agent seals a bounded task and selected input files, hands them to a local child
whose output is always untrusted, and accepts nothing until an independent gate re-verifies it.

## Assets

| Asset | Why it matters |
|---|---|
| Caller credentials and ambient identity | Theft turns a local helper into an authenticated actor |
| Files outside the staged workspace | The child should see only what the caller selected |
| Downstream decision integrity | Local output must never silently become authority |
| Run receipts and hashes | They are the audit trail for every trust claim |
| The host | The child runs as the OS user; there is no OS sandbox |

## Trust levels

| Actor | Trust |
|---|---|
| Frontier caller / operator | Trusted; holds authority |
| Launcher, gate, shim, and policy code | Trusted, reviewable repository code |
| Copilot CLI child binary | Trusted binary at the pinned version; unsandboxed |
| Local child output | Untrusted, always |
| Local model and runtime | Semi-trusted supply chain; output remains untrusted |
| Staged input content | Untrusted prompt-injection carrier |
| Other same-user processes | Untrusted for loopback confidentiality; active same-user malware is out of scope |

## Trust boundaries

1. **Task seal:** task text, staged files, tool allowlist, and budgets cross from frontier to child.
2. **Network egress:** provider and shim upstream must remain loopback; redirects and proxies are
   blocked.
3. **Authority gate:** child output crosses into real work only after independent verification.

## Threats and controls

| # | Threat | Control | Enforcement | Residual |
|---|---|---|---|---|
| T1 | Prompt injection steers output | Treat output as proposal; exact independent gate; read-only profile | Gate, launcher, skill procedure | Loose caller-defined gates inherit semantic risk |
| T2 | Credential or identity theft | Default-deny env allowlist; isolated HOME/AppData/Azure/git; provider-key scrub | Launcher and policy tests | High-risk credential override disables the control |
| T3 | Remote data exfiltration | Loopback checks at launcher and shim; proxies removed; redirects refused | URL checks and negative tests | A hostile trusted binary can still use the OS network |
| T4 | Filesystem escape | Minimal available tools; writes/shell require explicit flags and isolated worktree | Launcher validation and tests | No filesystem ACL sandbox |
| T5 | Output silently becomes authority | Distinct failure exits; required gate; dispositions and authority field | Output policy, gate, skill | An integrator can misuse launcher exit zero |
| T6 | Poisoned model/runtime | Version tuple and preflight; all output untrusted | Qualification and preflight | Model weights are not independently verified |
| T7 | Compromised Copilot binary | Version pin and re-preflight on changes | README and policy | **Largest residual:** binary runs fully trusted as the OS user |
| T8 | Shim port abuse | Loopback bind; start late, stop early | Shim and operating procedure | Same-user process can reach the port while open |
| T9 | Receipt tampering | Chained task, input, stdout, and stderr hashes | Launcher | Receipts are unsigned and assume host integrity |
| T10 | Secret pasted into task text | Pre-launch secret-pattern screen; explicit high-risk override | Launcher and policy test | Pattern matching cannot detect every secret |
| T11 | Hung or looping child | Hard timeout and process-tree termination | Launcher | Long but progressing runs can still be expensive in wall time |
| T12 | Unapproved or policy-banned model is selected | Fail-closed exact runtime/model/profile/budget allowlist; explicit override recorded as unqualified | Route policy in launcher, preflight, and sealed demo; PowerShell and Node tests | Runtime/model labels are configuration claims, not cryptographic attestation of weights |
| T13 | Embedded SDK terminal failure is hidden behind plausible partial output | Adapter records per-request terminal reason and the qualification gate rejects `length`, `error`, missing telemetry, and a final reason other than `stop` | Session adapter telemetry and qualification grader tests | The SDK and native execution provider remain trusted to report their own terminal state honestly |
| T14 | Session adapter port remains reachable longer than required | Ephemeral loopback bind; runner starts immediately before serial execution and closes in `finally`; lifecycle receipt records closure | Session qualification runner and adapter loopback test | Other same-user processes can reach the port during the bounded run |
| T15 | Adapter or embedded native runtime processes untrusted staged content | Prompts and staged files remain bounded by the launcher; only `view` is exposed; output remains untrusted and independently graded | Launcher, adapter, deterministic grader | The embedded SDK/native provider runs as the OS user without an OS sandbox |

## Explicit non-goals

- containing active same-user malware;
- OS-level sandboxing of the child binary;
- multi-tenant host isolation;
- proving semantic correctness of local output;
- authorizing security, compliance, merge, or deployment decisions.

## Assurance map

| Control | Test |
|---|---|
| Credential isolation | `test_policy.ps1` |
| Qualified defaults | `test_policy.ps1` |
| Tool and protected-branch gating | `test_policy.ps1` |
| Output rejection policy | `test_policy.ps1` |
| Staged-input hash chain | `test_policy.ps1` and example gate |
| Launcher non-loopback refusal | `test_policy.ps1` |
| Shim non-loopback refusal | `foundry-stream-shim.test.mjs` |
| Secret-pattern refusal | `test_policy.ps1` |
| Approved-route enforcement | `test_policy.ps1` and `route-policy.test.mjs` |
| Shim repair and de-duplication | `foundry-stream-shim.test.mjs` |
| Session SDK terminal-reason telemetry | `foundry-session-probe/adapter.test.mjs` |
| Session corpus and fail-closed grader | `foundry-session-qualification/qualification.test.mjs` |

## Review rule

Any change to the model, runtime, Copilot CLI version, tool set, network boundary, or default
authority flow requires a fresh threat-model review and preflight.
