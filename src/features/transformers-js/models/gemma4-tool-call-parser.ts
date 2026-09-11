import type { ToolCall } from '@/01-models/types';
import type { ToolCallId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';
import { exactObject } from '@/utils/exact-object';

const OPEN = '<|tool_call>';
const CLOSE = '<tool_call|>';
const QUOTE = '<|"|>';
const CHANNEL_OPEN = '<|channel>';
const CHANNEL_CLOSE = '<channel|>';
const CONTROLS = [OPEN, CLOSE, '<|tool_response>', '<tool_response|>', '<turn|>', '<eos>', CHANNEL_OPEN, CHANNEL_CLOSE, QUOTE];
const MAX_PROTOCOL_CHARACTERS = 64 * 1024;
const MAX_DEPTH = 64;
const MAX_CALLS = 16;

export class Gemma4ToolCallProtocolError extends Error {
  constructor() {
    // Never include generated arguments in diagnostics: they may be private.
    super('Invalid, incomplete, or oversized Gemma tool-call protocol');
    this.name = 'Gemma4ToolCallProtocolError';
  }
}

type ArgumentValue = string | number | boolean | null | ArgumentValue[] | { [key: string]: ArgumentValue };

/** Reads the unambiguous Naidan-supported subset of the pinned Gemma grammar. */
class ArgumentReader {
  position: number;
  private readonly source: string;

  constructor({ source, position }: { source: string, position: number }) {
    this.source = source;
    this.position = position;
  }

  whitespace(): void {
    while (/\s/.test(this.source[this.position] ?? '') && this.position < this.source.length) this.position++;
  }

  consume({ token }: { token: string }): void {
    if (!this.source.startsWith(token, this.position)) throw new Gemma4ToolCallProtocolError();
    this.position += token.length;
  }

  bareToken(): string {
    // Explicit ASCII subset shared with the input formatter. This is not a
    // claim to support every Unicode interpretation of the metadata's \w+.
    const token = /^[A-Za-z0-9_$.-]+/.exec(this.source.slice(this.position))?.[0];
    if (!token) throw new Gemma4ToolCallProtocolError();
    this.position += token.length;
    return token;
  }

  object({ depth }: { depth: number }): { [key: string]: ArgumentValue } {
    if (depth > MAX_DEPTH) throw new Gemma4ToolCallProtocolError();
    this.consume({ token: '{' });
    const result: { [key: string]: ArgumentValue } = Object.create(null);
    this.whitespace();
    if (this.source[this.position] !== '}') {
      while (true) {
        const key = this.bareToken();
        if (Object.hasOwn(result, key)) throw new Gemma4ToolCallProtocolError();
        this.whitespace();
        this.consume({ token: ':' });
        result[key] = this.value({ depth: depth + 1 });
        this.whitespace();
        if (this.source[this.position] !== ',') break;
        this.position++;
        this.whitespace();
      }
    }
    this.consume({ token: '}' });
    return result;
  }

  private value({ depth }: { depth: number }): ArgumentValue {
    this.whitespace();
    if (this.source.startsWith(QUOTE, this.position)) {
      this.position += QUOTE.length;
      const end = this.source.indexOf(QUOTE, this.position);
      if (end < 0) throw new Gemma4ToolCallProtocolError();
      // Native quotes contain raw characters, not JSON escape sequences.
      const result = this.source.slice(this.position, end);
      this.position = end + QUOTE.length;
      return result;
    }
    if (this.source[this.position] === '{') return this.object({ depth });
    if (this.source[this.position] === '[') {
      if (depth > MAX_DEPTH) throw new Gemma4ToolCallProtocolError();
      this.position++;
      const result: ArgumentValue[] = [];
      this.whitespace();
      if (this.source[this.position] !== ']') {
        while (true) {
          result.push(this.value({ depth: depth + 1 }));
          this.whitespace();
          if (this.source[this.position] !== ',') break;
          this.position++;
        }
      }
      this.consume({ token: ']' });
      return result;
    }
    for (const [token, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.source.startsWith(token, this.position)) {
        this.position += token.length;
        return value;
      }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.position))?.[0];
    if (!token) throw new Gemma4ToolCallProtocolError();
    const value = Number(token);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Gemma4ToolCallProtocolError();
    this.position += token.length;
    return value;
  }
}

