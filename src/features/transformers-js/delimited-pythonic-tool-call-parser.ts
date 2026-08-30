import type { ToolCall } from '@/01-models/types';
import type { ToolCallId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';

export const DELIMITED_PYTHONIC_TOOL_CALL_OPEN = '<|tool_call_start|>';
export const DELIMITED_PYTHONIC_TOOL_CALL_CLOSE = '<|tool_call_end|>';

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;
const identifierStartPattern = /^[A-Za-z_$]$/;
const identifierPartPattern = /^[A-Za-z0-9_$.-]$/;
const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const numberPartPattern = /^[0-9eE+.-]$/;
const MAX_VALUE_NESTING_DEPTH = 64;

type PythonicPunctuation =
  | '['
  | ']'
  | '('
  | ')'
  | '{'
  | '}'
  | ','
  | '='
  | ':';

type PythonicToken =
  | { readonly type: 'punctuation', readonly value: PythonicPunctuation }
  | { readonly type: 'identifier', readonly value: string }
  | { readonly type: 'string', readonly value: string }
  | { readonly type: 'number', readonly value: number };

export type PythonicValueAst =
  | { readonly type: 'string', readonly value: string }
  | { readonly type: 'number', readonly value: number }
  | { readonly type: 'boolean', readonly value: boolean }
  | { readonly type: 'null' }
  | { readonly type: 'array', readonly items: readonly PythonicValueAst[] }
  | {
    readonly type: 'object',
    readonly entries: readonly {
      readonly key: string,
      readonly value: PythonicValueAst,
    }[],
  };

export type PythonicFunctionCallAst = {
  readonly type: 'function-call',
  readonly name: string,
  readonly arguments: readonly {
    readonly name: string,
    readonly value: PythonicValueAst,
  }[],
};

export type PythonicToolCallListAst = {
  readonly type: 'tool-call-list',
  readonly calls: readonly PythonicFunctionCallAst[],
};

export type DelimitedPythonicToolCallStreamEvent =
  | {
    readonly type: 'call-parsed',
    readonly blockId: number,
    readonly callIndex: number,
    readonly call: PythonicFunctionCallAst,
  }
  | {
    readonly type: 'block-committed',
    readonly blockId: number,
    readonly callCount: number,
  }
  | {
    readonly type: 'block-rejected',
    readonly blockId: number,
    readonly reason:
      | 'empty-tool-call-list'
      | 'incomplete'
      | 'invalid-syntax'
      | 'missing-close-delimiter'
      | 'tool-not-offered',
  };

type SyntaxAnalysis =
  | {
    readonly status: 'incomplete',
    readonly completedCalls: readonly PythonicFunctionCallAst[],
  }
  | {
    readonly status: 'invalid',
    readonly completedCalls: readonly PythonicFunctionCallAst[],
    readonly reason: string,
  }
  | {
    readonly status: 'complete',
    readonly ast: PythonicToolCallListAst,
  };

type IncrementalPayloadFeedResult =
  | {
    readonly status: 'incomplete',
    readonly consumed: number,
  }
  | {
    readonly status: 'invalid',
    readonly consumed: number,
    readonly reason: string,
  }
  | {
    readonly status: 'complete',
    readonly consumed: number,
    readonly ast: PythonicToolCallListAst,
  };

class IncompletePythonicSyntaxError extends Error {
}

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

class PythonicToolCallLexer {
  private mode:
    | 'base'
    | 'identifier'
    | 'number'
    | 'string'
    | 'string-escape'
    | 'string-unicode' = 'base';
  private tokenBuffer = '';
  private stringQuote: '\'' | '"' | undefined;
  private stringValue = '';
  private unicodeEscape = '';

  feedCharacter({ character }: { character: string }): { tokens: PythonicToken[], error: string | undefined } {
    const tokens: PythonicToken[] = [];
    let current: string | undefined = character;

    while (current !== undefined) {
      switch (this.mode) {
      case 'base': {
        if (/\s/.test(current)) {
          current = undefined;
          break;
        }
        if (isPythonicPunctuation(current)) {
          tokens.push({ type: 'punctuation', value: current });
          current = undefined;
          break;
        }
        if (identifierStartPattern.test(current)) {
          this.mode = 'identifier';
          this.tokenBuffer = current;
          current = undefined;
          break;
        }
        if (current === '-' || isDigit({ character: current })) {
          this.mode = 'number';
          this.tokenBuffer = current;
          current = undefined;
          break;
        }
        if (current === '\'' || current === '"') {
          this.mode = 'string';
          this.stringQuote = current;
          this.stringValue = '';
          current = undefined;
          break;
        }
        return { tokens, error: `Unexpected character in tool-call payload: ${JSON.stringify(current)}` };
      }
      case 'identifier': {
        if (identifierPartPattern.test(current)) {
          this.tokenBuffer += current;
          current = undefined;
          break;
        }
        const identifier = this.tokenBuffer;
        this.tokenBuffer = '';
        this.mode = 'base';
        if (!identifierPattern.test(identifier)) {
          return { tokens, error: `Invalid identifier: ${identifier}` };
        }
        tokens.push({ type: 'identifier', value: identifier });
        break;
      }
      case 'number': {
        if (numberPartPattern.test(current)) {
          this.tokenBuffer += current;
          current = undefined;
          break;
        }
        const rawNumber = this.tokenBuffer;
        this.tokenBuffer = '';
        this.mode = 'base';
        if (!numberPattern.test(rawNumber)) {
          return { tokens, error: `Invalid number literal: ${rawNumber}` };
        }
        const value = Number(rawNumber);
        if (!Number.isFinite(value)) {
          return { tokens, error: 'Tool argument number must be finite' };
        }
        tokens.push({ type: 'number', value });
        break;
      }
      case 'string': {
        if (current === this.stringQuote) {
          tokens.push({ type: 'string', value: this.stringValue });
          this.stringQuote = undefined;
          this.stringValue = '';
          this.mode = 'base';
          current = undefined;
          break;
        }
        if (current === '\\') {
          this.mode = 'string-escape';
          current = undefined;
          break;
        }
        if (current === '\n' || current === '\r') {
          return { tokens, error: 'Unescaped newline in tool-call string literal' };
        }
        this.stringValue += current;
        current = undefined;
        break;
      }
      case 'string-escape': {
        switch (current) {
        case '"':
        case '\'':
        case '\\':
        case '/':
          this.stringValue += current;
          this.mode = 'string';
          current = undefined;
          break;
        case 'b':
          this.stringValue += '\b';
          this.mode = 'string';
          current = undefined;
          break;
        case 'f':
          this.stringValue += '\f';
          this.mode = 'string';
          current = undefined;
          break;
        case 'n':
          this.stringValue += '\n';
          this.mode = 'string';
          current = undefined;
          break;
        case 'r':
          this.stringValue += '\r';
          this.mode = 'string';
          current = undefined;
          break;
        case 't':
          this.stringValue += '\t';
          this.mode = 'string';
          current = undefined;
          break;
        case 'u':
          this.unicodeEscape = '';
          this.mode = 'string-unicode';
          current = undefined;
          break;
        default:
          return { tokens, error: `Unsupported escape sequence: \\${current}` };
        }
        break;
      }
      case 'string-unicode': {
        if (!/^[0-9A-Fa-f]$/.test(current)) {
          return { tokens, error: `Invalid unicode escape character: ${JSON.stringify(current)}` };
        }
        this.unicodeEscape += current;
        current = undefined;
        if (this.unicodeEscape.length === 4) {
          this.stringValue += String.fromCharCode(Number.parseInt(this.unicodeEscape, 16));
          this.unicodeEscape = '';
          this.mode = 'string';
        }
        break;
      }
      default: {
        const _ex: never = this.mode;
        return { tokens, error: `Unhandled lexer mode: ${String(_ex)}` };
      }
      }
    }

    return { tokens, error: undefined };
  }
}

class PythonicTokenCursor {
  private readonly tokens: readonly PythonicToken[];
  private index = 0;

  constructor({ tokens }: { tokens: readonly PythonicToken[] }) {
    this.tokens = tokens;
  }

  parseFunctionCall(): PythonicFunctionCallAst {
    const name = this.consumeIdentifier();
    this.consumePunctuation({ expected: '(' });
    const args: Array<{ readonly name: string, readonly value: PythonicValueAst }> = [];
    const argumentNames = new Set<string>();

    if (this.peekPunctuation({ expected: ')' })) {
      this.consumePunctuation({ expected: ')' });
      return { type: 'function-call', name, arguments: args };
    }

    while (true) {
      const argumentName = this.consumeIdentifier();
      if (argumentNames.has(argumentName)) throw new Error(`Duplicate tool argument: ${argumentName}`);
      argumentNames.add(argumentName);
      this.consumePunctuation({ expected: '=' });
      args.push({ name: argumentName, value: this.parseValue({ depth: 0 }) });

      if (this.peekPunctuation({ expected: ',' })) {
        this.consumePunctuation({ expected: ',' });
        continue;
      }
      if (this.peekPunctuation({ expected: ')' })) {
        this.consumePunctuation({ expected: ')' });
        return { type: 'function-call', name, arguments: args };
      }
      if (this.peek() === undefined) throw new IncompletePythonicSyntaxError();
      throw new Error('Expected "," or ")" after tool argument');
    }
  }

  parseValue({ depth }: { depth: number }): PythonicValueAst {
    if (depth > MAX_VALUE_NESTING_DEPTH) throw new Error('Tool argument nesting is too deep');
    const token = this.peek();
    if (token === undefined) throw new IncompletePythonicSyntaxError();

    switch (token.type) {
    case 'string':
      this.consumeAny();
      return { type: 'string', value: token.value };
    case 'number':
      this.consumeAny();
      return { type: 'number', value: token.value };
    case 'identifier': {
      this.consumeAny();
      switch (token.value) {
      case 'true':
      case 'True':
        return { type: 'boolean', value: true };
      case 'false':
      case 'False':
        return { type: 'boolean', value: false };
      case 'null':
      case 'None':
        return { type: 'null' };
      default:
        throw new Error(`Unsupported unquoted tool argument value: ${token.value}`);
      }
    }
    case 'punctuation':
      switch (token.value) {
      case '{':
        return this.parseObject({ depth: depth + 1 });
      case '[':
        return this.parseArray({ depth: depth + 1 });
      default:
        throw new Error(`Unexpected punctuation in tool argument: ${token.value}`);
      }
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled token: ${String(_ex)}`);
    }
    }
  }

  peek(): PythonicToken | undefined {
    return this.tokens[this.index];
  }

  peekPunctuation({ expected }: { expected: PythonicPunctuation }): boolean {
    const token = this.peek();
    return token?.type === 'punctuation' && token.value === expected;
  }

  consumePunctuation({ expected }: { expected: PythonicPunctuation }): void {
    const token = this.consumeAny();
    if (token.type !== 'punctuation' || token.value !== expected) {
      throw new Error(`Expected "${expected}"`);
    }
  }

  consumeIdentifier(): string {
    const token = this.consumeAny();
    switch (token.type) {
    case 'identifier':
      return token.value;
    case 'punctuation':
    case 'string':
    case 'number':
      throw new Error('Expected identifier');
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled token type: ${String(_ex)}`);
    }
    }
  }

  hasRemaining(): boolean {
    return this.index < this.tokens.length;
  }

  private parseObject({ depth }: { depth: number }): PythonicValueAst {
    this.consumePunctuation({ expected: '{' });
    const entries: Array<{ readonly key: string, readonly value: PythonicValueAst }> = [];
    const keys = new Set<string>();

    if (this.peekPunctuation({ expected: '}' })) {
      this.consumePunctuation({ expected: '}' });
      return { type: 'object', entries };
    }

    while (true) {
      const keyToken = this.consumeAny();
      const key = (() => {
        switch (keyToken.type) {
        case 'string':
          return keyToken.value;
        case 'punctuation':
        case 'identifier':
        case 'number':
          throw new Error('Expected quoted object key');
        default: {
          const _ex: never = keyToken;
          throw new Error(`Unhandled object-key token: ${String(_ex)}`);
        }
        }
      })();
      if (keys.has(key)) throw new Error(`Duplicate object key: ${key}`);
      keys.add(key);
      this.consumePunctuation({ expected: ':' });
      entries.push({ key, value: this.parseValue({ depth }) });

      if (this.peekPunctuation({ expected: ',' })) {
        this.consumePunctuation({ expected: ',' });
        continue;
      }
      if (this.peekPunctuation({ expected: '}' })) {
        this.consumePunctuation({ expected: '}' });
        return { type: 'object', entries };
      }
      if (this.peek() === undefined) throw new IncompletePythonicSyntaxError();
      throw new Error('Expected "," or "}" in object value');
    }
  }

  private parseArray({ depth }: { depth: number }): PythonicValueAst {
    this.consumePunctuation({ expected: '[' });
    const items: PythonicValueAst[] = [];

    if (this.peekPunctuation({ expected: ']' })) {
      this.consumePunctuation({ expected: ']' });
      return { type: 'array', items };
    }

    while (true) {
      items.push(this.parseValue({ depth }));
      if (this.peekPunctuation({ expected: ',' })) {
        this.consumePunctuation({ expected: ',' });
        continue;
      }
      if (this.peekPunctuation({ expected: ']' })) {
        this.consumePunctuation({ expected: ']' });
        return { type: 'array', items };
      }
      if (this.peek() === undefined) throw new IncompletePythonicSyntaxError();
      throw new Error('Expected "," or "]" in array value');
    }
  }

  private consumeAny(): PythonicToken {
    const token = this.tokens[this.index];
    if (token === undefined) throw new IncompletePythonicSyntaxError();
    this.index += 1;
    return token;
  }
}

