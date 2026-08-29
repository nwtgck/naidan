import { GIT_REGEX_DUPLICATION_MAX, compileGitPosixBracketExpression as compileBracketExpression, encodeGitRegexByteDomain as encodeUtf8ByteDomain, escapeGitRegexLiteral as escapeRegexLiteral } from './posix-regex';

type RepetitionKind = 'none' | 'star' | 'plus' | 'question' | 'interval';

export interface GitBasicRegex {
  readonly byteRegex: RegExp,
}

function intervalAt({ pattern, start }: {
  pattern: string,
  start: number,
}): { source: string, nextIndex: number } {
  const end = pattern.indexOf('\\}', start + 2);
  if (end < 0) throw new Error('unterminated BRE interval');
  const body = pattern.slice(start + 2, end);
  if (!/^(?:[0-9]+|[0-9]+,|[0-9]+,[0-9]+|,[0-9]+)$/u.test(body))
    throw new Error(`invalid BRE interval: ${body}`);

  const [minimumText, maximumText] = body.split(',');
  const minimum = minimumText!.length === 0 ? 0 : Number.parseInt(minimumText!, 10);
  if (!Number.isSafeInteger(minimum) || minimum > GIT_REGEX_DUPLICATION_MAX)
    throw new Error(`BRE interval is too large: ${body}`);
  if (maximumText !== undefined && maximumText.length > 0) {
    const maximum = Number.parseInt(maximumText, 10);
    if (!Number.isSafeInteger(maximum) || maximum < minimum)
      throw new Error(`invalid BRE interval: ${body}`);
    if (maximum > GIT_REGEX_DUPLICATION_MAX)
      throw new Error(`BRE interval is too large: ${body}`);
  }
  const sourceBody = minimumText!.length === 0 ? `0,${maximumText}` : body;
  return { source: `{${sourceBody}}`, nextIndex: end + 2 };
}

function isBranchEnd({ pattern, index }: { pattern: string, index: number }): boolean {
  if (index + 1 >= pattern.length) return true;
  return pattern[index + 1] === '\\' && (pattern[index + 2] === ')' || pattern[index + 2] === '|');
}

function appendRepeatableAtom({ source, atomSource }: {
  source: string,
  atomSource: string,
}): { source: string, atomStart: number } {
  const atomStart = source.length;
  return { source: `${source}${atomSource}`, atomStart };
}

