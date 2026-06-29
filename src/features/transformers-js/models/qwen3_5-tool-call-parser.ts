import type { ToolCall } from '@/01-models/types';
import { z } from 'zod';
import type { ToolCallId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';

const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';
const relaxedIdentifierPattern = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;
const toolCallPayloadSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

function buildToolCall({ name, parameters }: {
  name: string,
  parameters: Record<string, unknown>,
}): ToolCall {
  return {
    id: generateId<ToolCallId>(),
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(parameters),
    },
  };
}

function tryParseQwen3_5ToolCall({ content }: {
  content: string,
}): ToolCall | null {
  const trimmed = content.trim();
  const jsonToolCall = tryParseJsonLikeToolCall({ content: trimmed });
  if (jsonToolCall) return jsonToolCall;

  const functionMatch = trimmed.match(/^<function=([^\n>]+)>\s*([\s\S]*?)\s*<\/function>$/);
  if (!functionMatch) return null;

  const [, name, body] = functionMatch;
  if (!name || body === undefined) return null;
  const parameters: Record<string, unknown> = {};
  const parameterPattern = /<parameter=([^\n>]+)>\s*([\s\S]*?)\s*<\/parameter>/g;

  let match: RegExpExecArray | null;
  while ((match = parameterPattern.exec(body)) !== null) {
    const [, parameterName, rawValue] = match;
    if (!parameterName || rawValue === undefined) continue;
    const value = rawValue.trim();

    if (value === '') {
      parameters[parameterName] = '';
      continue;
    }

    if (value === 'true') {
      parameters[parameterName] = true;
      continue;
    }
    if (value === 'false') {
      parameters[parameterName] = false;
      continue;
    }
    if (value === 'null') {
      parameters[parameterName] = null;
      continue;
    }

    const numericValue = Number(value);
    if (!Number.isNaN(numericValue) && `${numericValue}` === value) {
      parameters[parameterName] = numericValue;
      continue;
    }

    parameters[parameterName] = value;
  }

  return buildToolCall({ name, parameters });
}

function tryParseJsonLikeToolCall({ content }: { content: string }): ToolCall | null {
  const strict = tryParseStrictJson({ content });
  const relaxed = strict ?? tryParseRelaxedJson({ content });
  const validated = toolCallPayloadSchema.safeParse(relaxed);
  if (!validated.success) return null;

  return buildToolCall({
    name: validated.data.name,
    parameters: validated.data.arguments,
  });
}

function tryParseStrictJson({ content }: { content: string }): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function tryParseRelaxedJson({ content }: { content: string }): unknown {
  try {
    const parser = new RelaxedJsonValueParser({ input: content });
    return parser.parse();
  } catch {
    return null;
  }
}

// Qwen sometimes emits tool-call payloads that are close to JSON but leave
// identifiers like function names unquoted. Parse that safely without eval.
class RelaxedJsonValueParser {
  private readonly input: string;
  private index = 0;

  constructor({ input }: { input: string }) {
    this.input = input;
  }

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (!this.isAtEnd()) {
      throw new Error('Unexpected trailing content');
    }
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const next = this.peek();
    if (next === undefined) {
      throw new Error('Unexpected end of input');
    }

