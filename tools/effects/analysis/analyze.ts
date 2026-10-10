import { withoutSourceEvidence } from './source-evidence.ts';
import { FRESH_IMAGE } from '../models/browser/dom.ts';
import { selectTidyOwners, type TidySelection } from '../maintenance/selection.ts';
import { evaluateBrowserOperation } from '../models/browser/operations.ts';
import type { OperationDecision } from '../models/operation.ts';
import path from 'node:path';
import { connectWatcherCleanups, type WatcherCleanupUse } from './watcher-cleanups.ts';
import { evaluateVue, isVueOperation, isScalarRefName } from '../models/packages/vue.ts';
import { evaluateNative, type NativeModelContext } from '../models/invoke.ts';
import { discoverWorkerEntries, literalWorkerEntry } from '../bridges/worker-transport.ts';
import ts from 'typescript';
import type { EffectsConfig } from '../config.ts';
import { effectCovered, mergeEffects, printEffect, type Effect } from '../contracts/effects.ts';
import { compareDiagnostics, type EffectDiagnostic, type SourceLocation } from '../diagnostics.ts';
import { readAnnotation, readContractComments, unsafeDirectiveLocations } from '../syntax/annotations.ts';
import { UNSAFE_SUPPRESSION_TAG, type UnsafeEffectSuppression } from '../syntax/suppression.ts';
import { EffectSyntaxError } from '../syntax/expression.ts';
import { solveEffects, type EffectEdge, type EffectSolution } from './solve.ts';
import { containsContract, SCALAR, UNKNOWN, type ContractOwner, type FunctionValue, type Value, type Field } from './values.ts';

import { choiceValue, logicalValue, spreadRecords } from './records.ts';
import { isCallableValue, isRecordValue, isScalarValue, isNativeValue, isPromiseValue, passiveData } from './value-guards.ts';

type Implementation = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
type FunctionInfo = { declaration: Implementation, value: FunctionValue, scope: Map<ts.Symbol, Value> };
export type UnsafeSuppressionAudit = SourceLocation & {
  owner: number,
  label: string,
  reason: string,
  specified: readonly Effect[],
  body: readonly Effect[],
  suppressed: readonly Effect[],
  outward: readonly Effect[],
};
export type EffectOrigin = {
  owner: number,
  effect: Effect,
  location: SourceLocation,
  reason: string,
};
export type EffectsAnalysis = {
  diagnostics: readonly EffectDiagnostic[],
  owners: readonly ContractOwner[],
  solution: EffectSolution,
  dependencies: readonly EffectEdge[],
  origins: readonly EffectOrigin[],
  modelDecisions: readonly OperationDecision[],
  sources: ReadonlyMap<string, string>,
  assumptions: readonly string[],
  unsafeSuppressions: readonly UnsafeSuppressionAudit[],
  coverage: { files: readonly string[], functions: number, excludedTests: readonly string[] },
};

function isImplementation(node: ts.Node): node is Implementation {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

function isFunctionSyntax(node: ts.Node): node is ts.SignatureDeclaration {
  return isImplementation(node) || ts.isFunctionTypeNode(node) || ts.isMethodSignature(node) || ts.isCallSignatureDeclaration(node);
}

function simpleName({ node }: { node: ts.Node | undefined }): string | undefined {
  return node !== undefined && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) ? node.text : undefined;
}

function hasModifier({ node, kind }: { node: ts.Node, kind: ts.SyntaxKind }): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true;
}

/**
 * The first production slice is explicitly fail-closed. It reuses TypeScript for
 * identity and ordinary types, but performs effect variance checks independently.
 * Framework causality and complete heap histories are deliberately not reconstructed.
 */
export class EffectsAnalyzer {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly root: string;
  readonly config: EffectsConfig;
  private readonly nativeModels: NativeModelContext;
  private readonly watcherRegistrations: WatcherCleanupUse[] = [];
  private readonly watcherStops: WatcherCleanupUse[] = [];
  private readonly vueCallbacks: { callable: FunctionValue, node: ts.Node }[] = [];
  readonly owners: ContractOwner[] = [];
  readonly edges: EffectEdge[] = [];
  readonly origins: EffectOrigin[] = [];
  private readonly modelDecisions = new Map<string, OperationDecision>();
  readonly diagnostics: EffectDiagnostic[] = [];
  readonly assumptions = new Set<string>();
  readonly sources = new Map<string, string>();
  private readonly ownerByAnchor = new Map<ts.Node, ContractOwner>();
  private readonly valueByDeclaration = new Map<ts.Node, Value>();
  private readonly functionByDeclaration = new Map<ts.SignatureDeclaration, FunctionValue>();
  private readonly pending: FunctionInfo[] = [];
  private readonly busy = new Set<ts.Node | ts.Type>();
  private readonly moduleOwners = new Map<ts.SourceFile, ContractOwner>();
  private readonly diagnosticKeys = new Set<string>();
  private readonly symbolScope = new Map<ts.Symbol, Value>();
  private readonly excludedTests: string[] = [];
  private readonly activeSources: ts.SourceFile[] = [];
  private readonly workerCreations: { entry: string, owner: ContractOwner | undefined, node: ts.Node }[] = [];
  private readonly workerExposures: { entry: string, contract: ts.Type, declared: Value, api: Value, node: ts.Node }[] = [];
  private readonly workerWraps: { entry: string, contract: ts.Type, declared: Value, node: ts.Node }[] = [];
  private readonly invocations: { callable: FunctionValue, args: readonly Value[], node: ts.Node }[] = [];
  private readonly functionTransfers: { source: FunctionValue, target: FunctionValue }[] = [];
  private readonly returnValues = new Map<number, Value[]>();
  private readonly ownerSuppressions = new Map<number, UnsafeEffectSuppression>();
  private readonly bodyOwners = new Map<number, ContractOwner>();
  private readonly bodyPublicOwners = new Map<number, number>();
  private readonly lexicalScopes = new Map<ts.Node, Map<ts.Symbol, Value>>();

  constructor({ program, root, config }: { program: ts.Program, root: string, config: EffectsConfig }) {
    this.program = program;
    this.checker = program.getTypeChecker();
    this.root = path.resolve(root);
    this.config = config;
    this.nativeModels = {
      config,
      recordOperation: input => {
        const { node, owner, ...decision } = input;
        if (owner === undefined) return; // Shape discovery is not execution.
        const location = this.location({ node });
        const key = `${owner?.id}:${location.file}:${location.start}:${decision.access}:${decision.rule}:${decision.operation}`;
        this.modelDecisions.set(key, { ...location, owner: owner?.id, ...decision });
      },
      registerWatcherCleanup: input => {
        this.watcherRegistrations.push(input);
      },
      consumeWatcherCleanup: input => {
        this.watcherStops.push(input);
      },
      invokeDetached: input => this.invoke({ ...input, cleanupBoundary: true }),
      observeVueCallback: input => {
        this.vueCallbacks.push(input);
      },
      addEffects: input => this.addEffects(input),
      native: input => this.native(input),
      issue: input => this.issue(input),
      invoke: input => this.invoke(input),
      settle: input => this.settle(input),
      compatible: input => this.compatible(input),
      replacementShape: input => this.replacementShape(input),
    };
  }

  location({ node }: { node: ts.Node }): SourceLocation {
    const file = node.getSourceFile();
    return { file: path.resolve(file.fileName), start: node.getStart(file), length: Math.max(1, node.getWidth(file)) };
  }

  issue({ node, message, code }: { node: ts.Node, message: string, code: EffectDiagnostic['code'] }): void {
    const location = this.location({ node });
    const key = `${location.file}:${location.start}:${code}:${message}`;
    if (this.diagnosticKeys.has(key)) return;
    this.diagnosticKeys.add(key);
    this.diagnostics.push({ ...location, code, message, related: [] });
  }

  symbol({ node }: { node: ts.Node }): ts.Symbol | undefined {
    let symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
      : this.checker.getSymbolAtLocation(node);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    return symbol;
  }

  private importedSource({ specifier }: { specifier: ts.Expression }): ts.SourceFile | undefined {
    const declared = this.checker.getSymbolAtLocation(specifier)?.declarations?.find(ts.isSourceFile);
    if (declared !== undefined || !ts.isStringLiteral(specifier)) return declared;
    const resolved = ts.resolveModuleName(specifier.text, specifier.getSourceFile().fileName, this.program.getCompilerOptions(), ts.sys).resolvedModule;
    return resolved === undefined ? undefined : this.program.getSourceFile(resolved.resolvedFileName);
  }

  private lexicalScope({ node }: { node: ts.Node }): Map<ts.Symbol, Value> {
    for (let ancestor: ts.Node | undefined = node.parent; ancestor !== undefined; ancestor = ancestor.parent) {
      const scope = this.lexicalScopes.get(ancestor);
      if (scope !== undefined) return new Map(scope);
    }
    return new Map(this.symbolScope);
  }

