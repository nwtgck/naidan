import {
  GIT_REGEX_DUPLICATION_MAX,
  compileGitPosixBracketExpression,
  encodeGitRegexByteDomain,
  encodeGitRegexBytes,
  escapeGitRegexLiteral,
} from './posix-regex';

type RepetitionKind = 'none' | 'star' | 'plus' | 'question' | 'interval';

export interface GitExtendedRegex {
  readonly byteRegex: RegExp,
}

function parseInterval({ pattern, start }: {
  pattern: string,
  start: number,
}): { source: string, nextIndex: number } {
  const end = pattern.indexOf('}', start + 1);
  if (end < 0) throw new Error('unterminated ERE interval');
  const body = pattern.slice(start + 1, end);
  if (!/^(?:[0-9]+|[0-9]+,|[0-9]+,[0-9]+|,[0-9]+)$/u.test(body))
    throw new Error(`invalid ERE interval: ${body}`);
  const [minimumText, maximumText] = body.split(',');
  const minimum = minimumText!.length === 0 ? 0 : Number.parseInt(minimumText!, 10);
  if (!Number.isSafeInteger(minimum) || minimum > GIT_REGEX_DUPLICATION_MAX)
    throw new Error(`ERE interval is too large: ${body}`);
  if (maximumText !== undefined && maximumText.length > 0) {
    const maximum = Number.parseInt(maximumText, 10);
    if (!Number.isSafeInteger(maximum) || maximum < minimum)
      throw new Error(`invalid ERE interval: ${body}`);
    if (maximum > GIT_REGEX_DUPLICATION_MAX)
      throw new Error(`ERE interval is too large: ${body}`);
  }
  const sourceBody = minimumText!.length === 0 ? `0,${maximumText}` : body;
  return { source: `{${sourceBody}}`, nextIndex: end + 1 };
}

