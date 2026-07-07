import type { CompiledTreePattern } from './types';

function escapeRegExp({ value }: { value: string }): string {
  return value.replace(/[\\^$+?.()|{}]/g, '\\$&');
}

function splitAlternatives({ pattern }: { pattern: string }): string[] {
  const alternatives: string[] = [];
  let current = '';
  let escaped = false;
  let classDepth = 0;

  for (const char of pattern) {
    if (escaped) {
      current += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '[') {
      classDepth += 1;
      current += char;
      continue;
    }
    if (char === ']' && classDepth > 0) {
      classDepth -= 1;
      current += char;
      continue;
    }
    if (char === '|' && classDepth === 0) {
      alternatives.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (escaped) {
    current += '\\\\';
  }
  alternatives.push(current);
  return alternatives;
}

function compileCharacterClass({ pattern, startIndex }: {
  pattern: string,
  startIndex: number,
}): { source: string, nextIndex: number } {
  let index = startIndex + 1;
  let negated = false;
  if (pattern[index] === '!' || pattern[index] === '^') {
    negated = true;
    index += 1;
  }

  let body = '';
  if (pattern[index] === ']') {
    body += '\\]';
    index += 1;
  }

  for (; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) {
      break;
    }
    if (char === ']') {
      return {
        source: `[${negated ? '^' : ''}${body}]`,
        nextIndex: index + 1,
      };
    }
    if (char === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) {
        body += '\\\\';
        continue;
      }
      body += escapeRegExp({ value: next });
      index += 1;
      continue;
    }
    if (char === '/') {
      body += '\\/';
      continue;
    }
    body += char.replace(/\\/g, '\\\\');
  }

  return {
    source: '\\[',
    nextIndex: startIndex + 1,
  };
}

function compileAlternative({ pattern }: { pattern: string }): string {
  let source = '';
  for (let index = 0; index < pattern.length;) {
    const char = pattern[index];
    if (char === undefined) {
      break;
    }
    if (char === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) {
        source += '\\\\';
        index += 1;
        continue;
      }
      source += escapeRegExp({ value: next });
      index += 2;
      continue;
    }
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      const compiled = compileCharacterClass({ pattern, startIndex: index });
      source += compiled.source;
      index = compiled.nextIndex;
      continue;
    }
    source += escapeRegExp({ value: char });
    index += 1;
  }
  return source;
}

export function compileTreePattern({
  pattern,
  ignoreCase,
}: {
  pattern: string,
  ignoreCase: boolean,
}): CompiledTreePattern {
  const directoryOnly = pattern.endsWith('/') && pattern.length > 1;
  const rawPattern = directoryOnly ? pattern.slice(0, -1) : pattern;
  const alternatives = splitAlternatives({ pattern: rawPattern });
  const source = alternatives.map((alternative) => compileAlternative({ pattern: alternative })).join('|');
  const scope = rawPattern.includes('/') ? 'path' : 'name';
  return {
    rawPattern: pattern,
    directoryOnly,
    matcher: new RegExp(`^(?:${source})$`, ignoreCase ? 'i' : ''),
    scope,
  };
}

export function matchesTreePattern({
  compiled,
  name,
  path,
  isDirectory,
}: {
  compiled: CompiledTreePattern,
  name: string,
  path: string,
  isDirectory: boolean,
}): boolean {
  if (compiled.directoryOnly && !isDirectory) {
    return false;
  }
  const candidate = (() => {
    switch (compiled.scope) {
    case 'path':
      return path;
    case 'name':
      return name;
    default: {
      const _ex: never = compiled.scope;
      throw new Error(`Unhandled pattern scope: ${_ex}`);
    }
    }
  })();
  return compiled.matcher.test(candidate);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  compileTreePattern,
  matchesTreePattern,
};
