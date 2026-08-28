import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { OutputChunk, PluginContext } from 'rolldown';
import type { Plugin } from 'vite';
import type { StandaloneBuildDiagnostics } from '../diagnostics.js';
import type { NormalizedWorkerDefinition } from '../worker-definition.js';
import { isBabelNode, isBabelNodeType } from './babel-node.js';

type ImportScriptsCall = Readonly<{staticSpecifiers: string[]; unsupportedArguments: string[]; start: number | null; end: number | null; deferred: boolean; guarded: boolean; topLevelUnsafeForUi: boolean}>;
type ImportScriptsAssetRecord = Readonly<{realSourcePath: string; source: string; outputFileName: string}>;

function stripQueryAndFragment(specifier: string): string {
  return specifier.replace(/[?#].*$/u, '');
}

function isFunctionLike(node: Node | null | undefined): boolean {
  return node !== null && node !== undefined && [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}

function guardExpressionMentionsWorkerImportScripts(test: Node | null | undefined, code: string, safeGuardIdentifiers: ReadonlySet<string> = new Set()): boolean {
  if (!test || typeof test.start !== 'number' || typeof test.end !== 'number') return false;
  if (isBabelNodeType(test, 'Identifier') && safeGuardIdentifiers.has(test.name)) return true;
  const source = code.slice(test.start, test.end);
  if ([...safeGuardIdentifiers].some(identifier => new RegExp(`\\b${identifier}\\b`, 'u').test(source))) return true;
  return /typeof\s+importScripts\s*(?:===?\s*['"]function['"]|!==?\s*['"]undefined['"])/u.test(source)
    || /['"]undefined['"]\s*!==?\s*typeof\s+importScripts/u.test(source)
    || /['"]function['"]\s*===?\s*typeof\s+importScripts/u.test(source);
}

function analyzeImportScriptsCalls(code: string, id = '<unknown>'): ImportScriptsCall[] {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    sourceFilename: id,
    allowAwaitOutsideFunction: true,
    plugins: ['dynamicImport', 'importMeta', 'topLevelAwait', 'typescript', 'jsx'],
  });
  const calls: ImportScriptsCall[] = [];
  const safeGuardIdentifiers = new Set<string>();
  for (const statement of ast.program?.body ?? []) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    for (const declaration of statement.declarations) {
      if (declaration.id?.type !== 'Identifier' || !declaration.init) continue;
      if (guardExpressionMentionsWorkerImportScripts(declaration.init, code)) {
        safeGuardIdentifiers.add(declaration.id.name);
      }
    }
  }

  function visit(node: Node | null | undefined, ancestors: readonly Node[]): void {
    if (!node || typeof node !== 'object') return;
    if (isBabelNodeType(node, 'CallExpression') && node.callee?.type === 'Identifier' && node.callee.name === 'importScripts') {
      const staticSpecifiers: string[] = [];
      const unsupportedArguments: string[] = [];
      for (const argument of node.arguments) {
        if (isBabelNodeType(argument, 'StringLiteral')) staticSpecifiers.push(argument.value);
        else unsupportedArguments.push(argument.type);
      }
      const deferred = ancestors.some(isFunctionLike);
      const guarded = ancestors.some((ancestor, index) => {
        if (ancestor.type === 'IfStatement' && ancestor.consequent) {
          const descendant = ancestors[index + 1] ?? node;
          if (descendant === ancestor.consequent || ancestors.slice(index + 1).includes(ancestor.consequent)) {
            return guardExpressionMentionsWorkerImportScripts(ancestor.test, code, safeGuardIdentifiers);
          }
        }
        if (ancestor.type === 'LogicalExpression' && ancestor.operator === '&&') {
          const descendant = ancestors[index + 1] ?? node;
          if (descendant === ancestor.right || ancestors.slice(index + 1).includes(ancestor.right)) {
            return guardExpressionMentionsWorkerImportScripts(ancestor.left, code, safeGuardIdentifiers);
          }
        }
        if (isBabelNodeType(ancestor, 'ConditionalExpression')) {
          const descendant = ancestors[index + 1] ?? node;
          if (descendant === ancestor.consequent || ancestors.slice(index + 1).includes(ancestor.consequent)) {
            return guardExpressionMentionsWorkerImportScripts(ancestor.test, code, safeGuardIdentifiers);
          }
        }
        return false;
      });
      calls.push({
        staticSpecifiers,
        unsupportedArguments,
        start: node.start ?? null,
        end: node.end ?? null,
        deferred,
        guarded,
        topLevelUnsafeForUi: !deferred && !guarded,
      });
    }
    const nextAncestors = [...ancestors, node];
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isBabelNode(item)) visit(item, nextAncestors);
        }
      } else if (isBabelNode(value)) {
        visit(value, nextAncestors);
      }
    }
  }

  visit(ast, []);
  return calls;
}

