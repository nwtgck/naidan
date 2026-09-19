import { compileGitExtendedRegex, testGitExtendedRegex, type GitExtendedRegex } from "./extended-regex";
import type { GitFiles } from "./files";
import { pathExists, readFileText, replaceTextViaLock } from "./files";
import type { GitRepository } from "./repository";
import { joinPath } from "./repository";

export type GitConfigValue =
  | { readonly kind: 'implicit-boolean' }
  | { readonly kind: 'explicit', readonly value: string };

export type GitConfig = Map<string, GitConfigValue>;

export interface GitConfigValuePattern {
  readonly regex: GitExtendedRegex,
  readonly inverted: boolean,
}

function configWholeValueRegexSource({ source }: { source: string }): string {
  let result = '';
  let escaped = false;
  let inCharacterClass = false;
  for (const character of source) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '[' && !inCharacterClass) {
      inCharacterClass = true;
      result += character;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      result += character;
      continue;
    }
    result += character === '$' && !inCharacterClass ? '(?![\\s\\S])' : character;
  }
  return result;
}

export function compileGitConfigValuePattern({ pattern }: { pattern: string }): GitConfigValuePattern {
  const inverted = pattern.startsWith('!');
  const regexPattern = inverted ? pattern.slice(1) : pattern;
  const compiled = compileGitExtendedRegex({ pattern: regexPattern });
  return {
    regex: {
      byteRegex: new RegExp(configWholeValueRegexSource({ source: compiled.byteRegex.source }), 'su'),
    },
    inverted,
  };
}

export function configValueMatchesPattern({ value, valuePattern }: {
  value: string,
  valuePattern: GitConfigValuePattern,
}): boolean {
  const matches = testGitExtendedRegex({ regex: valuePattern.regex, value });
  return valuePattern.inverted ? !matches : matches;
}

export interface GitCommandConfigEntry {
  readonly key: string,
  readonly value: GitConfigValue,
}

// Parsed `git -c` values are invocation-local typed metadata. Keep them out of
// string-only GIT_CONFIG_VALUE_n transport so valueless and explicit-empty
// assignments remain distinct without reserving a user-visible sentinel value.
const commandConfigEntriesByEnv = new WeakMap<ReadonlyMap<string, string>, readonly GitCommandConfigEntry[]>();

export function registerGitCommandConfigEntries({ env, entries }: {
  env: ReadonlyMap<string, string>,
  entries: readonly GitCommandConfigEntry[],
}): void {
  commandConfigEntriesByEnv.set(env, [...entries]);
}

export interface GitConfigEntry {
  key: string,
  value: GitConfigValue,
}

export type GitAutoCrlf = 'false' | 'true' | 'input';
export type GitCoreEol = 'lf' | 'crlf';

export interface GitWorktreeContentConfig {
  autoCrlf: GitAutoCrlf,
  eol: GitCoreEol,
}

function isValidConfigVariableName({ name }: { name: string }): boolean {
  return /^[A-Za-z][A-Za-z0-9-]*$/u.test(name);
}

function normalizeConfigKey({ section, subsection, name }: {
  section: string,
  subsection: string | undefined,
  name: string,
}): string {
  return subsection === undefined
    ? `${section.toLowerCase()}.${name.toLowerCase()}`
    : `${section.toLowerCase()}.${subsection}.${name.toLowerCase()}`;
}

function normalizeConfigKeyString({ key }: { key: string }): string {
  const { section, subsection, name } = parseConfigKey({ key });
  return normalizeConfigKey({ section, subsection, name });
}

export function configKeysEqual({ left, right }: {
  left: string,
  right: string,
}): boolean {
  return normalizeConfigKeyString({ key: left }) === normalizeConfigKeyString({ key: right });
}

