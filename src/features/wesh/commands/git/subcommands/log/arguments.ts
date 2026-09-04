import { analyzeArgvShortForm, defineArgvCatalog } from '@/features/wesh/argv-v2';
import { parseGitMaxCount } from '@/features/wesh/commands/git/max-count';
import { compileGitBasicRegex } from '@/features/wesh/commands/git/basic-regex';
import type { GitBasicRegex } from '@/features/wesh/commands/git/basic-regex';
import { compileGitExtendedRegex } from '@/features/wesh/commands/git/extended-regex';
import type { GitExtendedRegex } from '@/features/wesh/commands/git/extended-regex';

export type GitLogDecorationMode = 'none' | 'short' | 'full';

type LogShortSemantic = 'patch' | 'max-count' | 'pickaxe-string' | 'pickaxe-regex';

const LOG_SHORT_ARGV_CATALOG = defineArgvCatalog<LogShortSemantic>({
  nonExecutableLongOptions: [],
  definitions: [
    { semantic: 'patch', forms: [{ kind: 'short', name: 'p', value: { kind: 'none' } }] },
    { semantic: 'max-count', forms: [{ kind: 'short', name: 'n', value: { kind: 'required-attached-or-following', missingValueName: 'count' } }] },
    { semantic: 'pickaxe-string', forms: [{ kind: 'short', name: 'S', value: { kind: 'required-attached-or-following', missingValueName: 'string' } }] },
    { semantic: 'pickaxe-regex', forms: [{ kind: 'short', name: 'G', value: { kind: 'required-attached-or-following', missingValueName: 'regex' } }] },
  ],
});

export interface GitLogArguments {
  format: string | undefined,
  oneline: boolean,
  decorationMode: GitLogDecorationMode,
  graph: boolean,
  maxCount: number,
  allRefs: boolean,
  showStat: boolean,
  showPatch: boolean,
  nameOnly: boolean,
  nameStatus: boolean,
  follow: boolean,
  sinceTimestamp: number | undefined,
  untilTimestamp: number | undefined,
  grepPatterns: readonly GitBasicRegex[],
  pickaxeString: string | undefined,
  pickaxeRegex: GitExtendedRegex | undefined,
  revisionTerms: readonly string[],
  pathOperands: readonly string[],
}

