# Model regression tests from investigation evidence

## Purpose

Use Model Support Investigation evidence both to assess whether Naidan handles
a model correctly and to preserve verified Download and Provider contracts in
browserless regression tests. A model that already works with the existing
implementation is also worth protecting; a model-specific Production change is
not a prerequisite for adding tests.

Reproducing a recording is not, by itself, a successful model-support check.
Read the actual public inputs and outputs and assess their meaning against the
relevant contract: resource availability and Offline Load, thinking and answer
boundaries, message history, tool execution, or image handling. A recording can
faithfully reproduce a Naidan defect. Passing that observation-based test must
not turn the defect into the desired behavior.

A useful outcome of changing shared Production code is that model-specific
tests, evidence, and expectations remain unchanged and pass. When an intended
contract change requires different expectations, make the affected models and
the changed behavior reviewable.

## Test boundaries

| Test | Responsibility |
| --- | --- |
| `download-replay-<model>.test.ts` | Download, completed cache files, and Offline Load using those files |
| `provider-replay-<model>.test.ts` | Actual `LmProvider.chat()` input conversion, generation calls, output interpretation, tools, continuation, and settlement |
| `model-runtime-input-replay-<model>.test.ts` | Original metadata, tokenizer or processor inputs, and runtime artifact requests without entering the public Provider |
| `model-load-allocation-replay-<model>.test.ts` | Observed resource sizes refused before large allocation through the actual model reader, separately from explicitly tiny read/copy/session controls; not browser memory capacity or ONNX inference |
| Replay infrastructure tests | Evidence readers, input gates, Worker transport, test platforms, and cleanup |

Provider replay replaces expensive weight-based inference with recorded data.
Production input preparation, transport, and output interpretation still run.
Release recorded output only after checking the actual input, settings, and
required state. This does not certify real GPU execution, answer quality, or
device memory requirements. Direct tokenizer or processor controls have a
different boundary from tests that enter through the Provider.

Terms used below:

- **Candidate:** an execution choice, such as a device and dtype combination.
- **Required-file plan:** files needed to load a selected candidate.
- **Fresh Offline Load:** load from existing completed cache files in a new Worker,
  rather than reusing a loaded instance. It does not mean deleting the cache.
- **Evidence:** recorded inputs, outputs, resources, or execution conditions.
- **Expectation:** behavior selected as the test's comparison contract. An
  observation is not automatically a correctness oracle.

## Finding related tests

Model-local tests and evidence belong together under
`src/features/transformers-js/replay-models/`. Model directories include the
repository owner; evidence also retains the exact model ID. The `support/`
directory contains infrastructure shared by the model tests.

Within a model directory, prefixes group Download, Provider, and shared model
resources in filename-sorted views. For example:

```text
replay-models/
  huggingfacetb--smollm2-135m-instruct/
    download-replay-smollm2-135m.test.ts
    provider-replay-smollm2-135m.test.ts
    provider-<request>.evidence.json
    model-<resource-context>.json
  support/
    ...
```

Use the existing tests for the exact model and tests with comparable contracts
as working examples. A similar architecture does not establish identical
prompts, artifact paths, capabilities, or expected outputs.

Starting points for reading the implementation:

| Example | What to inspect |
| --- | --- |
| [SmolLM2 135M Download](./replay-models/huggingfacetb--smollm2-135m-instruct/download-replay-smollm2-135m.test.ts) | Fresh acquisition, reuse, and terminal failures after planning |
| [SmolLM2 135M Provider](./replay-models/huggingfacetb--smollm2-135m-instruct/provider-replay-smollm2-135m.test.ts) | Recorded output, supplied history, and same-runtime conversation boundaries |
| [Gemma 4 E2B Provider](./replay-models/onnx-community--gemma-4-e2b-it-onnx/provider-replay-gemma4-e2b.test.ts) | Processor, tool, and image contracts with distinct evidence limits |
| [SmolLM2 135M runtime inputs](./replay-models/huggingfacetb--smollm2-135m-instruct/model-runtime-input-replay-smollm2-135m.test.ts) | Independent metadata identities and native input controls |
| [Causal gate controls](./replay-models/support/provider-replay-test-causal-gate.test.ts) | Rejection of mismatched inputs before releasing recorded output |

## From evidence to a regression

### 1. Identify existing protection

