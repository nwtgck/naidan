import path from 'node:path';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';
import { validateStaticComponent } from './source-policy';

type ResolveImport = ({ specifier, importer }: { specifier: string; importer: string }) => Promise<string | undefined>;
type ImportEdge = { specifier: string; kind: 'static' | 'dynamic'; node: ts.Node };
type ScriptSource = { content: string; startLine: number; startColumn: number };

const reservedIslandAttributes = new Set(['data-docs-island', 'data-docs-props', 'data-docs-hydrated']);
const disallowedContextApis = new Set(['useId', 'provide', 'inject']);
const unsupportedStaticVueApis = new Set([
  'onBeforeMount', 'onMounted', 'onBeforeUpdate', 'onUpdated', 'onBeforeUnmount', 'onUnmounted',
  'onActivated', 'onDeactivated', 'onRenderTracked', 'onRenderTriggered',
  'watch', 'watchEffect', 'watchPostEffect', 'watchSyncEffect',
  'h', 'createVNode', 'defineComponent', 'Teleport', 'useTemplateRef',
]);

function isStaticAuthoringFile({ filename }: { filename: string }): boolean {
  if (filename === 'server.ts' || filename.startsWith('client/')) return false;
  if (filename.startsWith('islands/')) {
    return filename === 'islands/spec.ts' || filename === 'islands/registry.ts'
      || /^islands\/[^/]+\/(?:definition|contracts|copy)\.ts$/u.test(filename);
  }
  return true;
}

function isPublicIslandValueEdge({ filename, target }: { filename: string; target: string }): boolean {
  if (!filename.startsWith('islands/')) {
    return /^islands\/[^/]+\/definition\.ts$/u.test(target) || target === 'islands/browser-ai-availability/copy.ts';
  }
  if (filename === 'islands/registry.ts') return /^islands\/[^/]+\/contracts\.ts$/u.test(target);
  const name = islandName({ file: filename });
  if (name === undefined) return false;
  if (filename === `islands/${name}/definition.ts`) return target === `islands/${name}/contracts.ts`;
  if (filename === `islands/${name}/contracts.ts`) return target === 'islands/spec.ts';
  return false;
}

function staticScriptError({ filename, script, ast, node, reason, remedy }: {
  filename: string;
  script: ScriptSource;
  ast: ts.SourceFile;
  node: ts.Node;
  reason: string;
  remedy: string;
}): never {
  const { line, character } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
  const fileLine = script.startLine + line;
  const fileColumn = (line === 0 ? script.startColumn : 1) + character;
  throw new Error(`${filename}:${fileLine}:${fileColumn}: ${reason} ${remedy}`);
}

function rejectUnsupportedStaticVueApi({ name, filename, script, ast, node }: {
  name: string;
  filename: string;
  script: ScriptSource;
  ast: ts.SourceFile;
  node: ts.Node;
}): void {
  if (!unsupportedStaticVueApis.has(name)) return;
  const reason = name === 'Teleport'
    ? 'Vue Teleport content is omitted from the static Docs page.'
    : name === 'useTemplateRef'
      ? 'Vue useTemplateRef has no DOM to reference in static Docs pages.'
      : name.startsWith('watch')
        ? `Vue ${name} is outside the supported static Docs script subset; its server execution does not provide browser reactivity.`
        : ['h', 'createVNode', 'defineComponent'].includes(name)
          ? `Vue ${name} is outside the supported static Docs script subset; render functions can hide inactive events.`
          : `Vue ${name} is not called when a static Docs page is rendered.`;
  const remedy = name === 'Teleport'
    ? 'Render the content inline.'
    : name === 'useTemplateRef'
      ? 'Use server-rendered data, or put DOM access in a registered island.'
      : name.startsWith('watch')
        ? 'Use computed for derived output, onServerPrefetch for async server data, or a registered island for browser updates.'
        : ['h', 'createVNode', 'defineComponent'].includes(name)
          ? 'Write static UI in an SFC template, and put interaction in a registered island.'
          : 'Use computed or onServerPrefetch for server output, or move browser behavior into a registered island.';
  staticScriptError({ filename, script, ast, node, reason, remedy });
}

