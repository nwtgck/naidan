function regexEscape({ value }: { value: string }): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function createGitGlobSource({ pattern, wildcardMatchesSlash }: { pattern: string, wildcardMatchesSlash: boolean }): string {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '\\' && index + 1 < pattern.length) {
      source += regexEscape({ value: pattern[index + 1]! });
      index += 1;
      continue;
    }
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1;
        if (pattern[index + 1] === '/') {
          source += '(?:.*/)?';
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
      const close = pattern.indexOf(']', index + 1);
      if (close > index + 1) {
        let body = pattern.slice(index + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        source += `[${body}]`;
        index = close;
        continue;
      }
    }
    source += regexEscape({ value: character });
  }
  return source;
}


export function gitGlobSource({ pattern }: { pattern: string }): string {
  return createGitGlobSource({ pattern, wildcardMatchesSlash: false });
}

export function gitPathspecGlobSource({ pattern }: { pattern: string }): string {
  return createGitGlobSource({ pattern, wildcardMatchesSlash: true });
}

export function compileGitPattern({ pattern, basenameAnywhere }: {
  pattern: string,
  basenameAnywhere: boolean,
}): RegExp {
  const source = gitGlobSource({ pattern });
  return basenameAnywhere
    ? new RegExp(`(?:^|/)${source}$`, 'u')
    : new RegExp(`^${source}$`, 'u');
}

export const TEST_ONLY = {
};
