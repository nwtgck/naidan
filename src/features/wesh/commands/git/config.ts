import type { GitFiles } from "./files";
import { pathExists, readFileText, replaceTextViaLock } from "./files";
import type { GitRepository } from "./repository";
import { joinPath } from "./repository";

export type GitConfig = Map<string, string>;

export interface GitConfigEntry {
  key: string,
  value: string,
}

export type GitAutoCrlf = 'false' | 'true' | 'input';
export type GitCoreEol = 'lf' | 'crlf';

export interface GitWorktreeContentConfig {
  autoCrlf: GitAutoCrlf,
  eol: GitCoreEol,
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

export function parseConfigEntries({ text }: { text: string }): GitConfigEntry[] {
  const result: GitConfigEntry[] = [];
  let section: string | undefined;
  let subsection: string | undefined;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([^\s\]"]+)(?:\s+"([^"]*)")?\]$/u.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1]!;
      subsection = sectionMatch[2];
      continue;
    }
    if (section === undefined) continue;
    const assignment = /^([^=\s]+)\s*=\s*(.*)$/u.exec(line);
    if (assignment === null) continue;
    result.push({
      key: normalizeConfigKey({ section, subsection, name: assignment[1]! }),
      value: assignment[2]!,
    });
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

function globalConfigPath({ homePath }: { homePath: string }): string {
  return joinPath({ base: homePath, child: '.gitconfig' });
}

export async function readGlobalConfigEntries({ files, homePath }: {
  files: GitFiles,
  homePath: string,
}): Promise<GitConfigEntry[]> {
  const path = globalConfigPath({ homePath });
  if (!await pathExists({ files, path })) return [];
  return parseConfigEntries({ text: await readFileText({ files, path }) });
}

export async function readGlobalConfig({ files, homePath }: {
  files: GitFiles,
  homePath: string,
}): Promise<GitConfig> {
  const result: GitConfig = new Map();
  for (const entry of await readGlobalConfigEntries({ files, homePath })) result.set(entry.key, entry.value);
  return result;
}

export function readCommandConfigEntries({ env }: {
  env: ReadonlyMap<string, string>,
}): GitConfigEntry[] {
  const rawCount = env.get('GIT_CONFIG_COUNT');
  if (rawCount === undefined) return [];
  if (!/^(?:0|[1-9][0-9]*)$/u.test(rawCount)) throw new Error('invalid GIT_CONFIG_COUNT');
  const count = Number(rawCount);
  const result: GitConfigEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = env.get(`GIT_CONFIG_KEY_${index}`);
    const value = env.get(`GIT_CONFIG_VALUE_${index}`);
    if (key === undefined || value === undefined) throw new Error(`missing command config entry ${index}`);
    const { section, subsection, name } = parseConfigKey({ key });
    result.push({ key: normalizeConfigKey({ section, subsection, name }), value });
  }
  return result;
}

export async function readEffectiveConfigEntries({ files, repository, homePath, env }: {
  files: GitFiles,
  repository: GitRepository,
  homePath: string,
  env: ReadonlyMap<string, string>,
}): Promise<GitConfigEntry[]> {
  return [
    ...await readGlobalConfigEntries({ files, homePath }),
    ...await readLocalConfigEntries({ files, repository }),
    ...readCommandConfigEntries({ env }),
  ];
}

export async function readEffectiveConfig({ files, repository, homePath, env }: {
  files: GitFiles,
  repository: GitRepository,
  homePath: string,
  env: ReadonlyMap<string, string>,
}): Promise<GitConfig> {
  const result: GitConfig = new Map();
  for (const entry of await readEffectiveConfigEntries({ files, repository, homePath, env })) {
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
    else autoCrlf = parseBooleanConfig({ key: 'core.autocrlf', value: rawAutoCrlf }) ? 'true' : 'false';
  }

  const rawEol = getConfigValue({ config, key: 'core.eol' });
  const normalizedEol = rawEol?.trim().toLowerCase();
  const eol: GitCoreEol = normalizedEol === 'crlf' ? 'crlf' : 'lf';
  return { autoCrlf, eol };
}

