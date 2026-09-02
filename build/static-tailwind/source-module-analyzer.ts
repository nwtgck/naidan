import fs from 'node:fs';
import path from 'node:path';

import { compile as compileTemplate, parse as parseTemplate } from '@vue/compiler-dom';
import type { CompilerError } from '@vue/compiler-core';
import { parse as parseSfc, type SFCBlock, type SFCDescriptor } from '@vue/compiler-sfc';
import { profileBuildSync } from '../build-profile.js';

import {
  collectTwCandidateOccurrencesFromTemplateAst,
  createTwClassNodeTransform,
  sourceTypeForVueScriptBlock,
  transformTwCallsInModule,
  type SourcePosition,
  type TailwindCandidateOccurrence,
  type TwModuleSourceType,
} from './tw-class-core';

const moduleExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'];

export type SourceCandidateGroupBase = {
  id: string;
  filename: string;
  sourceKind: string;
  sourceAttributes?: string[];
  candidates: string[];
  line: number;
  column: number;
};

export type SourceCandidateGroup = SourceCandidateGroupBase & {
  owners: string[];
};

export type SourceCssOwner = {
  name: string;
  root: string;
};

export type SourceModuleAnalysisCache = Map<string, {
  source: string;
  groups: SourceCandidateGroupBase[];
}>;

export type SourceModuleAnalysis = {
  projectRoot: string;
  sourceRoot: string;
  files: string[];
  cssOwners: SourceCssOwner[];
  candidateGroups: SourceCandidateGroup[];
  candidateOwners: Map<string, Set<string>>;
};

export type SerializedSourceModuleAnalysis = {
  projectRoot: string;
  sourceRoot: string;
  files: string[];
  cssOwners: SourceCssOwner[];
  candidateOwners: Record<string, string[]>;
  candidateGroups: SourceCandidateGroup[];
};

type VueScriptBlock = {
  source: string;
  sourceType: TwModuleSourceType;
  blockStart: SourcePosition;
  groupIdPrefix: 'script' | 'script-setup';
};

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function walkFiles({ directory }: {
  directory: string;
}): string[] {
  if (!fs.existsSync(directory)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles({ directory: absolutePath }) : [absolutePath];
  });
}

export function isStaticTailwindSourcePath({ filename, sourceRoot }: {
  filename: string;
  sourceRoot: string;
}): boolean {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const absoluteFilename = path.resolve(filename);
  const relativePath = path.relative(absoluteSourceRoot, absoluteFilename).replaceAll(path.sep, '/');
  return relativePath !== ''
    && !relativePath.startsWith('../')
    && !path.isAbsolute(relativePath)
    && !/\.(?:test|spec)\.[^.]+$/u.test(absoluteFilename)
    && !relativePath.startsWith('test-tmp/')
    && !relativePath.startsWith('lint-rule-tmp/');
}

export function isStaticTailwindSourceFile({ filename, sourceRoot }: {
  filename: string;
  sourceRoot: string;
}): boolean {
  return isStaticTailwindSourcePath({ filename, sourceRoot })
    && moduleExtensions.includes(path.extname(path.resolve(filename)));
}

function parseVueDescriptor({ source, filename }: {
  source: string;
  filename: string;
}): SFCDescriptor {
  const { descriptor, errors } = parseSfc(source, { filename });
  if (errors.length > 0) throw new Error(`${filename}: ${errors.map(String).join('; ')}`);
  return descriptor;
}

function createVueScriptBlock({ block, filename, kind }: {
  block: SFCBlock | null;
  filename: string;
  kind: VueScriptBlock['groupIdPrefix'];
}): VueScriptBlock | undefined {
  if (block === null) return undefined;
  return {
    source: block.content,
    sourceType: sourceTypeForVueScriptBlock({ lang: block.lang, filename }),
    blockStart: block.loc.start,
    groupIdPrefix: kind,
  };
}

function scriptBlocksFromDescriptor({ descriptor, filename }: {
  descriptor: SFCDescriptor;
  filename: string;
}): VueScriptBlock[] {
  return [
    createVueScriptBlock({ block: descriptor.script, filename, kind: 'script' }),
    createVueScriptBlock({ block: descriptor.scriptSetup, filename, kind: 'script-setup' }),
  ].filter((block): block is VueScriptBlock => block !== undefined);
}

function absoluteTemplatePosition({ relative, blockStart }: {
  relative: SourcePosition;
  blockStart: SourcePosition;
}): SourcePosition {
  return {
    line: blockStart.line + relative.line - 1,
    column: relative.line === 1
      ? blockStart.column + relative.column - 1
      : relative.column,
  };
}

