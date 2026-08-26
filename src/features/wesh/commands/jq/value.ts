import type { JsonValue, JqBinaryOperator } from './ast';
import {
  compareJqNumberOrigins,
  copyJsonChildNumberOrigins,
  getJsonChildNumberOrigin,
  setJsonChildNumberOrigin,
  type JqNumberOrigin,
} from './number-origin';

export type JsonObject = { [key: string]: JsonValue };

const jqObjectKeyOrder = Symbol('jqObjectKeyOrder');
const jqObjectKnownKeys = Symbol('jqObjectKnownKeys');
type OrderedJsonObject = JsonObject & {
  [jqObjectKeyOrder]?: string[];
  [jqObjectKnownKeys]?: Set<string>;
};

export function createJsonObject(): JsonObject {
  const object = Object.create(null) as OrderedJsonObject;
  Object.defineProperty(object, jqObjectKeyOrder, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: [],
  });
  Object.defineProperty(object, jqObjectKnownKeys, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: new Set<string>(),
  });
  return object;
}

export function jsonObjectKeys({
  object,
}: {
  object: JsonObject,
}): string[] {
  const ordered = (object as OrderedJsonObject)[jqObjectKeyOrder];
  if (ordered === undefined) return Object.keys(object);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of ordered) {
    if (!seen.has(key) && Object.hasOwn(object, key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  for (const key of Object.keys(object)) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export function jsonObjectEntries({
  object,
}: {
  object: JsonObject,
}): [string, JsonValue][] {
  return jsonObjectKeys({ object }).map((key) => [key, object[key]!]);
}

export function jsonObjectValues({
  object,
}: {
  object: JsonObject,
}): JsonValue[] {
  return jsonObjectKeys({ object }).map((key) => object[key]!);
}

export function defineJsonProperty({
  object,
  key,
  value,
}: {
  object: JsonObject,
  key: string,
  value: JsonValue,
}): void {
  if (!Object.hasOwn(object, key)) {
    const ordered = (object as OrderedJsonObject)[jqObjectKeyOrder];
    if (ordered !== undefined) {
      const knownKeys = (object as OrderedJsonObject)[jqObjectKnownKeys];
      if (knownKeys === undefined || knownKeys.has(key)) {
        const staleIndex = ordered.indexOf(key);
        if (staleIndex >= 0) ordered.splice(staleIndex, 1);
      }
      ordered.push(key);
      knownKeys?.add(key);
    }
  }
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function describeJsonType({
  value,
}: {
  value: JsonValue,
}): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
  case 'boolean':
    return 'boolean';
  case 'number':
    return 'number';
  case 'string':
    return 'string';
  case 'object':
    return 'object';
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled jq value type: ${String(_ex)}`);
  }
  }
}

export function formatJqIndexError({
  container,
  index,
}: {
  container: JsonValue,
  index: JsonValue,
}): string {
  const indexDescription = typeof index === 'string'
    ? `string ${JSON.stringify(index)}`
    : describeJsonType({ value: index });
  return `Cannot index ${describeJsonType({ value: container })} with ${indexDescription}`;
}

export function formatJqObjectKeyError({
  key,
  numberOrigin,
}: {
  key: JsonValue,
  numberOrigin?: JqNumberOrigin,
}): string {
  return `Cannot use ${describeJsonType({ value: key })} (${stringifyJqDiagnosticPreview({
    value: key,
    numberOrigin,
  })}) as object key`;
}

const jqDiagnosticPreviewFullByteLimit = 14;
const jqDiagnosticPreviewPrefixByteLimit = 11;
const jqDiagnosticPreviewProbeByteLimit = jqDiagnosticPreviewFullByteLimit + 1;

class JqDiagnosticPreviewWriter {
  readonly #bytes = new Uint8Array(jqDiagnosticPreviewProbeByteLimit);
  #length = 0;

  get full(): boolean {
    return this.#length >= this.#bytes.length;
  }

  appendText({ text }: { text: string }): void {
    let offset = 0;
    while (offset < text.length && !this.full) {
      const codePoint = text.codePointAt(offset)!;
      this.#appendCodePoint({ codePoint });
      offset += codePoint > 0xffff ? 2 : 1;
    }
  }

  result(): string {
    const decoder = new TextDecoder();
    if (this.#length <= jqDiagnosticPreviewFullByteLimit) {
      return decoder.decode(this.#bytes.subarray(0, this.#length));
    }
    return `${decoder.decode(this.#bytes.subarray(0, jqDiagnosticPreviewPrefixByteLimit))}...`;
  }

  #appendCodePoint({ codePoint }: { codePoint: number }): void {
    if (codePoint <= 0x7f) {
      this.#appendByte({ value: codePoint });
      return;
    }
    if (codePoint <= 0x7ff) {
      this.#appendByte({ value: 0xc0 | (codePoint >> 6) });
      this.#appendByte({ value: 0x80 | (codePoint & 0x3f) });
      return;
    }
    if (codePoint <= 0xffff) {
      this.#appendByte({ value: 0xe0 | (codePoint >> 12) });
      this.#appendByte({ value: 0x80 | ((codePoint >> 6) & 0x3f) });
      this.#appendByte({ value: 0x80 | (codePoint & 0x3f) });
      return;
    }
    this.#appendByte({ value: 0xf0 | (codePoint >> 18) });
    this.#appendByte({ value: 0x80 | ((codePoint >> 12) & 0x3f) });
    this.#appendByte({ value: 0x80 | ((codePoint >> 6) & 0x3f) });
    this.#appendByte({ value: 0x80 | (codePoint & 0x3f) });
  }

  #appendByte({ value }: { value: number }): void {
    if (this.full) return;
    this.#bytes[this.#length] = value;
    this.#length += 1;
  }
}

function appendJqDiagnosticJsonString({
  writer,
  value,
}: {
  writer: JqDiagnosticPreviewWriter,
  value: string,
}): void {
  writer.appendText({ text: '"' });
  let offset = 0;
  while (offset < value.length && !writer.full) {
    const first = value.charCodeAt(offset);
    const escape = (() => {
      switch (first) {
      case 0x08:
        return '\\b';
      case 0x09:
        return '\\t';
      case 0x0a:
        return '\\n';
      case 0x0c:
        return '\\f';
      case 0x0d:
        return '\\r';
      case 0x22:
        return '\\"';
      case 0x5c:
        return '\\\\';
      case 0x7f:
        return '\\u007f';
      default:
        return first < 0x20 ? `\\u${first.toString(16).padStart(4, '0')}` : undefined;
      }
    })();
    if (escape !== undefined) {
      writer.appendText({ text: escape });
      offset += 1;
      continue;
    }
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(offset + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        writer.appendText({ text: value.slice(offset, offset + 2) });
        offset += 2;
        continue;
      }
      writer.appendText({ text: `\\u${first.toString(16).padStart(4, '0')}` });
      offset += 1;
      continue;
    }
    if (first >= 0xdc00 && first <= 0xdfff) {
      writer.appendText({ text: `\\u${first.toString(16).padStart(4, '0')}` });
      offset += 1;
      continue;
    }
    writer.appendText({ text: value[offset]! });
    offset += 1;
  }
  if (!writer.full) writer.appendText({ text: '"' });
}

interface JqDiagnosticObjectKeyCursor {
  readonly object: JsonObject;
  readonly ordered: readonly string[] | undefined;
  orderedIndex: number;
  fallbackKeys: string[] | undefined;
  fallbackIndex: number;
  readonly seen: Set<string>;
  emittedCount: number;
}

function createJqDiagnosticObjectKeyCursor({
  object,
}: {
  object: JsonObject,
}): JqDiagnosticObjectKeyCursor {
  return {
    object,
    ordered: (object as OrderedJsonObject)[jqObjectKeyOrder],
    orderedIndex: 0,
    fallbackKeys: undefined,
    fallbackIndex: 0,
    seen: new Set<string>(),
    emittedCount: 0,
  };
}

function nextJqDiagnosticObjectKey({
  cursor,
}: {
  cursor: JqDiagnosticObjectKeyCursor,
}): string | undefined {
  if (cursor.ordered !== undefined) {
    while (cursor.orderedIndex < cursor.ordered.length) {
      const key = cursor.ordered[cursor.orderedIndex]!;
      cursor.orderedIndex += 1;
      if (cursor.seen.has(key) || !Object.hasOwn(cursor.object, key)) continue;
      cursor.seen.add(key);
      cursor.emittedCount += 1;
      return key;
    }
  }
  cursor.fallbackKeys ??= Object.keys(cursor.object);
  while (cursor.fallbackIndex < cursor.fallbackKeys.length) {
    const key = cursor.fallbackKeys[cursor.fallbackIndex]!;
    cursor.fallbackIndex += 1;
    if (cursor.seen.has(key)) continue;
    cursor.seen.add(key);
    cursor.emittedCount += 1;
    return key;
  }
  return undefined;
}

function stringifyJqDiagnosticPreview({
  value,
  numberOrigin,
}: {
  value: JsonValue,
  numberOrigin?: JqNumberOrigin,
}): string {
  type PreviewTask =
    | { kind: 'value', value: JsonValue, numberOrigin?: JqNumberOrigin }
    | { kind: 'array', value: JsonValue[], index: number }
    | { kind: 'object', cursor: JqDiagnosticObjectKeyCursor };

  const writer = new JqDiagnosticPreviewWriter();
  const pending: PreviewTask[] = [{ kind: 'value', value, numberOrigin }];
  while (pending.length > 0 && !writer.full) {
    const task = pending.pop()!;
    switch (task.kind) {
    case 'array': {
      if (task.index >= task.value.length) {
        writer.appendText({ text: ']' });
        continue;
      }
      if (task.index > 0) writer.appendText({ text: ',' });
      pending.push({ kind: 'array', value: task.value, index: task.index + 1 });
      pending.push({
        kind: 'value',
        value: task.value[task.index]!,
        numberOrigin: getJsonChildNumberOrigin({ container: task.value, key: task.index }),
      });
      continue;
    }
    case 'object': {
      const key = nextJqDiagnosticObjectKey({ cursor: task.cursor });
      if (key === undefined) {
        writer.appendText({ text: '}' });
        continue;
      }
      if (task.cursor.emittedCount > 1) writer.appendText({ text: ',' });
      appendJqDiagnosticJsonString({ writer, value: key });
      writer.appendText({ text: ':' });
      pending.push({ kind: 'object', cursor: task.cursor });
      pending.push({
        kind: 'value',
        value: task.cursor.object[key]!,
        numberOrigin: getJsonChildNumberOrigin({ container: task.cursor.object, key }),
      });
      continue;
    }
    case 'value': {
      const nested = task.value;
      if (nested === null) {
        writer.appendText({ text: 'null' });
        continue;
      }
      switch (typeof nested) {
      case 'boolean':
        writer.appendText({ text: nested ? 'true' : 'false' });
        break;
      case 'number':
        writer.appendText({
          text: task.numberOrigin?.canonical ?? formatComputedJqNumber({ value: nested }),
        });
        break;
      case 'string':
        appendJqDiagnosticJsonString({ writer, value: nested });
        break;
      case 'object':
        if (Array.isArray(nested)) {
          writer.appendText({ text: '[' });
          if (nested.length === 0) {
            writer.appendText({ text: ']' });
          } else {
            pending.push({ kind: 'array', value: nested, index: 0 });
          }
          break;
        }
        writer.appendText({ text: '{' });
        pending.push({
          kind: 'object',
          cursor: createJqDiagnosticObjectKeyCursor({ object: nested }),
        });
        break;
      default: {
        const _ex: never = nested;
        throw new Error(`Unhandled jq diagnostic preview value: ${JSON.stringify(_ex)}`);
      }
      }
      continue;
    }
    default: {
      const _ex: never = task;
      throw new Error(`Unhandled jq diagnostic preview task: ${String(_ex)}`);
    }
    }
  }
  return writer.result();
}

export function formatJqArithmeticError({
  operator,
  left,
  right,
  leftOrigin,
  rightOrigin,
}: {
  operator: Extract<JqBinaryOperator, 'add' | 'sub' | 'mul' | 'div' | 'mod'>,
  left: JsonValue,
  right: JsonValue,
  leftOrigin?: JqNumberOrigin,
  rightOrigin?: JqNumberOrigin,
}): string {
  const operation = (() => {
    switch (operator) {
    case 'add':
      return 'added';
    case 'sub':
      return 'subtracted';
    case 'mul':
      return 'multiplied';
    case 'div':
      return 'divided';
    case 'mod':
      return 'divided (remainder)';
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled jq arithmetic operator: ${_ex}`);
    }
    }
  })();
  const describeOperand = ({
    value,
    numberOrigin,
  }: {
    value: JsonValue,
    numberOrigin: JqNumberOrigin | undefined,
  }): string => `${describeJsonType({ value })} (${stringifyJqDiagnosticPreview({
    value,
    numberOrigin,
  })})`;
  const zeroDivisor = (operator === 'div' || operator === 'mod')
    && typeof left === 'number'
    && typeof right === 'number'
    && right === 0;
  return `${describeOperand({ value: left, numberOrigin: leftOrigin })} and ${describeOperand({
    value: right,
    numberOrigin: rightOrigin,
  })} cannot be ${operation}${zeroDivisor ? ' because the divisor is zero' : ''}`;
}

export function cloneJson({
  value,
}: {
  value: JsonValue,
}): JsonValue {
  if (value === null || typeof value !== 'object') return value;

  type JsonContainer = JsonValue[] | JsonObject;
  const createContainer = ({ source }: { source: JsonValue[] | JsonObject }): JsonContainer => (
    Array.isArray(source) ? new Array<JsonValue>(source.length) : createJsonObject()
  );
  const root = createContainer({ source: value });
  const pending: { source: JsonValue[] | JsonObject, target: JsonContainer }[] = [
    { source: value, target: root },
  ];

  while (pending.length > 0) {
    const frame = pending.pop()!;
    copyJsonChildNumberOrigins({ source: frame.source, target: frame.target });
    if (Array.isArray(frame.source)) {
      const target = frame.target as JsonValue[];
      for (let index = 0; index < frame.source.length; index += 1) {
        const nested = frame.source[index]!;
        if (nested === null || typeof nested !== 'object') {
          target[index] = nested;
          continue;
        }
        const child = createContainer({ source: nested });
        target[index] = child;
        pending.push({ source: nested, target: child });
      }
      continue;
    }

    const target = frame.target as JsonObject;
    for (const [key, nested] of jsonObjectEntries({ object: frame.source })) {
      if (nested === null || typeof nested !== 'object') {
        defineJsonProperty({ object: target, key, value: nested });
        continue;
      }
      const child = createContainer({ source: nested });
      defineJsonProperty({ object: target, key, value: child });
      pending.push({ source: nested, target: child });
    }
  }

  return root;
}

export function normalizeJsonValue({
  value,
}: {
  value: JsonValue,
}): JsonValue {
  return cloneJson({ value });
}

export function toJqArithmeticNumber({
  value,
}: {
  value: number,
}): number {
  if (Number.isNaN(value)) return value;
  if (value >= Number.MAX_VALUE) return Number.POSITIVE_INFINITY;
  if (value <= -Number.MAX_VALUE) return Number.NEGATIVE_INFINITY;
  return value;
}

export function normalizeJqArithmeticResult({
  value,
}: {
  value: number,
}): number {
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_VALUE;
  if (value === Number.NEGATIVE_INFINITY) return -Number.MAX_VALUE;
  return value;
}

export function mergeJsonObjects({
  left,
  right,
}: {
  left: JsonObject,
  right: JsonObject,
}): JsonObject {
  const merged = createJsonObject();
  for (const [key, value] of jsonObjectEntries({ object: left })) {
    defineJsonProperty({ object: merged, key, value });
    setJsonChildNumberOrigin({
      container: merged,
      key,
      origin: getJsonChildNumberOrigin({ container: left, key }),
    });
  }
  for (const [key, value] of jsonObjectEntries({ object: right })) {
    defineJsonProperty({ object: merged, key, value });
    setJsonChildNumberOrigin({
      container: merged,
      key,
      origin: getJsonChildNumberOrigin({ container: right, key }),
    });
  }
  return merged;
}

function compareStrings({
  left,
  right,
}: {
  left: string,
  right: string,
}): number {
  if (left === right) return 0;

  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftCodePoint = left.codePointAt(leftOffset)!;
    const rightCodePoint = right.codePointAt(rightOffset)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
    leftOffset += leftCodePoint > 0xffff ? 2 : 1;
    rightOffset += rightCodePoint > 0xffff ? 2 : 1;
  }
  if (leftOffset === left.length && rightOffset === right.length) return 0;
  return leftOffset === left.length ? -1 : 1;
}

function typeRank({
  value,
}: {
  value: JsonValue,
}): number {
  if (value === null) return 0;
  if (value === false) return 1;
  if (value === true) return 2;
  if (typeof value === 'number') return 3;
  if (typeof value === 'string') return 4;
  if (Array.isArray(value)) return 5;
  return 6;
}

export function compareJsonValues({
  left,
  right,
  leftOrigin,
  rightOrigin,
}: {
  left: JsonValue,
  right: JsonValue,
  leftOrigin?: JqNumberOrigin,
  rightOrigin?: JqNumberOrigin,
}): number {
  type ComparisonFrame =
    | { kind: 'value', left: JsonValue, right: JsonValue, leftOrigin?: JqNumberOrigin, rightOrigin?: JqNumberOrigin }
    | {
      kind: 'array',
      left: JsonValue[],
      right: JsonValue[],
      index: number,
      sharedLength: number,
    }
    | {
      kind: 'object',
      left: JsonObject,
      right: JsonObject,
      leftKeys: string[],
      rightKeys: string[],
      index: number,
      sharedLength: number,
    };

  const pending: ComparisonFrame[] = [{ kind: 'value', left, right, leftOrigin, rightOrigin }];
  while (pending.length > 0) {
    const frame = pending.pop()!;
    switch (frame.kind) {
    case 'array': {
      if (frame.index >= frame.sharedLength) {
        if (frame.left.length !== frame.right.length) {
          return frame.left.length < frame.right.length ? -1 : 1;
        }
        continue;
      }
      pending.push({
        kind: 'array',
        left: frame.left,
        right: frame.right,
        index: frame.index + 1,
        sharedLength: frame.sharedLength,
      });
      pending.push({
        kind: 'value',
        left: frame.left[frame.index]!,
        right: frame.right[frame.index]!,
        leftOrigin: getJsonChildNumberOrigin({ container: frame.left, key: frame.index }),
        rightOrigin: getJsonChildNumberOrigin({ container: frame.right, key: frame.index }),
      });
      continue;
    }
    case 'object': {
      if (frame.index >= frame.sharedLength) {
        if (frame.leftKeys.length !== frame.rightKeys.length) {
          return frame.leftKeys.length < frame.rightKeys.length ? -1 : 1;
        }
        continue;
      }
      const leftKey = frame.leftKeys[frame.index]!;
      const rightKey = frame.rightKeys[frame.index]!;
      const keyComparison = compareStrings({ left: leftKey, right: rightKey });
      if (keyComparison !== 0) return keyComparison;
      pending.push({
        kind: 'object',
        left: frame.left,
        right: frame.right,
        leftKeys: frame.leftKeys,
        rightKeys: frame.rightKeys,
        index: frame.index + 1,
        sharedLength: frame.sharedLength,
      });
      pending.push({
        kind: 'value',
        left: frame.left[leftKey]!,
        right: frame.right[rightKey]!,
        leftOrigin: getJsonChildNumberOrigin({ container: frame.left, key: leftKey }),
        rightOrigin: getJsonChildNumberOrigin({ container: frame.right, key: rightKey }),
      });
      continue;
    }
    case 'value': {
      const leftRank = typeRank({ value: frame.left });
      const rightRank = typeRank({ value: frame.right });
      if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;

      if (frame.left === null || frame.right === null) continue;
      if (typeof frame.left === 'boolean' && typeof frame.right === 'boolean') {
        if (frame.left !== frame.right) return frame.left ? 1 : -1;
        continue;
      }
      if (typeof frame.left === 'number' && typeof frame.right === 'number') {
        if (frame.leftOrigin !== undefined && frame.rightOrigin !== undefined) {
          const compared = compareJqNumberOrigins({ left: frame.leftOrigin, right: frame.rightOrigin });
          if (compared !== 0) return compared;
          continue;
        }
        if (Object.is(frame.left, frame.right) || frame.left === frame.right) continue;
        if (Number.isNaN(frame.left)) return Number.isNaN(frame.right) ? 0 : -1;
        if (Number.isNaN(frame.right)) return 1;
        return frame.left < frame.right ? -1 : 1;
      }
      if (typeof frame.left === 'string' && typeof frame.right === 'string') {
        const compared = compareStrings({ left: frame.left, right: frame.right });
        if (compared !== 0) return compared;
        continue;
      }
      if (Array.isArray(frame.left) && Array.isArray(frame.right)) {
        pending.push({
          kind: 'array',
          left: frame.left,
          right: frame.right,
          index: 0,
          sharedLength: Math.min(frame.left.length, frame.right.length),
        });
        continue;
      }
      if (isJsonObject(frame.left) && isJsonObject(frame.right)) {
        const leftKeys = jsonObjectKeys({ object: frame.left }).sort((a, b) => compareStrings({ left: a, right: b }));
        const rightKeys = jsonObjectKeys({ object: frame.right }).sort((a, b) => compareStrings({ left: a, right: b }));
        pending.push({
          kind: 'object',
          left: frame.left,
          right: frame.right,
          leftKeys,
          rightKeys,
          index: 0,
          sharedLength: Math.min(leftKeys.length, rightKeys.length),
        });
      }
      continue;
    }
    default: {
      const _ex: never = frame;
      throw new Error(`Unhandled jq comparison frame: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }

  return 0;
}

export function jsonValuesEqual({
  left,
  right,
  leftOrigin,
  rightOrigin,
}: {
  left: JsonValue,
  right: JsonValue,
  leftOrigin?: JqNumberOrigin,
  rightOrigin?: JqNumberOrigin,
}): boolean {
  const pending: { readonly left: JsonValue, readonly right: JsonValue, readonly leftOrigin?: JqNumberOrigin, readonly rightOrigin?: JqNumberOrigin }[] = [{ left, right, leftOrigin, rightOrigin }];
  while (pending.length > 0) {
    const pair = pending.pop()!;
    if (typeof pair.left === 'number' && typeof pair.right === 'number') {
      if (pair.leftOrigin !== undefined && pair.rightOrigin !== undefined) {
        if (compareJqNumberOrigins({ left: pair.leftOrigin, right: pair.rightOrigin }) !== 0) return false;
        continue;
      }
      if (Number.isNaN(pair.left) || Number.isNaN(pair.right)) return false;
      if (Object.is(pair.left, pair.right) || pair.left === pair.right) continue;
      return false;
    }
    if (pair.left === pair.right) continue;
    if (Array.isArray(pair.left) && Array.isArray(pair.right)) {
      if (pair.left.length !== pair.right.length) return false;
      for (let index = 0; index < pair.left.length; index += 1) {
        pending.push({
          left: pair.left[index]!,
          right: pair.right[index]!,
          leftOrigin: getJsonChildNumberOrigin({ container: pair.left, key: index }),
          rightOrigin: getJsonChildNumberOrigin({ container: pair.right, key: index }),
        });
      }
      continue;
    }
    if (isJsonObject(pair.left) && isJsonObject(pair.right)) {
      const leftKeys = jsonObjectKeys({ object: pair.left });
      const rightKeys = jsonObjectKeys({ object: pair.right });
      if (leftKeys.length !== rightKeys.length) return false;
      for (const key of leftKeys) {
        if (!Object.hasOwn(pair.right, key)) return false;
        pending.push({
          left: pair.left[key]!,
          right: pair.right[key]!,
          leftOrigin: getJsonChildNumberOrigin({ container: pair.left, key }),
          rightOrigin: getJsonChildNumberOrigin({ container: pair.right, key }),
        });
      }
      continue;
    }
    return false;
  }
  return true;
}

function escapeNonAscii({
  text,
}: {
  text: string,
}): string {
  const chunks: string[] = [];
  let unchangedStart = 0;
  let offset = 0;
  while (offset < text.length) {
    const codePoint = text.codePointAt(offset)!;
    const width = codePoint > 0xffff ? 2 : 1;
    if (codePoint <= 0x7f) {
      offset += width;
      continue;
    }

    if (unchangedStart < offset) chunks.push(text.slice(unchangedStart, offset));
    if (codePoint <= 0xffff) {
      chunks.push(`\\u${codePoint.toString(16).padStart(4, '0')}`);
    } else {
      const adjusted = codePoint - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      chunks.push(`\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`);
    }
    offset += width;
    unchangedStart = offset;
  }
  if (unchangedStart === 0) return text;
  if (unchangedStart < text.length) chunks.push(text.slice(unchangedStart));
  return chunks.join('');
}

function stringifyJsonString({
  value,
}: {
  value: string,
}): string {
  return JSON.stringify(value).replaceAll('\u007f', '\\u007f');
}

function formatComputedJqNumber({ value }: { value: number }): string {
  if (!Number.isFinite(value)) return 'null';
  if (Object.is(value, -0)) return '-0';
  const magnitude = Math.abs(value);
  const requiresScientific = magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e18);
  const formatted = requiresScientific ? value.toExponential() : String(value);
  return formatted.replace(/e([+-])(\d)$/u, 'e$10$2');
}

function stringifyJsonValue({
  value,
  indentation,
  sortKeys,
  numberOrigin,
}: {
  value: JsonValue,
  indentation: string | undefined,
  sortKeys: boolean,
  numberOrigin?: JqNumberOrigin,
}): string {
  type StringifyTask =
    | { kind: 'value', value: JsonValue, depth: number, numberOrigin?: JqNumberOrigin }
    | { kind: 'array', value: JsonValue[], index: number, depth: number }
    | { kind: 'object', value: JsonObject, keys: string[], index: number, depth: number };

  const chunks: string[] = [];
  const pending: StringifyTask[] = [{ kind: 'value', value, depth: 0, numberOrigin }];
  while (pending.length > 0) {
    const task = pending.pop()!;
    switch (task.kind) {
    case 'array': {
      if (task.index >= task.value.length) {
        chunks.push(indentation === undefined ? ']' : `\n${indentation.repeat(task.depth)}]`);
        continue;
      }
      chunks.push(indentation === undefined
        ? task.index === 0 ? '' : ','
        : task.index === 0
          ? `\n${indentation.repeat(task.depth + 1)}`
          : `,\n${indentation.repeat(task.depth + 1)}`);
      pending.push({
        kind: 'array',
        value: task.value,
        index: task.index + 1,
        depth: task.depth,
      });
      pending.push({
        kind: 'value',
        value: task.value[task.index]!,
        depth: task.depth + 1,
        numberOrigin: getJsonChildNumberOrigin({ container: task.value, key: task.index }),
      });
      continue;
    }
    case 'object': {
      if (task.index >= task.keys.length) {
        chunks.push(indentation === undefined ? '}' : `\n${indentation.repeat(task.depth)}}`);
        continue;
      }
      const key = task.keys[task.index]!;
      chunks.push(indentation === undefined
        ? task.index === 0 ? '' : ','
        : task.index === 0
          ? `\n${indentation.repeat(task.depth + 1)}`
          : `,\n${indentation.repeat(task.depth + 1)}`);
      chunks.push(`${stringifyJsonString({ value: key })}${indentation === undefined ? ':' : ': '}`);
      pending.push({
        kind: 'object',
        value: task.value,
        keys: task.keys,
        index: task.index + 1,
        depth: task.depth,
      });
      pending.push({
        kind: 'value',
        value: task.value[key]!,
        depth: task.depth + 1,
        numberOrigin: getJsonChildNumberOrigin({ container: task.value, key }),
      });
      continue;
    }
    case 'value': {
      const nested = task.value;
      if (nested === null) {
        chunks.push('null');
        continue;
      }
      switch (typeof nested) {
      case 'boolean':
        chunks.push(nested ? 'true' : 'false');
        break;
      case 'number':
        chunks.push(task.numberOrigin?.canonical ?? formatComputedJqNumber({ value: nested }));
        break;
      case 'string':
        chunks.push(stringifyJsonString({ value: nested }));
        break;
      case 'object':
        if (Array.isArray(nested)) {
          if (nested.length === 0) {
            chunks.push('[]');
          } else {
            chunks.push('[');
            pending.push({ kind: 'array', value: nested, index: 0, depth: task.depth });
          }
          break;
        }
        {
          const keys = jsonObjectKeys({ object: nested });
          if (sortKeys) keys.sort((left, right) => compareStrings({ left, right }));
          if (keys.length === 0) {
            chunks.push('{}');
          } else {
            chunks.push('{');
            pending.push({ kind: 'object', value: nested, keys, index: 0, depth: task.depth });
          }
        }
        break;
      default: {
        const _ex: never = nested;
        throw new Error(`Unhandled jq value: ${JSON.stringify(_ex)}`);
      }
      }
      continue;
    }
    default: {
      const _ex: never = task;
      throw new Error(`Unhandled jq stringify task: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }
  return chunks.join('');
}

export function stringifyJson({
  value,
  indentation,
  sortKeys,
  asciiOnly,
  numberOrigin,
}: {
  value: JsonValue,
  indentation: number | '\t' | undefined,
  sortKeys: boolean,
  asciiOnly: boolean,
  numberOrigin?: JqNumberOrigin,
}): string {
  const indentationText = indentation === undefined
    ? undefined
    : indentation === '\t'
      ? '\t'
      : indentation === 0
        ? undefined
        : ' '.repeat(Math.min(10, Math.max(0, indentation)));
  const text = stringifyJsonValue({
    value,
    indentation: indentationText,
    sortKeys,
    numberOrigin,
  });
  return asciiOnly ? escapeNonAscii({ text }) : text;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
