import { parse } from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import type {
  CallExpression,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  ImportDeclaration,
  ImportExpression,
  Node,
  ObjectProperty,
} from '@babel/types';
import type { Plugin } from 'vite';
import type {
  StandaloneBuildDiagnostics,
  ViteWorkerQueryRecord,
} from '../diagnostics.js';
import { babelTraverse } from '../../babel-traverse-runtime.js';
import { isBabelNodeType } from './babel-node.js';

function viteWorkerQueryFlags(specifier: string): string[] {
  const queryIndex = specifier.indexOf('?');
  if (queryIndex < 0) return [];
  const fragmentIndex = specifier.indexOf('#', queryIndex);
  const query = specifier.slice(queryIndex + 1, fragmentIndex < 0 ? undefined : fragmentIndex);
  const flags: string[] = [];
  for (const segment of query.split('&')) {
    const [rawName, rawValue = ''] = segment.split('=', 2);
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(rawName.replaceAll('+', ' '));
      value = decodeURIComponent(rawValue.replaceAll('+', ' '));
    } catch {
      continue;
    }
    if (['worker', 'sharedworker'].includes(name.toLowerCase()) && value === '') {
      flags.push(name.toLowerCase());
    }
  }
  return [...new Set(flags)];
}

function staticStringValue(node: Node | null | undefined): string | null {
  if (isBabelNodeType(node, 'StringLiteral')) return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? '';
  }
  return null;
}