function repetitionKindFor({ operator }: { operator: '*' | '+' | '?' }): Exclude<RepetitionKind, 'none' | 'interval'> {
  switch (operator) {
  case '*': return 'star';
  case '+': return 'plus';
  case '?': return 'question';
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled ERE repetition operator: ${_ex}`);
  }
  }
}

function applyRepetition({ source, atomStart, repetitionKind, operator }: {
  source: string,
  atomStart: number | undefined,
  repetitionKind: RepetitionKind,
  operator: '*' | '+' | '?',
}): { source: string, atomStart: number, repetitionKind: RepetitionKind } {
  if (atomStart === undefined) throw new Error(`invalid preceding regular expression for ${operator}`);
  switch (repetitionKind) {
  case 'none':
    return { source: `${source}${operator}`, atomStart, repetitionKind: repetitionKindFor({ operator }) };
  case 'star':
    return { source, atomStart, repetitionKind: 'star' };
  case 'plus':
    switch (operator) {
    case '+': return { source, atomStart, repetitionKind: 'plus' };
    case '*':
    case '?': return { source: `${source.slice(0, -1)}*`, atomStart, repetitionKind: 'star' };
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled ERE repetition operator: ${_ex}`);
    }
    }
  case 'question':
    switch (operator) {
    case '?': return { source, atomStart, repetitionKind: 'question' };
    case '*':
    case '+': return { source: `${source.slice(0, -1)}*`, atomStart, repetitionKind: 'star' };
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled ERE repetition operator: ${_ex}`);
    }
    }
  case 'interval': {
    const repeatedAtom = source.slice(atomStart);
    return {
      source: `${source.slice(0, atomStart)}(?:${repeatedAtom})${operator}`,
      atomStart,
      repetitionKind: repetitionKindFor({ operator }),
    };
  }
  default: {
    const _ex: never = repetitionKind;
    throw new Error(`Unhandled ERE repetition kind: ${_ex}`);
  }
  }
}

function isBranchEnd({ pattern, index }: { pattern: string, index: number }): boolean {
  return index + 1 >= pattern.length || pattern[index + 1] === '|' || pattern[index + 1] === ')';
}

export function compileGitExtendedRegex({ pattern }: { pattern: string }): GitExtendedRegex {
  const bytePattern = encodeGitRegexByteDomain({ value: pattern });
  let source = '';
  let index = 0;
  let atBranchStart = true;
  let atomStart: number | undefined;
  let repetitionKind: RepetitionKind = 'none';
  const groupStartStack: number[] = [];

  const appendAtom = ({ atomSource }: { atomSource: string }): void => {
    atomStart = source.length;
    source += atomSource;
    repetitionKind = 'none';
    atBranchStart = false;
  };

  while (index < bytePattern.length) {
    const character = bytePattern[index]!;
    if (character === '[') {
      const bracket = compileGitPosixBracketExpression({ pattern: bytePattern, start: index });
      appendAtom({ atomSource: bracket.source });
      index = bracket.nextIndex;
      continue;
    }
    if (character === '\\') {
      const next = bytePattern[index + 1];
      if (next === undefined) throw new Error('extended regular expression ends with an incomplete escape');
      if (/^[1-9]$/u.test(next)) appendAtom({ atomSource: `\\${next}` });
      else {
        switch (next) {
        case '<':
          source += '(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])';
          atomStart = undefined;
          repetitionKind = 'none';
          atBranchStart = false;
          break;
        case '>':
          source += '(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])';
          atomStart = undefined;
          repetitionKind = 'none';
          atBranchStart = false;
          break;
        case 'b':
          source += '\\b';
          atomStart = undefined;
          repetitionKind = 'none';
          atBranchStart = false;
          break;
        case 'B':
          source += '\\B';
          atomStart = undefined;
          repetitionKind = 'none';
          atBranchStart = false;
          break;
        case 'w': appendAtom({ atomSource: '[A-Za-z0-9_]' }); break;
        case 'W': appendAtom({ atomSource: '[^A-Za-z0-9_]' }); break;
        case 's': appendAtom({ atomSource: '[ \\t\\r\\n\\v\\f]' }); break;
        case 'S': appendAtom({ atomSource: '[^ \\t\\r\\n\\v\\f]' }); break;
        default: appendAtom({ atomSource: escapeGitRegexLiteral({ character: next }) }); break;
        }
      }
      index += 2;
      continue;
    }
    if (character === '(') {
      groupStartStack.push(source.length);
      source += '(';
      atomStart = undefined;
      repetitionKind = 'none';
      atBranchStart = true;
      index += 1;
      continue;
    }
    if (character === ')') {
      const groupStart = groupStartStack.pop();
      if (groupStart === undefined) throw new Error('unmatched ERE group close');
      source += ')';
      atomStart = groupStart;
      repetitionKind = 'none';
      atBranchStart = false;
      index += 1;
      continue;
    }
    if (character === '|') {
      source += '|';
      atomStart = undefined;
      repetitionKind = 'none';
      atBranchStart = true;
      index += 1;
      continue;
    }
    if (character === '^') {
      source += atBranchStart ? '^' : '\\^';
      atomStart = undefined;
      repetitionKind = 'none';
      atBranchStart = false;
      index += 1;
      continue;
    }
    if (character === '$') {
      source += isBranchEnd({ pattern: bytePattern, index }) ? '$' : '\\$';
      atomStart = undefined;
      repetitionKind = 'none';
      atBranchStart = false;
      index += 1;
      continue;
    }
    if (character === '.') {
      appendAtom({ atomSource: '.' });
      index += 1;
      continue;
    }
    if (character === '*' || character === '+' || character === '?') {
      const repeated = applyRepetition({ source, atomStart, repetitionKind, operator: character });
      source = repeated.source;
      atomStart = repeated.atomStart;
      repetitionKind = repeated.repetitionKind;
      atBranchStart = false;
      index += 1;
      continue;
    }
    if (character === '{') {
      if (atomStart === undefined || repetitionKind !== 'none')
        throw new Error('invalid preceding expression for ERE interval');
      const interval = parseInterval({ pattern: bytePattern, start: index });
      source += interval.source;
      repetitionKind = 'interval';
      atBranchStart = false;
      index = interval.nextIndex;
      continue;
    }
    appendAtom({ atomSource: escapeGitRegexLiteral({ character }) });
    index += 1;
  }

  if (groupStartStack.length !== 0) throw new Error('unterminated ERE group');
  try {
    return { byteRegex: new RegExp(source, 'u') };
  } catch (error) {
    throw new Error(`invalid extended regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function testGitExtendedRegex({ regex, value }: {
  regex: GitExtendedRegex,
  value: string,
}): boolean {
  regex.byteRegex.lastIndex = 0;
  return regex.byteRegex.test(encodeGitRegexByteDomain({ value }));
}

export function testGitExtendedRegexBytes({ regex, bytes }: {
  regex: GitExtendedRegex,
  bytes: Uint8Array,
}): boolean {
  regex.byteRegex.lastIndex = 0;
  return regex.byteRegex.test(encodeGitRegexBytes({ bytes }));
}

export const TEST_ONLY = {
};
