# Wesh

## Bash Compatibility

Principles:

- Wesh Shell prioritizes Bash compatibility.
- Intentional exceptions are documented below.

Testing:

- Do not execute host Bash or Linux commands from `.test.ts` files.

## Exceptions

### Builtin Commands

Policy:

- The set of Wesh builtin commands is an intentional exception to Bash compatibility.
- Wesh may provide more builtin commands than Bash.
- When useful, an executable shell-script wrapper such as `builtin <command> "$@"` may be placed under `/bin` or similar, including virtually, if its contents are readable as a normal file.

Prohibited:

- Do not restrict Wesh builtins to Bash builtins.
- Do not create or use a list of Bash builtin names to decide which Wesh commands are builtins.
- Do not create executable files only to match Bash or Linux command classification when their executable contents cannot be provided correctly.

Reason:

- An external executable must have readable file contents that correspond to what is executed.
- An internally implemented Wesh command may have no such file contents. In that case, use a builtin.
