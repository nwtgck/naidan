# Release integrity

GitHub Actions publishes a distribution candidate on each push with
`naidan-release-integrity.yaml` and an attestation for its exact SHA-256 digest.
Tagged pushes also publish the staged payload and the same YAML to GitHub
Releases. The inventory binds the committed-source tree fingerprint to the
staged files. It includes the complete Bash fingerprint recipe and a checksum verification
block. No project-specific Python, YAML parser, or package installation is
needed to copy and audit those commands.

The attestation authenticates a statement made by the selected GitHub Actions
workflow. Trusting that workflow and GitHub-hosted runners is a prerequisite.
It does not prove that the program is safe, that a dependency or compiler
cannot influence a build, or that a reproducible rebuild produces equal bytes.

## Verify a download

Choose the expected source ref and revision independently. On the Actions run,
download the YAML from `naidan-integrity-<attempt>` or get it with the complete
distribution from `naidan-distribution-<attempt>`. GitHub Releases offer the YAML
alongside their assets and link to its **Build Attestation** in the release notes.
Verify the YAML **before trusting its data
or running a command copied from it**:

```bash
gh attestation verify naidan-release-integrity.yaml \
  --repo nwtgck/naidan \
  --signer-workflow nwtgck/naidan/.github/workflows/main.yml \
  --source-ref "$EXPECTED_SOURCE_REF" \
  --source-digest "$EXPECTED_SOURCE_COMMIT" \
  --deny-self-hosted-runners
```

`gh` is the GitHub command-line interface. Use the full ref, such as
`refs/heads/develop` or `refs/tags/v0.72.1`. A stricter verifier
may also pin `--signer-digest` to the reviewed signing-workflow revision.
Neither the repository nor a tag alone identifies an acceptable workflow
revision; review the YAML and invoked code at the expected commit.

After successful attestation verification:

1. Check the source repository, ref and commit. A tagged candidate also
   records its `release_tag`.
2. Hash your downloaded files and compare each file's `size` and `sha256`.
   The included `verification.artifacts` Bash block checks all listed hashes
   with GNU `sha256sum --strict --check`. Run it in `assets/` for an Actions
   Artifact or in the directory with the Release downloads. For a selective
   download, compare the selected files' entries.
   To run the verified Linux server binary from a branch Artifact, restore its
   executable bit from the extracted candidate root with `chmod +x assets/naidan-server`.
   Keep `assets/naidan-server-THIRD-PARTY-NOTICES.txt` with the binary when redistributing it.
3. To check the source, recursively check out `source.commit` and run the
   `source.tree_fingerprint.reproduce` block from that checkout's root.
   Compare its output with `source.tree_fingerprint.value`.
4. To check the complete current release, also compare its uploaded asset
   names with the YAML inventory plus `naidan-release-integrity.yaml` itself.
   Hash checking listed files alone does not detect unrelated extra files.

### Verify an individual Actions Artifact

Download the Artifact ZIP from the same Actions run and hash it before
extracting it. For example, run `sha256sum standalone-universal-package.zip`
and compare the result with `workflow_artifacts.standalone-universal-package`
in the verified YAML. The same check applies to `standalone-all-locale-packages`,
`naidan-hosted`, `naidan-server-binary` and `full-dist-build`. Each hash covers
the complete downloaded archive, including any debug files it contains.

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

## Candidate build and publication

1. For each push, capture the clean committed source before dependency
   installation, then confirm that installation left the tracked source intact.
   Keep Git metadata and the source tooling read-only in the install and build
   containers.
2. Record this run's source and the hashes of all Web ZIPs and hosted files.
   The candidate job downloads the build from the same run and verifies that
   receipt and those bytes. The Go server embeds the verified hosted files.
3. For a branch push, stage the Web ZIPs and the Linux server binary already
   produced by CI. For a tag push, build the full GoReleaser matrix offline
   with `--skip=publish`, then stage the Web ZIPs, server archives, Linux
   packages and `checksums.txt`. The tag sets the tagged build's version.
   Branch builds use the version in `package.json`.
4. Generate the YAML from the staged files inside the offline container.
   The candidate job obtains an attestation for the exact YAML digest and
   saves the staged assets, YAML and Sigstore bundle in one Actions Artifact.
5. For a stable tag, the serialized release job downloads that exact
   candidate by Artifact ID. It checks for existing integrity evidence and
   unrelated Release Assets before uploading the staged files and their YAML.
   A tag such as `v0.72.1-release-trigger-1` makes the same files
   available as a GitHub prerelease outside the Latest release.

The signed file inventory describes the candidate's bytes. Later additions
or replacements on a Release can change what GitHub serves. GitHub-generated
source archives and release notes are outside the signed file inventory.

## Offline verification and disclosure

Normal `gh attestation verify` retrieves attestations online. For offline
verification, preserve the exact YAML, selected payloads, the Sigstore bundle
and a trusted root obtained through a trusted channel. Use the same identity
policy with `--bundle /path/to/bundle.json` and
`--custom-trusted-root /path/to/trusted-root.jsonl`. Trust roots must not come
only from the untrusted artifact being checked. The Actions Artifact
`naidan-distribution-<attempt>` contains the exact YAML
and `attestation.bundle.json`, with normal artifact retention. GitHub's
attestation service is the online lookup path. Offline verification uses historical names;
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
inputs, malformed metadata, branch and tagged candidates, and adversarial
Git trees.

- [actions/attest](https://github.com/actions/attest)
- [GitHub CLI attestation verification](https://cli.github.com/manual/gh_attestation_verify)
- [GoReleaser v2.7.0 artifact types](https://github.com/goreleaser/goreleaser/blob/v2.7.0/internal/artifact/artifact.go)
- [GoReleaser v2.7.0 artifact metadata](https://github.com/goreleaser/goreleaser/blob/v2.7.0/internal/pipe/metadata/metadata.go)
