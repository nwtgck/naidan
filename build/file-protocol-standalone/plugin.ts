import { parse } from '@babel/parser';
import type { Binding, NodePath } from '@babel/traverse';
import type {
  CallExpression,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  ImportDeclaration,
  ImportExpression,
  Node,
  ObjectMethod,
  ObjectProperty,
  ReturnStatement,
} from '@babel/types';
import { transformAsync } from '@babel/core';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { URLSearchParams } from 'node:url';
import type { OutputAsset, OutputChunk, PluginContext } from 'rolldown';
import type { Plugin, PluginOption } from 'vite';
import {
  createFileProtocolStandaloneReleaseValidationPlugin,
  type FileProtocolStandaloneReleaseValidationOptions,
  type FileProtocolStandaloneSourceAuditSummary,
} from './release-validation.js';
import {
  assertMatchingSystemJsSourceMap,
  assertSupportedSystemJsRuntime,
} from './systemjs.js';
import {
  assertFileProtocolStandaloneHtmlAfterRewrite,
  assertFileProtocolStandaloneHtmlBeforeRewrite,
  resolveFileProtocolStandaloneHtmlReference,
} from './html-validation.js';
import { insertFileProtocolStandaloneBootstrap } from './html-output.js';
import {
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_GLOBAL_NAME,
} from '../../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol.js';
import {
  createFileProtocolStandaloneEntryBootstrapSource,
  createSystemJsFileScriptLoaderPatchSource,
  createSystemJsPhysicalLoadRecoverySource,
} from './file-protocol-startup-support.js';
import { createStandaloneWorkerRuntimeModuleSource } from './standalone-worker-runtime-source.js';
import {
  babelTransformDynamicImportPlugin,
  babelTransformModulesSystemjsPlugin,
  babelTraverse,
} from './babel-runtime.js';

export type NaidanStandaloneWorkerDefinition = Readonly<{
  name: string;
  entry: string;
  virtualId: string;
  defaultWorkerName?: string;
}>;

export type NaidanStandalonePolicies = Readonly<{
  allowExternalWasmAssets?: boolean;
  allowWorkerOnlyCssAssets?: boolean;
  allowRawWorkerConstructor?: (record: unknown) => boolean;
  allowViteWorkerQueryImport?: (record: unknown) => boolean;
  allowWorkerRealmGlobal?: (record: unknown) => boolean;
  uiOnlyGlobals?: readonly string[];
}>;

export type NaidanStandaloneSourceAudit =
  | Readonly<{mode: 'inline'}>
  | Readonly<{mode: 'external'; evidence: string}>;

type NaidanStandaloneReleaseValidationOptions = Omit<
  FileProtocolStandaloneReleaseValidationOptions,
  'workers' | 'runtimeFileNames' | 'sourceAudit'
>;

export type NaidanStandalonePluginOptions = Readonly<{
  workers: readonly NaidanStandaloneWorkerDefinition[];
  systemRuntimePath: string;
  systemRuntimeSourceMapPath?: string;
  diagnostics?: Record<string, unknown>;
  startupSlowNoticeDelayMs?: number;
  policies?: NaidanStandalonePolicies;
  sourceAudit?: NaidanStandaloneSourceAudit;
  releaseValidation?: NaidanStandaloneReleaseValidationOptions;
}>;

type AvailabilityState = 'available' | 'unavailable' | 'unknown';
type ImportScriptsCall = Readonly<{staticSpecifiers: string[]; unsupportedArguments: string[]; start: number | null; end: number | null; deferred: boolean; guarded: boolean; topLevelUnsafeForUi: boolean}>;
type GlobalObjectPropertyChain = Readonly<{root: string; segments: Array<Readonly<{name: string; optional: boolean}>>}>;
type WorkerRealmGlobalReference = Readonly<{name: string; accessKind: string; start: number; end: number; line: number | null; column: number | null}>;
type ViteWorkerQueryRecord = Readonly<{kind: string; specifier: string; flags: string[]; start: number; end: number; line: number | null; column: number | null}>;
type CommonJsRequireCall = Readonly<{kind: string; staticSpecifier: string | null; dynamic: boolean; start: number | null; end: number | null}>;

type WorkerConstructorKind = 'Worker' | 'SharedWorker';
type WorkerResolution = Readonly<{kind: WorkerConstructorKind; calleeForm: string}>;
type RawWorkerConstructorRecord = Readonly<{
  kind: WorkerConstructorKind;
  calleeForm: string;
  argumentKind: string;
  start: number;
  end: number;
  line: number | null;
  column: number | null;
  invocationKind?: 'Reflect.construct';
}>;
type BabelNodePath = NodePath<unknown>;
type SyntheticMemberPath = Readonly<{
  syntheticMember: true;
  objectPath: BabelNodePath;
  propertyName: string;
  seenBindings?: ReadonlySet<Binding>;
}>;
type WorkerValuePath = BabelNodePath | SyntheticMemberPath;
type WorkerValueCandidate = Readonly<{
  path: WorkerValuePath;
  seenBindings: ReadonlySet<Binding>;
}>;

type NormalizedWorkerDefinition = NaidanStandaloneWorkerDefinition & Readonly<{entry: string}>;
type ClassicScriptAssetDiagnostic = Readonly<{outputFileName: string; sourcePath?: string; kind?: string}>;
type VirtualModuleDiagnostic = Readonly<{workerName: string; virtualId: string; resolvedVirtualId: string; source: string}>;
type ChunkDiagnostic = {
  fileName: string;
  name: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  dynamicImports: string[];
  moduleIds: string[];
  beforeBytes: number;
  afterBytes?: number;
};
type HtmlDiagnostic = Readonly<{
  fileName: string;
  moduleEntryUrls: string[];
  systemRuntimeUrl: string;
  uiPreloadedCssFileNames: string[];
  uiPreloadedCssUrls: string[];
  startupScriptElementIds: string[];
}>;
type RawWorkerSourceCandidateDiagnostic = RawWorkerConstructorRecord & Readonly<{
  stage: 'source';
  moduleId: string;
  expressionSource: string;
}>;
type RawWorkerOutputDiagnostic = RawWorkerConstructorRecord & Readonly<{
  stage: 'output';
  moduleId: string;
  moduleIds: string[];
  outputFileName: string;
  expressionSource: string;
  generatedBootstrapWorker: boolean;
  allowed: boolean;
}>;
type ViteWorkerQueryDiagnostic = ViteWorkerQueryRecord & Readonly<{moduleId: string; allowed: boolean}>;
type WorkerRealmGlobalDiagnostic = WorkerRealmGlobalReference & Readonly<{
  moduleId: string;
  owners: string[];
  workerOwners: string[];
  included: boolean;
  workerReachable: boolean;
  allowed: boolean;
}>;
type WorkerCssDiagnostic = Readonly<{
  classificationBasis: 'source-module-graph';
  workerEntryModuleIds: string[];
  uiEntryModuleIds: string[];
  workerCss: string[];
  uiCss: string[];
  workerOnlyCss: string[];
  emittedCssAssets: string[];
}>;
type StandaloneBuildDiagnostics = Record<string, unknown> & {
  chunks: ChunkDiagnostic[];
  classicScriptAssets: ClassicScriptAssetDiagnostic[];
  virtualModules: VirtualModuleDiagnostic[];
  html: HtmlDiagnostic[];
  rawWorkerSourceCandidates: RawWorkerSourceCandidateDiagnostic[];
  rawWorkerConstructors: RawWorkerOutputDiagnostic[];
  viteWorkerQueryImports: ViteWorkerQueryDiagnostic[];
  workerRealmGlobalReferences: WorkerRealmGlobalDiagnostic[];
  workerCss?: WorkerCssDiagnostic;
  commonJsCompatibilityChecked?: boolean;
  modulePreloadDisabled?: boolean;
  cssCodeSplitEnabled?: boolean;
  lazyCssDependencyMetadataEnabled?: boolean;
  vitePreloadHelperRealmNeutral?: boolean;
  vitePreloadHelperSkipsDomOutsideUiRealm?: boolean;
  vitePreloadHelperOmitsFileCrossorigin?: boolean;
};

type ImportScriptsAssetRecord = Readonly<{realSourcePath: string; source: string; outputFileName: string}>;
type WorkerEntryRecord = NormalizedWorkerDefinition & Readonly<{referenceId: string; resolvedVirtualId: string}>;
type ExternalModuleScript = Readonly<{tag: string; source: string}>;

function isWorkerConstructorKind(value: string): value is WorkerConstructorKind {
  return value === 'Worker' || value === 'SharedWorker';
}

function isSyntheticMemberPath(value: WorkerValuePath): value is SyntheticMemberPath {
  return 'syntheticMember' in value && value.syntheticMember === true;
}

function isBabelNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string';
}

function isBabelNodeType<T extends Node['type']>(
  node: Node | null | undefined,
  type: T,
): node is Extract<Node, {type: T}> {
  return node?.type === String(type);
}

function invertAvailabilityState(state: AvailabilityState): AvailabilityState {
  switch (state) {
  case 'available': return 'unavailable';
  case 'unavailable': return 'available';
  case 'unknown': return 'unknown';
  default: {
    const exhaustive: never = state;
    throw new Error(`Unhandled availability state: ${exhaustive}`);
  }
  }
}

function mergeAvailabilityAnd(left: AvailabilityState, right: AvailabilityState): AvailabilityState {
  if (left === right) return left;
  switch (left) {
  case 'unknown': return right;
  case 'available':
  case 'unavailable':
    break;
  default: {
    const exhaustive: never = left;
    throw new Error(`Unhandled availability state: ${exhaustive}`);
  }
  }
  switch (right) {
  case 'unknown': return left;
  case 'available':
  case 'unavailable': return 'unknown';
  default: {
    const exhaustive: never = right;
    throw new Error(`Unhandled availability state: ${exhaustive}`);
  }
  }
}

function isOutputChunk(output: {readonly type: string}): output is OutputChunk {
  return output.type === 'chunk';
}

const DEFAULT_RUNTIME_PUBLIC_ID = 'virtual:naidan-standalone-worker-runtime';
const DEFAULT_RUNTIME_RESOLVED_ID = '\0naidan:standalone-worker-runtime';
const INIT_MESSAGE_TYPE = '__naidanStandaloneWorkerInitV1';
const READY_MESSAGE_TYPE = '__naidanStandaloneWorkerReadyV1';
const ERROR_MESSAGE_TYPE = '__naidanStandaloneWorkerErrorV1';

const DEFAULT_UI_ONLY_GLOBALS = Object.freeze([
  'CSSStyleSheet',
  'DOMParser',
  'Document',
  'Element',
  'HTMLElement',
  'IntersectionObserver',
  'MutationObserver',
  'Node',
  'ResizeObserver',
  'alert',
  'confirm',
  'customElements',
  'document',
  'getComputedStyle',
  'localStorage',
  'matchMedia',
  'prompt',
  'sessionStorage',
  'window',
]);


function slash(value: string): string {
  return value.split(path.sep).join('/');
}

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

