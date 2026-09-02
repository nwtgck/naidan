import { parse } from '@babel/parser';
import type { Binding, NodePath } from '@babel/traverse';
import type { CallExpression, Node, ObjectMethod, ObjectProperty, ReturnStatement } from '@babel/types';
import type { Plugin } from 'vite';
import type {
  RawWorkerConstructorRecord,
  RawWorkerOutputDiagnostic,
  StandaloneBuildDiagnostics,
  WorkerConstructorKind,
} from '../diagnostics.js';
import { isOutputChunk } from '../output-graph.js';
import { isBabelNode, isBabelNodeType, staticMemberPropertyName } from './babel-node.js';
import { babelTraverse } from '../../babel-traverse-runtime.js';
import { profileBuildSync } from '../../../build-profile.js';

type WorkerResolution = Readonly<{kind: WorkerConstructorKind; calleeForm: string}>;
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

function isWorkerConstructorKind(value: string): value is WorkerConstructorKind {
  return value === 'Worker' || value === 'SharedWorker';
}

function isSyntheticMemberPath(value: WorkerValuePath): value is SyntheticMemberPath {
  return 'syntheticMember' in value && value.syntheticMember === true;
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
  const ast = profileBuildSync({
    name: 'standalone.raw-worker.parse',
    sample: { detail: id, inputChars: code.length, items: 1 },
    run: () => parse(code, {
      sourceType: 'unambiguous',
      sourceFilename: id,
      allowAwaitOutsideFunction: true,
      // Rolldown can expose intermediate entry-export shapes to generateBundle.
      // This analysis only needs constructor expressions, so unresolved exports must
      // not turn a compatibility policy into a parser failure. Final output shape
      // validation remains strict elsewhere.
      allowUndeclaredExports: true,
      plugins: ['dynamicImport', 'importMeta', 'topLevelAwait', 'typescript', 'jsx'],
    }),
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

  profileBuildSync({
    name: 'standalone.raw-worker.traverse',
    sample: { detail: id, inputChars: code.length, items: 1 },
    run: () => babelTraverse(ast, {
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
    }),
  });

  return constructors.sort((left, right) => left.start - right.start || left.kind.localeCompare(right.kind));
}

export function createRawWorkerConstructorPolicyPlugin({ diagnostics, allowRawWorkerConstructor, inspectSource }: Readonly<{
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
