export function parseGitMaxCount({ value, option }: {
  value: string,
  option: string,
}): number {
  if (!/^[ \t\r\n\v\f]*[+-]?[0-9]+$/u.test(value))
    throw new Error(`option '${option}' requires a numeric value`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < -2147483648 || parsed > 2147483647)
    throw new Error(`option '${option}' requires a numeric value`);
  return parsed < 0 ? Number.POSITIVE_INFINITY : parsed;
}

export const TEST_ONLY = {
};
