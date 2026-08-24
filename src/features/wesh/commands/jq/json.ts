import type { JsonValue } from './ast';
import { normalizeJsonValue, stringifyJson } from './value';
import {
  createJqNumberOrigin,
  setJsonChildNumberOrigin,
  type JqNumberOrigin,
} from './number-origin';

function isWhitespace({
  char,
}: {
  char: string,
}): boolean {
  return /\s/.test(char);
}

const jqFiniteNumberPattern = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))([eE][+-]?\d+)?$/u;
const jqSpecialNumberPattern = /^([+-]?)(nan\d*|inf(?:inity)?)$/iu;

interface JqSpecialNumber {
  readonly normalizedJson: string,
  readonly value: number,
}

function parseJqSpecialNumber({
  lexeme,
}: {
  lexeme: string,
}): JqSpecialNumber | undefined {
  const match = jqSpecialNumberPattern.exec(lexeme);
  if (match === null) return undefined;

  if (match[2]!.toLowerCase().startsWith('nan')) {
    return { normalizedJson: '0', value: Number.NaN };
  }

  const negative = match[1] === '-';
  return {
    normalizedJson: `${negative ? '-' : ''}${String(Number.MAX_VALUE)}`,
    value: negative ? -Number.MAX_VALUE : Number.MAX_VALUE,
  };
}

function isJqPrimitiveLexeme({
  lexeme,
}: {
  lexeme: string,
}): boolean {
  return lexeme === 'true'
    || lexeme === 'false'
    || lexeme === 'null'
    || normalizeJqFiniteNumberLexemeForJson({ lexeme }) !== undefined
    || parseJqSpecialNumber({ lexeme }) !== undefined;
}

function normalizeJqFiniteNumberLexemeForJson({
  lexeme,
}: {
  lexeme: string,
}): string | undefined {
  const match = jqFiniteNumberPattern.exec(lexeme);
  if (match === null) return undefined;

  const sign = match[1] === '-' ? '-' : '';
  const integer = match[2];
  const explicitFraction = match[3];
  const leadingFraction = match[4];
  const exponent = match[5] ?? '';

  if (integer === undefined) {
    return `${sign}0.${leadingFraction!}${exponent}`;
  }

  const normalizedInteger = integer.replace(/^0+(?=\d)/u, '');
  const fraction = explicitFraction === undefined
    ? ''
    : `.${explicitFraction.length === 0 ? '0' : explicitFraction}`;
  return `${sign}${normalizedInteger}${fraction}${exponent}`;
}

function normalizeJqFiniteNumbersForJsonParse({
  text,
}: {
  text: string,
}): string {
  let rewritten: string[] | undefined;
  let copiedThrough = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const end = scanStringEnd({ text, start: index });
      if (end === undefined) {
        index = text.length;
        break;
      }
      index = end;
      continue;
    }

    if (isWhitespace({ char }) || /[{}[\],:]/u.test(char)) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < text.length) {
      const candidate = text[end]!;
      if (candidate === '"' || isWhitespace({ char: candidate }) || /[{}[\],:]/u.test(candidate)) break;
      end += 1;
    }

    const lexeme = text.slice(index, end);
    const normalizedNumber = normalizeJqFiniteNumberLexemeForJson({ lexeme })
      ?? parseJqSpecialNumber({ lexeme })?.normalizedJson;
    if (normalizedNumber !== undefined && normalizedNumber !== lexeme) {
      rewritten ??= [];
      rewritten.push(text.slice(copiedThrough, index), normalizedNumber);
      copiedThrough = end;
    }
    index = end;
  }

  if (rewritten === undefined) return text;
  rewritten.push(text.slice(copiedThrough));
  return rewritten.join('');
}

function scanStringEnd({
  text,
  start,
}: {
  text: string,
  start: number,
}): number | undefined {
  let index = start + 1;
  let escaped = false;

  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;
    if (!escaped && char === '"') return index + 1;
    if (!escaped && char === '\\') {
      escaped = true;
      index += 1;
      continue;
    }
    escaped = false;
    index += 1;
  }

  return undefined;
}