function docsRelative({ root, file }: { root: string; file: string }): string | undefined {
  const relative = path.relative(root, file.split('?')[0] ?? file).split(path.sep).join('/');
  return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ? undefined : relative;
}

function islandName({ file }: { file: string }): string | undefined {
  const match = /^islands\/([^/]+)\//u.exec(file);
  return match?.[1];
}

function propertyName({ name }: { name: ts.PropertyName }): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function importedSource({ statement }: { statement: ts.ImportDeclaration | ts.ExportDeclaration }): string | undefined {
  return statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text : undefined;
}

function isTypeOnlyEdge({ node }: { node: ts.Node }): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly) return true;
    const bindings = clause?.namedBindings;
    return Boolean(!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length
      && bindings.elements.every(element => element.isTypeOnly));
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const clause = node.exportClause;
    return Boolean(clause && ts.isNamedExports(clause) && clause.elements.length
      && clause.elements.every(element => element.isTypeOnly));
  }
  return false;
}

function importsOnlyCoreValue({ node, exportName }: { node: ts.Node; exportName: string }): boolean {
  if (!ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  const bindings = clause?.namedBindings;
  return Boolean(clause && !clause.name && bindings && ts.isNamedImports(bindings)
    && bindings.elements.filter(element => !element.isTypeOnly).length > 0
    && bindings.elements.every(element => element.isTypeOnly || (element.propertyName?.text ?? element.name.text) === exportName));
}

function scripts({ source, filename }: { source: string; filename: string }): ScriptSource[] {
  if (!filename.endsWith('.vue')) return [{ content: source, startLine: 1, startColumn: 1 }];
  const { descriptor, errors } = parse(source, { filename });
  if (errors.length) throw new Error(`Invalid Docs component ${filename}: ${errors.map(String).join('; ')}`);
  return [descriptor.script, descriptor.scriptSetup]
    .filter((block): block is NonNullable<typeof block> => block !== null)
    .map(block => ({ content: block.content, startLine: block.loc.start.line, startColumn: block.loc.start.column }));
}

function inspectScript({ script, filename }: { script: ScriptSource; filename: string }): {
  ast: ts.SourceFile;
  edges: ImportEdge[];
} {
  const ast = ts.createSourceFile(filename, script.content, ts.ScriptTarget.Latest, true, filename.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const edges: ImportEdge[] = [];
  const vueNamespaces = new Set<string>();
  const staticAuthoring = isStaticAuthoringFile({ filename });

  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = importedSource({ statement });
      if (specifier === undefined) continue;
      edges.push({ specifier, kind: 'static', node: statement });
      if (staticAuthoring && (specifier.startsWith('@vue/') || specifier.startsWith('vue/'))
        && !isTypeOnlyEdge({ node: statement })) {
        staticScriptError({
          filename,
          script,
          ast,
          node: statement,
          reason: `Vue runtime subpath ${specifier} is unsupported in static Docs authoring.`,
          remedy: 'Import named server-rendered APIs from vue, or move browser behavior into a registered island.',
        });
      }
      if (specifier === 'vue') {
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;
        if (staticAuthoring && clause?.name && !clause.isTypeOnly) {
          staticScriptError({
            filename,
            script,
            ast,
            node: clause.name,
            reason: 'A default Vue value import is unsupported in static Docs.',
            remedy: 'Use named Vue imports for server-rendered values, or a registered island for browser behavior.',
          });
        }
        if (bindings && ts.isNamespaceImport(bindings) && !clause?.isTypeOnly) {
          if (staticAuthoring) {
            staticScriptError({
              filename,
              script,
              ast,
              node: bindings,
              reason: 'A Vue value namespace import is unsupported in static Docs.',
              remedy: 'Use named Vue imports so browser-only APIs can be checked.',
            });
          }
          vueNamespaces.add(bindings.name.text);
        }
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            if (disallowedContextApis.has(importedName) && !clause?.isTypeOnly && !element.isTypeOnly) {
              throw new Error(`Vue context API ${element.name.text} is unsupported in Docs islands: ${filename}`);
            }
            if (staticAuthoring && !clause?.isTypeOnly && !element.isTypeOnly) {
              rejectUnsupportedStaticVueApi({ name: importedName, filename, script, ast, node: element });
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      const specifier = importedSource({ statement });
      if (specifier !== undefined) edges.push({ specifier, kind: 'static', node: statement });
      if (staticAuthoring && specifier && (specifier.startsWith('@vue/') || specifier.startsWith('vue/'))
        && !isTypeOnlyEdge({ node: statement })) {
        staticScriptError({
          filename,
          script,
          ast,
          node: statement,
          reason: `Vue runtime subpath ${specifier} is unsupported in static Docs authoring.`,
          remedy: 'Re-export only named server-rendered APIs from vue.',
        });
      }
      if (specifier === 'vue') {
        const clause = statement.exportClause;
        if (staticAuthoring && !statement.isTypeOnly && (!clause || ts.isNamespaceExport(clause))) {
          staticScriptError({
            filename,
            script,
            ast,
            node: statement,
            reason: 'A Vue value star or namespace re-export is unsupported in static Docs.',
            remedy: 'Re-export only explicitly named server-rendered Vue values.',
          });
        }
        if (!staticAuthoring && !statement.isTypeOnly && !clause) {
          throw new Error(`Docs islands cannot re-export Vue context APIs in ${filename}`);
        }
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            if (statement.isTypeOnly || element.isTypeOnly) continue;
            const exportedName = element.propertyName?.text ?? element.name.text;
            if (disallowedContextApis.has(exportedName)) {
              throw new Error(`Docs islands cannot re-export Vue context APIs in ${filename}`);
            }
            if (staticAuthoring) rejectUnsupportedStaticVueApi({ name: exportedName, filename, script, ast, node: element });
          }
        }
      }
    }
  }

  const visit = ({ node }: { node: ts.Node }): void => {
    if (ts.isCallExpression(node)) {
      if (staticAuthoring && filename.endsWith('.vue') && ts.isIdentifier(node.expression) && node.expression.text === 'defineOptions') {
        const option = node.arguments[0];
        const property = option && ts.isObjectLiteralExpression(option) && option.properties.length === 1 ? option.properties[0] : undefined;
        const valid = node.arguments.length === 1 && property && ts.isPropertyAssignment(property)
          && propertyName({ name: property.name }) === 'inheritAttrs'
          && property.initializer.kind === ts.SyntaxKind.FalseKeyword;
        if (!valid) {
          staticScriptError({
            filename,
            script,
            ast,
            node,
            reason: 'Static Docs defineOptions supports only { inheritAttrs: false }; lifecycle options are not called in published static pages.',
            remedy: 'Use inline <script setup> for server output, or a registered island for browser behavior.',
          });
        }
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (staticAuthoring && argument && ts.isStringLiteralLike(argument)
          && (argument.text === 'vue' || argument.text.startsWith('@vue/') || argument.text.startsWith('vue/'))) {
          staticScriptError({
            filename,
            script,
            ast,
            node,
            reason: 'A dynamic Vue value import is unsupported in static Docs.',
            remedy: 'Use named Vue imports for server-rendered values, or a registered island for browser behavior.',
          });
        }
        if (argument && ts.isStringLiteralLike(argument)) edges.push({ specifier: argument.text, kind: 'dynamic', node });
      }
      if (staticAuthoring && ts.isIdentifier(node.expression) && node.expression.text === 'require'
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
        && (node.arguments[0].text === 'vue' || node.arguments[0].text.startsWith('@vue/') || node.arguments[0].text.startsWith('vue/'))) {
        staticScriptError({
          filename,
          script,
          ast,
          node,
          reason: 'A require("vue") value import is unsupported in static Docs.',
          remedy: 'Use named Vue imports for server-rendered values, or a registered island for browser behavior.',
        });
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && vueNamespaces.has(node.expression.text) && disallowedContextApis.has(node.name.text)) {
      throw new Error(`Vue context API ${node.name.text} is unsupported in Docs islands: ${filename}`);
    }
    if (ts.isObjectLiteralExpression(node) && filename !== 'site/DocsIsland.vue') {
      for (const property of node.properties) {
        if ((ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) && reservedIslandAttributes.has(propertyName({ name: property.name }) ?? '')) {
          throw new Error(`Reserved Docs island attribute in script ${filename}`);
        }
      }
    }
    ts.forEachChild(node, child => visit({ node: child }));
  };
  visit({ node: ast });
  return { ast, edges };
}

function checkDefinition({ ast, filename }: { ast: ts.SourceFile; filename: string }): void {
  const name = islandName({ file: filename });
  if (name === undefined) throw new Error(`Invalid Docs island definition path: ${filename}`);
  const componentImports = new Map<string, string>();
  const specImports = new Set<string>();
  const factoryNames = new Set<string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = importedSource({ statement });
    if (specifier === undefined) continue;
    if (specifier.endsWith('.vue')) {
      const imported = statement.importClause;
      if (!specifier.startsWith('./') || !imported?.name || imported.isTypeOnly || imported.namedBindings) {
        throw new Error(`Docs island definition must directly default-import its local SFC: ${filename}`);
      }
      componentImports.set(imported.name.text, specifier);
    }
    if (specifier === './contracts' || specifier === './contracts.ts') {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if (!element.isTypeOnly) specImports.add(element.name.text);
      }
    }
    if (specifier === '../core' || specifier === '../core.ts') {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === 'defineDocsIsland') factoryNames.add(element.name.text);
        }
      }
    }
  }
  if (componentImports.size !== 1 || specImports.size === 0 || factoryNames.size === 0) {
    throw new Error(`Docs island definition requires one concrete SFC, its local spec, and defineDocsIsland: ${filename}`);
  }
  let factoryCount = 0;
  for (const statement of ast.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || statement.exportClause && ts.isNamedExports(statement.exportClause)
        && statement.exportClause.elements.every(element => element.isTypeOnly)) continue;
      throw new Error(`Docs island definition may export only its factory: ${filename}`);
    }
    if (ts.isExportAssignment(statement)) {
      throw new Error(`Docs island definition may export only its factory: ${filename}`);
    }
    const exported = ts.canHaveModifiers(statement)
      && (ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
    if (!ts.isVariableStatement(statement)) {
      if (exported && !ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) {
        throw new Error(`Docs island definition may export only its factory: ${filename}`);
      }
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!exported) continue;
      const initializer = declaration.initializer;
      if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)
        || !factoryNames.has(initializer.expression.text) || initializer.arguments.length !== 1) {
        throw new Error(`Docs island definition may export only a direct defineDocsIsland call: ${filename}`);
      }
      const argument = initializer.arguments[0];
      if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error(`Docs island definition must use a literal definition: ${filename}`);
      const entries = new Map(argument.properties.filter(ts.isPropertyAssignment).map(property => [propertyName({ name: property.name }), property.initializer]));
      const component = entries.get('component');
      const spec = entries.get('spec');
      if (argument.properties.length !== 2 || !component || !ts.isIdentifier(component) || !componentImports.has(component.text)
        || !spec || !ts.isIdentifier(spec) || !specImports.has(spec.text)) {
        throw new Error(`Docs island definition must use directly imported component and spec identifiers: ${filename}`);
      }
      factoryCount++;
    }
  }
  if (factoryCount !== 1) throw new Error(`Docs island definition must export one factory: ${filename}`);
}

