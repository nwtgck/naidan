import type { GitAutoCrlf, GitCoreEol, GitWorktreeContentConfig } from './config';
import type { GitFiles } from './files';
import { pathExists, readFileText } from './files';
import type { GitIndexEntry } from './index-file';
import { readObject } from './objects';
import { compareGitPaths } from './path-order';
import type { GitRepository } from './repository';
import { joinPath, relativeToWorktree } from './repository';
import { compileGitWildmatch } from './wildmatch';
import type { GitWildmatchMatcher } from './wildmatch';

type GitTextAttribute = 'auto' | 'set' | 'unset' | 'unspecified';
type GitEolAttribute = 'crlf' | 'lf' | undefined;

export interface GitPathAttributes {
  text: GitTextAttribute,
  eol: GitEolAttribute,
}

interface GitAttributeRule {
  basePath: string,
  matcher: GitWildmatchMatcher,
  updates: Array<
    | { type: 'text', value: GitTextAttribute }
    | { type: 'eol', value: GitEolAttribute }
  >,
}

export interface GitAttributesMatcher {
  attributesFor: ({ path }: { path: string }) => GitPathAttributes,
  cleanNeedsIndex: ({ path }: { path: string }) => boolean,
  clean: ({ path, bytes, indexBytes }: { path: string, bytes: Uint8Array, indexBytes?: Uint8Array }) => Uint8Array,
  smudge: ({ path, bytes }: { path: string, bytes: Uint8Array }) => Uint8Array,
}

export async function cleanWorktreeBytes({ attributes, files, repository, path, bytes, indexObjectId }: {
  attributes: GitAttributesMatcher,
  files: GitFiles,
  repository: GitRepository,
  path: string,
  bytes: Uint8Array,
  indexObjectId?: string,
}): Promise<Uint8Array> {
  let indexBytes: Uint8Array | undefined;
  if (indexObjectId !== undefined && attributes.cleanNeedsIndex({ path })) {
    const indexObject = await readObject({ files, repository, objectId: indexObjectId });
    switch (indexObject.type) {
    case 'blob':
      indexBytes = indexObject.body;
      break;
    case 'tree':
    case 'commit':
    case 'tag':
      throw new Error(`index entry does not reference a blob: ${path}`);
    default: {
      const _ex: never = indexObject.type;
      throw new Error(`Unhandled Git object type: ${_ex}`);
    }
    }
  }
  return attributes.clean({ path, bytes, indexBytes });
}

function decodeQuotedAttributeToken({ line, start }: { line: string, start: number }): {
  token: string,
  offset: number,
} {
  let token = '';
  let offset = start + 1;
  while (offset < line.length) {
    const character = line[offset]!;
    offset += 1;
    if (character === '"') return { token, offset };
    if (character !== '\\') {
      token += character;
      continue;
    }
    if (offset >= line.length) throw new Error('unterminated quoted attribute token');
    const escaped = line[offset]!;
    offset += 1;
    switch (escaped) {
    case '\\':
    case '"':
      token += escaped;
      break;
    case 't':
      token += '\t';
      break;
    case 'n':
      token += '\n';
      break;
    case 'b':
      token += '\b';
      break;
    default:
      throw new Error(`unsupported quoted attribute escape: \\${escaped}`);
    }
  }
  throw new Error('unterminated quoted attribute token');
}

function tokenizeAttributeLine({ line }: { line: string }): string[] {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < line.length) {
    while (offset < line.length && /\s/u.test(line[offset]!)) offset += 1;
    if (offset >= line.length) break;
    if (line[offset] === '"') {
      const quoted = decodeQuotedAttributeToken({ line, start: offset });
      tokens.push(quoted.token);
      offset = quoted.offset;
      if (offset < line.length && !/\s/u.test(line[offset]!)) {
        throw new Error('quoted attribute token must be followed by whitespace');
      }
      continue;
    }
    const start = offset;
    while (offset < line.length && !/\s/u.test(line[offset]!)) offset += 1;
    tokens.push(line.slice(start, offset));
  }
  return tokens;
}