function scanStructuredEnd({
  text,
  start,
}: {
  text: string,
  start: number,
}): number | undefined {
  const stack: string[] = [text[start]!];
  let index = start + 1;
  let inString = false;
  let escaped = false;

  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;

    if (inString) {
      if (!escaped && char === '"') {
        inString = false;
        index += 1;
        continue;
      }
      if (!escaped && char === '\\') {
        escaped = true;
        index += 1;
        continue;
      }
      escaped = false;
      index += 1;
      continue;
    }

    switch (char) {
    case '"':
      inString = true;
      index += 1;
      continue;
    case '{':
    case '[':
      stack.push(char);
      index += 1;
      continue;
    case '}':
      if (stack[stack.length - 1] !== '{') return undefined;
      stack.pop();
      index += 1;
      if (stack.length === 0) return index;
      continue;
    case ']':
      if (stack[stack.length - 1] !== '[') return undefined;
      stack.pop();
      index += 1;
      if (stack.length === 0) return index;
      continue;
    default:
      index += 1;
      continue;
    }
  }

  return undefined;
}

type IncrementalStructuredScan =
  | { readonly kind: 'complete', readonly end: number }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'invalid', readonly offset: number };

type JqStructuredParserFrame =
  | {
    readonly kind: 'array',
    hasEntries: boolean,
  }
  | {
    readonly kind: 'object',
    hasEntries: boolean,
  }
  | {
    readonly kind: 'object_key',
  };

type JqStructuredParserValueKind = 'string' | 'value';

function structuredErrorRecoveryEnd({
  text,
  offset,
}: {
  text: string,
  offset: number,
}): number {
  const newline = text.indexOf('\n', Math.max(0, offset));
  return newline < 0 ? text.length : newline + 1;
}

