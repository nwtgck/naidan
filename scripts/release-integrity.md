# Release integrity

New tag publications attach `naidan-release-integrity.yaml` to the GitHub
Release and create one GitHub artifact attestation for its exact SHA-256
digest. The YAML binds the committed-source tree fingerprint to every
uploaded distribution ZIP, server archive, Linux package and `checksums.txt`.
It includes the complete Bash fingerprint recipe and a checksum verification
block. No project-specific Python, YAML parser, or package installation is
needed to copy and audit those commands.

The attestation authenticates a statement made by the selected GitHub Actions
workflow. Trusting that workflow and GitHub-hosted runners is a prerequisite.
It does not prove that the program is safe, that a dependency or compiler
cannot influence a build, or that a reproducible rebuild produces equal bytes.

## Verify a download

Choose the expected tag and source revision independently. Download the YAML
and the distribution files you intend to use. Verify the YAML **before trusting
its data or running a command copied from it**:

```bash
gh attestation verify naidan-release-integrity.yaml \
  --repo nwtgck/naidan \
  --signer-workflow nwtgck/naidan/.github/workflows/sync-release-notes.yml \
  --source-ref "refs/tags/$EXPECTED_TAG" \
  --source-digest "$EXPECTED_SOURCE_COMMIT" \
  --deny-self-hosted-runners
```

`gh` is the GitHub command-line interface. The signer is the reusable
`sync-release-notes.yml` workflow, not its `main.yml` caller. A stricter verifier
may also pin `--signer-digest` to the reviewed signing-workflow revision.
Neither the repository nor a tag alone identifies an acceptable workflow
revision; review the YAML and invoked code at the expected commit.

After successful attestation verification:

1. Check `release_tag` and the source repository/commit against your expectations.
2. Hash your downloaded files and compare each file's `size` and `sha256`.
   The included `verification.artifacts` Bash block checks all listed hashes
   with GNU `sha256sum --strict --check`. It requires every listed file; for a
   selective download, compare only your selected files' entries.
3. To check the source, recursively check out `source.commit` and run the
   `source.tree_fingerprint.reproduce` block from that checkout's root.
   Compare its output with `source.tree_fingerprint.value`.
4. To check the complete current release, also compare its uploaded asset
   names with the YAML inventory plus `naidan-release-integrity.yaml` itself.
   Hash checking listed files alone does not detect unrelated extra files.

The source fingerprint is independent of Git's commit object hash. The commit
is still a useful locator; compare the content fingerprint against a trusted
source copy when independence from the commit hash matters.

This strengthens source-content comparison; it does not replace the Git-based
identities in GitHub's workflow certificates or remove SHA-1 from the entire
provenance chain. The reviewed workflow computes and asserts this fingerprint;
GitHub does not independently recompute and certify it. An authorized malicious
workflow could sign a false source claim. Expected signer/ref/revision policy
and trust in the actually executed, reviewed workflow remain prerequisites.

## Fingerprint specification

The shared Naidan/browser-inference-core scheme is
`git-committed-tree-sha256-v1`. SHA-256 means Secure Hash Algorithm 256-bit.
For each committed Git entry, append the following binary record:

```text
Git mode, NUL, raw relative path, NUL, lowercase content SHA-256, NUL
```

NUL is the zero byte. Records follow the native recursive order of
`git ls-tree -r -z --full-tree`, not a global sort of full paths. Hash the
concatenated records with SHA-256. An empty tree hashes the empty byte stream.

| Git mode | Contents hashed |
| --- | --- |
| `100644` | Exact committed regular-file blob bytes |
| `100755` | Exact committed executable-file blob bytes |
| `120000` | Exact symlink target text; the target is not dereferenced |
| `160000` | Recursive fingerprint of the initialized submodule at its recorded commit |

All names, including spaces, tabs, newlines and non-UTF-8 bytes, are represented
without a text escaping convention. A mode, filename, content or submodule
content change affects the fingerprint. Commit authors, timestamps, messages,
history, index contents, worktree modifications, untracked files and fetched
dependencies are excluded. A different submodule commit with an identical
recursive tree has the same content contribution. External bytes reached via
a symlink are outside this committed-tree specification.

The Bash recipe is copied independently into each repository. It uses Git and
GNU `sha256sum`, disables replacement objects and lazy object fetching, and
requires every submodule's checkout to match its gitlink. Missing/unreadable
objects, an uninitialized/mismatched submodule or an unsupported entry mode
fail with a nonzero status and no final digest. The enclosing subshell keeps
directory, shell options, variables and function definitions out of the
caller's shell. Explicit failure guards also handle conditional sourcing,
where Bash's automatic `errexit` behavior alone is insufficient.

## Publication flow and failure behavior

1. On a tag build, capture the clean committed source before dependency
   installation. Keep that source record in the runner's private temporary
   directory, outside the workspace mount used by build containers.
