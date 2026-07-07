type DuPatternToken =
  | { kind: 'literal', value: string }
  | { kind: 'any' }
  | { kind: 'star' }
  | {
      kind: 'class',
      negated: boolean,
      ranges: Array<{ start: string, end: string }>,
    };

export interface CompiledDuPattern {
  target: 'basename' | 'path',
  tokens: DuPatternToken[],
}

interface DuPatternWorkspace {
  previous: Uint8Array,
  next: Uint8Array,
}

function parseCharacterClass({
  characters: patternCharacters,
  startIndex,
}: {
  characters: string[],
  startIndex: number,
}): { token: DuPatternToken, nextIndex: number } | undefined {
  let index = startIndex + 1;
  if (index >= patternCharacters.length) {
    return undefined;
  }

  let negated = false;
  if (patternCharacters[index] === '!' || patternCharacters[index] === '^') {
    negated = true;
    index += 1;
  }

  const characters: string[] = [];
  if (patternCharacters[index] === ']') {
    characters.push(']');
    index += 1;
  }

  while (index < patternCharacters.length && patternCharacters[index] !== ']') {
    const current = patternCharacters[index];
    if (current === undefined) {
      break;
    }
    if (current === '\\' && index + 1 < patternCharacters.length) {
      const escaped = patternCharacters[index + 1];
      if (escaped !== undefined) {
        characters.push(escaped);
        index += 2;
        continue;
      }
    }
    characters.push(current);
    index += 1;
  }

  if (patternCharacters[index] !== ']' || characters.length === 0) {
    return undefined;
  }

  const ranges: Array<{ start: string, end: string }> = [];
  for (let characterIndex = 0; characterIndex < characters.length; characterIndex += 1) {
    const start = characters[characterIndex];
    if (start === undefined) {
      continue;
    }
    if (
      characterIndex + 2 < characters.length
      && characters[characterIndex + 1] === '-'
    ) {
      const end = characters[characterIndex + 2];
      if (end !== undefined) {
        ranges.push({ start, end });
        characterIndex += 2;
        continue;
      }
    }
    ranges.push({ start, end: start });
  }

  return {
    token: {
      kind: 'class',
      negated,
      ranges,
    },
    nextIndex: index + 1,
  };
}

export function compileDuPattern({ pattern }: { pattern: string }): CompiledDuPattern {
  const tokens: DuPatternToken[] = [];
  const patternCharacters = Array.from(pattern);
  let index = 0;
  while (index < patternCharacters.length) {
    const character = patternCharacters[index];
    if (character === undefined) {
      break;
    }

    switch (character) {
    case '*': {
      const previousToken = tokens[tokens.length - 1];
      const shouldAppend = (() => {
        if (previousToken === undefined) {
          return true;
        }
        switch (previousToken.kind) {
        case 'star':
          return false;
        case 'literal':
        case 'any':
        case 'class':
          return true;
        default: {
          const _ex: never = previousToken;
          throw new Error(`Unhandled previous du pattern token: ${String(_ex)}`);
        }
        }
      })();
      if (shouldAppend) {
        tokens.push({ kind: 'star' });
      }
      index += 1;
      break;
    }
    case '?':
      tokens.push({ kind: 'any' });
      index += 1;
      break;
    case '[': {
      const parsedClass = parseCharacterClass({
        characters: patternCharacters,
        startIndex: index,
      });
      if (parsedClass === undefined) {
        tokens.push({ kind: 'literal', value: '[' });
        index += 1;
        break;
      }
      tokens.push(parsedClass.token);
      index = parsedClass.nextIndex;
      break;
    }
    case '\\': {
      const escaped = patternCharacters[index + 1];
      if (escaped === undefined) {
        tokens.push({ kind: 'literal', value: '\\' });
        index += 1;
        break;
      }
      tokens.push({ kind: 'literal', value: escaped });
      index += 2;
      break;
    }
    default:
      tokens.push({ kind: 'literal', value: character });
      index += 1;
      break;
    }
  }

  return {
    target: pattern.includes('/') ? 'path' : 'basename',
    tokens,
  };
}

function characterClassMatches({
  character,
  token,
}: {
  character: string,
  token: Extract<DuPatternToken, { kind: 'class' }>,
}): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }

  const matched = token.ranges.some(({ start, end }) => {
    const startPoint = start.codePointAt(0);
    const endPoint = end.codePointAt(0);
    if (startPoint === undefined || endPoint === undefined || startPoint > endPoint) {
      return false;
    }
    return codePoint >= startPoint && codePoint <= endPoint;
  });
  return token.negated ? !matched : matched;
}

function matchesTokens({
  tokens,
  characters,
  workspace,
}: {
  tokens: DuPatternToken[],
  characters: string[],
  workspace: DuPatternWorkspace,
}): boolean {
  let previous = workspace.previous;
  let next = workspace.next;
  previous.fill(0);
  next.fill(0);
  previous[0] = 1;

  for (const token of tokens) {
    next.fill(0);
    switch (token.kind) {
    case 'star':
      next[0] = previous[0] ?? 0;
      for (let index = 1; index <= characters.length; index += 1) {
        next[index] = (next[index - 1] === 1 || previous[index] === 1) ? 1 : 0;
      }
      break;
    case 'any':
      for (let index = 1; index <= characters.length; index += 1) {
        next[index] = previous[index - 1] ?? 0;
      }
      break;
    case 'literal':
      for (let index = 1; index <= characters.length; index += 1) {
        next[index] = previous[index - 1] === 1 && characters[index - 1] === token.value ? 1 : 0;
      }
      break;
    case 'class':
      for (let index = 1; index <= characters.length; index += 1) {
        const character = characters[index - 1];
        next[index] = character !== undefined
          && previous[index - 1] === 1
          && characterClassMatches({ character, token })
          ? 1
          : 0;
      }
      break;
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled du pattern token: ${_ex}`);
    }
    }

    const swap = previous;
    previous = next;
    next = swap;
  }

  return previous[characters.length] === 1;
}

function createWorkspace({ characterCount }: { characterCount: number }): DuPatternWorkspace {
  return {
    previous: new Uint8Array(characterCount + 1),
    next: new Uint8Array(characterCount + 1),
  };
}

export function duPatternsMatch({
  patterns,
  displayPath,
  basename,
}: {
  patterns: CompiledDuPattern[],
  displayPath: string,
  basename: string,
}): boolean {
  let pathCharacters: string[] | undefined;
  let pathWorkspace: DuPatternWorkspace | undefined;
  let basenameCharacters: string[] | undefined;
  let basenameWorkspace: DuPatternWorkspace | undefined;

  for (const pattern of patterns) {
    switch (pattern.target) {
    case 'path': {
      pathCharacters ??= Array.from(displayPath);
      pathWorkspace ??= createWorkspace({ characterCount: pathCharacters.length });
      if (matchesTokens({
        tokens: pattern.tokens,
        characters: pathCharacters,
        workspace: pathWorkspace,
      })) {
        return true;
      }
      break;
    }
    case 'basename': {
      basenameCharacters ??= Array.from(basename);
      basenameWorkspace ??= createWorkspace({ characterCount: basenameCharacters.length });
      if (matchesTokens({
        tokens: pattern.tokens,
        characters: basenameCharacters,
        workspace: basenameWorkspace,
      })) {
        return true;
      }
      break;
    }
    default: {
      const _ex: never = pattern.target;
      throw new Error(`Unhandled du pattern target: ${_ex}`);
    }
    }
  }

  return false;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
