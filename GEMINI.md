# Development Principles

*   **Zod**: Must be used for all data persistence and API communication to ensure safe serialization. All API responses MUST be validated to protect the application from unreliable external data structures. Persisted data must maintain backward compatibility.
*   **Strong Typing**: Prefer strict static typing to catch errors at build-time. Avoid `any`.
*   **Exhaustive Type Checking**: Use `switch` statements with a `default` block assigning to `never` (e.g., `const _ex: never = val;`) when handling union types to ensure all cases are handled.
*   **Verification**: Run `npm run build`, `npm run lint:fix` and `npm run test -- --run` before committing to ensure quality and prevent regressions. Use `|& tail -n 20` or similar to suppress excessive verbosity and save context tokens while still confirming completion and capturing potential errors.
*   **Targeted Testing**: Test specific files or directories (multiple paths supported) by passing them as arguments: `npm run test -- <paths...> --run`.

# Function Signatures & Named Arguments

For **new** or **refactored** functions, use a single mandatory argument object (Swift-style) for clarity and extensibility. **This applies even if the function has only one argument.**

- **Explicit > Implicit**: Avoid property defaults. They hide intent and create "implicit knowledge". Require explicit values (including `undefined`) so the state is fully visible at the call site.
- **Inline Types**: Prefer inline destructuring and type definitions in signatures.
- **No Nulls**: Use `undefined` for missing values.

### Examples

#### ❌ BAD (Positional Arguments)
```typescript
// Difficult to read at call site, prone to order mismatch
async function processRecord(id: string, retryCount: number | undefined, isSilent: boolean) { ... }

// Caller: What do 3 and true mean here? Is the second arg retryCount or something else?
await processRecord("rec_123", 3, true);

// Even single arguments should not be positional
async function deleteUser(id: string) { ... }
await deleteUser("user_123");
```

#### ❌ BAD (Implicit Defaults)
```typescript
// Definitions are hidden from the caller, creating "implicit knowledge"
async function processRecord({ id, retryCount = 3, isSilent = false }: {
  id: string,
  retryCount?: number,
  isSilent?: boolean,
}) { ... }

// Caller: What are the defaults for retryCount and isSilent? It's not clear here.
await processRecord({ id: "rec_123" });
```

#### ✅ GOOD (Explicit Named Arguments)
```typescript
// Self-documenting, order-independent, and fully explicit
async function processRecord({ id, retryCount, isSilent }: {
  id: string,
  retryCount: number | undefined,
  isSilent: boolean,
}) {
  // logic...
}

// Caller: Clear and safe. Every state is visible.
// Similar to Swift's named arguments style.
await processRecord({
  id: "rec_123",
  retryCount: 3,
  isSilent: true,
});

// Even single arguments use the object-based named argument style
async function deleteUser({ id }: { id: string }) { ... }
await deleteUser({ id: "user_123" });
```

# Type Design: Avoid Booleans for Future-Proofing

Even if a property seems binary today, prefer a **Literal String Union** over a `boolean` if there is any possibility it could evolve. Replacing a boolean with a union later requires refactoring all call sites, which we want to avoid.

-   **Extensibility**: Adding a third or fourth state to a union is a non-breaking change for existing logic (if handled by a switch).
-   **No "In-Between" States**: Prevents the "Boolean Growth" problem where you end up with `isA: boolean`, `isB: boolean`, etc., leading to impossible combinations.
-   **Semantic Clarity**: `status: 'hidden'` is more descriptive than `isVisible: false`.

### Examples

#### ❌ BAD (Boolean-first, hard to extend)
```typescript
interface Widget {
  isVisible: boolean,
}

// Later, you need a "collapsed" state...
// You either add 'isCollapsed: boolean' (bad, now you have 4 combinations)
// or you refactor 'isVisible' to something else (breaking change).
```

#### ✅ GOOD (Union-first, easy to extend)
```typescript
type Visibility = 'visible' | 'hidden' | 'collapsed';

interface Widget {
  visibility: Visibility,
}

// Adding 'archived' or 'minimized' later is a non-breaking extension.
const widget: Widget = {
  visibility: 'hidden',
};
```

---
*   **Non-interactive Tests**: Always use the `--run` flag (e.g., `npm run test -- --run`) when executing tests as an agent or in CI to ensure the process exits after completion and does not hang in watch mode.
*   **Testing**: Actively use `data-testid` attributes for selecting elements in tests. This decouples tests from implementation details (CSS classes, tag names) and makes them more resilient to styling changes.
*   **Preserve Tests**: Never delete tests during refactoring. Adapt them to the new UI structure (e.g., test events/props instead of direct DOM interaction) to maintain functional coverage.
*   **File Modification**: If you are using the `write_file` tool, then first use the `read_file` tool to retrieve the current content of the file. Always respect the existing code structure, comments, and conventions.
* **Language**: English only for source code, UI, and commit messages.
* **Wrapping Blocks**: If wrapping an existing block (tags, if-statements, etc.), then insert the start and end markers in separate steps to preserve the existing indentation of the children.
* **Commit Attribution**: When Gemini (this AI agent) performs a git commit, always append its own identity in the format `Co-authored-by: ${name} <${email}>` to the end of the commit message.
