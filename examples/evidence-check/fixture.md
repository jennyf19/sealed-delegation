# Synthetic release evidence

service: `checkout-api`
environment: `test`
policy: `synthetic-release-gate-v1`

## Observation window

For each release:

```text
window_start = deployment timestamp
window_end   = deployment timestamp + 30 days
```

Correlate by release identifier, commit, deployment ring, and environment to:

- rollback or deployment halt;
- runtime regression or incident;
- emergency configuration change;
- support work attributable to the release.

The predeclared test release windows are mature.

## Outcomes

The source-visible proxy is clean: no rollback commit or release-specific follow-up change was
found. The deployment record shows that the sample reached ring 0.

Runtime telemetry, incident records, rollback execution, and support evidence are still unjoined.

**Status: `pass` for source retention; `unknown` for operational correctness; overall
`rollbackEvidenceLinked=fail`.**
