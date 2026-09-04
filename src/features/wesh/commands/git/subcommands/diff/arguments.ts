import { analyzeArgvShortForm, defineArgvCatalog } from '@/features/wesh/argv-v2';
import { GitUsageError } from '@/features/wesh/commands/git/errors';

const DIFF_SHORT_ARGV_CATALOG = defineArgvCatalog<'unified-context'>({
  nonExecutableLongOptions: [],
  definitions: [
    { semantic: 'unified-context', forms: [{ kind: 'short', name: 'U', value: { kind: 'required-attached-or-following', missingValueName: 'n' } }] },
  ],
});

function parseUnifiedContextLines({ value, option }: { value: string, option: string }): number {
  if (!/^[0-9]+$/u.test(value))
    throw new GitUsageError({ message: `option '${option}' expects a non-negative integer` });
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed))
    throw new GitUsageError({ message: `option '${option}' expects a non-negative integer` });
  return parsed;
}

export interface GitDiffArguments {
  cached: boolean,
  nameOnly: boolean,
  nameStatus: boolean,
  stat: boolean,
  check: boolean,
  quiet: boolean,
  exitCode: boolean,
  nul: boolean,
  unifiedContextLines: number,
  wordDiff: boolean,
  binaryPatch: boolean,
  revisions: readonly string[],
  pathOperands: readonly string[],
}

export function parseDiffArguments({ args }: { args: readonly string[] }): GitDiffArguments {
  let cached = false;
  let nameOnly = false;
  let nameStatus = false;
  let stat = false;
  let check = false;
  let quiet = false;
  let exitCode = false;
  let nul = false;
  let unifiedContextLines = 3;
  let wordDiff = false;
  let binaryPatch = false;
  const revisions: string[] = [];
  const pathOperands: string[] = [];
  let parsingPaths = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parsingPaths) {
      pathOperands.push(arg);
      continue;
    }
    if (arg.startsWith('-U') && arg.length > 1) {
      const analysis = analyzeArgvShortForm({ token: arg, bodyOffset: 1, prefix: '-', catalog: DIFF_SHORT_ARGV_CATALOG });
      switch (analysis.kind) {
      case 'unknown':
        throw new GitUsageError({ message: `unknown option: ${arg}` });
      case 'matched':
        break;
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled diff short-option analysis: ${JSON.stringify(_ex)}`);
      }
      }
      switch (analysis.value.kind) {
      case 'inline':
        unifiedContextLines = parseUnifiedContextLines({ value: analysis.value.rawValue, option: analysis.option });
        break;
      case 'following-required': {
        const value = args[index + 1];
        if (value === undefined)
          throw new GitUsageError({ message: `option '${analysis.option}' requires a value` });
        unifiedContextLines = parseUnifiedContextLines({ value, option: analysis.option });
        index += 1;
        break;
      }
      case 'none':
      case 'following-optional':
        throw new GitUsageError({ message: `option '${analysis.option}' requires a value` });
      default: {
        const _ex: never = analysis.value;
        throw new Error(`Unhandled diff -U value: ${JSON.stringify(_ex)}`);
      }
      }
      continue;
    }
    switch (arg) {
    case '--':
      parsingPaths = true;
      break;
    case '--cached':
    case '--staged':
      cached = true;
      break;
    case '--name-only':
      nameOnly = true;
      break;
    case '--name-status':
      nameStatus = true;
      break;
    case '--stat':
      stat = true;
      break;
    case '--check':
      check = true;
      break;
    case '--word-diff':
      wordDiff = true;
      break;
    case '--binary':
      binaryPatch = true;
      break;
    case '--quiet':
      quiet = true;
      exitCode = true;
      break;
    case '--exit-code':
      exitCode = true;
      break;
    case '-z':
      nul = true;
      break;
    case '--cc':
    case '--no-color':
    case '--no-ext-diff':
      break;
    default:
      if (arg.startsWith('-')) throw new GitUsageError({ message: `unknown option: ${arg}` });
      revisions.push(arg);
      break;
    }
  }
  if (cached && revisions.length > 1) throw new Error('too many revisions for --cached');
  if (!cached && revisions.length > 2) throw new Error('too many revisions');
  return { cached, nameOnly, nameStatus, stat, check, quiet, exitCode, nul, unifiedContextLines, wordDiff, binaryPatch, revisions, pathOperands };
}

export const TEST_ONLY = {
};
