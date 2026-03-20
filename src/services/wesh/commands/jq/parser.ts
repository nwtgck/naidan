import type {
  JqBuiltinName,
  JqFilter,
  JqObjectEntry,
  JqPath,
  JqPathSegment,
  JqProgram,
  JqToken,
} from './ast';
import { lexJq } from './lexer';

function toBuiltinName({
  name,
}: {
  name: string;
}): JqBuiltinName | undefined {
  switch (name) {
  case 'empty':
  case 'select':
  case 'map':
  case 'length':
  case 'keys':
  case 'type':
  case 'has':
    return name;
  default:
    return undefined;
  }
}

class JqParser {
  private readonly tokens: JqToken[];

  private index = 0;

  constructor({
    tokens,
  }: {
    tokens: JqToken[];
  }) {
    this.tokens = tokens;
  }

  parse(): { ok: true; program: JqProgram } | { ok: false; message: string } {
    const filter = this.parseAssignment();
    if (!filter.ok) return filter;

    const eof = this.peek();
    switch (eof.kind) {
    case 'eof':
      return { ok: true, program: { filter: filter.filter } };
    default:
      return { ok: false, message: 'unexpected trailing tokens' };
    }
  }

  private parseAssignment(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    const left = this.parseComma();
    if (!left.ok) return left;

    const token = this.peek();
    if (token.kind === 'operator' && (token.value === '=' || token.value === '|=')) {
      this.index += 1;
      const right = this.parseAssignment();
      if (!right.ok) return right;

      const path = extractPath({
        filter: left.filter,
      });
      if (path === undefined) {
        return { ok: false, message: 'left-hand side of assignment must be a path' };
      }

      const filter = (() => {
        switch (token.value) {
        case '=':
          return { kind: 'assign', path, value: right.filter } satisfies JqFilter;
        case '|=':
          return { kind: 'update', path, value: right.filter } satisfies JqFilter;
        default: {
          const _ex: never = token.value;
          throw new Error(`Unhandled assignment operator: ${_ex}`);
        }
        }
      })();

      return {
        ok: true,
        filter,
      };
    }

    return left;
  }

  private parseExpressionList({
    terminator,
  }: {
    terminator: ')' | ']' | '}';
  }): { ok: true; filters: JqFilter[] } | { ok: false; message: string } {
    const filters: JqFilter[] = [];

    while (true) {
      const filter = this.parseAssignmentItem();
      if (!filter.ok) return filter;
      filters.push(filter.filter);

      const token = this.peek();
      if (!(token.kind === 'operator' && token.value === ',')) {
        break;
      }

      const next = this.peekOffset({ offset: 1 });
      if (next.kind === 'punctuation' && next.value === terminator) {
        break;
      }

      this.index += 1;
    }

    return { ok: true, filters };
  }

  private parseAssignmentItem(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    const left = this.parsePipe();
    if (!left.ok) return left;

    const token = this.peek();
    if (token.kind === 'operator' && (token.value === '=' || token.value === '|=')) {
      this.index += 1;
      const right = this.parseAssignmentItem();
      if (!right.ok) return right;

      const path = extractPath({
        filter: left.filter,
      });
      if (path === undefined) {
        return { ok: false, message: 'left-hand side of assignment must be a path' };
      }

      const filter = (() => {
        switch (token.value) {
        case '=':
          return { kind: 'assign', path, value: right.filter } satisfies JqFilter;
        case '|=':
          return { kind: 'update', path, value: right.filter } satisfies JqFilter;
        default: {
          const _ex: never = token.value;
          throw new Error(`Unhandled assignment operator: ${_ex}`);
        }
        }
      })();

      return {
        ok: true,
        filter,
      };
    }

    return left;
  }

