import { encodeGitRegexByteDomain, gitPosixCharacterClassSource } from './posix-regex';

export type GitWildmatchSlashMode = 'wildcards-exclude-slash' | 'wildcards-include-slash';
export type GitWildmatchAnchorMode = 'full' | 'basename-anywhere';

export interface GitWildmatchMatcher {
  matches: ({ value }: { value: string }) => boolean,
}


function wildcardsMatchSlash({ slashMode }: { slashMode: GitWildmatchSlashMode }): boolean {
  switch (slashMode) {
  case 'wildcards-exclude-slash':
    return false;
  case 'wildcards-include-slash':
    return true;
  default: {
    const _ex: never = slashMode;
    throw new Error(`Unhandled Git wildmatch slash mode: ${_ex}`);
  }
  }
}

function regexEscape({ value }: { value: string }): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function regexClassLiteral({ character, escaped }: { character: string, escaped: boolean }): string {
  if (escaped && character === '-') return '\\x2D';
  switch (character) {
  case '\\':
    return '\\\\';
  case '[':
    return '\\[';
  case ']':
    return '\\]';
  case '^':
    return '\\^';
  default:
    return character;
  }
}

function compileGitBracketExpression({
  pattern,
  start,
  slashMode,
}: {
  pattern: string,
  start: number,
  slashMode: GitWildmatchSlashMode,
}): { source: string, nextIndex: number } | undefined {
  let index = start + 1;
  let negated = false;
  if (pattern[index] === '!' || pattern[index] === '^') {
    negated = true;
    index += 1;
  }

  let body = '';
  let hasContent = false;
  let impossible = false;
  if (pattern[index] === ']') {
    body += regexClassLiteral({ character: ']', escaped: false });
    index += 1;
    hasContent = true;
  }

  while (index < pattern.length) {
    const character = pattern[index]!;
    if (character === ']' && hasContent) {
      const bracket = impossible ? '(?!)' : `[${negated ? '^' : ''}${body}]`;
      return {
        source: wildcardsMatchSlash({ slashMode }) ? bracket : `(?:(?!/)${bracket})`,
        nextIndex: index + 1,
      };
    }
    if (character === '[' && pattern[index + 1] === ':') {
      const end = pattern.indexOf(':]', index + 2);
      if (end < 0) return undefined;
      const name = pattern.slice(index + 2, end);
      const translated = gitPosixCharacterClassSource({ name });
      if (translated === undefined) impossible = true;
      else body += translated;
      index = end + 2;
      hasContent = true;
      continue;
    }

    const startEscaped = character === '\\' && index + 1 < pattern.length;
    const startCharacter = startEscaped ? pattern[index + 1]! : character;
    const afterStart = index + (startEscaped ? 2 : 1);
    if (pattern[afterStart] === '-' && pattern[afterStart + 1] !== undefined && pattern[afterStart + 1] !== ']') {
      const endIndex = afterStart + 1;
      const endEscaped = pattern[endIndex] === '\\' && pattern[endIndex + 1] !== undefined;
      const endCharacter = endEscaped ? pattern[endIndex + 1]! : pattern[endIndex]!;
      const rangeEnd = endIndex + (endEscaped ? 2 : 1);
      if (startCharacter.charCodeAt(0) <= endCharacter.charCodeAt(0)) {
        body += `${regexClassLiteral({ character: startCharacter, escaped: startEscaped })}-${regexClassLiteral({ character: endCharacter, escaped: endEscaped })}`;
      } else {
        body += regexClassLiteral({ character: startCharacter, escaped: startEscaped });
      }
      index = rangeEnd;
      hasContent = true;
      continue;
    }
    body += regexClassLiteral({ character: startCharacter, escaped: startEscaped });
    index = afterStart;
    hasContent = true;
  }
  return undefined;
}

function createGitGlobSource({ pattern, slashMode }: {
  pattern: string,
  slashMode: GitWildmatchSlashMode,
}): string {
  const bytePattern = encodeGitRegexByteDomain({ value: pattern });
  const wildcardMatchesSlash = wildcardsMatchSlash({ slashMode });
  let source = '';
  for (let index = 0; index < bytePattern.length; index += 1) {
    const character = bytePattern[index]!;
    if (character === '\\' && index + 1 < bytePattern.length) {
      source += regexEscape({ value: bytePattern[index + 1]! });
      index += 1;
      continue;
    }
    if (character === '*') {
      if (bytePattern[index + 1] === '*') {
        while (bytePattern[index + 1] === '*') index += 1;
        if (bytePattern[index + 1] === '/') {
          source += '(?:.*?/)?';
          index += 1;
        } else {
          source += '.*';
        }
      } else {
        source += wildcardMatchesSlash ? '.*' : '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += wildcardMatchesSlash ? '.' : '[^/]';
      continue;
    }
    if (character === '[') {
      const bracket = compileGitBracketExpression({ pattern: bytePattern, start: index, slashMode });
      if (bracket !== undefined) {
        source += bracket.source;
        index = bracket.nextIndex - 1;
        continue;
      }
    }
    source += regexEscape({ value: character });
  }
  return source;
}

export function compileGitWildmatch({ pattern, slashMode, anchorMode }: {
  pattern: string,
  slashMode: GitWildmatchSlashMode,
  anchorMode: GitWildmatchAnchorMode,
}): GitWildmatchMatcher {
  const source = createGitGlobSource({ pattern, slashMode });
  const anchored = (() => {
    switch (anchorMode) {
    case 'full':
      return `^${source}$`;
    case 'basename-anywhere':
      return `(?:^|/)${source}$`;
    default: {
      const _ex: never = anchorMode;
      throw new Error(`Unhandled Git wildmatch anchor mode: ${_ex}`);
    }
    }
  })();
  const regex = new RegExp(anchored, 's');
  return {
    matches: ({ value }) => regex.test(encodeGitRegexByteDomain({ value })),
  };
}

export const TEST_ONLY = {
};