function guardExpressionUiGlobalState(test: Node | null | undefined, name: string, safeGuardIdentifiers: ReadonlySet<string> = new Set()): AvailabilityState {
  if (!test) return 'unknown';
  if (isBabelNodeType(test, 'Identifier')) {
    if (safeGuardIdentifiers.has(`${name}:available:${test.name}`)) return 'available';
    if (safeGuardIdentifiers.has(`${name}:unavailable:${test.name}`)) return 'unavailable';
    return 'unknown';
  }
  const literalValue = (node: Node | null | undefined): string | boolean | null | undefined | symbol => {
    if (isBabelNodeType(node, 'StringLiteral') || node?.type === 'BooleanLiteral') return node.value;
    if (isBabelNodeType(node, 'NullLiteral')) return null;
    if (node?.type === 'Identifier' && node.name === 'undefined') return undefined;
    return Symbol.for('not-a-literal');
  };
  const isTypeofTarget = (node: Node | null | undefined): boolean => node?.type === 'UnaryExpression'
    && node.operator === 'typeof'
    && node.argument?.type === 'Identifier'
    && node.argument.name === name;
  const isGlobalObjectTarget = (node: Node | null | undefined): boolean => {
    if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') return false;
    return node.object?.type === 'Identifier'
      && ['globalThis', 'self'].includes(node.object.name)
      && staticMemberPropertyName(node) === name;
  };
  if (test.type === 'UnaryExpression' && test.operator === '!') {
    const nested = guardExpressionUiGlobalState(test.argument, name, safeGuardIdentifiers);
    return invertAvailabilityState(nested);
  }
  if (isGlobalObjectTarget(test)) return 'available';
  if (test.type === 'CallExpression'
    && test.callee?.type === 'Identifier'
    && test.callee.name === 'Boolean'
    && test.arguments.length === 1
    && isGlobalObjectTarget(test.arguments[0])) return 'available';
  if (isBabelNodeType(test, 'LogicalExpression')) {
    const left = guardExpressionUiGlobalState(test.left, name, safeGuardIdentifiers);
    const right = guardExpressionUiGlobalState(test.right, name, safeGuardIdentifiers);
    switch (test.operator) {
    case '&&':
      return mergeAvailabilityAnd(left, right);
    case '||':
      return left === right ? left : 'unknown';
    case '??':
      return 'unknown';
    default:
      return 'unknown';
    }
  }
  if (!isBabelNodeType(test, 'BinaryExpression')) return 'unknown';
  switch (test.operator) {
  case 'in':
    return literalValue(test.left) === name
      && test.right?.type === 'Identifier'
      && ['globalThis', 'self'].includes(test.right.name)
      ? 'available'
      : 'unknown';
  case '==':
  case '===':
  case '!=':
  case '!==':
    break;
  default:
    return 'unknown';
  }
  const leftLiteral = literalValue(test.left);
  const rightLiteral = literalValue(test.right);
  if (isTypeofTarget(test.left)) {
    if (['!=', '!=='].includes(test.operator) && rightLiteral === 'undefined') return 'available';
    if (['==', '==='].includes(test.operator) && typeof rightLiteral === 'string' && ['object', 'function'].includes(rightLiteral)) return 'available';
    if (['==', '==='].includes(test.operator) && rightLiteral === 'undefined') return 'unavailable';
    if (['!=', '!=='].includes(test.operator) && typeof rightLiteral === 'string' && ['object', 'function'].includes(rightLiteral)) return 'unavailable';
  }
  if (isTypeofTarget(test.right)) {
    if (['!=', '!=='].includes(test.operator) && leftLiteral === 'undefined') return 'available';
    if (['==', '==='].includes(test.operator) && typeof leftLiteral === 'string' && ['object', 'function'].includes(leftLiteral)) return 'available';
    if (['==', '==='].includes(test.operator) && leftLiteral === 'undefined') return 'unavailable';
    if (['!=', '!=='].includes(test.operator) && typeof leftLiteral === 'string' && ['object', 'function'].includes(leftLiteral)) return 'unavailable';
  }
  if (isGlobalObjectTarget(test.left) && (rightLiteral === undefined || rightLiteral === null)) {
    return ['!=', '!=='].includes(test.operator) ? 'available' : 'unavailable';
  }
  if (isGlobalObjectTarget(test.right) && (leftLiteral === undefined || leftLiteral === null)) {
    return ['!=', '!=='].includes(test.operator) ? 'available' : 'unavailable';
  }
  return 'unknown';
}

function guardExpressionMentionsUiGlobal(test: Node | null | undefined, name: string, _code: string, safeGuardIdentifiers: ReadonlySet<string> = new Set()): boolean {
  return guardExpressionUiGlobalState(test, name, safeGuardIdentifiers) === 'available';
}

function isDeferredFromModuleEvaluation(referencePath: NodePath): boolean {
  let current = referencePath;
  while (current.parentPath) {
    current = current.parentPath;
    if (current.isFunction()) return true;
    if ((current.isClassProperty?.() || current.isClassPrivateProperty?.() || current.isClassAccessorProperty?.())
      && current.node.static !== true) return true;
  }
  return false;
}

function isTypeOnlyReference(referencePath: NodePath): boolean {
  let current = referencePath;
  while (current.parentPath) {
    const parent = current.parentPath;
    if (parent.node?.type?.startsWith('TS')) {
      const runtimeExpressionWrapper = [
        'TSAsExpression',
        'TSInstantiationExpression',
        'TSNonNullExpression',
        'TSSatisfiesExpression',
        'TSTypeAssertion',
      ].includes(parent.node.type) && current.key === 'expression';
      if (!runtimeExpressionWrapper) return true;
    }
    current = parent;
  }
  return false;
}

function pathIsInsideGuardedBranch(referencePath: NodePath, name: string, code: string, safeGuardIdentifiers: ReadonlySet<string>): boolean {
  let current = referencePath;
  while (current.parentPath) {
    const parent = current.parentPath;
    if (parent.isIfStatement() && current.key === 'consequent'
      && guardExpressionMentionsUiGlobal(parent.node.test, name, code, safeGuardIdentifiers)) return true;
    if (parent.isIfStatement() && current.key === 'alternate'
      && guardExpressionUiGlobalState(parent.node.test, name, safeGuardIdentifiers) === 'unavailable') return true;
    if (parent.isLogicalExpression({ operator: '&&' }) && current.key === 'right'
      && guardExpressionMentionsUiGlobal(parent.node.left, name, code, safeGuardIdentifiers)) return true;
    if (parent.isLogicalExpression({ operator: '||' }) && current.key === 'right'
      && guardExpressionUiGlobalState(parent.node.left, name, safeGuardIdentifiers) === 'unavailable') return true;
    if (parent.isConditionalExpression() && current.key === 'consequent'
      && guardExpressionMentionsUiGlobal(parent.node.test, name, code, safeGuardIdentifiers)) return true;
    if (parent.isConditionalExpression() && current.key === 'alternate'
      && guardExpressionUiGlobalState(parent.node.test, name, safeGuardIdentifiers) === 'unavailable') return true;
    current = parent;
  }
  return false;
}

function staticMemberPropertyName(node: Node | null | undefined): string | null {
  if (!node) return null;
  if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.type === 'MemberExpression' && node.computed && node.property.type === 'StringLiteral') {
    return typeof node.property.value === 'string' ? node.property.value : null;
  }
  return null;
}

function globalObjectPropertyChain(node: Node | null | undefined): GlobalObjectPropertyChain | null {
  const segments: Array<{name: string; optional: boolean}> = [];
  let current = node;
  while (current?.type === 'MemberExpression' || current?.type === 'OptionalMemberExpression') {
    const propertyName = staticMemberPropertyName(current);
    if (!propertyName) return null;
    segments.unshift({ name: propertyName, optional: current.optional === true });
    current = current.object;
  }
  if (current?.type !== 'Identifier' || !['globalThis', 'self'].includes(current.name)) return null;
  return { root: current.name, segments };
}

function isOutermostMemberPath(referencePath: NodePath): boolean {
  const parent = referencePath.parentPath;
  return !(parent?.isMemberExpression?.() || parent?.isOptionalMemberExpression?.())
    || parent.node.object !== referencePath.node;
}

function unwrapTypeScriptExpression(node: Node | null | undefined): Node | null | undefined {
  let current = node;
  for (;;) {
    switch (current?.type) {
    case 'TSAsExpression':
    case 'TSInstantiationExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'TSTypeAssertion':
      current = current.expression;
      continue;
    default:
      return current;
    }
  }
}

function aliasAvailabilityState(test: Node | null | undefined, aliasName: string): AvailabilityState {
  if (!test) return 'unknown';
  if (isBabelNodeType(test, 'Identifier') && test.name === aliasName) return 'available';
  if (test.type === 'UnaryExpression' && test.operator === '!') {
    const nested = aliasAvailabilityState(test.argument, aliasName);
    return invertAvailabilityState(nested);
  }
  if (test.type === 'CallExpression'
    && test.callee?.type === 'Identifier'
    && test.callee.name === 'Boolean'
    && test.arguments.length === 1
    && test.arguments[0]?.type === 'Identifier'
    && test.arguments[0].name === aliasName) return 'available';
  if (isBabelNodeType(test, 'LogicalExpression')) {
    const left = aliasAvailabilityState(test.left, aliasName);
    const right = aliasAvailabilityState(test.right, aliasName);
    switch (test.operator) {
    case '&&':
      return mergeAvailabilityAnd(left, right);
    case '||':
      return left === right ? left : 'unknown';
    case '??':
      return 'unknown';
    default:
      return 'unknown';
    }
  }
  if (!isBabelNodeType(test, 'BinaryExpression') || !['==', '===', '!=', '!=='].includes(test.operator)) {
    return 'unknown';
  }
  const isAlias = (node: Node | null | undefined): boolean => node?.type === 'Identifier' && node.name === aliasName;
  const isEmpty = (node: Node | null | undefined): boolean => isBabelNodeType(node, 'NullLiteral')
    || node?.type === 'Identifier' && node.name === 'undefined';
  if (!(isAlias(test.left) && isEmpty(test.right)) && !(isAlias(test.right) && isEmpty(test.left))) {
    return 'unknown';
  }
  return ['!=', '!=='].includes(test.operator) ? 'available' : 'unavailable';
}

function pathIsInsideAliasGuardedBranch(referencePath: NodePath, aliasName: string): boolean {
  let current = referencePath;
  while (current.parentPath) {
    const parent = current.parentPath;
    if (parent.isIfStatement() && current.key === 'consequent'
      && aliasAvailabilityState(parent.node.test, aliasName) === 'available') return true;
    if (parent.isIfStatement() && current.key === 'alternate'
      && aliasAvailabilityState(parent.node.test, aliasName) === 'unavailable') return true;
    if (parent.isLogicalExpression({ operator: '&&' }) && current.key === 'right'
      && aliasAvailabilityState(parent.node.left, aliasName) === 'available') return true;
    if (parent.isLogicalExpression({ operator: '||' }) && current.key === 'right'
      && aliasAvailabilityState(parent.node.left, aliasName) === 'unavailable') return true;
    if (parent.isConditionalExpression() && current.key === 'consequent'
      && aliasAvailabilityState(parent.node.test, aliasName) === 'available') return true;
    if (parent.isConditionalExpression() && current.key === 'alternate'
      && aliasAvailabilityState(parent.node.test, aliasName) === 'unavailable') return true;
    current = parent;
  }
  return false;
}

