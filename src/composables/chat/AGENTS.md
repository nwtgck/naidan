# Chat Composables

This file applies to `src/composables/chat/**`.

## Cohesive Ownership

This directory keeps the composables that form Naidan's core Chat behavior together.

Chat coordinates many components, Features, state transitions, commands, and persistence operations. Do not distribute Chat composables across Features merely to categorize their technical responsibilities.

A composable belongs here when it:

- primarily manages Chat state or Chat operations;
- participates in Chat creation, selection, updates, sending, generation, branching, or related lifecycle;
- collaborates closely with several other Chat composables;
- is not owned by one independently removable Feature;
- remains necessary while Naidan's core Chat experience exists.

A composable belongs in a Feature only when removing that Feature would also remove the composable as part of the same cohesive deletion.

## Structural Changes

Do not treat file count or internal dependencies as reasons to split this directory.

Ask the user before:

- moving a Chat composable into a Feature;
- splitting this directory into separate ownership units;
- moving Chat composables into another top-level directory;
- performing a large consolidation or decomposition.

Do not combine a Chat behavior change with an unrelated relocation. Propose structural work as a separate change so rename detection and review remain clear.

## Dependencies

Chat composables may depend on shared application code, Features, `src/01-models/**`, `src/00-storage/service/**`, `src/strings/**`, `src/constants.ts`, and `src/utils/**`.

They must not depend directly on `src/00-storage/00-dto/**` or `src/00-storage/mapper/**`.
