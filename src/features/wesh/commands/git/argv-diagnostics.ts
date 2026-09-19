export function formatGitAmbiguousLongOption({ option, candidateOptions }: {
  option: string,
  candidateOptions: readonly string[],
}): string {
  return `ambiguous option: ${option.startsWith('--') ? option.slice(2) : option} (could be ${candidateOptions.join(' or ')})`;
}

export const TEST_ONLY = {
};