function findWorkerRealmGlobalReferences(
  code: string,
  id = '<unknown>',
  { uiOnlyGlobals = DEFAULT_UI_ONLY_GLOBALS }: Readonly<{uiOnlyGlobals?: readonly string[]}> = {},
): WorkerRealmGlobalReference[] {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    sourceFilename: id,
    allowAwaitOutsideFunction: true,
    plugins: ['dynamicImport', 'importMeta', 'topLevelAwait', 'typescript', 'jsx'],
  });
  const targetGlobals = new Set<string>(uiOnlyGlobals);
  const safeGuardIdentifiers = new Set<string>();
  const globalObjectAliases = new Map<string, string>();
  for (const statement of ast.program?.body ?? []) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    for (const declaration of statement.declarations) {
      if (!declaration.init) continue;
      if (isBabelNodeType(declaration.id, 'Identifier')) {
        for (const name of targetGlobals) {
          const state = guardExpressionUiGlobalState(declaration.init, name);
          switch (state) {
          case 'available':
          case 'unavailable':
            safeGuardIdentifiers.add(`${name}:${state}:${declaration.id.name}`);
            break;
          case 'unknown':
            break;
          default: {
            const exhaustive: never = state;
            throw new Error(`Unhandled availability state: ${exhaustive}`);
          }
          }
        }
        const initializer = unwrapTypeScriptExpression(declaration.init);
        const chain = globalObjectPropertyChain(initializer);
        if (chain?.segments.length === 1 && targetGlobals.has(chain.segments[0].name)) {
          globalObjectAliases.set(declaration.id.name, chain.segments[0].name);
        } else if (isBabelNodeType(initializer, 'Identifier')) {
          const aliasedGlobal = globalObjectAliases.get(initializer.name);
          if (aliasedGlobal !== undefined) globalObjectAliases.set(declaration.id.name, aliasedGlobal);
        }
      } else if (declaration.id?.type === 'ObjectPattern'
        && declaration.init.type === 'Identifier'
        && ['globalThis', 'self'].includes(declaration.init.name)) {
        for (const property of declaration.id.properties) {
          if (!isBabelNodeType(property, 'ObjectProperty') || property.computed) continue;
          const targetName = isBabelNodeType(property.key, 'Identifier')
            ? property.key.name
            : isBabelNodeType(property.key, 'StringLiteral')
              ? property.key.value
              : null;
          const aliasName = isBabelNodeType(property.value, 'Identifier') ? property.value.name : null;
          if (targetName !== null && targetGlobals.has(targetName) && aliasName) globalObjectAliases.set(aliasName, targetName);
        }
      }
    }
  }

  const references: WorkerRealmGlobalReference[] = [];
  const seen = new Set<string>();
  function record(node: Node, name: string, accessKind: string): void {
    const key = `${node.start}:${node.end}:${name}:${accessKind}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({
      name,
      accessKind,
      start: node.start ?? 0,
      end: node.end ?? 0,
      line: node.loc?.start.line ?? null,
      column: node.loc?.start.column ?? null,
    });
  }

  babelTraverse(ast, {
    Identifier(referencePath) {
      const { name } = referencePath.node;
      const aliasedGlobal = globalObjectAliases.get(name);
      if (aliasedGlobal) {
        const binding = referencePath.scope.getBinding(name);
        const isTopLevelConstAlias = binding?.kind === 'const' && binding.scope.path.isProgram();
        if (isTopLevelConstAlias && referencePath.isReferencedIdentifier()
          && !isTypeOnlyReference(referencePath)
          && !isDeferredFromModuleEvaluation(referencePath)
          && !pathIsInsideAliasGuardedBranch(referencePath, name)) {
          const parent = referencePath.parentPath;
          const memberDereference = (parent?.isMemberExpression?.() || parent?.isOptionalMemberExpression?.())
            && parent.node.object === referencePath.node
            && parent.node.optional !== true;
          const directInvocation = (
            ((parent?.isCallExpression?.() || parent?.isOptionalCallExpression?.() || parent?.isNewExpression?.())
              && parent.node.callee === referencePath.node
              && (!parent.isOptionalCallExpression?.() || parent.node.optional !== true))
            || (parent?.isTaggedTemplateExpression?.() && parent.node.tag === referencePath.node)
          );
          const destructured = parent?.isVariableDeclarator?.()
            && parent.node.init === referencePath.node
            && ['ObjectPattern', 'ArrayPattern'].includes(parent.node.id?.type);
          const spreadOutsideObject = parent?.isSpreadElement?.()
            && !parent.parentPath?.isObjectExpression?.();
          const forOfRight = parent?.isForOfStatement?.() && parent.node.right === referencePath.node;
          if (memberDereference || directInvocation || destructured || spreadOutsideObject || forOfRight) {
            record(referencePath.node, aliasedGlobal, 'global-object-alias-dereference');
          }
        }
      }
      if (!targetGlobals.has(name) || !referencePath.isReferencedIdentifier()) return;
      if (isTypeOnlyReference(referencePath)) return;
      if (referencePath.scope.getBinding(name)) return;
      if (isDeferredFromModuleEvaluation(referencePath)) return;
      if (referencePath.parentPath?.isUnaryExpression({ operator: 'typeof' })) return;
      if (pathIsInsideGuardedBranch(referencePath, name, code, safeGuardIdentifiers)) return;
      record(referencePath.node, name, 'unbound-identifier');
    },
    'MemberExpression|OptionalMemberExpression'(referencePath) {
      if (!isOutermostMemberPath(referencePath) || isDeferredFromModuleEvaluation(referencePath)) return;
      const chain = globalObjectPropertyChain(referencePath.node);
      if (!chain || chain.segments.length === 0) return;
      const [target, firstDereference] = chain.segments;
      if (!targetGlobals.has(target.name)) return;
      const parent = referencePath.parentPath;
      const directInvocation = chain.segments.length === 1
        && ((parent?.isCallExpression?.() || parent?.isOptionalCallExpression?.() || parent?.isNewExpression?.())
          && parent.node.callee === referencePath.node);
      const immediatelyDereferenced = chain.segments.length >= 2 && firstDereference?.optional !== true;
      if (!directInvocation && !immediatelyDereferenced) return;
      if (parent?.isOptionalCallExpression?.() && parent.node.optional === true) return;
      if (pathIsInsideGuardedBranch(referencePath, target.name, code, safeGuardIdentifiers)) return;
      record(referencePath.node, target.name, directInvocation ? 'global-object-call' : 'global-object-dereference');
    },
  });
  return references.sort((left, right) => left.start - right.start || left.name.localeCompare(right.name));
}

function memberExpressionName(node: Node | null | undefined): string | null {
  if (!node || node.type !== 'MemberExpression' || node.computed) return null;
  if (node.object?.type !== 'Identifier' || node.property?.type !== 'Identifier') return null;
  return `${node.object.name}.${node.property.name}`;
}

function isImportMetaUrl(node: Node | null | undefined): boolean {
  return node?.type === 'MemberExpression'
    && !node.computed
    && node.object?.type === 'MetaProperty'
    && node.object.meta?.name === 'import'
    && node.object.property?.name === 'meta'
    && node.property?.type === 'Identifier'
    && node.property.name === 'url';
}

function classifyRawWorkerArgument(argument: Node | null | undefined): string {
  if (!argument) return 'missing';
  if (isBabelNodeType(argument, 'StringLiteral') || argument.type === 'TemplateLiteral' && argument.expressions.length === 0) {
    return 'static-url';
  }
  if (argument.type === 'NewExpression'
    && argument.callee?.type === 'Identifier'
    && argument.callee.name === 'URL'
    && isImportMetaUrl(argument.arguments?.[1])) {
    return 'vite-new-url-import-meta';
  }
  if (argument.type === 'CallExpression'
    && memberExpressionName(argument.callee) === 'URL.createObjectURL'
    && argument.arguments?.[0]?.type === 'NewExpression'
    && argument.arguments[0].callee?.type === 'Identifier'
    && argument.arguments[0].callee.name === 'Blob') {
    return 'inline-blob-object-url';
  }
  return argument.type;
}

function findRawWorkerConstructors(code: string, id = '<unknown>'): RawWorkerConstructorRecord[] {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    sourceFilename: id,
    allowAwaitOutsideFunction: true,
    // Rolldown can expose intermediate entry-export shapes to generateBundle.
    // This analysis only needs constructor expressions, so unresolved exports must
    // not turn a compatibility policy into a parser failure. Final output shape
    // validation remains strict elsewhere.
    allowUndeclaredExports: true,
    plugins: ['dynamicImport', 'importMeta', 'topLevelAwait', 'typescript', 'jsx'],
  });
  const constructors: RawWorkerConstructorRecord[] = [];
  const recorded = new Set<string>();

  function unwrapPath(valuePath: BabelNodePath | null | undefined): BabelNodePath | null | undefined {
    let current = valuePath;
    while (current && [
      'TSAsExpression',
      'TSInstantiationExpression',
      'TSNonNullExpression',
      'TSSatisfiesExpression',
      'TSTypeAssertion',
      'ParenthesizedExpression',
    ].includes(isBabelNode(current.node) ? current.node.type : '')) {
      current = current.get('expression');
    }
    return current;
  }

  function unboundGlobalIdentifier(identifierPath: BabelNodePath | null | undefined, names: readonly string[]): boolean {
    return Boolean(identifierPath?.isIdentifier?.()
      && names.includes(identifierPath.node.name)
      && !identifierPath.scope.getBinding(identifierPath.node.name));
  }

  function staticObjectPropertyName(node: ObjectProperty | ObjectMethod | null | undefined): string | null {
    if (!node) return null;
    if (!node.computed && node.key?.type === 'Identifier') return node.key.name;
    if (isBabelNodeType(node.key, 'StringLiteral')) {
      return typeof node.key.value === 'string' ? node.key.value : null;
    }
    return null;
  }

  function candidateBindingValues(binding: Binding | undefined, seenBindings: ReadonlySet<Binding>): WorkerValueCandidate[] {
    if (!binding || seenBindings.has(binding)) return [];
    const nextSeen = new Set(seenBindings).add(binding);
    const values: WorkerValueCandidate[] = [];
    const bindingPath = binding.path;
    if (bindingPath.isVariableDeclarator?.()) {
      const init = bindingPath.get('init');
      const idPath = bindingPath.get('id');
      if (idPath.isIdentifier?.()) {
        if (init?.node) values.push({ path: init, seenBindings: nextSeen });
      } else if (idPath.isObjectPattern?.() && init?.node) {
        for (const property of idPath.get('properties')) {
          if (!property.isObjectProperty?.()) continue;
          const value = property.get('value');
          if (!value.isIdentifier?.({ name: binding.identifier.name })) continue;
          const propertyName = staticObjectPropertyName(property.node);
          if (propertyName) {
            values.push({ path: { syntheticMember: true, objectPath: init, propertyName }, seenBindings: nextSeen });
          }
        }
      } else if (idPath.isArrayPattern?.() && init?.isArrayExpression?.()) {
        const index = idPath.get('elements').findIndex(element => element?.isIdentifier?.({ name: binding.identifier.name }));
        const element = index >= 0 ? init.get('elements')[index] : null;
        if (element?.node) values.push({ path: element, seenBindings: nextSeen });
      }
    } else if (bindingPath.isIdentifier?.()) {
      const parent = bindingPath.parentPath;
      if (parent?.isVariableDeclarator?.() && parent.node.id === bindingPath.node) {
        const init = parent.get('init');
        if (init?.node) values.push({ path: init, seenBindings: nextSeen });
      } else if (parent?.isObjectProperty?.() && parent.parentPath?.isObjectPattern?.()) {
        const declaration = parent.parentPath.parentPath;
        if (declaration?.isVariableDeclarator?.()) {
          const init = declaration.get('init');
          const propertyName = staticObjectPropertyName(parent.node);
          if (init?.node && propertyName) {
            values.push({ path: { syntheticMember: true, objectPath: init, propertyName }, seenBindings: nextSeen });
          }
        }
      } else if (parent?.isArrayPattern?.()) {
        const declaration = parent.parentPath;
        if (declaration?.isVariableDeclarator?.()) {
          const index = parent.get('elements').findIndex(element => element.node === bindingPath.node);
          const init = declaration.get('init');
          if (index >= 0 && init?.isArrayExpression?.()) {
            const element = init.get('elements')[index];
            if (element?.node) values.push({ path: element, seenBindings: nextSeen });
          }
        }
      }
    }
    for (const violation of binding.constantViolations ?? []) {
      if (violation.isAssignmentExpression?.()) {
        const left = violation.get('left');
        const right = violation.get('right');
        if (left.isIdentifier?.({ name: binding.identifier.name })) {
          values.push({ path: right, seenBindings: nextSeen });
        } else if (left.isObjectPattern?.()) {
          for (const property of left.get('properties')) {
            if (!property.isObjectProperty?.()) continue;
            const value = property.get('value');
            if (!value.isIdentifier?.({ name: binding.identifier.name })) continue;
            const propertyName = staticObjectPropertyName(property.node);
            if (propertyName) {
              values.push({ path: { syntheticMember: true, objectPath: right, propertyName }, seenBindings: nextSeen });
            }
          }
        } else if (left.isArrayPattern?.() && right.isArrayExpression?.()) {
          const index = left.get('elements').findIndex(element => element?.isIdentifier?.({ name: binding.identifier.name }));
          const element = index >= 0 ? right.get('elements')[index] : null;
          if (element?.node) values.push({ path: element, seenBindings: nextSeen });
        }
      }
    }
    return values;
  }

  function resolveGlobalObject(valuePath: WorkerValuePath | null | undefined, seenBindings: ReadonlySet<Binding> = new Set<Binding>()): string[] {
    if (!valuePath) return [];
    if (isSyntheticMemberPath(valuePath)) return [];
    const current = unwrapPath(valuePath);
    if (!current?.node) return [];
    if (current.isIdentifier()) {
      if (unboundGlobalIdentifier(current, ['globalThis', 'self', 'window'])) return [current.node.name];
      const binding = current.scope.getBinding(current.node.name);
      return candidateBindingValues(binding, seenBindings)
        .flatMap(candidate => resolveGlobalObject(candidate.path, candidate.seenBindings));
    }
    if (current.isSequenceExpression?.()) {
      const expressions = current.get('expressions');
      return resolveGlobalObject(expressions.at(-1), seenBindings);
    }
    if (current.isConditionalExpression?.()) {
      return [
        ...resolveGlobalObject(current.get('consequent'), seenBindings),
        ...resolveGlobalObject(current.get('alternate'), seenBindings),
      ];
    }
    if (current.isLogicalExpression?.()) {
      return [
        ...resolveGlobalObject(current.get('left'), seenBindings),
        ...resolveGlobalObject(current.get('right'), seenBindings),
      ];
    }
    if (current.isAssignmentExpression?.()) return resolveGlobalObject(current.get('right'), seenBindings);
    return [];
  }

  function resolveObjectProperty(objectPath: BabelNodePath | null | undefined, propertyName: string, seenBindings: ReadonlySet<Binding>): WorkerResolution[] {
    if (!objectPath) return [];
    const current = unwrapPath(objectPath);
    if (!current?.node) return [];
    if (current.isObjectExpression?.()) {
      const results: WorkerResolution[] = [];
      for (const propertyPath of current.get('properties')) {
        if (!propertyPath.isObjectProperty?.() && !propertyPath.isObjectMethod?.()) continue;
        if (staticObjectPropertyName(propertyPath.node) !== propertyName) continue;
        if (propertyPath.isObjectProperty()) {
          results.push(...resolveWorkerValue(propertyPath.get('value'), seenBindings));
        }
      }
      return results;
    }
    if (current.isIdentifier?.()) {
      const binding = current.scope.getBinding(current.node.name);
      return candidateBindingValues(binding, seenBindings)
        .flatMap(candidate => {
          if (isSyntheticMemberPath(candidate.path)) return [];
          return resolveObjectProperty(candidate.path, propertyName, candidate.seenBindings);
        });
    }
    if (current.isAssignmentExpression?.()) return resolveObjectProperty(current.get('right'), propertyName, seenBindings);
    if (current.isSequenceExpression?.()) {
      const expressions = current.get('expressions');
      return resolveObjectProperty(expressions.at(-1), propertyName, seenBindings);
    }
    if (current.isConditionalExpression?.() || current.isLogicalExpression?.()) {
      const first = current.isConditionalExpression() ? current.get('consequent') : current.get('left');
      const second = current.isConditionalExpression() ? current.get('alternate') : current.get('right');
      return [
        ...resolveObjectProperty(first, propertyName, seenBindings),
        ...resolveObjectProperty(second, propertyName, seenBindings),
      ];
    }
    return [];
  }

  function functionReturnPaths(functionPath: BabelNodePath | null | undefined): BabelNodePath[] {
    if (!functionPath?.node) return [];
    if (!functionPath.isFunctionDeclaration()
      && !functionPath.isFunctionExpression()
      && !functionPath.isArrowFunctionExpression()) return [];
    if (functionPath.node.params.length > 0) return [];
    const body = functionPath.get('body');
    if (Array.isArray(body)) return [];
    if (functionPath.isArrowFunctionExpression() && !body.isBlockStatement()) return [body];
    if (!body.isBlockStatement()) return [];
    const returns: BabelNodePath[] = [];
    body.traverse({
      Function(innerPath: BabelNodePath) {
        if (innerPath !== functionPath) innerPath.skip();
      },
      ReturnStatement(returnPath: NodePath<ReturnStatement>) {
        const argument = returnPath.get('argument');
        if (argument?.node) returns.push(argument);
      },
    });
    return returns;
  }

  function resolveFactoryReturns(calleePath: BabelNodePath | null | undefined, seenBindings: ReadonlySet<Binding>): WorkerResolution[] {
    const current = unwrapPath(calleePath);
    if (!current?.node) return [];
    if (current.isFunctionExpression?.() || current.isArrowFunctionExpression?.()) {
      return functionReturnPaths(current).flatMap(returnPath => resolveWorkerValue(returnPath, seenBindings));
    }
    if (current.isIdentifier?.()) {
      const binding = current.scope.getBinding(current.node.name);
      if (!binding || seenBindings.has(binding)) return [];
      const nextSeen = new Set(seenBindings).add(binding);
      if (binding.path.isFunctionDeclaration?.()) {
        return functionReturnPaths(binding.path).flatMap(returnPath => resolveWorkerValue(returnPath, nextSeen));
      }
      return candidateBindingValues(binding, seenBindings)
        .flatMap(candidate => isSyntheticMemberPath(candidate.path)
          ? []
          : resolveFactoryReturns(candidate.path, candidate.seenBindings));
    }
    return [];
  }

  function resolveWorkerValue(valuePath: WorkerValuePath | null | undefined, seenBindings: ReadonlySet<Binding> = new Set<Binding>()): WorkerResolution[] {
    if (!valuePath) return [];
    if (isSyntheticMemberPath(valuePath)) {
      const globalForms = resolveGlobalObject(valuePath.objectPath, valuePath.seenBindings ?? seenBindings);
      if (isWorkerConstructorKind(valuePath.propertyName) && globalForms.length > 0) {
        return [{ kind: valuePath.propertyName, calleeForm: 'destructured-global' }];
      }
      return resolveObjectProperty(
        valuePath.objectPath,
        valuePath.propertyName,
        valuePath.seenBindings ?? seenBindings,
      );
    }
    const current = unwrapPath(valuePath);
    if (!current?.node) return [];
    if (current.isIdentifier?.()) {
      if (isWorkerConstructorKind(current.node.name) && unboundGlobalIdentifier(current, ['Worker', 'SharedWorker'])) {
        return [{ kind: current.node.name, calleeForm: 'direct' }];
      }
      const binding = current.scope.getBinding(current.node.name);
      return candidateBindingValues(binding, seenBindings)
        .flatMap(candidate => resolveWorkerValue(candidate.path, candidate.seenBindings))
        .map(result => ({ ...result, calleeForm: result.calleeForm === 'direct' ? 'alias' : result.calleeForm }));
    }
    if (current.isMemberExpression?.() || current.isOptionalMemberExpression?.()) {
      const propertyName = staticMemberPropertyName(current.node);
      if (!propertyName) return [];
      if (isWorkerConstructorKind(propertyName)) {
        const objectPath = current.get('object');
        if (Array.isArray(objectPath)) return [];
        const globals = resolveGlobalObject(objectPath, seenBindings);
        if (globals.length > 0) {
          const directForm = objectPath.isIdentifier() && globals.includes(objectPath.node.name)
            ? objectPath.node.name
            : 'global-object-alias';
          return [{ kind: propertyName, calleeForm: directForm }];
        }
      }
      const objectPath = current.get('object');
      if (Array.isArray(objectPath)) return [];
      return resolveObjectProperty(objectPath, propertyName, seenBindings)
        .map(result => ({ ...result, calleeForm: 'object-property-alias' }));
    }
    if (current.isAssignmentExpression?.()) return resolveWorkerValue(current.get('right'), seenBindings);
    if (current.isSequenceExpression?.()) {
      const expressions = current.get('expressions');
      return resolveWorkerValue(expressions.at(-1), seenBindings);
    }
    if (current.isConditionalExpression?.()) {
      return [
        ...resolveWorkerValue(current.get('consequent'), seenBindings),
        ...resolveWorkerValue(current.get('alternate'), seenBindings),
      ];
    }
    if (current.isLogicalExpression?.()) {
      return [
        ...resolveWorkerValue(current.get('left'), seenBindings),
        ...resolveWorkerValue(current.get('right'), seenBindings),
      ];
    }
    if (current.isCallExpression?.()) {
      const callee = current.get('callee');
      if ((callee.isMemberExpression?.() || callee.isOptionalMemberExpression?.())
        && staticMemberPropertyName(callee.node) === 'bind') {
        const objectPath = callee.get('object');
        if (Array.isArray(objectPath)) return [];
        return resolveWorkerValue(objectPath, seenBindings)
          .map(result => ({ ...result, calleeForm: 'bound-alias' }));
      }
      return resolveFactoryReturns(callee, seenBindings)
        .map(result => ({ ...result, calleeForm: 'factory-alias' }));
    }
    return [];
  }

  function record(
    node: Node,
    resolution: WorkerResolution,
    argumentPath: BabelNodePath | Node | null | undefined,
    extra: Pick<RawWorkerConstructorRecord, 'invocationKind'> | Record<never, never> = {},
  ): void {
    const key = `${node.start}:${node.end}:${resolution.kind}`;
    if (recorded.has(key)) return;
    recorded.add(key);
    constructors.push({
      kind: resolution.kind,
      calleeForm: resolution.calleeForm,
      argumentKind: classifyRawWorkerArgument(
        argumentPath && 'node' in argumentPath ? (isBabelNode(argumentPath.node) ? argumentPath.node : undefined) : argumentPath,
      ),
      start: node.start ?? 0,
      end: node.end ?? 0,
      line: node.loc?.start.line ?? null,
      column: node.loc?.start.column ?? null,
      ...extra,
    });
  }

  babelTraverse(ast, {
    NewExpression(newPath) {
      const callee = newPath.get('callee');
      if (Array.isArray(callee)) return;
      const resolutions = resolveWorkerValue(callee);
      for (const resolution of resolutions) {
        record(newPath.node, resolution, newPath.get('arguments')[0]);
      }
    },
    CallExpression(callPath: NodePath<CallExpression>) {
      const callee = callPath.get('callee');
      if (!callee.isMemberExpression?.() && !callee.isOptionalMemberExpression?.()) return;
      if (staticMemberPropertyName(callee.node) !== 'construct') return;
      const reflectObject = callee.get('object');
      if (Array.isArray(reflectObject) || !unboundGlobalIdentifier(reflectObject, ['Reflect'])) return;
      const args = callPath.get('arguments');
      const resolutions = resolveWorkerValue(args[0]);
      const constructorArgs = args[1];
      let workerUrlArgument = null;
      if (constructorArgs?.isArrayExpression?.()) workerUrlArgument = constructorArgs.get('elements')[0];
      for (const resolution of resolutions) {
        record(callPath.node, { ...resolution, calleeForm: `Reflect.construct:${resolution.calleeForm}` }, workerUrlArgument, {
          invocationKind: 'Reflect.construct',
        });
      }
    },
  });
  return constructors.sort((left, right) => left.start - right.start || left.kind.localeCompare(right.kind));
}

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

const NODE_BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
]);

function findCommonJsRequireCalls(code: string, id = '<unknown>'): CommonJsRequireCall[] {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    sourceFilename: id,
    allowAwaitOutsideFunction: true,
    plugins: ['dynamicImport', 'importMeta', 'topLevelAwait', 'typescript', 'jsx'],
  });
  const calls: CommonJsRequireCall[] = [];
  function visit(node: Node | null | undefined): void {
    if (!node || typeof node !== 'object') return;
    if (isBabelNodeType(node, 'CallExpression')) {
      const directRequire = node.callee?.type === 'Identifier' && node.callee.name === 'require';
      const requireResolve = node.callee?.type === 'MemberExpression'
        && node.callee.object?.type === 'Identifier'
        && node.callee.object.name === 'require'
        && node.callee.property?.type === 'Identifier'
        && node.callee.property.name === 'resolve';
      const moduleRequire = node.callee?.type === 'MemberExpression'
        && node.callee.object?.type === 'Identifier'
        && node.callee.object.name === 'module'
        && node.callee.property?.type === 'Identifier'
        && node.callee.property.name === 'require';
      if (directRequire || requireResolve || moduleRequire) {
        const argument = node.arguments[0];
        calls.push({
          kind: directRequire ? 'require' : requireResolve ? 'require.resolve' : 'module.require',
          staticSpecifier: node.arguments.length === 1 && argument?.type === 'StringLiteral' ? argument.value : null,
          dynamic: node.arguments.length !== 1 || argument?.type !== 'StringLiteral',
          start: node.start ?? null,
          end: node.end ?? null,
        });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isBabelNode(item)) visit(item);
        }
      } else if (isBabelNode(value)) {
        visit(value);
      }
    }
  }
  visit(ast);
  return calls;
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

function createImportScriptsAssetPlugin({
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

function createViteWorkerQueryPolicyPlugin({ diagnostics, allowViteWorkerQueryImport }: Readonly<{
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

function createRawWorkerConstructorPolicyPlugin({ diagnostics, allowRawWorkerConstructor, inspectSource }: Readonly<{
  diagnostics: StandaloneBuildDiagnostics;
  allowRawWorkerConstructor?: (record: unknown) => boolean;
  inspectSource: boolean;
}>): Plugin {
  const reservedBootstrapMarker = '__naidanStandaloneWorkerBootstrap';
  return {
    name: 'naidan-file-protocol-standalone-raw-worker-constructor-policy',
    enforce: 'pre',
    transform(code, id) {
      if (!inspectSource) return null;
      if (id.startsWith('\0') || !/\.[cm]?[jt]sx?(?:\?|$)/u.test(id)) return null;
      if (!code.includes('Worker') && !code.includes(reservedBootstrapMarker)) return null;
      const sourcePath = id.split('?', 1)[0];
      if (code.includes(reservedBootstrapMarker)) {
        throw new Error(
          `Reserved standalone Worker bootstrap marker is application-inaccessible: ${sourcePath}`,
        );
      }
      const constructors = findRawWorkerConstructors(code, sourcePath);
      for (const constructor of constructors) {
        diagnostics.rawWorkerSourceCandidates.push({
          stage: 'source',
          moduleId: sourcePath,
          expressionSource: code.slice(constructor.start, constructor.end),
          ...constructor,
        });
      }
      // Do not reject here. Package distribution files commonly contain unused
      // Worker helpers beside unrelated exports. Rejecting before tree-shaking would
      // block safe imports such as @vueuse/core even when the helper is absent from
      // the final standalone bundle.
      return null;
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (!isOutputChunk(output)) continue;
        const constructors = findRawWorkerConstructors(output.code, output.fileName);
        for (const constructor of constructors) {
          const expressionSource = output.code.slice(constructor.start, constructor.end);
          const moduleIds = Object.keys(output.modules);
          const generatedBootstrapWorker = expressionSource.includes(reservedBootstrapMarker);
          const record: Omit<RawWorkerOutputDiagnostic, 'allowed'> = {
            stage: 'output',
            moduleId: output.facadeModuleId || moduleIds[0] || output.fileName,
            moduleIds,
            outputFileName: output.fileName,
            expressionSource,
            generatedBootstrapWorker,
            ...constructor,
          };
          const allowed = generatedBootstrapWorker
            || typeof allowRawWorkerConstructor === 'function'
              && allowRawWorkerConstructor(record) === true;
          diagnostics.rawWorkerConstructors.push({ ...record, allowed });
          if (!allowed) {
            throw new Error(
              `Raw ${constructor.kind} constructors survive tree-shaking in standalone split output (${constructor.argumentKind}) at ${output.fileName}:${constructor.start}. `
              + 'Use a configured standalone Worker virtual client, or explicitly allow a reviewed self-contained Blob Worker.',
            );
          }
        }
      }
    },
  };
}

function createWorkerRealmGlobalGuardPlugin({
  workers,
  diagnostics,
  allowWorkerRealmGlobal,
  uiOnlyGlobals,
}: Readonly<{
  workers: readonly NormalizedWorkerDefinition[];
  diagnostics: StandaloneBuildDiagnostics;
  allowWorkerRealmGlobal?: (record: unknown) => boolean;
  uiOnlyGlobals: readonly string[];
}>): Plugin {
  const referencesByModule = new Map<string, WorkerRealmGlobalReference[]>();
  const workerEntryPaths = new Set(workers.map(worker => path.resolve(worker.entry)));
  const uiOnlyGlobalLexicalPattern = new RegExp(
    `\\b(?:${[...uiOnlyGlobals].map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})\\b`,
    'u',
  );
  return {
    name: 'naidan-file-protocol-standalone-worker-realm-global-guard',
    enforce: 'pre',
    transform(code, id) {
      if (id.startsWith('\0') || !/\.[cm]?[jt]sx?(?:\?|$)/u.test(id)) return null;
      if (!uiOnlyGlobalLexicalPattern.test(code)) return null;
      const sourcePath = id.split('?', 1)[0];
      const references = findWorkerRealmGlobalReferences(code, sourcePath, { uiOnlyGlobals });
      if (references.length > 0) referencesByModule.set(sourcePath, references);
      return null;
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(output => output.type === 'chunk');
      const chunkByFileName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
      const workerEntryFileNames = chunks
        .filter(chunk => chunk.facadeModuleId && workerEntryPaths.has(path.resolve(chunk.facadeModuleId)))
        .map(chunk => chunk.fileName);
      const workerClosure = collectChunkClosure({ chunkByFileName, entryFileNames: workerEntryFileNames });
      const failures: WorkerRealmGlobalDiagnostic[] = [];
      for (const [moduleId, references] of referencesByModule) {
        const owners = chunks
          .filter(chunk => Object.keys(chunk.modules).some(id => id.split('?', 1)[0] === moduleId))
          .map(chunk => chunk.fileName)
          .sort();
        const workerOwners = owners.filter(fileName => workerClosure.has(fileName));
        references.forEach(reference => {
          const record = {
            moduleId,
            owners,
            workerOwners,
            included: owners.length > 0,
            workerReachable: workerOwners.length > 0,
            ...reference,
          };
          const allowed = workerOwners.length === 0 || (
            typeof allowWorkerRealmGlobal === 'function'
            && allowWorkerRealmGlobal(record) === true
          );
          const diagnostic = { ...record, allowed };
          diagnostics.workerRealmGlobalReferences.push(diagnostic);
          if (!allowed) failures.push(diagnostic);
        });
      }
      diagnostics.workerRealmGlobalReferences.sort(
        (left, right) => left.moduleId.localeCompare(right.moduleId) || left.start - right.start,
      );
      if (failures.length > 0) {
        throw new Error(
          `UI-only globals are evaluated by Worker-reachable modules: ${failures.map(failure => (
            `${failure.name} (${failure.accessKind}) at ${failure.moduleId}:${failure.line}:${failure.column}; owners: ${failure.workerOwners.join(', ')}`
          )).join('; ')}. Defer the access, guard it for the current realm, or explicitly approve a reviewed exception.`,
        );
      }
    },
  };
}

function createCommonJsCompatibilityPlugin({ diagnostics }: Readonly<{diagnostics: StandaloneBuildDiagnostics}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-commonjs-compatibility',
    enforce: 'pre',
    transform(code, id) {
      const sourcePath = id.split('?', 1)[0];
      if (!/\.(?:cjs|cts)$/u.test(sourcePath)) return null;
      const calls = findCommonJsRequireCalls(code, sourcePath);
      for (const call of calls) {
        if (call.kind !== 'require') {
          throw new Error(`${call.kind}() is unsupported in standalone browser output: ${sourcePath}:${call.start}`);
        }
        if (call.dynamic) {
          throw new Error(`Dynamic CommonJS require() is unsupported in standalone browser output: ${sourcePath}:${call.start}`);
        }
        if (call.staticSpecifier !== null && NODE_BUILTIN_MODULES.has(call.staticSpecifier)) {
          throw new Error(`Node.js builtin ${JSON.stringify(call.staticSpecifier)} is unsupported in standalone browser output: ${sourcePath}:${call.start}`);
        }
      }
      return null;
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (!isOutputChunk(output)) continue;
        const browserExternalModules = Object.keys(output.modules).filter(moduleId => /(?:vite-browser-external|browser-external:|\0browser-external)/u.test(moduleId));
        if (browserExternalModules.length > 0) {
          throw new Error(`Browser-external stub modules are unsupported in standalone output ${output.fileName}: ${browserExternalModules.join(', ')}`);
        }
        if (/environment that doesn't expose the [`']require[`'] function/u.test(output.code)) {
          throw new Error(`Unresolved runtime CommonJS require() fallback remains in standalone output: ${output.fileName}`);
        }
      }
      diagnostics.commonJsCompatibilityChecked = true;
    },
  };
}