function findImportScriptsCalls(code: string, id = '<unknown>'): ImportScriptsCall[] {
  return analyzeImportScriptsCalls(code, id);
}

function validateRelativeClassicSpecifier(specifier: string, sourcePath: string): string {
  if (specifier.includes('\\')) {
    throw new Error(`Backslashes are unsupported in importScripts() paths: ${JSON.stringify(specifier)} in ${sourcePath}`);
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    throw new Error(
      `Standalone importScripts() only supports relative string literals; got ${JSON.stringify(specifier)} in ${sourcePath}`,
    );
  }
  const rawPathname = stripQueryAndFragment(specifier);
  if (!rawPathname || rawPathname === '.' || rawPathname === '..') {
    throw new Error(`Invalid importScripts() path ${JSON.stringify(specifier)} in ${sourcePath}`);
  }
  const decodedSegments = rawPathname.split('/').map(rawSegment => {
    let decoded;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw new Error(`Invalid percent encoding in importScripts() path ${JSON.stringify(specifier)} in ${sourcePath}`);
    }
    if (decoded.includes('/') || decoded.includes('\\')) {
      throw new Error(`Encoded path separators are unsupported in importScripts() path ${JSON.stringify(specifier)} in ${sourcePath}`);
    }
    if (rawSegment !== decoded && (decoded === '.' || decoded === '..')) {
      throw new Error(`Encoded dot segments are unsupported in importScripts() path ${JSON.stringify(specifier)} in ${sourcePath}`);
    }
    if ([...decoded].some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })) {
      throw new Error(`Control characters are unsupported in importScripts() path ${JSON.stringify(specifier)} in ${sourcePath}`);
    }
    return decoded;
  });
  return decodedSegments.join('/');
}

