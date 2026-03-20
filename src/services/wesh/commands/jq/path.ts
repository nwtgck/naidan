import type { JsonValue, JqFilter, JqPath, JqPathSegment } from './ast';

export function cloneJson({
  value,
}: {
  value: JsonValue;
}): JsonValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => cloneJson({ value: item }));
  switch (typeof value) {
  case 'boolean':
  case 'number':
  case 'string':
    return value;
  case 'object': {
    const clone: { [key: string]: JsonValue } = {};
    for (const [key, nested] of Object.entries(value)) {
      clone[key] = cloneJson({ value: nested });
    }
    return clone;
  }
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled jq value: ${JSON.stringify(_ex)}`);
  }
  }
}

export function normalizeArrayIndex({
  array,
  index,
}: {
  array: JsonValue[];
  index: number;
}): number | undefined {
  if (!Number.isInteger(index)) return undefined;
  const normalized = index >= 0 ? index : array.length + index;
  if (normalized < 0 || normalized >= array.length) return undefined;
  return normalized;
}

export function extractJqPath({
  filter,
}: {
  filter: JqFilter;
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

export function applyPathDeletion({
  root,
  path,
}: {
  root: JsonValue;
  path: JqPath;
}): { ok: true; value: JsonValue } | { ok: false; message: string } {
  if (path.segments.length === 0) {
    return { ok: true, value: null };
  }

  const nextRoot = cloneJson({ value: root });
  const result = deleteFromPath({
    container: nextRoot,
    segments: path.segments,
  });
  if (!result.ok) return result;
  return { ok: true, value: nextRoot };
}

function deleteFromPath({
  container,
  segments,
}: {
  container: JsonValue;
  segments: JqPathSegment[];
}): { ok: true } | { ok: false; message: string } {
  const [head, ...tail] = segments;
  if (head === undefined) {
    return { ok: false, message: 'empty deletion path' };
  }

  const isLeaf = tail.length === 0;
  switch (head.kind) {
  case 'field': {
    if (container === null || Array.isArray(container) || typeof container !== 'object') {
      return { ok: false, message: `cannot index field '${head.key}' on non-object` };
    }

    if (isLeaf) {
      delete container[head.key];
      return { ok: true };
    }

    const existing = container[head.key];
    if (existing === undefined) {
      return { ok: true };
    }

    return deleteFromPath({
      container: existing,
      segments: tail,
    });
  }
  case 'index': {
    if (!Array.isArray(container)) {
      return { ok: false, message: `cannot index [${head.index}] on non-array` };
    }

    const normalizedIndex = normalizeArrayIndex({
      array: container,
      index: head.index,
    });
    if (normalizedIndex === undefined) {
      return { ok: true };
    }

    if (isLeaf) {
      container.splice(normalizedIndex, 1);
      return { ok: true };
    }

    const existing = container[normalizedIndex];
    if (existing === undefined) {
      return { ok: true };
    }

    return deleteFromPath({
      container: existing,
      segments: tail,
    });
  }
  default: {
    const _ex: never = head;
    throw new Error(`Unhandled jq path segment: ${JSON.stringify(_ex)}`);
  }
  }
}