function repetitionKindFromEscapedOperator({ operator }: {
  operator: '+' | '?',
}): Extract<RepetitionKind, 'plus' | 'question'> {
  switch (operator) {
  case '+':
    return 'plus';
  case '?':
    return 'question';
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled repetition operator: ${_ex}`);
  }
  }
}

function appendEscapedRepetition({
  source,
  atomStart,
  repetitionKind,
  operator,
}: {
  source: string,
  atomStart: number | undefined,
  repetitionKind: RepetitionKind,
  operator: '+' | '?',
}): { source: string, atomStart: number, repetitionKind: RepetitionKind } {
  if (atomStart === undefined) {
    const literalStart = source.length;
    return {
      source: `${source}\\${operator}`,
      atomStart: literalStart,
      repetitionKind: 'none',
    };
  }

  const repeated = (() => {
    switch (repetitionKind) {
    case 'none':
      return { source: `${source}${operator}`, repetitionKind: repetitionKindFromEscapedOperator({ operator }) };
    case 'star':
      return { source, repetitionKind: 'star' as const };
    case 'plus':
      switch (operator) {
      case '+':
        return { source, repetitionKind: 'plus' as const };
      case '?':
        return { source: `${source.slice(0, -1)}*`, repetitionKind: 'star' as const };
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled repetition operator: ${_ex}`);
      }
      }
    case 'question':
      switch (operator) {
      case '+':
        return { source: `${source.slice(0, -1)}*`, repetitionKind: 'star' as const };
      case '?':
        return { source, repetitionKind: 'question' as const };
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled repetition operator: ${_ex}`);
      }
      }
    case 'interval':
      return {
        source: `${source.slice(0, atomStart)}(?:${source.slice(atomStart)})${operator}`,
        repetitionKind: repetitionKindFromEscapedOperator({ operator }),
      };
    default: {
      const _ex: never = repetitionKind;
      throw new Error(`Unhandled repetition kind: ${_ex}`);
    }
    }
  })();
  return {
    source: repeated.source,
    atomStart,
    repetitionKind: repeated.repetitionKind,
  };
}

export function compileGitBasicRegex({ pattern }: { pattern: string }): GitBasicRegex {
  const bytePattern = encodeUtf8ByteDomain({ value: pattern });
  let source = '';
  let index = 0;
  let atBranchStart = true;
  let atomStart: number | undefined;
  let repetitionKind: RepetitionKind = 'none';
  const groupStartStack: number[] = [];

  while (index < bytePattern.length) {
    const character = bytePattern[index]!;
    if (character === '[') {
      const bracket = compileBracketExpression({ pattern: bytePattern, start: index });
      const appended = appendRepeatableAtom({ source, atomSource: bracket.source });
      source = appended.source;
      atomStart = appended.atomStart;
      repetitionKind = 'none';
      index = bracket.nextIndex;
      atBranchStart = false;
      continue;
    }
    if (character === '\\') {
      const next = bytePattern[index + 1];
      if (next === undefined) throw new Error('basic regular expression ends with an incomplete escape');
      switch (next) {
      case '+':
      case '?': {
        const repeated = appendEscapedRepetition({
          source,
          atomStart,
          repetitionKind,
          operator: next,
        });
        source = repeated.source;
        atomStart = repeated.atomStart;
        repetitionKind = repeated.repetitionKind;
        break;
      }
      case '|':
        source += '|';
        atBranchStart = true;
        atomStart = undefined;
        repetitionKind = 'none';
        index += 2;
        continue;
      case '(':
        groupStartStack.push(source.length);
        source += '(';
        atBranchStart = true;
        atomStart = undefined;
        repetitionKind = 'none';
        index += 2;
        continue;
      case ')': {
        const groupStart = groupStartStack.pop();
        if (groupStart === undefined) throw new Error('unmatched BRE group close');
        source += ')';
        atomStart = groupStart;
        repetitionKind = 'none';
        atBranchStart = false;
        index += 2;
        continue;
      }
      case '{': {
        if (atomStart === undefined || repetitionKind !== 'none')
          throw new Error('invalid preceding expression for BRE interval');
        const interval = intervalAt({ pattern: bytePattern, start: index });
        source += interval.source;
        repetitionKind = 'interval';
        index = interval.nextIndex;
        continue;
      }
      case '<':
        source += '(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])';
        atomStart = undefined;
        repetitionKind = 'none';
        break;
      case '>':
        source += '(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])';
        atomStart = undefined;
        repetitionKind = 'none';
        break;
      case 'b':
        source += '\\b';
        atomStart = undefined;
        repetitionKind = 'none';
        break;
      case 'B':
        source += '\\B';
        atomStart = undefined;
        repetitionKind = 'none';
        break;
      case 'w': {
        const appended = appendRepeatableAtom({ source, atomSource: '[A-Za-z0-9_]' });
        source = appended.source;
        atomStart = appended.atomStart;
        repetitionKind = 'none';
        break;
      }
      case 'W': {
        const appended = appendRepeatableAtom({ source, atomSource: '[^A-Za-z0-9_]' });
        source = appended.source;
        atomStart = appended.atomStart;
        repetitionKind = 'none';
        break;
      }
      case 's': {
        const appended = appendRepeatableAtom({ source, atomSource: '[ \\t\\r\\n\\v\\f]' });
        source = appended.source;
        atomStart = appended.atomStart;
        repetitionKind = 'none';
        break;
      }
      case 'S': {
        const appended = appendRepeatableAtom({ source, atomSource: '[^ \\t\\r\\n\\v\\f]' });
        source = appended.source;
        atomStart = appended.atomStart;
        repetitionKind = 'none';
        break;
      }
      default: {
        let atomSource: string;
        if (/^[1-9]$/u.test(next)) atomSource = `\\${next}`;
        else if (/^[A-Za-z]$/u.test(next)) throw new Error(`unsupported BRE escape: \\${next}`);
        else atomSource = escapeRegexLiteral({ character: next });
        const appended = appendRepeatableAtom({ source, atomSource });
        source = appended.source;
        atomStart = appended.atomStart;
        repetitionKind = 'none';
        break;
      }
      }
      index += 2;
      atBranchStart = false;
      continue;
    }
    if (character === '^') {
      source += atBranchStart ? '^' : '\\^';
      index += 1;
      atomStart = undefined;
      repetitionKind = 'none';
      atBranchStart = false;
      continue;
    }
    if (character === '$') {
      source += isBranchEnd({ pattern: bytePattern, index }) ? '$' : '\\$';
      index += 1;
      atomStart = undefined;
      repetitionKind = 'none';
      atBranchStart = false;
      continue;
    }
    if (character === '.') {
      const appended = appendRepeatableAtom({ source, atomSource: '.' });
      source = appended.source;
      atomStart = appended.atomStart;
      repetitionKind = 'none';
      index += 1;
      atBranchStart = false;
      continue;
    }
    if (character === '*') {
      if (atomStart === undefined) {
        const appended = appendRepeatableAtom({ source, atomSource: '\\*' });
        source = appended.source;
        atomStart = appended.atomStart;
        repetitionKind = 'none';
      } else {
        switch (repetitionKind) {
        case 'none':
          source += '*';
          repetitionKind = 'star';
          break;
        case 'star':
        case 'plus':
        case 'question':
        case 'interval':
          throw new Error('invalid preceding regular expression for *');
        default: {
          const _ex: never = repetitionKind;
          throw new Error(`Unhandled repetition kind: ${_ex}`);
        }
        }
      }
      index += 1;
      atBranchStart = false;
      continue;
    }

    const appended = appendRepeatableAtom({ source, atomSource: escapeRegexLiteral({ character }) });
    source = appended.source;
    atomStart = appended.atomStart;
    repetitionKind = 'none';
    index += 1;
    atBranchStart = false;
  }

  if (groupStartStack.length !== 0) throw new Error('unterminated BRE group');
  try {
    return { byteRegex: new RegExp(source, 'u') };
  } catch (error) {
    throw new Error(`invalid basic regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function testGitBasicRegex({ regex, value }: {
  regex: GitBasicRegex,
  value: string,
}): boolean {
  return regex.byteRegex.test(encodeUtf8ByteDomain({ value }));
}

export function testAnyGitBasicRegex({ regexes, value }: {
  regexes: readonly GitBasicRegex[],
  value: string,
}): boolean {
  const byteValue = encodeUtf8ByteDomain({ value });
  return regexes.some(regex => regex.byteRegex.test(byteValue));
}

export const TEST_ONLY = {
};
