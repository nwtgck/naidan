# Transformers.js browser fixes

This is a version-bound Vite transformation, not an installed-package patch.
It applies only to the reviewed `@huggingface/transformers` 4.2.0 web bundle.
`npm ci`, `node_modules`, package scripts and the lockfile are unchanged. The
package's Node exports and raw source modules remain unmodified and are not
covered by this fix.

## What changes

Seven exact web-bundle edits address resource ownership, optional preparation and template parsing:

1. `getModelDataFiles` no longer uses an async Promise executor. Each external
   file's rejection now reaches the returned Promise instead of leaving an
   unhandled rejection and a permanently pending model load.
2. `getSession` observes core and external-data Promises together immediately.
   A failed core cannot become unhandled while external data remains pending;
   failures of later inputs remain observed after the first rejection.
3. Generic `PreTrainedModel.from_pretrained` completes optional configuration
   preparation before calling the session selector or constructing sessions.
   `get_optional_configs` retains a failed file's origin as
   `TransformersJsOptionalConfigurationError`, its original error in `cause`,
   and the filename plus original error name/message in the diagnostic message.
   The name remains distinguishable after Comlink transports an Error without
   its custom fields. Naidan classifies this specific origin as terminal; an
   ordinary backend Error or unrelated SyntaxError is not reclassified.
4. The bundled Jinja parser handles balanced `generation` / `endgeneration`
   blocks instead of deleting tag-shaped source text with a regular expression.
   The existing lexer handles whitespace controls, while recursive parsing
   retains nested statements and rejects malformed blocks. A parsed block uses
   the existing `Program` evaluation in the same environment, so body text and
   assignments are preserved without introducing a new scope. Quoted literals
   and runtime message contents are not rewritten. This is rendering support,
   not assistant-token masks, generation-span tracking or an AST formatting
   round-trip guarantee.

Resource selection, dtype, device, external binding paths, optional-file absence
defaults and successful constructor arguments are unchanged. Optional metadata
and sessions no longer run concurrently: a shared preparation failure must not
be mistaken for a candidate-specific session failure that another dtype could
repair. A family without optional configs still receives only its session
argument; an empty optional mapping still contributes an empty config object.

This does not add JSON validation, duplicate tokenizer data, add a timeout or
suppress global unhandled rejections. Existing optional files are parsed once by
the upstream reader. `Promise.all` remains inside the third-party module for its
dynamic inputs; it must not import Naidan's application helpers. Cache I/O errors
that upstream turns into misses still require Naidan's sticky resource-operation
boundary. Native work already in progress remains the owning Worker's lifecycle
responsibility. An unresponsive optional read can still require termination;
this ordering fix is not an I/O deadline.

## One browser build contract

`createTransformersJsFixesViteConfig` owns all three registrations used by
`vite.config.ts`: main module transforms, fresh Worker build plugins, and Vite 8
Rolldown dependency-optimizer plugins. Development, test and hosted builds use
this contract. Standalone facades do not use Transformers and register none of
these plugins; they do not acquire a new dependency validation requirement.

The factory validates the package version and all six recorded original input
hashes. It also executes and verifies the transformation eagerly, even if a warm
optimizer cache avoids the transform hook. The plugin name contains the approved
output hash so that a reviewed patch change invalidates Vite's optimizer cache.
Unknown originals, missing inputs, ambiguous edits, unexpected replacement
output, and already-transformed input fail closed. There is no automatic upgrade
or alternate unpatched browser path.

Original web SHA-256:
`25e0cbdf5df922996299fcd2cf835101ba979b134389a0dcc54f92022ca7e0ff`.
Transformed web SHA-256:
`875b33675dcf7b646f7f39d2680d2612040b1eb570f865a537aea1118658b731`.

