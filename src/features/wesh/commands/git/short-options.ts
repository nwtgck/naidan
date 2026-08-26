/**
 * Expands Git-style short-option clusters into the separate argv spelling that
 * command parsers already understand. A value-taking option consumes the rest
 * of its token as an attached value, matching Git's ordinary short-option
 * convention (for example `-ammessage` -> `-a -m message`).
 *
 * Unknown clusters are intentionally left untouched so each subcommand keeps
 * ownership of its unsupported-option diagnostic and compatibility profile.
 */
export function expandGitShortOptions({ args, flagOptions, valueOptions }: {
  args: readonly string[],
  flagOptions: readonly string[],
  valueOptions: readonly string[],
}): readonly string[] {
  const flagOptionSet = new Set(flagOptions);
  const valueOptionSet = new Set(valueOptions);
  const expanded: string[] = [];
  let parsingOptions = true;

  for (const arg of args) {
    if (!parsingOptions) {
      expanded.push(arg);
      continue;
    }
    if (arg === '--') {
      parsingOptions = false;
      expanded.push(arg);
      continue;
    }
    if (!arg.startsWith('-') || arg.startsWith('--') || arg.length <= 2) {
      expanded.push(arg);
      continue;
    }

    const tokenParts: string[] = [];
    let recognized = true;
    for (let index = 1; index < arg.length; index += 1) {
      const option = arg[index]!;
      if (flagOptionSet.has(option)) {
        tokenParts.push(`-${option}`);
        continue;
      }
      if (valueOptionSet.has(option)) {
        tokenParts.push(`-${option}`);
        const attachedValue = arg.slice(index + 1);
        if (attachedValue.length > 0)
          tokenParts.push(attachedValue);
        break;
      }
      recognized = false;
      break;
    }

    if (recognized)
      expanded.push(...tokenParts);
    else
      expanded.push(arg);
  }
  return expanded;
}

export const TEST_ONLY = {
};
