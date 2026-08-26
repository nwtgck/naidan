export function parseGitMaxCount({ value, option }: {
  value: string,
  option: string,
}): number {
  if (!/^-?[0-9]+$/u.test(value))
    throw new Error(`option '${option}' requires a numeric value`);
  const parsed = Number.parseInt(value, 10);
  return parsed < 0 ? Number.POSITIVE_INFINITY : parsed;
}

export const TEST_ONLY = {
};
