# Shared Application Logic

This file applies to `src/logic/**`.

Place Naidan-specific non-Vue application logic here when it is not owned by one removable Feature.

Appropriate responsibilities include:

- application startup;
- coordination across several Features;
- application-wide commands and lifecycle behavior;
- browser integration governed by Naidan policy;
- file, worker, communication, or other I/O orchestration;
- security policy and sanitization used across the application;
- application behavior that selects or formats Naidan strings.

Code under `src/logic/**` may depend on `src/strings/**`.

Do not place the following here:

- Vue reactivity or lifecycle-centered behavior;
- behavior owned by one removable Feature;
- Naidan-wide pure concepts;
- persistence internals;
- Naidan-independent reusable helpers;
- Vue components.

Use the following destinations instead:

```text
Vue state and lifecycle → src/composables or Feature-owned composables
Feature-owned behavior → src/features/<name>
Naidan-wide pure concepts → src/01-models
Naidan-independent reusable helpers → src/utils
```

Logic may use `src/00-storage/service/**`. It must not depend directly on Storage DTOs or mappers.