function parseExplicitConfigValue({ rawValue }: { rawValue: string }): string {
  let result = '';
  let pendingWhitespace = '';
  let inQuotes = false;
  let escaped = false;
  let started = false;

  const appendPendingWhitespace = () => {
    if (pendingWhitespace.length === 0) return;
    result += pendingWhitespace;
    pendingWhitespace = '';
  };

  for (const character of rawValue) {
    if (escaped) {
      appendPendingWhitespace();
      switch (character) {
      case 'n':
        result += '\n';
        break;
      case 't':
        result += '\t';
        break;
      case 'b':
        result += '\b';
        break;
      case '\\':
      case '"':
        result += character;
        break;
      default:
        throw new Error(`invalid config escape: \\${character}`);
      }
      escaped = false;
      started = true;
      continue;
    }

    if (character === '\\') {
      escaped = true;
      continue;
    }

    if (character === '"') {
      if (!inQuotes && started) appendPendingWhitespace();
      inQuotes = !inQuotes;
      started = true;
      continue;
    }

    if (!inQuotes && (character === '#' || character === ';')) break;

    if (!inQuotes && /\s/u.test(character)) {
      if (started) pendingWhitespace += character;
      continue;
    }

    appendPendingWhitespace();
    result += character;
    started = true;
  }

  if (escaped) throw new Error('config value ends with an incomplete escape');
  if (inQuotes) throw new Error('config value has an unterminated quote');
  return result;
}

