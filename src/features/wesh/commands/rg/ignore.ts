import { compileRgGlobRule, type RgGlobRule } from './glob';

export interface RgIgnoreRule {
  readonly basePath: string,
  readonly directoryOnly: boolean,
  readonly negated: boolean,
  readonly glob: RgGlobRule,
}

export interface RgIgnoreDiagnostic {
  readonly lineNumber: number,
  readonly message: string,
}

export interface RgIgnoreParseResult {
  readonly rules: readonly RgIgnoreRule[],
  readonly diagnostics: readonly RgIgnoreDiagnostic[],
}

function normalizeBasePath({ path }: { path: string }): string {
  if (path === '.' || path === './') return '';
  return path.replace(/^\.\//, '').replace(/\/$/, '');
}

export function parseRgIgnoreFile({
  text,
  basePath,
}: {
  text: string,
  basePath: string,
}): RgIgnoreParseResult {
  const normalizedBasePath = normalizeBasePath({ path: basePath });
  const rules: RgIgnoreRule[] = [];
  const diagnostics: RgIgnoreDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    if (rawLine.length === 0 || rawLine.startsWith('#')) continue;
    const negated = rawLine.startsWith('!');
    let pattern = negated ? rawLine.slice(1) : rawLine;
    if (pattern.length === 0) continue;
    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) pattern = pattern.slice(0, -1);
    if (pattern.startsWith('/')) pattern = pattern.slice(1);
    const anchoredPattern = pattern.includes('/') ? pattern : `**/${pattern}`;
    try {
      rules.push({
        basePath: normalizedBasePath,
        directoryOnly,
        negated,
        glob: compileRgGlobRule({ rawPattern: anchoredPattern, caseInsensitive: false }),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const separatorIndex = message.indexOf(': ');
      const detail = separatorIndex === -1 ? message : message.slice(separatorIndex + 2);
      diagnostics.push({ lineNumber: index + 1, message: `error parsing glob '${pattern}': ${detail}` });
    }
  }
  return { rules, diagnostics };
}

function pathRelativeToBase({
  path,
  basePath,
}: {
  path: string,
  basePath: string,
}): string | undefined {
  const normalizedPath = path.replace(/^\.\//, '');
  if (basePath.length === 0) return normalizedPath;
  if (normalizedPath === basePath) return '';
  if (!normalizedPath.startsWith(`${basePath}/`)) return undefined;
  return normalizedPath.slice(basePath.length + 1);
}

export function isIgnoredByRgRules({
  relativePath,
  isDirectory,
  rules,
}: {
  relativePath: string,
  isDirectory: boolean,
  rules: readonly RgIgnoreRule[],
}): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    const candidate = pathRelativeToBase({ path: relativePath, basePath: rule.basePath });
    if (candidate === undefined) continue;
    if (rule.glob.regex.test(candidate)) ignored = !rule.negated;
  }
  return ignored;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