function parentPath({ path }: { path: string }): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function parseAttributeRules({ text, basePath }: { text: string, basePath: string }): GitAttributeRule[] {
  const rules: GitAttributeRule[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/u, '');
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const tokens = tokenizeAttributeLine({ line });
    const pattern = tokens.shift();
    if (pattern === undefined || pattern.startsWith('!') || pattern.endsWith('/')) continue;
    if (pattern.startsWith('[attr]')) {
      throw new Error(`attribute macros are not supported yet: ${pattern}`);
    }
    const normalizedPattern = pattern.startsWith('/') ? pattern.slice(1) : pattern;
    if (normalizedPattern.length === 0) continue;
    const updates: GitAttributeRule['updates'] = [];
    for (const attribute of tokens) {
      switch (attribute) {
      case 'text':
        updates.push({ type: 'text', value: 'set' });
        break;
      case '-text':
        updates.push({ type: 'text', value: 'unset' });
        break;
      case '!text':
        updates.push({ type: 'text', value: 'unspecified' });
        break;
      case 'text=auto':
        updates.push({ type: 'text', value: 'auto' });
        break;
      case 'eol=lf':
        updates.push({ type: 'eol', value: 'lf' });
        break;
      case 'eol=crlf':
        updates.push({ type: 'eol', value: 'crlf' });
        break;
      case '-eol':
      case '!eol':
        updates.push({ type: 'eol', value: undefined });
        break;
      default:
        if (/^(?:!?-?ident|!?-?filter(?:=.*)?|working-tree-encoding(?:=.*)?)$/u.test(attribute)) {
          throw new Error(`unsupported content-changing attribute: ${attribute}`);
        }
        break;
      }
    }
    if (updates.length === 0) continue;
    rules.push({
      basePath,
      matcher: compileGitWildmatch({
        pattern: normalizedPattern,
        slashMode: 'wildcards-exclude-slash',
        anchorMode: normalizedPattern.includes('/') ? 'full' : 'basename-anywhere',
      }),
      updates,
    });
  }
  return rules;
}

function relativeToBase({ path, basePath }: { path: string, basePath: string }): string | undefined {
  if (basePath.length === 0) return path;
  if (!path.startsWith(`${basePath}/`)) return undefined;
  return path.slice(basePath.length + 1);
}

function containsNul({ bytes }: { bytes: Uint8Array }): boolean {
  return bytes.includes(0);
}

function normalizeCrLf({ bytes }: { bytes: Uint8Array }): Uint8Array {
  let count = 0;
  for (let index = 0; index + 1 < bytes.byteLength; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) count += 1;
  }
  if (count === 0) return bytes;
  const result = new Uint8Array(bytes.byteLength - count);
  let output = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) continue;
    result[output++] = bytes[index]!;
  }
  return result;
}

function autoCrlfNormalizesText({ autoCrlf }: { autoCrlf: GitAutoCrlf }): boolean {
  switch (autoCrlf) {
  case 'false':
    return false;
  case 'true':
  case 'input':
    return true;
  default: {
    const _ex: never = autoCrlf;
    throw new Error(`Unhandled core.autocrlf mode: ${_ex}`);
  }
  }
}

function configuredCheckoutEol({ contentConfig }: { contentConfig: GitWorktreeContentConfig }): GitCoreEol {
  switch (contentConfig.autoCrlf) {
  case 'true':
    return 'crlf';
  case 'input':
    return 'lf';
  case 'false':
    return contentConfig.eol;
  default: {
    const _ex: never = contentConfig.autoCrlf;
    throw new Error(`Unhandled core.autocrlf mode: ${_ex}`);
  }
  }
}

function expandLfToCrLf({ bytes }: { bytes: Uint8Array }): Uint8Array {
  let count = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 10 && (index === 0 || bytes[index - 1] !== 13)) count += 1;
  }
  if (count === 0) return bytes;
  const result = new Uint8Array(bytes.byteLength + count);
  let output = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 10 && (index === 0 || bytes[index - 1] !== 13)) result[output++] = 13;
    result[output++] = bytes[index]!;
  }
  return result;
}

function matcherFromRules({ rules, contentConfig }: {
  rules: readonly GitAttributeRule[],
  contentConfig: GitWorktreeContentConfig,
}): GitAttributesMatcher {
  const attributesFor = ({ path }: { path: string }): GitPathAttributes => {
    const result: GitPathAttributes = { text: 'unspecified', eol: undefined };
    for (const rule of rules) {
      const relative = relativeToBase({ path, basePath: rule.basePath });
      if (relative === undefined || !rule.matcher.matches({ value: relative })) continue;
      for (const update of rule.updates) {
        switch (update.type) {
        case 'text':
          result.text = update.value;
          break;
        case 'eol':
          result.eol = update.value;
          break;
        default: {
          const _ex: never = update;
          throw new Error(`Unhandled attribute update: ${String(_ex)}`);
        }
        }
      }
    }
    return result;
  };
  const cleanNeedsIndex = ({ path }: { path: string }): boolean => {
    const attributes = attributesFor({ path });
    switch (attributes.text) {
    case 'auto':
      return true;
    case 'unspecified':
      return attributes.eol === undefined
        && autoCrlfNormalizesText({ autoCrlf: contentConfig.autoCrlf });
    case 'set':
    case 'unset':
      return false;
    default: {
      const _ex: never = attributes.text;
      throw new Error(`Unhandled text attribute: ${_ex}`);
    }
    }
  };
  return {
    attributesFor,
    cleanNeedsIndex,
    clean: ({ path, bytes, indexBytes }) => {
      const attributes = attributesFor({ path });
      const indexAlreadyHasCrLf = indexBytes !== undefined && normalizeCrLf({ bytes: indexBytes }) !== indexBytes;
      let normalize: boolean;
      switch (attributes.text) {
      case 'unset':
        return bytes;
      case 'set':
        normalize = true;
        break;
      case 'auto':
        normalize = !containsNul({ bytes }) && !indexAlreadyHasCrLf;
        break;
      case 'unspecified':
        normalize = attributes.eol !== undefined
          || autoCrlfNormalizesText({ autoCrlf: contentConfig.autoCrlf })
            && !containsNul({ bytes })
            && !indexAlreadyHasCrLf;
        break;
      default: {
        const _ex: never = attributes.text;
        throw new Error(`Unhandled text attribute: ${_ex}`);
      }
      }
      return normalize ? normalizeCrLf({ bytes }) : bytes;
    },
    smudge: ({ path, bytes }) => {
      const attributes = attributesFor({ path });
      let convertText: boolean;
      switch (attributes.text) {
      case 'unset':
        return bytes;
      case 'set':
        convertText = true;
        break;
      case 'auto':
        convertText = !containsNul({ bytes });
        break;
      case 'unspecified':
        convertText = attributes.eol !== undefined
          || autoCrlfNormalizesText({ autoCrlf: contentConfig.autoCrlf }) && !containsNul({ bytes });
        break;
      default: {
        const _ex: never = attributes.text;
        throw new Error(`Unhandled text attribute: ${_ex}`);
      }
      }
      if (!convertText) return bytes;
      const eol = attributes.eol ?? configuredCheckoutEol({ contentConfig });
      switch (eol) {
      case 'crlf':
        return expandLfToCrLf({ bytes });
      case 'lf':
        return bytes;
      default: {
        const _ex: never = eol;
        throw new Error(`Unhandled eol mode: ${_ex}`);
      }
      }
    },
  };
}

