# HizoFS inspection feature

This directory owns technical review tools for inspecting HizoFS. It is not the source of filesystem semantics and must not become a generic storage dashboard or an independent model of HizoFS.

## Role

The HizoFS Inspector is a faithful audit projection of the current HizoFS. HizoFS itself is the subject under review and the only source of storage meaning. Information flows from HizoFS into the Inspector; the Inspector does not define what HizoFS should contain.

- Project the HizoFS implementation that actually exists. Do not substitute a simplified, idealized, explanatory, or UI-owned storage model.
- Do not introduce an Inspector-owned hierarchy, vocabulary, identity scheme, or semantic layer.
- If a faithful projection exposes awkward terminology, a redundant abstraction, an unexpected relationship, or another apparent design problem, preserve that evidence and treat it as a possible HizoFS finding.
- Do not hide, rename, flatten, or reinterpret a possible HizoFS finding in the Inspector. When an approved finding changes HizoFS, change HizoFS first and update the Inspector as a consequence.
- Change the Inspector independently only to correct an inaccurate, incomplete, stale, or otherwise unfaithful projection of the HizoFS that exists.

## Authorities and dependency direction

- Use the production HizoFS `00-format` modules as the authority for persisted identifiers, bytes, layouts, kinds, bounds, references, and decoded payload shapes.
- Use approved HizoFS inspection DTOs and capabilities as the authority for authenticated observations. Do not reconstruct equivalent DTOs inside this feature.
- Reuse authoritative codecs, constants, record kinds, and reference types. Never copy format literals or infer persisted meaning from display strings.
- This exact feature root may use its separately reviewed deep dependency access where a convenience abstraction would omit, normalize, or reinterpret audit evidence. Do not generalize that exception to another debug feature.
- HizoFS core, format, crypto, runtime, and maintenance code must never import this feature.
- Inspector behavior must not affect HizoFS persistence, publication, recovery, concurrency, maintenance, or error results.

## Canonical vocabulary

Canonical HizoFS names are audit evidence.

- Preserve HizoFS identifiers, field names, record names, authority names, and terminology in the Inspector.
- Do not replace canonical names with friendlier aliases or a normalized Inspector vocabulary.
- Explanations, grouping labels, formatting, and human-readable summaries may be additive, but the canonical term or identifier must remain visible and unambiguous.
- Do not use presentation wording to imply an identity, ownership relationship, authority relationship, or persisted structure that HizoFS does not establish.

## Projection layers

Keep different kinds of evidence distinguishable:

- physical persisted facts, including A/B copies, Segment locations, frame boundaries, and physical references;
- authenticated and decoded persisted facts, including authority selection, records, pages, payloads, and logical references;
- logical filesystem observations derived by following the current authenticated structure;
- derived navigation, summaries, breadcrumbs, and shortcuts;
- runtime-only observations, when an approved inspection DTO explicitly exposes them.

Derived presentation is allowed only as an addition. Keep its authoritative evidence reachable, identify derivation where confusion is possible, and never promote a shortcut or summary into a substitute HizoFS concept. Do not assert that two observations have the same identity merely because they share a path, label, or display value.

## Audit fidelity and safety

- Display selected and rejected authority candidates, unknown values, corruption reasons, proof failures, physical references, and bounded or truncated observation metadata when the authoritative DTO provides them.
- Navigation shortcuts must not replace or hide Unlock Envelopes, Superblocks, Segments, Record Frames, Records, indexes, or other structures that are present in HizoFS.
- Keep inspection I/O and memory bounded. Surface truncation and unavailable evidence instead of silently presenting a partial result as complete.
- Fail closed when authenticated evidence cannot be established. Do not create unchecked decode or decryption paths for debug convenience.
- Do not expose a Root Key, credential, passphrase, generic decryption capability, or production write authority through UI-facing DTOs.
- A credential accepted for one inspection operation must not become durable Inspector state, diagnostic output, or an implicit credential for another source.
- Isolated fixture tooling may own a purpose-specific writable Temporary HizoFS session, but the Inspector projection must not receive or imply general production mutation authority.

## Synchronization with HizoFS

HizoFS and the Inspector do not have to change in the same implementation slice. While HizoFS is unstable, Inspector synchronization may intentionally lag to avoid repeatedly rebuilding the projection. This is a valid implementation strategy, not permission for the Inspector to evolve independently.

- Treat delayed synchronization as explicit projection debt.
- Do not invent the expected future HizoFS shape in the Inspector before the authoritative HizoFS change exists.
- Restore complete synchronization with the current HizoFS at an explicit checkpoint.
- At a synchronization checkpoint, review the current authoritative DTOs, variants, references, and navigation edges rather than relying on the previous Inspector implementation as the inventory.

## Exhaustive projections

A complete view projection must not silently drop a newly added authoritative field or variant.

- Depend on the authoritative source type rather than copying its shape into an Inspector-owned type.
- When destructuring a complete DTO or nested object, collect the rest and require:

```ts
unhandled satisfies Record<PropertyKey, never>;
```

- Use `exactObject` for destination-side exactness.
- Handle discriminated unions exhaustively and converge the default branch to `never`.
- Intentionally undisplayed fields must still be destructured with an underscore-prefixed name and justified by a nearby why comment. Prefer displaying authoritative evidence over discarding it.
- When a boundary is genuinely dynamic or open-ended, do not invent a false closed world solely to satisfy exhaustiveness. Use bounded runtime validation and focused tests for that boundary.
