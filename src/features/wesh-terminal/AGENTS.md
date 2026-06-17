# Wesh Terminal UX Layer

Wesh Terminal is an experimental human-facing UX layer for inspecting Wesh behavior.

Wesh core remains the source of truth for command execution semantics. Terminal-side completion, tokenization, prompt rendering, keyboard handling, and output-control behavior may intentionally duplicate small shell-like logic because they do not affect LM tool call execution.

Keep this duplication local to `src/features/wesh-terminal`. If a terminal-side behavior proves stable and useful outside the UI, it can later be promoted into `src/services/wesh` as a shared core facility.

Do not add TTY, PTY, raw-mode, or full terminal-emulator responsibilities to Wesh core from this directory. Prefer thin read-only worker observation APIs plus UI-local experiments.