function parseConfigSubsection({ rawSubsection }: { rawSubsection: string }): string {
  let result = '';
  let escaped = false;
  for (const character of rawSubsection) {
    if (escaped) {
      switch (character) {
      case '\\':
      case '"':
        result += character;
        break;
      default:
        throw new Error(`invalid config subsection escape: \\${character}`);
      }
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    result += character;
  }
  if (escaped) throw new Error('config subsection ends with an incomplete escape');
  return result;
}

function parseConfigSectionHeader({ line }: { line: string }): {
  section: string,
  subsection: string | undefined,
} | undefined {
  const match = /^\s*\[([^\s\]"]+)(?:\s+"((?:\\[\\"]|[^"\\])*)")?\]\s*(?:[#;].*)?$/u.exec(line);
  if (match === null) return undefined;
  return {
    section: match[1]!,
    subsection: match[2] === undefined
      ? undefined
      : parseConfigSubsection({ rawSubsection: match[2] }),
  };
}

export function parseConfigEntries({ text }: { text: string }): GitConfigEntry[] {
  const result: GitConfigEntry[] = [];
  let section: string | undefined;
  let subsection: string | undefined;
  const logicalText = text.replace(/\\\r?\n/gu, '');
  for (const rawLine of logicalText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionHeader = parseConfigSectionHeader({ line });
    if (sectionHeader !== undefined) {
      section = sectionHeader.section;
      subsection = sectionHeader.subsection;
      continue;
    }
    if (line.startsWith('[')) throw new Error(`bad config line: ${line}`);
    const assignment = /^([^=\s]+)\s*=([\s\S]*)$/u.exec(line);
    if (assignment !== null) {
      const name = assignment[1]!;
      if (!isValidConfigVariableName({ name })) throw new Error(`invalid config variable name: ${name}`);
      result.push({
        key: section === undefined ? name.toLowerCase() : normalizeConfigKey({ section, subsection, name }),
        value: { kind: 'explicit', value: parseExplicitConfigValue({ rawValue: assignment[2]! }) },
      });
      continue;
    }
    const implicit = /^([^=\s]+)$/u.exec(line);
    if (implicit !== null) {
      const name = implicit[1]!;
      if (!isValidConfigVariableName({ name })) throw new Error(`invalid config variable name: ${name}`);
      result.push({
        key: section === undefined ? name.toLowerCase() : normalizeConfigKey({ section, subsection, name }),
        value: { kind: 'implicit-boolean' },
      });
      continue;
    }
    throw new Error(`bad config line: ${line}`);
  }
  return result;
}

export function parseConfig({ text }: { text: string }): GitConfig {
  const result: GitConfig = new Map();
  for (const entry of parseConfigEntries({ text })) result.set(entry.key, entry.value);
  return result;
}

export async function readLocalConfig({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitConfig> {
  const path = joinPath({ base: repository.commonDirPath, child: "config" });
  if (!await pathExists({ files, path })) return new Map();
  return parseConfig({ text: await readFileText({ files, path }) });
}

export async function readLocalConfigEntries({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitConfigEntry[]> {
  const path = joinPath({ base: repository.commonDirPath, child: 'config' });
  if (!await pathExists({ files, path })) return [];
  return parseConfigEntries({ text: await readFileText({ files, path }) });
}

function globalConfigPath({ homePath, cwd, env }: {
  homePath: string,
  cwd: string,
  env: ReadonlyMap<string, string>,
}): string {
  const override = env.get('GIT_CONFIG_GLOBAL');
  if (override === undefined) return joinPath({ base: homePath, child: '.gitconfig' });
  if (override.length === 0) return '';
  return joinPath({ base: cwd, child: override });
}

export async function readGlobalConfigEntries({ files, homePath, cwd, env }: {
  files: GitFiles,
  homePath: string,
  cwd: string,
  env: ReadonlyMap<string, string>,
}): Promise<GitConfigEntry[]> {
  const path = globalConfigPath({ homePath, cwd, env });
  if (!await pathExists({ files, path })) return [];
  return parseConfigEntries({ text: await readFileText({ files, path }) });
}

export async function readRequiredGlobalConfigEntries({ files, homePath, cwd, env }: {
  files: GitFiles,
  homePath: string,
  cwd: string,
  env: ReadonlyMap<string, string>,
}): Promise<GitConfigEntry[]> {
  const path = globalConfigPath({ homePath, cwd, env });
  if (!await pathExists({ files, path })) {
    throw new Error(`unable to read config file '${path}': No such file or directory`);
  }
  return parseConfigEntries({ text: await readFileText({ files, path }) });
}

export async function readGlobalConfig({ files, homePath, cwd, env }: {
  files: GitFiles,
  homePath: string,
  cwd: string,
  env: ReadonlyMap<string, string>,
}): Promise<GitConfig> {
  const result: GitConfig = new Map();
  for (const entry of await readGlobalConfigEntries({ files, homePath, cwd, env })) result.set(entry.key, entry.value);
  return result;
}

function parseEnvironmentCommandConfigCount({ rawCount }: { rawCount: string | undefined }): number {
  if (rawCount === undefined || rawCount.trim().length === 0) return 0;
  const normalized = rawCount.trim();
  if (!/^\+?[0-9]+$/u.test(normalized)) throw new Error('invalid GIT_CONFIG_COUNT');
  const count = Number(normalized);
  if (!Number.isSafeInteger(count)) throw new Error('invalid GIT_CONFIG_COUNT');
  return count;
}

export function readCommandConfigEntries({ env }: {
  env: ReadonlyMap<string, string>,
}): GitConfigEntry[] {
  const result: GitConfigEntry[] = [];
  const count = parseEnvironmentCommandConfigCount({ rawCount: env.get('GIT_CONFIG_COUNT') });
  if (count > 0) {
    for (let index = 0; index < count; index += 1) {
      const key = env.get(`GIT_CONFIG_KEY_${index}`);
      const value = env.get(`GIT_CONFIG_VALUE_${index}`);
      if (key === undefined || value === undefined) throw new Error(`missing command config entry ${index}`);
      const { section, subsection, name } = parseConfigKey({ key });
      result.push({
        key: normalizeConfigKey({ section, subsection, name }),
        value: { kind: 'explicit', value },
      });
    }
  }

  for (const entry of commandConfigEntriesByEnv.get(env) ?? []) {
    const { section, subsection, name } = parseConfigKey({ key: entry.key });
    result.push({
      key: normalizeConfigKey({ section, subsection, name }),
      value: entry.value,
    });
  }
  return result;
}

export async function readEffectiveConfigEntries({ files, repository, homePath, cwd, env }: {
  files: GitFiles,
  repository: GitRepository,
  homePath: string,
  cwd: string,
  env: ReadonlyMap<string, string>,
}): Promise<GitConfigEntry[]> {
  return [
    ...await readGlobalConfigEntries({ files, homePath, cwd, env }),
    ...await readLocalConfigEntries({ files, repository }),
    ...readCommandConfigEntries({ env }),
  ];
}

export async function readEffectiveConfig({ files, repository, homePath, cwd, env }: {
  files: GitFiles,
  repository: GitRepository,
  homePath: string,
  cwd: string,
  env: ReadonlyMap<string, string>,
}): Promise<GitConfig> {
  const result: GitConfig = new Map();
  for (const entry of await readEffectiveConfigEntries({ files, repository, homePath, cwd, env })) {
    result.set(entry.key, entry.value);
  }
  return result;
}

function parseBooleanConfig({ key, value }: { key: string, value: string }): boolean {
  switch (value.trim().toLowerCase()) {
  case 'true':
  case 'yes':
  case 'on':
  case '1':
    return true;
  case '':
  case 'false':
  case 'no':
  case 'off':
  case '0':
    return false;
  default:
    throw new Error(`bad boolean config value '${value}' for '${key}'`);
  }
}

export function resolveWorktreeContentConfig({ config }: { config: GitConfig }): GitWorktreeContentConfig {
  const rawAutoCrlf = getConfigValue({ config, key: 'core.autocrlf' });
  let autoCrlf: GitAutoCrlf = 'false';
  if (rawAutoCrlf !== undefined) {
    const normalized = rawAutoCrlf.trim().toLowerCase();
    if (normalized === 'input') autoCrlf = 'input';
    else autoCrlf = getBooleanConfigValue({ config, key: 'core.autocrlf' }) ? 'true' : 'false';
  }

  const rawEol = getConfigValue({ config, key: 'core.eol' });
  const normalizedEol = rawEol?.trim().toLowerCase();
  const eol: GitCoreEol = normalizedEol === 'crlf' ? 'crlf' : 'lf';
  return { autoCrlf, eol };
}

export async function readWorktreeContentConfig({ files, repository, homePath, cwd, env }: {
  files: GitFiles,
  repository: GitRepository,
  homePath: string,
  cwd: string,
  env: ReadonlyMap<string, string>,
}): Promise<GitWorktreeContentConfig> {
  return resolveWorktreeContentConfig({
    config: await readEffectiveConfig({ files, repository, homePath, cwd, env }),
  });
}

function validateSafeCrlfConfig({ config }: { config: GitConfig }): string | undefined {
  const safeCrlf = getConfigValue({ config, key: 'core.safecrlf' });
  if (safeCrlf === undefined) return undefined;
  if (safeCrlf.trim().toLowerCase() === 'warn') return safeCrlf;
  parseBooleanConfig({ key: 'core.safecrlf', value: safeCrlf });
  return safeCrlf;
}

export function assertSupportedSafeCrlfClean({ config }: { config: GitConfig }): void {
  const safeCrlf = validateSafeCrlfConfig({ config });
  if (safeCrlf === undefined) return;
  const normalized = safeCrlf.trim().toLowerCase();
  if (normalized === 'warn' || parseBooleanConfig({ key: 'core.safecrlf', value: safeCrlf })) {
    throw new Error(`core.safecrlf=${safeCrlf} is not supported yet`);
  }
}

export function assertSupportedWorktreeContentConfig({ config }: { config: GitConfig }): void {
  resolveWorktreeContentConfig({ config });
  validateSafeCrlfConfig({ config });

  const attributesFile = getConfigValue({ config, key: 'core.attributesfile' });
  if (attributesFile !== undefined) {
    throw new Error(`core.attributesFile=${attributesFile} is not supported yet`);
  }
}

export interface GitConfigKeyParts {
  section: string,
  subsection: string | undefined,
  name: string,
}

export function parseConfigKey({ key }: { key: string }): GitConfigKeyParts {
  const firstSeparator = key.indexOf('.');
  const lastSeparator = key.lastIndexOf('.');
  if (firstSeparator <= 0 || lastSeparator === key.length - 1) throw new Error(`invalid key: ${key}`);
  const section = key.slice(0, firstSeparator);
  const name = key.slice(lastSeparator + 1);
  if (!/^[A-Za-z0-9-]+$/u.test(section) || !isValidConfigVariableName({ name })) {
    throw new Error(`invalid key: ${key}`);
  }
  if (firstSeparator === lastSeparator) return { section, subsection: undefined, name };
  const subsection = key.slice(firstSeparator + 1, lastSeparator);
  if (subsection.length === 0 || /[\0\r\n]/u.test(subsection)) throw new Error(`invalid key: ${key}`);
  return { section, subsection, name };
}

function sectionHeaderMatches({ line, section, subsection }: {
  line: string,
  section: string,
  subsection: string | undefined,
}): boolean {
  const header = parseConfigSectionHeader({ line });
  if (header === undefined || header.section.toLowerCase() !== section.toLowerCase()) return false;
  return subsection === undefined
    ? header.subsection === undefined
    : header.subsection === subsection;
}

function assertPersistableConfigValue({ key, value }: { key: string, value: string }): void {
  if (value.includes('\0')) throw new Error(`config value for '${key}' contains NUL`);
}

function formatConfigValueForWrite({ value }: { value: string }): string {
  const escaped = value
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, '\\n')
    .replace(/\t/gu, '\\t')
    .replaceAll(String.fromCharCode(8), '\\b');
  const requiresQuotes = /^\s|\s$/u.test(value) || /[#;\r]/u.test(value);
  return requiresQuotes ? `"${escaped}"` : escaped;
}

function formatSectionHeader({ section, subsection }: {
  section: string,
  subsection: string | undefined,
}): string {
  if (subsection === undefined) return `[${section}]`;
  const escapedSubsection = subsection
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"');
  return `[${section} "${escapedSubsection}"]`;
}

function parseConfigEntryName({ line }: { line: string }): string | undefined {
  const assignment = /^\s*([^=\s]+)\s*=[\s\S]*$/u.exec(line);
  if (assignment !== null) return assignment[1]!;
  return /^\s*([^=\s]+)\s*$/u.exec(line)?.[1];
}

interface ConfigEntryPhysicalRange {
  start: number,
  endExclusive: number,
}

interface ConfigSectionPhysicalRange {
  start: number,
  endExclusive: number,
}

function findLastConfigSectionPhysicalRange({ lines, section, subsection }: {
  lines: readonly string[],
  section: string,
  subsection: string | undefined,
}): ConfigSectionPhysicalRange | undefined {
  let activeStart: number | undefined;
  let lastMatch: ConfigSectionPhysicalRange | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\[/u.test(lines[index]!)) continue;
    if (activeStart !== undefined) {
      lastMatch = { start: activeStart, endExclusive: index };
      activeStart = undefined;
    }
    if (sectionHeaderMatches({ line: lines[index]!, section, subsection })) activeStart = index;
  }
  if (activeStart !== undefined) lastMatch = { start: activeStart, endExclusive: lines.length };
  return lastMatch;
}

function getConfigEntryPhysicalRange({ lines, start }: {
  lines: readonly string[],
  start: number,
}): ConfigEntryPhysicalRange {
  let endExclusive = start + 1;
  while (endExclusive < lines.length && lines[endExclusive - 1]!.endsWith('\\')) endExclusive += 1;
  return { start, endExclusive };
}

function findConfigEntryPhysicalRanges({ lines, section, subsection, name }: {
  lines: readonly string[],
  section: string,
  subsection: string | undefined,
  name: string,
}): ConfigEntryPhysicalRange[] {
  const matches: ConfigEntryPhysicalRange[] = [];
  let inTargetSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*\[/u.test(line)) {
      inTargetSection = sectionHeaderMatches({ line, section, subsection });
      continue;
    }
    const range = getConfigEntryPhysicalRange({ lines, start: index });
    if (inTargetSection) {
      const entryName = parseConfigEntryName({ line });
      if (entryName?.toLowerCase() === name.toLowerCase()) matches.push(range);
    }
    index = range.endExclusive - 1;
  }
  return matches;
}

function findMatchingConfigEntryPhysicalRanges({ currentText, lines, section, subsection, name, valuePattern }: {
  currentText: string,
  lines: readonly string[],
  section: string,
  subsection: string | undefined,
  name: string,
  valuePattern: GitConfigValuePattern | undefined,
}): ConfigEntryPhysicalRange[] {
  const ranges = findConfigEntryPhysicalRanges({ lines, section, subsection, name });
  if (valuePattern === undefined) return ranges;

  const normalizedKey = normalizeConfigKey({ section, subsection, name });
  const entries = parseConfigEntries({ text: currentText }).filter(entry => entry.key === normalizedKey);
  if (entries.length !== ranges.length) throw new Error(`config entry range mismatch for '${normalizedKey}'`);
  return ranges.filter((_range, index) => configValueMatchesPattern({
    value: getRawConfigValue({ value: entries[index]!.value }),
    valuePattern,
  }));
}

export type GitSetConfigValueResult = 'set' | 'multiple';

async function setConfigValueAtPath({ files, path, key, value, valuePattern }: {
  files: GitFiles,
  path: string,
  key: string,
  value: string,
  valuePattern: GitConfigValuePattern | undefined,
}): Promise<GitSetConfigValueResult> {
  assertPersistableConfigValue({ key, value });
  const { section, subsection, name } = parseConfigKey({ key });
  const currentText = await pathExists({ files, path }) ? await readFileText({ files, path }) : '';
  const lines = currentText.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');

  const targetSection = findLastConfigSectionPhysicalRange({ lines, section, subsection });
  const matchingEntryRanges = findMatchingConfigEntryPhysicalRanges({
    currentText,
    lines,
    section,
    subsection,
    name,
    valuePattern,
  });
  if (matchingEntryRanges.length > 1) return 'multiple';

  if (matchingEntryRanges.length === 1) {
    const [range] = matchingEntryRanges;
    lines.splice(range!.start, range!.endExclusive - range!.start, `\t${name} = ${formatConfigValueForWrite({ value })}`);
  } else if (targetSection === undefined) {
    if (lines.length === 1 && lines[0] === '') lines.length = 0;
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(formatSectionHeader({ section, subsection }), `\t${name} = ${formatConfigValueForWrite({ value })}`);
  } else {
    lines.splice(targetSection.endExclusive, 0, `\t${name} = ${formatConfigValueForWrite({ value })}`);
  }

  await replaceTextViaLock({ files, path, text: `${lines.join('\n')}\n` });
  return 'set';
}

export async function setLocalConfigValue({ files, repository, key, value, valuePattern }: {
  files: GitFiles,
  repository: GitRepository,
  key: string,
  value: string,
  valuePattern: GitConfigValuePattern | undefined,
}): Promise<GitSetConfigValueResult> {
  return setConfigValueAtPath({
    files,
    path: joinPath({ base: repository.commonDirPath, child: 'config' }),
    key,
    value,
    valuePattern,
  });
}

export async function setGlobalConfigValue({ files, homePath, cwd, env, key, value, valuePattern }: {
  files: GitFiles,
  homePath: string,
  cwd: string,
  env: ReadonlyMap<string, string>,
  key: string,
  value: string,
  valuePattern: GitConfigValuePattern | undefined,
}): Promise<GitSetConfigValueResult> {
  return setConfigValueAtPath({
    files,
    path: globalConfigPath({ homePath, cwd, env }),
    key,
    value,
    valuePattern,
  });
}

async function addConfigValueAtPath({ files, path, key, value }: {
  files: GitFiles,
  path: string,
  key: string,
  value: string,
}): Promise<void> {
  assertPersistableConfigValue({ key, value });
  const { section, subsection, name } = parseConfigKey({ key });
  const currentText = await pathExists({ files, path }) ? await readFileText({ files, path }) : '';
  const lines = currentText.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
  const targetSection = findLastConfigSectionPhysicalRange({ lines, section, subsection });
  if (targetSection === undefined) {
    if (lines.length === 1 && lines[0] === '') lines.length = 0;
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(formatSectionHeader({ section, subsection }), `\t${name} = ${formatConfigValueForWrite({ value })}`);
  } else {
    lines.splice(targetSection.endExclusive, 0, `\t${name} = ${formatConfigValueForWrite({ value })}`);
  }
  await replaceTextViaLock({ files, path, text: `${lines.join('\n')}\n` });
}

export async function addLocalConfigValue({ files, repository, key, value }: {
  files: GitFiles,
  repository: GitRepository,
  key: string,
  value: string,
}): Promise<void> {
  await addConfigValueAtPath({ files, path: joinPath({ base: repository.commonDirPath, child: 'config' }), key, value });
}

export async function addGlobalConfigValue({ files, homePath, cwd, env, key, value }: {
  files: GitFiles,
  homePath: string,
  cwd: string,
  env: ReadonlyMap<string, string>,
  key: string,
  value: string,
}): Promise<void> {
  await addConfigValueAtPath({ files, path: globalConfigPath({ homePath, cwd, env }), key, value });
}

async function unsetConfigValueAtPath({ files, path, key, all, valuePattern }: {
  files: GitFiles,
  path: string,
  key: string,
  all: boolean,
  valuePattern: GitConfigValuePattern | undefined,
}): Promise<'missing' | 'multiple' | 'removed'> {
  const { section, subsection, name } = parseConfigKey({ key });
  if (!await pathExists({ files, path })) return 'missing';
  const currentText = await readFileText({ files, path });
  const lines = currentText.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
  const matches = findMatchingConfigEntryPhysicalRanges({
    currentText,
    lines,
    section,
    subsection,
    name,
    valuePattern,
  });
  if (matches.length === 0) return 'missing';
  if (!all && matches.length > 1) return 'multiple';
  const removal = all ? matches : [matches[0]!];
  for (const range of [...removal].sort((left, right) => right.start - left.start)) {
    lines.splice(range.start, range.endExclusive - range.start);
  }
  await replaceTextViaLock({ files, path, text: `${lines.join('\n')}\n` });
  return 'removed';
}

export async function unsetLocalConfigValue({ files, repository, key, all, valuePattern }: {
  files: GitFiles,
  repository: GitRepository,
  key: string,
  all: boolean,
  valuePattern: GitConfigValuePattern | undefined,
}): Promise<'missing' | 'multiple' | 'removed'> {
  return unsetConfigValueAtPath({
    files,
    path: joinPath({ base: repository.commonDirPath, child: 'config' }),
    key,
    all,
    valuePattern,
  });
}

export async function unsetGlobalConfigValue({ files, homePath, cwd, env, key, all, valuePattern }: {
  files: GitFiles,
  homePath: string,
  cwd: string,
  env: ReadonlyMap<string, string>,
  key: string,
  all: boolean,
  valuePattern: GitConfigValuePattern | undefined,
}): Promise<'missing' | 'multiple' | 'removed'> {
  return unsetConfigValueAtPath({
    files,
    path: globalConfigPath({ homePath, cwd, env }),
    key,
    all,
    valuePattern,
  });
}

export async function removeLocalConfigSection({ files, repository, section, subsection }: {
  files: GitFiles,
  repository: GitRepository,
  section: string,
  subsection: string,
}): Promise<boolean> {
  const path = joinPath({ base: repository.commonDirPath, child: 'config' });
  if (!await pathExists({ files, path })) return false;
  const lines = (await readFileText({ files, path })).replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
  let sectionStart: number | undefined;
  let sectionEnd: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\[/u.test(lines[index]!)) continue;
    if (sectionStart !== undefined) {
      sectionEnd = index;
      break;
    }
    if (sectionHeaderMatches({ line: lines[index]!, section, subsection })) sectionStart = index;
  }
  if (sectionStart === undefined) return false;
  if (sectionEnd === undefined) sectionEnd = lines.length;
  lines.splice(sectionStart, sectionEnd - sectionStart);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  await replaceTextViaLock({ files, path, text: `${lines.join('\n')}\n` });
  return true;
}


export async function renameLocalConfigSection({ files, repository, section, oldSubsection, newSubsection }: {
  files: GitFiles,
  repository: GitRepository,
  section: string,
  oldSubsection: string,
  newSubsection: string,
}): Promise<boolean> {
  const path = joinPath({ base: repository.commonDirPath, child: 'config' });
  if (!await pathExists({ files, path })) return false;
  const lines = (await readFileText({ files, path })).replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
  let sourceIndex: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (sectionHeaderMatches({ line: lines[index]!, section, subsection: oldSubsection })) {
      sourceIndex = index;
      break;
    }
  }
  if (sourceIndex === undefined) return false;
  lines[sourceIndex] = formatSectionHeader({ section, subsection: newSubsection });
  await replaceTextViaLock({ files, path, text: `${lines.join('\n')}\n` });
  return true;
}

export function getConfigValue({ config, key }: { config: GitConfig, key: string }): string | undefined {
  const value = config.get(normalizeConfigKeyString({ key }));
  if (value === undefined) return undefined;
  return getRawConfigValue({ value });
}

export function getRawConfigValue({ value }: { value: GitConfigValue }): string {
  switch (value.kind) {
  case 'implicit-boolean':
    return '';
  case 'explicit':
    return value.value;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled config value: ${String(_ex)}`);
  }
  }
}

export function formatConfigEntryForList({ entry }: { entry: GitConfigEntry }): string {
  switch (entry.value.kind) {
  case 'implicit-boolean':
    return entry.key;
  case 'explicit':
    return `${entry.key}=${entry.value.value}`;
  default: {
    const _ex: never = entry.value;
    throw new Error(`Unhandled config value: ${String(_ex)}`);
  }
  }
}

type GitLogAllRefUpdatesConfigValue = 'disabled' | 'enabled' | 'always';

function getLogAllRefUpdatesConfigValue({ config }: {
  config: GitConfig,
}): GitLogAllRefUpdatesConfigValue | undefined {
  const key = 'core.logallrefupdates';
  const value = config.get(key);
  if (value === undefined) return undefined;
  switch (value.kind) {
  case 'implicit-boolean':
    throw new Error(`missing value for '${key}'`);
  case 'explicit': {
    const normalized = value.value.trim().toLowerCase();
    if (normalized === 'always') return 'always';
    return parseBooleanConfig({ key, value: value.value }) ? 'enabled' : 'disabled';
  }
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled config value: ${String(_ex)}`);
  }
  }
}

export function shouldCreateBranchReflog({ config }: { config: GitConfig }): boolean {
  const value = getLogAllRefUpdatesConfigValue({ config });
  switch (value) {
  case undefined:
  case 'enabled':
  case 'always':
    return true;
  case 'disabled':
    return false;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled core.logallrefupdates value: ${String(_ex)}`);
  }
  }
}

export function getBooleanConfigValue({ config, key }: {
  config: GitConfig,
  key: string,
}): boolean | undefined {
  const normalizedKey = normalizeConfigKeyString({ key });
  const value = config.get(normalizedKey);
  if (value === undefined) return undefined;
  switch (value.kind) {
  case 'implicit-boolean':
    return true;
  case 'explicit':
    return parseBooleanConfig({ key: normalizedKey, value: value.value });
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled config value: ${String(_ex)}`);
  }
  }
}