  private anchor({ declaration }: { declaration: ts.Node }): ts.Node {
    if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
      if (ts.isPropertyAssignment(declaration.parent)) return declaration.parent;
      if (ts.isVariableDeclaration(declaration.parent)) return this.anchor({ declaration: declaration.parent });
    }
    if (ts.isFunctionTypeNode(declaration) && (ts.isPropertySignature(declaration.parent) || ts.isTypeAliasDeclaration(declaration.parent) || ts.isParameter(declaration.parent))) return declaration.parent;
    if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && declaration.parent.declarations.length === 1 && ts.isVariableStatement(declaration.parent.parent)) return declaration.parent.parent;
    return declaration;
  }

  private owner({ anchor, role, label, symbolic }: {
    anchor: ts.Node, role: ContractOwner['role'], label: string, symbolic: Effect | undefined,
  }): ContractOwner {
    const existing = this.ownerByAnchor.get(anchor);
    if (existing !== undefined) return existing;
    let annotation;
    let suppression: UnsafeEffectSuppression | undefined;
    try {
      switch (role) {
      case 'module': case 'body': break; // Source-file trivia can include the first callable's annotation.
      case 'implementation': case 'signature': case 'slot': case 'symbolic':
        ({ annotation, suppression } = readContractComments({ anchor, definitions: this.config.definitions })); break;
      default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
      }
    } catch (error) {
      if (!(error instanceof EffectSyntaxError)) throw error;
      this.diagnostics.push({ ...this.location({ node: anchor }), start: error.offset, length: 1, code: 'syntax', message: error.message, related: [] });
    }
    const owner: ContractOwner = {
      id: this.owners.length,
      label,
      location: this.location({ node: anchor }),
      anchor,
      role,
      annotation,
      declared: symbolic === undefined ? annotation?.effects ?? [] : [symbolic],
      direct: [],
      callbackPaths: new Set(),
    };
    this.owners.push(owner);
    this.ownerByAnchor.set(anchor, owner);
    if (suppression !== undefined) {
      switch (role) {
      case 'implementation':
        this.ownerSuppressions.set(owner.id, suppression);
        if (owner.declared.some(effect => effectCovered({ effect, allowed: suppression.effects })
          || suppression.effects.some(mask => effectCovered({ effect: mask, allowed: [effect] })))) {
          this.issue({ node: anchor, code: 'boundary', message: 'Public @effects and unsafe suppression must be disjoint; state the remaining public upper bound explicitly.' });
        }
        break;
      case 'slot': case 'signature': case 'symbolic': case 'module': case 'body':
        this.issue({ node: anchor, code: 'boundary', message: 'Unsafe effect suppression requires a checked implementation body, not a slot, alias or type signature.' });
        break;
      default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
      }
    }
    return owner;
  }

  /** Keep assignment constraints on the public owner: they are never masked. */
  private createSuppressedBody({ owner }: { owner: ContractOwner }): void {
    const directive = this.ownerSuppressions.get(owner.id);
    if (directive === undefined || this.bodyOwners.has(owner.id)) return;
    const body: ContractOwner = {
      id: this.owners.length,
      label: `${owner.label} <body>`,
      location: owner.location,
      anchor: owner.anchor,
      annotation: undefined,
      role: 'body',
      declared: [],
      direct: [],
      callbackPaths: owner.callbackPaths,
    };
    this.owners.push(body);
    this.bodyOwners.set(owner.id, body);
    this.bodyPublicOwners.set(body.id, owner.id);
    this.edges.push({
      source: body.id,
      target: owner.id,
      bindings: new Map(),
      location: {
        file: owner.location.file,
        start: directive.start,
        length: directive.end - directive.start,
      },
      reason: 'implementation after explicit unsafe suppression',
      suppress: directive.effects,
    });
  }

  private addEffects({ owner, effects, node, reason }: {
    owner: ContractOwner | undefined, effects: readonly Effect[], node: ts.Node, reason: string,
  }): void {
    if (owner === undefined) return;
    owner.direct = mergeEffects({ groups: [owner.direct, effects] });
    for (const effect of effects) this.origins.push({ owner: owner.id, effect, location: this.location({ node }), reason });
  }

  private link({ source, target, node, reason, bindings, cleanupBoundary }: {
    source: ContractOwner, target: ContractOwner | undefined, node: ts.Node, reason: string, bindings: ReadonlyMap<string, number>, cleanupBoundary?: true,
  }): void {
    if (target === undefined) return;
    this.edges.push({ source: source.id, target: target.id, bindings, location: this.location({ node }), reason, ...(cleanupBoundary ? { cleanupBoundary } : {}) });
  }

  private native({ name, receiver }: { name: string, receiver: Value | undefined }): Value {
    return { kind: 'native', name, receiver };
  }

  private isLibraryDeclaration({ declaration }: { declaration: ts.Node }): boolean {
    return this.program.isSourceFileDefaultLibrary(declaration.getSourceFile());
  }

  private isVueDeclaration({ declaration }: { declaration: ts.Node }): boolean {
    return this.config.vueModels.some(model => path.resolve(this.root, model.file) === path.resolve(declaration.getSourceFile().fileName));
  }

  private vueExport({ symbol }: { symbol: ts.Symbol }): Value | undefined {
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0 || !declarations.every(declaration => this.isVueDeclaration({ declaration }))) return undefined;
    if (!isVueOperation(symbol.name)) return undefined;
    for (const declaration of declarations) {
      const model = this.config.vueModels.find(candidate => path.resolve(this.root, candidate.file) === path.resolve(declaration.getSourceFile().fileName))!;
      this.assumptions.add(`Vue boundary: ${model.file} (${model.sha256}); reactive causality is intentionally not propagated.`);
    }
    return this.native({ name: `vue:${symbol.name}`, receiver: undefined });
  }

  private typeValue({ type, anchor, callbackPath, depth }: {
    type: ts.Type, anchor: ts.Node, callbackPath: readonly string[] | undefined, depth: number,
  }): Value {
    if (depth > 24) {
      this.issue({ node: anchor, code: 'unsupported', message: 'Effect type nesting exceeds the supported depth.' }); return UNKNOWN;
    }
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Conditional)) return UNKNOWN;
    if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) {
      return type.isStringLiteral() ? { kind: 'scalar', keys: [type.value], truthiness: type.value.length === 0 ? 'falsy' : 'truthy' } : SCALAR;
    }
    if (type.isUnion()) {
      const values = type.types.map(item => this.typeValue({ type: item, anchor, callbackPath, depth: depth + 1 }));
      if (values.every(value => value.kind === 'scalar')) return { kind: 'scalar', keys: values.every(value => value.keys !== undefined) ? values.flatMap(value => value.keys ?? []) : undefined, truthiness: 'unknown' };
      return { kind: 'choice', values };
    }
    const name = type.getSymbol()?.name;
    const declarations = type.getSymbol()?.getDeclarations() ?? [];
    const library = declarations.length > 0 && declarations.every(declaration => this.isLibraryDeclaration({ declaration }));
    if (name === 'Ref' && declarations.length > 0 && declarations.every(declaration => this.isVueDeclaration({ declaration }))) {
      const [inner] = this.checker.getTypeArguments(type as ts.TypeReference);
      if (inner === undefined || !isScalarValue(this.typeValue({ type: inner, anchor, callbackPath: undefined, depth: depth + 1 }))) {
        this.issue({ node: anchor, code: 'unsupported', message: 'The initial Vue model supports scalar Ref payloads only.' }); return UNKNOWN;
      }
      return this.native({ name: 'vue:unverified-ref', receiver: undefined });
    }
    if (library && name === 'Promise' && type.flags & ts.TypeFlags.Object) {
      const [inner] = this.checker.getTypeArguments(type as ts.TypeReference);
      return { kind: 'promise', value: inner === undefined ? UNKNOWN : this.typeValue({ type: inner, anchor, callbackPath: undefined, depth: depth + 1 }) };
    }
    if (library && name !== undefined && ['FileSystemDirectoryHandle', 'FileSystemFileHandle', 'FileSystemWritableFileStream', 'FileSystemSyncAccessHandle', 'Response', 'Headers', 'AbortSignal', 'Error', 'DOMException', 'Blob', 'File', 'HTMLImageElement', 'Location', 'Window', 'BroadcastChannel'].includes(name)) {
      return this.native({ name, receiver: undefined });
    }
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
      const elementTypes = this.checker.getTypeArguments(type as ts.TypeReference);
      const values = elementTypes.map(item => this.typeValue({ type: item, anchor, callbackPath: undefined, depth: depth + 1 }));
      if (values.some(value => containsContract({ value, seen: new Set() }))) this.issue({ node: anchor, code: 'unsupported', message: 'Arrays containing effect contracts need an explicit element-slot model.' });
      return this.native({ name: 'Array', receiver: SCALAR });
    }
    const signatures = type.getCallSignatures();
    if (signatures.length > 0) {
      if (signatures.length !== 1 || signatures[0]!.declaration === undefined || !isFunctionSyntax(signatures[0]!.declaration)) {
        this.issue({ node: anchor, code: 'unsupported', message: 'Overloaded or declaration-less effect callables require an explicit boundary model.' });
        return UNKNOWN;
      }
      if (callbackPath !== undefined) {
        const signature = signatures[0]!;
        let explicit;
        try {
          explicit = readAnnotation({ anchor, definitions: this.config.definitions });
        } catch { /* The owner reports syntax errors. */ }
        const owner = this.owner({ anchor, role: explicit === undefined ? 'symbolic' : 'signature', label: callbackPath.join('.'), symbolic: explicit === undefined ? { kind: 'callback', path: callbackPath } : undefined });
        return {
          kind: 'function',
          owner,
          transport: 'local',
          declaration: signature.declaration !== undefined && isFunctionSyntax(signature.declaration) ? signature.declaration : undefined,
          parameters: signature.parameters.map(parameter => this.typeValue({ type: this.checker.getTypeOfSymbolAtLocation(parameter, anchor), anchor: parameter.valueDeclaration ?? anchor, callbackPath: undefined, depth: depth + 1 })),
          returns: this.typeValue({ type: this.checker.getReturnTypeOfSignature(signature), anchor, callbackPath: undefined, depth: depth + 1 }),
        };
      }
      const declaration = signatures[0]!.declaration;
      if (declaration === undefined || !isFunctionSyntax(declaration)) return UNKNOWN;
      return this.functionValue({ declaration, inheritedScope: this.lexicalScope({ node: declaration }) });
    }
    if (this.busy.has(type)) return UNKNOWN;
    this.busy.add(type);
    const fields = new Map<string, Field>();
    for (const property of type.getProperties()) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (declaration === undefined) continue;
      if (ts.isGetAccessor(declaration) || ts.isSetAccessor(declaration)) {
        this.issue({ node: declaration, code: 'unsupported', message: 'Accessors need an explicit effect model; they are not passive data properties.' });
        fields.set(property.name, { value: UNKNOWN, access: 'writable' });
        continue;
      }
      const value = this.typeValue({
        type: this.checker.getTypeOfSymbolAtLocation(property, anchor),
        anchor: declaration,
        callbackPath: callbackPath === undefined ? undefined : [...callbackPath, property.name],
        depth: depth + 1,
      });
      fields.set(property.name, { value, access: hasModifier({ node: declaration, kind: ts.SyntaxKind.ReadonlyKeyword }) ? 'readonly' : 'writable' });
    }
    this.busy.delete(type);
    const indexType = type.getStringIndexType();
    return { kind: 'record', fields, shape: 'open', reflected: undefined, indexValue: indexType === undefined ? undefined : this.typeValue({ type: indexType, anchor, callbackPath: undefined, depth: depth + 1 }) };
  }

  private bindPattern({ name, value, scope, owner }: { name: ts.BindingName, value: Value, scope: Map<ts.Symbol, Value>, owner: ContractOwner | undefined }): void {
    if (ts.isIdentifier(name)) {
      const symbol = this.symbol({ node: name });
      if (symbol !== undefined) scope.set(symbol, value);
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      // Scalar array elements are handled by the ordinary TypeScript checker.
      for (const item of name.elements) if (ts.isBindingElement(item)) this.bindPattern({
        name: item.name,
        value: this.typeValue({ type: this.checker.getTypeAtLocation(item.name), anchor: item, callbackPath: undefined, depth: 0 }),
        scope,
        owner,
      });
      return;
    }
    for (const item of name.elements) {
      if (item.dotDotDotToken !== undefined) this.issue({ node: item, code: 'unsupported', message: 'Object rest requires a checked own-property shape.' });
      const key = simpleName({ node: item.propertyName ?? item.name });
      const field = key === undefined || value.kind !== 'record' ? undefined : value.fields.get(key);
      // Native binding reads (notably document.cookie and Storage.length) are
      // operations too. Do not lose them merely because there is no dot access.
      const member = key !== undefined && (value.kind === 'native' || value.kind === 'choice')
        ? this.property({ receiver: value, key, node: item, owner }) : field?.value ?? UNKNOWN;
      this.bindPattern({ name: item.name, value: member, scope, owner });
    }
  }

  /** Default initializers execute on entry and must also fit their destination contract. */
  private parameterDefaults({ parameter, expected, owner, scope }: {
    parameter: ts.ParameterDeclaration, expected: Value, owner: ContractOwner, scope: Map<ts.Symbol, Value>,
  }): void {
    const check = ({ initializer, target }: { initializer: ts.Expression, target: Value }): void => {
      const source = this.expression({ expression: initializer, owner, scope });
      this.compatible({ source, target, node: initializer, mode: ts.isObjectLiteralExpression(initializer) ? 'value' : 'shared' });
    };
    const visit = ({ name, target }: { name: ts.BindingName, target: Value }): void => {
      if (ts.isIdentifier(name)) return;
      for (const element of name.elements) {
        if (!ts.isBindingElement(element)) continue;
        const key = simpleName({ node: element.propertyName ?? element.name });
        const field = isRecordValue(target) && key !== undefined ? target.fields.get(key)?.value
          : isNativeValue(target) && target.name === 'Array' ? target.receiver : undefined;
        if (element.initializer !== undefined) check({ initializer: element.initializer, target: field ?? UNKNOWN });
        visit({ name: element.name, target: field ?? UNKNOWN });
      }
    };
    if (parameter.initializer !== undefined) check({ initializer: parameter.initializer, target: expected });
    visit({ name: parameter.name, target: expected });
  }

  private functionValue({ declaration, inheritedScope }: { declaration: ts.SignatureDeclaration, inheritedScope: Map<ts.Symbol, Value> }): FunctionValue {
    const cached = this.functionByDeclaration.get(declaration);
    if (cached !== undefined) return cached;
    const anchor = this.anchor({ declaration });
    const owner = this.owner({ anchor, role: isImplementation(declaration) ? 'implementation' : 'signature', label: simpleName({ node: declaration.name }) ?? (ts.isVariableDeclaration(declaration.parent) || ts.isPropertyAssignment(declaration.parent) ? simpleName({ node: declaration.parent.name }) : undefined) ?? '<anonymous>', symbolic: undefined });
    const value: FunctionValue = { kind: 'function', owner, parameters: [], returns: UNKNOWN, declaration, transport: 'local' };
    this.functionByDeclaration.set(declaration, value);
    const scope = new Map(inheritedScope);
    value.parameters = declaration.parameters.map((parameter, index) => {
      if (parameter.dotDotDotToken !== undefined) this.issue({ node: parameter, code: 'unsupported', message: 'Rest-parameter contract forwarding is not implemented yet.' });
      const type = this.checker.getTypeAtLocation(parameter);
      const result = this.typeValue({ type, anchor: parameter, callbackPath: [`arg${index}`], depth: 0 });
      this.bindPattern({ name: parameter.name, value: result, scope, owner: undefined });
      return result;
    });
    this.lexicalScopes.set(declaration, scope);
    const tokens = new Set<string>();
    const collect = ({ item }: { item: Value }): void => {
      switch (item.kind) {
      case 'function':
        for (const effect of item.owner.declared) {
          switch (effect.kind) {
          case 'callback': tokens.add(printEffect({ effect })); break;
          case 'operation': break;
          default: { const exhaustive: never = effect; throw new Error(String(exhaustive)); }
          }
        }
        break;
      case 'record': for (const field of item.fields.values()) collect({ item: field.value }); break;
      case 'scalar': case 'native': case 'unknown': case 'promise': case 'choice': break;
      default: { const exhaustive: never = item; throw new Error(String(exhaustive)); }
      }
    };
    for (const parameter of value.parameters) collect({ item: parameter });
    // Closures may use lexical callback contracts; a stored fixed contract cannot acquire them implicitly.
    for (const captured of inheritedScope.values()) collect({ item: captured });
    owner.callbackPaths = tokens;
    for (const effect of owner.declared) if (effect.kind === 'callback' && !tokens.has(printEffect({ effect }))) {
      this.issue({ node: anchor, code: 'syntax', message: `Unbound effect reference: ${printEffect({ effect })}.` });
    }
    if (declaration.type !== undefined) {
      value.returns = this.typeValue({ type: this.checker.getTypeFromTypeNode(declaration.type), anchor: declaration.type, callbackPath: undefined, depth: 0 });
    } else {
      const signature = this.checker.getSignatureFromDeclaration(declaration);
      if (signature !== undefined) value.returns = this.typeValue({ type: this.checker.getReturnTypeOfSignature(signature), anchor: declaration, callbackPath: undefined, depth: 0 });
    }
    if (isImplementation(declaration) && declaration.body !== undefined) {
      this.createSuppressedBody({ owner });
      this.pending.push({ declaration, value, scope });
    }
    return value;
  }

  private declaredValue({ declaration, scope }: { declaration: ts.Declaration, scope: Map<ts.Symbol, Value> }): Value {
    const cached = this.valueByDeclaration.get(declaration);
    if (cached !== undefined) return cached;
    if (this.busy.has(declaration)) return UNKNOWN;
    this.busy.add(declaration);
    let result: Value = UNKNOWN;
    if (isFunctionSyntax(declaration)) {
      result = this.functionValue({ declaration, inheritedScope: scope });
    } else if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isParameter(declaration)) {
      const initializer = declaration.initializer;
      if (initializer !== undefined) {
        const source = this.expression({ expression: initializer, owner: undefined, scope });
        const target = 'type' in declaration && declaration.type !== undefined
          ? this.typeValue({ type: this.checker.getTypeFromTypeNode(declaration.type), anchor: declaration, callbackPath: undefined, depth: 0 }) : source;
        if (target !== source) this.compatible({ source, target, node: declaration, mode: ts.isObjectLiteralExpression(initializer) ? 'value' : 'shared' });
        result = target;
        const stable = ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
          && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && ts.isIdentifier(declaration.name);
        // Type annotations do not create evidence, but do not erase evidence of
        // an evaluated immutable const string/image either. Mutable cells and
        // reflected object copies may no longer use their initial URL facts.
        if (stable && source.kind === 'scalar' && target.kind === 'scalar') result = source;
        if (stable && isNativeValue(source) && source.name === FRESH_IMAGE && isNativeValue(target) && target.name === 'HTMLImageElement') result = source;
        if (isNativeValue(target) && target.name === 'vue:unverified-ref' && isNativeValue(source) && source.name === 'vue:scalar-ref') result = source;
        if (target !== source && target.kind === 'record' && source.kind === 'record') {
          const isConst = ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
          result = { ...target, reflected: isConst ? source : undefined };
        }
        const anchor = this.anchor({ declaration });
        let annotation;
        try {
          annotation = readAnnotation({ anchor, definitions: this.config.definitions });
        } catch (error) {
          if (!(error instanceof EffectSyntaxError)) throw error;
          this.issue({ node: anchor, code: 'syntax', message: error.message });
        }
        if (annotation !== undefined && source.kind !== 'function') this.issue({ node: anchor, code: 'syntax', message: 'An effect contract must belong to a callable or callable storage slot.' });
        if (annotation !== undefined && source.kind === 'function' && source.owner.anchor !== anchor) {
          const owner = this.owner({ anchor, role: 'slot', label: simpleName({ node: declaration.name }) ?? '<slot>', symbolic: undefined });
          const destination: FunctionValue = { ...source, owner };
          this.compatible({ source, target: destination, node: declaration, mode: 'value' });
          result = destination;
        }
      } else if (ts.isParameter(declaration)) {
        const symbol = this.symbol({ node: declaration.name });
        result = symbol === undefined ? UNKNOWN : scope.get(symbol) ?? UNKNOWN;
      }
    } else if (ts.isBindingElement(declaration)) {
      const symbol = this.symbol({ node: declaration.name });
      result = symbol === undefined ? UNKNOWN : scope.get(symbol) ?? UNKNOWN;
    } else if (ts.isPropertySignature(declaration) && declaration.type !== undefined) {
      result = this.typeValue({ type: this.checker.getTypeFromTypeNode(declaration.type), anchor: declaration, callbackPath: undefined, depth: 0 });
    } else if (ts.isSourceFile(declaration)) {
      const symbol = this.checker.getSymbolAtLocation(declaration);
      const fields = new Map<string, Field>();
      for (const member of symbol === undefined ? [] : this.checker.getExportsOfModule(symbol)) {
        const resolved = member.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(member) : member;
        const target = resolved.valueDeclaration;
        if (target !== undefined) fields.set(member.name, { value: this.vueExport({ symbol: resolved }) ?? (!target.getSourceFile().isDeclarationFile && this.sources.has(path.resolve(target.getSourceFile().fileName)) ? this.declaredValue({ declaration: target, scope }) : UNKNOWN), access: 'readonly' });
      }
      result = { kind: 'record', fields, shape: 'closed', reflected: undefined, indexValue: undefined };
    }
    const immutableStringBinding = ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && ts.isIdentifier(declaration.name);
    if (!immutableStringBinding || result.kind === 'record') result = withoutSourceEvidence({ value: result });
    this.busy.delete(declaration);
    this.valueByDeclaration.set(declaration, result);
    return result;
  }

  private identifier({ expression, scope }: { expression: ts.Identifier, scope: Map<ts.Symbol, Value> }): Value {
    const symbol = this.symbol({ node: expression });
    if (symbol === undefined) return UNKNOWN;
    const bound = scope.get(symbol);
    if (bound !== undefined) return bound;
    const declarations = symbol.declarations ?? [];
    // Intrinsic undefined has no declaration. A parameter/local/import with the
    // same spelling can hold executable conversion hooks and must keep its value.
    if (symbol.name === 'undefined' && declarations.length === 0 && (symbol.flags & ts.SymbolFlags.Transient) !== 0) return SCALAR;
    // TypeScript represents the intrinsic globalThis namespace without source
    // declarations. A local parameter/binding named globalThis has declarations
    // and must keep its ordinary contract instead of becoming a native root.
    if (symbol.name === 'globalThis' && declarations.length === 0 && (symbol.flags & ts.SymbolFlags.ValueModule) !== 0) {
      return this.native({ name: 'globalThis', receiver: undefined });
    }
    if (declarations.length > 0 && declarations.every(declaration => this.isLibraryDeclaration({ declaration }))) return this.native({ name: symbol.name, receiver: undefined });
    const vue = this.vueExport({ symbol });
    if (vue !== undefined) return vue;
    const declaration = symbol.valueDeclaration ?? declarations[0];
    if (declaration === undefined) return UNKNOWN;
    const transport = this.config.workerTransports.find(candidate => path.resolve(this.root, candidate.file) === path.resolve(declaration.getSourceFile().fileName));
    if (transport !== undefined) {
      this.assumptions.add(`Worker transport: ${transport.file} (${transport.sha256})`);
      if (symbol.name === transport.wrapExport) return this.native({ name: 'worker:wrap', receiver: undefined });
      if (symbol.name === transport.exposeExport) return this.native({ name: 'worker:expose', receiver: undefined });
      this.issue({ node: expression, code: 'boundary', message: `Unmodeled transport export: ${symbol.name}.` });
      return UNKNOWN;
    }
    const model = this.config.models.find(candidate => path.resolve(this.root, candidate.file) === path.resolve(declaration.getSourceFile().fileName) && candidate.export === symbol.name);
    if (model !== undefined) {
      this.assumptions.add(`${model.file}#${model.export} (${model.sha256})`);
      switch (model.returnValue) {
      case 'scalar-value': return SCALAR;
      case 'scalar': case 'promise-scalar': return this.native({ name: `model:${model.file}#${model.export}`, receiver: undefined });
      default: { const exhaustive: never = model.returnValue; throw new Error(String(exhaustive)); }
      }
    }
    if (declaration.getSourceFile().isDeclarationFile && !ts.isSourceFile(declaration)) {
      this.issue({ node: expression, code: 'boundary', message: `Ambient value ${symbol.name} needs a reviewed effect model; a declaration is not an implementation.` });
      return UNKNOWN;
    }
    if (declaration.getSourceFile().fileName.endsWith('.test.ts')) {
      this.issue({ node: expression, code: 'boundary', message: 'Production effect contracts cannot depend on excluded test implementations.' });
      return UNKNOWN;
    }
    if (!this.sources.has(path.resolve(declaration.getSourceFile().fileName)) && !ts.isSourceFile(declaration)) {
      this.issue({ node: expression, code: 'boundary', message: `No reviewed effect model for ${symbol.name} from ${declaration.getSourceFile().fileName}.` });
      return UNKNOWN;
    }
    return this.declaredValue({ declaration, scope });
  }

  private compatible({ source, target, node, mode }: {
    source: Value, target: Value, node: ts.Node, mode: 'value' | 'shared',
  }): void {
    this.compatibleValue({ source, target, node, mode, depth: 0 });
  }

  private compatibleValue({ source, target, node, mode, depth }: {
    source: Value, target: Value, node: ts.Node, mode: 'value' | 'shared', depth: number,
  }): void {
    if (depth > 24) {
      this.issue({ node, code: 'unsupported', message: 'Recursive effect compatibility requires an explicit contract.' }); return;
    }
    if (source === target) return;
    if (target.kind === 'choice' && source.kind !== 'choice') {
      // Optional scalar alternatives do not erase the sole effect-bearing shape.
      // Multiple callable/object alternatives still need a more precise union model.
      const candidates = target.values.filter(value => isScalarValue(source) ? isScalarValue(value) : !isScalarValue(value));
      if (candidates.length === 1) {
        this.compatibleValue({ source, target: candidates[0]!, node, mode, depth: depth + 1 }); return;
      }
    }
    switch (source.kind) {
    case 'choice':
      for (const item of source.values) this.compatibleValue({ source: item, target, node, mode, depth: depth + 1 });
      return;
    case 'scalar': if (target.kind === source.kind) return; break;
    case 'native':
      if (isNativeValue(target) && (source.name === 'vue:watch-handle' || source.name.startsWith('vue:handle-')) && source.receiver !== target.receiver) {
        this.issue({ node, code: 'unsupported', message: 'Replacing a Vue watch handle needs an explicit lifetime slot contract; it cannot retain an earlier callback bound.' }); return;
      }
      if (isNativeValue(target) && source.name === 'vue:scalar-ref' && target.name === 'vue:unverified-ref') return;
      if (isNativeValue(target) && source.name === FRESH_IMAGE && target.name === 'HTMLImageElement') return;
      if (target.kind === source.kind && source.name === target.name) return; break;
    case 'unknown': break;
    case 'promise':
      if (target.kind !== source.kind) break;
      this.compatibleValue({ source: source.value, target: target.value, node, mode: 'value', depth: depth + 1 });
      return;
    case 'function': {
      if (target.kind !== source.kind) break;
      this.link({ source: source.owner, target: target.owner, node, reason: 'assigned callable', bindings: new Map() });
      this.functionTransfers.push({ source, target });
      if (source.parameters.length !== target.parameters.length) {
        this.issue({ node, code: 'unsupported', message: 'Effectful callable arity conversion is not implemented.' }); return;
      }
      for (let index = 0; index < source.parameters.length; index++) {
        this.compatibleValue({ source: target.parameters[index]!, target: source.parameters[index]!, node, mode: 'shared', depth: depth + 1 });
      }
      this.compatibleValue({ source: source.returns, target: target.returns, node, mode: 'value', depth: depth + 1 });
      return;
    }
    case 'record': {
      if (target.kind !== source.kind) break;
      for (const [key, expected] of target.fields) {
        const actual = source.fields.get(key);
        if (actual === undefined) {
          this.issue({ node, code: 'unsupported', message: `Missing effect member: ${key}.` }); continue;
        }
        if (expected.access === 'writable' && actual.access === 'readonly' && containsContract({ value: expected.value, seen: new Set() })) {
          this.issue({ node, code: 'unsupported', message: `A readonly effect slot cannot become writable: ${key}.` });
        }
        this.compatibleValue({ source: actual.value, target: expected.value, node, mode: 'shared', depth: depth + 1 });
        if (mode === 'shared' && expected.access === 'writable') this.compatibleValue({ source: expected.value, target: actual.value, node, mode: 'shared', depth: depth + 1 });
      }
      return;
    }
    default: { const exhaustive: never = source; throw new Error(String(exhaustive)); }
    }
    this.issue({ node, code: 'unsupported', message: `Unsupported or unresolved effect value conversion: ${source.kind} to ${target.kind}.` });
  }

  private bindCallbacks({ actual, formal, bindings, node }: { actual: Value, formal: Value, bindings: Map<string, number>, node: ts.Node }): void {
    if (formal.kind === 'function' && actual.kind === 'function') {
      switch (formal.owner.role) {
      case 'symbolic':
        for (const token of formal.owner.declared) bindings.set(printEffect({ effect: token }), actual.owner.id);
        break;
      case 'implementation': case 'slot': case 'signature': case 'module': case 'body':
        this.compatible({ source: actual, target: formal, node, mode: 'value' }); break;
      default: { const exhaustive: never = formal.owner.role; throw new Error(String(exhaustive)); }
      }
      return;
    }
    if (formal.kind === 'record' && actual.kind === 'record') {
      for (const [key, field] of formal.fields) {
        const source = actual.fields.get(key);
        if (source !== undefined) this.bindCallbacks({ actual: source.value, formal: field.value, bindings, node });
        else if (containsContract({ value: field.value, seen: new Set() })) this.issue({ node, code: 'unsupported', message: `Unresolved callback argument: ${key}.` });
      }
    } else if (!isScalarValue(formal) || !isScalarValue(actual)) {
      this.compatible({ source: actual, target: formal, node, mode: 'value' });
    }
  }

  private invoke({ callable, args, owner, node, cleanupBoundary }: { callable: Value, args: readonly Value[], owner: ContractOwner | undefined, node: ts.Node, cleanupBoundary?: true }): Value {
    switch (callable.kind) {
    case 'function': {
      this.invocations.push({ callable, args, node });
      const bindings = new Map<string, number>();
      for (let index = 0; index < callable.parameters.length; index++) {
        const actual = args[index];
        if (actual !== undefined) this.bindCallbacks({ actual, formal: callable.parameters[index]!, bindings, node });
      }
      this.link({ source: callable.owner, target: owner, node, reason: 'function call', bindings, ...(cleanupBoundary ? { cleanupBoundary } : {}) });
      return callable.returns;
    }
    case 'native': return this.invokeNative({ callable, args, owner, node });
    case 'choice': return { kind: 'choice', values: callable.values.map(value => this.invoke({ callable: value, args, owner, node, ...(cleanupBoundary ? { cleanupBoundary } : {}) })) };
    case 'record': case 'promise': case 'scalar': case 'unknown':
      this.issue({ node, code: 'unsupported', message: 'The call target has no checked effect contract.' }); return UNKNOWN;
    default: { const exhaustive: never = callable; throw new Error(String(exhaustive)); }
    }
  }

  private settle({ value, node }: { value: Value, node: ts.Node }): Value {
    switch (value.kind) {
    case 'promise': return value.value;
    case 'scalar': return value;
    case 'choice': return { kind: 'choice', values: value.values.map(item => this.settle({ value: item, node })) };
    case 'record': if (value.shape === 'closed' && !value.fields.has('then')) return value; break;
    case 'function': if (value.declaration !== undefined && isImplementation(value.declaration)) return value; break;
    case 'native':
      if (value.name.startsWith('opfs.') || value.name.startsWith('hostfs.') || value.name.startsWith('FileSystem') || value.name === 'Response') return value;
      break;
    case 'unknown': break;
    default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
    }
    this.issue({ node, code: 'unsupported', message: 'Unverified Promise settlement: the value may have an executable or hidden then member.' });
    return UNKNOWN;
  }

  private invokeNative({ callable, args, owner, node }: { callable: Extract<Value, { kind: 'native' }>, args: readonly Value[], owner: ContractOwner | undefined, node: ts.Node }): Value {
    const name = callable.name;
    const promise = ({ value }: { value: Value }): Value => ({ kind: 'promise', value });
    if (name === 'worker:wrap' || name === 'worker:expose') {
      if (!ts.isCallExpression(node) || node.typeArguments?.length !== 1 || !isRecordValue(args[0])) {
        this.issue({ node, code: 'boundary', message: 'The worker bridge requires one explicit shared type and a named argument object.' }); return UNKNOWN;
      }
      const contract = this.checker.getTypeFromTypeNode(node.typeArguments[0]!);
      const declared = this.typeValue({ type: contract, anchor: node.typeArguments[0]!, callbackPath: undefined, depth: 0 });
      if (!isRecordValue(declared)) {
        this.issue({ node, code: 'boundary', message: 'The shared worker contract must be a method record.' }); return UNKNOWN;
      }
      const endpoint = args[0].fields.get('endpoint')?.value;
      switch (name) {
      case 'worker:expose': {
        const api = args[0].fields.get('api')?.value;
        const rawArgument = node.arguments[0];
        const rawEndpoint = rawArgument !== undefined && ts.isObjectLiteralExpression(rawArgument)
          ? rawArgument.properties.find(property => ts.isPropertyAssignment(property) && simpleName({ node: property.name }) === 'endpoint') : undefined;
        if (api === undefined || rawEndpoint === undefined || !ts.isPropertyAssignment(rawEndpoint) || !ts.isIdentifier(rawEndpoint.initializer) || rawEndpoint.initializer.text !== 'undefined') {
          this.issue({ node, code: 'boundary', message: 'Only explicit default-worker exposure (endpoint: undefined) is implemented.' }); return UNKNOWN;
        }
        this.workerExposures.push({ entry: path.resolve(node.getSourceFile().fileName), contract, declared, api, node });
        return SCALAR;
      }
      case 'worker:wrap': break;
      default: { const exhaustive: never = name; throw new Error(String(exhaustive)); }
      }
      if (endpoint?.kind !== 'native' || !endpoint.name.startsWith('worker-endpoint:')) {
        this.issue({ node, code: 'boundary', message: 'The worker endpoint has no verified entry identity.' }); return UNKNOWN;
      }
      const entry = endpoint.name.slice('worker-endpoint:'.length);
      this.workerWraps.push({ entry, contract, declared, node });
      const fields = new Map<string, Field>();
      for (const [key, field] of declared.fields) {
        if (field.value.kind !== 'function' || key === 'then' || key === 'bind') {
          this.issue({ node, code: 'boundary', message: `Unsupported or reserved remote member: ${key}.` }); continue;
        }
        const value: FunctionValue = { ...field.value, transport: 'worker', returns: isPromiseValue(field.value.returns) ? field.value.returns : promise({ value: field.value.returns }) };
        fields.set(key, { value, access: 'readonly' });
      }
      return { kind: 'record', fields, shape: 'closed', reflected: undefined, indexValue: undefined };
    }
    if (name.startsWith('vue:')) return evaluateVue({ context: this.nativeModels, callable, args, owner, node });
    return evaluateNative({ context: this.nativeModels, callable, args, owner, node });
  }

  private property({ receiver, key, node, owner }: { receiver: Value, key: string, node: ts.Node, owner: ContractOwner | undefined }): Value {
    switch (receiver.kind) {
    case 'record': {
      const field = receiver.fields.get(key);
      if (field !== undefined) return field.value;
      this.issue({ node, code: 'unsupported', message: `Property ${key} is outside the checked object contract.` }); return UNKNOWN;
    }
    case 'choice': return { kind: 'choice', values: receiver.values.map(value => this.property({ receiver: value, key, node, owner })) };
    case 'promise': return this.native({ name: `Promise.${key}`, receiver });
    case 'native': {
      const prefix = receiver.name;
      if (isScalarRefName(prefix)) {
        if (prefix === 'vue:scalar-ref' && key === 'value') return SCALAR;
        this.issue({ node, code: 'unsupported', message: 'Vue Ref access requires a proven scalar ref creation, not only a Ref type or custom accessor.' }); return UNKNOWN;
      }
      if (prefix === 'vue:watch-handle') {
        if (key === 'stop' || key === 'pause' || key === 'resume') return this.native({ name: `vue:handle-${key}`, receiver: receiver.receiver });
        this.issue({ node, code: 'unsupported', message: `Unmodeled Vue watch handle member: ${key}.` }); return UNKNOWN;
      }
      // An explicit Window endpoint is not a worker's ambient postMessage/self.
      // Keep library identity checks from identifier/typeValue; local lookalikes
      // still use ordinary record/callable contracts.
      if (['window', 'parent', 'top', 'opener', 'Window'].includes(prefix) && key === 'postMessage') {
        return this.native({ name: 'Window.postMessage', receiver });
      }
      if (prefix === 'window' || prefix === 'globalThis' || prefix === 'self') return this.native({ name: key, receiver: undefined });
      const modeled = evaluateBrowserOperation({ context: this.nativeModels, callable: { kind: 'native', name: `${prefix}.${key}`, receiver }, args: [], owner, node, access: 'read' });
      if (modeled !== undefined) return modeled;
      if (['Error', 'DOMException'].includes(prefix) && ['name', 'message', 'stack'].includes(key)) return SCALAR;
      return this.native({ name: `${prefix}.${key}`, receiver });
    }
    case 'scalar': {
      const symbol = this.symbol({ node });
      const declaration = symbol?.declarations?.[0];
      if (declaration !== undefined && this.isLibraryDeclaration({ declaration })) {
        const parent = declaration.parent;
        const family = 'name' in parent && parent.name !== undefined && ts.isIdentifier(parent.name as ts.Node) ? (parent.name as ts.Identifier).text : undefined;
        if (ts.isPropertySignature(declaration)) return SCALAR;
        if (family !== undefined && ['String', 'Number', 'Boolean', 'Array', 'ReadonlyArray'].includes(family)) return this.native({ name: `${family === 'ReadonlyArray' ? 'Array' : family}.${key}`, receiver });
      }
      return UNKNOWN;
    }
    case 'function': case 'unknown':
      this.issue({ node, code: 'unsupported', message: `Unverified property access: ${key}.` }); return UNKNOWN;
    default: { const exhaustive: never = receiver; throw new Error(String(exhaustive)); }
    }
  }

  private record({ expression, owner, scope }: { expression: ts.ObjectLiteralExpression, owner: ContractOwner | undefined, scope: Map<ts.Symbol, Value> }): Value {
    const fields = new Map<string, Field>();
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const value = this.expression({ expression: property.expression, owner, scope });
        const source = spreadRecords({ value });
        if (source === undefined) {
          this.issue({ node: property, code: 'unsupported', message: 'Object spread needs a known own-property shape, not only a structural TypeScript view.' }); continue;
        }
        for (const [key, field] of source.fields) {
          const previous = fields.get(key);
          if (previous !== undefined) this.compatible({ source: field.value, target: previous.value, node: property, mode: 'value' });
          else fields.set(key, { ...field, access: 'writable' });
        }
        continue;
      }
      const key = simpleName({ node: property.name });
      if (key === undefined || key === '__proto__' || ts.isGetAccessor(property) || ts.isSetAccessor(property)) {
        this.issue({ node: property, code: 'unsupported', message: 'Computed properties, accessors and prototype mutation require a model.' }); continue;
      }
      let value: Value;
      if (ts.isShorthandPropertyAssignment(property)) value = this.identifier({ expression: property.name, scope });
      else if (ts.isMethodDeclaration(property)) value = this.functionValue({ declaration: property, inheritedScope: scope });
      else if (ts.isPropertyAssignment(property)) {
        value = this.declaredValue({ declaration: property, scope });
        this.expression({ expression: property.initializer, owner, scope });
      } else value = UNKNOWN;
      fields.set(key, { value, access: 'writable' });
    }
    return withoutSourceEvidence({ value: { kind: 'record', fields, shape: 'closed', reflected: undefined, indexValue: undefined } });
  }

  private replacementShape({ source, target, node, depth }: { source: Value, target: Value, node: ts.Node, depth: number }): void {
    if (!isRecordValue(target)) return;
    const before = this.closedRecord({ value: target });
    const after = this.closedRecord({ value: source });
    if (depth > 24 || before === undefined || after === undefined || before.fields.size !== after.fields.size
      || [...before.fields.keys()].some(key => !after.fields.has(key))) {
      this.issue({ node, code: 'unsupported', message: 'Object-valued storage replacement needs the same checked own-property shape; initial-value evidence cannot survive an arbitrary replacement.' });
      return;
    }
    for (const [key, field] of before.fields) this.replacementShape({ source: after.fields.get(key)!.value, target: field.value, node, depth: depth + 1 });
  }

  private assign({ left, right, owner, scope, node }: { left: ts.Expression, right: Value, owner: ContractOwner | undefined, scope: Map<ts.Symbol, Value>, node: ts.Node }): void {
    if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
      const receiver = this.expression({ expression: left.expression, owner, scope });
      const keys = ts.isPropertyAccessExpression(left) ? [left.name.text] : (() => {
        const value = this.expression({ expression: left.argumentExpression, owner, scope });
        return isScalarValue(value) ? value.keys : undefined;
      })();
      if (isNativeValue(receiver)) {
        if (isScalarRefName(receiver.name)) {
          if (receiver.name !== 'vue:scalar-ref' || keys?.length !== 1 || keys[0] !== 'value' || !isScalarValue(right)) {
            this.issue({ node, code: 'unsupported', message: 'Vue Ref writes require a proven scalar ref and scalar value.' });
          }
          return;
        }
        const operations = receiver.name === 'localStorage' || receiver.name === 'sessionStorage'
          ? [`${receiver.name}.[stored-key]`]
          : keys?.map(key => ['window', 'globalThis', 'self'].includes(receiver.name) && key === 'location'
            ? 'location.href' : receiver.name === 'document' && key === 'location' ? 'location.href' : `${receiver.name}.${key}`);
        if (operations !== undefined && operations.length > 0) {
          let matched = true;
          for (const operation of operations) {
            const modeled = evaluateBrowserOperation({ context: this.nativeModels, callable: { kind: 'native', name: operation, receiver }, args: [right], owner, node, access: 'write' });
            if (modeled === undefined) matched = false;
          }
          if (matched) return;
        }
      }
      if (receiver.kind === 'record' && receiver.indexValue?.kind === 'scalar' && right.kind === 'scalar') return;
      if (receiver.kind !== 'record' || keys === undefined || keys.length === 0) {
        this.issue({ node, code: 'unsupported', message: 'Assignment has no finite checked destination slots.' }); return;
      }
      for (const key of keys) {
        const field = receiver.fields.get(key);
        if (field === undefined || field.access !== 'writable') {
          this.issue({ node, code: 'unsupported', message: `Cannot write unmodeled or readonly slot ${key}.` }); continue;
        }
        this.replacementShape({ source: right, target: field.value, node, depth: 0 });
        this.compatible({ source: right, target: field.value, node, mode: 'shared' });
      }
      return;
    }
    if (ts.isIdentifier(left)) {
      const target = this.identifier({ expression: left, scope });
      if (isNativeValue(target) && target.name === 'location') {
        evaluateBrowserOperation({ context: this.nativeModels, callable: { kind: 'native', name: 'location.href', receiver: target }, args: [right], owner, node, access: 'write' });
        return;
      }
      this.replacementShape({ source: right, target, node, depth: 0 });
      this.compatible({ source: right, target, node, mode: 'shared' });
      return;
    }
    this.issue({ node, code: 'unsupported', message: 'Destructuring assignment is not yet modeled.' });
  }

  expression({ expression, owner, scope }: { expression: ts.Expression, owner: ContractOwner | undefined, scope: Map<ts.Symbol, Value> }): Value {
    if (ts.isIdentifier(expression)) return this.identifier({ expression, scope });
    if (ts.isStringLiteralLike(expression)) return { kind: 'scalar', keys: [expression.text], truthiness: expression.text.length === 0 ? 'falsy' : 'truthy', stringEvidence: { kind: 'literal', values: [expression.text] } };
    if (ts.isNumericLiteral(expression) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(expression.kind)) return SCALAR;
    if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      // Type assertions never erase the original effect value or its own-property evidence.
      return this.expression({ expression: expression.expression, owner, scope });
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return this.functionValue({ declaration: expression, inheritedScope: scope });
    if (ts.isObjectLiteralExpression(expression)) return this.record({ expression, owner, scope });
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) if (!ts.isOmittedExpression(element)) {
        if (ts.isSpreadElement(element)) this.issue({ node: element, code: 'unsupported', message: 'Array spread may execute an unmodeled iterator.' });
        else {
          const value = this.expression({ expression: element, owner, scope });
          if (containsContract({ value, seen: new Set() })) this.issue({ node: element, code: 'unsupported', message: 'Effectful array elements require a checked element contract.' });
        }
      }
      return this.native({ name: 'Array', receiver: SCALAR });
    }
    if (ts.isPropertyAccessExpression(expression)) return this.property({ receiver: this.expression({ expression: expression.expression, owner, scope }), key: expression.name.text, node: expression.name, owner });
    if (ts.isElementAccessExpression(expression)) {
      const receiver = this.expression({ expression: expression.expression, owner, scope });
      const key = this.expression({ expression: expression.argumentExpression, owner, scope });
      if (key.kind !== 'scalar' || key.keys === undefined || key.keys.length === 0) {
        this.issue({ node: expression, code: 'unsupported', message: 'Element access requires finite literal keys.' }); return UNKNOWN;
      }
      const values = key.keys.map(item => this.property({ receiver, key: item, node: expression, owner }));
      return values.length === 1 ? values[0]! : { kind: 'choice', values };
    }
    if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
      const callable = this.expression({ expression: expression.expression, owner, scope });
      if (ts.isNewExpression(expression) && isNativeValue(callable) && callable.name === 'Worker') {
        const entry = literalWorkerEntry({ node: expression, program: this.program });
        if (entry === undefined || this.program.getSourceFile(entry) === undefined) {
          this.issue({ node: expression, code: 'boundary', message: 'A Worker requires a verified literal entry included in the analysis Program.' });
          return UNKNOWN;
        }
        for (const argument of (expression.arguments ?? []).slice(1)) this.expression({ expression: argument, owner, scope });
        this.workerCreations.push({ entry, owner, node: expression });
        evaluateBrowserOperation({ context: this.nativeModels, callable, args: [], owner, node: expression, access: 'construct' });
        return this.native({ name: 'worker-endpoint:' + entry, receiver: undefined });
      }

      const args = (expression.arguments ?? []).map(argument => {
        if (ts.isSpreadElement(argument)) {
          this.issue({ node: argument, code: 'unsupported', message: 'Dynamic call argument spread is not modeled.' }); return UNKNOWN;
        }
        return this.expression({ expression: argument, owner, scope });
      });
      return this.invoke({ callable, args, owner, node: expression });
    }
    if (ts.isAwaitExpression(expression)) return this.settle({ value: this.expression({ expression: expression.expression, owner, scope }), node: expression });
    if (ts.isBinaryExpression(expression)) {
      const right = this.expression({ expression: expression.right, owner, scope });
      if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        this.assign({ left: expression.left, right, owner, scope, node: expression }); return right;
      }
      const left = this.expression({ expression: expression.left, owner, scope });
      const operator = expression.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
        return logicalValue({ left, right, operator: operator === ts.SyntaxKind.AmpersandAmpersandToken ? 'and' : 'or' });
      }
      if (operator === ts.SyntaxKind.QuestionQuestionToken) return isScalarValue(left) && isScalarValue(right) ? SCALAR : { kind: 'choice', values: [left, right] };
      if (operator === ts.SyntaxKind.CommaToken) return right;
      if (operator === ts.SyntaxKind.InKeyword && isScalarValue(left) && (isRecordValue(right) || isNativeValue(right) && (right.name.startsWith('opfs.') || right.name.startsWith('hostfs.') || right.name.startsWith('FileSystem')))) return SCALAR;
      if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken && operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken
        && (!isScalarValue(left) || !isScalarValue(right))) this.issue({ node: expression, code: 'unsupported', message: 'Binary operator conversion may execute user-defined hooks.' });
      if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) this.assign({ left: expression.left, right: SCALAR, owner, scope, node: expression });
      return this.typeValue({ type: this.checker.getTypeAtLocation(expression), anchor: expression, callbackPath: undefined, depth: 0 });
    }
    if (ts.isConditionalExpression(expression)) {
      this.expression({ expression: expression.condition, owner, scope });
      return choiceValue({ values: [this.expression({ expression: expression.whenTrue, owner, scope }), this.expression({ expression: expression.whenFalse, owner, scope })] });
    }
    if (ts.isTypeOfExpression(expression) || ts.isVoidExpression(expression) || ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) {
      const operand = this.expression({ expression: 'operand' in expression ? expression.operand : expression.expression, owner, scope });
      if ((ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression) && expression.operator !== ts.SyntaxKind.ExclamationToken) && !isScalarValue(operand)) this.issue({ node: expression, code: 'unsupported', message: 'Numeric conversion may execute user-defined hooks.' });
      return SCALAR;
    }
    if (ts.isTemplateExpression(expression)) {
      for (const span of expression.templateSpans) {
        const value = this.expression({ expression: span.expression, owner, scope });
        if (!isScalarValue(value)) this.issue({ node: span.expression, code: 'unsupported', message: 'Template conversion may execute user-defined hooks.' });
      }
      return SCALAR;
    }
    this.issue({ node: expression, code: 'unsupported', message: `Unsupported effect expression: ${ts.SyntaxKind[expression.kind]}.` });
    return UNKNOWN;
  }

  private statement({ statement, owner, scope, result }: { statement: ts.Statement, owner: ContractOwner, scope: Map<ts.Symbol, Value>, result: Value | undefined }): void {
    if (ts.isBlock(statement)) {
      for (const item of statement.statements) this.statement({ statement: item, owner, scope, result }); return;
    }
    if (ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & ts.NodeFlags.Using) !== 0) this.issue({ node: statement, code: 'unsupported', message: 'Resource disposal requires its own effect model.' });
      for (const declaration of statement.declarationList.declarations) {
        const value = this.declaredValue({ declaration, scope });
        if (declaration.initializer !== undefined) this.expression({ expression: declaration.initializer, owner, scope });
        this.bindPattern({ name: declaration.name, value, scope, owner });
      }
      return;
    }
    if (ts.isExpressionStatement(statement)) {
      this.expression({ expression: statement.expression, owner, scope }); return;
    }
    if (ts.isReturnStatement(statement)) {
      if (statement.expression !== undefined) {
        const value = this.expression({ expression: statement.expression, owner, scope });
        const publicId = this.bodyPublicOwners.get(owner.id) ?? owner.id;
        const proofs = this.returnValues.get(publicId) ?? [];
        proofs.push(isPromiseValue(value) ? value.value : value);
        this.returnValues.set(publicId, proofs);
        if (result !== undefined) this.compatible({ source: isPromiseValue(result) ? this.settle({ value, node: statement }) : value, target: isPromiseValue(result) ? result.value : result, node: statement, mode: ts.isObjectLiteralExpression(statement.expression) ? 'value' : 'shared' });
      }
      return;
    }
    if (ts.isThrowStatement(statement)) {
      this.expression({ expression: statement.expression, owner, scope }); return;
    }
    if (ts.isFunctionDeclaration(statement)) {
      this.functionValue({ declaration: statement, inheritedScope: scope }); return;
    }
    if (ts.isIfStatement(statement)) {
      this.expression({ expression: statement.expression, owner, scope });
      this.statement({ statement: statement.thenStatement, owner, scope, result });
      if (statement.elseStatement !== undefined) this.statement({ statement: statement.elseStatement, owner, scope, result });
      return;
    }
    if (ts.isTryStatement(statement)) {
      this.statement({ statement: statement.tryBlock, owner, scope, result });
      if (statement.catchClause !== undefined) {
        const local = new Map(scope);
        if (statement.catchClause.variableDeclaration !== undefined) this.bindPattern({ name: statement.catchClause.variableDeclaration.name, value: UNKNOWN, scope: local, owner });
        this.statement({ statement: statement.catchClause.block, owner, scope: local, result });
      }
      if (statement.finallyBlock !== undefined) this.statement({ statement: statement.finallyBlock, owner, scope, result });
      return;
    }
    if (ts.isSwitchStatement(statement)) {
      this.expression({ expression: statement.expression, owner, scope });
      for (const clause of statement.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) this.expression({ expression: clause.expression, owner, scope });
        for (const child of clause.statements) this.statement({ statement: child, owner, scope, result });
      }
      return;
    }
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
      this.expression({ expression: statement.expression, owner, scope }); this.statement({ statement: statement.statement, owner, scope, result }); return;
    }
    if (ts.isForOfStatement(statement)) {
      const type = this.checker.getTypeAtLocation(statement.expression);
      if (!this.checker.isArrayType(type) && !this.checker.isTupleType(type)) this.issue({ node: statement, code: 'unsupported', message: 'An arbitrary iterator may execute unmodeled effects.' });
      this.expression({ expression: statement.expression, owner, scope });
      if (ts.isVariableDeclarationList(statement.initializer)) for (const declaration of statement.initializer.declarations) this.bindPattern({
        name: declaration.name,
        value: this.typeValue({ type: this.checker.getTypeAtLocation(declaration.name), anchor: declaration, callbackPath: undefined, depth: 0 }),
        scope,
        owner,
      });
      this.statement({ statement: statement.statement, owner, scope, result }); return;
    }
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier;
      if (specifier !== undefined) {
        const imported = this.importedSource({ specifier });
        if (imported?.fileName.endsWith('.test.ts')) this.issue({ node: statement, code: 'boundary', message: 'A product module imports an excluded test module.' });
        const typeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly;
        if (!typeOnly && imported !== undefined) {
          const dependency = this.moduleOwners.get(imported);
          if (dependency !== undefined) this.link({ source: dependency, target: owner, node: statement, reason: 'module initialization', bindings: new Map() });
        }
      }
      return;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement) || ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) return;
    this.issue({ node: statement, code: 'unsupported', message: `Unsupported effect statement: ${ts.SyntaxKind[statement.kind]}.` });
  }

  private closedRecord({ value }: { value: Value }): Extract<Value, { kind: 'record' }> | undefined {
    let current = value;
    const seen = new Set<Value>();
    while (isRecordValue(current) && !seen.has(current)) {
      seen.add(current);
      switch (current.shape) {
      case 'closed': return current;
      case 'open': break;
      default: { const exhaustive: never = current.shape; throw new Error(String(exhaustive)); }
      }
      if (current.reflected === undefined) return undefined;
      current = current.reflected;
    }
    return undefined;
  }

  private completeWorkerBindings(): void {
    for (const info of this.pending) {
      const proofs = this.returnValues.get(info.value.owner.id) ?? [];
      const result = isPromiseValue(info.value.returns) ? info.value.returns.value : info.value.returns;
      if (isRecordValue(result) && proofs.length === 1 && proofs[0] !== result) result.reflected = proofs[0]!;
    }
    for (const wrap of this.workerWraps) {
      const exposed = this.workerExposures.filter(exposure => exposure.entry === wrap.entry);
      if (exposed.length !== 1 || exposed[0]!.contract !== wrap.contract) {
        this.issue({ node: wrap.node, code: 'boundary', message: 'The worker entry must expose exactly the same shared contract declaration.' }); continue;
      }
      const exposure = exposed[0]!;
      const api = this.closedRecord({ value: exposure.api });
      if (api === undefined || !isRecordValue(wrap.declared)) {
        this.issue({ node: exposure.node, code: 'boundary', message: 'The complete exposed worker shape is not known.' }); continue;
      }
      for (const key of api.fields.keys()) if (!wrap.declared.fields.has(key)) this.issue({ node: exposure.node, code: 'boundary', message: `Undeclared worker member: ${key}.` });
      for (const [key, field] of wrap.declared.fields) {
        const actual = api.fields.get(key)?.value;
        if (actual === undefined || actual.kind !== 'function' || field.value.kind !== 'function') {
          this.issue({ node: exposure.node, code: 'boundary', message: `Missing callable worker implementation: ${key}.` }); continue;
        }
        this.compatible({ source: actual, target: field.value, node: exposure.node, mode: 'value' });
        const returned = isPromiseValue(actual.returns) ? actual.returns.value : actual.returns;
        const proof = this.closedRecord({ value: returned }) ?? returned;
        if (!passiveData({ value: proof, seen: new Set() })) this.issue({ node: exposure.node, code: 'boundary', message: `Unverified worker return serialization for ${key}.` });
      }
    }
    for (const exposure of this.workerExposures) {
      if (!this.workerWraps.some(wrap => wrap.entry === exposure.entry)) this.issue({ node: exposure.node, code: 'boundary', message: 'Exposed worker has no verified client binding in this scope.' });
    }
    for (const creation of this.workerCreations) {
      const module = this.program.getSourceFile(creation.entry);
      const owner = module === undefined ? undefined : this.moduleOwners.get(module);
      if (owner === undefined) this.issue({ node: creation.node, code: 'boundary', message: 'Worker startup effects were not analyzed.' });
      else this.link({ source: owner, target: creation.owner, node: creation.node, reason: 'worker startup', bindings: new Map() });
    }
    let changed = true;
    let iterations = 0;
    while (changed) {
      changed = false;
      if (++iterations > this.owners.length + this.functionTransfers.length + 1) throw new Error('Worker requirement transfer did not converge.');
      for (const transfer of this.functionTransfers) {
        if (transfer.source.transport === 'worker' && transfer.target.transport !== 'worker') {
          transfer.target.transport = 'worker'; changed = true;
        }
      }
    }
    for (const registration of this.vueCallbacks) {
      switch (registration.callable.transport) {
      case 'worker': this.issue({ node: registration.node, code: 'boundary', message: 'Vue callback registration cannot use a remote method: framework-supplied cleanup or lifecycle arguments are not wire-modeled.' }); break;
      case 'local': break;
      default: { const exhaustive: never = registration.callable.transport; throw new Error(String(exhaustive)); }
      }
    }
    for (const invocation of this.invocations) {
      switch (invocation.callable.transport) {
      case 'worker': {
        for (const argument of invocation.args) if (!passiveData({ value: argument, seen: new Set() })) this.issue({ node: invocation.node, code: 'boundary', message: 'Unverified worker argument serialization; a structural type is not a closed wire shape.' });
        break;
      }
      case 'local': break;
      default: { const exhaustive: never = invocation.callable.transport; throw new Error(String(exhaustive)); }
      }
      for (const argument of invocation.args) if (argument.kind === 'function' && argument.transport === 'worker') {
        this.issue({ node: invocation.node, code: 'boundary', message: 'Higher-order remote forwarding requires the transport-argument condition adapter.' });
      }
    }
  }

  private suppressionAudit({ solution }: { solution: EffectSolution }): UnsafeSuppressionAudit[] {
    const claimed = new Set<string>();
    const audit: UnsafeSuppressionAudit[] = [];
    for (const [id, directive] of this.ownerSuppressions) {
      const owner = this.owners[id]!;
      const bodyOwner = this.bodyOwners.get(id);
      if (bodyOwner === undefined) continue;
      claimed.add(`${owner.location.file}:${directive.start}`);
      const body = solution.rows.get(bodyOwner.id) ?? [];
      const suppressed = body.filter(effect => effectCovered({ effect, allowed: directive.effects }));
      if (body.some(effect => effect.kind === 'callback')) {
        this.issue({ node: owner.anchor, code: 'unsupported', message: 'Unsafe suppression of unresolved callback effects requires a concrete wrapper; residual callback rows are not implemented.' });
      }
      for (const effect of directive.effects) {
        if (!body.some(actual => effectCovered({ effect: actual, allowed: [effect] }))) {
          this.issue({ node: owner.anchor, code: 'boundary', message: `Unused unsafe effect suppression: ${printEffect({ effect })}. Remove it explicitly instead of silently keeping an unchecked exception.` });
        }
      }
      audit.push({
        file: owner.location.file,
        start: directive.start,
        length: directive.end - directive.start,
        owner: id,
        label: owner.label,
        reason: directive.reason,
        specified: directive.effects,
        body,
        suppressed,
        outward: solution.rows.get(id) ?? [],
      });
      this.assumptions.add(`UNSAFE effect suppression at ${path.relative(this.root, owner.location.file)}:${directive.start}: ${directive.reason}`);
    }
    for (const source of this.activeSources) {
      for (const location of unsafeDirectiveLocations({ source })) {
        const file = path.resolve(source.fileName);
        if (claimed.has(`${file}:${location.start}`)) continue;
        if (this.diagnostics.some(item => item.file === file && item.start >= location.start && item.start < location.end)) continue;
        this.diagnostics.push({
          file,
          start: location.start,
          length: location.end - location.start,
          code: 'boundary',
          message: `${UNSAFE_SUPPRESSION_TAG} must be owned by exactly one checked implementation, not a file, statement, alias or type.`,
          related: [],
        });
      }
    }
    return audit.sort((left, right) => left.file.localeCompare(right.file) || left.start - right.start);
  }

  analyze(): EffectsAnalysis {
    return this.analyzeWithPolicy({ tidyFiles: undefined }).analysis;
  }

  analyzeForTidy({ files }: { files: ReadonlySet<string> }): { analysis: EffectsAnalysis, selections: readonly TidySelection[] } {
    return this.analyzeWithPolicy({ tidyFiles: files });
  }

  private analyzeWithPolicy({ tidyFiles }: { tidyFiles: ReadonlySet<string> | undefined }): { analysis: EffectsAnalysis, selections: readonly TidySelection[] } {
    const selected = new Set<ts.SourceFile>();
    const queue: ts.SourceFile[] = [];
    for (const file of [...this.config.files, ...(this.config.workerTransports.length > 0 ? discoverWorkerEntries({ program: this.program }) : [])]) {
      const source = this.program.getSourceFile(path.resolve(this.root, file));
      if (source === undefined) throw new Error(`Effect entry is not present in this TypeScript Program: ${file}`);
      queue.push(source);
    }
    for (let index = 0; index < queue.length; index++) {
      const source = queue[index]!;
      if (selected.has(source) || this.program.isSourceFileDefaultLibrary(source) || this.program.isSourceFileFromExternalLibrary(source)) continue;
      selected.add(source);
      if (this.config.workerTransports.some(transport => path.resolve(this.root, transport.file) === path.resolve(source.fileName))) continue;
      for (const statement of source.statements) if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier !== undefined) {
        const imported = this.importedSource({ specifier: statement.moduleSpecifier });
        if (imported !== undefined) queue.push(imported);
      }
    }
    for (const source of selected) {
      const file = path.resolve(source.fileName);
      const relative = path.relative(this.root, file);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        if (!source.isDeclarationFile) this.issue({ node: source, code: 'boundary', message: 'Effect analysis reached a source outside the repository.' });
        continue;
      }
      this.sources.set(file, source.text);
      if (file.endsWith('.test.ts')) {
        this.excludedTests.push(file); continue;
      }
      if (source.isDeclarationFile || this.config.workerTransports.some(transport => path.resolve(this.root, transport.file) === file)) continue;
      if (!file.endsWith('.ts') || file.endsWith('.d.ts')) {
        this.issue({ node: source, code: 'unsupported', message: 'This rollout supports TypeScript modules; Vue/JavaScript must be integrated explicitly.' }); continue;
      }
      this.activeSources.push(source);
      const owner = this.owner({ anchor: source, role: 'module', label: '<module>', symbolic: undefined });
      this.moduleOwners.set(source, owner);
    }
    for (const source of this.activeSources) {
      const scope = new Map<ts.Symbol, Value>();
      for (const statement of source.statements) this.statement({ statement, owner: this.moduleOwners.get(source)!, scope, result: undefined });
      for (const [symbol, value] of scope) this.symbolScope.set(symbol, value);
    }
    for (let index = 0; index < this.pending.length; index++) {
      const info = this.pending[index]!;
      if (index > this.config.analysisBudget) throw new Error('Function analysis budget exceeded.');
      const body = info.declaration.body;
      if (body === undefined) continue;
      const bodyOwner = this.bodyOwners.get(info.value.owner.id) ?? info.value.owner;
      info.declaration.parameters.forEach((parameter, index) => {
        const expected = info.value.parameters[index] ?? UNKNOWN;
        this.bindPattern({ name: parameter.name, value: expected, scope: info.scope, owner: bodyOwner });
        this.parameterDefaults({ parameter, expected, owner: bodyOwner, scope: info.scope });
      });
      if (ts.isBlock(body)) this.statement({ statement: body, owner: bodyOwner, scope: info.scope, result: info.value.returns });
      else {
        const value = this.expression({ expression: body, owner: bodyOwner, scope: info.scope });
        this.returnValues.set(info.value.owner.id, [isPromiseValue(value) ? value.value : value]);
        this.compatible({ source: value, target: info.value.returns, node: body, mode: 'shared' });
      }
    }
    this.completeWorkerBindings();
    const selections = tidyFiles === undefined ? [] : selectTidyOwners({ owners: this.owners, files: tidyFiles });
    const inferred = new Set(selections.filter(selection => selection.disposition === 'infer').map(selection => selection.owner));
    // Lower only selected declaration seeds. Rebuild cleanup rows from those same
    // seeds so an old declared callback dependency cannot keep itself alive.
    // The real owners retain their original declarations for diagnostics/edits.
    const nodes = this.owners.map(owner => inferred.has(owner.id) ? { ...owner, declared: [] } : owner);
    const originalCount = nodes.length;
    const cleanupChecks = connectWatcherCleanups({ owners: nodes, edges: this.edges, registrations: this.watcherRegistrations, stops: this.watcherStops });
    this.owners.push(...nodes.slice(originalCount));
    const solution = solveEffects({ nodes, edges: this.edges, budget: this.config.analysisBudget });
    for (const check of cleanupChecks) {
      if ((solution.rows.get(check.owner) ?? []).length > 0) this.issue({
        node: check.node,
        code: 'unsupported',
        message: 'Reentrant watcher cleanup registration needs an explicit ambient-lifecycle model; it cannot be erased from stop contracts.',
      });
    }
    for (const owner of this.owners) {
      if (owner.role === 'module' || owner.role === 'symbolic' || owner.role === 'body') continue;
      if (owner.annotation === undefined) this.diagnostics.push({ ...owner.location, code: 'missing', message: `Missing @effects contract for ${owner.label}.`, related: [] });
      for (const effect of solution.rows.get(owner.id) ?? []) {
        if (effect.kind === 'callback' && !owner.callbackPaths.has(printEffect({ effect }))) {
          this.issue({ node: owner.anchor, code: 'unsupported', message: `Cannot move callback reference ${printEffect({ effect })} outside its lexical contract.` }); continue;
        }
        if (effectCovered({ effect, allowed: owner.declared })) continue;
        const cause = solution.causes.get(`${owner.id}:${printEffect({ effect })}`);
        this.diagnostics.push({
          ...owner.location,
          code: 'exceeds',
          message: `${printEffect({ effect })} exceeds the contract of ${owner.label}.`,
          related: cause === undefined ? [] : [{ ...cause.location, message: `${cause.reason}: ${this.owners[cause.source]?.label ?? '<unknown>'}` }],
        });
      }
    }
    const unsafeSuppressions = this.suppressionAudit({ solution });
    return {
      selections,
      analysis: {
        diagnostics: [...this.diagnostics].sort((left, right) => compareDiagnostics({ left, right })),
        owners: this.owners,
        solution,
        dependencies: this.edges,
        origins: this.origins,
        modelDecisions: [...this.modelDecisions.values()],
        sources: this.sources,
        assumptions: [...this.assumptions],
        unsafeSuppressions,
        coverage: { files: this.activeSources.map(source => source.fileName), functions: this.pending.length, excludedTests: this.excludedTests },
      },
    };
  }
}
