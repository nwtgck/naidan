import type { GitFiles } from './files';
import { pathExists, readFileText } from './files';
import type { GitRepository } from './repository';
import { joinPath, relativeToWorktree } from './repository';
import { compileGitPattern } from './wildmatch';

interface GitIgnoreRule {
  basePath: string,
  pattern: string,
  negated: boolean,
  directoryOnly: boolean,
  hasSlash: boolean,
  regex: RegExp,
}

export interface GitIgnoreMatcher {
  isIgnored: ({ path, isDirectory }: { path: string, isDirectory: boolean }) => boolean,
}

function stripUnescapedTrailingSpaces({ value }: { value: string }): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ' ') {
    let backslashes = 0;
    for (let index = end - 2; index >= 0 && value[index] === '\\'; index -= 1) backslashes += 1;
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return value.slice(0, end);
}

function parseRule({ line, basePath }: { line: string, basePath: string }): GitIgnoreRule | undefined {
  let value = stripUnescapedTrailingSpaces({ value: line.replace(/\r$/u, '') });
  if (value.length === 0) return undefined;
  if (value.startsWith('#')) return undefined;
  if (value.startsWith('\\#')) value = value.slice(1);

  let negated = false;
  if (value.startsWith('!')) {
    negated = true;
    value = value.slice(1);
  } else if (value.startsWith('\\!')) {
    value = value.slice(1);
  }
  if (value.length === 0) return undefined;

  const directoryOnly = value.endsWith('/') && !value.endsWith('\\/');
  if (directoryOnly) value = value.slice(0, -1);
  if (value.startsWith('/')) value = value.slice(1);
  if (value.length === 0) return undefined;
  const hasSlash = value.includes('/');
  return {
    basePath,
    pattern: value,
    negated,
    directoryOnly,
    hasSlash,
    regex: compileGitPattern({ pattern: value, basenameAnywhere: !hasSlash }),
  };
}

function isWithinBase({ path, basePath }: { path: string, basePath: string }): boolean {
  return basePath.length === 0 || path === basePath || path.startsWith(`${basePath}/`);
}

function relativeToBase({ path, basePath }: { path: string, basePath: string }): string {
  if (basePath.length === 0) return path;
  if (path === basePath) return '';
  return path.slice(basePath.length + 1);
}

function ruleMatches({ rule, path, isDirectory }: {
  rule: GitIgnoreRule,
  path: string,
  isDirectory: boolean,
}): boolean {
  if (!isWithinBase({ path, basePath: rule.basePath })) return false;
  if (rule.directoryOnly && !isDirectory) return false;
  const relative = relativeToBase({ path, basePath: rule.basePath });
  if (relative.length === 0) return false;
  return rule.regex.test(relative);
}

function evaluateRules({ rules, path, isDirectory }: {
  rules: readonly GitIgnoreRule[],
  path: string,
  isDirectory: boolean,
}): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches({ rule, path, isDirectory })) ignored = !rule.negated;
  }
  return ignored;
}

function parentDirectories({ path }: { path: string }): string[] {
  const segments = path.split('/');
  const result: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    result.push(segments.slice(0, index).join('/'));
  }
  return result;
}

function matcherFromRules({ rules }: { rules: readonly GitIgnoreRule[] }): GitIgnoreMatcher {
  return {
    isIgnored: ({ path, isDirectory }) => {
      for (const parent of parentDirectories({ path })) {
        if (evaluateRules({ rules, path: parent, isDirectory: true })) return true;
      }
      return evaluateRules({ rules, path, isDirectory });
    },
  };
}

function parseRules({ text, basePath }: { text: string, basePath: string }): GitIgnoreRule[] {
  const result: GitIgnoreRule[] = [];
  for (const line of text.split('\n')) {
    const rule = parseRule({ line, basePath });
    if (rule !== undefined) result.push(rule);
  }
  return result;
}

export async function loadIgnoreMatcher({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitIgnoreMatcher> {
  const rules: GitIgnoreRule[] = [];
  const infoExclude = joinPath({ base: repository.commonDirPath, child: 'info/exclude' });
  if (await pathExists({ files, path: infoExclude })) {
    rules.push(...parseRules({ text: await readFileText({ files, path: infoExclude }), basePath: '' }));
  }

  const visit = async ({ directoryPath }: { directoryPath: string }): Promise<void> => {
    const basePath = relativeToWorktree({ repository, absolutePath: directoryPath });
    const ignoreFile = joinPath({ base: directoryPath, child: '.gitignore' });
    if (await pathExists({ files, path: ignoreFile })) {
      rules.push(...parseRules({ text: await readFileText({ files, path: ignoreFile }), basePath }));
    }
    const currentMatcher = matcherFromRules({ rules });
    for await (const entry of files.readDir({ path: directoryPath })) {
      if (entry.name === '.git' || entry.name === '.gitignore') continue;
      switch (entry.type) {
      case 'directory': {
        const relativePath = relativeToWorktree({ repository, absolutePath: entry.fullPath });
        if (!currentMatcher.isIgnored({ path: relativePath, isDirectory: true })) {
          await visit({ directoryPath: entry.fullPath });
        }
        break;
      }
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        break;
      default: {
        const _ex: never = entry.type;
        throw new Error(`Unhandled ignore path type: ${_ex}`);
      }
      }
    }
  };
  await visit({ directoryPath: repository.worktreePath });
  return matcherFromRules({ rules });
}

export const TEST_ONLY = {
  parseRule,
};