function parseGitConfigInt({ key, value }: { key: string, value: string | undefined }): number {
  const text = value ?? '';
  const match = /^[\t\n\v\f\r ]*([+-]?)(?:(0[xX][0-9a-fA-F]+)|(0[0-7]*)|([1-9][0-9]*))([kKmMgG]?)$/u.exec(text);
  if (match === null) throw new Error(`bad numeric config value '${text}' for '${key}': invalid unit`);
  const sign = match[1] === '-' ? -1n : 1n;
  let magnitude: bigint;
  if (match[2] !== undefined) magnitude = BigInt(match[2]);
  else if (match[3] !== undefined) magnitude = BigInt(`0o${match[3].slice(1) || '0'}`);
  else magnitude = BigInt(match[4]!);
  const unit = match[5]!.toLowerCase();
  const factor = unit === 'k' ? 1024n : unit === 'm' ? 1024n * 1024n : unit === 'g' ? 1024n * 1024n * 1024n : 1n;
  const parsed = sign * magnitude * factor;
  const gitIntMaximum = 2_147_483_647n;
  if (parsed < -gitIntMaximum || parsed > gitIntMaximum) {
    throw new Error(`bad numeric config value '${text}' for '${key}': out of range`);
  }
  return Number(parsed);
}

export function getDiffRenameLimitConfigValue({ config }: { config: GitConfig }): number | undefined {
  const key = 'diff.renamelimit';
  const value = config.get(key);
  if (value === undefined) return undefined;
  switch (value.kind) {
  case 'implicit-boolean':
    return parseGitConfigInt({ key, value: undefined });
  case 'explicit':
    return parseGitConfigInt({ key, value: value.value });
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled config value: ${String(_ex)}`);
  }
  }
}

export type GitDiffRenamesConfigMode = 'disabled' | 'renames' | 'copies';

export function getDiffRenamesConfigMode({ config }: {
  config: GitConfig,
}): GitDiffRenamesConfigMode {
  const key = 'diff.renames';
  const value = config.get(key);
  if (value === undefined || value.kind === 'implicit-boolean') return 'renames';
  const normalized = value.value.trim().toLowerCase();
  if (normalized === 'copy' || normalized === 'copies') return 'copies';
  return parseBooleanConfig({ key, value: value.value }) ? 'renames' : 'disabled';
}

export const TEST_ONLY = {
  formatConfigValueForWrite,
};