function createSystemJsRuntimeValidationPlugin({
  systemRuntimePath,
  systemRuntimeSourceMapPath,
}: Readonly<{
  systemRuntimePath: string;
  systemRuntimeSourceMapPath?: string;
}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-systemjs-runtime-validation',
    async buildStart() {
      const runtimeSource = await fs.readFile(systemRuntimePath, 'utf8');
      assertSupportedSystemJsRuntime({ source: runtimeSource });
      if (systemRuntimeSourceMapPath === undefined) return;

      const sourceMapSource = await fs.readFile(systemRuntimeSourceMapPath);
      assertMatchingSystemJsSourceMap({ runtimeSource, sourceMapSource });
    },
  };
}

function createWorkerEntryPlugin({ workers, diagnostics, systemRuntimePath, systemRuntimeFileName }: Readonly<{
  workers: readonly NormalizedWorkerDefinition[];
  diagnostics: StandaloneBuildDiagnostics;
  systemRuntimePath: string;
  systemRuntimeFileName: string;
}>): Plugin {
  const runtimePublicId = DEFAULT_RUNTIME_PUBLIC_ID;
  const workerRecords = new Map<string, WorkerEntryRecord>();
  let systemReferenceId: string | undefined;

  return {
    name: 'naidan-file-protocol-standalone-worker-entries',
    enforce: 'pre',
    buildStart() {
      systemReferenceId = this.emitFile({
        type: 'asset',
        fileName: systemRuntimeFileName,
        source: '',
      });
      for (const worker of workers) {
        const referenceId = this.emitFile({
          type: 'chunk',
          id: worker.entry,
          name: worker.name,
        });
        workerRecords.set(worker.virtualId, {
          ...worker,
          referenceId,
          resolvedVirtualId: `\0naidan:standalone-worker-client:${worker.name}`,
        });
      }
    },
    resolveId(id) {
      if (id === runtimePublicId) return DEFAULT_RUNTIME_RESOLVED_ID;
      return workerRecords.get(id)?.resolvedVirtualId ?? null;
    },
    load(id) {
      if (id === DEFAULT_RUNTIME_RESOLVED_ID) {
        return createStandaloneWorkerRuntimeModuleSource({
          initMessageType: INIT_MESSAGE_TYPE,
          readyMessageType: READY_MESSAGE_TYPE,
          errorMessageType: ERROR_MESSAGE_TYPE,
          diagnosticsGlobalName: FILE_PROTOCOL_STANDALONE_GLOBAL_NAME,
        });
      }
      const record = [...workerRecords.values()].find(candidate => candidate.resolvedVirtualId === id);
      if (!record) return null;
      const source = `
import {
  createStandaloneWorkerFromUrls,
  debugGetStandaloneWorkerRuntimeDiagnostics,
  disposeStandaloneWorkerBootstrap,
  scheduleStandaloneWorkerBootstrapWarmup,
} from ${JSON.stringify(runtimePublicId)};
export {
  debugGetStandaloneWorkerRuntimeDiagnostics,
  disposeStandaloneWorkerBootstrap,
  scheduleStandaloneWorkerBootstrapWarmup,
};
const workerEntryUrl = import.meta.ROLLUP_FILE_URL_${record.referenceId};
const systemRuntimeUrl = import.meta.ROLLUP_FILE_URL_${systemReferenceId};
export function createStandaloneWorker(options = {}) {
  return createStandaloneWorkerFromUrls({
    ...options,
    name: options.name || ${JSON.stringify(record.defaultWorkerName ?? record.name)},
    workerEntryUrl,
    systemRuntimeUrl,
  });
}
`;
      diagnostics.virtualModules.push({
        workerName: record.name,
        virtualId: record.virtualId,
        resolvedVirtualId: record.resolvedVirtualId,
        source,
      });
      return source;
    },
    async generateBundle(_options, bundle) {
      const systemAsset = Object.values(bundle).find(
        output => output.type === 'asset' && output.fileName === systemRuntimeFileName,
      );
      if (!systemAsset || systemAsset.type !== 'asset') {
        throw new Error(`Missing emitted SystemJS runtime asset: ${systemRuntimeFileName}`);
      }
      const systemRuntimeSource = await fs.readFile(systemRuntimePath, 'utf8');
      // The standalone package intentionally omits third-party source maps to keep the
      // distribution small. Remove the dangling directive so Firefox does not report a
      // misleading file:// NetworkError for a map that is not part of the package.
      systemAsset.source = systemRuntimeSource.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/u, '');
    },
  };
}