function findViteWorkerQueryImports(code: string, id = '<unknown>'): ViteWorkerQueryRecord[] {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    sourceFilename: id,
    allowAwaitOutsideFunction: true,
    plugins: ['dynamicImport', 'importMeta', 'topLevelAwait', 'typescript', 'jsx'],
  });
  const records: ViteWorkerQueryRecord[] = [];
  const seen = new Set<string>();

  function record(node: Node, kind: string, specifier: string): void {
    const flags = viteWorkerQueryFlags(specifier);
    if (flags.length === 0) return;
    const key = `${node.start}:${node.end}:${kind}:${specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({
      kind,
      specifier,
      flags,
      start: node.start ?? 0,
      end: node.end ?? 0,
      line: node.loc?.start.line ?? null,
      column: node.loc?.start.column ?? null,
    });
  }

  function runtimeImportDeclaration(importPath: NodePath<ImportDeclaration>): boolean {
    switch (importPath.node.importKind) {
    case 'type':
      return false;
    case 'typeof':
    case 'value':
    case null:
    case undefined:
      break;
    default: {
      const exhaustive: never = importPath.node.importKind;
      throw new Error(`Unhandled import kind: ${exhaustive}`);
    }
    }
    if (importPath.node.specifiers.length === 0) return true;
    return importPath.node.specifiers.some(specifier => specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type');
  }

  function runtimeExportDeclaration(exportPath: NodePath<ExportNamedDeclaration>): boolean {
    switch (exportPath.node.exportKind) {
    case 'type':
      return false;
    case 'value':
    case null:
    case undefined:
      break;
    default: {
      const exhaustive: never = exportPath.node.exportKind;
      throw new Error(`Unhandled export kind: ${exhaustive}`);
    }
    }
    if (!Array.isArray(exportPath.node.specifiers) || exportPath.node.specifiers.length === 0) return true;
    return exportPath.node.specifiers.some(specifier => specifier.type !== 'ExportSpecifier' || specifier.exportKind !== 'type');
  }

  function isImportMetaGlob(callee: Node | null | undefined): boolean {
    if (callee?.type !== 'MemberExpression' || callee.computed) return false;
    if (callee.property.type !== 'Identifier' || !['glob', 'globEager'].includes(callee.property.name)) return false;
    return callee.object?.type === 'MetaProperty'
      && callee.object.meta?.name === 'import'
      && callee.object.property?.name === 'meta';
  }

  function globQuerySpecifier(callNode: CallExpression): string | null {
    const options = callNode.arguments?.[1];
    if (!isBabelNodeType(options, 'ObjectExpression')) return null;
    for (const property of options.properties) {
      if (!isBabelNodeType(property, 'ObjectProperty')) continue;
      const key = staticObjectPropertyNameForQuery(property);
      if (key !== 'query') continue;
      return staticStringValue(property.value);
    }
    return null;
  }

  function staticObjectPropertyNameForQuery(node: ObjectProperty): string | null {
    if (!node) return null;
    if (!node.computed && node.key?.type === 'Identifier') return node.key.name;
    if (isBabelNodeType(node.key, 'StringLiteral')) return node.key.value;
    return null;
  }

  babelTraverse(ast, {
    ImportDeclaration(importPath: NodePath<ImportDeclaration>) {
      if (!runtimeImportDeclaration(importPath)) return;
      record(importPath.node, 'static-import', importPath.node.source.value);
    },
    ExportNamedDeclaration(exportPath: NodePath<ExportNamedDeclaration>) {
      if (!exportPath.node.source || !runtimeExportDeclaration(exportPath)) return;
      record(exportPath.node, 'named-reexport', exportPath.node.source.value);
    },
    ExportAllDeclaration(exportPath: NodePath<ExportAllDeclaration>) {
      switch (exportPath.node.exportKind) {
      case 'type':
        return;
      case 'value':
      case null:
      case undefined:
        break;
      default: {
        const exhaustive: never = exportPath.node.exportKind;
        throw new Error(`Unhandled export-all kind: ${exhaustive}`);
      }
      }
      record(exportPath.node, 'export-all', exportPath.node.source.value);
    },
    CallExpression(callPath) {
      if (isBabelNodeType(callPath.node.callee, 'Import')) {
        const specifier = staticStringValue(callPath.node.arguments?.[0]);
        if (specifier !== null) record(callPath.node, 'dynamic-import', specifier);
        return;
      }
      if (isImportMetaGlob(callPath.node.callee)) {
        const query = globQuerySpecifier(callPath.node);
        if (query !== null) record(callPath.node, 'import-meta-glob-query', `glob${query.startsWith('?') ? query : `?${query}`}`);
      }
    },
    ImportExpression(importPath: NodePath<ImportExpression>) {
      const specifier = staticStringValue(importPath.node.source);
      if (specifier !== null) record(importPath.node, 'dynamic-import', specifier);
    },
  });
  return records.sort((left, right) => left.start - right.start || left.kind.localeCompare(right.kind));
}

export function createViteWorkerQueryPolicyPlugin({ diagnostics, allowViteWorkerQueryImport }: Readonly<{
  diagnostics: StandaloneBuildDiagnostics;
  allowViteWorkerQueryImport?: (record: unknown) => boolean;
}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-vite-worker-query-policy',
    enforce: 'pre',
    transform(code, id) {
      if (id.startsWith('\0') || !/\.[cm]?[jt]sx?(?:\?|$)/u.test(id)) return null;
      if (!/[?&](?:worker|sharedworker)(?:&|['"`]|$)/iu.test(code)) return null;
      const sourcePath = id.split('?', 1)[0];
      const imports = findViteWorkerQueryImports(code, sourcePath);
      if (imports.length === 0) return null;
      for (const workerImport of imports) {
        const record = { moduleId: sourcePath, ...workerImport };
        const allowed = typeof allowViteWorkerQueryImport === 'function'
          && allowViteWorkerQueryImport(record) === true;
        diagnostics.viteWorkerQueryImports.push({ ...record, allowed });
        if (!allowed) {
          throw new Error(
            `Vite Worker query import is unsupported in standalone split output (${workerImport.kind}: ${workerImport.specifier}) at ${sourcePath}:${workerImport.start}. `
            + 'It creates a separate Worker build graph and defeats UI/Worker chunk deduplication; use a configured standalone Worker virtual client.',
          );
        }
      }
      return null;
    },
  };
}
