# Shared Components

This file applies to `src/components/**`.

Place Vue components here when they are not owned by one removable Feature.

Typical responsibilities include:

- application-wide layout;
- primary navigation;
- UI that integrates several Features;
- UI that remains if any single Feature is removed.

A component belongs under `src/features/<name>/components` when removing that Feature would also remove the component.

Do not move a component here merely because it is reused or visually generic. Consider ownership, naming, props, and change reasons.

Keep reusable non-UI behavior outside Vue components:

```text
Vue state and lifecycle  → shared or Feature-owned composables
Naidan-specific non-Vue behavior → shared or Feature-owned logic
Naidan-wide concepts → src/01-models
```

Components may depend on `src/strings/**` and `src/00-storage/service/**`. They must not depend directly on Storage DTOs or mappers.