function outputNameForClassicSpecifier({ specifier, classicScriptOutputBase, sourcePath }: Readonly<{specifier: string; classicScriptOutputBase: string; sourcePath: string}>): string {
  const pathname = validateRelativeClassicSpecifier(specifier, sourcePath).replaceAll('\\', '/');
  const normalizedBase = path.posix.normalize(classicScriptOutputBase).replace(/^\.\//u, '');
  const normalized = path.posix.normalize(path.posix.join(normalizedBase, pathname));
  const basePrefix = normalizedBase.endsWith('/') ? normalizedBase : `${normalizedBase}/`;
  if (!normalized.startsWith(basePrefix)) {
    throw new Error(`importScripts() path escapes standalone Classic Script root: ${specifier} in ${sourcePath}`);
  }
  return normalized;
}

export function createImportScriptsAssetPlugin({
  diagnostics,
  classicScriptOutputBase,
  workers,
}: Readonly<{
  diagnostics: StandaloneBuildDiagnostics;
  classicScriptOutputBase: string;
  workers: readonly NormalizedWorkerDefinition[];
}>): Plugin {
  const emittedByOutputName = new Map<string, ImportScriptsAssetRecord>();
  const emittedByPortableOutputName = new Map<string, ImportScriptsAssetRecord>();
  const scannedSourceRoots = new Set<string>();
  const unsafeTopLevelImportScriptsByModule = new Map<string, ImportScriptsCall[]>();

  async function scanClassicAssetGraph(
    context: Pick<PluginContext, 'emitFile'>,
    { sourceRoot, specifier, importerSourcePath }: Readonly<{sourceRoot: string; specifier: string; importerSourcePath: string}>,
  ): Promise<void> {
    const pathname = validateRelativeClassicSpecifier(specifier, importerSourcePath);
    const sourcePath = path.resolve(sourceRoot, pathname);
    const realSourcePath = await fs.realpath(sourcePath);
    const outputFileName = outputNameForClassicSpecifier({
      specifier,
      classicScriptOutputBase,
      sourcePath: importerSourcePath,
    });
    const scanKey = `${realSourcePath}\0${outputFileName}\0${sourceRoot}`;
    if (scannedSourceRoots.has(scanKey)) return;
    scannedSourceRoots.add(scanKey);

    const source = await fs.readFile(realSourcePath, 'utf8');
    const existing = emittedByOutputName.get(outputFileName);
    if (existing && (existing.realSourcePath !== realSourcePath || existing.source !== source)) {
      throw new Error(
        `Conflicting importScripts() assets for ${outputFileName}: ${existing.realSourcePath} vs ${realSourcePath}`,
      );
    }
    const portableOutputKey = outputFileName.normalize('NFC').toLowerCase();
    const portableExisting = emittedByPortableOutputName.get(portableOutputKey);
    if (portableExisting && portableExisting.outputFileName !== outputFileName) {
      throw new Error(
        `Portable-filesystem importScripts() output collision: ${portableExisting.outputFileName} vs ${outputFileName}`,
      );
    }
    if (!existing) {
      context.emitFile({ type: 'asset', fileName: outputFileName, source });
      const record = { realSourcePath, source, outputFileName };
      emittedByOutputName.set(outputFileName, record);
      emittedByPortableOutputName.set(portableOutputKey, record);
      diagnostics.classicScriptAssets.push({ sourcePath: realSourcePath, outputFileName });
    }

    for (const call of findImportScriptsCalls(source, realSourcePath)) {
      if (call.unsupportedArguments.length > 0) {
        throw new Error(`Dynamic importScripts() URL is unsupported in ${realSourcePath}`);
      }
      for (const nestedSpecifier of call.staticSpecifiers) {
        await scanClassicAssetGraph(context, {
          sourceRoot,
          specifier: nestedSpecifier,
          importerSourcePath: realSourcePath,
        });
      }
    }
  }

  return {
    name: 'naidan-file-protocol-standalone-importscripts-assets',
    enforce: 'pre',
    async transform(code, id) {
      if (id.startsWith('\0') || !/\.[cm]?[jt]sx?(?:\?|$)/u.test(id)) return null;
      // Most application modules do not mention importScripts. Avoid constructing
      // a Babel AST unless the lexical token is present; the full parser remains
      // the source of truth for every candidate module.
      if (!code.includes('importScripts')) return null;
      const sourcePath = id.split('?', 1)[0];
      const calls = findImportScriptsCalls(code, sourcePath);
      if (calls.length === 0) return null;
      const unsafeCalls = calls.filter(call => call.topLevelUnsafeForUi);
      if (unsafeCalls.length > 0) unsafeTopLevelImportScriptsByModule.set(sourcePath, unsafeCalls);
      for (const call of calls) {
        if (call.unsupportedArguments.length > 0) {
          throw new Error(`Dynamic importScripts() URL is unsupported in ${sourcePath}`);
        }
        for (const specifier of call.staticSpecifiers) {
          await scanClassicAssetGraph(this, {
            sourceRoot: path.dirname(sourcePath),
            specifier,
            importerSourcePath: sourcePath,
          });
        }
      }
      return null;
    },
    generateBundle(_options, bundle) {
      if (unsafeTopLevelImportScriptsByModule.size === 0) return;
      const chunks = Object.values(bundle).filter(output => output.type === 'chunk');
      const byFileName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
      const workerEntryIds = new Set(workers.map(worker => path.resolve(worker.entry)));
      const uiRoots = chunks.filter(chunk => chunk.isEntry && !workerEntryIds.has(path.resolve(chunk.facadeModuleId || '')));
      const uiReachable = new Set<string>();
      const visit = (chunk: OutputChunk | undefined): void => {
        if (!chunk || uiReachable.has(chunk.fileName)) return;
        uiReachable.add(chunk.fileName);
        for (const imported of [...chunk.imports, ...chunk.dynamicImports]) visit(byFileName.get(imported));
      };
      for (const root of uiRoots) visit(root);
      for (const [moduleId, calls] of unsafeTopLevelImportScriptsByModule) {
        const owners = chunks.filter(chunk => Object.hasOwn(chunk.modules, moduleId));
        const uiOwners = owners.filter(chunk => uiReachable.has(chunk.fileName));
        if (uiOwners.length > 0) {
          throw new Error(
            `Top-level importScripts() in UI-reachable module ${moduleId} must be Worker-guarded or deferred; output owners: ${uiOwners.map(chunk => chunk.fileName).join(', ')}; calls: ${calls.map(call => `${call.start}-${call.end}`).join(', ')}`,
          );
        }
      }
    },
  };
}
