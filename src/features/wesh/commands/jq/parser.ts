import {
  JQ_MAX_PARSER_PREFIX_NESTING,
  JQ_MAX_PARSER_STRUCTURAL_NESTING,
  JQ_MAX_STRING_INTERPOLATION_NESTING,
} from './limits';
import type {
  JqBinaryOperator,
  JqBuiltinName,
  JqCompoundAssignmentOperator,
  JqFilter,
  JqObjectEntry,
  JqObjectKey,
  JqPath,
  JqPathExpression,
  JqPathSegment,
  JqProgram,
  JqStringPart,
  JqStringTokenPart,
  JqToken,
  JqUserDefinition,
} from './ast';
import { lexJq } from './lexer';
import {
  createJqFilterParameterMarker,
  instantiateJqUserDefinition,
  renameJqDefinitionLocals,
  type JqUserParameter,
} from './user-definition';

function toBuiltinName({
  name,
}: {
  name: string,
}): JqBuiltinName | undefined {
  switch (name) {
  case 'IN':
  case 'INDEX':
  case 'JOIN':
  case '@base64':
  case '@base64d':
  case '@csv':
  case '@html':
  case '@json':
  case '@sh':
  case '@text':
  case '@tsv':
  case '@uri':
  case 'abs':
  case 'acos':
  case 'acosh':
  case 'add':
  case 'all':
  case 'ascii_downcase':
  case 'ascii_upcase':
  case 'arrays':
  case 'asin':
  case 'asinh':
  case 'atan':
  case 'atanh':
  case 'atan2':
  case 'any':
  case 'booleans':
  case 'bsearch':
  case 'capture':
  case 'cbrt':
  case 'ceil':
  case 'combinations':
  case 'contains':
  case 'copysign':
  case 'cos':
  case 'cosh':
  case 'del':
  case 'delpaths':
  case 'debug':
  case 'drem':
  case 'empty':
  case 'endswith':
  case 'exp':
  case 'exp2':
  case 'exp10':
  case 'expm1':
  case 'error':
  case 'explode':
  case 'first':
  case 'flatten':
  case 'frexp':
  case 'floor':
  case 'fabs':
  case 'fdim':
  case 'fmax':
  case 'fmin':
  case 'fmod':
  case 'finites':
  case 'format':
  case 'fromdate':
  case 'fromdateiso8601':
  case 'from_entries':
  case 'fromjson':
  case 'fromstream':
  case 'getpath':
  case 'gmtime':
  case 'group_by':
  case 'gsub':
  case 'hypot':
  case 'has':
  case 'halt':
  case 'halt_error':
  case 'implode':
  case 'index':
  case 'indices':
  case 'input':
  case 'input_filename':
  case 'input_line_number':
  case 'inputs':
  case 'inside':
  case 'isfinite':
  case 'isinfinite':
  case 'isnan':
  case 'isnormal':
  case 'in':
  case 'infinite':
  case 'isempty':
  case 'iterables':
  case 'join':
  case 'keys':
  case 'keys_unsorted':
  case 'last':
  case 'length':
  case 'ldexp':
  case 'limit':
  case 'log':
  case 'log10':
  case 'log2':
  case 'log1p':
  case 'logb':
  case 'localtime':
  case 'match':
  case 'ltrimstr':
  case 'map':
  case 'map_values':
  case 'mktime':
  case 'modf':
  case 'max':
  case 'max_by':
  case 'min':
  case 'min_by':
  case 'nth':
  case 'nan':
  case 'nearbyint':
  case 'nextafter':
  case 'nexttoward':
  case 'nulls':
  case 'normals':
  case 'not':
  case 'now':
  case 'numbers':
  case 'objects':
  case 'path':
  case 'paths':
  case 'pick':
  case 'pow':
  case 'range':
  case 'remainder':
  case 'recurse':
  case 'repeat':
  case 'reverse':
  case 'rint':
  case 'rindex':
  case 'round':
  case 'scan':
  case 'rtrimstr':
  case 'scalars':
  case 'scalb':
  case 'scalbln':
  case 'select':
  case 'setpath':
  case 'significand':
  case 'sin':
  case 'sinh':
  case 'sort':
  case 'sort_by':
  case 'split':
  case 'splits':
  case 'sqrt':
  case 'sub':
  case 'startswith':
  case 'stderr':
  case 'strftime':
  case 'strptime':
  case 'strings':
  case 'strflocaltime':
  case 'tan':
  case 'tanh':
  case 'to_entries':
  case 'todate':
  case 'todateiso8601':
  case 'tostream':
  case 'test':
  case 'tojson':
  case 'tonumber':
  case 'transpose':
  case 'truncate_stream':
  case 'trunc':
  case 'type':
  case 'until':
  case 'unique':
  case 'unique_by':
  case 'utf8bytelength':
  case 'values':
  case 'tostring':
  case 'walk':
  case 'while':
  case 'with_entries':
    return name;
  default:
    return undefined;
  }
}

interface JqParserUserDefinition {
  readonly id: number,
  readonly name: string,
  readonly parameters: readonly JqUserParameter[],
  readonly body: JqFilter | undefined,
}

type ParseResult =
  | { ok: true, filter: JqFilter, grouped?: boolean }
  | { ok: false, message: string };

class JqParser {
  private readonly tokens: JqToken[];

  private readonly definitions: Map<string, Map<number, JqParserUserDefinition>>;

  private readonly runtimeDefinitions: Map<number, JqUserDefinition>;

  private readonly interpolationDepth: number;

  private readonly filterParameterScopes: Set<string>[];

  private readonly variableRenameScopes: Map<string, string>[];

  private index = 0;

  private definitionLocalIndex: number;

  private nextUserDefinitionId: number;

  private nextLabelId: number;

  private readonly activeLabels: Array<{ readonly name: string, readonly id: number }>;

  private prefixNestingDepth = 0;

  private definitionBodyDepth: number;

  constructor({
    tokens,
    interpolationDepth,
    definitions = new Map(),
    runtimeDefinitions = new Map(),
    filterParameterScopes = [],
    variableRenameScopes = [],
    activeLabels = [],
    definitionLocalIndex = 0,
    nextUserDefinitionId = 0,
    nextLabelId = 0,
    definitionBodyDepth = 0,
  }: {
    tokens: JqToken[],
    interpolationDepth: number,
    definitions?: ReadonlyMap<string, ReadonlyMap<number, JqParserUserDefinition>>,
    runtimeDefinitions?: Map<number, JqUserDefinition>,
    filterParameterScopes?: readonly ReadonlySet<string>[],
    variableRenameScopes?: readonly ReadonlyMap<string, string>[],
    activeLabels?: readonly { readonly name: string, readonly id: number }[],
    definitionLocalIndex?: number,
    nextUserDefinitionId?: number,
    nextLabelId?: number,
    definitionBodyDepth?: number,
  }) {
    this.tokens = tokens;
    this.interpolationDepth = interpolationDepth;
    this.definitions = new Map(
      [...definitions].map(([name, overloads]) => [name, new Map(overloads)]),
    );
    this.runtimeDefinitions = runtimeDefinitions;
    this.filterParameterScopes = filterParameterScopes.map((scope) => new Set(scope));
    this.variableRenameScopes = variableRenameScopes.map((scope) => new Map(scope));
    this.activeLabels = [...activeLabels];
    this.definitionLocalIndex = definitionLocalIndex;
    this.nextUserDefinitionId = nextUserDefinitionId;
    this.nextLabelId = nextLabelId;
    this.definitionBodyDepth = definitionBodyDepth;
  }

  private createLexicalVariableName(): string {
    return `\0jq-lexical-variable:${this.definitionLocalIndex++}`;
  }

  private resolveVariableName({ name }: { name: string }): string {
    for (let index = this.variableRenameScopes.length - 1; index >= 0; index -= 1) {
      const renamed = this.variableRenameScopes[index]?.get(name);
      if (renamed !== undefined) return renamed;
    }
    return name;
  }

