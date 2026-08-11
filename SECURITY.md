# Security

The complete design analysis is in [`THREAT-MODEL.md`](THREAT-MODEL.md).

## Boundary summary

- The local child runs as the current OS user. Environment isolation is **not** an OS sandbox.
- The child binary is trusted; child output is always untrusted.
- Provider and shim upstream URLs are loopback-only by default.
- The child runs with blanket approval; `--available-tools` is the entire tool-enforcement
  boundary.
- Approved source files should cross through `-InputPaths`, which copies and hashes them.
- Local output cannot authorize a consequential decision without an independent gate.
- Task text is persisted in receipts; potential secret patterns are rejected before launch unless
  the caller uses the explicit high-risk override.
- Runtime/model routes are denied unless the complete tuple appears in the approved-route policy.
  The unqualified-route override is for isolated research and removes qualified status.
- The temporary shim is unauthenticated on loopback. Start it only for the bounded run and stop it
  immediately afterward.

## Reporting a vulnerability

Keep the repository private while evaluating reports. Share:

- the affected version or commit;
- a minimized synthetic reproducer;
- scrubbed receipts;
- expected and actual boundary behavior.

Do not include credentials, private prompts, source files, full child homes, or production paths.
