# HizoFS debug inspection

This directory is an internal developer and reviewer tool, not a general Naidan user interface.

Its purpose is to make encrypted HizoFS persisted structure inspectable without hiding the physical and logical evidence behind a convenience abstraction. It may consume the exact approved HizoFS persisted-format and inspection DTOs through the separately reviewed dependency-direction exception for this exact feature root.

## Audit fidelity

- Prefer direct use of authoritative persisted-format or inspection DTOs when an intermediate public abstraction could normalize, omit, or reinterpret evidence.
- Display both selected and rejected authority candidates, unknown values, corruption reasons, proof failures, physical references, and bounded/truncated observation metadata.
- Root-directory and similar shortcuts are additive navigation aids. They must not replace or hide A/B copies, segments, frames, records, indexes, or other physical structures.
- Reuse authoritative codecs, constants, record kinds, and reference types. Never duplicate format literals or infer persisted meaning in the debug feature.
- HizoFS core must never import this feature.

## Exhaustive projections

A view projection must not silently drop a newly added DTO field. When a projection destructures a complete DTO or nested object, collect the rest and require:

```ts
unhandled satisfies Record<PropertyKey, never>;
```

Use `exactObject` for destination-side exactness. Intentionally undisplayed fields must still be destructured with an underscore-prefixed name and justified by a nearby why comment. Prefer showing the field over discarding it.