function scanStructuredPrimitiveToken({
  text,
  start,
}: {
  text: string,
  start: number,
}): { readonly end: number, readonly boundaryKnown: boolean } {
  let end = start;
  while (end < text.length) {
    const char = text[end]!;
    if (isWhitespace({ char }) || /[{}[\],:"]/u.test(char)) break;
    end += 1;
  }
  return { end, boundaryKnown: end < text.length };
}

function isHexDigit({
  char,
}: {
  char: string,
}): boolean {
  return /^[0-9a-f]$/iu.test(char);
}

function parseHexCodeUnit({
  text,
  start,
}: {
  text: string,
  start: number,
}): number | undefined {
  const end = start + 4;
  if (end > text.length) return undefined;
  for (let index = start; index < end; index += 1) {
    if (!isHexDigit({ char: text[index]! })) return undefined;
  }
  return Number.parseInt(text.slice(start, end), 16);
}

/**
 * Validate a closed JSON string with the same escape rules jq's non-streaming
 * parser applies before it publishes the string as its pending value. Keeping
 * this validation in the incremental structural scan is important: a malformed
 * key can fail in the current parser input buffer even when the surrounding
 * object continues in a later positional file.
 */
function isJqStructuredStringLexemeValid({
  text,
  start,
  end,
}: {
  text: string,
  start: number,
  end: number,
}): boolean {
  const contentEnd = end - 1;
  let index = start + 1;

  while (index < contentEnd) {
    const char = text[index]!;
    if (char !== '\\') {
      const code = char.charCodeAt(0);
      if (code > 0 && code < 0x001f) return false;
      index += 1;
      continue;
    }

    const escape = text[index + 1];
    if (escape === undefined || index + 1 >= contentEnd) return false;
    switch (escape) {
    case '\\':
    case '"':
    case '/':
    case 'b':
    case 'f':
    case 't':
    case 'n':
    case 'r':
      index += 2;
      continue;
    case 'u': {
      const codePoint = parseHexCodeUnit({ text, start: index + 2 });
      if (codePoint === undefined || index + 6 > contentEnd) return false;
      index += 6;
      if (codePoint < 0xd800 || codePoint > 0xdbff) continue;
      if (index + 6 > contentEnd || text[index] !== '\\' || text[index + 1] !== 'u') return false;
      const lowSurrogate = parseHexCodeUnit({ text, start: index + 2 });
      if (lowSurrogate === undefined || lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) return false;
      index += 6;
      continue;
    }
    default:
      return false;
    }
  }

  return true;
}

/**
 * Incrementally mirror the structural state used by jq's ordinary JSON parser.
 * jq deliberately does not enforce a conventional "object key expected" state
 * when it sees an opening container. Instead it keeps a container stack plus a
 * pending value, and punctuation validates that state later. Reproducing that
 * model avoids both speculative later-file reads and false early errors for
 * inputs that jq itself keeps parsing until a later token.
 */
function scanStructuredIncrementally({
  text,
  start,
}: {
  text: string,
  start: number,
}): IncrementalStructuredScan {
  const frames: JqStructuredParserFrame[] = [
    text[start] === '['
      ? { kind: 'array', hasEntries: false }
      : { kind: 'object', hasEntries: false },
  ];
  let nextValueKind: JqStructuredParserValueKind | undefined;
  let index = start + 1;

  const invalid = ({ offset }: { offset: number }): IncrementalStructuredScan => ({
    kind: 'invalid',
    offset,
  });

  const acceptValue = ({
    kind,
    offset,
  }: {
    kind: JqStructuredParserValueKind,
    offset: number,
  }): IncrementalStructuredScan | undefined => {
    if (nextValueKind !== undefined) return invalid({ offset });
    nextValueKind = kind;
    return undefined;
  };

  while (index < text.length) {
    const char = text[index]!;
    if (isWhitespace({ char })) {
      index += 1;
      continue;
    }

    if (char === '"') {
      const end = scanStringEnd({ text, start: index });
      if (end === undefined) return { kind: 'incomplete' };
      if (!isJqStructuredStringLexemeValid({ text, start: index, end })) {
        return invalid({ offset: end - 1 });
      }
      const rejected = acceptValue({ kind: 'string', offset: end - 1 });
      if (rejected !== undefined) return rejected;
      index = end;
      continue;
    }

    if (char !== '[' && char !== '{' && char !== ':' && char !== ',' && char !== ']' && char !== '}') {
      const primitive = scanStructuredPrimitiveToken({ text, start: index });
      if (!primitive.boundaryKnown) return { kind: 'incomplete' };
      const lexeme = text.slice(index, primitive.end);
      if (!isJqPrimitiveLexeme({ lexeme })) {
        return invalid({ offset: Math.min(text.length - 1, primitive.end) });
      }
      const rejected = acceptValue({ kind: 'value', offset: Math.min(text.length - 1, primitive.end) });
      if (rejected !== undefined) return rejected;
      index = primitive.end;
      continue;
    }

    switch (char) {
    case '[':
      if (nextValueKind !== undefined) return invalid({ offset: index });
      frames.push({ kind: 'array', hasEntries: false });
      index += 1;
      continue;
    case '{':
      if (nextValueKind !== undefined) return invalid({ offset: index });
      frames.push({ kind: 'object', hasEntries: false });
      index += 1;
      continue;
    case ':': {
      if (nextValueKind === undefined) return invalid({ offset: index });
      const frame = frames[frames.length - 1];
      if (frame === undefined || frame.kind !== 'object') return invalid({ offset: index });
      switch (nextValueKind) {
      case 'string':
        break;
      case 'value':
        return invalid({ offset: index });
      default: {
        const _exhaustive: never = nextValueKind;
        throw new Error(`Unhandled jq structured parser value kind: ${_exhaustive}`);
      }
      }
      frames.push({ kind: 'object_key' });
      nextValueKind = undefined;
      index += 1;
      continue;
    }
    case ',': {
      if (nextValueKind === undefined) return invalid({ offset: index });
      const frame = frames[frames.length - 1];
      if (frame === undefined) return invalid({ offset: index });
      switch (frame.kind) {
      case 'array':
        frame.hasEntries = true;
        nextValueKind = undefined;
        index += 1;
        continue;
      case 'object_key': {
        frames.pop();
        const objectFrame = frames[frames.length - 1];
        if (objectFrame === undefined || objectFrame.kind !== 'object') {
          throw new Error('Invalid jq structured parser object-key stack');
        }
        objectFrame.hasEntries = true;
        nextValueKind = undefined;
        index += 1;
        continue;
      }
      case 'object':
        return invalid({ offset: index });
      default: {
        const _exhaustive: never = frame;
        throw new Error(`Unhandled jq structured parser frame: ${JSON.stringify(_exhaustive)}`);
      }
      }
    }
    case ']': {
      const frame = frames[frames.length - 1];
      if (frame === undefined || frame.kind !== 'array') return invalid({ offset: index });
      if (nextValueKind !== undefined) {
        frame.hasEntries = true;
        nextValueKind = undefined;
      } else if (frame.hasEntries) {
        return invalid({ offset: index });
      }
      frames.pop();
      nextValueKind = 'value';
      index += 1;
      if (frames.length === 0) return { kind: 'complete', end: index };
      continue;
    }
    case '}': {
      let frame = frames[frames.length - 1];
      if (frame === undefined) return invalid({ offset: index });
      if (nextValueKind !== undefined) {
        switch (frame.kind) {
        case 'object_key':
          break;
        case 'array':
        case 'object':
          return invalid({ offset: index });
        default: {
          const _exhaustive: never = frame;
          throw new Error(`Unhandled jq structured parser frame: ${JSON.stringify(_exhaustive)}`);
        }
        }
        frames.pop();
        frame = frames[frames.length - 1];
        if (frame === undefined || frame.kind !== 'object') {
          throw new Error('Invalid jq structured parser object close stack');
        }
        frame.hasEntries = true;
        nextValueKind = undefined;
      } else {
        switch (frame.kind) {
        case 'object':
          if (frame.hasEntries) return invalid({ offset: index });
          break;
        case 'array':
        case 'object_key':
          return invalid({ offset: index });
        default: {
          const _exhaustive: never = frame;
          throw new Error(`Unhandled jq structured parser frame: ${JSON.stringify(_exhaustive)}`);
        }
        }
      }
      frames.pop();
      nextValueKind = 'value';
      index += 1;
      if (frames.length === 0) return { kind: 'complete', end: index };
      continue;
    }
    default: {
      const _exhaustive: never = char;
      throw new Error(`Unhandled jq structured parser token: ${_exhaustive}`);
    }
    }
  }

  return { kind: 'incomplete' };
}

type IncrementalPrimitiveScan = {
  readonly end: number,
  readonly boundaryKnown: boolean,
};

function scanPrimitiveIncrementally({
  text,
  start,
}: {
  text: string,
  start: number,
}): IncrementalPrimitiveScan {
  let index = start;
  let malformed = false;

  while (index < text.length) {
    const char = text[index];
    if (char === undefined || isWhitespace({ char })) {
      return { end: index, boundaryKnown: true };
    }

    if (char === ',' || char === ']' || char === '}' || char === ':') {
      malformed = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === '[' || char === '{') {
      const prefix = text.slice(start, index);
      if (!malformed && isJqPrimitiveLexeme({ lexeme: prefix })) {
        return { end: index, boundaryKnown: true };
      }

      malformed = true;
      switch (char) {
      case '"':
        index = scanStringEnd({ text, start: index }) ?? text.length;
        break;
      case '[':
      case '{':
        index = scanStructuredEnd({ text, start: index }) ?? text.length;
        break;
      default: {
        const _exhaustive: never = char;
        throw new Error(`Unhandled primitive suffix delimiter: ${_exhaustive}`);
      }
      }
      continue;
    }

    index += 1;
  }

  return { end: index, boundaryKnown: malformed };
}

function scanPrimitiveEnd({
  text,
  start,
}: {
  text: string,
  start: number,
}): number {
  let index = start;
  let malformed = false;

  while (index < text.length) {
    const char = text[index];
    if (char === undefined || isWhitespace({ char })) break;

    if (char === ',' || char === ']' || char === '}' || char === ':') {
      malformed = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === '[' || char === '{') {
      const prefix = text.slice(start, index);
      if (!malformed && isJqPrimitiveLexeme({ lexeme: prefix })) break;

      // Once a primitive prefix is already malformed, a quoted/structured
      // fragment before the next whitespace belongs to the same jq parse
      // error. Consume it atomically so input? cannot expose a suffix that
      // Linux jq considers part of the rejected input event.
      malformed = true;
      switch (char) {
      case '"':
        index = scanStringEnd({ text, start: index }) ?? text.length;
        break;
      case '[':
      case '{':
        index = scanStructuredEnd({ text, start: index }) ?? text.length;
        break;
      default: {
        const _exhaustive: never = char;
        throw new Error(`Unhandled primitive suffix delimiter: ${_exhaustive}`);
      }
      }
      continue;
    }

    index += 1;
  }

  return index;
}


type JsonNumberOriginTree =
  | { readonly kind: 'number', readonly origin: JqNumberOrigin }
  | { readonly kind: 'special_number', readonly value: number }
  | { readonly kind: 'array', readonly items: ReadonlyMap<number, JsonNumberOriginTree> }
  | { readonly kind: 'object', readonly entries: ReadonlyMap<string, JsonNumberOriginTree> };

function skipJsonWhitespace({ text, start }: { text: string, start: number }): number {
  let index = start;
  while (index < text.length && /[\t\n\r ]/u.test(text[index]!)) index += 1;
  return index;
}

function parseJsonNumberOriginTree({
  text,
  start,
}: {
  text: string,
  start: number,
}): { readonly end: number, readonly tree: JsonNumberOriginTree | undefined } | undefined {
  const index = skipJsonWhitespace({ text, start });
  const char = text[index];
  if (char === undefined) return undefined;
  if (char === '"') {
    const end = scanStringEnd({ text, start: index });
    return end === undefined ? undefined : { end, tree: undefined };
  }
  if (char === '[') {
    let cursor = skipJsonWhitespace({ text, start: index + 1 });
    const items = new Map<number, JsonNumberOriginTree>();
    let itemIndex = 0;
    if (text[cursor] === ']') return { end: cursor + 1, tree: { kind: 'array', items } };
    while (cursor < text.length) {
      const parsed = parseJsonNumberOriginTree({ text, start: cursor });
      if (parsed === undefined) return undefined;
      if (parsed.tree !== undefined) items.set(itemIndex, parsed.tree);
      itemIndex += 1;
      cursor = skipJsonWhitespace({ text, start: parsed.end });
      if (text[cursor] === ']') return { end: cursor + 1, tree: { kind: 'array', items } };
      if (text[cursor] !== ',') return undefined;
      cursor = skipJsonWhitespace({ text, start: cursor + 1 });
    }
    return undefined;
  }
  if (char === '{') {
    let cursor = skipJsonWhitespace({ text, start: index + 1 });
    const entries = new Map<string, JsonNumberOriginTree>();
    if (text[cursor] === '}') return { end: cursor + 1, tree: { kind: 'object', entries } };
    while (cursor < text.length) {
      if (text[cursor] !== '"') return undefined;
      const keyEnd = scanStringEnd({ text, start: cursor });
      if (keyEnd === undefined) return undefined;
      const key = JSON.parse(text.slice(cursor, keyEnd)) as string;
      cursor = skipJsonWhitespace({ text, start: keyEnd });
      if (text[cursor] !== ':') return undefined;
      const parsed = parseJsonNumberOriginTree({ text, start: cursor + 1 });
      if (parsed === undefined) return undefined;
      if (parsed.tree === undefined) entries.delete(key);
      else entries.set(key, parsed.tree);
      cursor = skipJsonWhitespace({ text, start: parsed.end });
      if (text[cursor] === '}') return { end: cursor + 1, tree: { kind: 'object', entries } };
      if (text[cursor] !== ',') return undefined;
      cursor = skipJsonWhitespace({ text, start: cursor + 1 });
    }
    return undefined;
  }
  for (const literal of ['true', 'false', 'null'] as const) {
    if (text.startsWith(literal, index)) return { end: index + literal.length, tree: undefined };
  }
  const specialMatch = text.slice(index).match(/^[+-]?(?:nan\d*|inf(?:inity)?)/iu);
  const specialLexeme = specialMatch?.[0];
  if (specialLexeme !== undefined) {
    const special = parseJqSpecialNumber({ lexeme: specialLexeme });
    if (special !== undefined) {
      return {
        end: index + specialLexeme.length,
        tree: { kind: 'special_number', value: special.value },
      };
    }
  }
  const match = text.slice(index).match(/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/u);
  const lexeme = match?.[0];
  if (lexeme === undefined) return undefined;
  const origin = createJqNumberOrigin({ lexeme });
  return origin === undefined
    ? undefined
    : { end: index + lexeme.length, tree: { kind: 'number', origin } };
}

function applyJsonSpecialNumberTree({
  value,
  tree,
}: {
  value: JsonValue,
  tree: JsonNumberOriginTree | undefined,
}): JsonValue {
  if (tree === undefined || tree.kind === 'number') return value;
  switch (tree.kind) {
  case 'special_number':
    return tree.value;
  case 'array':
    if (!Array.isArray(value)) return value;
    for (const [index, childTree] of tree.items) {
      const child = value[index];
      if (child === undefined) continue;
      value[index] = applyJsonSpecialNumberTree({ value: child, tree: childTree });
    }
    return value;
  case 'object':
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    for (const [key, childTree] of tree.entries) {
      if (!Object.hasOwn(value, key)) continue;
      value[key] = applyJsonSpecialNumberTree({ value: value[key]!, tree: childTree });
    }
    return value;
  default: {
    const _ex: never = tree;
    throw new Error(`Unhandled jq special number tree: ${String(_ex)}`);
  }
  }
}

function applyJsonNumberOriginTree({
  value,
  tree,
}: {
  value: JsonValue,
  tree: JsonNumberOriginTree | undefined,
}): JqNumberOrigin | undefined {
  if (tree === undefined) return undefined;
  switch (tree.kind) {
  case 'number':
    return tree.origin;
  case 'special_number':
    return undefined;
  case 'array':
    if (!Array.isArray(value)) return undefined;
    for (const [index, childTree] of tree.items) {
      const child = value[index];
      if (child === undefined) continue;
      const origin = applyJsonNumberOriginTree({ value: child, tree: childTree });
      setJsonChildNumberOrigin({ container: value, key: index, origin });
    }
    return undefined;
  case 'object':
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    for (const [key, childTree] of tree.entries) {
      if (!Object.hasOwn(value, key)) continue;
      const origin = applyJsonNumberOriginTree({ value: value[key]!, tree: childTree });
      setJsonChildNumberOrigin({ container: value, key, origin });
    }
    return undefined;
  default: {
    const _ex: never = tree;
    throw new Error(`Unhandled jq number origin tree: ${String(_ex)}`);
  }
  }
}

export function parseJsonValueWithNumberOrigins({
  text,
}: {
  text: string,
}):
  | { ok: true, value: JsonValue, numberOrigin?: JqNumberOrigin }
  | { ok: false, message: string } {
  try {
    const normalizedText = normalizeJqFiniteNumbersForJsonParse({ text });
    const parsedValue = normalizeJsonValue({ value: JSON.parse(normalizedText) as JsonValue });
    const parsedTree = parseJsonNumberOriginTree({ text, start: 0 });
    const value = applyJsonSpecialNumberTree({ value: parsedValue, tree: parsedTree?.tree });
    const numberOrigin = applyJsonNumberOriginTree({ value, tree: parsedTree?.tree });
    return {
      ok: true,
      value,
      ...(numberOrigin === undefined ? {} : { numberOrigin }),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export type JsonSequenceEntry =
  | { ok: true, value: JsonValue, lineNumber: number, numberOrigin?: JqNumberOrigin }
  | { ok: false, message: string, lineNumber: number };

export type JsonIncrementalSequenceResult =
  | {
      readonly kind: 'value',
      readonly value: JsonValue,
      readonly nextIndex: number,
      readonly tokenStart: number,
      readonly tokenEnd: number,
      readonly completionOffset: number,
      readonly numberOrigin?: JqNumberOrigin,
    }
  | {
      readonly kind: 'error',
      readonly message: string,
      readonly nextIndex: number,
      readonly tokenStart: number,
      readonly tokenEnd: number,
      readonly completionOffset: number,
    }
  | {
      readonly kind: 'need_more_input',
      readonly nextIndex: number,
      readonly pendingToken: boolean,
    }
  | {
      readonly kind: 'exhausted',
      readonly nextIndex: number,
    };

/**
 * Scan one jq JSON-sequence value without assuming that the current text is
 * the end of the logical input stream. Positional jq files are consecutive
 * byte segments, so an otherwise valid primitive at a segment boundary is
 * still continuation-eligible until another byte (or true source EOF) is
 * observed. Strings and structured values are self-delimiting once their
 * closing token is present and therefore do not require speculative access to
 * a later input path.
 */
export function scanJsonSequenceIncrementally({
  text,
  start,
  endOfInput,
  errorRecoveryEnd,
}: {
  text: string,
  start: number,
  endOfInput: boolean,
  errorRecoveryEnd?: ({ offset }: { readonly offset: number }) => number,
}): JsonIncrementalSequenceResult {
  const recoverErrorEnd = ({ offset }: { offset: number }): number => {
    const end = errorRecoveryEnd?.({ offset }) ?? structuredErrorRecoveryEnd({ text, offset });
    if (!Number.isSafeInteger(end) || end <= offset || end > text.length) {
      throw new Error(`Invalid jq parser error recovery boundary ${end} for offset ${offset}`);
    }
    return end;
  };
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === undefined || !isWhitespace({ char })) break;
    index += 1;
  }

  if (index >= text.length) {
    return endOfInput
      ? { kind: 'exhausted', nextIndex: index }
      : { kind: 'need_more_input', nextIndex: index, pendingToken: false };
  }

  const tokenStart = index;
  const char = text[tokenStart]!;
  let tokenEnd: number | undefined;
  let completionOffset: number;
  let primitive = false;
  let tokenEndIsRecoveryBoundary = false;

  switch (char) {
  case '"':
    tokenEnd = scanStringEnd({ text, start: tokenStart });
    if (tokenEnd === undefined) {
      if (!endOfInput) {
        return { kind: 'need_more_input', nextIndex: tokenStart, pendingToken: true };
      }
      return {
        kind: 'error',
        message: `invalid JSON input near byte ${tokenStart}`,
        nextIndex: text.length,
        tokenStart,
        tokenEnd: text.length,
        completionOffset: text.length,
      };
    }
    completionOffset = tokenEnd - 1;
    break;
  case '{':
  case '[': {
    const structured = scanStructuredIncrementally({ text, start: tokenStart });
    switch (structured.kind) {
    case 'complete':
      tokenEnd = structured.end;
      completionOffset = tokenEnd - 1;
      break;
    case 'invalid':
      tokenEnd = recoverErrorEnd({ offset: structured.offset });
      completionOffset = tokenEnd - 1;
      tokenEndIsRecoveryBoundary = true;
      break;
    case 'incomplete':
      if (!endOfInput) {
        return { kind: 'need_more_input', nextIndex: tokenStart, pendingToken: true };
      }
      return {
        kind: 'error',
        message: `invalid JSON input near byte ${tokenStart}`,
        nextIndex: text.length,
        tokenStart,
        tokenEnd: text.length,
        completionOffset: text.length,
      };
    default: {
      const _ex: never = structured;
      throw new Error(`Unhandled incremental structured JSON scan: ${JSON.stringify(_ex)}`);
    }
    }
    break;
  }
  default: {
    primitive = true;
    const primitiveScan = scanPrimitiveIncrementally({ text, start: tokenStart });
    tokenEnd = primitiveScan.end;
    if (tokenEnd === text.length && !endOfInput && !primitiveScan.boundaryKnown) {
      return { kind: 'need_more_input', nextIndex: tokenStart, pendingToken: true };
    }
    completionOffset = tokenEnd < text.length ? tokenEnd : Math.max(tokenStart, tokenEnd - 1);
    break;
  }
  }

  if (tokenEnd <= tokenStart) {
    return {
      kind: 'error',
      message: `invalid JSON input near byte ${tokenStart}`,
      nextIndex: Math.max(tokenStart + 1, tokenEnd),
      tokenStart,
      tokenEnd,
      completionOffset,
    };
  }

  const slice = text.slice(tokenStart, tokenEnd);
  try {
    const normalizedSlice = normalizeJqFiniteNumbersForJsonParse({ text: slice });
    const parsedValue = normalizeJsonValue({ value: JSON.parse(normalizedSlice) as JsonValue });
    const originTree = parseJsonNumberOriginTree({ text: slice, start: 0 });
    const value = applyJsonSpecialNumberTree({ value: parsedValue, tree: originTree?.tree });
    const numberOrigin = applyJsonNumberOriginTree({ value, tree: originTree?.tree });
    return {
      kind: 'value',
      value,
      nextIndex: tokenEnd,
      tokenStart,
      tokenEnd,
      completionOffset,
      ...(numberOrigin === undefined ? {} : { numberOrigin }),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'error',
      message: `invalid JSON input near byte ${tokenStart}: ${message}`,
      nextIndex: tokenEndIsRecoveryBoundary
        ? tokenEnd
        : recoverErrorEnd({ offset: Math.max(tokenStart, tokenEnd - 1) }),
      tokenStart,
      tokenEnd,
      completionOffset: primitive ? completionOffset : tokenEnd - 1,
    };
  }
}

export function* iterateJsonSequence({
  text,
}: {
  text: string,
}): Generator<JsonSequenceEntry, void, undefined> {
  let index = 0;
  let lineNumber = 1;

  while (index < text.length) {
    while (index < text.length) {
      const char = text[index];
      if (char === undefined || !isWhitespace({ char })) break;
      if (char === '\n') lineNumber += 1;
      index += 1;
    }
    if (index >= text.length) return;

    const char = text[index];
    if (char === undefined) return;

    let end: number | undefined;
    switch (char) {
    case '"':
      end = scanStringEnd({ text, start: index });
      break;
    case '{':
    case '[':
      end = scanStructuredEnd({ text, start: index });
      break;
    default:
      end = scanPrimitiveEnd({ text, start: index });
      break;
    }

    if (end === undefined || end <= index) {
      yield {
        ok: false,
        message: `invalid JSON input near byte ${index}`,
        lineNumber,
      };
      return;
    }

    const slice = text.slice(index, end);
    let entryLineNumber = lineNumber;
    for (const character of slice) {
      if (character === '\n') entryLineNumber += 1;
    }
    try {
      const normalizedSlice = normalizeJqFiniteNumbersForJsonParse({ text: slice });
      const parsedValue = normalizeJsonValue({ value: JSON.parse(normalizedSlice) as JsonValue });
      const originTree = parseJsonNumberOriginTree({ text: slice, start: 0 });
      const value = applyJsonSpecialNumberTree({ value: parsedValue, tree: originTree?.tree });
      const numberOrigin = applyJsonNumberOriginTree({ value, tree: originTree?.tree });
      yield {
        ok: true,
        value,
        lineNumber: entryLineNumber,
        ...(numberOrigin === undefined ? {} : { numberOrigin }),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      yield {
        ok: false,
        message: `invalid JSON input near byte ${index}: ${message}`,
        lineNumber: entryLineNumber,
      };
      // The token boundary is known, so input? / try input can suppress this
      // one parse error and continue with the following JSON value, as jq does.
      lineNumber = entryLineNumber;
      index = end;
      continue;
    }

    lineNumber = entryLineNumber;
    index = end;
  }
}

export function parseJsonSequence({
  text,
}: {
  text: string,
}): { ok: true, values: JsonValue[] } | { ok: false, message: string } {
  const values: JsonValue[] = [];
  for (const entry of iterateJsonSequence({ text })) {
    if (!entry.ok) return entry;
    values.push(entry.value);
  }
  return { ok: true, values };
}

export function formatJsonOutput({
  value,
  compact,
  raw,
  join,
  asciiOnly,
  sortKeys,
  indentation,
  nullSeparator,
  numberOrigin,
}: {
  value: JsonValue,
  compact: boolean,
  raw: boolean,
  join: boolean,
  asciiOnly: boolean,
  sortKeys: boolean,
  indentation: number | '\t',
  nullSeparator: boolean,
  numberOrigin?: JqNumberOrigin,
}): string {
  const separator = nullSeparator ? '\0' : join ? '' : '\n';
  if (raw && typeof value === 'string') {
    return `${value}${separator}`;
  }

  return `${stringifyJson({
    value,
    indentation: compact ? undefined : indentation,
    sortKeys,
    asciiOnly,
    numberOrigin,
  })}${separator}`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
