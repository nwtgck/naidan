# `chat-scoped/` Rules

Files in this directory must be truly chat-scoped.

Required rules:

- Every public `useXxx` composable in this directory must accept `{ chatId }`.
- The scope must be explicit in the signature, not implicit through `currentChat`.
- Reads and writes must behave as operations on that specific chat.
- A composable that only works with the current chat, the current chat group, or global UI state does not belong here.
- A composable that is scoped by something other than `chatId` does not belong here.

If a composable can be upgraded to `useXxx({ chatId })`, prefer upgrading it instead of moving it.

If it cannot naturally become `chatId`-scoped, move it to a more accurate directory such as `chat/ui/`, `chat/compat/`, or another domain-specific folder.
