import type { JsonValue } from './ast';

export type JsonObject = { [key: string]: JsonValue };

export function createJsonObject(): JsonObject {
  return Object.create(null) as JsonObject;
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

export function cloneJson({
  value,
}: {
  value: JsonValue,
}): JsonValue {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson({ value: item }));
  }

  switch (typeof value) {
  case 'boolean':
  case 'number':
  case 'string':
    return value;
  case 'object': {
    const clone = createJsonObject();
    for (const [key, nested] of Object.entries(value)) {
      defineJsonProperty({
        object: clone,
        key,
        value: cloneJson({ value: nested }),
      });
    }
    return clone;
  }
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled jq value: ${JSON.stringify(_ex)}`);
  }
  }
}

export function normalizeJsonValue({
  value,
}: {
  value: JsonValue,
}): JsonValue {
  return cloneJson({ value });
}

export function mergeJsonObjects({
  left,
  right,
}: {
  left: JsonObject,
  right: JsonObject,
}): JsonObject {
  const merged = createJsonObject();
  for (const [key, value] of Object.entries(left)) {
    defineJsonProperty({ object: merged, key, value });
  }
  for (const [key, value] of Object.entries(right)) {
    defineJsonProperty({ object: merged, key, value });
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

  const leftCodePoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightCodePoints = Array.from(right, (value) => value.codePointAt(0)!);
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const leftCodePoint = leftCodePoints[index]!;
    const rightCodePoint = rightCodePoints[index]!;
    if (leftCodePoint === rightCodePoint) continue;
    return leftCodePoint < rightCodePoint ? -1 : 1;
  }

  return leftCodePoints.length < rightCodePoints.length ? -1 : 1;
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
}: {
  left: JsonValue,
  right: JsonValue,
}): number {
  const leftRank = typeRank({ value: left });
  const rightRank = typeRank({ value: right });
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;

  if (left === null || right === null) return 0;
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    if (left === right) return 0;
    return left ? 1 : -1;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    if (Object.is(left, right) || left === right) return 0;
    if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : -1;
    if (Number.isNaN(right)) return 1;
    return left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return compareStrings({ left, right });
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const sharedLength = Math.min(left.length, right.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const compared = compareJsonValues({
        left: left[index]!,
        right: right[index]!,
      });
      if (compared !== 0) return compared;
    }
    if (left.length === right.length) return 0;
    return left.length < right.length ? -1 : 1;
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left).sort((a, b) => compareStrings({ left: a, right: b }));
    const rightKeys = Object.keys(right).sort((a, b) => compareStrings({ left: a, right: b }));
    const sharedLength = Math.min(leftKeys.length, rightKeys.length);

    for (let index = 0; index < sharedLength; index += 1) {
      const leftKey = leftKeys[index]!;
      const rightKey = rightKeys[index]!;
      const keyComparison = compareStrings({ left: leftKey, right: rightKey });
      if (keyComparison !== 0) return keyComparison;

      const valueComparison = compareJsonValues({
        left: left[leftKey]!,
        right: right[rightKey]!,
      });
      if (valueComparison !== 0) return valueComparison;
    }

    if (leftKeys.length === rightKeys.length) return 0;
    return leftKeys.length < rightKeys.length ? -1 : 1;
  }

  return 0;
}

export function jsonValuesEqual({
  left,
  right,
}: {
  left: JsonValue,
  right: JsonValue,
}): boolean {
  return compareJsonValues({ left, right }) === 0;
}

function sortJsonObjectKeys({
  value,
}: {
  value: JsonValue,
}): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonObjectKeys({ value: item }));
  }
  if (!isJsonObject(value)) return value;

  const sorted = createJsonObject();
  const keys = Object.keys(value).sort((a, b) => compareStrings({ left: a, right: b }));
  for (const key of keys) {
    defineJsonProperty({
      object: sorted,
      key,
      value: sortJsonObjectKeys({ value: value[key]! }),
    });
  }
  return sorted;
}

function escapeNonAscii({
  text,
}: {
  text: string,
}): string {
  let output = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      output += char;
      continue;
    }
    if (codePoint <= 0xffff) {
      output += `\\u${codePoint.toString(16).padStart(4, '0')}`;
      continue;
    }
    const adjusted = codePoint - 0x10000;
    const high = 0xd800 + (adjusted >> 10);
    const low = 0xdc00 + (adjusted & 0x3ff);
    output += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
  }
  return output;
}

export function stringifyJson({
  value,
  indentation,
  sortKeys,
  asciiOnly,
}: {
  value: JsonValue,
  indentation: number | '\t' | undefined,
  sortKeys: boolean,
  asciiOnly: boolean,
}): string {
  const normalized = sortKeys ? sortJsonObjectKeys({ value }) : value;
  const text = JSON.stringify(normalized, undefined, indentation);
  return asciiOnly ? escapeNonAscii({ text }) : text;
}
