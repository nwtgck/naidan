import type { ToolCall } from '@/01-models/types';
import type { ToolCallId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';

export const DELIMITED_PYTHONIC_TOOL_CALL_OPEN = '<|tool_call_start|>';
export const DELIMITED_PYTHONIC_TOOL_CALL_CLOSE = '<|tool_call_end|>';

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$.-]*/;
const MAX_VALUE_NESTING_DEPTH = 64;

function createRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function longestSuffixMatchingPrefix({ text, pattern }: { text: string, pattern: string }): number {
  const maxLen = Math.min(pattern.length - 1, text.length);
  for (let len = maxLen; len > 0; len--) {
    if (pattern.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

type ParsedFunctionCall = {
  name: string,
  arguments: Record<string, unknown>,
};

class PythonicToolCallPayloadParser {
  private readonly input: string;
  private index = 0;

  constructor({ input }: { input: string }) {
    this.input = input;
  }

  parse(): ParsedFunctionCall[] {
    this.skipWhitespace();
    this.consume({ expected: '[' });
    const calls: ParsedFunctionCall[] = [];
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.consume({ expected: ']' });
      this.finish();
      return calls;
    }

    while (true) {
      calls.push(this.parseFunctionCall());
      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.consume({ expected: ',' });
        this.skipWhitespace();
        continue;
      }
      if (next === ']') {
        this.consume({ expected: ']' });
        this.finish();
        return calls;
      }
      throw new Error('Expected "," or "]" after tool call');
    }
  }

  private parseFunctionCall(): ParsedFunctionCall {
    const name = this.parseIdentifier();
    this.skipWhitespace();
    this.consume({ expected: '(' });
    const args = createRecord();
    this.skipWhitespace();
    if (this.peek() === ')') {
      this.consume({ expected: ')' });
      return { name, arguments: args };
    }

    while (true) {
      const argumentName = this.parseIdentifier();
      if (Object.hasOwn(args, argumentName)) throw new Error(`Duplicate tool argument: ${argumentName}`);
      this.skipWhitespace();
      this.consume({ expected: '=' });
      args[argumentName] = this.parseValue({ depth: 0 });
      this.skipWhitespace();

      const next = this.peek();
      if (next === ',') {
        this.consume({ expected: ',' });
        this.skipWhitespace();
        continue;
      }
      if (next === ')') {
        this.consume({ expected: ')' });
        return { name, arguments: args };
      }
      throw new Error('Expected "," or ")" after tool argument');
    }
  }

  private parseValue({ depth }: { depth: number }): unknown {
    if (depth > MAX_VALUE_NESTING_DEPTH) throw new Error('Tool argument nesting is too deep');
    this.skipWhitespace();
    const next = this.peek();
    if (next === undefined) throw new Error('Unexpected end of tool argument');
    if (next === '\'' || next === '"') return this.parseString({ quote: next });
    if (next === '{') return this.parseObject({ depth: depth + 1 });
    if (next === '[') return this.parseArray({ depth: depth + 1 });
    if (next === '-' || this.isDigit({ char: next })) return this.parseNumber();

    const keyword = this.parseIdentifier();
    switch (keyword) {
    case 'true':
    case 'True':
      return true;
    case 'false':
    case 'False':
      return false;
    case 'null':
    case 'None':
      return null;
    default:
      throw new Error(`Unsupported unquoted tool argument value: ${keyword}`);
    }
  }

  private parseObject({ depth }: { depth: number }): Record<string, unknown> {
    this.consume({ expected: '{' });
    const result = createRecord();
    this.skipWhitespace();
    if (this.peek() === '}') {
      this.consume({ expected: '}' });
      return result;
    }

    while (true) {
      this.skipWhitespace();
      const quote = this.peek();
      if (quote !== '\'' && quote !== '"') throw new Error('Expected quoted object key');
      const key = this.parseString({ quote });
      if (Object.hasOwn(result, key)) throw new Error(`Duplicate object key: ${key}`);
      this.skipWhitespace();
      this.consume({ expected: ':' });
      result[key] = this.parseValue({ depth });
      this.skipWhitespace();

      const next = this.peek();
      if (next === ',') {
        this.consume({ expected: ',' });
        this.skipWhitespace();
        continue;
      }
      if (next === '}') {
        this.consume({ expected: '}' });
        return result;
      }
      throw new Error('Expected "," or "}" in object value');
    }
  }

  private parseArray({ depth }: { depth: number }): unknown[] {
    this.consume({ expected: '[' });
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.consume({ expected: ']' });
      return result;
    }

    while (true) {
      result.push(this.parseValue({ depth }));
      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.consume({ expected: ',' });
        this.skipWhitespace();
        continue;
      }
      if (next === ']') {
        this.consume({ expected: ']' });
        return result;
      }
      throw new Error('Expected "," or "]" in array value');
    }
  }

  private parseString({ quote }: { quote: '\'' | '"' }): string {
    this.consume({ expected: quote });
    let result = '';
    while (!this.isAtEnd()) {
      const char = this.consumeAny();
      if (char === quote) return result;
      if (char !== '\\') {
        result += char;
        continue;
      }
      if (this.isAtEnd()) throw new Error('Unterminated escape sequence');
      result += this.parseEscapeSequence();
    }
    throw new Error('Unterminated string literal');
  }

  private parseEscapeSequence(): string {
    const escaped = this.consumeAny();
    switch (escaped) {
    case '"':
    case '\'':
    case '\\':
    case '/':
      return escaped;
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'u': {
      const hex = this.input.slice(this.index, this.index + 4);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error('Invalid unicode escape');
      this.index += 4;
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    default:
      throw new Error(`Unsupported escape sequence: \\${escaped}`);
    }
  }

  private parseNumber(): number {
    const remaining = this.input.slice(this.index);
    const match = remaining.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error('Invalid number literal');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error('Tool argument number must be finite');
    return value;
  }

  private parseIdentifier(): string {
    this.skipWhitespace();
    const match = this.input.slice(this.index).match(identifierPattern);
    if (!match) throw new Error('Expected identifier');
    this.index += match[0].length;
    return match[0];
  }

  private finish(): void {
    this.skipWhitespace();
    if (!this.isAtEnd()) throw new Error('Unexpected trailing tool-call content');
  }

  private skipWhitespace(): void {
    while (!this.isAtEnd() && /\s/.test(this.input[this.index]!)) this.index += 1;
  }

  private peek(): string | undefined {
    return this.input[this.index];
  }

  private consume({ expected }: { expected: string }): void {
    const actual = this.consumeAny();
    if (actual !== expected) throw new Error(`Expected "${expected}" but received "${actual}"`);
  }

  private consumeAny(): string {
    const char = this.input[this.index];
    if (char === undefined) throw new Error('Unexpected end of input');
    this.index += 1;
    return char;
  }

  private isAtEnd(): boolean {
    return this.index >= this.input.length;
  }

  private isDigit({ char }: { char: string }): boolean {
    return char >= '0' && char <= '9';
  }
}

