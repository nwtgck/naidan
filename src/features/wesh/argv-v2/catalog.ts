export type ArgvShortValueSyntax =
  | { readonly kind: 'none' }
  | { readonly kind: 'required-attached-or-following', readonly missingValueName: string }
  // Real-command example: Bash invocation `-O [shopt_option]`. If a following argv exists,
  // Bash claims it even when it looks like another option; `-Oe extglob` then continues at `e`.
  | { readonly kind: 'optional-following' }
  // Real-command examples: GNU xargs `-e[eof-str]`, Sed `-i[SUFFIX]`.
  | { readonly kind: 'optional-attached' };

export type ArgvLongValueSyntax =
  | { readonly kind: 'none' }
  | { readonly kind: 'required', readonly missingValueName: string }
  | { readonly kind: 'optional-inline' };

export type ArgvSyntaxForm =
  | {
      readonly kind: 'short',
      readonly name: string,
      readonly value: ArgvShortValueSyntax,
    }
  // Real-command examples: Bash invocation `+O extglob` and the `set +e` shell grammar.
  // This is lexical coverage only; Bash/set state semantics remain command-owned.
  | {
      readonly kind: 'plus-short',
      readonly name: string,
      readonly value: ArgvShortValueSyntax,
    }
  | {
      readonly kind: 'long',
      readonly name: string,
      readonly value: ArgvLongValueSyntax,
    };

export interface ArgvOptionDefinition<TSemantic> {
  readonly semantic: TSemantic,
  // `defineArgvCatalog()` rejects an empty array: a semantic definition must own at least
  // one real syntax spelling. Keep the public input ergonomic while validating this invariant.
  readonly forms: readonly ArgvSyntaxForm[],
}

export interface FlatArgvFormBase<TSemantic> {
  readonly definitionIndex: number,
  readonly formIndex: number,
  readonly semantic: TSemantic,
}

export interface FlatShortArgvForm<TSemantic> extends FlatArgvFormBase<TSemantic> {
  readonly form: Extract<ArgvSyntaxForm, { readonly kind: 'short' }>,
}

export interface FlatPlusShortArgvForm<TSemantic> extends FlatArgvFormBase<TSemantic> {
  readonly form: Extract<ArgvSyntaxForm, { readonly kind: 'plus-short' }>,
}

export interface FlatLongArgvForm<TSemantic> extends FlatArgvFormBase<TSemantic> {
  readonly form: Extract<ArgvSyntaxForm, { readonly kind: 'long' }>,
}

export interface ArgvCatalogData<TSemantic> {
  readonly short: ReadonlyMap<string, FlatShortArgvForm<TSemantic>>,
  readonly plusShort: ReadonlyMap<string, FlatPlusShortArgvForm<TSemantic>>,
  readonly long: ReadonlyMap<string, FlatLongArgvForm<TSemantic>>,
  readonly sourceFormToCompiledForm: ReadonlyMap<ArgvSyntaxForm, ArgvSyntaxForm>,
  // Real names that participate in long-name resolution but are intentionally unsupported
  // by this Wesh command. Names mapped to one group resolve as one real option semantic;
  // distinct group numbers remain ambiguity candidates.
  readonly nonExecutableLongGroupByName: ReadonlyMap<string, number>,
}

type ArgvNonExecutableLongOption = string | {
  // Use only for real aliases that GNU-style resolution treats as the same option semantic
  // with equivalent value grammar. This metadata affects resolution only; Wesh still does
  // not execute the option.
  readonly equivalentNames: readonly string[],
};

declare const argvCatalogBrand: unique symbol;

export interface ArgvCatalog<TSemantic> {
  readonly [argvCatalogBrand]: TSemantic,
}

const argvCatalogData = new WeakMap<object, ArgvCatalogData<unknown>>();

function validateShortName({ name }: { name: string }): void {
  if (!/^[A-Za-z0-9]$/.test(name)) {
    throw new Error(`Invalid argv short option name: ${JSON.stringify(name)}`);
  }
}

