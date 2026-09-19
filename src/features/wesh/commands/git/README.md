# Wesh Git implementation architecture

`git` is one Wesh command with many CLI subcommands. Keep the CLI layer separate from Git repository/domain behavior so compatibility changes propagate only where intended.

## Entrypoint

`index.ts` is the composition root for the Git command. It owns help/version handling, subcommand selection, and dispatch. It may import subcommands.

`command-invocation.ts` owns Git-wide invocation parsing such as `-C`, `-c`, `--git-dir`, and `--work-tree`. The composition root does not interpret subcommand-specific options.

Production Git domain modules must not import the entrypoint.

## Subcommands

`subcommands/**` owns CLI behavior for individual Git subcommands.

- Keep a simple subcommand as `subcommands/<name>.ts`.
- When a subcommand has private helper modules, use `subcommands/<name>/index.ts` plus specifically named helpers in the same directory.
- Private modules belonging to the same subcommand may depend on each other.
- One subcommand must not import another subcommand or its private helpers.
- Raw argv parsing belongs to the owning subcommand. When CLI surfaces may evolve independently, shared Git domain code receives a normalized request instead of parsing multiple subcommands' argv itself.
- A subcommand also selects command-specific compatibility policy from its own parsed or minimally classified invocation. Shared policy modules validate normalized requirements and do not interpret subcommand argv.
- Private compatibility engines used by only one complex subcommand belong under that subcommand. For example, `subcommands/apply/patch/**` is the Git-apply-specific patch implementation rather than a Git-wide patch API.
- Behavior needed by multiple subcommands belongs in a specifically named Git domain module, not in one subcommand chosen as an accidental shared API.

## Git domain modules

Modules outside `subcommands/**` implement Git-owned repository concepts and behavior that are intentionally shared across subcommands or form lower-level Git machinery.

Examples include repository discovery, refs, objects, index handling, revision resolution, merge/rebase operations, and the Git-owned `diff/**` implementation shared by diff/log/show/stash/text-merge behavior. `content-policy.ts` validates normalized content-policy requirements selected by subcommands.

Git domain modules must not import `subcommands/**`.

## argv-v2 ownership

Git uses the frozen `@/features/wesh/argv-v2` contract only for option mechanics that should intentionally match other migrated commands. Keep Git-specific phase, revision, pathspec, config, and diagnostic semantics command-local.

- Use `parseStandardArgv()` for catalog-shaped subcommands.
- Use direct `analyzeArgvShortForm()` / `analyzeArgvLongForm()` only when the subcommand must own the argv cursor or parsing phase. Keep these calls grep-visible rather than hiding them behind another generic Git scanner.
- Resolve parse-options-style long abbreviations against the complete real Git option namespace for that subcommand, not only the options Wesh executes. Register unsupported real long options as `nonExecutableLongOptions`: they participate in unique-prefix and ambiguity resolution but remain non-executable.
- Do not add unsupported option semantics merely because an option is present in the resolver namespace.
- Update a resolver namespace from an observed Linux Git oracle. Do not guess omitted options from another subcommand.
- Keep Git-specific exit-status and diagnostic ordering in the owning subcommand even when argv-v2 owns lexical recognition.

This separation prevents Wesh from falsely accepting a prefix that real Git considers ambiguous while keeping unsupported functionality outside the implemented surface.

## Test environment isolation

Git integration tests must own mutable Wesh state per test case. For new or refactored suites, allocate a fresh `Wesh` with a fresh in-memory root from inside the `it()` scenario (directly or through `createGitTestExecutor()`) rather than exposing mutable suite-scoped state. Suite-level `beforeAll` remains appropriate for immutable command-definition preload only.

Do not rely on `finally` cleanup to make a repository, config, cwd, environment, or VFS state reusable by another `it()`. A test may execute multiple Git commands against the same Wesh instance when those commands form one scenario; the isolation boundary is between test cases. Existing suites that already create a fresh root and Wesh in `beforeEach` are isolated, but migrate them to the explicit test-local form when materially refactoring their fixture ownership.

## Sharing rule

Code similarity is not a reason to share an implementation. Share behavior only when a future change to that behavior should intentionally propagate to every consumer.

If two compatibility surfaces may need to evolve independently, keep their implementations separate even when that means deliberate duplication. Conversely, when multiple Git subcommands must receive the same behavioral fix, place that responsibility in a neutral, specifically named Git domain module.

The dependency-direction lint rule enforces the structural direction described above.
