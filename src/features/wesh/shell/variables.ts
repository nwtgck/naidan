import { WeshOverlayMap } from '@/features/wesh/utils/overlay-map';
import { SHELL_EXECUTION_OPTION_NAMES, type WeshExecutionOptions } from './invocation';

export interface WeshVariableValues {
  get({ name }: { name: string }): string | undefined,
  set({ name, value }: { name: string, value: string }): void,
}

export class WeshReadonlyVariableError extends Error {
  constructor({ name }: { name: string }) {
    super(`${name}: readonly variable`);
    this.name = 'WeshReadonlyVariableError';
  }
}

interface WeshVariableBinding {
  readonly value: string | undefined,
  readonly exported: boolean,
  readonly origin: 'ordinary' | 'prefix' | 'declared-prefix',
  readonly propagateOnScopeExit: boolean,
  readonly shadowed?: WeshVariableBinding,
}

interface WeshVariableScope {
  readonly kind: 'function' | 'command',
  readonly bindings: Map<string, WeshVariableBinding>,
}

export class WeshShellVariables implements WeshVariableValues {
  private readonly global: Map<string, WeshVariableBinding>;
  private readonly scopes: WeshVariableScope[];
  private readonly special: Map<string, string>;
  private readonly options: WeshExecutionOptions;
  private readonly hasShellopts: boolean;

  private constructor({ global, scopes, special, executionOptions, hasShellopts }: {
    global: Map<string, WeshVariableBinding>,
    scopes: WeshVariableScope[],
    special: Map<string, string>,
    executionOptions: WeshExecutionOptions,
    hasShellopts: boolean,
  }) {
    this.global = global;
    this.scopes = scopes;
    this.special = special;
    this.options = executionOptions;
    this.hasShellopts = hasShellopts;
  }

  static fromEnvironment({ entries, executionOptions, shellopts }: {
    entries: Iterable<readonly [string, string]>,
    executionOptions: WeshExecutionOptions,
    shellopts?: true,
  }): WeshShellVariables {
    const global = new Map<string, WeshVariableBinding>();
    for (const [name, value] of entries) {
      global.set(name, {
        value,
        exported: true,
        origin: 'ordinary',
        propagateOnScopeExit: false,
      });
    }
    const variables = new WeshShellVariables({
      global,
      scopes: [],
      special: new Map(),
      executionOptions,
      hasShellopts: shellopts === true,
    });
    variables.refreshShellopts();
    return variables;
  }

  forExecution(): WeshShellVariables {
    return new WeshShellVariables({
      global: this.global,
      scopes: [],
      special: this.special,
      executionOptions: this.options,
      hasShellopts: this.hasShellopts,
    });
  }

  get executionOptions(): Readonly<WeshExecutionOptions> {
    return this.options;
  }

  updateExecutionOptions({ options }: { options: Partial<WeshExecutionOptions> }): void {
    Object.assign(this.options, options);
    this.refreshShellopts();
  }

  private refreshShellopts(): void {
    if (!this.hasShellopts) {
      return;
    }
    const binding = this.global.get('SHELLOPTS');
    this.global.set('SHELLOPTS', {
      value: SHELL_EXECUTION_OPTION_NAMES.filter(name => this.options[name]).join(':'),
      exported: binding?.exported === true,
      origin: 'ordinary',
      propagateOnScopeExit: false,
    });
  }

  isReadonly({ name }: { name: string }): boolean {
    return this.hasShellopts && name === 'SHELLOPTS';
  }

