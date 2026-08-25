# Git diff internals

These modules are private implementation details of the Wesh `git` command.
They are intentionally owned by Git rather than the sibling Wesh `diff` command
because Git and GNU/POSIX `diff` are different compatibility targets. Changes
made for one target must not automatically change the other.

Do not replace these modules with imports from `commands/diff/**` merely to
remove duplication. Extract a lower-level responsibility only when future
changes to that responsibility should intentionally propagate to every
consumer.
