import type {
  JqBinaryOperator,
  JqBuiltinName,
  JqFilter,
  JqObjectEntry,
  JqObjectKey,
  JqPath,
  JqPathSegment,
  JqProgram,
  JqStringPart,
  JqStringTokenPart,
  JqToken,
} from './ast';
import { lexJq } from './lexer';

function toBuiltinName({
  name,
}: {
  name: string,
}): JqBuiltinName | undefined {
  switch (name) {
  case 'abs':
  case 'add':
  case 'all':
  case 'ascii_downcase':
  case 'ascii_upcase':
  case 'arrays':
  case 'any':
  case 'booleans':
  case 'bsearch':
  case 'ceil':
  case 'combinations':
  case 'contains':
  case 'del':
  case 'delpaths':
  case 'empty':
  case 'endswith':
  case 'error':
  case 'explode':
  case 'first':
  case 'flatten':
  case 'floor':
  case 'from_entries':
  case 'fromjson':
  case 'getpath':
  case 'group_by':
  case 'has':
  case 'implode':
  case 'index':
  case 'indices':
  case 'inside':
  case 'isempty':
  case 'join':
  case 'keys':
  case 'keys_unsorted':
  case 'last':
  case 'length':
  case 'limit':
  case 'log':
  case 'log10':
  case 'log2':
  case 'ltrimstr':
  case 'map':
  case 'map_values':
  case 'max':
  case 'max_by':
  case 'min':
  case 'min_by':
  case 'nth':
  case 'nulls':
  case 'numbers':
  case 'objects':
  case 'path':
  case 'paths':
  case 'pick':
  case 'pow':
  case 'range':
  case 'recurse':
  case 'reverse':
  case 'rindex':
  case 'round':
  case 'rtrimstr':
  case 'scalars':
  case 'select':
  case 'setpath':
  case 'sort':
  case 'sort_by':
  case 'split':
  case 'sqrt':
  case 'startswith':
  case 'strings':
  case 'to_entries':
  case 'tojson':
  case 'tonumber':
  case 'transpose':
  case 'type':
  case 'unique':
  case 'unique_by':
  case 'utf8bytelength':
  case 'values':
  case 'tostring':
  case 'walk':
  case 'with_entries':
    return name;
  default:
    return undefined;
  }
}

type ParseResult =
  | { ok: true, filter: JqFilter }
  | { ok: false, message: string };

class JqParser {
  private readonly tokens: JqToken[];

  private index = 0;

  constructor({
    tokens,
  }: {
    tokens: JqToken[],
  }) {
    this.tokens = tokens;
  }

  parse(): { ok: true, program: JqProgram } | { ok: false, message: string } {
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
    return { ok: true, program: { filter: filter.filter } };
  }

  private parseAssignment(): ParseResult {
    const left = this.parseAlternative();
    if (!left.ok) return left;

    const token = this.peek();
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
    const right = this.parseAssignment();
    if (!right.ok) return right;
    const path = extractPath({ filter: left.filter });
    if (path === undefined) {
      return { ok: false, message: 'left-hand side of assignment must be a path' };
    }

    switch (token.value) {
    case '=':
      return { ok: true, filter: { kind: 'assign', path, value: right.filter } };
    case '|=':
      return { ok: true, filter: { kind: 'update', path, value: right.filter } };
    case '+=':
    case '-=':
    case '*=':
    case '/=':
    case '%=':
    case '//=': {
      const operator = compoundAssignmentOperator({ operator: token.value });
      return {
        ok: true,
        filter: {
          kind: 'update',
          path,
          value: {
            kind: 'binary',
            operator,
            left: { kind: 'identity' },
            right: right.filter,
          },
        },
      };
    }
    default:
      return { ok: false, message: `unsupported assignment operator '${token.value}'` };
    }
  }

  private parseComma(): ParseResult {
    let left = this.parsePipe();
    if (!left.ok) return left;

    while (this.matchOperator({ value: ',' })) {
      const right = this.parsePipe();
      if (!right.ok) return right;
      left = {
        ok: true,
        filter: { kind: 'comma', left: left.filter, right: right.filter },
      };
    }

    return left;
  }

  private parsePipe(): ParseResult {
    let left = this.parseAssignment();
    if (!left.ok) return left;

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
        const body = this.parsePipe();
        if (!body.ok) return body;
        return {
          ok: true,
          filter: {
            kind: 'bind',
            binding: left.filter,
            name: variable.value,
            body: body.filter,
          },
        };
      }