function validateLongName({ name }: { name: string }): void {
  // A long-option name may itself begin with '-'. GNU rm has the hidden real option
  // `---presume-input-tty`, whose resolver name after the leading `--` is
  // `-presume-input-tty`. Do not narrow this validator to an alphanumeric prefix.
  if (name.length === 0 || name.includes('=')) {
    throw new Error(`Invalid argv long option name: ${JSON.stringify(name)}`);
  }
}


function compileShortValueSyntax({ value }: { value: ArgvShortValueSyntax }): ArgvShortValueSyntax {
  switch (value.kind) {
  case 'none':
  case 'optional-following':
  case 'optional-attached':
    return Object.freeze({ kind: value.kind });
  case 'required-attached-or-following':
    return Object.freeze({ kind: value.kind, missingValueName: value.missingValueName });
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled argv short value syntax: ${JSON.stringify(_ex)}`);
  }
  }
}

function compileLongValueSyntax({ value }: { value: ArgvLongValueSyntax }): ArgvLongValueSyntax {
  switch (value.kind) {
  case 'none':
  case 'optional-inline':
    return Object.freeze({ kind: value.kind });
  case 'required':
    return Object.freeze({ kind: value.kind, missingValueName: value.missingValueName });
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled argv long value syntax: ${JSON.stringify(_ex)}`);
  }
  }
}

function compileSyntaxForm({ form }: { form: ArgvSyntaxForm }): ArgvSyntaxForm {
  switch (form.kind) {
  case 'short':
    return Object.freeze({ kind: form.kind, name: form.name, value: compileShortValueSyntax({ value: form.value }) });
  case 'plus-short':
    return Object.freeze({ kind: form.kind, name: form.name, value: compileShortValueSyntax({ value: form.value }) });
  case 'long':
    return Object.freeze({ kind: form.kind, name: form.name, value: compileLongValueSyntax({ value: form.value }) });
  default: {
    const _ex: never = form;
    throw new Error(`Unhandled argv syntax form: ${JSON.stringify(_ex)}`);
  }
  }
}

