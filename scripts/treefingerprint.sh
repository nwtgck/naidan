# Run with Bash from the repository root after initializing recursive submodules.
# Hashes committed objects only; changed and untracked worktree files are excluded.
# The subshell preserves the caller's environment, directory, options and functions.
(
  set -euo pipefail
  export LC_ALL=C GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 || exit

  fingerprint() (
    cd -- "$1" || exit
    prefix="$(git rev-parse --show-prefix)" || exit
    test -z "$prefix" || { echo 'Run at a repository root.' >&2; exit 1; }
    commit="$(git rev-parse --verify "$2^{commit}")" || exit

    hash="$(
      git ls-tree -rz --full-tree "$commit" |
      while IFS= read -r -d '' entry; do
        header="${entry%%$'\t'*}"
        path="${entry#*$'\t'}"
        IFS=' ' read -r mode type oid <<< "$header" || exit

        case "$mode:$type" in
          100644:blob|100755:blob|120000:blob)
            digest="$(git cat-file blob "$oid" | sha256sum)" || exit
            ;;
          160000:commit)
            test -d "$path" && test ! -L "$path" && test -e "$path/.git" || exit 1
            head="$(git -C "$path" rev-parse --verify HEAD)" || exit
            test "$head" = "$oid" || { echo "Submodule commit mismatch: $path" >&2; exit 1; }
            digest="$(fingerprint "$path" "$oid")" || exit
            ;;
          *) echo "Unsupported Git entry: $header" >&2; exit 1 ;;
        esac

        printf '%s\0%s\0%s\0' "$mode" "$path" "${digest%% *}" || exit
      done | sha256sum
    )" || exit

    printf '%s\n' "${hash%% *}"
  ) || exit

  fingerprint . HEAD
)
