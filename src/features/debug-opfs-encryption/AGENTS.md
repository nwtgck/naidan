# Persistence Control debug inspection

This directory is an internal HizoFS/Persistence Control audit tool, not a general Naidan user interface.

The exact-path dependency-direction exception exists so reviewers can inspect persisted encryption and authority DTOs without a normal application mapper silently normalizing, omitting, or reinterpreting evidence. Direct DTO consumption is therefore intentional when it preserves audit fidelity.

## Audit fidelity

- Show both A/B copies, selected and rejected candidates, proof state, failure reason, sequence, protection, transition state, authentication filesystem identity, retired identities, and physical path.
- Do not collapse unknown, invalid, rejected, or unavailable states into a generic user-facing status.
- Reuse authoritative Persistence Control and HizoFS types. Do not duplicate persisted constants or proof-selection logic.
- Core storage code must never import this feature.

## Exhaustive projections

Every complete DTO projection must use rest-property exhaustiveness:

```ts
unhandled satisfies Record<PropertyKey, never>;
```

Use `exactObject` for destination-side exactness. If a field is intentionally not rendered, destructure it with an underscore-prefixed name and add a why comment. Prefer rendering all audit-relevant fields so future DTO additions fail compilation until the Inspector is updated.