export function defineArgvCatalog<TSemantic>({
  definitions,
  nonExecutableLongOptions,
}: {
  definitions: readonly ArgvOptionDefinition<TSemantic>[],
  // Supply the complete non-executable portion of the real long-name resolver namespace
  // when `unique-prefix` matching is used. Exact-only catalogs normally pass an empty array.
  // A string is one distinct unsupported option semantic. Group real equivalent aliases
  // with `{ equivalentNames: [...] }` so a shared prefix does not become a false ambiguity.
  // This is about semantic support, not help visibility: a hidden real alias of an
  // implemented semantic remains an executable form and may be omitted only from help.
  nonExecutableLongOptions: readonly ArgvNonExecutableLongOption[],
}): ArgvCatalog<TSemantic> {
  const short = new Map<string, FlatShortArgvForm<TSemantic>>();
  const plusShort = new Map<string, FlatPlusShortArgvForm<TSemantic>>();
  const long = new Map<string, FlatLongArgvForm<TSemantic>>();
  const sourceFormToCompiledForm = new Map<ArgvSyntaxForm, ArgvSyntaxForm>();

  for (let definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
    const definition = definitions[definitionIndex];
    if (definition === undefined) {
      throw new Error('Argv catalog definitions must not contain sparse entries');
    }
    if (definition.forms.length === 0) {
      throw new Error('Argv option definition must have at least one syntax form');
    }

    for (let formIndex = 0; formIndex < definition.forms.length; formIndex += 1) {
      const sourceForm = definition.forms[formIndex];
      if (sourceForm === undefined) {
        throw new Error('Argv option definition forms must not contain sparse entries');
      }
      const form = compileSyntaxForm({ form: sourceForm });
      sourceFormToCompiledForm.set(sourceForm, form);
      switch (form.kind) {
      case 'short':
        validateShortName({ name: form.name });
        if (short.has(form.name)) {
          throw new Error(`Duplicate argv short option: -${form.name}`);
        }
        short.set(form.name, { definitionIndex, formIndex, semantic: definition.semantic, form });
        break;
      case 'plus-short':
        validateShortName({ name: form.name });
        if (plusShort.has(form.name)) {
          throw new Error(`Duplicate argv plus-short option: +${form.name}`);
        }
        plusShort.set(form.name, { definitionIndex, formIndex, semantic: definition.semantic, form });
        break;
      case 'long':
        validateLongName({ name: form.name });
        if (long.has(form.name)) {
          throw new Error(`Duplicate argv long option: --${form.name}`);
        }
        long.set(form.name, { definitionIndex, formIndex, semantic: definition.semantic, form });
        break;
      default: {
        const _ex: never = form;
        throw new Error(`Unhandled argv syntax form: ${JSON.stringify(_ex)}`);
      }
      }
    }
  }

  const nonExecutableLongGroupByName = new Map<string, number>();
  for (let optionIndex = 0; optionIndex < nonExecutableLongOptions.length; optionIndex += 1) {
    const option = nonExecutableLongOptions[optionIndex];
    if (option === undefined) {
      throw new Error('Non-executable long options must not contain sparse entries');
    }
    const names = typeof option === 'string' ? [option] : option.equivalentNames;
    if (typeof option !== 'string' && names.length < 2) {
      throw new Error('Equivalent non-executable long option group must contain at least two names');
    }
    for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
      const name = names[nameIndex];
      if (name === undefined) {
        throw new Error('Equivalent non-executable long option names must not contain sparse entries');
      }
      validateLongName({ name });
      if (nonExecutableLongGroupByName.has(name)) {
        throw new Error(`Duplicate non-executable long option name: --${name}`);
      }
      if (long.has(name)) {
        throw new Error(`Non-executable long option name duplicates executable option: --${name}`);
      }
      nonExecutableLongGroupByName.set(name, optionIndex);
    }
  }

  const catalog = Object.freeze({}) as ArgvCatalog<TSemantic>;
  argvCatalogData.set(catalog, Object.freeze({
    short,
    plusShort,
    long,
    sourceFormToCompiledForm,
    nonExecutableLongGroupByName,
  }) as ArgvCatalogData<unknown>);
  return catalog;
}

export function getCatalogData<TSemantic>({
  catalog,
}: {
  catalog: ArgvCatalog<TSemantic>,
}): ArgvCatalogData<TSemantic> {
  const data = argvCatalogData.get(catalog as object) as ArgvCatalogData<TSemantic> | undefined;
  if (data === undefined) {
    throw new Error('Invalid argv catalog');
  }
  return data;
}


export interface CatalogArgvHelpRow {
  readonly forms: readonly ArgvSyntaxForm[],
  readonly summary: string,
  readonly valueName?: string,
  readonly category?: 'common' | 'advanced',
}

export interface CatalogArgvHelpPresentation {
  readonly rows: readonly CatalogArgvHelpRow[],
}

export function defineCatalogArgvHelpPresentation<TSemantic>({
  catalog,
  rows,
}: {
  catalog: ArgvCatalog<TSemantic>,
  rows: readonly CatalogArgvHelpRow[],
}): CatalogArgvHelpPresentation {
  const data = getCatalogData({ catalog });
  const compiledRows = Array.from(rows, (row) => {
    if (row === undefined) {
      throw new Error('Argv help rows must not contain sparse entries');
    }
    if (row.forms.length === 0) {
      throw new Error('Argv help row must have at least one syntax form');
    }
    return Object.freeze({
      forms: Object.freeze(Array.from(row.forms, (sourceForm) => {
        if (sourceForm === undefined) {
          throw new Error('Argv help row forms must not contain sparse entries');
        }
        const compiledForm = data.sourceFormToCompiledForm.get(sourceForm);
        if (compiledForm === undefined) {
          throw new Error('Argv help row must reference a syntax form from its catalog');
        }
        return compiledForm;
      })),
      summary: row.summary,
      ...(row.valueName === undefined ? {} : { valueName: row.valueName }),
      ...(row.category === undefined ? {} : { category: row.category }),
    });
  });

  return Object.freeze({ rows: Object.freeze(compiledRows) });
}


// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
