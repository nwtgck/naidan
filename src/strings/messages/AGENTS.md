# Boundary Strings message rules

Message directories and catalog properties must use this format:

```text
<scope>__<natural_english_like_message>
```

The directory name, English catalog property, every locale catalog property,
and property accessed after `lazyStrings.` must match exactly.

## Scope ownership

Choose the smallest stable unit that would be removed together. If removing a
component, composable, or feature would remove a group of messages at the same
time, those messages belong to the same scope. If some messages could remain
after that removal, they need a different scope. Copy decisions and movement
should normally follow the same ownership boundary.

* Use an existing Vue component identifier for component-owned copy, preserving
  PascalCase, for example `ChatInput` or `SettingsModal`.
* Use an existing composable or function identifier for workflow-owned copy,
  preserving camelCase, for example `useChatLifecycle`.
* Use lowerCamelCase for a removable feature made of multiple source files,
  for example `fileExplorer` or `weshTerminal`.
* Do not use broad scopes such as `chat`, `settings`, or `common` merely because
  messages are in the same product area or currently have identical English.

The scope describes copy ownership. It does not describe a Vite chunk or force
messages from different scopes into different output files.

## Sharing

Reuse one key only when future copy changes must intentionally propagate to all
call sites. Identical English text alone is not a reason to share a key.

## Natural-language suffix

The suffix after `__` must be lowercase snake_case derived from the existing
English UI message. A reader should be able to predict the likely message from
`lazyStrings.<key>` without opening the locale file.

Do not use abstract role-only suffixes such as `confirmation`, `error_message`,
or `button_label`. Punctuation, minor tone, and incidental wording do not need
to be copied into the key. Do not reproduce an entire sentence when that makes
the identifier unwieldy. Use the shortest natural-English phrase that still
preserves the distinguishing meaning and lets a reader predict the message.
For example, prefer `SettingsModal__discard_unsaved_connection_changes` over a
key that copies the full confirmation sentence. Avoid opaque abbreviations.
Keep a key for minor copy edits; change it when the meaning or ownership changes
materially.

## Language and Wesh boundary

Identifiers, comments, and tests remain English. Locale message implementations
may contain their target natural language.

Naidan UI around Wesh is eligible for Boundary Strings. Wesh command output,
usage text, diagnostics, shell transcript content, and raw worker errors remain
English and must not be moved into this directory.

## Module exports and implementation style

Each locale module must use a named export whose identifier exactly matches the
message directory and catalog key. Individual message modules must not use a
default export.

Do not import the English message type into every locale module and do not add
per-message `satisfies` expressions. Each locale implementation declares its
own parameter and return types, while `src/strings/catalogs/<locale>.ts` uses
`satisfies Strings` as the single catalog-wide compatibility check. This keeps
adding a translation to one small file and avoids repetitive type-import noise.

Prefer a compact `export const` arrow function when the message is a direct
string or template expression. Keep the destructured parameter and its inline
object type on one line, including for block-bodied functions.

```typescript
export const ChatInput__failed_to_copy = ({ name, errorMessage }: { name: string; errorMessage: string }): string => (
  `Failed to copy "${name}": ${errorMessage}`
);
```

When the entire declaration fits comfortably on one line, do not add
parentheses around the returned expression.

```typescript
export const ChatInput__remove = (): string => 'Remove';
```

When an arrow function returns an expression on the following line, wrap that
expression in parentheses. Use `function` only when message construction needs
substantial branching, multiple intermediate values, explanatory comments, or
a parameter list that is too large to remain readable as a compact arrow
function. Even then, keep the destructured parameter and inline object type on
one line unless doing so would be exceptionally difficult to read.

Generated catalogs and virtual packs must preserve message identifiers. Use
single-line named imports or named re-exports. Do not generate information-free
aliases such as `message0`, `message1`, or similar numbered names.
