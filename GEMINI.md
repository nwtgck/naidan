# Development Principles

This document outlines the core technical principles and conventions for this project.

## 1. Zod for Safe Serialization
Reliability of persisted data is paramount.
*   **Mandate**: All data structures intended for persistence (Storage) or external communication (API) **MUST** be defined and validated using **Zod**.
*   **Safety**: Use Zod to ensure safe serialization and deserialization (serde). This prevents corrupted or unexpected data from causing runtime failures in the application logic.

## 2. Strong Static Typing
We prefer a "Type-First" approach to development.
*   **Goal**: Detect as many issues as possible at **build-time** rather than runtime.
*   **Strictness**: Adhere to strict TypeScript configurations. Avoid `any` and prefer exhaustive type checking.
*   **Inference**: Leverage Zod's `z.infer<typeof Schema>` to keep TypeScript interfaces in sync with validation logic automatically.

## 3. Language Conventions
Consistency in natural language ensures a professional and maintainable codebase.
*   **Source Code**: All comments, variable names, and documentation within the source code must be in **English**.
*   **User Interface**: All user-facing messages, labels, and notifications must be in **English**.

## 4. Git Conventions
*   **Commit Messages**: All commit messages must be written in **English**.
*   **Clarity**: Messages should be concise and clearly describe the "why" and "what" of the change.