function findExternalModuleScripts(html: string, fileName: string): ExternalModuleScript[] {
  const scripts: ExternalModuleScript[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)) {
    const attributes = match[1];
    if (!/\btype\s*=\s*(["'])module\1/u.test(attributes)) continue;
    const source = /\bsrc\s*=\s*(["'])([^"']+)\1/u.exec(attributes);
    if (!source) throw new Error(`Inline module scripts are unsupported in standalone HTML: ${fileName}`);
    scripts.push({ tag: match[0], source: source[2] });
  }
  return scripts;
}


function collectChunkClosure({ chunkByFileName, entryFileNames }: Readonly<{
  chunkByFileName: ReadonlyMap<string, OutputChunk>;
  entryFileNames: readonly string[];
}>): Set<string> {
  const visited = new Set<string>();
  const queue = [...entryFileNames];
  while (queue.length > 0) {
    const fileName = queue.pop();
    if (!fileName || visited.has(fileName)) continue;
    visited.add(fileName);
    const chunk = chunkByFileName.get(fileName);
    if (!chunk) continue;
    for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
      if (!visited.has(dependency)) queue.push(dependency);
    }
  }
  return visited;
}

function localHtmlReferenceToBundleFileName(reference: string, htmlFileName: string): string {
  return resolveFileProtocolStandaloneHtmlReference({
    reference,
    htmlFileName,
    attribute: 'HTML reference',
  });
}

function bundleFileNameToHtmlReference(fileName: string, htmlFileName: string): string {
  const relative = slash(path.posix.relative(path.posix.dirname(htmlFileName), fileName));
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function findLocalStylesheetReferences(html: string): string[] {
  const references: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    if (!/\brel\s*=\s*(["'])stylesheet\1/iu.test(tag)) continue;
    const hrefMatch = /\bhref\s*=\s*(["'])([^"']+)\1/iu.exec(tag);
    if (!hrefMatch) continue;
    const href = hrefMatch[2];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(href)) continue;
    references.push(href);
  }
  return references;
}

function isStylesheetSideEffectModuleId(moduleId: string): boolean {
  const [pathname, query = ''] = moduleId.split('?', 2);
  if (!/\.(?:css|less|sass|scss|styl|stylus|pcss|postcss)$/iu.test(pathname)) return false;
  const queryFlags = new URLSearchParams(query);
  return !queryFlags.has('raw') && !queryFlags.has('inline') && !queryFlags.has('url');
}

function createWorkerCssGuardPlugin({ workers, diagnostics, allowWorkerOnlyCssAssets }: Readonly<{
  workers: readonly NormalizedWorkerDefinition[];
  diagnostics: StandaloneBuildDiagnostics;
  allowWorkerOnlyCssAssets: boolean;
}>): Plugin {
  const workerEntryPaths = new Set(workers.map(worker => path.resolve(worker.entry)));
  return {
    name: 'naidan-file-protocol-standalone-worker-css-guard',
    generateBundle(_options, bundle) {
      const moduleIds = [...this.getModuleIds()];
      const workerEntryModuleIds = moduleIds.filter(moduleId => workerEntryPaths.has(path.resolve(moduleId)));
      const uiEntryModuleIds = moduleIds.filter(moduleId => {
        const info = this.getModuleInfo(moduleId);
        return info?.isEntry === true && !workerEntryPaths.has(path.resolve(moduleId));
      });

      const collectModuleClosure = (entryModuleIds: readonly string[]): Set<string> => {
        const seen = new Set<string>();
        const pending = [...entryModuleIds];
        while (pending.length > 0) {
          const moduleId = pending.pop();
          if (moduleId === undefined || seen.has(moduleId)) continue;
          seen.add(moduleId);
          const info = this.getModuleInfo(moduleId);
          if (!info) continue;
          pending.push(...info.importedIds, ...info.dynamicallyImportedIds);
        }
        return seen;
      };

      const workerClosure = collectModuleClosure(workerEntryModuleIds);
      const uiClosure = collectModuleClosure(uiEntryModuleIds);
      const workerCss = [...workerClosure].filter(isStylesheetSideEffectModuleId).sort();
      const uiCss = [...uiClosure].filter(isStylesheetSideEffectModuleId).sort();
      const uiCssSet = new Set(uiCss);
      const workerOnlyCss = workerCss.filter(moduleId => !uiCssSet.has(moduleId));
      const emittedCssAssets = Object.values(bundle)
        .filter(output => output.type === 'asset' && /\.css$/iu.test(output.fileName))
        .map(output => output.fileName)
        .sort();

      diagnostics.workerCss = {
        classificationBasis: 'source-module-graph',
        workerEntryModuleIds: [...workerEntryModuleIds].sort(),
        uiEntryModuleIds: [...uiEntryModuleIds].sort(),
        workerCss,
        uiCss,
        workerOnlyCss,
        emittedCssAssets,
      };
      if (!allowWorkerOnlyCssAssets && workerOnlyCss.length > 0) {
        throw new Error(
          `Worker-only CSS side effects cannot be applied in a Dedicated Worker and would be merged into the standalone stylesheet without a UI owner: ${workerOnlyCss.join(', ')}`,
        );
      }
    },
  };
}

function createStandaloneBuildConfigPlugin({ diagnostics }: Readonly<{diagnostics: StandaloneBuildDiagnostics}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-build-config',
    config() {
      return {
        build: {
          // SystemJS owns every JavaScript dependency load in the standalone build.
          // Disable Vite modulepreload so a chunk shared by the UI and a Worker never
          // executes DOM-only preload code in the Worker Realm.
          modulePreload: false,

          // Keep CSS split during bundling. The output plugin links every stylesheet
          // reachable from the UI graph directly from index.html because Vite does not
          // reliably attach a CSS asset to a Dynamic Import when its JavaScript chunk
          // is shared by the UI and a Worker. This avoids a custom runtime CSS loader
          // while also avoiding the high generateBundle memory cost of merging all
          // application CSS into one asset.
          cssCodeSplit: true,
        },
      };
    },
    configResolved(config) {
      if (config.base !== './' && config.base !== '') {
        throw new Error(`Standalone file:// builds require a relative Vite base; received ${JSON.stringify(config.base)}`);
      }
      if (config.build.modulePreload !== false) {
        throw new Error('Standalone Worker builds require build.modulePreload=false');
      }
      if (config.build.cssCodeSplit !== true) {
        throw new Error('Standalone Worker builds require build.cssCodeSplit=true');
      }
      diagnostics.modulePreloadDisabled = true;
      diagnostics.cssCodeSplitEnabled = true;
      diagnostics.lazyCssDependencyMetadataEnabled = false;
    },
  };
}

function createVitePreloadHelperCompatibilityPlugin({ diagnostics }: Readonly<{diagnostics: StandaloneBuildDiagnostics}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-vite-preload-helper-compatibility',
    enforce: 'post',
    transform(code, id) {
      if (id !== '\0vite/preload-helper.js') return null;
      if (
        !code.includes('vite:preloadError')
        || !code.includes('window.dispatchEvent')
        || !code.includes('link.crossOrigin = ""')
        || !code.includes('if (__VITE_IS_MODERN__ && deps && deps.length > 0)')
      ) {
        throw new Error('Unexpected Vite preload helper shape; review Worker and file:// compatibility before upgrading Vite');
      }
      let transformed = code.replace('window.dispatchEvent', 'globalThis.dispatchEvent');
      transformed = transformed.replace(
        'if (__VITE_IS_MODERN__ && deps && deps.length > 0)',
        'if (__VITE_IS_MODERN__ && typeof document !== "undefined" && deps && deps.length > 0)',
      );
      transformed = transformed.replace(
        'link.crossOrigin = "";',
        'const fileProtocol = new URL(dep, document.baseURI).protocol === "file:"; if (fileProtocol && !isCss) return; if (!fileProtocol) link.crossOrigin = "";',
      );
      if (
        transformed.includes('window.dispatchEvent')
        || transformed.includes('if (__VITE_IS_MODERN__ && deps && deps.length > 0)')
        || !transformed.includes('const fileProtocol = new URL(dep, document.baseURI).protocol === "file:"; if (fileProtocol && !isCss) return; if (!fileProtocol) link.crossOrigin = "";')
      ) {
        throw new Error('Vite preload helper compatibility transform did not replace every expected construct');
      }
      diagnostics.vitePreloadHelperRealmNeutral = true;
      diagnostics.vitePreloadHelperSkipsDomOutsideUiRealm = true;
      diagnostics.vitePreloadHelperOmitsFileCrossorigin = true;
      return { code: transformed, map: null };
    },
  };
}

function createExternalWasmGuardPlugin({ allowExternalWasmAssets }: Readonly<{allowExternalWasmAssets: boolean}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-external-wasm-guard',
    generateBundle(_options, bundle) {
      if (allowExternalWasmAssets) return;
      const wasmAssets = Object.values(bundle)
        .filter(output => output.type === 'asset' && /\.wasm(?:\.gz)?$/iu.test(output.fileName))
        .map(output => output.fileName);
      if (wasmAssets.length > 0) {
        throw new Error(
          `External WebAssembly assets cannot be loaded by standalone file:// JavaScript without a custom embedding/loader strategy: ${wasmAssets.join(', ')}`,
        );
      }
    },
  };
}


function stripCrossoriginFromLocalStylesheetLinks(html: string): string {
  return html.replace(/<link\b[^>]*>/giu, (tag: string) => {
    if (!/\brel\s*=\s*(["'])stylesheet\1/iu.test(tag)) return tag;
    const hrefMatch = /\bhref\s*=\s*(["'])([^"']+)\1/iu.exec(tag);
    if (!hrefMatch) return tag;
    const href = hrefMatch[2];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(href)) return tag;
    return tag.replace(/\s+crossorigin(?:\s*=\s*(?:["'][^"']*["']|[^\s>]+))?/giu, '');
  });
}

function createSystemJsOutputPlugin({
  diagnostics,
  systemRuntimeFileName,
  systemJsFileScriptLoaderPatchFileName,
  systemJsRetryHookFileName,
  startupSlowNoticeDelayMs,
}: Readonly<{
  diagnostics: StandaloneBuildDiagnostics;
  systemRuntimeFileName: string;
  systemJsFileScriptLoaderPatchFileName: string;
  systemJsRetryHookFileName: string;
  startupSlowNoticeDelayMs: number;
}>): Plugin {
  let systemJsFileScriptLoaderPatchReferenceId: string | undefined;
  let systemJsRetryHookReferenceId: string | undefined;
  return {
    name: 'naidan-file-protocol-standalone-systemjs-output',
    enforce: 'post',
    buildStart() {
      systemJsFileScriptLoaderPatchReferenceId = this.emitFile({
        type: 'asset',
        fileName: systemJsFileScriptLoaderPatchFileName,
        source: createSystemJsFileScriptLoaderPatchSource(),
      });
      systemJsRetryHookReferenceId = this.emitFile({
        type: 'asset',
        fileName: systemJsRetryHookFileName,
        source: createSystemJsPhysicalLoadRecoverySource(),
      });
      diagnostics.classicScriptAssets.push({
        kind: 'systemjs-file-script-loader-patch',
        outputFileName: systemJsFileScriptLoaderPatchFileName,
      });
      diagnostics.classicScriptAssets.push({
        kind: 'systemjs-physical-load-retry-hook',
        outputFileName: systemJsRetryHookFileName,
      });
    },
    async generateBundle(_options, bundle) {
      if (systemJsFileScriptLoaderPatchReferenceId === undefined || systemJsRetryHookReferenceId === undefined) {
        throw new Error('SystemJS support assets were not emitted before generateBundle');
      }
      const emittedPatch = this.getFileName(systemJsFileScriptLoaderPatchReferenceId);
      const emittedRetry = this.getFileName(systemJsRetryHookReferenceId);
      if (emittedPatch !== systemJsFileScriptLoaderPatchFileName) {
        throw new Error(`Unexpected SystemJS file loader patch file name: ${emittedPatch}`);
      }
      if (emittedRetry !== systemJsRetryHookFileName) {
        throw new Error(`Unexpected SystemJS retry hook file name: ${emittedRetry}`);
      }

      const chunkOutputs = Object.values(bundle).filter(output => output.type === 'chunk');
      const chunkByFileName = new Map(chunkOutputs.map(output => [output.fileName, output]));
      for (const output of chunkOutputs) {
        const chunkRecord: ChunkDiagnostic = {
          fileName: output.fileName,
          name: output.name,
          isEntry: output.isEntry,
          facadeModuleId: output.facadeModuleId,
          imports: [...output.imports],
          dynamicImports: [...output.dynamicImports],
          moduleIds: Object.keys(output.modules),
          beforeBytes: Buffer.byteLength(output.code),
        };
        const transformed = await transformAsync(output.code, {
          filename: output.fileName,
          babelrc: false,
          configFile: false,
          ast: false,
          code: true,
          compact: true,
          minified: true,
          comments: false,
          sourceType: 'module',
          sourceMaps: false,
          plugins: [babelTransformDynamicImportPlugin, babelTransformModulesSystemjsPlugin],
        });
        if (!transformed?.code) throw new Error(`No SystemJS transform output for ${output.fileName}`);
        if (!transformed.code.includes('System.register(')) {
          throw new Error(`SystemJS transform did not emit System.register for ${output.fileName}`);
        }
        output.code = `${transformed.code}\n`;
        output.map = null;
        chunkRecord.afterBytes = Buffer.byteLength(output.code);
        diagnostics.chunks.push(chunkRecord);
      }

      const htmlOutputs = Object.values(bundle).filter(
        (output): output is OutputAsset => output.type === 'asset' && output.fileName.endsWith('.html'),
      );
      if (htmlOutputs.length !== 1) {
        throw new Error(`Naidan standalone output requires exactly one HTML entry; found ${htmlOutputs.length}`);
      }
      for (const output of htmlOutputs) {
        let html = typeof output.source === 'string'
          ? output.source
          : Buffer.from(output.source).toString('utf8');
        assertFileProtocolStandaloneHtmlBeforeRewrite({ html, htmlFileName: output.fileName });
        const moduleScripts = findExternalModuleScripts(html, output.fileName);
        if (moduleScripts.length !== 1) {
          throw new Error(`Naidan standalone output requires exactly one UI entry in ${output.fileName}; found ${moduleScripts.length}`);
        }
        html = stripCrossoriginFromLocalStylesheetLinks(html);
        html = html.replace(moduleScripts[0].tag, '');

        const moduleEntryFileName = localHtmlReferenceToBundleFileName(moduleScripts[0].source, output.fileName);
        if (!chunkByFileName.has(moduleEntryFileName)) {
          throw new Error(`HTML module entry does not resolve to an emitted chunk: ${moduleScripts[0].source} in ${output.fileName}`);
        }
        const completeUiClosure = collectChunkClosure({
          chunkByFileName,
          entryFileNames: [moduleEntryFileName],
        });
        const existingStylesheetFileNames = new Set(
          findLocalStylesheetReferences(html).map(reference => localHtmlReferenceToBundleFileName(reference, output.fileName)),
        );
        const uiCss = new Set<string>();
        // UI and Worker code can share a JavaScript module that imports CSS. Workers
        // cannot apply that CSS, so every stylesheet reachable from the UI graph is
        // linked once from the parent HTML while JavaScript remains lazy.
        for (const fileName of completeUiClosure) {
          const importedCss = chunkByFileName.get(fileName)?.viteMetadata?.importedCss;
          if (importedCss instanceof Set) {
            for (const cssFileName of importedCss) {
              if (typeof cssFileName === 'string') uiCss.add(cssFileName);
            }
          }
        }
        const uiPreloadedCssFileNames = [...uiCss]
          .filter(fileName => !existingStylesheetFileNames.has(fileName))
          .sort((left, right) => left.localeCompare(right));
        const uiPreloadedCssUrls = uiPreloadedCssFileNames.map(fileName => (
          bundleFileNameToHtmlReference(fileName, output.fileName)
        ));
        const cssLinks = uiPreloadedCssUrls
          .map(url => `<link rel="stylesheet" href=${JSON.stringify(url)}>`)
          .join('');

        const relativeToHtml = (fileName: string): string => {
          const relative = slash(path.posix.relative(path.posix.dirname(output.fileName), fileName));
          return relative.startsWith('.') ? relative : `./${relative}`;
        };
        const normalizedSystemUrl = relativeToHtml(systemRuntimeFileName);
        const normalizedPatchUrl = relativeToHtml(systemJsFileScriptLoaderPatchFileName);
        const normalizedRetryUrl = relativeToHtml(systemJsRetryHookFileName);
        const entryReference = bundleFileNameToHtmlReference(moduleEntryFileName, output.fileName);
        const entryBootstrap = createFileProtocolStandaloneEntryBootstrapSource({
          entryFileName: entryReference.replace(/^\.\//u, ''),
          slowStartupNoticeDelayMs: startupSlowNoticeDelayMs,
        });
        // This is the one proven UI loading path. SystemJS appends only requested
        // Classic Scripts; the external patch removes crossorigin only for file: URLs.
        // Keeping one path avoids carrying historical fallback loaders into Naidan.
        const bootstrap = `${cssLinks}`
          + `<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRuntime)} src=${JSON.stringify(normalizedSystemUrl)}></script>`
          + `<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsFilePatch)} src=${JSON.stringify(normalizedPatchUrl)}></script>`
          + `<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRetryHook)} src=${JSON.stringify(normalizedRetryUrl)}></script>`
          + `<script id=${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.entryBootstrap)}>${entryBootstrap}</script>`;
        html = insertFileProtocolStandaloneBootstrap({ html, bootstrap });
        assertFileProtocolStandaloneHtmlAfterRewrite({ html, htmlFileName: output.fileName });
        output.source = html;
        diagnostics.html.push({
          fileName: output.fileName,
          moduleEntryUrls: [moduleScripts[0].source],
          systemRuntimeUrl: normalizedSystemUrl,
          uiPreloadedCssFileNames,
          uiPreloadedCssUrls,
          startupScriptElementIds: [
            FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRuntime,
            FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsFilePatch,
            FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRetryHook,
            FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.entryBootstrap,
          ],
        });
      }

      diagnostics.chunks.sort((left, right) => left.fileName.localeCompare(right.fileName));
      diagnostics.classicScriptAssets.sort((left, right) => left.outputFileName.localeCompare(right.outputFileName));
      diagnostics.virtualModules.sort((left, right) => left.workerName.localeCompare(right.workerName));
      diagnostics.rawWorkerSourceCandidates.sort((left, right) => left.moduleId.localeCompare(right.moduleId) || left.start - right.start);
      diagnostics.rawWorkerConstructors.sort((left, right) => left.outputFileName.localeCompare(right.outputFileName) || left.start - right.start);
      diagnostics.viteWorkerQueryImports.sort((left, right) => left.moduleId.localeCompare(right.moduleId) || left.start - right.start);
      diagnostics.html.sort((left, right) => left.fileName.localeCompare(right.fileName));
    },
  };
}

function assertNonEmptyWorkerDefinitions(workers: readonly NaidanStandaloneWorkerDefinition[]): void {
  if (!Array.isArray(workers) || workers.length === 0) {
    throw new TypeError('workers must be a non-empty array');
  }
}

function createSourceAuditDiagnostic(sourceAudit: NaidanStandaloneSourceAudit): FileProtocolStandaloneSourceAuditSummary {
  switch (sourceAudit.mode) {
  case 'inline':
    return { mode: 'inline' };
  case 'external':
    return { mode: 'external', evidence: sourceAudit.evidence };
  default: {
    const exhaustive: never = sourceAudit;
    throw new Error(`Unhandled source audit mode: ${String(exhaustive)}`);
  }
  }
}

function createSourcePolicyPlugins({
  sourceAudit,
  diagnostics,
  policies,
  workers,
}: Readonly<{
  sourceAudit: NaidanStandaloneSourceAudit;
  diagnostics: StandaloneBuildDiagnostics;
  policies: NaidanStandalonePolicies;
  workers: readonly NormalizedWorkerDefinition[];
}>): Plugin[] {
  const mandatorySourcePolicies = [
    // These checks use cheap lexical prefilters and parse only candidate modules.
    // Keep them enabled even when the expensive Worker-realm source audit is
    // supplied externally: a newly introduced Vite Worker graph or importScripts
    // dependency must fail in the build that introduced it, not at a later audit.
    createViteWorkerQueryPolicyPlugin({
      diagnostics,
      allowViteWorkerQueryImport: policies.allowViteWorkerQueryImport,
    }),
    createImportScriptsAssetPlugin({
      diagnostics,
      classicScriptOutputBase: 'assets/chunks',
      workers,
    }),
  ];

  switch (sourceAudit.mode) {
  case 'inline':
    return [
      ...mandatorySourcePolicies,
      createWorkerRealmGlobalGuardPlugin({
        workers,
        diagnostics,
        allowWorkerRealmGlobal: policies.allowWorkerRealmGlobal,
        uiOnlyGlobals: policies.uiOnlyGlobals ?? DEFAULT_UI_ONLY_GLOBALS,
      }),
    ];
  case 'external':
    return mandatorySourcePolicies;
  default: {
    const exhaustive: never = sourceAudit;
    throw new Error(`Unhandled source audit mode: ${String(exhaustive)}`);
  }
  }
}

export function createNaidanStandalonePlugin({
  workers,
  systemRuntimePath,
  systemRuntimeSourceMapPath,
  diagnostics = {},
  startupSlowNoticeDelayMs = 15_000,
  policies = {},
  sourceAudit = { mode: 'inline' },
  releaseValidation,
}: NaidanStandalonePluginOptions): PluginOption {
  assertNonEmptyWorkerDefinitions(workers);
  if (!systemRuntimePath) throw new TypeError('systemRuntimePath is required');
  if (!Number.isFinite(startupSlowNoticeDelayMs) || startupSlowNoticeDelayMs < 0) {
    throw new TypeError('startupSlowNoticeDelayMs must be a non-negative finite number');
  }
  if (!sourceAudit || !['inline', 'external'].includes(sourceAudit.mode)) {
    throw new TypeError('sourceAudit.mode must be "inline" or "external"');
  }
  if (sourceAudit.mode === 'external' && (typeof sourceAudit.evidence !== 'string' || sourceAudit.evidence.trim() === '')) {
    throw new TypeError('sourceAudit.evidence is required when sourceAudit.mode is "external"');
  }

  const normalizedWorkers = workers.map(worker => {
    if (!worker?.name || !worker?.entry || !worker?.virtualId) {
      throw new TypeError('Each Worker requires name, entry, and virtualId');
    }
    return { ...worker, entry: path.resolve(worker.entry) };
  });
  const seenVirtualIds = new Set<string>();
  const seenNames = new Set<string>();
  const seenEntries = new Set<string>();
  for (const worker of normalizedWorkers) {
    if (seenVirtualIds.has(worker.virtualId)) throw new Error(`Duplicate Worker virtualId: ${worker.virtualId}`);
    if (seenNames.has(worker.name)) throw new Error(`Duplicate Worker name: ${worker.name}`);
    if (seenEntries.has(worker.entry)) throw new Error(`Duplicate Worker entry: ${worker.entry}`);
    seenVirtualIds.add(worker.virtualId);
    seenNames.add(worker.name);
    seenEntries.add(worker.entry);
  }

  const buildDiagnostics = Object.assign(diagnostics, {
    format: 'naidan-file-protocol-standalone-worker-build-v1',
    sourceAudit: createSourceAuditDiagnostic(sourceAudit),
    chunks: new Array<ChunkDiagnostic>(),
    classicScriptAssets: new Array<ClassicScriptAssetDiagnostic>(),
    virtualModules: new Array<VirtualModuleDiagnostic>(),
    html: new Array<HtmlDiagnostic>(),
    rawWorkerSourceCandidates: new Array<RawWorkerSourceCandidateDiagnostic>(),
    rawWorkerConstructors: new Array<RawWorkerOutputDiagnostic>(),
    viteWorkerQueryImports: new Array<ViteWorkerQueryDiagnostic>(),
    workerRealmGlobalReferences: new Array<WorkerRealmGlobalDiagnostic>(),
  });

  const normalizedSystemRuntimePath = path.resolve(systemRuntimePath);
  const normalizedSystemRuntimeSourceMapPath = systemRuntimeSourceMapPath === undefined
    ? undefined
    : path.resolve(systemRuntimeSourceMapPath);
  const systemRuntimeFileName = 'file-protocol-standalone/system.min.js';
  const sourcePolicyPlugins = createSourcePolicyPlugins({
    sourceAudit,
    diagnostics: buildDiagnostics,
    policies,
    workers: normalizedWorkers,
  });

  return [
    createStandaloneBuildConfigPlugin({ diagnostics: buildDiagnostics }),
    createSystemJsRuntimeValidationPlugin({
      systemRuntimePath: normalizedSystemRuntimePath,
      systemRuntimeSourceMapPath: normalizedSystemRuntimeSourceMapPath,
    }),
    createWorkerEntryPlugin({
      workers: normalizedWorkers,
      diagnostics: buildDiagnostics,
      systemRuntimePath: normalizedSystemRuntimePath,
      systemRuntimeFileName,
    }),
    ...sourcePolicyPlugins,
    // Final-output Raw Worker rejection remains mandatory in both modes. External
    // audit skips only the source-candidate Raw Worker diagnostics and the
    // Worker-realm global graph audit; cheap source guards above stay active.
    createRawWorkerConstructorPolicyPlugin({
      diagnostics: buildDiagnostics,
      allowRawWorkerConstructor: policies.allowRawWorkerConstructor,
      inspectSource: sourceAudit.mode === 'inline',
    }),
    createCommonJsCompatibilityPlugin({ diagnostics: buildDiagnostics }),
    createWorkerCssGuardPlugin({
      workers: normalizedWorkers,
      diagnostics: buildDiagnostics,
      allowWorkerOnlyCssAssets: policies.allowWorkerOnlyCssAssets === true,
    }),
    createExternalWasmGuardPlugin({
      allowExternalWasmAssets: policies.allowExternalWasmAssets === true,
    }),
    createVitePreloadHelperCompatibilityPlugin({ diagnostics: buildDiagnostics }),
    createSystemJsOutputPlugin({
      diagnostics: buildDiagnostics,
      systemRuntimeFileName,
      systemJsFileScriptLoaderPatchFileName: 'file-protocol-standalone/systemjs-file-protocol-patch.js',
      systemJsRetryHookFileName: 'file-protocol-standalone/systemjs-physical-load-retry.js',
      startupSlowNoticeDelayMs,
    }),
    ...(releaseValidation === undefined ? [] : [createFileProtocolStandaloneReleaseValidationPlugin({
      ...releaseValidation,
      sourceAudit: createSourceAuditDiagnostic(sourceAudit),
      workers: normalizedWorkers.map(({ name, entry }) => ({ name, sourceEntry: entry })),
      runtimeFileNames: [systemRuntimeFileName],
    })]),
  ];
}

export const naidanStandaloneWorkerProtocol = Object.freeze({
  initMessageType: INIT_MESSAGE_TYPE,
  readyMessageType: READY_MESSAGE_TYPE,
  errorMessageType: ERROR_MESSAGE_TYPE,
});
