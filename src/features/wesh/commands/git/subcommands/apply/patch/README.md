# Git patch internals

These modules are private implementation details of the Wesh `git apply` subcommand.
They are intentionally owned by Git rather than the sibling Wesh `patch`
command because `git apply` and GNU/POSIX `patch` are different compatibility
targets. Changes made for one target must not automatically change the other.

Do not replace these modules with imports from `commands/patch/**` merely to
remove duplication. Extract a lower-level responsibility only when future
changes to that responsibility should intentionally propagate to every
consumer.