`buildTransformersJsFixesArtifact` runs a real Vite library build with the same
plugin, `configFile: false`, and no application plugins. Runtime regression
fixtures consume that emitted code unchanged, not a test-only repair. Only ORT
imports are externalized; their original ESM entry identities are preserved.
The library artifact hash is reported separately from the fixed transformed
bundle hash because the emitted artifact contains local resolved ORT import URLs.
Those generated artifacts are temporary local test outputs, not public fixtures.

## Original evidence and maps

The pinned installed dependency supplies the unchanged
`src/utils/model-loader.js`, `src/models/session.js`,
`src/models/modeling_utils.js` and complete web bundle. `provenance.json` records
those input hashes, the installed package metadata and full web-bundle hashes.
Tests read these originals directly and verify their identities rather than
keeping redundant source copies. The four corresponding web sections are
extracted at reviewed boundaries; independent SHA-256 values in
`transform.test.ts` preserve their exact bytes, including trailing newlines.
Those section identities were verified against the former unmodified copies
before removing them. `upstream/LICENSE` retains the existing package notice.
`replacements.ts` contains the seven exact before/after web edits as `String.raw`
literals. Their whitespace and trailing newlines are part of the edits; they are
not trimmed or normalized. This keeps source backslashes readable without JSON
escaping. The full original web bundle is supplied by the pinned dependency,
not redundantly copied here.

The unchanged Jinja section is extracted directly from that exact original
browser bundle. Its source marker identifies Jinja 0.5.6;
the separately installed `@huggingface/jinja` 0.5.9 lexer differs and is not used
as a matching source baseline or replacement runtime. The section includes the
lexer, parser and interpreter needed to execute original failure evidence.
Its SHA is recorded in `bundledJinja`. `upstream/jinja/LICENSE` retains the MIT
notice available from the installed Jinja 0.5.9 package; provenance identifies
that notice's source separately rather than claiming possession of a 0.5.6
source package. The original bundle section and model templates remain unchanged.

Only the two existing license notices remain under `upstream/` in this
implementation; retaining them preserves existing notices, without changing
their provenance or making a new licensing determination. The corrected code
is the result of `applyTransformersJsFixes`, emitted by Vite, not a second
runtime imported by Production. Future source-derived
fixes may keep a locally modified upstream file when appropriate, provided its
changes and original baseline remain distinguishable. Preserve upstream code
structure and use the upstream-file lint exemption instead of burying a fix in
Naidan style-only changes. The integration code and tests remain normally linted.

The map keeps the original web bundle as `sourcesContent`. The installed bundle
does not provide a source map to individual upstream source files, so this layer
does not claim source-level symbolication into the three original source files.
Integration tests check that emitted map source names are relative, not developer
home paths or file URLs. Public provenance contains no investigation ZIP, run
identifier or local input path.

## Verification and removal

Run from the repository root:

```sh
npm run test:only-failed -- build/transformers-js-fixes --maxWorkers=1
```

The small consumer tests execute sections of the actual transformed bundle.
They cover held core/external inputs, early and late rejections, excessive chunk
counts, synchronous external throws, optional-before-session ordering, typed
origin/cause, unchanged absent/default constructor arguments, and byte identity without an
unhandled-rejection suppression handler. Integration tests cover a real Vite
library build, real Worker bundle, development Worker/dependency transforms,
and cold/warm dependency optimization with unknown-original rejection. They do
not launch a browser or prove WebGPU, OPFS, or browser Worker termination.

The ordinary model-specific runtime regressions use this same artifact builder;
their unmodified original-source and selector contracts still examine installed
upstream evidence. Successful model/resource tests are not ONNX inference claims.

On an upstream update, first determine which failures are fixed. Preserve
and review the new source evidence and independently rerun the consumer and
model-specific tests. Never refresh expected hashes merely to make checks pass.
Remove each fix when the reviewed upstream browser bundle addresses its failure
and the corresponding regressions pass without that transformation. Remove
the integration when no fix remains necessary.
If an update still needs a fix, review a new bounded transformation and its cache
identity instead of widening this one to accept arbitrary versions.
