import type { JsonValue, JqFilter, JqPath, JqPathSegment } from './ast';
import {
  cloneJson,
  createJsonObject,
  defineJsonProperty,
  isJsonObject,
} from './value';

export { cloneJson } from './value';

export function normalizeArrayIndex({
  array,
  index,
}: {
  array: JsonValue[],
  index: number,
}): number | undefined {
  if (!Number.isInteger(index)) return undefined;
  const normalized = index >= 0 ? index : array.length + index;
  if (normalized < 0 || normalized >= array.length) return undefined;
  return normalized;
}

export function extractJqPath({
  filter,
}: {
  filter: JqFilter,
}): JqPath | undefined {
  switch (filter.kind) {
  case 'identity':
    return { segments: [] };
  case 'field': {
    if (filter.optional) return undefined;
    const parent = extractJqPath({ filter: filter.input });
    if (parent === undefined) return undefined;
    return {
      segments: [...parent.segments, { kind: 'field', key: filter.key }],
    };
  }
  case 'index': {
    if (filter.optional) return undefined;
    const parent = extractJqPath({ filter: filter.input });
    if (parent === undefined) return undefined;
    return {
      segments: [...parent.segments, { kind: 'index', index: filter.index }],
    };
  }
  case 'slice':
    return undefined;
  default:
    return undefined;
  }
}

function shallowCloneObject({
  value,
}: {
  value: { [key: string]: JsonValue },
}): { [key: string]: JsonValue } {
  const clone = createJsonObject();
  for (const [key, nested] of Object.entries(value)) {
    defineJsonProperty({ object: clone, key, value: nested });
  }
  return clone;
}

function deleteAtPath({
  value,
  segments,
}: {
  value: JsonValue,
  segments: readonly JqPathSegment[],
}): { ok: true, value: JsonValue, changed: boolean } | { ok: false, message: string } {
  const [head, ...tail] = segments;
  if (head === undefined) {
    return { ok: true, value: null, changed: true };
  }

  const isLeaf = tail.length === 0;
  switch (head.kind) {
  case 'field': {
    if (!isJsonObject(value)) {
      return { ok: false, message: `cannot index field '${head.key}' on non-object` };
    }
    if (!Object.hasOwn(value, head.key)) {
      return { ok: true, value, changed: false };
    }

    const next = shallowCloneObject({ value });
    if (isLeaf) {
      delete next[head.key];
      return { ok: true, value: next, changed: true };
    }

    const nested = deleteAtPath({
      value: value[head.key]!,
      segments: tail,
    });
    if (!nested.ok) return nested;
    if (!nested.changed) return { ok: true, value, changed: false };
    defineJsonProperty({ object: next, key: head.key, value: nested.value });
    return { ok: true, value: next, changed: true };
  }
  case 'index': {
    if (!Array.isArray(value)) {
      return { ok: false, message: `cannot index [${head.index}] on non-array` };
    }
    const normalizedIndex = normalizeArrayIndex({ array: value, index: head.index });
    if (normalizedIndex === undefined) {
      return { ok: true, value, changed: false };
    }

    const next = value.slice();
    if (isLeaf) {
      next.splice(normalizedIndex, 1);
      return { ok: true, value: next, changed: true };
    }

    const nested = deleteAtPath({
      value: value[normalizedIndex]!,
      segments: tail,
    });
    if (!nested.ok) return nested;
    if (!nested.changed) return { ok: true, value, changed: false };
    next[normalizedIndex] = nested.value;
    return { ok: true, value: next, changed: true };
  }
  default: {
    const _ex: never = head;
    throw new Error(`Unhandled jq path segment: ${JSON.stringify(_ex)}`);
  }
  }
}

export function applyPathDeletion({
  root,
  path,
}: {
  root: JsonValue,
  path: JqPath,
}): { ok: true, value: JsonValue } | { ok: false, message: string } {
  const result = deleteAtPath({ value: root, segments: path.segments });
  if (!result.ok) return result;
  return { ok: true, value: result.value };
}

export function applyPathUpdate({
  root,
  path,
  update,
}: {
  root: JsonValue,
  path: JqPath,
  update: ({ currentValue }: {
    currentValue: JsonValue | undefined,
  }) => { ok: true, value: JsonValue } | { ok: false, message: string },
}): { ok: true, value: JsonValue } | { ok: false, message: string } {
  return updateAtPath({
    value: root,
    segments: path.segments,
    update,
  });
}

function updateAtPath({
  value,
  segments,
  update,
}: {
  value: JsonValue | undefined,
  segments: readonly JqPathSegment[],
  update: ({ currentValue }: {
    currentValue: JsonValue | undefined,
  }) => { ok: true, value: JsonValue } | { ok: false, message: string },
}): { ok: true, value: JsonValue } | { ok: false, message: string } {
  const [head, ...tail] = segments;
  if (head === undefined) {
    return update({ currentValue: value });
  }

  const isLeaf = tail.length === 0;
  switch (head.kind) {
  case 'field': {
    if (value !== undefined && value !== null && !isJsonObject(value)) {
      return { ok: false, message: `cannot index field '${head.key}' on non-object` };
    }

    const source = value !== undefined && isJsonObject(value) ? value : createJsonObject();
    const current = source[head.key];
    const nested = isLeaf
      ? update({ currentValue: current })
      : updateAtPath({ value: current, segments: tail, update });
    if (!nested.ok) return nested;

    const next = shallowCloneObject({ value: source });
    defineJsonProperty({ object: next, key: head.key, value: nested.value });
    return { ok: true, value: next };
  }
  case 'index': {
    if (!Array.isArray(value)) {
      return { ok: false, message: `cannot index [${head.index}] on non-array` };
    }
    if (!Number.isInteger(head.index)) {
      return { ok: false, message: `invalid array index ${head.index}` };
    }

    const normalizedIndex = head.index >= 0 ? head.index : value.length + head.index;
    if (normalizedIndex < 0) {
      return { ok: false, message: `invalid array index ${head.index}` };
    }

    const current = value[normalizedIndex];
    const nested = isLeaf
      ? update({ currentValue: current })
      : updateAtPath({ value: current, segments: tail, update });
    if (!nested.ok) return nested;

    const next = value.slice();
    while (next.length < normalizedIndex) next.push(null);
    next[normalizedIndex] = nested.value;
    return { ok: true, value: next };
  }
  default: {
    const _ex: never = head;
    throw new Error(`Unhandled jq path segment: ${JSON.stringify(_ex)}`);
  }
  }
}

export function clonePathValue({
  value,
}: {
  value: JsonValue,
}): JsonValue {
  return cloneJson({ value });
}