function parseLogDateBoundary({ value }: {
    value: string;
}): number {
  if (/^@-?[0-9]+$/u.test(value))
    return Number.parseInt(value.slice(1), 10);
  const rawTimestamp = /^([0-9]{9,})(?:[ \t]+[+-][0-9]{4})?$/u.exec(value);
  if (rawTimestamp !== null)
    return Number.parseInt(rawTimestamp[1]!, 10);
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
  let nameOnly = false;
  let nameStatus = false;
  let follow = false;
  let sinceTimestamp: number | undefined;
  let untilTimestamp: number | undefined;
  const grepPatterns: GitBasicRegex[] = [];
  let pickaxeString: string | undefined;
  let pickaxeRegex: GitExtendedRegex | undefined;
  let parsingOptions = true;
  let readingPaths = false;
  const revisionTerms: string[] = [];
  const pathOperands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      readingPaths = true;
      continue;
    }
    if (readingPaths) {
      pathOperands.push(arg);
      continue;
    }
    if (parsingOptions && /^-[0-9]+$/u.test(arg)) {
      maxCount = parseGitMaxCount({ value: arg.slice(1), option: '-n' });
      continue;
    }
    if (parsingOptions && arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      let bodyOffset = 1;
      while (bodyOffset < arg.length) {
        const analysis = analyzeArgvShortForm({ token: arg, bodyOffset, prefix: '-', catalog: LOG_SHORT_ARGV_CATALOG });
        switch (analysis.kind) {
        case 'unknown':
          throw new Error(`unsupported log argument: ${arg}`);
        case 'matched':
          break;
        default: {
          const _ex: never = analysis;
          throw new Error(`Unhandled log short-option analysis: ${JSON.stringify(_ex)}`);
        }
        }
        switch (analysis.semantic) {
        case 'patch':
          switch (analysis.value.kind) {
          case 'none':
            showPatch = true;
            break;
          case 'inline':
          case 'following-required':
          case 'following-optional':
            throw new Error(`Log -p unexpectedly claimed a value: ${analysis.value.kind}`);
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled log -p value: ${JSON.stringify(_ex)}`);
          }
          }
          break;
        case 'max-count':
          switch (analysis.value.kind) {
          case 'inline':
            maxCount = parseGitMaxCount({ value: analysis.value.rawValue, option: analysis.option });
            break;
          case 'following-required': {
            const value = args[index + 1];
            if (value === undefined)
              throw new Error(`option '${analysis.option}' requires a numeric value`);
            maxCount = parseGitMaxCount({ value, option: analysis.option });
            index += 1;
            break;
          }
          case 'none':
          case 'following-optional':
            throw new Error(`Log -n produced invalid value claim: ${analysis.value.kind}`);
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled log -n value: ${JSON.stringify(_ex)}`);
          }
          }
          break;
        case 'pickaxe-string':
          switch (analysis.value.kind) {
          case 'inline':
            if (analysis.value.rawValue.length === 0)
              throw new Error("option '-S' requires a non-empty value");
            pickaxeString = analysis.value.rawValue;
            break;
          case 'following-required': {
            const value = args[index + 1];
            if (value === undefined || value.length === 0)
              throw new Error("option '-S' requires a non-empty value");
            pickaxeString = value;
            index += 1;
            break;
          }
          case 'none':
          case 'following-optional':
            throw new Error(`Log -S produced invalid value claim: ${analysis.value.kind}`);
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled log -S value: ${JSON.stringify(_ex)}`);
          }
          }
          break;
        case 'pickaxe-regex':
          switch (analysis.value.kind) {
          case 'inline':
            if (analysis.value.rawValue.length === 0)
              throw new Error("option '-G' requires a non-empty value");
            pickaxeRegex = compileGitExtendedRegex({ pattern: analysis.value.rawValue });
            break;
          case 'following-required': {
            const value = args[index + 1];
            if (value === undefined || value.length === 0)
              throw new Error("option '-G' requires a non-empty value");
            pickaxeRegex = compileGitExtendedRegex({ pattern: value });
            index += 1;
            break;
          }
          case 'none':
          case 'following-optional':
            throw new Error(`Log -G produced invalid value claim: ${analysis.value.kind}`);
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled log -G value: ${JSON.stringify(_ex)}`);
          }
          }
          break;
        default: {
          const _ex: never = analysis.semantic;
          throw new Error(`Unhandled log short semantic: ${_ex}`);
        }
        }
        bodyOffset = analysis.nextBodyOffset;
      }
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
    } else if (parsingOptions && arg === '--patch') {
      showPatch = true;
    } else if (parsingOptions && arg === '--name-only') {
      nameOnly = true;
    } else if (parsingOptions && arg === '--name-status') {
      nameStatus = true;
    } else if (parsingOptions && arg === '--follow') {
      follow = true;
    } else if (parsingOptions && arg === '--no-color') {
      // Output is uncolored by Wesh Git.
    } else if (parsingOptions && arg === '--max-count') {
      const value = args[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a numeric value`);
      maxCount = parseGitMaxCount({ value, option: arg });
      index += 1;
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
      const value = args[index + 1];
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
    } else if (parsingOptions && (arg === '--grep')) {
      const value = args[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a value`);
      grepPatterns.push(compileGitBasicRegex({ pattern: value }));
      index += 1;
    } else if (parsingOptions && arg.startsWith('--grep=')) {
      grepPatterns.push(compileGitBasicRegex({ pattern: arg.slice('--grep='.length) }));
    } else if (parsingOptions && arg.startsWith('-')) {
      throw new Error(`unsupported log argument: ${arg}`);
    } else {
      revisionTerms.push(arg);
    }
  }
  if (pickaxeString !== undefined && pickaxeRegex !== undefined)
    throw new Error("options '-G' and '-S' cannot be used together");
  if (nameOnly && nameStatus)
    throw new Error("options '--name-only' and '--name-status' cannot be used together");
  if (follow && pathOperands.length !== 1)
    throw new Error('--follow requires exactly one path');
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
    nameOnly,
    nameStatus,
    follow,
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
