import { expandGitShortOptions } from '@/features/wesh/commands/git/short-options';
import { parseGitMaxCount } from '@/features/wesh/commands/git/max-count';

export type GitLogDecorationMode = 'none' | 'short' | 'full';

export interface GitLogArguments {
  format: string | undefined,
  oneline: boolean,
  decorationMode: GitLogDecorationMode,
  graph: boolean,
  maxCount: number,
  allRefs: boolean,
  showStat: boolean,
  showPatch: boolean,
  sinceTimestamp: number | undefined,
  untilTimestamp: number | undefined,
  grepPatterns: readonly RegExp[],
  pickaxeString: string | undefined,
  pickaxeRegex: RegExp | undefined,
  revisionTerms: readonly string[],
  pathOperands: readonly string[],
}

function parseLogDateBoundary({ value }: {
    value: string;
}): number {
  if (/^@-?[0-9]+$/u.test(value))
    return Number.parseInt(value.slice(1), 10);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new Error(`invalid date format: ${value}`);
  return Math.floor(milliseconds / 1000);
}
export function parseLogArguments({ args }: { args: readonly string[] }): GitLogArguments {
  let format: string | undefined;
  let oneline = false;
  let decorationMode: GitLogDecorationMode = 'none';
  let graph = false;
  let maxCount = Number.POSITIVE_INFINITY;
  let allRefs = false;
  let showStat = false;
  let showPatch = false;
  let sinceTimestamp: number | undefined;
  let untilTimestamp: number | undefined;
  const grepPatterns: RegExp[] = [];
  let pickaxeString: string | undefined;
  let pickaxeRegex: RegExp | undefined;
  let parsingOptions = true;
  let readingPaths = false;
  const revisionTerms: string[] = [];
  const pathOperands: string[] = [];
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['p'], valueOptions: ['n', 'S', 'G'] });
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      readingPaths = true;
      continue;
    }
    if (readingPaths) {
      pathOperands.push(arg);
      continue;
    }
    if (parsingOptions && arg === '--oneline') {
      format = '%h %s';
      oneline = true;
    } else if (parsingOptions && arg === '--graph') {
      graph = true;
    } else if (parsingOptions && arg === '--decorate') {
      decorationMode = 'short';
    } else if (parsingOptions && arg === '--decorate=short') {
      decorationMode = 'short';
    } else if (parsingOptions && arg === '--decorate=full') {
      decorationMode = 'full';
    } else if (parsingOptions && arg === '--no-decorate') {
      decorationMode = 'none';
    } else if (parsingOptions && arg === '--all') {
      allRefs = true;
    } else if (parsingOptions && arg === '--stat') {
      showStat = true;
    } else if (parsingOptions && (arg === '-p' || arg === '--patch')) {
      showPatch = true;
    } else if (parsingOptions && arg === '--no-color') {
      // Output is uncolored by Wesh Git.
    } else if (parsingOptions && (arg === '-n' || arg === '--max-count')) {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a numeric value`);
      maxCount = parseGitMaxCount({ value, option: arg });
      index += 1;
    } else if (parsingOptions && /^-[0-9]+$/u.test(arg)) {
      maxCount = Number.parseInt(arg.slice(1), 10);
    } else if (parsingOptions && arg.startsWith('--max-count=')) {
      const value = arg.slice('--max-count='.length);
      maxCount = parseGitMaxCount({ value, option: '--max-count' });
    } else if (parsingOptions && arg === '--pretty') {
      format = undefined;
      oneline = false;
    } else if (parsingOptions && arg === '--format') {
      throw new Error('unsupported log argument: --format');
    } else if (parsingOptions && (arg.startsWith('--format=') || arg.startsWith('--pretty='))) {
      const value = arg.slice(arg.indexOf('=') + 1);
      format = value === 'oneline'
        ? '%H %s'
        : value.startsWith('format:') ? value.slice('format:'.length) : value;
      oneline = false;
    } else if (parsingOptions && (arg === '--since' || arg === '--after' || arg === '--until' || arg === '--before')) {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a value`);
      const timestamp = parseLogDateBoundary({ value });
      if (arg === '--since' || arg === '--after')
        sinceTimestamp = timestamp;
      else
        untilTimestamp = timestamp;
      index += 1;
    } else if (parsingOptions && (arg.startsWith('--since=') || arg.startsWith('--after='))) {
      sinceTimestamp = parseLogDateBoundary({ value: arg.slice(arg.indexOf('=') + 1) });
    } else if (parsingOptions && (arg.startsWith('--until=') || arg.startsWith('--before='))) {
      untilTimestamp = parseLogDateBoundary({ value: arg.slice(arg.indexOf('=') + 1) });
    } else if (parsingOptions && arg === '-S') {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new Error("option '-S' requires a value");
      pickaxeString = value;
      index += 1;
    } else if (parsingOptions && arg.startsWith('-S')) {
      pickaxeString = arg.slice(2);
    } else if (parsingOptions && arg === '-G') {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new Error("option '-G' requires a value");
      pickaxeRegex = new RegExp(value, 'u');
      index += 1;
    } else if (parsingOptions && arg.startsWith('-G')) {
      pickaxeRegex = new RegExp(arg.slice(2), 'u');
    } else if (parsingOptions && (arg === '--grep')) {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a value`);
      grepPatterns.push(new RegExp(value, 'u'));
      index += 1;
    } else if (parsingOptions && arg.startsWith('--grep=')) {
      grepPatterns.push(new RegExp(arg.slice('--grep='.length), 'u'));
    } else if (parsingOptions && arg.startsWith('-')) {
      throw new Error(`unsupported log argument: ${arg}`);
    } else {
      revisionTerms.push(arg);
    }
  }
  if (graph && (showStat || showPatch || pathOperands.length > 0 || sinceTimestamp !== undefined
        || untilTimestamp !== undefined || grepPatterns.length > 0 || pickaxeString !== undefined
        || pickaxeRegex !== undefined)) {
    throw new Error('log --graph does not support diff or history filtering options yet');
  }
  return {
    format,
    oneline,
    decorationMode,
    graph,
    maxCount,
    allRefs,
    showStat,
    showPatch,
    sinceTimestamp,
    untilTimestamp,
    grepPatterns,
    pickaxeString,
    pickaxeRegex,
    revisionTerms,
    pathOperands,
  };
}

export const TEST_ONLY = {
};
