import path from 'node:path';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';
import { validateStaticComponent } from './source-policy';

type ResolveImport = ({ specifier, importer }: { specifier: string; importer: string }) => Promise<string | undefined>;
type ImportEdge = { specifier: string; kind: 'static' | 'dynamic'; node: ts.Node };

const reservedIslandAttributes = new Set(['data-docs-island', 'data-docs-props', 'data-docs-hydrated']);
const disallowedContextApis = new Set(['useId', 'provide', 'inject']);

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

function scripts({ source, filename }: { source: string; filename: string }): string[] {
  if (!filename.endsWith('.vue')) return [source];
  const { descriptor, errors } = parse(source, { filename });
  if (errors.length) throw new Error(`Invalid Docs component ${filename}: ${errors.map(String).join('; ')}`);
  return [descriptor.script?.content, descriptor.scriptSetup?.content].filter((script): script is string => script !== undefined);
}

function inspectScript({ source, filename }: { source: string; filename: string }): {
  ast: ts.SourceFile;
  edges: ImportEdge[];
} {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const edges: ImportEdge[] = [];
  const vueNamespaces = new Set<string>();

  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = importedSource({ statement });
      if (specifier === undefined) continue;
      edges.push({ specifier, kind: 'static', node: statement });
      if (specifier === 'vue') {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) vueNamespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (disallowedContextApis.has(element.propertyName?.text ?? element.name.text)) {
              throw new Error(`Vue context API ${element.name.text} is unsupported in Docs islands: ${filename}`);
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      const specifier = importedSource({ statement });
      if (specifier !== undefined) edges.push({ specifier, kind: 'static', node: statement });
      if (specifier === 'vue' && (!statement.exportClause || ts.isNamedExports(statement.exportClause)
        && statement.exportClause.elements.some(element => disallowedContextApis.has(element.propertyName?.text ?? element.name.text)))) {
        throw new Error(`Docs islands cannot re-export Vue context APIs in ${filename}`);
      }
    }
  }

  const visit = ({ node }: { node: ts.Node }): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) edges.push({ specifier: argument.text, kind: 'dynamic', node });
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
    const { ast, edges } = inspectScript({ source: script, filename });
    if (name !== undefined && filename.endsWith('/definition.ts')) checkDefinition({ ast, filename });
    if (name !== undefined && filename === `islands/${name}/contracts.ts`) checkSpec({ ast, filename });
    for (const edge of edges) {
      const resolved = await resolve({ specifier: edge.specifier, importer });
      if (resolved === undefined) continue;
      const target = docsRelative({ root, file: resolved });
      if (target === 'islands/core.ts' && !isTypeOnlyEdge({ node: edge.node })) {
        const hostImport = filename === 'site/DocsIsland.vue' && importsOnlyCoreValue({ node: edge.node, exportName: 'readDocsIslandEntry' });
        const definitionImport = name !== undefined && filename === `islands/${name}/definition.ts`
          && importsOnlyCoreValue({ node: edge.node, exportName: 'defineDocsIsland' });
        if (!hostImport && !definitionImport) {
          throw new Error(`Import Docs island runtime through a definition or DocsIsland host: ${filename}`);
        }
      }
      if (target === undefined || !target.endsWith('.vue') || islandName({ file: target }) === undefined) continue;
      const targetIsland = islandName({ file: target });
      const withinIslandComponent = name === targetIsland && filename.endsWith('.vue');
      const definitionImport = name === targetIsland && filename === `islands/${name}/definition.ts`
        && edge.kind === 'static' && edge.specifier.startsWith('./') && path.posix.dirname(target) === path.posix.dirname(filename);
      if (!withinIslandComponent && !definitionImport) {
        throw new Error(`Import raw Docs island component through its definition instead: ${filename} -> ${target}`);
      }
    }
  }
}