Read the model's tests, fixtures, and the infrastructure they use. For each
contract, identify what is already protected, what the evidence can add, which
conditional behavior applies, and what remains unobserved.

Inspect assertions and registered cases, not just test declarations. A filtered
`it.each()` table with no rows supplies no coverage for that contract.

### 2. Classify the source and its conditions

Keep these categories distinct:

| Source | Permitted claim |
| --- | --- |
| Recorded input and output | Replay after validating the corresponding conditions |
| Input-only capture | Verify the input boundary |
| Output prefix | Verify the recorded range, not an invented complete ending |
| Observed Provider failure | Verify its conditions and point of failure |
| Investigation or collection failure | Describe collection limits; do not infer model incompatibility |
| Source-derived control | Explain the derivation; do not label it a captured result |
| Unexecuted or missing observations | Record the evidence gap |

Check relevant model ID, revision, template, device, dtype, Load route, and cache
state. If a new recording differs from an existing expectation, determine
whether this is a regression, an intended change, or a difference in conditions.
Do not automatically adopt the newest ZIP as the new expected behavior.

### 3. Choose applicable contracts

Use the patterns below to select concrete tests. Evidence may justify an input
test without justifying output replay. Missing evidence is neither success nor
proof of non-support. Do not fill a checklist with empty or skipped tests.

For the same contract, comparable titles and a simple-to-complex order make
new tests easier to compare across models. Use distinct titles when the actual
contract or verified boundary differs.

### 4. Select public fixture data

Keep only data needed by the tests. Exclude personal information, unnecessary
logs, identifying local environment details, and whole investigation archives.
Retain publicly safe execution conditions, such as runtime versions and the
backend, when they are necessary to interpret the evidence.

Preserve original metadata and token data where simplification would alter the
runtime path. Ordinary tests must use repository-owned fixtures, not private
ZIPs, evidence-path environment variables, or external network access. Loopback
fixtures may emulate remote services. Incomplete fixtures must fail closed.

Do not fabricate or alter replay data to make the desired assertions pass
without an explicit user instruction authorizing substitute data. In particular,
do not invent missing inference results, tokens, stream observations, or cache
state when a recording cannot support the correct behavior. Keep the original
observations intact. Any explicitly authorized synthetic data must remain
identified as synthetic, never as a browser observation.

Synthetic mechanics or input-boundary controls test a different contract; they
must not supply an unobserved model result or stand in for successful replay of
that result.

See [original model runtime fixtures](./replay-models/support/model-runtime-fixtures.md)
for metadata byte preservation, explicit absence, and the synthetic model-body
boundary used by Download tests.

### 5. Assess behavior and exercise Production against independent expectations

Explain the basis of each expectation. If the implementation violates that
contract, let the test fail; do not update the expectation merely to obtain a
pass. Production fixes are a separate scope decision.

For each investigated contract, distinguish these outcomes:

- Correct behavior under the recorded conditions: preserve it as a regression.
- A reproducible defect: retain the original evidence, state the correct
  expected behavior, and demonstrate a failing test before an authorized fix.
- Insufficient or no longer applicable evidence: verify the boundary the data
  supports and record what additional observation would close the gap. Do not
  call the model unsupported, or successfully supported, on that basis alone.

After a fix, check whether later inputs or runtime state change. For example,
correcting a delivered answer can change the history supplied to the next
request. Recorded native output for the old input must not be released for the
new input by weakening or rewriting the replay gate. Keep historical conditions
explicit, and distinguish an input-only control for the corrected path from an
output replay backed by applicable evidence.

When the correct behavior requires observations that are missing or invalidated
by a fix, ask the user to collect new investigation data. First prepare the fix
and the necessary capture path, then identify the affected models, scenarios,
and required observations so the user can collect them together where possible.
An input-only test or controlled evidence-limit stop can guard the replay
boundary meanwhile, but does not prove the missing successful model behavior.
Report that behavior as unverified until applicable evidence is available.

Distinguish an observed Provider error from an intentional test boundary stop,
a replay input mismatch, and missing evidence. A generic rejection is not enough
to prove the expected negative behavior: verify the reached boundary and the
source of the error.

## Download patterns

Use this order as a starting point for new model tests:

