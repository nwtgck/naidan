# Development Principles

*   **Zod**: Must be used for all data persistence and API communication to ensure safe serialization. All API responses MUST be validated to protect the application from unreliable external data structures. Persisted data must maintain backward compatibility.
*   **Strong Typing**: Prefer strict static typing to catch errors at build-time. Avoid `any`.
*   **Exhaustive Type Checking**: Use `switch` statements with a `default` block assigning to `never` (e.g., `const _ex: never = val;`) when handling union types to ensure all cases are handled.
*   **Named Arguments**: Use options objects for functions with multiple parameters to improve clarity at the call site.
*   **Verification**: Run `npm run build`, `npm run lint:fix` and `npm run test -- --run` before committing to ensure quality and prevent regressions. Use `> /dev/null` or similar to suppress verbosity and save context tokens when appropriate.
*   **Targeted Testing**: Test specific files or directories (multiple paths supported) by passing them as arguments: `npm run test -- <paths...> --run`.
*   **Non-interactive Tests**: Always use the `--run` flag (e.g., `npm run test -- --run`) when executing tests as an agent or in CI to ensure the process exits after completion and does not hang in watch mode.
*   **Testing**: Actively use `data-testid` attributes for selecting elements in tests. This decouples tests from implementation details (CSS classes, tag names) and makes them more resilient to styling changes.
*   **Preserve Tests**: Never delete tests during refactoring. Adapt them to the new UI structure (e.g., test events/props instead of direct DOM interaction) to maintain functional coverage.
*   **File Modification**: If you are using the `write_file` tool, then first use the `read_file` tool to retrieve the current content of the file. Always respect the existing code structure, comments, and conventions.
*   **Language**: English only for source code, UI, and commit messages.
* **Commit Attribution**: When Gemini (this AI agent) performs a git commit, always append its own identity in the format `Co-authored-by: ${name} <${email}>` to the end of the commit message.