    if (next === '{') return this.parseObject();
    if (next === '[') return this.parseArray();
    if (next === '"') return this.parseString({ quote: '"' });
    if (next === '\'') return this.parseString({ quote: '\'' });
    if (next === '-' || this.isDigit({ char: next })) return this.parseNumber();
    return this.parseKeywordOrIdentifier();
  }

  private parseObject(): Record<string, unknown> {
    this.consume({ expected: '{' });
    const result: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.peek() === '}') {
      this.consume({ expected: '}' });
      return result;
    }

    while (true) {
      const key = this.parseObjectKey();
      this.skipWhitespace();
      this.consume({ expected: ':' });
      result[key] = this.parseValue();
      this.skipWhitespace();

      const next = this.peek();
      if (next === ',') {
        this.consume({ expected: ',' });
        this.skipWhitespace();
        if (this.peek() === '}') {
          this.consume({ expected: '}' });
          return result;
        }
        continue;
      }
      if (next === '}') {
        this.consume({ expected: '}' });
        return result;
      }
      throw new Error('Expected "," or "}"');
    }
  }

  private parseArray(): unknown[] {
    this.consume({ expected: '[' });
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.consume({ expected: ']' });
      return result;
    }

    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();

      const next = this.peek();
      if (next === ',') {
        this.consume({ expected: ',' });
        this.skipWhitespace();
        if (this.peek() === ']') {
          this.consume({ expected: ']' });
          return result;
        }
        continue;
      }
      if (next === ']') {
        this.consume({ expected: ']' });
        return result;
      }
      throw new Error('Expected "," or "]"');
    }
  }

  private parseObjectKey(): string {
    this.skipWhitespace();
    const next = this.peek();
    if (next === '"') return this.parseString({ quote: '"' });
    if (next === '\'') return this.parseString({ quote: '\'' });

    const identifier = this.parseIdentifier();
    if (!relaxedIdentifierPattern.test(identifier)) {
      throw new Error('Invalid object key');
    }
    return identifier;
  }

  private parseString({ quote }: { quote: '"' | '\'' }): string {
    this.consume({ expected: quote });
    let result = '';

    while (!this.isAtEnd()) {
      const char = this.consumeAny();
      if (char === quote) return result;
      if (char !== '\\') {
        result += char;
        continue;
      }

      if (this.isAtEnd()) {
        throw new Error('Unterminated escape sequence');
      }
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
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
        throw new Error('Invalid unicode escape');
      }
      this.index += 4;
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    default:
      return escaped;
    }
  }

  private parseNumber(): number {
    const remaining = this.input.slice(this.index);
    const match = remaining.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) {
      throw new Error('Invalid number literal');
    }
    this.index += match[0].length;
    return Number(match[0]);
  }

  private parseKeywordOrIdentifier(): boolean | null | string {
    const token = this.parseIdentifier();
    switch (token) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'null':
      return null;
    default:
      return token;
    }
  }

  private parseIdentifier(): string {
    const remaining = this.input.slice(this.index);
    const match = remaining.match(/^[A-Za-z_$][A-Za-z0-9_$.-]*/);
    if (!match) {
      throw new Error('Expected identifier');
    }
    this.index += match[0].length;
    return match[0];
  }

  private skipWhitespace(): void {
    while (!this.isAtEnd() && /\s/.test(this.input[this.index]!)) {
      this.index += 1;
    }
  }

  private peek(): string | undefined {
    return this.input[this.index];
  }

  private consume({ expected }: { expected: string }): void {
    const actual = this.consumeAny();
    if (actual !== expected) {
      throw new Error(`Expected "${expected}" but received "${actual}"`);
    }
  }

  private consumeAny(): string {
    const char = this.input[this.index];
    if (char === undefined) {
      throw new Error('Unexpected end of input');
    }
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

export class Qwen3_5ToolCallParser {
  private readonly onText: ({ text }: { text: string }) => void;
  private pending = '';
  private parsedToolCalls: ToolCall[] = [];

  constructor({ onText }: { onText: ({ text }: { text: string }) => void }) {
    this.onText = onText;
  }

  feed({ output }: { output: string }): void {
    this.pending += output;
    this.process();
  }

  flush(): void {
    if (this.pending.length > 0) {
      this.onText({ text: this.pending });
    }
    this.pending = '';
  }

  drainToolCalls(): ToolCall[] {
    const result = this.parsedToolCalls;
    this.parsedToolCalls = [];
    return result;
  }

  private process(): void {
    while (true) {
      const startIdx = this.pending.indexOf(TOOL_CALL_OPEN);
      if (startIdx === -1) {
        if (this.pending.length > 0) {
          this.onText({ text: this.pending });
          this.pending = '';
        }
        return;
      }

      if (startIdx > 0) {
        this.onText({ text: this.pending.slice(0, startIdx) });
        this.pending = this.pending.slice(startIdx);
      }

      const endIdx = this.pending.indexOf(TOOL_CALL_CLOSE, TOOL_CALL_OPEN.length);
      if (endIdx === -1) return;

      const inner = this.pending.slice(TOOL_CALL_OPEN.length, endIdx);
      this.pending = this.pending.slice(endIdx + TOOL_CALL_CLOSE.length);

      const parsed = tryParseQwen3_5ToolCall({ content: inner });
      if (parsed) {
        this.parsedToolCalls.push(parsed);
      } else {
        this.onText({ text: `${TOOL_CALL_OPEN}${inner}${TOOL_CALL_CLOSE}` });
      }
    }
  }
}
