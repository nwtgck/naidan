# Native notices

Both installed bicore dependencies supply a runtime-local
`native-license-index.json`. This is a build input, not an extra public asset.
The lazy `virtual:naidan-licenses` payload combines these records with the existing
JavaScript package records and compresses their notice text together.

## Contract

`index-types.ts` is the consumer's structural contract. The literal JSON imports
in `llama-index.ts` and `image-index.ts` use `satisfies`; do not replace them with
`JSON.parse(...) as ...`, a wildcard JSON declaration, or a declaration supplied
by the artifact itself. There is no schema-version or accepted-release list.
`typecheck.ts` checks only the selected adapter and its inputs before use, even
when Vite is invoked without Naidan's normal typecheck command.

Names, IDs, versions, identifiers and documents are data, not a Naidan allowlist.
Paths are relative to the selected runtime package. `notices[].path` names the
complete displayable notice. Optional `sourcePath` names its retained original
when bicore extracted comments from an embedded source. Additive JSON fields are
allowed; never silently change an existing field's meaning. Unknown version and
license identifier values are null, not guessed values.

The normal import is compared to the bytes verified by the existing bicore
manifests. Those manifests supply their own hashes; no license or release hash
is embedded in Naidan. Module-cache/config-bundle mismatch fails explicitly
rather than pairing new runtime bytes with old notices.

`NAIDAN_STABLE_DIFFUSION_CORE_DIR` is arbitrary external input, so only that path
uses a Zod shape check. It must not import the installed package's notices.
Standalone and missing optional image installations do not load the image index.
The two runtime dependencies may refer to different bicore revisions.

JavaScript package auditing retains its existing name/version contract. Native
records have runtime-qualified IDs and a display origin; same-name records are
not overwritten. Compression is lossless and does not merge software identities.

## Updating artifacts

Publish bicore artifacts containing both native indexes, then update Naidan's
normal dependency specifiers and lockfile. Do not invent a publication commit or
reuse an old dependency pin as if it contained the new files. Missing indexes
fail with an actionable error. Original notices remain in bicore artifacts;
Naidan does not emit separate native notice files.