2. Make Git metadata and host integrity tooling read-only in dependency and
   build containers, including the entire `build` source directory so imports
   cannot be substituted by replacing their parent. After installation, require the original event commit
   and unchanged tracked sources before building. Build-time generated source
   files are allowed; the fingerprint describes committed inputs.
3. After the web build, seal a local receipt containing this run's source
   evidence and exact hashes/sizes for all web ZIPs and every hosted file.
   The latter is necessary because the Go server embeds `dist/hosted`.
4. In the existing serialized release publication job, refuse an existing
   integrity YAML **before uploading any payload**. Ordinary release-note
   synchronization remains available because release notes are outside this
   attestation's coverage.
5. Download the same run's build artifact and compare its receipt, all ZIPs,
   and the exact hosted file set against the tagged checkout. A release-only
   retry may have a later attempt number; run ID and source must still match.
6. Publish the existing ZIPs and GoReleaser outputs. Rehash actual local files,
   select the public `Archive`, `Linux Package` and `Checksum` records from
   GoReleaser's `artifacts.json`, and create the YAML. Unknown types, duplicate
   names and unexpected paths fail closed. Server output hashes do not come
   from remote release metadata or unverified GoReleaser checksum fields.
7. Compare the **entire** remote uploaded asset set with the local expected
   names, sizes, upload states and GitHub's SHA-256 asset digests. A missing
   remote digest is a failure. Record asset IDs as well to detect replacement.
8. Call `actions/attest` once with the frozen YAML digest and default build
   provenance. It obtains the workflow identity from GitHub and stores the
   attestation in GitHub's attestation service. No custom predicate replaces
   the standard provenance. Both caller and reusable job grant `id-token:
   write` and `attestations: write`; no registry-storage permission is needed.
9. Save the returned attestation bundle as a workflow artifact. Recheck the
   YAML and remote snapshot, upload the YAML without overwrite, and recheck
   the complete final remote set including the YAML digest.

This deliberately keeps the existing mutable Release workflow. GitHub may
show payloads before the final proof arrives. If publication fails before the
YAML upload, the release is incomplete evidence and an unsigned retry can
resume. If the YAML is already present, reruns stop before payload changes;
use a new version for a new signed publication. If the last network response
is lost, inspect and verify the release rather than blindly deleting proof.

The job's concurrency group serializes this workflow's publishers and release
note updates. It cannot lock out an administrator, another token or a separate
workflow. Checks detect inconsistencies at observation time, but do not make
the release immutable. Later file additions, deletion or replacement do not
invalidate a previously saved signature; they change the current release
relative to its signed snapshot. An older valid attestation is not proof of
the latest release, freshness, revocation or absence of rollback.

Only uploaded distribution assets are in the inventory. GitHub's generated
“Source code (zip/tar.gz)” links, descriptions, release notes, debug reports,
the receipt and the integrity YAML itself are outside that payload list.
The YAML's digest is authenticated by the external attestation, avoiding a
self-hash cycle. The receipt is internal workflow evidence, not a second
unsigned public authority.

## Offline verification and disclosure

Normal `gh attestation verify` retrieves attestations online. For offline
verification, preserve the exact YAML, selected payloads, the Sigstore bundle
and a trusted root obtained through a trusted channel. Use the same identity
policy with `--bundle /path/to/bundle.json` and
`--custom-trusted-root /path/to/trusted-root.jsonl`. Trust roots must not come
only from the untrusted artifact being checked. The workflow bundle artifact
has normal artifact retention; GitHub's attestation service is the online
lookup path. Offline bundle verification checks historical recorded names;
it cannot determine current repository renames or latest-release state.

This public-repository attestation exposes repository/workflow/run/source
identity and artifact digests through GitHub/Sigstore. The public YAML exposes
the source fingerprint, distribution names/sizes/hashes and verification
code. It does not embed source files, secrets, local absolute build paths,
the build receipt or dependency credentials. The receipt is present in the
build's normal workflow artifact and follows that artifact's access policy.
This publication design should not be reused
unmodified for private builds with confidential filenames or identity data.

## Tooling and references

Production helpers use only Node built-ins and the repository's existing
command/environment readers. Node 22.18 or newer runs their local TypeScript
imports without installing packages. Workflow Node 22.x setup and the
`node:22-bookworm` test image provide that support.

Run focused tooling tests with `node --test scripts/tests/*.test.mjs`; the
workflow runs them offline. New tests exercise failure paths and actual
inline publication code, including source/run substitution, corrupted hosted
inputs, unknown assets, absent remote digests, signature/upload races and
adversarial Git trees.

- [actions/attest](https://github.com/actions/attest)
- [GitHub CLI attestation verification](https://cli.github.com/manual/gh_attestation_verify)
- [GoReleaser v2.7.0 artifact types](https://github.com/goreleaser/goreleaser/blob/v2.7.0/internal/artifact/artifact.go)
- [GoReleaser v2.7.0 artifact metadata](https://github.com/goreleaser/goreleaser/blob/v2.7.0/internal/pipe/metadata/metadata.go)