  private findScope({ name, exclude }: {
    name: string,
    exclude?: WeshVariableScope,
  }): WeshVariableScope | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const scope = this.scopes[index]!;
      if (scope !== exclude && scope.bindings.has(name)) {
        return scope;
      }
    }
    return undefined;
  }

  get({ name }: { name: string }): string | undefined {
    const special = this.special.get(name);
    if (special !== undefined) {
      return special;
    }
    const scope = this.findScope({ name });
    return (scope?.bindings ?? this.global).get(name)?.value;
  }

  setSpecial({ name, value }: { name: string, value: string | undefined }): void {
    if (value === undefined) {
      this.special.delete(name);
    } else {
      this.special.set(name, value);
    }
  }

  set({ name, value, skipCurrentCommand }: { name: string, value: string | undefined, skipCurrentCommand?: true }): void {
    if (this.isReadonly({ name })) {
      throw new WeshReadonlyVariableError({ name });
    }
    const scope = this.findScope({ name, exclude: skipCurrentCommand ? this.currentCommandScope() : undefined });
    this.writeValue({ name, value, scope });
  }

  private writeValue({ name, value, scope }: {
    name: string,
    value: string | undefined,
    scope: WeshVariableScope | undefined,
  }): void {
    const bindings = scope?.bindings ?? this.global;
    const previous = bindings.get(name);
    const exported = this.options.allexport || previous?.exported === true;
    bindings.set(name, previous === undefined ? {
      value,
      exported,
      origin: 'ordinary',
      propagateOnScopeExit: false,
    } : { ...previous, value, exported });
  }

  setExport({ name, value, exported, directAssignment }: {
    name: string,
    value: string | undefined,
    exported: boolean,
    directAssignment?: boolean,
  }): void {
    const scope = this.findScope({ name });
    const bindings = scope?.bindings ?? this.global;
    const previous = bindings.get(name);
    if (previous === undefined && value === undefined && !exported) {
      return;
    }

    const readonlyAssignment = value !== undefined && this.isReadonly({ name });
    const nextValue = readonlyAssignment ? previous?.value : value ?? previous?.value;
    const origin = previous?.origin ?? 'ordinary';
    bindings.set(name, {
      ...previous,
      value: nextValue,
      exported,
      origin,
      propagateOnScopeExit: previous?.propagateOnScopeExit === true
        || (exported && scope?.kind === 'function' && origin !== 'ordinary'),
    });
    if (readonlyAssignment) {
      throw new WeshReadonlyVariableError({ name });
    }

    if (
      directAssignment === true
      && scope?.kind === 'command'
      && scope === this.scopes.at(-1)
      && origin === 'prefix'
    ) {
      const enclosingScope = this.findScope({ name, exclude: scope });
      if (exported) {
        const enclosingBindings = enclosingScope?.bindings ?? this.global;
        const enclosing = enclosingBindings.get(name);
        enclosingBindings.set(name, {
          ...enclosing,
          value: nextValue,
          exported: true,
          origin: enclosing?.origin ?? 'ordinary',
          propagateOnScopeExit: enclosing?.propagateOnScopeExit ?? false,
        });
      } else if (value !== undefined) {
        this.writeValue({ name, value, scope: enclosingScope });
      }
    }
  }

  private currentCommandScope(): WeshVariableScope | undefined {
    const scope = this.scopes.at(-1);
    const kind = scope?.kind;
    switch (kind) {
    case 'command':
      return scope;
    case 'function':
    case undefined:
      return undefined;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled shell variable scope: ${_ex}`);
    }
    }
  }

  unset({ name, skipCurrentCommand }: { name: string, skipCurrentCommand?: true }): void {
    if (this.isReadonly({ name })) {
      throw new WeshReadonlyVariableError({ name });
    }
    const scope = this.findScope({ name, exclude: skipCurrentCommand ? this.currentCommandScope() : undefined });
    const bindings = scope?.bindings ?? this.global;
    const binding = bindings.get(name);
    if (
      binding !== undefined
      && binding.origin !== 'prefix'
      && scope !== undefined
      && scope === this.scopes.findLast((candidate) => candidate.kind === 'function')
    ) {
      // Keep the local declaration and detach it from its original prefix.
      const declaration: WeshVariableBinding = {
        value: undefined,
        exported: binding.origin === 'declared-prefix' && binding.exported,
        origin: 'ordinary',
        propagateOnScopeExit: false,
      };
      const shadowed = binding.shadowed?.shadowed;
      bindings.set(name, shadowed === undefined ? declaration : { ...declaration, shadowed });
    } else if (binding?.shadowed !== undefined) {
      bindings.set(name, binding.shadowed);
    } else {
      bindings.delete(name);
    }
  }

  enterFunction({ assignments }: { assignments: ReadonlyMap<string, string> }): void {
    this.scopes.push({ kind: 'function', bindings: this.prefixBindings({ assignments }) });
  }

  enterCommand({ assignments }: { assignments: Iterable<readonly [string, string]> }): void {
    this.scopes.push({ kind: 'command', bindings: this.prefixBindings({ assignments }) });
  }

  private prefixBindings({ assignments }: {
    assignments: Iterable<readonly [string, string]>,
  }): Map<string, WeshVariableBinding> {
    const bindings = new Map<string, WeshVariableBinding>();
    for (const [name, value] of assignments) {
      bindings.set(name, {
        value,
        exported: true,
        origin: 'prefix',
        propagateOnScopeExit: false,
      });
    }
    return bindings;
  }

  async expandCommandAssignments({ assignments, expand, isInterrupted, reportReadonlyAssignment }: {
    assignments: readonly { key: string, value: string }[],
    expand({ raw, variables }: { raw: string, variables: WeshVariableValues }): Promise<string>,
    isInterrupted: () => boolean,
    reportReadonlyAssignment({ name }: { name: string }): Promise<void>,
  }): Promise<Map<string, string>> {
    const expanded = new Map<string, string>();
    if (assignments.length === 0) {
      return expanded;
    }

    const scope: WeshVariableScope = { kind: 'command', bindings: new Map() };
    const variables: WeshVariableValues = {
      get: ({ name }) => this.get({ name }),
      set: ({ name, value }) => {
        if (isInterrupted()) {
          return;
        }
        if (this.isReadonly({ name })) {
          throw new WeshReadonlyVariableError({ name });
        }
        // Parameter and arithmetic assignments also update the binding outside this prefix.
        if (scope.bindings.has(name)) {
          this.writeValue({ name, value, scope });
        }
        this.writeValue({ name, value, scope: this.findScope({ name, exclude: scope }) });
      },
    };
    this.scopes.push(scope);
    try {
      for (const { key, value: raw } of assignments) {
        if (isInterrupted()) {
          break;
        }
        const value = await expand({ raw, variables });
        if (isInterrupted()) {
          break;
        }
        if (this.isReadonly({ name: key })) {
          await reportReadonlyAssignment({ name: key });
          continue;
        }
        scope.bindings.set(key, {
          value,
          exported: true,
          origin: 'prefix',
          propagateOnScopeExit: false,
        });
      }
      for (const [name, { value }] of scope.bindings) {
        if (value !== undefined) {
          expanded.set(name, value);
        }
      }
      return expanded;
    } finally {
      this.leaveScope();
    }
  }

  leaveScope(): void {
    const scope = this.scopes.pop();
    if (scope === undefined) {
      return;
    }
    for (const [name, binding] of scope.bindings) {
      let propagation = binding.propagateOnScopeExit ? binding : binding.shadowed;
      while (propagation !== undefined && !propagation.propagateOnScopeExit) {
        propagation = propagation.shadowed;
      }
      if (propagation !== undefined) {
        // An explicit export of a function prefix propagates as the enclosing scopes return.
        const enclosingScope = this.findScope({ name });
        const bindings = enclosingScope?.bindings ?? this.global;
        const enclosing = bindings.get(name);
        bindings.set(name, {
          ...enclosing,
          value: propagation.value,
          exported: this.options.allexport || propagation.exported || enclosing?.exported === true,
          origin: enclosing?.origin ?? 'ordinary',
          propagateOnScopeExit: enclosingScope !== undefined,
        });
      }
    }
  }

  declareLocal({ name, value, directAssignment }: {
    name: string,
    value: string | undefined,
    directAssignment: boolean,
  }): void {
    if (this.isReadonly({ name })) {
      throw new WeshReadonlyVariableError({ name });
    }
    const scope = this.scopes.findLast((candidate) => candidate.kind === 'function');
    if (scope === undefined) {
      throw new Error('Missing shell local-variable scope inside function');
    }

    const local = scope.bindings.get(name);
    const existingScope = this.findScope({ name });
    const existing = (existingScope?.bindings ?? this.global).get(name);
    const inheritedPrefix = existing?.origin === 'prefix' || existing?.origin === 'declared-prefix';
    const replacesLocal = directAssignment
      && existingScope?.kind === 'command'
      && existingScope === this.scopes.at(-1)
      && inheritedPrefix;
    const usePrefix = replacesLocal || (local === undefined && inheritedPrefix);
    const declaration: WeshVariableBinding = {
      value: value ?? (usePrefix ? existing?.value : local?.value),
      exported: existing?.exported === true || (value !== undefined && this.options.allexport),
      origin: replacesLocal || local === undefined || local.origin === 'ordinary' ? 'ordinary' : 'declared-prefix',
      propagateOnScopeExit: !replacesLocal && local?.propagateOnScopeExit === true,
    };
    // A prefixed local declaration shadows older bindings in the same function.
    const shadowed = replacesLocal ? local : local?.shadowed;
    scope.bindings.set(name, shadowed === undefined ? declaration : { ...declaration, shadowed });
  }

  private *visibleBindings({ omitCurrentCommand }: {
    omitCurrentCommand: boolean,
  }): IterableIterator<[string, WeshVariableBinding]> {
    const scopeCount = omitCurrentCommand && this.scopes.at(-1)?.kind === 'command'
      ? this.scopes.length - 1
      : this.scopes.length;
    if (scopeCount === 0) {
      yield* this.global;
      return;
    }

    const seen = new Set<string>();
    for (let index = scopeCount - 1; index >= 0; index -= 1) {
      const scope = this.scopes[index]!;
      for (const [name, binding] of scope.bindings) {
        if (!seen.has(name)) {
          seen.add(name);
          yield [name, binding];
        }
      }
    }
    for (const [name, binding] of this.global) {
      if (!seen.has(name)) {
        yield [name, binding];
      }
    }
  }

  *entries({ omitCurrentCommand }: { omitCurrentCommand?: boolean } = {}): IterableIterator<[string, string]> {
    for (const [name, { value }] of this.visibleBindings({ omitCurrentCommand: omitCurrentCommand === true })) {
      if (value !== undefined) {
        yield [name, value];
      }
    }
  }

  *exportDeclarations({ omitCurrentCommand }: { omitCurrentCommand?: boolean } = {}): IterableIterator<[string, string | undefined]> {
    for (const [name, { value, exported }] of this.visibleBindings({ omitCurrentCommand: omitCurrentCommand === true })) {
      if (exported) {
        yield [name, value];
      }
    }
  }

  *exportedEntries({ assignments }: {
    assignments: ReadonlyMap<string, string> | undefined,
  }): IterableIterator<[string, string]> {
    // Exported values in inner scopes replace exported outer values with the same name.
    yield* this.exportedBindings({ bindings: this.global });
    for (const { bindings } of this.scopes) {
      yield* this.exportedBindings({ bindings });
    }
    if (assignments !== undefined) {
      yield* assignments;
    }
  }

  private *exportedBindings({ bindings }: {
    bindings: ReadonlyMap<string, WeshVariableBinding>,
  }): IterableIterator<[string, string]> {
    for (const [name, binding] of bindings) {
      if (binding.exported && binding.value !== undefined) {
        yield [name, binding.value];
        continue;
      }

      let shadowed = binding.shadowed;
      while (shadowed !== undefined) {
        if (shadowed.exported && shadowed.value !== undefined) {
          yield [name, shadowed.value];
          break;
        }
        shadowed = shadowed.shadowed;
      }
    }
  }

  clone({ mapStrategy }: { mapStrategy: 'snapshot_copy' | 'synchronous_overlay' }): WeshShellVariables {
    const cloneBindings = ({ source }: { source: Map<string, WeshVariableBinding> }) => {
      switch (mapStrategy) {
      case 'snapshot_copy':
        return new Map(source);
      case 'synchronous_overlay':
        return new WeshOverlayMap({ source });
      default: {
        const _ex: never = mapStrategy;
        throw new Error(`Unhandled shell variable map strategy: ${_ex}`);
      }
      }
    };
    return new WeshShellVariables({
      global: cloneBindings({ source: this.global }),
      scopes: this.scopes.map((scope) => ({
        kind: scope.kind,
        bindings: cloneBindings({ source: scope.bindings }),
      })),
      special: new Map(this.special),
      executionOptions: { ...this.options },
      hasShellopts: this.hasShellopts,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