export async function readWorktreeContentConfig({ files, repository, homePath, env }: {
  files: GitFiles,
  repository: GitRepository,
  homePath: string,
  env: ReadonlyMap<string, string>,
}): Promise<GitWorktreeContentConfig> {
  return resolveWorktreeContentConfig({
    config: await readEffectiveConfig({ files, repository, homePath, env }),
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
  if (!/^[A-Za-z0-9-]+$/u.test(section) || !/^[A-Za-z0-9-]+$/u.test(name)) {
    throw new Error(`invalid key: ${key}`);
  }
  if (firstSeparator === lastSeparator) return { section, subsection: undefined, name };
  const subsection = key.slice(firstSeparator + 1, lastSeparator);
  if (subsection.length === 0 || /[\0\r\n"\\]/u.test(subsection)) throw new Error(`invalid key: ${key}`);
  return { section, subsection, name };
}

function sectionHeaderMatches({ line, section, subsection }: {
  line: string,
  section: string,
  subsection: string | undefined,
}): boolean {
  const match = /^\s*\[([^\s\]"]+)(?:\s+"([^"]*)")?\]\s*$/u.exec(line);
  if (match === null || match[1]!.toLowerCase() !== section.toLowerCase()) return false;
  return subsection === undefined
    ? match[2] === undefined
    : match[2] === subsection;
}

function formatSectionHeader({ section, subsection }: {
  section: string,
  subsection: string | undefined,
}): string {
  return subsection === undefined ? `[${section}]` : `[${section} "${subsection}"]`;
}

async function setConfigValueAtPath({ files, path, key, value }: {
  files: GitFiles,
  path: string,
  key: string,
  value: string,
}): Promise<void> {
  if (/[\0\r\n]/u.test(value)) {
    throw new Error(`config value for '${key}' contains an unsupported control character`);
  }
  const { section, subsection, name } = parseConfigKey({ key });
  const currentText = await pathExists({ files, path }) ? await readFileText({ files, path }) : '';
  const lines = currentText.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');

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
  if (sectionStart !== undefined && sectionEnd === undefined) sectionEnd = lines.length;

  if (sectionStart === undefined || sectionEnd === undefined) {
    if (lines.length === 1 && lines[0] === '') lines.length = 0;
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(formatSectionHeader({ section, subsection }), `\t${name} = ${value}`);
  } else {
    let replaced = false;
    for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
      const assignment = /^\s*([^=\s]+)\s*=.*$/u.exec(lines[index]!);
      if (assignment?.[1]?.toLowerCase() !== name.toLowerCase()) continue;
      lines[index] = `\t${name} = ${value}`;
      replaced = true;
      break;
    }
    if (!replaced) lines.splice(sectionEnd, 0, `\t${name} = ${value}`);
  }

  await replaceTextViaLock({ files, path, text: `${lines.join('\n')}\n` });
}

export async function setLocalConfigValue({ files, repository, key, value }: {
  files: GitFiles,
  repository: GitRepository,
  key: string,
  value: string,
}): Promise<void> {
  await setConfigValueAtPath({ files, path: joinPath({ base: repository.commonDirPath, child: 'config' }), key, value });
}

export async function setGlobalConfigValue({ files, homePath, key, value }: {
  files: GitFiles,
  homePath: string,
  key: string,
  value: string,
}): Promise<void> {
  await setConfigValueAtPath({ files, path: globalConfigPath({ homePath }), key, value });
}

async function addConfigValueAtPath({ files, path, key, value }: {
  files: GitFiles,
  path: string,
  key: string,
  value: string,
}): Promise<void> {
  const { section, subsection, name } = parseConfigKey({ key });
  const currentText = await pathExists({ files, path }) ? await readFileText({ files, path }) : '';
  const lines = currentText.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
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
  if (sectionStart !== undefined && sectionEnd === undefined) sectionEnd = lines.length;
  if (sectionStart === undefined || sectionEnd === undefined) {
    if (lines.length === 1 && lines[0] === '') lines.length = 0;
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(formatSectionHeader({ section, subsection }), `\t${name} = ${value}`);
  } else {
    lines.splice(sectionEnd, 0, `\t${name} = ${value}`);
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

export async function addGlobalConfigValue({ files, homePath, key, value }: {
  files: GitFiles,
  homePath: string,
  key: string,
  value: string,
}): Promise<void> {
  await addConfigValueAtPath({ files, path: globalConfigPath({ homePath }), key, value });
}

async function unsetConfigValueAtPath({ files, path, key, all }: {
  files: GitFiles,
  path: string,
  key: string,
  all: boolean,
}): Promise<'missing' | 'multiple' | 'removed'> {
  const { section, subsection, name } = parseConfigKey({ key });
  if (!await pathExists({ files, path })) return 'missing';
  const lines = (await readFileText({ files, path })).replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
  let currentSection: string | undefined;
  let currentSubsection: string | undefined;
  const matches: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const sectionMatch = /^\s*\[([^\s\]"]+)(?:\s+"([^"]*)")?\]\s*$/u.exec(line);
    if (sectionMatch !== null) {
      currentSection = sectionMatch[1];
      currentSubsection = sectionMatch[2];
      continue;
    }
    if (currentSection === undefined || currentSection.toLowerCase() !== section.toLowerCase()) continue;
    if (subsection === undefined ? currentSubsection !== undefined : currentSubsection !== subsection) continue;
    const assignment = /^\s*([^=\s]+)\s*=.*$/u.exec(line);
    if (assignment?.[1]?.toLowerCase() === name.toLowerCase()) matches.push(index);
  }
  if (matches.length === 0) return 'missing';
  if (!all && matches.length > 1) return 'multiple';
  const removal = all ? matches : [matches[0]!];
  for (const index of [...removal].sort((left, right) => right - left)) lines.splice(index, 1);
  await replaceTextViaLock({ files, path, text: `${lines.join('\n')}\n` });
  return 'removed';
}

export async function unsetLocalConfigValue({ files, repository, key, all }: {
  files: GitFiles,
  repository: GitRepository,
  key: string,
  all: boolean,
}): Promise<'missing' | 'multiple' | 'removed'> {
  return unsetConfigValueAtPath({ files, path: joinPath({ base: repository.commonDirPath, child: 'config' }), key, all });
}

export async function unsetGlobalConfigValue({ files, homePath, key, all }: {
  files: GitFiles,
  homePath: string,
  key: string,
  all: boolean,
}): Promise<'missing' | 'multiple' | 'removed'> {
  return unsetConfigValueAtPath({ files, path: globalConfigPath({ homePath }), key, all });
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
  return config.get(key.toLowerCase());
}

export function getBooleanConfigValue({ config, key }: {
  config: GitConfig,
  key: string,
}): boolean | undefined {
  const raw = getConfigValue({ config, key });
  if (raw === undefined) return undefined;
  switch (raw.trim().toLowerCase()) {
  case 'true':
  case 'yes':
  case 'on':
  case '1':
    return true;
  case 'false':
  case 'no':
  case 'off':
  case '0':
    return false;
  default:
    throw new Error(`bad boolean config value '${raw}' for '${key.toLowerCase()}'`);
  }
}

export const TEST_ONLY = {
};