/**
 * Parses generated native syntax, not an inverse of arbitrary template input:
 * the template's unescaped quote delimiter makes some source values ambiguous.
 * Known lossy history is rejected by the input formatter. Generated valid syntax
 * still requires the Provider's registered-tool/schema/approval checks.
 *
 * Ordinary text streams immediately. From the first executable call marker,
 * hold at most 64 Ki UTF-16 code units until the whole generation validates.
 * No call can be drained before successful flush, including an earlier valid
 * call followed by malformed output. Raw evidence belongs to the caller.
 */
export class Gemma4ToolCallParser {
  private readonly onText: ({ text }: { text: string }) => void;
  private readonly toolCalls: 'enabled' | 'disabled';
  private readonly controls: readonly string[];
  private pending = '';
  private protocol: string | undefined;
  private channel: 'ordinary' | 'header' | 'thought' | 'other' = 'ordinary';
  private channelHeader = '';
  private publicThought: 'open' | 'closed' = 'closed';
  private quoteState: 'outside' | 'inside' = 'outside';
  private state: 'feeding' | 'flushed' | 'failed' = 'feeding';
  private calls: ToolCall[] = [];

  constructor({ onText, toolCalls, ignoredSpecialTokens }: {
    onText: ({ text }: { text: string }) => void; toolCalls: 'enabled' | 'disabled'; ignoredSpecialTokens: readonly string[];
  }) {
    this.onText = onText;
    this.toolCalls = toolCalls;
    if (ignoredSpecialTokens.some(token => typeof token !== 'string' || token.length === 0)) throw new Gemma4ToolCallProtocolError();
    this.controls = [...new Set([...CONTROLS, ...ignoredSpecialTokens])];
  }

