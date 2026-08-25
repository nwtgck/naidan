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

## Sharing rule

Code similarity is not a reason to share an implementation. Share behavior only when a future change to that behavior should intentionally propagate to every consumer.

If two compatibility surfaces may need to evolve independently, keep their implementations separate even when that means deliberate duplication. Conversely, when multiple Git subcommands must receive the same behavioral fix, place that responsibility in a neutral, specifically named Git domain module.

The dependency-direction lint rule enforces the structural direction described above.