      if (!this.matchOperator({ value: '|' })) break;
      const right = this.parseAssignment();
      if (!right.ok) return right;
      left = {
        ok: true,
        filter: { kind: 'pipe', left: left.filter, right: right.filter },
      };
    }

    return left;
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
      const value = this.parseUnary();
      if (!value.ok) return value;
      return { ok: true, filter: { kind: 'unary', operator: 'not', value: value.filter } };
    }
    if (this.matchOperator({ value: '-' })) {
      const value = this.parseUnary();
      if (!value.ok) return value;
      return { ok: true, filter: { kind: 'unary', operator: 'neg', value: value.filter } };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ParseResult {
    const parsed = this.parsePrimary();
    if (!parsed.ok) return parsed;
    let filter = parsed.filter;

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
        continue;
      }
      case 'punctuation':
        switch (token.value) {
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
          const _ex: never = token;
          throw new Error(`Unhandled jq punctuation token: ${JSON.stringify(_ex)}`);
        }
        }
      case 'operator':
        switch (token.value) {
        case '?':
          this.index += 1;
          filter = { kind: 'optional', body: filter };
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
      return { ok: true, filter: { kind: 'literal', value: token.value } };
    case 'string': {
      this.index += 1;
      return parseStringToken({ parts: token.parts });
    }
    case 'variable':
      this.index += 1;
      return { ok: true, filter: { kind: 'variable', name: token.value } };
    case 'keyword':
      switch (token.value) {
      case 'if':
        return this.parseConditional();
      case 'try':
        return this.parseTryCatch();
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
      return this.parseCall();
    case 'punctuation':
      switch (token.value) {
      case '(':
        this.index += 1;
        {
          const nested = this.parseComma();
          if (!nested.ok) return nested;
          const close = this.consumePunctuation({ value: ')' });
          if (!close.ok) return close;
          return nested;
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
    const name = toBuiltinName({ name: token.value });
    if (name === undefined) {
      return { ok: false, message: `unsupported syntax: identifier '${token.value}'` };
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
        const parsedValue = this.parsePipe();
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
      const parsed = parseStringToken({ parts: token.parts });
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
    const condition = this.parseComma();
    if (!condition.ok) return condition;
    if (!this.matchKeyword({ value: 'then' })) {
      return { ok: false, message: "expected 'then'" };
    }
    const thenBranch = this.parseComma();
    if (!thenBranch.ok) return thenBranch;

    let elseBranch: JqFilter;
    if (this.matchKeyword({ value: 'else' })) {
      const parsedElse = this.parseComma();
      if (!parsedElse.ok) return parsedElse;
      elseBranch = parsedElse.filter;
    } else if (this.matchKeyword({ value: 'elif' })) {
      const nested = this.parseElifTail();
      if (!nested.ok) return nested;
      elseBranch = nested.filter;
    } else {
      return { ok: false, message: "expected 'else' or 'elif'" };
    }

    if (!this.matchKeyword({ value: 'end' })) {
      return { ok: false, message: "expected 'end'" };
    }
    return {
      ok: true,
      filter: {
        kind: 'conditional',
        condition: condition.filter,
        thenBranch: thenBranch.filter,
        elseBranch,
      },
    };
  }

  private parseElifTail(): ParseResult {
    const condition = this.parseComma();
    if (!condition.ok) return condition;
    if (!this.matchKeyword({ value: 'then' })) {
      return { ok: false, message: "expected 'then'" };
    }
    const thenBranch = this.parseComma();
    if (!thenBranch.ok) return thenBranch;

    let elseBranch: JqFilter;
    if (this.matchKeyword({ value: 'else' })) {
      const parsedElse = this.parseComma();
      if (!parsedElse.ok) return parsedElse;
      elseBranch = parsedElse.filter;
    } else if (this.matchKeyword({ value: 'elif' })) {
      const nested = this.parseElifTail();
      if (!nested.ok) return nested;
      elseBranch = nested.filter;
    } else {
      return { ok: false, message: "expected 'else' or 'elif'" };
    }

    return {
      ok: true,
      filter: {
        kind: 'conditional',
        condition: condition.filter,
        thenBranch: thenBranch.filter,
        elseBranch,
      },
    };
  }

  private parseTryCatch(): ParseResult {
    this.index += 1;
    const body = this.parseComma();
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

    const catchBranch = this.parseComma();
    if (!catchBranch.ok) return catchBranch;
    return {
      ok: true,
      filter: {
        kind: 'trycatch',
        body: body.filter,
        catchBranch: catchBranch.filter,
      },
    };
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
}): JqBinaryOperator {
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
  switch (filter.kind) {
  case 'literal':
    if (typeof filter.value === 'number') return { kind: 'number', value: filter.value };
    if (typeof filter.value === 'string') return { kind: 'string', value: filter.value };
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
  case 'binary':
  case 'unary':
  case 'bind':
  case 'assign':
  case 'update':
    return undefined;
  default: {
    const _ex: never = filter;
    throw new Error(`Unhandled jq filter: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

function parseStringToken({
  parts,
}: {
  parts: JqStringTokenPart[],
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
      const parsed = parseJqProgram({ source: part.source });
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

export function parseJqProgram({
  source,
}: {
  source: string,
}): { ok: true, program: JqProgram } | { ok: false, message: string } {
  const lexed = lexJq({ source });
  if (!lexed.ok) return lexed;
  return new JqParser({ tokens: lexed.tokens }).parse();
}

export function extractPath({
  filter,
}: {
  filter: JqFilter,
}): JqPath | undefined {
  const segments: JqPathSegment[] = [];
  let current: JqFilter = filter;

  while (true) {
    switch (current.kind) {
    case 'field':
      if (current.optional) return undefined;
      segments.unshift({ kind: 'field', key: current.key });
      current = current.input;
      continue;
    case 'index':
      if (current.optional) return undefined;
      segments.unshift({ kind: 'index', index: current.index });
      current = current.input;
      continue;
    case 'identity':
      return { segments };
    default:
      return undefined;
    }
  }
}
