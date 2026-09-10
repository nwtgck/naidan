# Original model runtime fixtures

These are checked-in, model-specific test inputs. Tests require neither an
investigation archive, an environment variable, nor a network connection.

Each `replay-models/<owner>--<repository>/` directory owns its
`model-runtime-inputs.evidence.json` and `model-*` original metadata assets.
Large `model-tokenizer.json.gz` assets are losslessly compressed single JSON files,
not investigation archives. The fixture reader bounds decompression and checks
the original byte length and SHA-256 before use. Small JSON and Jinja
templates retain their original bytes, including line endings. Equal bytes in different model directories
do not make the corresponding model contracts interchangeable.

The selected 52 original files total 116,075,337 decoded bytes and 22,628,559
stored bytes, excluding manifests and this document. Vocabularies are not
reduced or synthesized. No model weights are included.

The model ID, immutable revision and resource path identify the public upstream
source. Investigation IDs, timestamps, user messages, generated output, local
filesystem paths, request headers and cache inventories are not source data
for these tests and are not included.

## Selection and absence

All models include config, tokenizer config, tokenizer vocabulary and generation
config. Processor/preprocessor originals are included for Gemma and Qwen.
Only Gemma's current processor reads an external Jinja file; other current
routes use the template inside tokenizer config. Fresh investigation also
supplements the replay with allowlisted metadata not consumed by that runtime
preparation. Its external templates and special-token maps are therefore included;
they are not additional required Production artifacts.

All ten collector paths have explicit presence or repository-absence evidence
for each model. The empty-cache evidence confirms the pinned revisions and
previously selected original bytes. SmolLM2-1.7B's special-token map timed out
in that run; its original bytes come from an earlier successful observation at
the same immutable revision, not an invented absence or a new network request.
Successful replay of those bytes does not reclassify the recorded timeout.

Each manifest includes the complete recorded `onnx/` path/size inventory,
including other dtypes. This lets tests distinguish actual repository
availability from counterfactual request selection and catch an unquantized
fallback. Sizes describe upstream artifacts, not the tiny synthetic bodies used
at the instrumented ORT boundary. Metadata absence is explicit; an unrecorded
metadata request is missing evidence and fails closed, never an implicit 404.
The manifests are selected test evidence, not a new Production persisted format
or a complete repository/runtime-input certificate.

## Running

Run from the repository root with the normal configuration:

```sh
npm run test:only-failed -- src/features/transformers-js/replay-models/*/model-runtime-input-replay-*.test.ts --maxWorkers=1
npm run test:only-failed -- src/features/transformers-js/replay-models/*/download-replay-*.test.ts --maxWorkers=1
```

Each `model-runtime-input-replay-<model>.test.ts` and `download-replay-<model>.test.ts`
independently fixes its revision, raw hashes, route and artifact expectations.
The shared harness executes those contracts; it must not regenerate expected
sets from observed requests.
The model tests and connected Download tests are ordinary CI-discovered tests.
Missing or corrupt checked-in data is a test failure, not a skipped lane.

The Transformers.js web runtime emitted through the same
[Vite fix integration](../../../../../build/transformers-js-fixes/README.md)
as Production constructs tokenizers/processors and selects model resources.
The installed upstream files remain unchanged; each operation imports a fresh
runtime instance from the verified Vite artifact. Connected tests retain Naidan orchestration,
cache adapters and writers. Fixture boundaries replace the native FileSystem,
remote responses, Worker client construction with direct exposed-API facades,
heavy ORT session creation and model bytes. This does not prove ONNX validity, generation semantics,
browser OPFS, GPU compatibility, actual Worker transport or concurrent Realms.
The connected per-model service cases also execute Naidan's revision resolver
and cache-reuse coordinator. Cold service cases discard the previous service
instance and revision hint, then select the local immutable revision again.
This models ownership through direct client facades, not physical Worker
termination; transport and Worker lifecycle have separate regression tests.

Synthetic model bodies carry model/revision/path identities. The instrumented
ORT boundary checks those identities and external-data bindings against
independent per-model expectations; these are not valid ONNX models and do not
establish real weight integrity or GPU execution. Missing-resource and interrupted
write cases exercise failure paths without downloading the upstream weights.
Do not change model expectations, suppress tests, or infer runtime success from
the synthetic session boundary to make a regression pass.

## Evidence roles

`model-runtime-inputs.evidence.json` is the manifest for original metadata bytes.
Its resource paths and digests remain upstream identities even though stored
asset filenames use a `model-` prefix. `model-parsed-metadata.evidence.json`
is an older parsed-JSON observation, not a byte-preserving replacement. Its
shared source attribution and explicit collection membership live in `support/`;
model-specific route, artifact, and absence expectations remain in model tests.

`download-repository.evidence.json` records historical repository facts and
`model-historical-load.evidence.json` records the historical selected route.
They do not automatically redefine the current Production route. The explicit
Causal planner prepass controls intentionally differ from current Qwen image
routing. Missing observations are not model non-support or repository absence.

The Download test groups follow metadata, new Download and fresh Offline Load,
completed-artifact reuse, candidate availability, metadata integrity, and
post-plan invariants. No per-model retry case is claimed unless it actually
executes retry. Memory-file and synthetic-session platform tests protect shared
mechanics rather than adding model coverage.