| Pattern | Contract and relevant branches |
| --- | --- |
| Metadata | Fresh preparation and observation without downloading model bodies |
| New Download | Selected files are fully written, marked complete, and usable in a fresh Offline Load |
| Reuse | Completed artifacts are not transferred again unnecessarily |
| Interrupted acquisition | Explicit retry of missing artifacts; distinguish this from HTTP byte-range resume |
| Candidate selection | Availability, absence, incomplete candidates, and permitted fallback |
| Metadata integrity | Required absence, optional absence, corrupt existing data, and read failures |
| Post-plan invariants | Disappearing files, unplanned requests, and inappropriate fallback |

Optional absence, healthy presence, and corrupt presence are different
conditions. Derive their expected handling from the relevant resource contract.
Repository existence and actual runtime consumption are also different facts.
Do not generate the expected file set by calling the same planner being tested.

Offline Load must preserve the architecture boundary: no Hugging Face requests,
implicit Download, OPFS writes, or cache repair; missing required local files
are terminal. Network access is limited to necessary same-origin runtime assets.
Local embedded image decoding is not remote network access.

Coverage of retry mechanics in a shared Worker test is not evidence that every
model-specific replay has exercised retry.

## Provider patterns

Use this order as a starting point:

| Pattern | Contract |
| --- | --- |
| Basic input | Public messages reach the expected native input boundary |
| Basic output | Recorded callbacks are interpreted and delivered before settlement |
| System instructions | System input is preserved through preparation |
| Supplied history | Caller-provided assistant history is represented correctly |
| Independent next conversation | Previous requests do not contaminate a new conversation in the same runtime |
| Reasoning | Effort handling, thinking, and visible output |
| Tools | Definitions, calls, arguments, execution, results, and continuation |
| Images | Image preservation, processor inputs, and any recorded output |
| Sequences | Cross-request state, ownership, and settlement |

Examples of comparable titles are `preserves system instructions at the native
generation boundary`, `delivers the recorded callbacks before settlement`, and
`keeps a new conversation independent of the previous request`. Input-only tests
and output replay tests must not imply the same coverage.

### Conditional tool contracts

| Available evidence | What to test |
| --- | --- |
| Recorded calls and execution | Notifications, arguments, ID relationships, execution count, results, and continued generation |
| Established non-support behavior | The actual negative contract, such as explicit refusal |
| Input handling only | Preservation or omission of definitions, arguments, and results at that boundary |
| No call in the recorded response | That response's behavior, not model-wide non-support |
| Insufficient evidence | The verifiable subset and the additional evidence needed |

These are decisions made when writing model-local tests, not a reason to put
model-specific branches into a universal test generator.

## Replay completeness

Input equality alone does not prove that all required work occurred. Verify the
expected generation calls and their order, tool execution and continuation,
notifications, settlement, and absence of unexpected extra calls. Detect missing
calls as well as mismatched calls.

For a prefix capture, specify the verified range instead of imposing a complete
recording's termination contract.

## Evidence ownership and changes

Split evidence at boundaries whose changes should be reviewed together. A public
Provider request is a useful unit: keep the initial generation, tool execution,
and continued generation of that request together. Sequence definitions can
refer to request evidence with explicit order and dependencies.

Adding a case should not update unrelated expectations. Re-recording alone does
not require replacing the source attribution of existing cases. Keep historical
prefixes, input-only captures, and pre-fix outputs distinguishable from current
complete recordings.

Make source and execution-context references traceable. A change to shared
metadata, Load context, or comparison code may change model expectations even
when the model's test file has no diff. Identify the affected models and changed
expectations in review. Do not let a shared reference silently redefine older
cases. Source capture ordinals describe provenance, not necessarily the order
of a newly selected replay sequence.

Share evidence between tests when changes to that expectation should affect
both consumers. Equal values alone do not require shared ownership.

## Stateful tests

File boundaries and execution boundaries are separate choices:

- Build conversational continuation from the first request's actually delivered
  and settled output.
- Test independent-conversation isolation after a preceding request in the same
  runtime, rather than only in an empty runtime.
- Keep the native calls inside one tool-enabled `Provider.chat()` together.
- Exercise the preceding cache-producing conversation when testing isolation
  from its cache.

Independent `it()` cases must not depend on execution order or shared mutable
runtime state. Execute the required chain inside the test. Keep sequence-level
checks for ownership, expected call inventory, Load lifetime, and cleanup.

## Shared infrastructure