function analyzePythonicTokens({ tokens }: { tokens: readonly PythonicToken[] }): SyntaxAnalysis {
  const cursor = new PythonicTokenCursor({ tokens });
  const calls: PythonicFunctionCallAst[] = [];

  try {
    cursor.consumePunctuation({ expected: '[' });
    if (cursor.peekPunctuation({ expected: ']' })) {
      cursor.consumePunctuation({ expected: ']' });
      if (cursor.hasRemaining()) {
        return { status: 'invalid', completedCalls: calls, reason: 'Unexpected trailing tool-call content' };
      }
      return { status: 'complete', ast: { type: 'tool-call-list', calls } };
    }

    while (true) {
      try {
        calls.push(cursor.parseFunctionCall());
      } catch (error) {
        if (error instanceof IncompletePythonicSyntaxError) {
          return { status: 'incomplete', completedCalls: calls };
        }
        throw error;
      }

      if (cursor.peekPunctuation({ expected: ',' })) {
        cursor.consumePunctuation({ expected: ',' });
        if (cursor.peek() === undefined) return { status: 'incomplete', completedCalls: calls };
        continue;
      }
      if (cursor.peekPunctuation({ expected: ']' })) {
        cursor.consumePunctuation({ expected: ']' });
        if (cursor.hasRemaining()) {
          return { status: 'invalid', completedCalls: calls, reason: 'Unexpected trailing tool-call content' };
        }
        return { status: 'complete', ast: { type: 'tool-call-list', calls } };
      }
      if (cursor.peek() === undefined) return { status: 'incomplete', completedCalls: calls };
      return { status: 'invalid', completedCalls: calls, reason: 'Expected "," or "]" after tool call' };
    }
  } catch (error) {
    if (error instanceof IncompletePythonicSyntaxError) {
      return { status: 'incomplete', completedCalls: calls };
    }
    return {
      status: 'invalid',
      completedCalls: calls,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

class IncrementalPythonicToolCallPayloadParser {
  private readonly lexer = new PythonicToolCallLexer();
  private readonly tokens: PythonicToken[] = [];
  private readonly onCallParsed: ({ call, callIndex }: {
    call: PythonicFunctionCallAst,
    callIndex: number,
  }) => void;
  private emittedCallCount = 0;
  private terminalStatus: Exclude<IncrementalPayloadFeedResult, { status: 'incomplete' }> | undefined;

  constructor({ onCallParsed }: {
    onCallParsed: ({ call, callIndex }: { call: PythonicFunctionCallAst, callIndex: number }) => void,
  }) {
    this.onCallParsed = onCallParsed;
  }

  feed({ input }: { input: string }): IncrementalPayloadFeedResult {
    if (this.terminalStatus) return { ...this.terminalStatus, consumed: 0 };

    for (let index = 0; index < input.length; index++) {
      const lexical = this.lexer.feedCharacter({ character: input[index]! });
      if (lexical.error !== undefined) {
        const result: IncrementalPayloadFeedResult = {
          status: 'invalid',
          consumed: index + 1,
          reason: lexical.error,
        };
        this.terminalStatus = result;
        return result;
      }

      for (const token of lexical.tokens) {
        this.tokens.push(token);
        const analysis = analyzePythonicTokens({ tokens: this.tokens });
        this.emitNewlyCompletedCalls({ analysis });
        switch (analysis.status) {
        case 'incomplete':
          break;
        case 'invalid': {
          const result: IncrementalPayloadFeedResult = {
            status: 'invalid',
            consumed: index + 1,
            reason: analysis.reason,
          };
          this.terminalStatus = result;
          return result;
        }
        case 'complete': {
          const result: IncrementalPayloadFeedResult = {
            status: 'complete',
            consumed: index + 1,
            ast: analysis.ast,
          };
          this.terminalStatus = result;
          return result;
        }
        default: {
          const _ex: never = analysis;
          throw new Error(`Unhandled syntax analysis: ${String(_ex)}`);
        }
        }
      }
    }

    return { status: 'incomplete', consumed: input.length };
  }

  private emitNewlyCompletedCalls({ analysis }: { analysis: SyntaxAnalysis }): void {
    const completedCalls = (() => {
      switch (analysis.status) {
      case 'incomplete':
      case 'invalid':
        return analysis.completedCalls;
      case 'complete':
        return analysis.ast.calls;
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled syntax analysis: ${String(_ex)}`);
      }
      }
    })();
    while (this.emittedCallCount < completedCalls.length) {
      const callIndex = this.emittedCallCount;
      const call = completedCalls[callIndex]!;
      this.emittedCallCount += 1;
      this.onCallParsed({ call, callIndex });
    }
  }
}

function pythonicValueAstToValue({ ast }: { ast: PythonicValueAst }): unknown {
  switch (ast.type) {
  case 'string':
  case 'number':
  case 'boolean':
    return ast.value;
  case 'null':
    return null;
  case 'array':
    return ast.items.map(item => pythonicValueAstToValue({ ast: item }));
  case 'object': {
    const result = createRecord();
    for (const entry of ast.entries) {
      result[entry.key] = pythonicValueAstToValue({ ast: entry.value });
    }
    return result;
  }
  default: {
    const _ex: never = ast;
    throw new Error(`Unhandled Pythonic value AST: ${String(_ex)}`);
  }
  }
}

function pythonicFunctionCallAstToParsedCall({ ast }: {
  ast: PythonicFunctionCallAst,
}): { name: string, arguments: Record<string, unknown> } {
  const args = createRecord();
  for (const argument of ast.arguments) {
    args[argument.name] = pythonicValueAstToValue({ ast: argument.value });
  }
  return { name: ast.name, arguments: args };
}

function parseDelimitedPythonicToolCallPayloadAst({ content }: {
  content: string,
}): PythonicToolCallListAst | undefined {
  const parser = new IncrementalPythonicToolCallPayloadParser({ onCallParsed: () => {} });
  const result = parser.feed({ input: content });
  switch (result.status) {
  case 'incomplete':
  case 'invalid':
    return undefined;
  case 'complete':
    if (content.slice(result.consumed).trim().length > 0) return undefined;
    return result.ast;
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled payload result: ${String(_ex)}`);
  }
  }
}

export function parseDelimitedPythonicToolCallPayload({ content }: {
  content: string,
}): Array<{ name: string, arguments: Record<string, unknown> }> | undefined {
  const ast = parseDelimitedPythonicToolCallPayloadAst({ content });
  if (!ast) return undefined;
  return ast.calls.map(call => pythonicFunctionCallAstToParsedCall({ ast: call }));
}

export class DelimitedPythonicToolCallStreamParser {
  private readonly onText: ({ text }: { text: string }) => void;
  private readonly onEvent: ({ event }: { event: DelimitedPythonicToolCallStreamEvent }) => void;
  private readonly allowedToolNames: ReadonlySet<string>;
  private pending = '';
  private mode: 'text' | 'payload' | 'await-close' | 'rejecting' = 'text';
  private frameRaw = '';
  private payloadParser: IncrementalPythonicToolCallPayloadParser | undefined;
  private parsedBlockAst: PythonicToolCallListAst | undefined;
  private parsedToolCalls: ToolCall[] = [];
  private nextBlockId = 0;
  private activeBlockId: number | undefined;
  private closeMatchIndex = 0;
  private rejectionReason: Extract<DelimitedPythonicToolCallStreamEvent, { type: 'block-rejected' }>['reason'] | undefined;

  constructor({ onText, onEvent, allowedToolNames }: {
    onText: ({ text }: { text: string }) => void,
    onEvent?: ({ event }: { event: DelimitedPythonicToolCallStreamEvent }) => void,
    allowedToolNames: ReadonlySet<string>,
  }) {
    this.onText = onText;
    this.onEvent = onEvent ?? (() => {});
    this.allowedToolNames = allowedToolNames;
  }

  feed({ output }: { output: string }): void {
    this.pending += output;
    this.process();
  }

  flush(): void {
    this.process();
    switch (this.mode) {
    case 'text':
      if (this.pending.length > 0) this.onText({ text: this.pending });
      this.pending = '';
      return;
    case 'payload':
    case 'await-close':
      this.frameRaw += this.pending;
      this.pending = '';
      this.rejectActiveBlock({ reason: 'incomplete' });
      return;
    case 'rejecting':
      this.frameRaw += this.pending;
      this.pending = '';
      this.onText({ text: this.frameRaw });
      this.rejectActiveBlock({ reason: this.rejectionReason ?? 'invalid-syntax' });
      return;
    default: {
      const _ex: never = this.mode;
      throw new Error(`Unhandled stream parser mode: ${String(_ex)}`);
    }
    }
  }

  drainToolCalls(): ToolCall[] {
    const result = this.parsedToolCalls;
    this.parsedToolCalls = [];
    return result;
  }

  private process(): void {
    while (this.pending.length > 0) {
      switch (this.mode) {
      case 'text':
        if (!this.processText()) return;
        break;
      case 'payload':
        this.processPayload();
        break;
      case 'await-close':
        this.processAwaitClose();
        break;
      case 'rejecting':
        this.processRejecting();
        break;
      default: {
        const _ex: never = this.mode;
        throw new Error(`Unhandled stream parser mode: ${String(_ex)}`);
      }
      }
    }
  }

  private processText(): boolean {
    const startIdx = this.pending.indexOf(DELIMITED_PYTHONIC_TOOL_CALL_OPEN);
    if (startIdx === -1) {
      const holdBack = longestSuffixMatchingPrefix({
        text: this.pending,
        pattern: DELIMITED_PYTHONIC_TOOL_CALL_OPEN,
      });
      const safeLength = this.pending.length - holdBack;
      if (safeLength > 0) this.onText({ text: this.pending.slice(0, safeLength) });
      this.pending = this.pending.slice(safeLength);
      return false;
    }

    if (startIdx > 0) this.onText({ text: this.pending.slice(0, startIdx) });
    this.pending = this.pending.slice(startIdx + DELIMITED_PYTHONIC_TOOL_CALL_OPEN.length);
    this.startBlock();
    return true;
  }

  private processPayload(): void {
    const payloadParser = this.payloadParser;
    if (!payloadParser) throw new Error('Pythonic payload parser is unavailable');
    const result = payloadParser.feed({ input: this.pending });
    const consumed = this.pending.slice(0, result.consumed);
    this.frameRaw += consumed;
    this.pending = this.pending.slice(result.consumed);

    switch (result.status) {
    case 'incomplete':
      return;
    case 'invalid':
      this.mode = 'rejecting';
      this.rejectionReason = 'invalid-syntax';
      return;
    case 'complete':
      this.parsedBlockAst = result.ast;
      this.mode = 'await-close';
      this.closeMatchIndex = 0;
      return;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled payload result: ${String(_ex)}`);
    }
    }
  }

  private processAwaitClose(): void {
    const character = this.pending[0]!;
    this.pending = this.pending.slice(1);
    this.frameRaw += character;

    if (this.closeMatchIndex === 0 && /\s/.test(character)) return;

    const expected = DELIMITED_PYTHONIC_TOOL_CALL_CLOSE[this.closeMatchIndex];
    if (character !== expected) {
      this.mode = 'rejecting';
      this.rejectionReason = 'missing-close-delimiter';
      return;
    }

    this.closeMatchIndex += 1;
    if (this.closeMatchIndex === DELIMITED_PYTHONIC_TOOL_CALL_CLOSE.length) {
      this.commitOrRejectCompleteBlock();
    }
  }

  private processRejecting(): void {
    const character = this.pending[0]!;
    this.pending = this.pending.slice(1);
    this.frameRaw += character;
    if (this.frameRaw.endsWith(DELIMITED_PYTHONIC_TOOL_CALL_CLOSE)) {
      this.onText({ text: this.frameRaw });
      this.rejectActiveBlock({ reason: this.rejectionReason ?? 'invalid-syntax' });
    }
  }

  private startBlock(): void {
    const blockId = this.nextBlockId;
    this.nextBlockId += 1;
    this.activeBlockId = blockId;
    this.frameRaw = DELIMITED_PYTHONIC_TOOL_CALL_OPEN;
    this.parsedBlockAst = undefined;
    this.rejectionReason = undefined;
    this.mode = 'payload';
    this.payloadParser = new IncrementalPythonicToolCallPayloadParser({
      onCallParsed: ({ call, callIndex }) => {
        this.onEvent({ event: { type: 'call-parsed', blockId, callIndex, call } });
      },
    });
  }

  private commitOrRejectCompleteBlock(): void {
    const ast = this.parsedBlockAst;
    const blockId = this.activeBlockId;
    if (!ast || blockId === undefined) throw new Error('Completed Pythonic tool-call block has no AST');

    if (ast.calls.length === 0) {
      this.onText({ text: this.frameRaw });
      this.rejectActiveBlock({ reason: 'empty-tool-call-list' });
      return;
    }
    if (ast.calls.some(call => !this.allowedToolNames.has(call.name))) {
      this.onText({ text: this.frameRaw });
      this.rejectActiveBlock({ reason: 'tool-not-offered' });
      return;
    }

    this.parsedToolCalls.push(...ast.calls.map(callAst => {
      const call = pythonicFunctionCallAstToParsedCall({ ast: callAst });
      return {
        id: generateId<ToolCallId>(),
        type: 'function' as const,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      };
    }));
    this.onEvent({ event: { type: 'block-committed', blockId, callCount: ast.calls.length } });
    this.resetBlock();
  }

  private rejectActiveBlock({ reason }: {
    reason: Extract<DelimitedPythonicToolCallStreamEvent, { type: 'block-rejected' }>['reason'],
  }): void {
    const blockId = this.activeBlockId;
    if (blockId !== undefined) {
      this.onEvent({ event: { type: 'block-rejected', blockId, reason } });
    }
    this.resetBlock();
  }

  private resetBlock(): void {
    this.mode = 'text';
    this.frameRaw = '';
    this.payloadParser = undefined;
    this.parsedBlockAst = undefined;
    this.activeBlockId = undefined;
    this.closeMatchIndex = 0;
    this.rejectionReason = undefined;
  }
}

function isPythonicPunctuation(character: string): character is PythonicPunctuation {
  switch (character) {
  case '[':
  case ']':
  case '(':
  case ')':
  case '{':
  case '}':
  case ',':
  case '=':
  case ':':
    return true;
  default:
    return false;
  }
}

function isDigit({ character }: { character: string }): boolean {
  return character >= '0' && character <= '9';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  parseDelimitedPythonicToolCallPayloadAst,
};
