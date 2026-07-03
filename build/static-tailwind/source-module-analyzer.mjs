import fs from 'node:fs';
import path from 'node:path';
import { compile as compileTemplate, parse as parseTemplate } from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';
import {
  collectTwCandidateOccurrencesFromTemplateAst,
  createTwClassNodeTransform,
  sourceTypeForVueScriptBlock,
  transformTwCallsInModule,
} from './tw-class-core.mjs';

const moduleExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'];

function walkFiles({ directory }) {
  if (!fs.existsSync(directory)) return [];
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles({ directory: absolutePath }) : [absolutePath];
  });
}

export function isStaticTailwindSourceFile({ filename, sourceRoot }) {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const absoluteFilename = path.resolve(filename);
  const relativePath = path.relative(absoluteSourceRoot, absoluteFilename).replaceAll(path.sep, '/');
  return relativePath !== ''
    && !relativePath.startsWith('../')
    && !path.isAbsolute(relativePath)
    && moduleExtensions.includes(path.extname(absoluteFilename))
    && !/\.(?:test|spec)\.[^.]+$/u.test(absoluteFilename)
    && !relativePath.startsWith('test-tmp/')
    && !relativePath.startsWith('lint-rule-tmp/');
}

function parseVueDescriptor({ source, filename }) {
  const { descriptor, errors } = parseSfc(source, { filename });
  if (errors.length > 0) throw new Error(`${filename}: ${errors.map(String).join('; ')}`);
  return descriptor;
}

function scriptBlocksFromDescriptor({ descriptor, filename }) {
  return [
    { block: descriptor.script, kind: 'script' },
    { block: descriptor.scriptSetup, kind: 'script-setup' },
  ]
    .filter(({ block }) => block !== null)
    .map(({ block, kind }) => ({
      source: block.content,
      sourceType: sourceTypeForVueScriptBlock({ lang: block.lang, filename }),
      blockStart: block.loc.start,
      groupIdPrefix: kind,
    }));
}

function absoluteTemplatePosition({ relative, blockStart }) {
  return {
    line: blockStart.line + relative.line - 1,
    column: relative.line === 1
      ? blockStart.column + relative.column - 1
      : relative.column,
  };
}

function candidateGroupsFromOccurrences({ occurrences, filename, groupIdPrefix }) {
  const groups = [];
  const groupByLocation = new Map();
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

function collectVueTemplateGroups({ descriptor, filename }) {
  if (descriptor.template === null) return [];
  if (descriptor.template.src !== undefined) {
    throw new Error(`${filename}: External Vue template src files are not supported by static Tailwind analysis.`);
  }
  if (descriptor.template.lang !== undefined && descriptor.template.lang !== 'html') {
    throw new Error(`${filename}: Unsupported Vue template language ${JSON.stringify(descriptor.template.lang)} for static Tailwind analysis.`);
  }
  const blockStart = descriptor.template.loc.start;
  const onError = (error) => {
    const position = absoluteTemplatePosition({ relative: error.loc.start, blockStart });
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
}) {
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

function collectCandidateGroups({ source, filename }) {
  if (!filename.endsWith('.vue')) {
    const extension = path.extname(filename);
    return collectMacroGroupsFromSource({
      source,
      filename,
      sourceType: extension === '.jsx'
        ? 'jsx'
        : extension === '.tsx'
          ? 'tsx'
          : ['.js', '.mjs', '.cjs'].includes(extension)
            ? 'javascript'
            : 'typescript',
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

function cloneCandidateGroups({ groups }) {
  return groups.map((group) => ({
    ...group,
    sourceAttributes: group.sourceAttributes === undefined ? undefined : [...group.sourceAttributes],
    candidates: [...group.candidates],
    owners: group.owners === undefined ? undefined : [...group.owners],
  }));
}

export function createSourceModuleAnalysisCache() {
  return new Map();
}

function sourceModuleOwnerName({ projectRoot, moduleId }) {
  return `module:${path.relative(projectRoot, moduleId).replaceAll(path.sep, '/')}`;
}

export function analyzeSourceModules({ projectRoot, sourceRoot, ownershipMode, cache }) {
  if (ownershipMode !== 'single-css' && ownershipMode !== 'source-module') {
    throw new Error(`[tw-class] Unknown source ownership mode: ${String(ownershipMode)}`);
  }
  const absoluteProjectRoot = path.resolve(projectRoot);
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const files = walkFiles({ directory: absoluteSourceRoot })
    .filter((file) => isStaticTailwindSourceFile({ filename: file, sourceRoot: absoluteSourceRoot }));
  const candidateGroups = [];
  const presentFiles = new Set(files);
  for (const cachedFile of cache.keys()) {
    if (!presentFiles.has(cachedFile)) cache.delete(cachedFile);
  }
  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        cache.delete(file);
        continue;
      }
      throw error;
    }
    const cached = cache.get(file);
    if (cached?.source === source) {
      candidateGroups.push(...cloneCandidateGroups({ groups: cached.groups }));
      continue;
    }
    const groups = collectCandidateGroups({ source, filename: file });
    cache.set(file, { source, groups: cloneCandidateGroups({ groups }) });
    candidateGroups.push(...groups);
  }

  const candidateOwners = new Map();
  if (ownershipMode === 'single-css') {
    for (const group of candidateGroups) {
      group.owners = ['initial'];
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

  const ownerByFile = new Map();
  for (const group of candidateGroups) {
    const owner = ownerByFile.get(group.filename) ?? {
      name: sourceModuleOwnerName({ projectRoot: absoluteProjectRoot, moduleId: group.filename }),
      root: group.filename,
    };
    ownerByFile.set(group.filename, owner);
    group.owners = [owner.name];
    for (const candidate of group.candidates) {
      const current = candidateOwners.get(candidate) ?? new Set();
      current.add(owner.name);
      candidateOwners.set(candidate, current);
    }
  }
  return {
    projectRoot: absoluteProjectRoot,
    sourceRoot: absoluteSourceRoot,
    files,
    cssOwners: [...ownerByFile.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    candidateGroups,
    candidateOwners,
  };
}

export function serializeSourceAnalysis({ analysis }) {
  const relative = (file) => path.relative(analysis.projectRoot, file).replaceAll(path.sep, '/');
  return {
    projectRoot: analysis.projectRoot,
    sourceRoot: analysis.sourceRoot,
    files: analysis.files.map(relative),
    cssOwners: analysis.cssOwners.map(({ name, root }) => ({ name, root: relative(root) })),
    candidateOwners: Object.fromEntries([...analysis.candidateOwners].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([candidate, owners]) => [candidate, [...owners].sort()])),
    candidateGroups: analysis.candidateGroups.map((group) => ({ ...group, filename: relative(group.filename) })),
  };
}
