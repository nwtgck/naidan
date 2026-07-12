export type JsonSyntaxTokenType =
  | 'property'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'punctuation'
  | 'whitespace'
  | 'invalid';

export interface JsonSyntaxToken {
  readonly type: JsonSyntaxTokenType,
  readonly text: string,
}

export interface FormattedJsonSource {
  readonly text: string,
  readonly status: 'valid' | 'invalid',
}

interface JsonObjectContainerContext {
  readonly type: 'object',
  expectingProperty: boolean,
}

interface JsonArrayContainerContext {
  readonly type: 'array',
}

type JsonContainerContext = JsonObjectContainerContext | JsonArrayContainerContext;

export function formatJsonSource({ source }: { source: string }): FormattedJsonSource {
  try {
    JSON.parse(source);
  } catch {
    return {
      text: source,
      status: 'invalid',
    };
  }

  const tokens = tokenizeJson({ source }).filter(token => token.type !== 'whitespace');
  let indentation = 0;
  let formatted = '';

  const appendIndentation = (): void => {
    formatted += '  '.repeat(indentation);
  };

  for (const [index, token] of tokens.entries()) {
    switch (token.type) {
    case 'property':
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'whitespace':
    case 'invalid':
      formatted += token.text;
      continue;
    case 'punctuation':
      break;
    default: {
      const _ex: never = token.type;
      throw new Error(`Unhandled JSON token type: ${String(_ex)}`);
    }
    }
    const next = tokens[index + 1];
    switch (token.text) {
    case '{':
    case '[':
      formatted += token.text;
      if (
        next?.type === 'punctuation'
        && (
          (token.text === '{' && next.text === '}')
          || (token.text === '[' && next.text === ']')
        )
      ) {
        break;
      }
      indentation += 1;
      formatted += '\n';
      appendIndentation();
      break;
    case '}':
    case ']': {
      const previous = tokens[index - 1];
      if (
        previous?.type === 'punctuation'
        && (
          (previous.text === '{' && token.text === '}')
          || (previous.text === '[' && token.text === ']')
        )
      ) {
        formatted += token.text;
        break;
      }
      indentation = Math.max(0, indentation - 1);
      formatted += '\n';
      appendIndentation();
      formatted += token.text;
      break;
    }
    case ':':
      formatted += ': ';
      break;
    case ',':
      formatted += ',\n';
      appendIndentation();
      break;
    default:
      formatted += token.text;
      break;
    }
  }

  return {
    text: formatted,
    status: 'valid',
  };
}

function setObjectPropertyExpectation({
  context,
  expectingProperty,
}: {
  context: JsonContainerContext | undefined,
  expectingProperty: boolean,
}): void {
  if (context === undefined) {
    return;
  }
  switch (context.type) {
  case 'array':
    return;
  case 'object':
    context.expectingProperty = expectingProperty;
    return;
  default: {
    const _ex: never = context;
    throw new Error(`Unhandled JSON container context: ${String(_ex)}`);
  }
  }
}

export function tokenizeJson({ source }: { source: string }): readonly JsonSyntaxToken[] {
  const tokens: JsonSyntaxToken[] = [];
  const contexts: JsonContainerContext[] = [];
  let offset = 0;

  while (offset < source.length) {
    const current = source[offset];
    if (current === undefined) {
      break;
    }

    if (/\s/u.test(current)) {
      const start = offset;
      offset += 1;
      while (offset < source.length && /\s/u.test(source[offset] ?? '')) {
        offset += 1;
      }
      tokens.push({ type: 'whitespace', text: source.slice(start, offset) });
      continue;
    }

    if (current === '"') {
      const start = offset;
      offset += 1;
      let escaped = false;
      let terminated = false;
      while (offset < source.length) {
        const character = source[offset];
        offset += 1;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === '\\') {
          escaped = true;
          continue;
        }
        if (character === '"') {
          terminated = true;
          break;
        }
      }
      const context = contexts.at(-1);
      tokens.push({
        type: terminated
          ? context?.type === 'object' && context.expectingProperty
            ? 'property'
            : 'string'
          : 'invalid',
        text: source.slice(start, offset),
      });
      continue;
    }

    const numberMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(source.slice(offset));
    if (numberMatch?.[0] !== undefined) {
      tokens.push({ type: 'number', text: numberMatch[0] });
      offset += numberMatch[0].length;
      continue;
    }

    const keyword = source.startsWith('true', offset)
      ? { type: 'boolean' as const, text: 'true' }
      : source.startsWith('false', offset)
        ? { type: 'boolean' as const, text: 'false' }
        : source.startsWith('null', offset)
          ? { type: 'null' as const, text: 'null' }
          : undefined;
    if (keyword !== undefined) {
      tokens.push(keyword);
      offset += keyword.text.length;
      continue;
    }

    switch (current) {
    case '{':
      contexts.push({ type: 'object', expectingProperty: true });
      tokens.push({ type: 'punctuation', text: current });
      offset += 1;
      break;
    case '[':
      contexts.push({ type: 'array' });
      tokens.push({ type: 'punctuation', text: current });
      offset += 1;
      break;
    case '}':
    case ']':
      contexts.pop();
      tokens.push({ type: 'punctuation', text: current });
      offset += 1;
      break;
    case ':': {
      setObjectPropertyExpectation({
        context: contexts.at(-1),
        expectingProperty: false,
      });
      tokens.push({ type: 'punctuation', text: current });
      offset += 1;
      break;
    }
    case ',': {
      setObjectPropertyExpectation({
        context: contexts.at(-1),
        expectingProperty: true,
      });
      tokens.push({ type: 'punctuation', text: current });
      offset += 1;
      break;
    }
    default:
      tokens.push({ type: 'invalid', text: current });
      offset += 1;
      break;
    }
  }

  return tokens;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