function candidateGroupsFromOccurrences({ occurrences, filename, groupIdPrefix }: {
  occurrences: TailwindCandidateOccurrence[];
  filename: string;
  groupIdPrefix: string;
}): SourceCandidateGroupBase[] {
  const groups: SourceCandidateGroupBase[] = [];
  const groupByLocation = new Map<string, SourceCandidateGroupBase>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.sourceKind}\0${occurrence.line}\0${occurrence.column}`;
    let group = groupByLocation.get(key);
    if (group === undefined) {
      group = {
        id: `${filename}:${groupIdPrefix}:${groups.length}`,
        filename,
        sourceKind: occurrence.sourceKind,
        candidates: [],
        line: occurrence.line,
        column: occurrence.column,
      };
      groups.push(group);
      groupByLocation.set(key, group);
    }
    if (!group.candidates.includes(occurrence.candidate)) group.candidates.push(occurrence.candidate);
  }
  return groups;
}

function collectVueTemplateGroups({ descriptor, filename }: {
  descriptor: SFCDescriptor;
  filename: string;
}): SourceCandidateGroupBase[] {
  if (descriptor.template === null) return [];
  if (descriptor.template.src !== undefined) {
    throw new Error(`${filename}: External Vue template src files are not supported by static Tailwind analysis.`);
  }
  if (descriptor.template.lang !== undefined && descriptor.template.lang !== 'html') {
    throw new Error(`${filename}: Unsupported Vue template language ${JSON.stringify(descriptor.template.lang)} for static Tailwind analysis.`);
  }
  const blockStart = descriptor.template.loc.start;
  const onError = (error: CompilerError): never => {
    const position = absoluteTemplatePosition({ relative: error.loc?.start ?? { line: 1, column: 1 }, blockStart });
    throw new Error(`${filename}:${position.line}:${position.column} ${error.message}`);
  };
  const ast = parseTemplate(descriptor.template.content, {
    comments: true,
    expressionPlugins: ['typescript'],
    onError,
  });
  compileTemplate(descriptor.template.content, {
    comments: true,
    expressionPlugins: ['typescript'],
    nodeTransforms: [createTwClassNodeTransform({ filename, blockStart })],
    onError,
  });
  return candidateGroupsFromOccurrences({
    occurrences: collectTwCandidateOccurrencesFromTemplateAst({ ast, filename, blockStart }),
    filename,
    groupIdPrefix: 'template',
  });
}

function collectMacroGroupsFromSource({
  source,
  filename,
  sourceType,
  blockStart,
  groupIdPrefix,
}: {
  source: string;
  filename: string;
  sourceType: TwModuleSourceType;
  blockStart: SourcePosition;
  groupIdPrefix: string;
}): SourceCandidateGroupBase[] {
  if (!source.includes('virtual:naidan-tailwind')) return [];
  const result = transformTwCallsInModule({
    source,
    filename,
    sourceType,
    blockStart,
    additionalImports: [],
  });
  return candidateGroupsFromOccurrences({
    occurrences: result.occurrences,
    filename,
    groupIdPrefix: `${groupIdPrefix}:macro`,
  });
}

function sourceTypeForModule({ filename }: {
  filename: string;
}): TwModuleSourceType {
  const extension = path.extname(filename);
  if (extension === '.jsx') return 'jsx';
  if (extension === '.tsx') return 'tsx';
  if (['.js', '.mjs', '.cjs'].includes(extension)) return 'javascript';
  return 'typescript';
}

function collectCandidateGroups({ source, filename }: {
  source: string;
  filename: string;
}): SourceCandidateGroupBase[] {
  if (!filename.endsWith('.vue')) {
    return collectMacroGroupsFromSource({
      source,
      filename,
      sourceType: sourceTypeForModule({ filename }),
      blockStart: { line: 1, column: 1 },
      groupIdPrefix: 'module',
    });
  }
  const descriptor = parseVueDescriptor({ source, filename });
  const result = collectVueTemplateGroups({ descriptor, filename });
  for (const block of scriptBlocksFromDescriptor({ descriptor, filename })) {
    result.push(...collectMacroGroupsFromSource({
      source: block.source,
      filename,
      sourceType: block.sourceType,
      blockStart: block.blockStart,
      groupIdPrefix: block.groupIdPrefix,
    }));
  }
  return result;
}

function cloneCandidateGroups({ groups }: {
  groups: SourceCandidateGroupBase[];
}): SourceCandidateGroupBase[] {
  return groups.map((group) => ({
    ...group,
    sourceAttributes: group.sourceAttributes === undefined ? undefined : [...group.sourceAttributes],
    candidates: [...group.candidates],
  }));
}

export function createSourceModuleAnalysisCache(): SourceModuleAnalysisCache {
  return new Map();
}

function sourceModuleOwnerName({ projectRoot, moduleId }: {
  projectRoot: string;
  moduleId: string;
}): string {
  return `module:${path.relative(projectRoot, moduleId).replaceAll(path.sep, '/')}`;
}

export function analyzeSourceModules({ projectRoot, sourceRoot, ownershipMode, cache }: {
  projectRoot: string;
  sourceRoot: string;
  ownershipMode: 'single-css' | 'source-module';
  cache: SourceModuleAnalysisCache;
}): SourceModuleAnalysis {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const files = profileBuildSync({
    name: 'tailwind.source.walk-files',
    sample: { detail: absoluteSourceRoot },
    run: () => walkFiles({ directory: absoluteSourceRoot })
      .filter((file) => isStaticTailwindSourceFile({ filename: file, sourceRoot: absoluteSourceRoot })),
  });
  const baseCandidateGroups: SourceCandidateGroupBase[] = [];
  const presentFiles = new Set(files);
  for (const cachedFile of cache.keys()) {
    if (!presentFiles.has(cachedFile)) cache.delete(cachedFile);
  }
  for (const file of files) {
    let source: string;
    try {
      source = profileBuildSync({
        name: 'tailwind.source.read-file',
        sample: { detail: file, items: 1 },
        run: () => fs.readFileSync(file, 'utf8'),
      });
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        cache.delete(file);
        continue;
      }
      throw error;
    }
    const cached = cache.get(file);
    if (cached?.source === source) {
      baseCandidateGroups.push(...cloneCandidateGroups({ groups: cached.groups }));
      continue;
    }
    const groups = profileBuildSync({
      name: 'tailwind.source.collect-candidate-groups',
      sample: { detail: file, inputChars: source.length, items: 1 },
      run: () => collectCandidateGroups({ source, filename: file }),
    });
    cache.set(file, { source, groups: cloneCandidateGroups({ groups }) });
    baseCandidateGroups.push(...groups);
  }

  const candidateOwners = new Map<string, Set<string>>();
  switch (ownershipMode) {
  case 'single-css': {
    const candidateGroups = baseCandidateGroups.map<SourceCandidateGroup>((group) => ({
      ...group,
      owners: ['initial'],
    }));
    for (const group of candidateGroups) {
      for (const candidate of group.candidates) candidateOwners.set(candidate, new Set(['initial']));
    }
    return {
      projectRoot: absoluteProjectRoot,
      sourceRoot: absoluteSourceRoot,
      files,
      cssOwners: [],
      candidateGroups,
      candidateOwners,
    };
  }
  case 'source-module':
    break;
  default: {
    const _ex: never = ownershipMode;
    throw new Error(`Unhandled ownership mode: ${_ex}`);
  }
  }

  const ownerByFile = new Map<string, SourceCssOwner>();
  const candidateGroups = baseCandidateGroups.map<SourceCandidateGroup>((group) => {
    const owner = ownerByFile.get(group.filename) ?? {
      name: sourceModuleOwnerName({ projectRoot: absoluteProjectRoot, moduleId: group.filename }),
      root: group.filename,
    };
    ownerByFile.set(group.filename, owner);
    for (const candidate of group.candidates) {
      const current = candidateOwners.get(candidate) ?? new Set<string>();
      current.add(owner.name);
      candidateOwners.set(candidate, current);
    }
    return {
      ...group,
      owners: [owner.name],
    };
  });
  return {
    projectRoot: absoluteProjectRoot,
    sourceRoot: absoluteSourceRoot,
    files,
    cssOwners: [...ownerByFile.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    candidateGroups,
    candidateOwners,
  };
}

export function serializeSourceAnalysis({ analysis }: {
  analysis: SourceModuleAnalysis;
}): SerializedSourceModuleAnalysis {
  const relative = (file: string): string => path.relative(analysis.projectRoot, file).replaceAll(path.sep, '/');
  return {
    projectRoot: analysis.projectRoot,
    sourceRoot: analysis.sourceRoot,
    files: analysis.files.map(relative),
    cssOwners: analysis.cssOwners.map(({ name, root }) => ({ name, root: relative(root) })),
    candidateOwners: Object.fromEntries(
      [...analysis.candidateOwners]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([candidate, owners]) => [candidate, [...owners].sort()]),
    ),
    candidateGroups: analysis.candidateGroups.map((group) => ({
      ...group,
      filename: relative(group.filename),
    })),
  };
}
