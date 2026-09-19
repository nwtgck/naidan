export interface RgGlobRule {
  readonly exclude: boolean,
  readonly regex: RegExp,
  readonly basenameOnly: boolean,
}

function escapeRegex({ text }: { text: string }): string {
  return text.replace(/[\\^$+?.()|{}]/g, '\\$&');
}

function globBodyToRegex({ glob }: { glob: string }): string {
  let result = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          result += '(?:.*/)?';
        } else {
          result += '.*';
        }
      } else {
        result += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      result += '[^/]';
      continue;
    }
    if (char === '[') {
      const close = glob.indexOf(']', index + 1);
      if (close === -1) throw new Error("unclosed character class; missing ']'");
      const body = glob.slice(index + 1, close);
      const normalizedBody = body.startsWith('!') ? `^${body.slice(1)}` : body;
      result += `[${normalizedBody}]`;
      index = close;
      continue;
    }
    result += escapeRegex({ text: char ?? '' });
  }
  return result;
}

export function compileRgGlobRule({
  rawPattern,
  caseInsensitive,
}: {
  rawPattern: string,
  caseInsensitive: boolean,
}): RgGlobRule {
  const exclude = rawPattern.startsWith('!');
  const pattern = exclude ? rawPattern.slice(1) : rawPattern;
  try {
    return {
      exclude,
      basenameOnly: !pattern.includes('/'),
      regex: new RegExp(`^${globBodyToRegex({ glob: pattern })}$`, caseInsensitive ? 'i' : ''),
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`error parsing glob '${rawPattern}': ${detail}`);
  }
}

function basename({ path }: { path: string }): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export function matchesRgGlobRules({
  relativePath,
  rules,
}: {
  relativePath: string,
  rules: readonly RgGlobRule[],
}): boolean {
  let accepted = !rules.some((rule) => !rule.exclude);
  for (const rule of rules) {
    const candidate = rule.basenameOnly ? basename({ path: relativePath }) : relativePath;
    if (rule.regex.test(candidate)) accepted = !rule.exclude;
  }
  return accepted;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
