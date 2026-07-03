import fs from 'node:fs';
import path from 'node:path';
import { NodeTypes, parse as parseTemplate } from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { parseTwClassExpression, parseTwClassTokens } from './tw-class-core.mjs';
import { tailwindClassAttributeBySource } from './tailwind-class-attributes.mjs';
import {
  createTypeScriptSourceFile,
  staticStringValue,
  ts,
  unwrapTypeScriptExpression,
  visitTypeScriptAst,
} from './typescript-ast-utils.mjs';

const moduleExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'];

function isPathInside({ directory, candidate }) {
  const relativePath = path.relative(path.resolve(directory), path.resolve(candidate));
  return relativePath === ''
    || (!path.isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`));
}

function walkFiles({ directory }) {
  if (!fs.existsSync(directory)) return [];
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles({ directory: absolutePath }) : [absolutePath];
  });
}

function isAnalyzableSourceFile({ file, sourceRoot }) {
  const relativePath = path.relative(sourceRoot, file).replaceAll(path.sep, '/');
  return moduleExtensions.includes(path.extname(file))
    && !/\.(?:test|spec)\.[^.]+$/u.test(file)
    && !relativePath.startsWith('test-tmp/')
    && !relativePath.startsWith('lint-rule-tmp/');
}

function scriptBlocksFromVue({ source, filename }) {
  const { descriptor, errors } = parseSfc(source, { filename });
  if (errors.length > 0) throw new Error(`${filename}: ${errors.map(String).join('; ')}`);
  return {
    descriptor,
    blocks: [
      { block: descriptor.script, kind: 'script' },
      { block: descriptor.scriptSetup, kind: 'script-setup' },
    ]
      .filter(({ block }) => block !== null)
      .map(({ block, kind }) => ({
        source: block.content,
        filename: `${filename}.${block.lang === 'js' || block.lang === 'jsx' ? block.lang : 'ts'}`,
        blockStart: block.loc.start,
        groupIdPrefix: kind,
      })),
  };
}

function resolveSourceSpecifier({ importer, specifier, sourceRoot, aliases }) {
  let candidate;
  if (specifier.startsWith('.')) candidate = path.resolve(path.dirname(importer), specifier);
  else {
    const matchedAlias = aliases.find(({ find }) => specifier === find || specifier.startsWith(`${find}/`));
    if (matchedAlias === undefined) return undefined;
    candidate = path.resolve(matchedAlias.replacement, specifier.slice(matchedAlias.find.length).replace(/^\//u, ''));
  }
  const attempts = [candidate, ...moduleExtensions.map((extension) => `${candidate}${extension}`)];
  for (const extension of moduleExtensions) attempts.push(path.join(candidate, `index${extension}`));
  const resolved = attempts.find((attempt) => fs.existsSync(attempt) && fs.statSync(attempt).isFile());
  if (resolved === undefined) return undefined;
  const normalized = path.resolve(resolved);
  return isPathInside({ directory: sourceRoot, candidate: normalized }) ? normalized : undefined;
}

function collectImportsFromSourceFile({ sourceFile, importer, sourceRoot, aliases }) {
  const staticImports = new Set();
  const dynamicImports = new Set();
  const unresolvedDynamicImports = [];
  function add({ specifier, kind }) {
    const resolved = resolveSourceSpecifier({ importer, specifier, sourceRoot, aliases });
    if (resolved !== undefined) (kind === 'static' ? staticImports : dynamicImports).add(resolved);
  }
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      add({ specifier: statement.moduleSpecifier.text, kind: 'static' });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
      add({ specifier: statement.moduleSpecifier.text, kind: 'static' });
    }
  }
  visitTypeScriptAst({
    node: sourceFile,
    visitor(node) {
      if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
      const [argument] = node.arguments;
      const specifier = argument === undefined ? undefined : staticStringValue({ node: argument });
      if (specifier === undefined) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        unresolvedDynamicImports.push({
          line: position.line + 1,
          column: position.character + 1,
          expression: argument?.getText(sourceFile) ?? '',
        });
      } else add({ specifier, kind: 'dynamic' });
    },
  });
  return { staticImports: [...staticImports], dynamicImports: [...dynamicImports], unresolvedDynamicImports };
}

function collectModuleImports({ source, filename, sourceRoot, aliases }) {
  if (!filename.endsWith('.vue')) {
    return collectImportsFromSourceFile({
      sourceFile: createTypeScriptSourceFile({ source, filename }),
      importer: filename,
      sourceRoot,
      aliases,
    });
  }
  const { blocks } = scriptBlocksFromVue({ source, filename });
  const staticImports = new Set();
  const dynamicImports = new Set();
  const unresolvedDynamicImports = [];
  for (const block of blocks) {
    const result = collectImportsFromSourceFile({
      sourceFile: createTypeScriptSourceFile({ source: block.source, filename: block.filename }),
      importer: filename,
      sourceRoot,
      aliases,
    });
    result.staticImports.forEach((value) => staticImports.add(value));
    result.dynamicImports.forEach((value) => dynamicImports.add(value));
    unresolvedDynamicImports.push(...result.unresolvedDynamicImports);
  }
  return { staticImports: [...staticImports], dynamicImports: [...dynamicImports], unresolvedDynamicImports };
}

function classAttributeDefinition({ prop }) {
  if (prop.type === NodeTypes.ATTRIBUTE) return tailwindClassAttributeBySource.get(prop.name);
  if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic) {
    return tailwindClassAttributeBySource.get(prop.arg.content);
  }
  return undefined;
}

function collectVueTemplateGroups({ source, filename }) {
  const { descriptor } = scriptBlocksFromVue({ source, filename });
  if (descriptor.template === null) return [];
  const ast = parseTemplate(descriptor.template.content, { comments: true, expressionPlugins: ['typescript'] });
  const groups = [];
  let index = 0;
  const visited = new Set();
  function visit(node) {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.type === NodeTypes.ELEMENT) {
      const candidates = [];
      const sources = [];
      for (const prop of node.props) {
        const definition = classAttributeDefinition({ prop });
        if (definition === undefined) continue;
        if (prop.type === NodeTypes.ATTRIBUTE && prop.value !== undefined) {
          candidates.push(...parseTwClassTokens({ value: prop.value.content, filename, loc: prop.loc }));
          sources.push(definition.source);
        } else if (prop.type === NodeTypes.DIRECTIVE && definition.target === 'class' && prop.exp !== undefined) {
          candidates.push(...parseTwClassExpression({ expression: prop.exp.loc.source, filename, loc: prop.loc }).classes);
          sources.push(`:${definition.source}`);
        }
      }
      if (candidates.length > 0) {
        groups.push({
          id: `${filename}:template:${index}`,
          filename,
          sourceKind: 'vue-template-element',
          sourceAttributes: [...new Set(sources)].sort(),
          candidates: [...new Set(candidates)],
          line: descriptor.template.loc.start.line + node.loc.start.line - 1,
          column: node.loc.start.column,
        });
        index += 1;
      }
    }
    if ('children' in node && Array.isArray(node.children)) node.children.forEach(visit);
    if (node.type === NodeTypes.IF) node.branches.forEach(visit);
  }
  visit(ast);
  return groups;
}

function collectMacroGroupsFromSourceFile({ sourceFile, filename, blockStart, groupIdPrefix }) {
  const twNames = new Set();
  const twClassStringNames = new Set();
  const groups = [];
  let index = 0;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'virtual:naidan-tailwind') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      const imported = (specifier.propertyName ?? specifier.name).text;
      if (imported === 'tw') twNames.add(specifier.name.text);
      else if (imported === 'twClassString') twClassStringNames.add(specifier.name.text);
    }
  }
  visitTypeScriptAst({
    node: sourceFile,
    visitor(node) {
      if (!ts.isCallExpression(node)) return;
      const expression = unwrapTypeScriptExpression({ node: node.expression });
      if (!ts.isIdentifier(expression)) return;
      const isTw = twNames.has(expression.text);
      const isString = twClassStringNames.has(expression.text);
      if (!isTw && !isString) return;
      const candidates = node.arguments.flatMap((argument) => {
        const value = staticStringValue({ node: argument });
        return value === undefined ? [] : parseTwClassTokens({ value, filename });
      });
      if (candidates.length === 0) return;
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      groups.push({
        id: `${filename}:${groupIdPrefix}:macro:${index}`,
        filename,
        sourceKind: isTw ? 'tw()' : 'twClassString()',
        candidates: [...new Set(candidates)],
        line: blockStart.line + position.line,
        column: position.line === 0
          ? blockStart.column + position.character
          : position.character + 1,
      });
      index += 1;
    },
  });
  return groups;
}

function collectCandidateGroups({ source, filename }) {
  if (!filename.endsWith('.vue')) {
    return collectMacroGroupsFromSourceFile({
      sourceFile: createTypeScriptSourceFile({ source, filename }),
      filename,
      blockStart: { line: 1, column: 1 },
      groupIdPrefix: 'module',
    });
  }
  const result = collectVueTemplateGroups({ source, filename });
  const { blocks } = scriptBlocksFromVue({ source, filename });
  for (const block of blocks) {
    result.push(...collectMacroGroupsFromSourceFile({
      sourceFile: createTypeScriptSourceFile({ source: block.source, filename: block.filename }),
      filename,
      blockStart: block.blockStart,
      groupIdPrefix: block.groupIdPrefix,
    }));
  }
  return result;
}

function staticClosure({ root, graph }) {
  const visited = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const imported of graph.get(current)?.staticImports ?? []) stack.push(imported);
  }
  return visited;
}

function ownerName({ sourceRoot, moduleId }) {
  return `lazy:${path.relative(sourceRoot, moduleId).replaceAll(path.sep, '/')}`;
}

function sourceModuleOwnerName({ projectRoot, moduleId }) {
  return `module:${path.relative(projectRoot, moduleId).replaceAll(path.sep, '/')}`;
}

export function analyzeSourceModules({ projectRoot, sourceRoot, entryModule, aliases, additionalLazyRootDirectories, ownershipMode }) {
  if (ownershipMode !== 'single-css' && ownershipMode !== 'source-module' && ownershipMode !== 'module-graph') {
    throw new Error(`[tw-class] Unknown source ownership mode: ${String(ownershipMode)}`);
  }
  const absoluteProjectRoot = path.resolve(projectRoot);
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const files = walkFiles({ directory: absoluteSourceRoot })
    .filter((file) => isAnalyzableSourceFile({ file, sourceRoot: absoluteSourceRoot }));
  const graph = new Map();
  const candidateGroups = [];
  const unresolvedDynamicImports = [];
  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (ownershipMode === 'module-graph') {
      const imports = collectModuleImports({ source, filename: file, sourceRoot: absoluteSourceRoot, aliases });
      graph.set(file, imports);
      unresolvedDynamicImports.push(...imports.unresolvedDynamicImports.map((record) => ({ filename: file, ...record })));
    }
    candidateGroups.push(...collectCandidateGroups({ source, filename: file }));
  }
  const absoluteEntry = path.resolve(entryModule);
  if (ownershipMode === 'single-css') {
    const initialModules = new Set();
    const moduleOwners = new Map(files.map((file) => [file, new Set()]));
    const candidateOwners = new Map();
    for (const group of candidateGroups) {
      const owners = new Set(['initial']);
      group.owners = ['initial'];
      moduleOwners.set(group.filename, owners);
      initialModules.add(group.filename);
      for (const candidate of group.candidates) {
        candidateOwners.set(candidate, new Set(['initial']));
      }
    }
    return {
      projectRoot: absoluteProjectRoot,
      sourceRoot: absoluteSourceRoot,
      entryModule: absoluteEntry,
      files,
      graph,
      unresolvedDynamicImports,
      initialModules,
      cssOwners: [],
      lazyOwners: [],
      moduleOwners,
      candidateGroups,
      candidateOwners,
      fallbackInitialModules: new Set(),
    };
  }
  if (ownershipMode === 'source-module') {
    const initialModules = new Set([absoluteEntry]);
    const moduleOwners = new Map(files.map((file) => [file, new Set()]));
    const ownerByFile = new Map();
    const candidateOwners = new Map();
    for (const group of candidateGroups) {
      const owner = ownerByFile.get(group.filename) ?? {
        name: sourceModuleOwnerName({ projectRoot: absoluteProjectRoot, moduleId: group.filename }),
        root: group.filename,
      };
      ownerByFile.set(group.filename, owner);
      const owners = new Set([owner.name]);
      group.owners = [owner.name];
      moduleOwners.set(group.filename, owners);
      for (const candidate of group.candidates) {
        const current = candidateOwners.get(candidate) ?? new Set();
        current.add(owner.name);
        candidateOwners.set(candidate, current);
      }
    }
    return {
      projectRoot: absoluteProjectRoot,
      sourceRoot: absoluteSourceRoot,
      entryModule: absoluteEntry,
      files,
      graph,
      unresolvedDynamicImports,
      initialModules,
      cssOwners: [...ownerByFile.values()].sort((left, right) => left.name.localeCompare(right.name)),
      lazyOwners: [],
      moduleOwners,
      candidateGroups,
      candidateOwners,
      fallbackInitialModules: new Set(),
    };
  }
  const initialModules = staticClosure({ root: absoluteEntry, graph });
  const dynamicRoots = new Set();
  for (const module of graph.values()) module.dynamicImports.forEach((value) => dynamicRoots.add(value));
  for (const directory of additionalLazyRootDirectories) {
    for (const file of walkFiles({ directory: path.resolve(directory) })) {
      if (moduleExtensions.includes(path.extname(file)) && graph.has(path.resolve(file))) dynamicRoots.add(path.resolve(file));
    }
  }
  const lazyOwners = [...dynamicRoots].sort().map((root) => ({ name: ownerName({ sourceRoot: absoluteSourceRoot, moduleId: root }), root }));
  const moduleOwners = new Map(files.map((file) => [file, new Set()]));
  for (const file of initialModules) moduleOwners.get(file)?.add('initial');
  for (const owner of lazyOwners) {
    for (const file of staticClosure({ root: owner.root, graph })) {
      if (!initialModules.has(file)) moduleOwners.get(file)?.add(owner.name);
    }
  }
  const candidateOwners = new Map();
  const fallbackInitialModules = new Set();
  for (const group of candidateGroups) {
    const owners = moduleOwners.get(group.filename) ?? new Set();
    if (owners.size === 0) {
      owners.add('initial');
      moduleOwners.set(group.filename, owners);
      fallbackInitialModules.add(group.filename);
    }
    group.owners = [...owners].sort();
    for (const candidate of group.candidates) {
      const current = candidateOwners.get(candidate) ?? new Set();
      owners.forEach((owner) => current.add(owner));
      candidateOwners.set(candidate, current);
    }
  }
  return {
    projectRoot: absoluteProjectRoot,
    sourceRoot: absoluteSourceRoot,
    entryModule: absoluteEntry,
    files,
    graph,
    unresolvedDynamicImports,
    initialModules,
    cssOwners: lazyOwners,
    lazyOwners,
    moduleOwners,
    candidateGroups,
    candidateOwners,
    fallbackInitialModules,
  };
}

export function serializeSourceAnalysis({ analysis }) {
  const relative = (file) => path.relative(analysis.projectRoot, file).replaceAll(path.sep, '/');
  return {
    projectRoot: analysis.projectRoot,
    sourceRoot: analysis.sourceRoot,
    entryModule: analysis.entryModule,
    files: analysis.files.map(relative),
    unresolvedDynamicImports: analysis.unresolvedDynamicImports.map(({ filename, ...record }) => ({ filename: relative(filename), ...record })),
    initialModules: [...analysis.initialModules].map(relative).sort(),
    cssOwners: analysis.cssOwners.map(({ name, root }) => ({ name, root: relative(root) })),
    lazyOwners: analysis.lazyOwners.map(({ name, root }) => ({ name, root: relative(root) })),
    moduleOwners: Object.fromEntries([...analysis.moduleOwners].map(([file, owners]) => [relative(file), [...owners].sort()])),
    fallbackInitialModules: [...analysis.fallbackInitialModules].map(relative).sort(),
    candidateOwners: Object.fromEntries([...analysis.candidateOwners].sort(([left], [right]) => left.localeCompare(right)).map(([candidate, owners]) => [candidate, [...owners].sort()])),
    candidateGroups: analysis.candidateGroups.map((group) => ({ ...group, filename: relative(group.filename) })),
  };
}