function checkSpec({ ast, filename }: { ast: ts.SourceFile; filename: string }): void {
  const name = islandName({ file: filename });
  if (name === undefined) return;
  let found = false;
  const visit = ({ node }: { node: ts.Node }): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineDocsIslandSpec') {
      const argument = node.arguments[0];
      if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error(`Docs island spec must be a literal object: ${filename}`);
      const id = argument.properties.find(property => ts.isPropertyAssignment(property) && propertyName({ name: property.name }) === 'id');
      if (!id || !ts.isPropertyAssignment(id) || !ts.isStringLiteralLike(id.initializer) || id.initializer.text !== name) {
        throw new Error(`Docs island spec ID must match its directory ${name}: ${filename}`);
      }
      found = true;
    }
    ts.forEachChild(node, child => visit({ node: child }));
  };
  visit({ node: ast });
  if (!found) throw new Error(`Missing Docs island spec in ${filename}`);
}

export async function validateDocsAuthoringSource({ source, filename, root, resolve }: {
  source: string;
  filename: string;
  root: string;
  resolve: ResolveImport;
}): Promise<void> {
  const name = islandName({ file: filename });
  if (filename.endsWith('.vue')) {
    validateStaticComponent({ source, filename, mode: name === undefined ? 'static' : 'island' });
  }
  const importer = path.resolve(root, filename);
  for (const script of scripts({ source, filename })) {
    const { ast, edges } = inspectScript({ script, filename });
    if (name !== undefined && filename.endsWith('/definition.ts')) checkDefinition({ ast, filename });
    if (name !== undefined && filename === `islands/${name}/contracts.ts`) checkSpec({ ast, filename });
    for (const edge of edges) {
      const resolved = await resolve({ specifier: edge.specifier, importer });
      if (resolved === undefined) continue;
      const target = docsRelative({ root, file: resolved });
      const staticAuthoring = isStaticAuthoringFile({ filename });
      if (staticAuthoring && target?.startsWith('client/') && !isTypeOnlyEdge({ node: edge.node })) {
        staticScriptError({
          filename,
          script,
          ast,
          node: edge.node,
          reason: `Static Docs cannot import browser client code from ${target}.`,
          remedy: 'Keep static output in the page or a server-rendered helper; put browser behavior in a registered island.',
        });
      }
      if (target === 'islands/core.ts' && !isTypeOnlyEdge({ node: edge.node })) {
        const hostImport = filename === 'site/DocsIsland.vue' && importsOnlyCoreValue({ node: edge.node, exportName: 'readDocsIslandEntry' });
        const definitionImport = name !== undefined && filename === `islands/${name}/definition.ts`
          && importsOnlyCoreValue({ node: edge.node, exportName: 'defineDocsIsland' });
        if (!hostImport && !definitionImport) {
          throw new Error(`Import Docs island runtime through a definition or DocsIsland host: ${filename}`);
        }
      }
      if (staticAuthoring && target?.startsWith('islands/') && !target.endsWith('.vue')
        && !isTypeOnlyEdge({ node: edge.node }) && target !== 'islands/core.ts'
        && !isPublicIslandValueEdge({ filename, target })) {
        staticScriptError({
          filename,
          script,
          ast,
          node: edge.node,
          reason: `Static Docs cannot import private island code from ${target}.`,
          remedy: 'Import the registered island definition through DocsIsland, or move shared static data into an approved static helper.',
        });
      }
      if (target === undefined || !target.endsWith('.vue') || islandName({ file: target }) === undefined) continue;
      const targetIsland = islandName({ file: target });
      const withinIslandComponent = name === targetIsland && filename.endsWith('.vue');
      const definitionImport = name === targetIsland && filename === `islands/${name}/definition.ts`
        && edge.kind === 'static' && edge.specifier.startsWith('./') && path.posix.dirname(target) === path.posix.dirname(filename);
      if (!withinIslandComponent && !definitionImport) {
        if (staticAuthoring) {
          staticScriptError({
            filename,
            script,
            ast,
            node: edge.node,
            reason: `Import raw Docs island component through its definition instead: ${filename} -> ${target}.`,
            remedy: 'Pass the registered factory to DocsIsland.',
          });
        }
        throw new Error(`Import raw Docs island component through its definition instead: ${filename} -> ${target}`);
      }
    }
  }
}
