import { expandGitShortOptions } from '@/features/wesh/commands/git/short-options';

export interface CloneArguments {
  quiet: boolean;
  branchOption: string | undefined;
  depthOption: number | undefined;
  operands: string[];
}

export function parseCloneArguments({ args }: { args: readonly string[] }): CloneArguments {
  let quiet = false;
  let branchOption: string | undefined;
  let depthOption: number | undefined;
  const operands: string[] = [];
  let parsingOptions = true;
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['q'], valueOptions: ['b'] });
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-q' || arg === '--quiet')) {
      quiet = true;
      continue;
    }
    if (parsingOptions && (arg === '-b' || arg === '--branch')) {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a value`);
      branchOption = value;
      index += 1;
      continue;
    }
    if (parsingOptions && arg.startsWith('--branch=')) {
      branchOption = arg.slice('--branch='.length);
      if (branchOption.length === 0)
        throw new Error("option '--branch' requires a value");
      continue;
    }
    if (parsingOptions && arg === '--depth') {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new Error("option '--depth' requires a value");
      if (!/^[0-9]+$/u.test(value) || Number.parseInt(value, 10) <= 0)
        throw new Error(`depth ${value} is not a positive number`);
      depthOption = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (parsingOptions && arg.startsWith('--depth=')) {
      const value = arg.slice('--depth='.length);
      if (!/^[0-9]+$/u.test(value) || Number.parseInt(value, 10) <= 0)
        throw new Error(`depth ${value} is not a positive number`);
      depthOption = Number.parseInt(value, 10);
      continue;
    }
    if (parsingOptions && arg.startsWith('-'))
      throw new Error(`unknown option: ${arg}`);
    operands.push(arg);
  }
  if (operands.length < 1)
    throw new Error('You must specify a repository to clone.');
  if (operands.length > 2)
    throw new Error('Too many arguments.');
  return { quiet, branchOption, depthOption, operands };
}

export const TEST_ONLY = {
};
