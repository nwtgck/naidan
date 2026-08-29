import { parse } from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import type { Node } from '@babel/types';
import path from 'node:path';
import type { Plugin } from 'vite';
import type {
  StandaloneBuildDiagnostics,
  WorkerRealmGlobalDiagnostic,
  WorkerRealmGlobalReference,
} from '../diagnostics.js';
import { collectChunkClosure } from '../output-graph.js';
import type { NormalizedWorkerDefinition } from '../worker-definition.js';
import { isBabelNodeType, staticMemberPropertyName } from './babel-node.js';
import { babelTraverse } from '../../babel-runtime.js';

type AvailabilityState = 'available' | 'unavailable' | 'unknown';
type GlobalObjectPropertyChain = Readonly<{root: string; segments: Array<Readonly<{name: string; optional: boolean}>>}>;

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

export const DEFAULT_UI_ONLY_GLOBALS = Object.freeze([
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

export function createWorkerRealmGlobalGuardPlugin({
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
