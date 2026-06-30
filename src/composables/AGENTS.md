# Shared Composables

This file applies to `src/composables/**`.

Place Vue composables here when they are not owned by one removable Feature.

Composables commonly manage:

- Vue reactive state;
- computed values and watchers;
- Vue lifecycle behavior;
- provide/inject state;
- coordination used by several application areas;
- operations exposed to Vue components.

Use a `use` prefix unless a different name is clearly more accurate.

A composable belongs under `src/features/<name>/composables` when removing that Feature would also remove the composable. Multiple callers do not by themselves make a composable shared; ownership is more important than call count.

Do not place Vue-independent logic, Storage DTO conversion, Vue components, or files that only hold shared types here.

Composables may depend on `src/strings/**` and `src/00-storage/service/**`. They must not depend directly on Storage DTOs or mappers.

`src/composables/chat/**` is an intentional cohesive area. Follow its deeper `AGENTS.md` before proposing structural changes there.
