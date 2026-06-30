# Reusable Utilities

This file applies to `src/utils/**`.

Place reusable helpers and technical primitives here when they do not encode Naidan-specific concepts or application policy.

Appropriate contents include:

- small pure helpers;
- missing standard-library-style operations;
- generic schema helpers;
- generic codecs and stream primitives;
- small platform capability adapters that remain independent of Naidan behavior.

A utility may wrap a platform API when it exposes a narrow, generic capability and does not coordinate application state, UI, strings, or Naidan policy.

Utilities must not depend on:

```text
src/01-models/**
src/00-storage/**
src/features/**
src/components/**
src/composables/**
src/logic/**
src/strings/**
```

A helper that requires Naidan-specific input or output types usually belongs in `src/01-models`, `src/logic`, or the owning Feature instead.

Do not use `src/utils` as a fallback when ownership is unclear.