  feed({ output }: { output: string }): void {
    switch (this.state) {
    case 'feeding': break;
    case 'flushed':
    case 'failed': throw new Gemma4ToolCallProtocolError();
    default: {
      const _ex: never = this.state;
      throw new Error(`Unhandled parser state: ${_ex}`);
    }
    }
    try {
      if (this.protocol !== undefined) {
        if (this.protocol.length + output.length > MAX_PROTOCOL_CHARACTERS) throw new Gemma4ToolCallProtocolError();
        this.protocol += output;
      } else {
        this.pending += output;
        this.streamOrdinary({ final: false });
      }
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  flush(): void {
    switch (this.state) {
    case 'flushed': return;
    case 'failed': throw new Gemma4ToolCallProtocolError();
    case 'feeding': break;
    default: {
      const _ex: never = this.state;
      throw new Error(`Unhandled parser state: ${_ex}`);
    }
    }
    try {
      this.streamOrdinary({ final: true });
      if (this.protocol !== undefined) this.parseProtocol();
      this.closePublicThought();
      this.state = 'flushed';
      this.protocol = undefined;
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  drainToolCalls(): ToolCall[] {
    switch (this.state) {
    case 'flushed': break;
    case 'feeding':
    case 'failed': throw new Gemma4ToolCallProtocolError();
    default: {
      const _ex: never = this.state;
      throw new Error(`Unhandled parser state: ${_ex}`);
    }
    }
    const calls = this.calls;
    this.calls = [];
    return calls;
  }

  /** End only the public display interval on native failure, never publish calls. */
  abort(): void {
    this.fail();
  }

  private closePublicThought(): void {
    const wasPublished = this.publicThought === 'open';
    this.channel = 'ordinary';
    this.channelHeader = '';
    this.publicThought = 'closed';
    if (wasPublished) this.onText({ text: '</think>' });
  }

  private publishText({ text }: { text: string }): void {
    if (!text) return;
    // Parsing may advance past an opening or closing delimiter before a later
    // error. Only committed text changes the public interval's state.
    switch (this.channel) {
    case 'thought': this.publicThought = 'open'; break;
    case 'ordinary': case 'header': case 'other': this.publicThought = 'closed'; break;
    default: { const exhaustive: never = this.channel; throw new Error(`Unhandled channel state: ${exhaustive}`); }
    }
    this.onText({ text });
  }

  private fail(): void {
    this.state = 'failed';
    this.pending = '';
    this.protocol = undefined;
    this.calls = [];
    // A failed output callback must not replace the original protocol/native
    // error. This terminates a public interval, not a native completion claim.
    try {
      this.closePublicThought();
    } catch { /* Preserve the original failure. */ }
  }

  private renderCharacter({ character }: { character: string }): string {
    switch (this.channel) {
    case 'ordinary': case 'thought': case 'other': return character;
    case 'header': break;
    default: { const exhaustive: never = this.channel; throw new Error(`Unhandled channel state: ${exhaustive}`); }
    }
    this.channelHeader += character;
    if (this.channelHeader === 'thought\n') {
      this.channelHeader = '';
      this.channel = 'thought';
      return '<think>';
    }
    if ('thought\n'.startsWith(this.channelHeader)) return '';
    // Unknown channel labels remain ordinary text, not invented reasoning or
    // executable syntax. Native framing itself stays inside this adapter.
    this.channel = 'other';
    const header = this.channelHeader;
    this.channelHeader = '';
    return header;
  }

  private renderControl({ control }: { control: string }): string {
    switch (this.quoteState) {
    case 'inside':
      if (control === QUOTE) this.quoteState = 'outside';
      // A quoted channel terminator is data, not permission to execute a
      // subsequent call-shaped substring inside the same thought string.
      return control;
    case 'outside':
      if (control === QUOTE) {
        this.quoteState = 'inside';
        return control;
      }
      if (control === CHANNEL_OPEN) {
        const ending = this.renderThoughtEnding();
        this.channel = 'header';
        this.channelHeader = '';
        return ending;
      }
      if (control === CHANNEL_CLOSE) {
        const ending = this.renderThoughtEnding();
        this.channel = 'ordinary';
        this.channelHeader = '';
        return ending;
      }
      switch (this.channel) {
      // Call-shaped strings inside a thought are data, not executable calls.
      case 'thought': return [OPEN, CLOSE, '<|tool_response>', '<tool_response|>'].includes(control) ? control : '';
      case 'header': return '';
      case 'other': return '';
      case 'ordinary': return '';
      default: { const exhaustive: never = this.channel; throw new Error(`Unhandled channel state: ${exhaustive}`); }
      }
    default: {
      const _ex: never = this.quoteState;
      throw new Error(`Unhandled quote state: ${_ex}`);
    }
    }
  }

  private renderThoughtEnding(): string {
    switch (this.channel) {
    case 'thought': return '</think>';
    case 'ordinary': case 'header': case 'other': return '';
    default: { const exhaustive: never = this.channel; throw new Error(`Unhandled channel state: ${exhaustive}`); }
    }
  }

  private streamOrdinary({ final }: { final: boolean }): void {
    let position = 0;
    let text = '';
    while (position < this.pending.length) {
      const control = this.controls.find(token => this.pending.startsWith(token, position));
      if (control === OPEN && this.toolCalls === 'enabled' && this.channel === 'ordinary' && this.quoteState === 'outside') {
        const remaining = this.pending.length - position;
        if (remaining > MAX_PROTOCOL_CHARACTERS) throw new Gemma4ToolCallProtocolError();
        this.protocol = this.pending.slice(position);
        position = this.pending.length;
        break;
      }
      if (control !== undefined) {
        text += this.renderControl({ control });
        position += control.length;
      } else {
        if (!final && this.controls.some(token => token.startsWith(this.pending.slice(position)))) break;
        if (final && this.quoteState === 'outside' && [CHANNEL_OPEN, CHANNEL_CLOSE].some(token => token.startsWith(this.pending.slice(position)))) {
          position = this.pending.length;
          break;
        }
        text += this.renderCharacter({ character: this.pending[position]! });
        position++;
      }
    }
    this.pending = this.pending.slice(position);
    this.publishText({ text });
  }

  private parseProtocol(): void {
    const source = this.protocol!;
    const reader = new ArgumentReader({ source, position: 0 });
    const calls: ToolCall[] = [];
    let text = '';
    while (reader.position < source.length) {
      const control = this.controls.find(token => source.startsWith(token, reader.position));
      if (control === OPEN && this.channel === 'ordinary' && this.quoteState === 'outside') {
        if (calls.length >= MAX_CALLS) throw new Gemma4ToolCallProtocolError();
        reader.consume({ token: OPEN });
        reader.consume({ token: 'call:' });
        const name = reader.bareToken();
        reader.whitespace();
        const args = reader.object({ depth: 1 });
        reader.whitespace();
        reader.consume({ token: CLOSE });
        calls.push(exactObject<ToolCall>()({ id: generateId<ToolCallId>(), type: 'function', function: { name, arguments: JSON.stringify(args) } }));
      } else if (control !== undefined) {
        text += this.renderControl({ control });
        reader.position += control.length;
      } else {
        text += this.renderCharacter({ character: source[reader.position]! });
        reader.position++;
      }
    }
    // Callback failure must also prevent draining the otherwise valid calls.
    this.publishText({ text });
    this.calls = calls;
  }
}

export const TEST_ONLY = {
};