export async function loadWorktreeAttributes({ files, repository, contentConfig }: {
  files: GitFiles,
  repository: GitRepository,
  contentConfig: GitWorktreeContentConfig,
}): Promise<GitAttributesMatcher> {
  const sources: Array<{ basePath: string, text: string }> = [];
  const visit = async ({ directoryPath }: { directoryPath: string }): Promise<void> => {
    const attributePath = joinPath({ base: directoryPath, child: '.gitattributes' });
    if (await pathExists({ files, path: attributePath })) {
      sources.push({
        basePath: relativeToWorktree({ repository, absolutePath: directoryPath }),
        text: await readFileText({ files, path: attributePath }),
      });
    }
    for await (const entry of files.readDir({ path: directoryPath })) {
      if (entry.name === '.git') continue;
      switch (entry.type) {
      case 'directory':
        await visit({ directoryPath: entry.fullPath });
        break;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        break;
      default: {
        const _ex: never = entry.type;
        throw new Error(`Unhandled attribute path type: ${_ex}`);
      }
      }
    }
  };
  await visit({ directoryPath: repository.worktreePath });
  sources.sort((left, right) => left.basePath.split('/').length - right.basePath.split('/').length
    || compareGitPaths({ left: left.basePath, right: right.basePath }));
  const rules = sources.flatMap(source => parseAttributeRules(source));
  const infoAttributesPath = joinPath({ base: repository.commonDirPath, child: 'info/attributes' });
  if (await pathExists({ files, path: infoAttributesPath })) {
    rules.push(...parseAttributeRules({ text: await readFileText({ files, path: infoAttributesPath }), basePath: '' }));
  }
  return matcherFromRules({ rules, contentConfig });
}

export async function loadIndexAttributes({ files, repository, entries, contentConfig }: {
  files: GitFiles,
  repository: GitRepository,
  entries: readonly GitIndexEntry[],
  contentConfig: GitWorktreeContentConfig,
}): Promise<GitAttributesMatcher> {
  const sources: Array<{ basePath: string, text: string }> = [];
  for (const entry of entries) {
    if (entry.stage !== 0 || !entry.path.endsWith('.gitattributes')) continue;
    const baseName = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    if (baseName !== '.gitattributes') continue;
    const object = await readObject({ files, repository, objectId: entry.objectId });
    switch (object.type) {
    case 'blob':
      sources.push({
        basePath: parentPath({ path: entry.path }),
        text: new TextDecoder('utf-8', { fatal: true }).decode(object.body),
      });
      break;
    case 'tree':
    case 'commit':
    case 'tag':
      throw new Error(`attribute file ${entry.path} does not reference a blob`);
    default: {
      const _ex: never = object.type;
      throw new Error(`Unhandled object type: ${_ex}`);
    }
    }
  }
  sources.sort((left, right) => left.basePath.split('/').length - right.basePath.split('/').length
    || compareGitPaths({ left: left.basePath, right: right.basePath }));
  const rules = sources.flatMap(source => parseAttributeRules(source));
  const infoAttributesPath = joinPath({ base: repository.commonDirPath, child: 'info/attributes' });
  if (await pathExists({ files, path: infoAttributesPath })) {
    rules.push(...parseAttributeRules({ text: await readFileText({ files, path: infoAttributesPath }), basePath: '' }));
  }
  return matcherFromRules({ rules, contentConfig });
}

export const TEST_ONLY = {
  normalizeCrLf,
  expandLfToCrLf,
};