export function parseDelimitedPythonicToolCallPayload({ content }: {
  content: string,
}): Array<{ name: string, arguments: Record<string, unknown> }> | undefined {
  try {
    return new PythonicToolCallPayloadParser({ input: content.trim() }).parse();
  } catch {
    return undefined;
  }
}

export class DelimitedPythonicToolCallStreamParser {
  private readonly onText: ({ text }: { text: string }) => void;
  private readonly allowedToolNames: ReadonlySet<string>;
  private pending = '';
  private buffer = '';
  private inToolCall = false;
  private parsedToolCalls: ToolCall[] = [];

  constructor({ onText, allowedToolNames }: {
    onText: ({ text }: { text: string }) => void,
    allowedToolNames: ReadonlySet<string>,
  }) {
    this.onText = onText;
    this.allowedToolNames = allowedToolNames;
  }

  feed({ output }: { output: string }): void {
    this.pending += output;
    this.process();
  }

  flush(): void {
    if (!this.inToolCall && this.pending.length > 0) {
      this.onText({ text: this.pending });
    } else if (this.inToolCall) {
      this.onText({ text: `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}${this.buffer}${this.pending}` });
    }
    this.pending = '';
    this.buffer = '';
    this.inToolCall = false;
  }

  drainToolCalls(): ToolCall[] {
    const result = this.parsedToolCalls;
    this.parsedToolCalls = [];
    return result;
  }

  private process(): void {
    while (this.pending.length > 0) {
      if (!this.inToolCall) {
        const startIdx = this.pending.indexOf(DELIMITED_PYTHONIC_TOOL_CALL_OPEN);
        if (startIdx === -1) {
          const holdBack = longestSuffixMatchingPrefix({
            text: this.pending,
            pattern: DELIMITED_PYTHONIC_TOOL_CALL_OPEN,
          });
          const safeLength = this.pending.length - holdBack;
          if (safeLength > 0) this.onText({ text: this.pending.slice(0, safeLength) });
          this.pending = this.pending.slice(safeLength);
          return;
        }

        if (startIdx > 0) this.onText({ text: this.pending.slice(0, startIdx) });
        this.pending = this.pending.slice(startIdx + DELIMITED_PYTHONIC_TOOL_CALL_OPEN.length);
        this.inToolCall = true;
        this.buffer = '';
        continue;
      }

      const endIdx = this.pending.indexOf(DELIMITED_PYTHONIC_TOOL_CALL_CLOSE);
      if (endIdx === -1) {
        const holdBack = longestSuffixMatchingPrefix({
          text: this.pending,
          pattern: DELIMITED_PYTHONIC_TOOL_CALL_CLOSE,
        });
        this.buffer += this.pending.slice(0, this.pending.length - holdBack);
        this.pending = this.pending.slice(this.pending.length - holdBack);
        return;
      }

      this.buffer += this.pending.slice(0, endIdx);
      this.pending = this.pending.slice(endIdx + DELIMITED_PYTHONIC_TOOL_CALL_CLOSE.length);
      this.inToolCall = false;
      this.parseBuffered();
      this.buffer = '';
    }
  }

  private parseBuffered(): void {
    const parsed = parseDelimitedPythonicToolCallPayload({ content: this.buffer });
    if (
      parsed === undefined
      || parsed.length === 0
      || parsed.some(call => !this.allowedToolNames.has(call.name))
    ) {
      this.onText({
        text: `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}${this.buffer}${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`,
      });
      return;
    }

    this.parsedToolCalls.push(...parsed.map(call => ({
      id: generateId<ToolCallId>(),
      type: 'function' as const,
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      },
    })));
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