  private pushVariableRename({ sourceName, renamedName }: {
    sourceName: string,
    renamedName: string,
  }): void {
    this.variableRenameScopes.push(new Map([[sourceName, renamedName]]));
  }

  private parseStringInterpolation({
    source,
  }: {
    source: string,
  }): { ok: true, program: JqProgram } | { ok: false, message: string } {
    if (this.interpolationDepth >= JQ_MAX_STRING_INTERPOLATION_NESTING) {
      return {
        ok: false,
        message: `string interpolation nesting exceeds limit ${JQ_MAX_STRING_INTERPOLATION_NESTING}`,
      };
    }
    const lexed = lexJq({ source });
    if (!lexed.ok) return lexed;
    const nestingMessage = validateJqStructuralNesting({ tokens: lexed.tokens });
    if (nestingMessage !== undefined) return { ok: false, message: nestingMessage };
    const parser = new JqParser({
      tokens: lexed.tokens,
      interpolationDepth: this.interpolationDepth + 1,
      definitions: this.definitions,
      runtimeDefinitions: this.runtimeDefinitions,
      filterParameterScopes: this.filterParameterScopes,
      variableRenameScopes: this.variableRenameScopes,
      activeLabels: this.activeLabels,
      definitionLocalIndex: this.definitionLocalIndex,
      nextUserDefinitionId: this.nextUserDefinitionId,
      nextLabelId: this.nextLabelId,
      definitionBodyDepth: this.definitionBodyDepth,
    });
    const parsed = parser.parse();
    this.definitionLocalIndex = parser.definitionLocalIndex;
    this.nextUserDefinitionId = parser.nextUserDefinitionId;
    this.nextLabelId = parser.nextLabelId;
    return parsed;
  }

