# Development Principles

*   **Zod**: Must be used for all data persistence and API communication to ensure safe serialization. All API responses MUST be validated to protect the application from unreliable external data structures. Persisted data must maintain backward compatibility.
*   **Strong Typing**: Prefer strict static typing to catch errors at build-time. Avoid `any`.
*   **Verification**: Run `npm run build`, `npm run lint` and `npm test` before committing to ensure quality and prevent regressions. Use `> /dev/null` or similar to suppress verbosity and save context tokens when appropriate.
*   **Testing**: Actively use `data-testid` attributes for selecting elements in tests. This decouples tests from implementation details (CSS classes, tag names) and makes them more resilient to styling changes.
*   **Language**: English only for source code, UI, and commit messages.