  private parseComma(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    let filter = this.parsePipe();
    if (!filter.ok) return filter;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'operator' && token.value === ',')) break;
      this.index += 1;
      const right = this.parsePipe();
      if (!right.ok) return right;
      filter = {
        ok: true,
        filter: { kind: 'comma', left: filter.filter, right: right.filter },
      };
    }

    return filter;
  }

  private parsePipe(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    let filter = this.parseOr();
    if (!filter.ok) return filter;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'operator' && token.value === '|')) break;
      this.index += 1;
      const right = this.parseOr();
      if (!right.ok) return right;
      filter = {
        ok: true,
        filter: { kind: 'pipe', left: filter.filter, right: right.filter },
      };
    }

    return filter;
  }

  private parseOr(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    let filter = this.parseAnd();
    if (!filter.ok) return filter;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'keyword' && token.value === 'or')) break;
      this.index += 1;
      const right = this.parseAnd();
      if (!right.ok) return right;
      filter = {
        ok: true,
        filter: { kind: 'binary', operator: 'or', left: filter.filter, right: right.filter },
      };
    }

    return filter;
  }

  private parseAnd(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    let filter = this.parseComparison();
    if (!filter.ok) return filter;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'keyword' && token.value === 'and')) break;
      this.index += 1;
      const right = this.parseComparison();
      if (!right.ok) return right;
      filter = {
        ok: true,
        filter: { kind: 'binary', operator: 'and', left: filter.filter, right: right.filter },
      };
    }

    return filter;
  }

  private parseComparison(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    let filter = this.parseAddition();
    if (!filter.ok) return filter;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'operator' && ['==', '!=', '<', '<=', '>', '>='].includes(token.value))) {
        break;
      }

      this.index += 1;
      const right = this.parseAddition();
      if (!right.ok) return right;

      const operator = (() => {
        switch (token.value) {
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
      })();
      if (operator === undefined) {
        return { ok: false, message: `unsupported syntax: operator '${token.value}'` };
      }

      filter = {
        ok: true,
        filter: { kind: 'binary', operator, left: filter.filter, right: right.filter },
      };
    }

    return filter;
  }

  private parseAddition(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    let filter = this.parseUnary();
    if (!filter.ok) return filter;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'operator' && token.value === '+')) break;
      this.index += 1;
      const right = this.parseUnary();
      if (!right.ok) return right;
      filter = {
        ok: true,
        filter: { kind: 'binary', operator: 'add', left: filter.filter, right: right.filter },
      };
    }

    return filter;
  }

  private parseUnary(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    const token = this.peek();
    if (token.kind === 'keyword' && token.value === 'not') {
      this.index += 1;
      const value = this.parseUnary();
      if (!value.ok) return value;
      return { ok: true, filter: { kind: 'unary', operator: 'not', value: value.filter } };
    }

    return this.parsePostfix();
  }

  private parsePostfix(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    let filter = this.parsePrimary();
    if (!filter.ok) return filter;

    while (true) {
      const token = this.peek();
      switch (token.kind) {
      case 'dot': {
        this.index += 1;
        const field = this.consumeIdentifier();
        if (!field.ok) return field;
        filter = {
          ok: true,
          filter: { kind: 'field', input: filter.filter, key: field.value },
        };
        continue;
      }
      case 'punctuation':
        switch (token.value) {
        case '[': {
          this.index += 1;
          const next = this.peek();
          if (next.kind === 'punctuation' && next.value === ']') {
            this.index += 1;
            filter = { ok: true, filter: { kind: 'iterate', input: filter.filter } };
            continue;
          }

          const indexToken = this.peek();
          switch (indexToken.kind) {
          case 'number':
            this.index += 1;
            {
              const closeToken = this.peek();
              if (!(closeToken.kind === 'punctuation' && closeToken.value === ']')) {
                return { ok: false, message: 'unsupported syntax inside []' };
              }
              this.index += 1;
              filter = {
                ok: true,
                filter: { kind: 'index', input: filter.filter, index: indexToken.value },
              };
            }
            continue;
          case 'string':
            this.index += 1;
            {
              const closeToken = this.peek();
              if (!(closeToken.kind === 'punctuation' && closeToken.value === ']')) {
                return { ok: false, message: 'unsupported syntax inside []' };
              }
              this.index += 1;
              filter = {
                ok: true,
                filter: { kind: 'field', input: filter.filter, key: indexToken.value },
              };
            }
            continue;
          default:
            return { ok: false, message: 'unsupported syntax inside []' };
          }
        }
        default:
          return filter;
        }
      default:
        return filter;
      }
    }
  }

  private parsePrimary(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
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
          filter = { kind: 'field', input: filter, key: next.value };
          continue;
        case 'punctuation':
          switch (next.value) {
          case '[': {
            this.index += 1;
            const content = this.peek();
            if (content.kind === 'punctuation' && content.value === ']') {
              this.index += 1;
              filter = { kind: 'iterate', input: filter };
              continue;
            }
            switch (content.kind) {
            case 'number': {
              this.index += 1;
              const closeToken = this.peek();
              if (!(closeToken.kind === 'punctuation' && closeToken.value === ']')) {
                return { ok: false, message: 'unsupported syntax inside []' };
              }
              this.index += 1;
              filter = { kind: 'index', input: filter, index: content.value };
              continue;
            }
            case 'string': {
              this.index += 1;
              const closeToken = this.peek();
              if (!(closeToken.kind === 'punctuation' && closeToken.value === ']')) {
                return { ok: false, message: 'unsupported syntax inside []' };
              }
              this.index += 1;
              filter = { kind: 'field', input: filter, key: content.value };
              continue;
            }
            default:
              return { ok: false, message: 'unsupported syntax inside []' };
            }
          }
          default:
            return { ok: true, filter };
          }
        default:
          return { ok: true, filter };
        }
      }
    }
    case 'number':
      this.index += 1;
      return { ok: true, filter: { kind: 'literal', value: token.value } };
    case 'string':
      this.index += 1;
      return { ok: true, filter: { kind: 'literal', value: token.value } };
    case 'keyword':
      this.index += 1;
      switch (token.value) {
      case 'true':
        return { ok: true, filter: { kind: 'literal', value: true } };
      case 'false':
        return { ok: true, filter: { kind: 'literal', value: false } };
      case 'null':
        return { ok: true, filter: { kind: 'literal', value: null } };
      default:
        return { ok: false, message: `unexpected keyword '${token.value}'` };
      }
    case 'identifier': {
      const builtinName = toBuiltinName({ name: token.value });
      if (builtinName === undefined) {
        return { ok: false, message: `unsupported syntax: identifier '${token.value}'` };
      }
      this.index += 1;
      const next = this.peek();
      if (!(next.kind === 'punctuation' && next.value === '(')) {
        return {
          ok: true,
          filter: { kind: 'call', name: builtinName, args: [] },
        };
      }

      this.index += 1;
      const args: JqFilter[] = [];
      const first = this.peek();
      if (!(first.kind === 'punctuation' && first.value === ')')) {
        const parsedArgs = this.parseExpressionList({ terminator: ')' });
        if (!parsedArgs.ok) return parsedArgs;
        args.push(...parsedArgs.filters);
      }

      const close = this.consumePunctuation({ value: ')' });
      if (!close.ok) return close;
      return {
        ok: true,
        filter: { kind: 'call', name: builtinName, args },
      };
    }
    case 'punctuation':
      switch (token.value) {
      case '(': {
        this.index += 1;
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

  private parseArrayLiteral(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    const open = this.consumePunctuation({ value: '[' });
    if (!open.ok) return open;

    const items: JqFilter[] = [];
    const next = this.peek();
    if (!(next.kind === 'punctuation' && next.value === ']')) {
      const parsedItems = this.parseExpressionList({ terminator: ']' });
      if (!parsedItems.ok) return parsedItems;
      items.push(...parsedItems.filters);
    }

    const close = this.consumePunctuation({ value: ']' });
    if (!close.ok) return close;
    return { ok: true, filter: { kind: 'array', items } };
  }

  private parseObjectLiteral(): { ok: true; filter: JqFilter } | { ok: false; message: string } {
    const open = this.consumePunctuation({ value: '{' });
    if (!open.ok) return open;

    const entries: JqObjectEntry[] = [];
    const next = this.peek();
    if (!(next.kind === 'punctuation' && next.value === '}')) {
      while (true) {
        const keyToken = this.peek();
        let key: string;
        let shorthandKey: string | undefined;
        switch (keyToken.kind) {
        case 'identifier':
        case 'string':
          this.index += 1;
          key = keyToken.value;
          shorthandKey = (() => {
            switch (keyToken.kind) {
            case 'identifier':
              return keyToken.value;
            case 'string':
              return undefined;
            default: {
              const _ex: never = keyToken;
              throw new Error(`Unhandled object key token: ${JSON.stringify(_ex)}`);
            }
            }
          })();
          break;
        default:
          return { ok: false, message: 'expected object key' };
        }

        const separator = this.peek();
        switch (separator.kind) {
        case 'operator':
          switch (separator.value) {
          case ':': {
            this.index += 1;
            const parsedValue = this.parseAssignmentItem();
            if (!parsedValue.ok) return parsedValue;
            entries.push({ key, value: parsedValue.filter });
            break;
          }
          case ',':
            if (shorthandKey === undefined) {
              return { ok: false, message: `expected ':' after object key '${key}'` };
            }
            entries.push({
              key,
              value: { kind: 'field', input: { kind: 'identity' }, key: shorthandKey },
            });
            break;
          default:
            return { ok: false, message: `expected ':' after object key '${key}'` };
          }
          break;
        case 'punctuation':
          switch (separator.value) {
          case '}':
            if (shorthandKey === undefined) {
              return { ok: false, message: `expected ':' after object key '${key}'` };
            }
            entries.push({
              key,
              value: { kind: 'field', input: { kind: 'identity' }, key: shorthandKey },
            });
            break;
          default:
            return { ok: false, message: `expected ':' after object key '${key}'` };
          }
          break;
        default:
          return { ok: false, message: `expected ':' after object key '${key}'` };
        }

        const nextEntry = this.peek();
        if (!(nextEntry.kind === 'operator' && nextEntry.value === ',')) break;
        this.index += 1;
      }
    }

    const close = this.consumePunctuation({ value: '}' });
    if (!close.ok) return close;
    return { ok: true, filter: { kind: 'object', entries } };
  }

  private consumePunctuation({
    value,
  }: {
    value: '[' | ']' | '{' | '}' | '(' | ')';
  }): { ok: true } | { ok: false; message: string } {
    const token = this.peek();
    if (token.kind === 'punctuation' && token.value === value) {
      this.index += 1;
      return { ok: true };
    }
    return { ok: false, message: `expected '${value}'` };
  }

  private consumeIdentifier(): { ok: true; value: string } | { ok: false; message: string } {
    const token = this.peek();
    switch (token.kind) {
    case 'identifier':
      this.index += 1;
      return { ok: true, value: token.value };
    default:
      return { ok: false, message: 'expected identifier' };
    }
  }

  private peek(): JqToken {
    return this.tokens[this.index] ?? { kind: 'eof' };
  }

  private peekOffset({
    offset,
  }: {
    offset: number;
  }): JqToken {
    return this.tokens[this.index + offset] ?? { kind: 'eof' };
  }
}

export function parseJqProgram({
  source,
}: {
  source: string;
}): { ok: true; program: JqProgram } | { ok: false; message: string } {
  const lexed = lexJq({ source });
  if (!lexed.ok) return lexed;
  return new JqParser({ tokens: lexed.tokens }).parse();
}

export function extractPath({
  filter,
}: {
  filter: JqFilter;
}): JqPath | undefined {
  const segments: JqPathSegment[] = [];
  let current: JqFilter = filter;

  while (true) {
    switch (current.kind) {
    case 'field':
      segments.unshift({ kind: 'field', key: current.key });
      current = current.input;
      continue;
    case 'index':
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
