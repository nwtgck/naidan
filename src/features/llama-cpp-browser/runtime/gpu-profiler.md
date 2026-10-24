# Existing GPU timestamp readback waits

The profiling observer reuses timestamp queries, resolution, copies and maps
already requested by the profiling Wasm. It does not add GPU work or a queue
wait. The ordinary profile never installs this observer. This addition does not
require another runtime variant or a consumer API change.

`gpuProfile.readbacks` is optional in version-one archives. New observations
carry source `existing-timestamp-buffer-mapAsync`, `phaseAt: map-request` and at
most one row per prefill/decode/checkpoint/other phase. The raw and summarized
GPU archive files retain these rows; ordinary throughput summaries remain
separate and exclude the profiling lane.

For MAP_READ buffers containing unconsumed timestamps of an open measurement,
measure from the existing `mapAsync` call to its observed Promise settlement.
Return the original native Promise with the same fulfillment/rejection; do not
await it on the caller's behalf. Preserve the native buffer identity and receiver
brand. An unrelated mapping, closed request or consumed timestamp does not read
the clock or attach a timing reaction. No browser prototype is modified.

Rows record requested/completed/rejected/pending maps, invalid timings, total
and maximum wait milliseconds. The phase is captured at the map request, not
at timestamp encoding or eventual delivery. GPU pass rows retain their separate
encoding-phase semantics. A closed request is immutable: late settlement is
neither added to its exported result nor reassigned to a following measurement.
Invalid or throwing clocks never change native inference outcomes or add
non-finite numbers. Pending, rejected and invalid observations mark a measured
profile partial rather than silently claiming complete coverage.

This is **host-observed mapping wait**, not GPU idle time, kernel execution time,
page-fault time or swap evidence. It can contain queued work, driver processing,
mapping and JavaScript scheduling. Concurrent waits may overlap each other and
native decode waits. Do not add their sum to GPU pass time to reconstruct wall
time. The timing reaction adds a small amount of JavaScript work in the profiling
lane; it does not claim zero profiling overhead. The normal non-profiling path
is unchanged.