  parse(): { ok: true, program: JqProgram } | { ok: false, message: string } {
    while (true) {
      const token = this.peek();
      if (!(token.kind === 'keyword' && token.value === 'def')) break;
      const definition = this.parseDefinition();
      if (!definition.ok) return definition;
    }

    const filter = this.parseComma();
    if (!filter.ok) return filter;
    const trailing = this.peek();
    switch (trailing.kind) {
    case 'eof':
      break;
    case 'dot':
    case 'recursive_descent':
    case 'identifier':
    case 'variable':
    case 'number':
    case 'string':
    case 'keyword':
    case 'operator':
    case 'punctuation':
      return { ok: false, message: 'unexpected trailing tokens' };
    default: {
      const _ex: never = trailing;
      throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    return {
      ok: true,
      program: {
        filter: filter.filter,
        userDefinitions: [...this.runtimeDefinitions.values()].sort((left, right) => left.id - right.id),
      },
    };
  }

  private cloneDefinitions(): Map<string, Map<number, JqParserUserDefinition>> {
    const cloned = new Map<string, Map<number, JqParserUserDefinition>>();
    for (const [name, overloads] of this.definitions) {
      cloned.set(name, new Map(overloads));
    }
    return cloned;
  }

  private restoreDefinitions({
    definitions,
  }: {
    definitions: ReadonlyMap<string, ReadonlyMap<number, JqParserUserDefinition>>,
  }): void {
    this.definitions.clear();
    for (const [name, overloads] of definitions) {
      this.definitions.set(name, new Map(overloads));
    }
  }

  private parseLocalDefinition(): ParseResult {
    const previousDefinitions = this.cloneDefinitions();
    const definition = this.parseDefinition();
    if (!definition.ok) {
      this.restoreDefinitions({ definitions: previousDefinitions });
      return definition;
    }

    try {
      return this.parseNestedPrefix({
        parse: () => this.parseComma(),
      });
    } finally {
      this.restoreDefinitions({ definitions: previousDefinitions });
    }
  }

  private parseDefinition(): { ok: true } | { ok: false, message: string } {
    this.index += 1;
    const nameToken = this.peek();
    switch (nameToken.kind) {
    case 'identifier':
      break;
    case 'dot':
    case 'recursive_descent':
    case 'variable':
    case 'number':
    case 'string':
    case 'keyword':
    case 'operator':
    case 'punctuation':
    case 'eof':
      return { ok: false, message: 'expected filter name after def' };
    default: {
      const _ex: never = nameToken;
      throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    this.index += 1;

    const parameters: JqUserParameter[] = [];
    const filterParameters = new Set<string>();
    if (this.matchPunctuation({ value: '(' })) {
      if (this.matchPunctuation({ value: ')' })) {
        return { ok: false, message: 'user-defined filter parameter list cannot be empty' };
      }
      while (true) {
        const parameter = this.peek();
        switch (parameter.kind) {
        case 'variable':
          parameters.push({ kind: 'value', name: parameter.value });
          this.index += 1;
          break;
        case 'identifier':
          parameters.push({ kind: 'filter', name: parameter.value });
          filterParameters.add(parameter.value);
          this.index += 1;
          break;
        case 'dot':
        case 'recursive_descent':
        case 'number':
        case 'string':
        case 'keyword':
        case 'operator':
        case 'punctuation':
        case 'eof':
          return { ok: false, message: 'expected a parameter in user-defined filter' };
        default: {
          const _ex: never = parameter;
          throw new Error(`Unhandled jq definition parameter: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
        if (this.matchPunctuation({ value: ')' })) break;
        if (!this.matchPunctuation({ value: ';' })) {
          return { ok: false, message: "expected ';' or ')' after user-defined filter parameter" };
        }
      }
    }
    if (!this.matchOperator({ value: ':' })) {
      return { ok: false, message: "expected ':' after user-defined filter name" };
    }

    const valueParameterScope = new Map<string, string>();
    const renamedParameters = parameters.map((parameter): JqUserParameter => {
      switch (parameter.kind) {
      case 'value': {
        const renamedName = this.createLexicalVariableName();
        valueParameterScope.set(parameter.name, renamedName);
        return { kind: 'value', name: renamedName };
      }
      case 'filter':
        return parameter;
      default: {
        const _ex: never = parameter;
        throw new Error(`Unhandled jq user parameter: ${JSON.stringify(_ex)}`);
      }
      }
    });

    let overloads = this.definitions.get(nameToken.value);
    if (overloads === undefined) {
      overloads = new Map();
      this.definitions.set(nameToken.value, overloads);
    }
    const previousDefinition = overloads.get(parameters.length);
    const definitionId = this.nextUserDefinitionId++;
    overloads.set(parameters.length, {
      id: definitionId,
      name: nameToken.value,
      parameters: renamedParameters,
      body: undefined,
    });

    this.filterParameterScopes.push(filterParameters);
    this.variableRenameScopes.push(valueParameterScope);
    this.definitionBodyDepth += 1;
    let body: ParseResult;
    try {
      body = this.parseComma();
    } finally {
      this.definitionBodyDepth -= 1;
      this.variableRenameScopes.pop();
      this.filterParameterScopes.pop();
    }
    if (!body.ok || !this.matchPunctuation({ value: ';' })) {
      if (previousDefinition === undefined) overloads.delete(parameters.length);
      else overloads.set(parameters.length, previousDefinition);
      return body.ok
        ? { ok: false, message: "expected ';' after user-defined filter body" }
        : body;
    }

    const renamedBody = renameJqDefinitionLocals({
      filter: body.filter,
      createLocalName: () => `\0jq-definition-local:${this.definitionLocalIndex++}`,
    });
    const definition: JqUserDefinition = {
      id: definitionId,
      name: nameToken.value,
      parameters: renamedParameters,
      body: renamedBody,
    };
    overloads.set(parameters.length, definition);
    this.runtimeDefinitions.set(definitionId, definition);
    return { ok: true };
  }

  private parseAssignment(): ParseResult {
    const operands: JqFilter[] = [];
    const operators: Array<'=' | '|=' | '+=' | '-=' | '*=' | '/=' | '%=' | '//='> = [];

    while (true) {
      const operand = this.parseAlternative();
      if (!operand.ok) return operand;
      operands.push(operand.filter);

      const token = this.peek();
      let operator: '=' | '|=' | '+=' | '-=' | '*=' | '/=' | '%=' | '//=' | undefined;
      switch (token.kind) {
      case 'operator':
        switch (token.value) {
        case '=':
        case '|=':
        case '+=':
        case '-=':
        case '*=':
        case '/=':
        case '%=':
        case '//=':
          operator = token.value;
          break;
        case '|':
        case '//':
        case ',':
        case '==':
        case '!=':
        case '<':
        case '<=':
        case '>':
        case '>=':
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
        case ':':
        case '?':
          break;
        default: {
          const _ex: never = token;
          throw new Error(`Unhandled jq operator token: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      case 'dot':
      case 'recursive_descent':
      case 'identifier':
      case 'variable':
      case 'number':
      case 'string':
      case 'keyword':
      case 'punctuation':
      case 'eof':
        break;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }

      if (operator === undefined) break;
      operators.push(operator);
      this.index += 1;
    }

    let filter = operands.at(-1);
    if (filter === undefined) throw new Error('jq assignment parser produced no operand');
    for (let index = operators.length - 1; index >= 0; index -= 1) {
      const left = operands[index];
      const operator = operators[index];
      if (left === undefined || operator === undefined) {
        throw new Error('jq assignment parser operand mismatch');
      }
      const pathExpression = extractPathExpression({ filter: left });
      if (pathExpression === undefined) {
        return { ok: false, message: 'left-hand side of assignment must be a path' };
      }

      switch (operator) {
      case '=':
        filter = { kind: 'assign', pathExpression, value: filter };
        break;
      case '|=':
        filter = {
          kind: 'update',
          pathExpression,
          value: filter,
          mode: { kind: 'first' },
        };
        break;
      case '+=':
      case '-=':
      case '*=':
      case '/=':
      case '%=':
      case '//=':
        filter = {
          kind: 'update',
          pathExpression,
          value: filter,
          mode: {
            kind: 'compound',
            operator: compoundAssignmentOperator({ operator }),
          },
        };
        break;
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled jq assignment operator: ${String(_ex)}`);
      }
      }
    }

    return { ok: true, filter };
  }

  private parseComma(): ParseResult {
    return this.parsePipe();
  }

  private parseCommaSequence(): ParseResult {
    let left = this.parseAssignment();
    if (!left.ok) return left;

    while (this.matchOperator({ value: ',' })) {
      const right = this.parseAssignment();
      if (!right.ok) return right;
      left = {
        ok: true,
        filter: { kind: 'comma', left: left.filter, right: right.filter },
      };
    }

    return left;
  }

  private parsePipe({
    allowComma = true,
  }: {
    allowComma?: boolean,
  } = {}): ParseResult {
    const variableScopeDepth = this.variableRenameScopes.length;
    try {
      let left = allowComma ? this.parseCommaSequence() : this.parseAssignment();
      if (!left.ok) return left;
      const bindings: Array<{ binding: JqFilter, name: string }> = [];

      while (true) {
        if (this.matchKeyword({ value: 'as' })) {
          const variable = this.peek();
          switch (variable.kind) {
          case 'variable':
            break;
          case 'dot':
          case 'recursive_descent':
          case 'identifier':
          case 'number':
          case 'string':
          case 'keyword':
          case 'operator':
          case 'punctuation':
          case 'eof':
            return { ok: false, message: "expected variable name after 'as'" };
          default: {
            const _ex: never = variable;
            throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
          }
          }
          this.index += 1;
          if (!this.matchOperator({ value: '|' })) {
            return { ok: false, message: "'as' requires '|'" };
          }
          const renamedName = this.createLexicalVariableName();
          bindings.push({ binding: left.filter, name: renamedName });
          this.pushVariableRename({ sourceName: variable.value, renamedName });
          left = allowComma ? this.parseCommaSequence() : this.parseAssignment();
          if (!left.ok) return left;
          continue;
        }

        if (!this.matchOperator({ value: '|' })) break;
        const right = allowComma ? this.parseCommaSequence() : this.parseAssignment();
        if (!right.ok) return right;
        left = {
          ok: true,
          filter: { kind: 'pipe', left: left.filter, right: right.filter },
        };
      }

      let filter = left.filter;
      for (let index = bindings.length - 1; index >= 0; index -= 1) {
        const binding = bindings[index];
        if (binding === undefined) throw new Error('jq binding parser frame mismatch');
        filter = {
          kind: 'bind',
          binding: binding.binding,
          name: binding.name,
          body: filter,
        };
      }
      return { ok: true, filter };
    } finally {
      this.variableRenameScopes.length = variableScopeDepth;
    }
  }

  private parseAlternative(): ParseResult {
    let left = this.parseOr();
    if (!left.ok) return left;
    while (this.matchOperator({ value: '//' })) {
      const right = this.parseOr();
      if (!right.ok) return right;
      left = {
        ok: true,
        filter: {
          kind: 'binary',
          operator: 'alternative',
          left: left.filter,
          right: right.filter,
        },
      };
    }
    return left;
  }

  private parseOr(): ParseResult {
    let left = this.parseAnd();
    if (!left.ok) return left;
    while (this.matchKeyword({ value: 'or' })) {
      const right = this.parseAnd();
      if (!right.ok) return right;
      left = {
        ok: true,
        filter: { kind: 'binary', operator: 'or', left: left.filter, right: right.filter },
      };
    }
    return left;
  }

  private parseAnd(): ParseResult {
    let left = this.parseComparison();
    if (!left.ok) return left;
    while (this.matchKeyword({ value: 'and' })) {
      const right = this.parseComparison();
      if (!right.ok) return right;
      left = {
        ok: true,
        filter: { kind: 'binary', operator: 'and', left: left.filter, right: right.filter },
      };
    }
    return left;
  }

  private parseComparison(): ParseResult {
    let left = this.parseAddition();
    if (!left.ok) return left;

    while (true) {
      const token = this.peek();
      switch (token.kind) {
      case 'operator':
        break;
      case 'dot':
      case 'recursive_descent':
      case 'identifier':
      case 'variable':
      case 'number':
      case 'string':
      case 'keyword':
      case 'punctuation':
      case 'eof':
        return left;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
      const operator = comparisonOperator({ operator: token.value });
      if (operator === undefined) return left;
      this.index += 1;
      const right = this.parseAddition();
      if (!right.ok) return right;
      left = {
        ok: true,
        filter: { kind: 'binary', operator, left: left.filter, right: right.filter },
      };
    }

    return left;
  }

  private parseAddition(): ParseResult {
    let left = this.parseMultiplicative();
    if (!left.ok) return left;

    while (true) {
      const token = this.peek();
      let operator: JqBinaryOperator;
      switch (token.kind) {
      case 'operator':
        switch (token.value) {
        case '+':
          operator = 'add';
          break;
        case '-':
          operator = 'sub';
          break;
        case '|':
        case '//':
        case ',':
        case '==':
        case '!=':
        case '<':
        case '<=':
        case '>':
        case '>=':
        case '=':
        case '|=':
        case '+=':
        case '-=':
        case '*=':
        case '/=':
        case '%=':
        case '//=':
        case '*':
        case '/':
        case '%':
        case ':':
        case '?':
          return left;
        default: {
          const _ex: never = token;
          throw new Error(`Unhandled jq operator token: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      case 'dot':
      case 'recursive_descent':
      case 'identifier':
      case 'variable':
      case 'number':
      case 'string':
      case 'keyword':
      case 'punctuation':
      case 'eof':
        return left;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
      this.index += 1;
      const right = this.parseMultiplicative();
      if (!right.ok) return right;
      left = {
        ok: true,
        filter: {
          kind: 'binary',
          operator,
          left: left.filter,
          right: right.filter,
        },
      };
    }

    return left;
  }

  private parseMultiplicative(): ParseResult {
    let left = this.parseUnary();
    if (!left.ok) return left;

    while (true) {
      const token = this.peek();
      let operator: JqBinaryOperator;
      switch (token.kind) {
      case 'operator':
        switch (token.value) {
        case '*':
          operator = 'mul';
          break;
        case '/':
          operator = 'div';
          break;
        case '%':
          operator = 'mod';
          break;
        case '|':
        case '//':
        case ',':
        case '==':
        case '!=':
        case '<':
        case '<=':
        case '>':
        case '>=':
        case '=':
        case '|=':
        case '+=':
        case '-=':
        case '*=':
        case '/=':
        case '%=':
        case '//=':
        case '+':
        case '-':
        case ':':
        case '?':
          return left;
        default: {
          const _ex: never = token;
          throw new Error(`Unhandled jq operator token: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      case 'dot':
      case 'recursive_descent':
      case 'identifier':
      case 'variable':
      case 'number':
      case 'string':
      case 'keyword':
      case 'punctuation':
      case 'eof':
        return left;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
      this.index += 1;
      const right = this.parseUnary();
      if (!right.ok) return right;
      left = {
        ok: true,
        filter: { kind: 'binary', operator, left: left.filter, right: right.filter },
      };
    }

    return left;
  }

  private parseUnary(): ParseResult {
    if (this.matchKeyword({ value: 'not' })) {
      return {
        ok: true,
        filter: { kind: 'unary', operator: 'not', value: { kind: 'identity' } },
      };
    }
    if (this.matchOperator({ value: '-' })) {
      return this.parseNestedPrefix({
        parse: () => {
          const value = this.parseMultiplicative();
          if (!value.ok) return value;
          return { ok: true, filter: { kind: 'unary', operator: 'neg', value: value.filter } };
        },
      });
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ParseResult {
    const parsed = this.parsePrimary();
    if (!parsed.ok) return parsed;
    let filter = parsed.filter;
    let grouped = parsed.grouped === true;

    while (true) {
      const token = this.peek();
      switch (token.kind) {
      case 'dot': {
        this.index += 1;
        const field = this.peek();
        switch (field.kind) {
        case 'identifier':
          break;
        case 'dot':
        case 'recursive_descent':
        case 'variable':
        case 'number':
        case 'string':
        case 'keyword':
        case 'operator':
        case 'punctuation':
        case 'eof':
          return { ok: false, message: "expected field name after '.'" };
        default: {
          const _ex: never = field;
          throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
        this.index += 1;
        filter = { kind: 'field', input: filter, key: field.value, optional: false };
        grouped = false;
        continue;
      }
      case 'punctuation':
        switch (token.value) {
        case '[': {
          const suffix = this.parseBracketSuffix({ input: filter });
          if (!suffix.ok) return suffix;
          filter = suffix.filter;
          grouped = false;
          continue;
        }
        case ']':
        case '{':
        case '}':
        case '(':
        case ')':
        case ';':
          return { ok: true, filter };
        default: {
          const _ex: never = token;
          throw new Error(`Unhandled jq punctuation token: ${JSON.stringify(_ex)}`);
        }
        }
      case 'operator':
        switch (token.value) {
        case '?':
          this.index += 1;
          if (grouped) {
            filter = { kind: 'optional', body: filter };
          } else {
            switch (filter.kind) {
            case 'field':
            case 'index':
            case 'dynamic_index':
            case 'slice':
            case 'iterate':
              filter = { ...filter, optional: true };
              break;
            case 'identity':
            case 'variable':
            case 'literal':
            case 'string':
            case 'array':
            case 'object':
            case 'recursive_descent':
            case 'optional':
            case 'pipe':
            case 'comma':
            case 'conditional':
            case 'trycatch':
            case 'call':
            case 'user_call':
            case 'unresolved_user_call':
            case 'binary':
            case 'unary':
            case 'bind':
            case 'label':
            case 'break':
            case 'assign':
            case 'update':
            case 'reduce':
            case 'foreach':
              filter = { kind: 'optional', body: filter };
              break;
            default: {
              const _ex: never = filter;
              throw new Error(`Unhandled jq filter: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
            }
            }
          }
          grouped = false;
          continue;
        case '|':
        case '//':
        case ',':
        case '==':
        case '!=':
        case '<':
        case '<=':
        case '>':
        case '>=':
        case '=':
        case '|=':
        case '+=':
        case '-=':
        case '*=':
        case '/=':
        case '%=':
        case '//=':
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
        case ':':
          return { ok: true, filter };
        default: {
          const _ex: never = token;
          throw new Error(`Unhandled jq operator token: ${JSON.stringify(_ex)}`);
        }
        }
      case 'recursive_descent':
      case 'identifier':
      case 'variable':
      case 'number':
      case 'string':
      case 'keyword':
      case 'eof':
        return { ok: true, filter };
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    }
  }

  private parsePrimary(): ParseResult {
    const token = this.peek();
    switch (token.kind) {
    case 'dot': {
      this.index += 1;
      let filter: JqFilter = { kind: 'identity' };
      while (true) {
        const next = this.peek();
        switch (next.kind) {
        case 'identifier':
          this.index += 1;
          filter = { kind: 'field', input: filter, key: next.value, optional: false };
          continue;
        case 'punctuation':
          switch (next.value) {
          case '[': {
            const suffix = this.parseBracketSuffix({ input: filter });
            if (!suffix.ok) return suffix;
            filter = suffix.filter;
            continue;
          }
          case ']':
          case '{':
          case '}':
          case '(':
          case ')':
          case ';':
            return { ok: true, filter };
          default: {
            const _ex: never = next;
            throw new Error(`Unhandled jq punctuation token: ${JSON.stringify(_ex)}`);
          }
          }
        case 'dot':
        case 'recursive_descent':
        case 'variable':
        case 'number':
        case 'string':
        case 'keyword':
        case 'operator':
        case 'eof':
          return { ok: true, filter };
        default: {
          const _ex: never = next;
          throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      }
    }
    case 'recursive_descent':
      this.index += 1;
      return {
        ok: true,
        filter: { kind: 'recursive_descent', input: { kind: 'identity' } },
      };
    case 'number':
      this.index += 1;
      return { ok: true, filter: { kind: 'literal', value: token.value, numberOrigin: token.origin } };
    case 'string': {
      this.index += 1;
      return parseStringToken({
        parts: token.parts,
        parseInterpolation: ({ source }) => this.parseStringInterpolation({ source }),
      });
    }
    case 'variable':
      this.index += 1;
      return {
        ok: true,
        filter: { kind: 'variable', name: this.resolveVariableName({ name: token.value }) },
      };
    case 'keyword':
      switch (token.value) {
      case 'def':
        return this.parseLocalDefinition();
      case 'if':
        return this.parseConditional();
      case 'try':
        return this.parseTryCatch();
      case 'reduce':
        return this.parseReduce();
      case 'foreach':
        return this.parseForeach();
      case 'true':
        this.index += 1;
        return { ok: true, filter: { kind: 'literal', value: true } };
      case 'false':
        this.index += 1;
        return { ok: true, filter: { kind: 'literal', value: false } };
      case 'null':
        this.index += 1;
        return { ok: true, filter: { kind: 'literal', value: null } };
      default:
        return { ok: false, message: `unexpected keyword '${token.value}'` };
      }
    case 'identifier':
      switch (token.value) {
      case 'label':
        return this.parseLabel();
      case 'break':
        return this.parseBreak();
      default:
        return this.parseCall();
      }
    case 'punctuation':
      switch (token.value) {
      case '(':
        this.index += 1;
        {
          const nested = this.parseComma();
          if (!nested.ok) return nested;
          const close = this.consumePunctuation({ value: ')' });
          if (!close.ok) return close;
          return { ok: true, filter: nested.filter, grouped: true };
        }
      case '[':
        return this.parseArrayLiteral();
      case '{':
        return this.parseObjectLiteral();
      default:
        return { ok: false, message: `unexpected token '${token.value}'` };
      }
    default:
      return { ok: false, message: 'expected filter' };
    }
  }

  private parseBracketSuffix({
    input,
  }: {
    input: JqFilter,
  }): ParseResult {
    const open = this.consumePunctuation({ value: '[' });
    if (!open.ok) return open;

    if (this.matchPunctuation({ value: ']' })) {
      return { ok: true, filter: { kind: 'iterate', input, optional: false } };
    }

    let start: JqFilter | undefined;
    if (!this.matchOperator({ value: ':' })) {
      const first = this.parseComma();
      if (!first.ok) return first;
      start = first.filter;

      if (!this.matchOperator({ value: ':' })) {
        const close = this.consumePunctuation({ value: ']' });
        if (!close.ok) return close;
        const staticIndex = literalIndex({ filter: start });
        switch (staticIndex?.kind) {
        case 'number':
          return {
            ok: true,
            filter: { kind: 'index', input, index: staticIndex.value, optional: false },
          };
        case 'string':
          return {
            ok: true,
            filter: { kind: 'field', input, key: staticIndex.value, optional: false },
          };
        case undefined:
          return {
            ok: true,
            filter: { kind: 'dynamic_index', input, index: start, optional: false },
          };
        default: {
          const _ex: never = staticIndex;
          throw new Error(`Unhandled static jq index: ${JSON.stringify(_ex)}`);
        }
        }
      }
    }

    let end: JqFilter | undefined;
    const next = this.peek();
    if (!(next.kind === 'punctuation' && next.value === ']')) {
      const parsedEnd = this.parsePipe();
      if (!parsedEnd.ok) return parsedEnd;
      end = parsedEnd.filter;
    }
    const close = this.consumePunctuation({ value: ']' });
    if (!close.ok) return close;
    return {
      ok: true,
      filter: { kind: 'slice', input, start, end, optional: false },
    };
  }

  private parseCall(): ParseResult {
    const token = this.peek();
    switch (token.kind) {
    case 'identifier':
      break;
    case 'dot':
    case 'recursive_descent':
    case 'variable':
    case 'number':
    case 'string':
    case 'keyword':
    case 'operator':
    case 'punctuation':
    case 'eof':
      return { ok: false, message: 'expected identifier' };
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    for (let scopeIndex = this.filterParameterScopes.length - 1; scopeIndex >= 0; scopeIndex -= 1) {
      if (this.filterParameterScopes[scopeIndex]?.has(token.value) !== true) continue;
      this.index += 1;
      const following = this.peek();
      if (following.kind === 'punctuation' && following.value === '(') {
        return { ok: false, message: `filter parameter '${token.value}' cannot be called with arguments` };
      }
      return {
        ok: true,
        filter: {
          kind: 'variable',
          name: createJqFilterParameterMarker({ name: token.value }),
        },
      };
    }
    const definitionOverloads = this.definitions.get(token.value);
    if (definitionOverloads !== undefined) {
      this.index += 1;
      const args: JqFilter[] = [];
      if (this.matchPunctuation({ value: '(' })) {
        if (this.matchPunctuation({ value: ')' })) {
          return { ok: false, message: 'empty user-defined filter call argument list is not supported' };
        }
        while (true) {
          const argument = this.parseComma();
          if (!argument.ok) return argument;
          args.push(argument.filter);
          if (this.matchPunctuation({ value: ')' })) break;
          if (!this.matchPunctuation({ value: ';' })) {
            return { ok: false, message: "expected ';' or ')' after function argument" };
          }
        }
      }
      const definition = definitionOverloads.get(args.length);
      if (definition === undefined) {
        return {
          ok: false,
          message: `user-defined filter '${token.value}' with ${args.length} argument(s) is not defined`,
        };
      }
      if (definition.body === undefined) {
        return { ok: true, filter: { kind: 'user_call', definitionId: definition.id, args } };
      }
      const completedDefinition: JqUserDefinition = {
        id: definition.id,
        name: definition.name,
        parameters: definition.parameters,
        body: definition.body,
      };
      return {
        ok: true,
        filter: instantiateJqUserDefinition({ definition: completedDefinition, args }),
      };
    }

    if (token.value === 'env') {
      this.index += 1;
      return { ok: true, filter: { kind: 'variable', name: 'ENV' } };
    }

    const name = toBuiltinName({ name: token.value });
    if (name === undefined) {
      if (this.definitionBodyDepth === 0) {
        return { ok: false, message: `unsupported syntax: identifier '${token.value}'` };
      }
      this.index += 1;
      const args: JqFilter[] = [];
      if (this.matchPunctuation({ value: '(' })) {
        if (this.matchPunctuation({ value: ')' })) {
          return { ok: false, message: 'empty user-defined filter call argument list is not supported' };
        }
        while (true) {
          const argument = this.parseComma();
          if (!argument.ok) return argument;
          args.push(argument.filter);
          if (this.matchPunctuation({ value: ')' })) break;
          if (!this.matchPunctuation({ value: ';' })) {
            return { ok: false, message: "expected ';' or ')' after function argument" };
          }
        }
      }
      return { ok: true, filter: { kind: 'unresolved_user_call', name: token.value, args } };
    }
    this.index += 1;

    if (!this.matchPunctuation({ value: '(' })) {
      return { ok: true, filter: { kind: 'call', name, args: [] } };
    }

    const args: JqFilter[] = [];
    if (!this.matchPunctuation({ value: ')' })) {
      while (true) {
        const argument = this.parseComma();
        if (!argument.ok) return argument;
        args.push(argument.filter);
        if (this.matchPunctuation({ value: ')' })) break;
        if (!this.matchPunctuation({ value: ';' })) {
          return { ok: false, message: "expected ';' or ')' after function argument" };
        }
      }
    }

    return { ok: true, filter: { kind: 'call', name, args } };
  }

  private parseArrayLiteral(): ParseResult {
    const open = this.consumePunctuation({ value: '[' });
    if (!open.ok) return open;
    if (this.matchPunctuation({ value: ']' })) {
      return { ok: true, filter: { kind: 'array', items: [] } };
    }

    const value = this.parseComma();
    if (!value.ok) return value;
    const close = this.consumePunctuation({ value: ']' });
    if (!close.ok) return close;
    return { ok: true, filter: { kind: 'array', items: [value.filter] } };
  }

  private parseObjectLiteral(): ParseResult {
    const open = this.consumePunctuation({ value: '{' });
    if (!open.ok) return open;
    const entries: JqObjectEntry[] = [];

    if (this.matchPunctuation({ value: '}' })) {
      return { ok: true, filter: { kind: 'object', entries } };
    }

    while (true) {
      const parsedKey = this.parseObjectKey();
      if (!parsedKey.ok) return parsedKey;
      const { key, shorthand } = parsedKey;

      let value: JqFilter;
      if (this.matchOperator({ value: ':' })) {
        const parsedValue = this.parsePipe({ allowComma: false });
        if (!parsedValue.ok) return parsedValue;
        value = parsedValue.filter;
      } else if (shorthand !== undefined) {
        value = {
          kind: 'field',
          input: { kind: 'identity' },
          key: shorthand,
          optional: false,
        };
      } else {
        return { ok: false, message: "expected ':' after object key" };
      }

      entries.push({ key, value });
      if (this.matchPunctuation({ value: '}' })) break;
      if (!this.matchOperator({ value: ',' })) {
        return { ok: false, message: "expected ',' or '}' in object" };
      }
    }

    return { ok: true, filter: { kind: 'object', entries } };
  }

  private parseObjectKey():
    | { ok: true, key: JqObjectKey, shorthand: string | undefined }
    | { ok: false, message: string } {
    const token = this.peek();
    switch (token.kind) {
    case 'identifier':
      this.index += 1;
      return {
        ok: true,
        key: { kind: 'static', value: token.value },
        shorthand: token.value,
      };
    case 'string': {
      this.index += 1;
      const parsed = parseStringToken({
        parts: token.parts,
        parseInterpolation: ({ source }) => this.parseStringInterpolation({ source }),
      });
      if (!parsed.ok) return parsed;
      if (parsed.filter.kind === 'literal' && typeof parsed.filter.value === 'string') {
        return {
          ok: true,
          key: { kind: 'static', value: parsed.filter.value },
          shorthand: undefined,
        };
      }
      return {
        ok: true,
        key: { kind: 'dynamic', filter: parsed.filter },
        shorthand: undefined,
      };
    }
    case 'punctuation':
      switch (token.value) {
      case '(': {
        this.index += 1;
        const filter = this.parseComma();
        if (!filter.ok) return filter;
        const close = this.consumePunctuation({ value: ')' });
        if (!close.ok) return close;
        return {
          ok: true,
          key: { kind: 'dynamic', filter: filter.filter },
          shorthand: undefined,
        };
      }
      case '[':
      case ']':
      case '{':
      case '}':
      case ')':
      case ';':
        return { ok: false, message: 'expected object key' };
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled jq punctuation token: ${JSON.stringify(_ex)}`);
      }
      }
    case 'dot':
    case 'recursive_descent':
    case 'variable':
    case 'number':
    case 'keyword':
    case 'operator':
    case 'eof':
      return { ok: false, message: 'expected object key' };
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }

  private parseConditional(): ParseResult {
    this.index += 1;
    const branches: {
      readonly condition: JqFilter,
      readonly thenBranch: JqFilter,
    }[] = [];

    const initialCondition = this.parseComma();
    if (!initialCondition.ok) return initialCondition;
    if (!this.matchKeyword({ value: 'then' })) {
      return { ok: false, message: "expected 'then'" };
    }
    const initialThenBranch = this.parseComma();
    if (!initialThenBranch.ok) return initialThenBranch;
    branches.push({
      condition: initialCondition.filter,
      thenBranch: initialThenBranch.filter,
    });

    while (this.matchKeyword({ value: 'elif' })) {
      const condition = this.parseComma();
      if (!condition.ok) return condition;
      if (!this.matchKeyword({ value: 'then' })) {
        return { ok: false, message: "expected 'then'" };
      }
      const thenBranch = this.parseComma();
      if (!thenBranch.ok) return thenBranch;
      branches.push({
        condition: condition.filter,
        thenBranch: thenBranch.filter,
      });
    }

    if (!this.matchKeyword({ value: 'else' })) {
      return { ok: false, message: "expected 'else' or 'elif'" };
    }
    const parsedElse = this.parseComma();
    if (!parsedElse.ok) return parsedElse;
    if (!this.matchKeyword({ value: 'end' })) {
      return { ok: false, message: "expected 'end'" };
    }

    let filter = parsedElse.filter;
    for (let index = branches.length - 1; index >= 0; index -= 1) {
      const branch = branches[index];
      if (branch === undefined) throw new Error('jq conditional branch is missing');
      filter = {
        kind: 'conditional',
        condition: branch.condition,
        thenBranch: branch.thenBranch,
        elseBranch: filter,
      };
    }
    return { ok: true, filter };
  }

  private parseLabel(): ParseResult {
    this.index += 1;
    const variable = this.peek();
    switch (variable.kind) {
    case 'variable':
      break;
    case 'dot':
    case 'recursive_descent':
    case 'identifier':
    case 'number':
    case 'string':
    case 'keyword':
    case 'operator':
    case 'punctuation':
    case 'eof':
      return { ok: false, message: "expected variable name after 'label'" };
    default: {
      const _ex: never = variable;
      throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    this.index += 1;
    if (!this.matchOperator({ value: '|' })) {
      return { ok: false, message: "'label' requires '|'" };
    }
    const id = this.nextLabelId++;
    this.activeLabels.push({ name: variable.value, id });
    try {
      return this.parseNestedPrefix({
        parse: () => {
          const body = this.parsePipe();
          if (!body.ok) return body;
          return { ok: true, filter: { kind: 'label', id, name: variable.value, body: body.filter } };
        },
      });
    } finally {
      this.activeLabels.pop();
    }
  }

  private parseBreak(): ParseResult {
    this.index += 1;
    const variable = this.peek();
    switch (variable.kind) {
    case 'variable':
      break;
    case 'dot':
    case 'recursive_descent':
    case 'identifier':
    case 'number':
    case 'string':
    case 'keyword':
    case 'operator':
    case 'punctuation':
    case 'eof':
      return { ok: false, message: "expected variable name after 'break'" };
    default: {
      const _ex: never = variable;
      throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    this.index += 1;
    for (let index = this.activeLabels.length - 1; index >= 0; index -= 1) {
      const label = this.activeLabels[index];
      if (label?.name === variable.value) {
        return { ok: true, filter: { kind: 'break', id: label.id, name: variable.value } };
      }
    }
    return { ok: false, message: `$*label-${variable.value} is not defined` };
  }

  private parseReduce(): ParseResult {
    this.index += 1;
    const generator = this.parseAssignment();
    if (!generator.ok) return generator;
    if (!this.matchKeyword({ value: 'as' })) {
      return { ok: false, message: "expected 'as' in reduce expression" };
    }

    const variable = this.peek();
    switch (variable.kind) {
    case 'variable':
      break;
    case 'dot':
    case 'recursive_descent':
    case 'identifier':
    case 'number':
    case 'string':
    case 'keyword':
    case 'operator':
    case 'punctuation':
    case 'eof':
      return { ok: false, message: 'expected variable name in reduce expression' };
    default: {
      const _ex: never = variable;
      throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    this.index += 1;

    const open = this.consumePunctuation({ value: '(' });
    if (!open.ok) return open;
    const initial = this.parseComma();
    if (!initial.ok) return initial;
    if (!this.matchPunctuation({ value: ';' })) {
      return { ok: false, message: "expected ';' in reduce expression" };
    }

    const renamedName = this.createLexicalVariableName();
    this.pushVariableRename({ sourceName: variable.value, renamedName });
    let update: ParseResult;
    try {
      update = this.parseComma();
    } finally {
      this.variableRenameScopes.pop();
    }
    if (!update.ok) return update;
    const close = this.consumePunctuation({ value: ')' });
    if (!close.ok) return close;

    return {
      ok: true,
      filter: {
        kind: 'reduce',
        generator: generator.filter,
        name: renamedName,
        initial: initial.filter,
        update: update.filter,
      },
    };
  }

  private parseForeach(): ParseResult {
    this.index += 1;
    const generator = this.parseAssignment();
    if (!generator.ok) return generator;
    if (!this.matchKeyword({ value: 'as' })) {
      return { ok: false, message: "expected 'as' in foreach expression" };
    }

    const variable = this.peek();
    switch (variable.kind) {
    case 'variable':
      break;
    case 'dot':
    case 'recursive_descent':
    case 'identifier':
    case 'number':
    case 'string':
    case 'keyword':
    case 'operator':
    case 'punctuation':
    case 'eof':
      return { ok: false, message: 'expected variable name in foreach expression' };
    default: {
      const _ex: never = variable;
      throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    this.index += 1;

    const open = this.consumePunctuation({ value: '(' });
    if (!open.ok) return open;
    const initial = this.parseComma();
    if (!initial.ok) return initial;
    if (!this.matchPunctuation({ value: ';' })) {
      return { ok: false, message: "expected first ';' in foreach expression" };
    }

    const renamedName = this.createLexicalVariableName();
    this.pushVariableRename({ sourceName: variable.value, renamedName });
    let update: ParseResult;
    let extract: JqFilter = { kind: 'identity' };
    try {
      update = this.parseComma();
      if (update.ok && this.matchPunctuation({ value: ';' })) {
        const parsedExtract = this.parseComma();
        if (!parsedExtract.ok) return parsedExtract;
        extract = parsedExtract.filter;
      }
    } finally {
      this.variableRenameScopes.pop();
    }
    if (!update.ok) return update;
    const close = this.consumePunctuation({ value: ')' });
    if (!close.ok) return close;

    return {
      ok: true,
      filter: {
        kind: 'foreach',
        generator: generator.filter,
        name: renamedName,
        initial: initial.filter,
        update: update.filter,
        extract,
      },
    };
  }

  private parseTryCatch(): ParseResult {
    this.index += 1;
    return this.parseNestedPrefix({
      parse: () => {
        const body = this.parseOr();
        if (!body.ok) return body;

        if (!this.matchKeyword({ value: 'catch' })) {
          return {
            ok: true,
            filter: {
              kind: 'trycatch',
              body: body.filter,
              catchBranch: { kind: 'call', name: 'empty', args: [] },
            },
          };
        }

        const catchBranch = this.parseOr();
        if (!catchBranch.ok) return catchBranch;
        return {
          ok: true,
          filter: {
            kind: 'trycatch',
            body: body.filter,
            catchBranch: catchBranch.filter,
          },
        };
      },
    });
  }

  private parseNestedPrefix({
    parse,
  }: {
    parse: () => ParseResult,
  }): ParseResult {
    if (this.prefixNestingDepth >= JQ_MAX_PARSER_PREFIX_NESTING) {
      return {
        ok: false,
        message: `parser prefix nesting exceeds limit ${JQ_MAX_PARSER_PREFIX_NESTING}`,
      };
    }
    this.prefixNestingDepth += 1;
    try {
      return parse();
    } finally {
      this.prefixNestingDepth -= 1;
    }
  }

  private peek(): JqToken {
    return this.tokens[this.index] ?? { kind: 'eof' };
  }

  private matchOperator({
    value,
  }: {
    value: Extract<JqToken, { kind: 'operator' }>['value'],
  }): boolean {
    const token = this.peek();
    if (!(token.kind === 'operator' && token.value === value)) return false;
    this.index += 1;
    return true;
  }

  private matchKeyword({
    value,
  }: {
    value: Extract<JqToken, { kind: 'keyword' }>['value'],
  }): boolean {
    const token = this.peek();
    if (!(token.kind === 'keyword' && token.value === value)) return false;
    this.index += 1;
    return true;
  }

  private matchPunctuation({
    value,
  }: {
    value: Extract<JqToken, { kind: 'punctuation' }>['value'],
  }): boolean {
    const token = this.peek();
    if (!(token.kind === 'punctuation' && token.value === value)) return false;
    this.index += 1;
    return true;
  }

  private consumePunctuation({
    value,
  }: {
    value: Extract<JqToken, { kind: 'punctuation' }>['value'],
  }): { ok: true } | { ok: false, message: string } {
    if (this.matchPunctuation({ value })) return { ok: true };
    return { ok: false, message: `expected '${value}'` };
  }
}

function comparisonOperator({
  operator,
}: {
  operator: Extract<JqToken, { kind: 'operator' }>['value'],
}): JqBinaryOperator | undefined {
  switch (operator) {
  case '==':
    return 'eq';
  case '!=':
    return 'ne';
  case '<':
    return 'lt';
  case '<=':
    return 'le';
  case '>':
    return 'gt';
  case '>=':
    return 'ge';
  default:
    return undefined;
  }
}

function compoundAssignmentOperator({
  operator,
}: {
  operator: '+=' | '-=' | '*=' | '/=' | '%=' | '//=',
}): JqCompoundAssignmentOperator {
  switch (operator) {
  case '+=':
    return 'add';
  case '-=':
    return 'sub';
  case '*=':
    return 'mul';
  case '/=':
    return 'div';
  case '%=':
    return 'mod';
  case '//=':
    return 'alternative';
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled compound assignment operator: ${_ex}`);
  }
  }
}

function literalIndex({
  filter,
}: {
  filter: JqFilter,
}): { kind: 'number', value: number } | { kind: 'string', value: string } | undefined {
  let current = filter;
  let numericSign = 1;
  while (current.kind === 'unary' && current.operator === 'neg') {
    numericSign = -numericSign;
    current = current.value;
  }

  switch (current.kind) {
  case 'literal':
    if (typeof current.value === 'number') {
      return { kind: 'number', value: numericSign * current.value };
    }
    if (numericSign === 1 && typeof current.value === 'string') {
      return { kind: 'string', value: current.value };
    }
    return undefined;
  case 'identity':
  case 'variable':
  case 'string':
  case 'array':
  case 'object':
  case 'field':
  case 'index':
  case 'dynamic_index':
  case 'slice':
  case 'iterate':
  case 'recursive_descent':
  case 'optional':
  case 'pipe':
  case 'comma':
  case 'conditional':
  case 'trycatch':
  case 'call':
  case 'user_call':
  case 'unresolved_user_call':
  case 'binary':
  case 'unary':
  case 'bind':
  case 'label':
  case 'break':
  case 'reduce':
  case 'foreach':
  case 'assign':
  case 'update':
    return undefined;
  default: {
    const _ex: never = current;
    throw new Error(`Unhandled jq filter: ${JSON.stringify(_ex)}`);
  }
  }
}

function parseStringToken({
  parts,
  parseInterpolation,
}: {
  parts: JqStringTokenPart[],
  parseInterpolation: ({ source }: { source: string }) =>
    { ok: true, program: JqProgram } | { ok: false, message: string },
}): ParseResult {
  if (parts.length === 0) {
    return { ok: true, filter: { kind: 'literal', value: '' } };
  }
  if (parts.length === 1 && parts[0]?.kind === 'text') {
    return { ok: true, filter: { kind: 'literal', value: parts[0].value } };
  }

  const parsedParts: JqStringPart[] = [];
  for (const part of parts) {
    switch (part.kind) {
    case 'text':
      parsedParts.push(part);
      break;
    case 'interpolation': {
      const parsed = parseInterpolation({ source: part.source });
      if (!parsed.ok) {
        return { ok: false, message: `invalid string interpolation: ${parsed.message}` };
      }
      parsedParts.push({ kind: 'interpolation', filter: parsed.program.filter });
      break;
    }
    default: {
      const _ex: never = part;
      throw new Error(`Unhandled string token part: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return { ok: true, filter: { kind: 'string', parts: parsedParts } };
}

function validateJqStructuralNesting({
  tokens,
}: {
  tokens: readonly JqToken[],
}): string | undefined {
  let delimiterDepth = 0;
  let conditionalDepth = 0;
  const exceedsLimit = (): boolean => (
    delimiterDepth + conditionalDepth > JQ_MAX_PARSER_STRUCTURAL_NESTING
  );

  for (const token of tokens) {
    switch (token.kind) {
    case 'punctuation':
      switch (token.value) {
      case '(':
      case '[':
      case '{':
        delimiterDepth += 1;
        if (exceedsLimit()) {
          return `parser structural nesting exceeds limit ${JQ_MAX_PARSER_STRUCTURAL_NESTING}`;
        }
        break;
      case ')':
      case ']':
      case '}':
        if (delimiterDepth > 0) delimiterDepth -= 1;
        break;
      case ';':
        break;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled jq punctuation token: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    case 'keyword':
      switch (token.value) {
      case 'if':
        conditionalDepth += 1;
        if (exceedsLimit()) {
          return `parser structural nesting exceeds limit ${JQ_MAX_PARSER_STRUCTURAL_NESTING}`;
        }
        break;
      case 'end':
        if (conditionalDepth > 0) conditionalDepth -= 1;
        break;
      case 'true':
      case 'false':
      case 'null':
      case 'and':
      case 'or':
      case 'not':
      case 'then':
      case 'elif':
      case 'else':
      case 'try':
      case 'catch':
      case 'def':
      case 'reduce':
      case 'foreach':
      case 'as':
        break;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled jq keyword token: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    case 'dot':
    case 'recursive_descent':
    case 'identifier':
    case 'variable':
    case 'number':
    case 'string':
    case 'operator':
    case 'eof':
      break;
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled jq token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }
  return undefined;
}

function parseJqProgramAtInterpolationDepth({
  source,
  interpolationDepth,
}: {
  source: string,
  interpolationDepth: number,
}): { ok: true, program: JqProgram } | { ok: false, message: string } {
  const lexed = lexJq({ source });
  if (!lexed.ok) return lexed;
  const nestingMessage = validateJqStructuralNesting({ tokens: lexed.tokens });
  if (nestingMessage !== undefined) return { ok: false, message: nestingMessage };
  return new JqParser({ tokens: lexed.tokens, interpolationDepth }).parse();
}

export function parseJqProgram({
  source,
}: {
  source: string,
}): { ok: true, program: JqProgram } | { ok: false, message: string } {
  return parseJqProgramAtInterpolationDepth({ source, interpolationDepth: 0 });
}

function staticSliceBound({
  filter,
}: {
  filter: JqFilter | undefined,
}): { supported: true, value: number | undefined } | { supported: false } {
  if (filter === undefined) return { supported: true, value: undefined };
  switch (filter.kind) {
  case 'literal':
    if (filter.value === null) return { supported: true, value: undefined };
    return typeof filter.value === 'number'
      ? { supported: true, value: filter.value }
      : { supported: false };
  case 'identity':
  case 'variable':
  case 'string':
  case 'array':
  case 'object':
  case 'field':
  case 'index':
  case 'dynamic_index':
  case 'slice':
  case 'iterate':
  case 'recursive_descent':
  case 'optional':
  case 'pipe':
  case 'comma':
  case 'conditional':
  case 'trycatch':
  case 'call':
  case 'user_call':
  case 'unresolved_user_call':
  case 'binary':
  case 'unary':
  case 'bind':
  case 'label':
  case 'break':
  case 'reduce':
  case 'foreach':
  case 'assign':
  case 'update':
    return { supported: false };
  default: {
    const _ex: never = filter;
    throw new Error(`Unhandled jq filter: ${JSON.stringify(_ex)}`);
  }
  }
}

function appendPathExpressionSegment({
  expression,
  segment,
}: {
  expression: JqPathExpression,
  segment: JqPathSegment,
}): JqPathExpression {
  return { kind: 'append', parent: expression, segment };
}

type PathExtractionFrame =
  | { kind: 'evaluate', filter: JqFilter }
  | { kind: 'append', segment: JqPathSegment }
  | {
    kind: 'slice',
    start: JqFilter | undefined,
    end: JqFilter | undefined,
    optional: boolean,
  }
  | { kind: 'dynamic_index', index: JqFilter, optional: boolean }
  | { kind: 'iterate', optional: boolean }
  | { kind: 'comma_left', right: JqFilter }
  | { kind: 'comma_combine', left: JqPathExpression };

type PathExtractionResult = {
  readonly expression: JqPathExpression | undefined,
};

export function extractPathExpression({
  filter,
}: {
  filter: JqFilter,
}): JqPathExpression | undefined {
  const frames: PathExtractionFrame[] = [{ kind: 'evaluate', filter }];
  const results: PathExtractionResult[] = [];

  while (frames.length > 0) {
    const frame = frames.pop()!;
    switch (frame.kind) {
    case 'evaluate': {
      const current = frame.filter;
      switch (current.kind) {
      case 'identity':
        results.push({ expression: { kind: 'path', path: { segments: [] } } });
        break;
      case 'field':
        frames.push({
          kind: 'append',
          segment: { kind: 'field', key: current.key, optional: current.optional },
        });
        frames.push({ kind: 'evaluate', filter: current.input });
        break;
      case 'index':
        frames.push({
          kind: 'append',
          segment: { kind: 'index', index: current.index, optional: current.optional },
        });
        frames.push({ kind: 'evaluate', filter: current.input });
        break;
      case 'slice':
        frames.push({
          kind: 'slice',
          start: current.start,
          end: current.end,
          optional: current.optional,
        });
        frames.push({ kind: 'evaluate', filter: current.input });
        break;
      case 'comma':
        frames.push({ kind: 'comma_left', right: current.right });
        frames.push({ kind: 'evaluate', filter: current.left });
        break;
      case 'dynamic_index':
        frames.push({ kind: 'dynamic_index', index: current.index, optional: current.optional });
        frames.push({ kind: 'evaluate', filter: current.input });
        break;
      case 'iterate':
        frames.push({ kind: 'iterate', optional: current.optional });
        frames.push({ kind: 'evaluate', filter: current.input });
        break;
      case 'variable':
      case 'literal':
      case 'string':
      case 'array':
      case 'object':
      case 'recursive_descent':
      case 'optional':
      case 'pipe':
      case 'conditional':
      case 'trycatch':
      case 'call':
      case 'user_call':
      case 'unresolved_user_call':
      case 'binary':
      case 'unary':
      case 'bind':
      case 'label':
      case 'break':
      case 'reduce':
      case 'foreach':
      case 'assign':
      case 'update':
        results.push({ expression: undefined });
        break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled jq filter: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'append': {
      const parent = results.pop();
      if (parent === undefined) throw new Error('jq path extraction result stack is empty');
      results.push({
        expression: parent.expression === undefined
          ? undefined
          : appendPathExpressionSegment({ expression: parent.expression, segment: frame.segment }),
      });
      break;
    }
    case 'slice': {
      const parent = results.pop();
      if (parent === undefined) throw new Error('jq path extraction result stack is empty');
      if (parent.expression === undefined) {
        results.push(parent);
        break;
      }
      const start = staticSliceBound({ filter: frame.start });
      const end = staticSliceBound({ filter: frame.end });
      results.push({
        expression: !start.supported || !end.supported
          ? {
            kind: 'dynamic_slice',
            parent: parent.expression,
            start: frame.start,
            end: frame.end,
            optional: frame.optional,
          }
          : appendPathExpressionSegment({
            expression: parent.expression,
            segment: {
              kind: 'slice',
              start: start.value,
              end: end.value,
              optional: frame.optional,
            },
          }),
      });
      break;
    }
    case 'dynamic_index': {
      const parent = results.pop();
      if (parent === undefined) throw new Error('jq path extraction result stack is empty');
      results.push({
        expression: parent.expression === undefined
          ? undefined
          : {
            kind: 'dynamic_index',
            parent: parent.expression,
            index: frame.index,
            optional: frame.optional,
          },
      });
      break;
    }
    case 'iterate': {
      const parent = results.pop();
      if (parent === undefined) throw new Error('jq path extraction result stack is empty');
      results.push({
        expression: parent.expression === undefined
          ? undefined
          : { kind: 'iterate', parent: parent.expression, optional: frame.optional },
      });
      break;
    }
    case 'comma_left': {
      const left = results.pop();
      if (left === undefined) throw new Error('jq path extraction result stack is empty');
      if (left.expression === undefined) {
        results.push(left);
        break;
      }
      frames.push({ kind: 'comma_combine', left: left.expression });
      frames.push({ kind: 'evaluate', filter: frame.right });
      break;
    }
    case 'comma_combine': {
      const right = results.pop();
      if (right === undefined) throw new Error('jq path extraction result stack is empty');
      results.push({
        expression: right.expression === undefined
          ? undefined
          : { kind: 'sequence', items: [frame.left, right.expression] },
      });
      break;
    }
    default: {
      const _ex: never = frame;
      throw new Error(`Unhandled jq path extraction frame: ${JSON.stringify(_ex)}`);
    }
    }
  }

  if (results.length !== 1) {
    throw new Error(`jq path extraction produced ${results.length} result frames`);
  }
  return results[0]!.expression;
}

export function extractPath({
  filter,
}: {
  filter: JqFilter,
}): JqPath | undefined {
  const reversedSegments: JqPathSegment[] = [];
  let current: JqFilter = filter;

  while (true) {
    switch (current.kind) {
    case 'field':
      reversedSegments.push({ kind: 'field', key: current.key, optional: current.optional });
      current = current.input;
      continue;
    case 'index':
      reversedSegments.push({ kind: 'index', index: current.index, optional: current.optional });
      current = current.input;
      continue;
    case 'identity':
      reversedSegments.reverse();
      return { segments: reversedSegments };
    default:
      return undefined;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