Share a responsibility when its changes should propagate to all its consumers,
not merely because code or values currently look alike. Worker setup, evidence
reading, gates, and cleanup are examples of potentially shared responsibilities.

Model-specific revisions, resource sets, prompts, tokens, settings, outputs,
and failure expectations must remain independently reviewable. Avoid generating
the expected result with the same Production implementation being tested.

### Model-local public contracts

Keep the public behavior readable in the model's `it()` body:

- Write the model ID, messages, parameters, tools, and each chat invocation in
  the model test. The invocation may use `provider.chat()` directly or a thin
  callback-recording helper such as `captureProviderChat`. Do not reconstruct
  requests in a shared scenario dispatcher from the same evidence that supplies
  the expected outcome. Prefer inline short messages and parameters when they
  are only passed to that request. Keep separate variables when they have a
  meaningful additional use, such as an independent input check or a stateful
  conversation; avoid long explicit type annotations when contextual typing
  already expresses the contract.
- Record observations in public callbacks and tool implementations, then
  assert after awaiting the chat. Capture mutable arguments by value when later
  mutation could change the observation. Do not rely on assertions inside a
  callback: an uncalled callback would perform no assertion, and callback errors
  may be handled by Production.
- Apply the same separation to input-only inference callbacks: capture the
  native inputs, stop without supplying inference output, then assert the
  observations and invocation count after the chat rejects at that intentional
  boundary. Tensor contents must remain observable independently of subsequent
  mutation or disposal. A boundary stop is control flow, not proof that the
  input was correct.
- Assert response text, thinking boundaries, tool arguments and results,
  relevant ID relationships, counts, and ordering explicitly. For readable
  text contracts, collecting chunks and comparing `chunks.join('')` is useful;
  keep separate assistant responses separate. Preserve exact chunk boundaries
  and cross-callback ordering where those are part of the contract.
- Check that expected callbacks actually occurred and unexpected callbacks did
  not occur. An empty observation list must not pass a positive-path test.
- Show successive `chat()` calls in the same test when state matters. Build
  conversational history from the preceding actually delivered, settled output;
  do not hide that dependency in a shared request runner.

Shared mechanics may prepare and dispose the real Provider environment, read
native evidence, and enforce replay input, state, and call-inventory gates.
Those gates must reject a mismatch before releasing recorded inference output;
they are not public callback assertions and must not be deferred until after
the replay. This requirement does not justify keeping input-only expectations
inside a `generate` callback that releases no recorded output. Shared code must
not choose a model's desired public behavior or
silently normalize its expected result.

A shared chat recorder may call the supplied Provider with the explicit request
and collect callback observations. It must preserve rejection and expose the
observations without selecting assertions, interpreting model capabilities, or
normalizing text. Keep tool implementations and their execution observations in
the model test; do not replace them with fixture-driven tool behavior. Preserve
settlement, unexpected-callback, and late-callback checks when moving recording
boilerplate into the helper. The helper's mechanics tests do not replace the
model-local assertions.

Whole-investigation ownership tests have a different responsibility: they may
drive the real collection sequence through shared infrastructure to check Load
lifetime, native capture, exact event traces, and cleanup. They do not replace
readable model-local public contract tests. When relying on such a test to
preserve detailed trace coverage, confirm that it covers the same model, case,
and execution conditions. A recording from another case is not equivalent.

## Running and reviewing

From the repository root, run the relevant model tests and changed infrastructure:

```sh
npm run test:only-failed -- src/features/transformers-js/replay-models --maxWorkers=1
```

A model directory or specific test file can be selected for a narrower check.
One worker limits concurrent runtime and tokenizer memory use.
For shared changes, also cover the affected models and relevant integration
tests outside that directory. Follow the repository's lint and type-check rules.

Review whether:

- Observed behavior has been assessed against the intended contract, rather
  than automatically accepted as correct because it can be replayed.
- Existing successful and failing contracts remain protected.
- Expectation changes have a basis and an identifiable affected model set.
- Shared data or comparison changes have not silently changed the oracle.
- Missing and additional calls are detected, not only mismatched inputs.
- Evidence gaps, non-support, observed failures, and infrastructure failures
  remain distinguishable.
- Claims stay within the replay boundary rather than certifying real inference.

When combining, splitting, or removing tests, map their protected assertions to
their destination. Equal test counts alone do not demonstrate preserved coverage.
