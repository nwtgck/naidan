# Scoped WebGPU dispatch compatibility

## Ownership and scope

This is a Naidan-owned WebGPU API adapter, not a new lcore artifact, a llama.cpp
source patch, or an implementation of a model's image encoder. It retains the
installed native source/binary pins and the existing exact-source build checks.
The existing browser-core build adapter gives each WebGPU factory a lexical
`navigator` supplied by `createCore`. No global `navigator`, GPU prototype, device
limit, installed dependency file, or Wasm byte is changed. Hosted and standalone
builds share this boundary. CPU factories do not receive the adapter.

The adapter observes shader/pipeline/bind-group creation and compute dispatches.
Native shaders and pipelines are used unchanged for legal-sized dispatches.
An oversized **direct** dispatch uses GPU shader variants which translate entry
point builtins back into the original logical dispatch coordinates. Only entry
parameters and their coordinate aliases change; the numerical kernel, resource
declarations, storage buffers, offsets, and tensor data remain unchanged.
There are no model names, architecture tables, image-token budgets, image resize
operations, automatic CPU retries, new network requests, or added dependencies.
The upstream scheduler's existing CPU fallback for unsupported operations remains
unchanged; this adapter does not claim that every native operation uses a GPU.

## Why dispatch chunking needs shader adaptation

`maxComputeWorkgroupsPerDimension` limits each of X/Y/Z, not their product. For
116100 rows and a device limit of 65535, two physical X dispatches cover 65535
and 50565 rows. Their logical X origins are 0 and 65535. The second dispatch
must not restart at row zero.

For an origin `o`, physical workgroup ID `w`, physical global invocation ID `g`,
workgroup size `s`, and original logical grid `n`, the variant preserves:

- `workgroup_id = w + o`;
- `global_invocation_id = g + o * s`;
- `num_workgroups = n`.

Local invocation and subgroup builtins remain native. Pipeline override constants
carry `o`/`n`, without extra tensor buffers or CPU readback. Each chunk is exact;
no padded workgroup can access a nonexistent row. All axes can be partitioned.
If `num_workgroups` is absent, origin zero can use the original pipeline. This
also handles shaders which already flatten a multidimensional logical grid.

Generic two-dimensional padding would require knowledge of each kernel's bounds
checks. Exact chunks avoid importing that model/operator-specific knowledge.
Splitting only the API call, without the shader aliases, would silently compute
the wrong rows and is explicitly not supported.

## Resource and state contracts

Shaders, compute pipelines, bind groups, buffers, and command buffers exposed to
native code are actual browser objects, not stand-ins. The navigator, adapter,
device, command encoder, and compute pass have scoped forwarding facades; native
methods retain their real receivers for WebIDL brand checks and event setters.
Creation descriptors and dynamic-offset views are snapshotted at call time.

Auto pipeline layouts have pipeline-exclusive compatibility. Every specialized
pipeline therefore obtains compatible bind groups with the same resource entries,
not the original auto-layout groups. Bindings outside the current shader's group
indices are left untouched. The original pipeline and bindings are restored even
when the caller omits redundant setters for its next direct/indirect dispatch.

Variants are cached per original pipeline (at most 16 retained specializations);
resource associations use weak maps. Planning/descriptor preparation completes
before any chunk of the affected dispatch is encoded. Diagnostics report the
first split for a pipeline (`native-info`, `nativeOperation: dispatch-split`) with
numeric counts only. A diagnostic subscriber's exception cannot alter GPU work.

## Deliberate limits and failure behavior

This is not a general WGSL compiler. Only the reviewed ggml-style grammar is
adapted: one void compute entry, direct builtin parameters, scalar literal or
identifier workgroup sizes, and literal resource group indices. Nested comments
are handled. Unrecognized syntax, reserved-name collisions, untracked resources,
and a plan larger than 256 chunks fail explicitly; no work is silently truncated,
no shader body is guessed at, and no resolution/backend fallback is attempted.
A new native shader form requires review rather than an unverified rewrite.

Indirect dispatches are forwarded unchanged. The affected native backend uses
direct dispatches; supporting an oversized GPU-generated indirect count would
require a different design. Buffer-size limits, allocation failures, device loss,
other kernel bugs, cancellation, and model support are outside this fix.
Browser validation and device-loss errors remain visible through existing paths.
The adapter cannot make an invalid or unsupported numerical kernel valid.

## Cost and removal

GPU tensor processing remains on the selected backend; this is not CPU image
encoding. The costs are scoped JavaScript forwarding, extra dispatch commands,
coordinate arithmetic, and first-use variant compilation/bind-group creation.
No hardware performance guarantee is made. Pipeline caching avoids repeating
most compilation for subsequent tensors with the same chunk origins.

An upstream native dispatch fix remains preferable long-term. Once the pinned
backend correctly schedules these grids, they pass through unchanged; after
native coverage is verified, remove this adapter, the factory binding, and its
specific tests. Do not weaken the existing artifact/hash guards to accept a new
lcore version without reviewing the JavaScript factory boundary.

## Verification boundaries

Unit tests cover exact coverage, limits, descriptor/offset snapshots, logical
builtins, pipeline-exclusive layouts, cache eviction, state restoration, error
propagation, lazy acquisition, and multiple devices. Existing projector/session
and profile tests retain their previous GPU-selection behavior. Build integration
tests assert the lexical insertion for GPU profiles and unchanged CPU factories.

Real-device inference and GPU numerical comparison are separate requirements;
mock GPU tests and a successful TypeScript check are not substitutes for them.
