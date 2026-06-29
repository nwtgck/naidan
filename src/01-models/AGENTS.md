# Naidan-Wide Models

This file applies to `src/01-models/**`.

## Responsibilities

`src/01-models` contains thin concepts shared across Naidan. It is not a type-only directory, but it should stay definition-first.

Appropriate contents include:

- types and interfaces;
- branded IDs;
- schemas;
- enum-like values;
- constants tied to a shared concept;
- pure validation;
- pure state transitions;
- small pure helpers that are tightly attached to those shared definitions.

## Dependency Direction

Code under `src/01-models/**` may depend on `src/constants.ts`, `src/utils/**`, and suitable external packages.

Code under `src/01-models/**` must not depend on:

```text
src/00-storage/**
src/features/**
src/components/**
src/composables/**
src/logic/**
src/strings/**
```

Do not use Vue reactivity, UI code, browser I/O, or persistence DTOs here.

Do not move a feature-specific concept into `src/01-models` merely to make an import appear shared.
