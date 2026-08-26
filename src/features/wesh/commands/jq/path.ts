import type { JsonValue, JqFilter, JqPath, JqPathExpression, JqPathSegment } from './ast';
import { JQ_MAX_MATERIALIZED_VALUE_LENGTH } from './limits';
import {
  copyJsonChildNumberOrigins,
  getJsonChildNumberOrigin,
  moveJsonArrayNumberOrigins,
  setJsonChildNumberOrigin,
} from './number-origin';
import {
  createJsonObject,
  defineJsonProperty,
  formatJqIndexError,
  isJsonObject,
  jsonObjectEntries,
  jsonObjectKeys,
  type JsonObject,
} from './value';

export { cloneJson } from './value';

export function normalizeArrayIndex({
  array,
  index,
}: {
  array: JsonValue[],
  index: number,
}): number | undefined {
  if (!Number.isFinite(index)) return undefined;
  const integerIndex = Math.trunc(index);
  const normalized = integerIndex >= 0 ? integerIndex : array.length + integerIndex;
  if (normalized < 0 || normalized >= array.length) return undefined;
  return normalized;
}

function normalizeSliceRange({
  length,
  start,
  end,
}: {
  length: number,
  start: number | undefined,
  end: number | undefined,
}): { start: number, end: number } {
  const normalize = ({ bound, fallback }: {
    bound: number | undefined,
    fallback: 0 | 'length',
  }): number => {
    const raw = bound ?? (fallback === 'length' ? length : 0);
    const adjusted = raw < 0 ? length + raw : raw;
    return Math.min(Math.max(Math.trunc(adjusted), 0), length);
  };
  return {
    start: normalize({ bound: start, fallback: 0 }),
    end: normalize({ bound: end, fallback: 'length' }),
  };
}

function replaceArraySlice({
  source,
  start,
  end,
  replacement,
}: {
  source: readonly JsonValue[],
  start: number,
  end: number,
  replacement: readonly JsonValue[],
}): { ok: true, value: JsonValue[] } | { ok: false, message: string } {
  const retainedSuffixLength = source.length - end;
  const resultLength = start + replacement.length + retainedSuffixLength;
  if (resultLength > JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
    return {
      ok: false,
      message: `array materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
    };
  }

  const result = new Array<JsonValue>(resultLength);
  let outputIndex = 0;
  for (let index = 0; index < start; index += 1) {
    result[outputIndex] = source[index]!;
    setJsonChildNumberOrigin({
      container: result,
      key: outputIndex,
      origin: getJsonChildNumberOrigin({ container: source as JsonValue[], key: index }),
    });
    outputIndex += 1;
  }
  for (let index = 0; index < replacement.length; index += 1) {
    result[outputIndex] = replacement[index]!;
    setJsonChildNumberOrigin({
      container: result,
      key: outputIndex,
      origin: getJsonChildNumberOrigin({ container: replacement as JsonValue[], key: index }),
    });
    outputIndex += 1;
  }
  for (let index = end; index < source.length; index += 1) {
    result[outputIndex] = source[index]!;
    setJsonChildNumberOrigin({
      container: result,
      key: outputIndex,
      origin: getJsonChildNumberOrigin({ container: source as JsonValue[], key: index }),
    });
    outputIndex += 1;
  }
  return { ok: true, value: result };
}

type JqPathReadResult =
  | { ok: true, value: JsonValue | undefined, skipped: boolean, numberOrigin?: import('./number-origin').JqNumberOrigin }
  | { ok: false, message: string };

function readJqPathSegmentValue({
  current,
  segment,
}: {
  current: JsonValue | undefined,
  segment: JqPathSegment,
}): JqPathReadResult {
  switch (segment.kind) {
  case 'field':
    if (current === undefined || current === null) {
      return { ok: true, value: undefined, skipped: false };
    }
    if (!isJsonObject(current)) {
      return segment.optional
        ? { ok: true, value: undefined, skipped: true }
        : { ok: false, message: formatJqIndexError({ container: current, index: segment.key }) };
    }
    return {
      ok: true,
      value: current[segment.key],
      skipped: false,
      numberOrigin: typeof current[segment.key] === 'number'
        ? getJsonChildNumberOrigin({ container: current, key: segment.key })
        : undefined,
    };
  case 'index': {
    if (current === undefined || current === null) {
      return { ok: true, value: undefined, skipped: false };
    }
    if (!Array.isArray(current)) {
      return segment.optional
        ? { ok: true, value: undefined, skipped: true }
        : { ok: false, message: formatJqIndexError({ container: current, index: segment.index }) };
    }
    const normalized = normalizeArrayIndex({ array: current, index: segment.index });
    return {
      ok: true,
      value: normalized === undefined ? undefined : current[normalized],
      skipped: false,
      numberOrigin: normalized !== undefined && typeof current[normalized] === 'number'
        ? getJsonChildNumberOrigin({ container: current, key: normalized })
        : undefined,
    };
  }
  case 'slice': {
    if (current === undefined || current === null) {
      return { ok: true, value: undefined, skipped: false };
    }
    if (!Array.isArray(current) && typeof current !== 'string') {
      return segment.optional
        ? { ok: true, value: undefined, skipped: true }
        : { ok: false, message: 'cannot slice non-array/string' };
    }
    const range = normalizeSliceRange({
      length: current.length,
      start: segment.start,
      end: segment.end,
    });
    return {
      ok: true,
      value: (() => {
        const sliced = current.slice(range.start, range.end) as JsonValue;
        if (Array.isArray(current) && Array.isArray(sliced)) {
          moveJsonArrayNumberOrigins({
            source: current,
            target: sliced,
            sourceStart: range.start,
            sourceEnd: range.end,
          });
        }
        return sliced;
      })(),
      skipped: false,
    };
  }
  default: {
    const _ex: never = segment;
    throw new Error(`Unhandled jq path segment: ${JSON.stringify(_ex)}`);
  }
  }
}

export function readJqPathValue({
  root,
  path,
}: {
  root: JsonValue,
  path: JqPath,
}): JqPathReadResult {
  let current: JsonValue | undefined = root;
  let numberOrigin: import('./number-origin').JqNumberOrigin | undefined;

  for (const segment of path.segments) {
    const result = readJqPathSegmentValue({ current, segment });
    if (!result.ok || result.skipped) return result;
    current = result.value;
    numberOrigin = result.numberOrigin;
  }

  return { ok: true, value: current, skipped: false, numberOrigin };
}

type MaterializedPathState = {
  readonly parent: MaterializedPathState | undefined,
  readonly basePath: JqPath | undefined,
  readonly segment: JqPathSegment | undefined,
  readonly depth: number,
  resolution: JqPathReadResult | undefined,
};

type PathMaterializationResult =
  | { ok: true, states: MaterializedPathState[] }
  | { ok: false, message: string };

type PathMaterializationFrame =
  | { kind: 'evaluate', expression: JqPathExpression }
  | { kind: 'append', segment: JqPathSegment }
  | { kind: 'dynamic_index', index: JqFilter, optional: boolean }
  | {
    kind: 'dynamic_slice',
    start: JqFilter | undefined,
    end: JqFilter | undefined,
    optional: boolean,
  }
  | { kind: 'iterate', optional: boolean }
  | {
    kind: 'sequence_continue',
    items: readonly JqPathExpression[],
    nextIndex: number,
    states: MaterializedPathState[],
  };

function createMaterializedPathState({
  path,
}: {
  path: JqPath,
}): MaterializedPathState {
  return {
    parent: undefined,
    basePath: path,
    segment: undefined,
    depth: 0,
    resolution: undefined,
  };
}

function extendMaterializedPathState({
  parent,
  segment,
}: {
  parent: MaterializedPathState,
  segment: JqPathSegment,
}): MaterializedPathState {
  return {
    parent,
    basePath: undefined,
    segment,
    depth: parent.depth + 1,
    resolution: undefined,
  };
}

function resolveMaterializedPathState({
  root,
  state,
}: {
  root: JsonValue,
  state: MaterializedPathState,
}): JqPathReadResult {
  const unresolved: MaterializedPathState[] = [];
  let cursor = state;
  while (cursor.resolution === undefined && cursor.parent !== undefined) {
    unresolved.push(cursor);
    cursor = cursor.parent;
  }

  let result = cursor.resolution;
  if (result === undefined) {
    if (cursor.basePath === undefined) {
      throw new Error('jq materialized path state is missing its base path');
    }
    result = readJqPathValue({ root, path: cursor.basePath });
    cursor.resolution = result;
  }

  for (let index = unresolved.length - 1; index >= 0; index -= 1) {
    const child = unresolved[index]!;
    if (!result.ok || result.skipped) {
      child.resolution = result;
      continue;
    }
    if (child.segment === undefined) {
      throw new Error('jq materialized path state is missing its segment');
    }
    result = readJqPathSegmentValue({ current: result.value, segment: child.segment });
    child.resolution = result;
  }

  return result;
}

function flattenMaterializedPathState({
  state,
}: {
  state: MaterializedPathState,
}): JqPath {
  let baseState = state;
  while (baseState.parent !== undefined) baseState = baseState.parent;
  if (baseState.basePath === undefined) {
    throw new Error('jq materialized path state is missing its base path');
  }

  const baseSegments = baseState.basePath.segments;
  const segments = new Array<JqPathSegment>(baseSegments.length + state.depth);
  for (let index = 0; index < baseSegments.length; index += 1) {
    segments[index] = baseSegments[index]!;
  }

  let outputIndex = segments.length - 1;
  let cursor = state;
  while (cursor.parent !== undefined) {
    if (cursor.segment === undefined) {
      throw new Error('jq materialized path state is missing its segment');
    }
    segments[outputIndex] = cursor.segment;
    outputIndex -= 1;
    cursor = cursor.parent;
  }
  return { segments };
}

function flattenPathExpressionSequence({
  expression,
}: {
  expression: JqPathExpression,
}): JqPathExpression[] {
  const pending: JqPathExpression[] = [expression];
  const items: JqPathExpression[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    switch (current.kind) {
    case 'sequence':
      for (let index = current.items.length - 1; index >= 0; index -= 1) {
        pending.push(current.items[index]!);
      }
      break;
    case 'path':
    case 'append':
    case 'dynamic_index':
    case 'dynamic_slice':
    case 'iterate':
      items.push(current);
      break;
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled jq path expression: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return items;
}

function appendMaterializedPathStates({
  target,
  source,
}: {
  target: MaterializedPathState[],
  source: readonly MaterializedPathState[],
}): boolean {
  if (source.length > JQ_MAX_MATERIALIZED_VALUE_LENGTH - target.length) return false;
  for (const state of source) target.push(state);
  return true;
}

export function materializeJqPathExpression({
  root,
  expression,
  evaluateDynamicIndex,
}: {
  root: JsonValue,
  expression: JqPathExpression,
  evaluateDynamicIndex: ({ filter, input }: {
    filter: JqFilter,
    input: JsonValue,
  }) => { ok: true, outputs: JsonValue[] } | { ok: false, message: string },
}): { ok: true, paths: JqPath[] } | { ok: false, message: string } {
  const frames: PathMaterializationFrame[] = [{ kind: 'evaluate', expression }];
  const results: PathMaterializationResult[] = [];

  while (frames.length > 0) {
    const frame = frames.pop()!;
    switch (frame.kind) {
    case 'evaluate': {
      const current = frame.expression;
      switch (current.kind) {
      case 'path':
        results.push({ ok: true, states: [createMaterializedPathState({ path: current.path })] });
        break;
      case 'sequence': {
        const items = flattenPathExpressionSequence({ expression: current });
        if (items.length === 0) {
          results.push({ ok: true, states: [] });
          break;
        }
        frames.push({
          kind: 'sequence_continue',
          items,
          nextIndex: 1,
          states: [],
        });
        frames.push({ kind: 'evaluate', expression: items[0]! });
        break;
      }
      case 'append':
        frames.push({ kind: 'append', segment: current.segment });
        frames.push({ kind: 'evaluate', expression: current.parent });
        break;
      case 'dynamic_index':
        frames.push({ kind: 'dynamic_index', index: current.index, optional: current.optional });
        frames.push({ kind: 'evaluate', expression: current.parent });
        break;
      case 'dynamic_slice':
        frames.push({
          kind: 'dynamic_slice',
          start: current.start,
          end: current.end,
          optional: current.optional,
        });
        frames.push({ kind: 'evaluate', expression: current.parent });
        break;
      case 'iterate':
        frames.push({ kind: 'iterate', optional: current.optional });
        frames.push({ kind: 'evaluate', expression: current.parent });
        break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled jq path expression: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'sequence_continue': {
      const itemResult = results.pop();
      if (itemResult === undefined) throw new Error('jq path materialization result stack is empty');
      if (!itemResult.ok) {
        results.push(itemResult);
        break;
      }
      if (!appendMaterializedPathStates({ target: frame.states, source: itemResult.states })) {
        results.push({
          ok: false,
          message: `path materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
        });
        break;
      }
      if (frame.nextIndex >= frame.items.length) {
        results.push({ ok: true, states: frame.states });
        break;
      }
      frames.push({
        kind: 'sequence_continue',
        items: frame.items,
        nextIndex: frame.nextIndex + 1,
        states: frame.states,
      });
      frames.push({ kind: 'evaluate', expression: frame.items[frame.nextIndex]! });
      break;
    }
    case 'append': {
      const parentResult = results.pop();
      if (parentResult === undefined) throw new Error('jq path materialization result stack is empty');
      if (!parentResult.ok) {
        results.push(parentResult);
        break;
      }
      const states = new Array<MaterializedPathState>(parentResult.states.length);
      for (let index = 0; index < parentResult.states.length; index += 1) {
        states[index] = extendMaterializedPathState({
          parent: parentResult.states[index]!,
          segment: frame.segment,
        });
      }
      results.push({ ok: true, states });
      break;
    }
    case 'dynamic_index': {
      const parentResult = results.pop();
      if (parentResult === undefined) throw new Error('jq path materialization result stack is empty');
      if (!parentResult.ok) {
        results.push(parentResult);
        break;
      }
      const indexes = evaluateDynamicIndex({ filter: frame.index, input: root });
      if (!indexes.ok) {
        results.push(indexes);
        break;
      }
      const states: MaterializedPathState[] = [];
      let failedMessage: string | undefined;
      parentLoop: for (const parentState of parentResult.states) {
        const parent = resolveMaterializedPathState({ root, state: parentState });
        if (!parent.ok) {
          failedMessage = parent.message;
          break;
        }
        if (parent.skipped) continue;
        const parentValue = parent.value;
        for (const index of indexes.outputs) {
          let segment: JqPathSegment | undefined;
          if (
            (parentValue === undefined || parentValue === null)
            && typeof index === 'number'
            && Number.isFinite(index)
          ) {
            segment = { kind: 'index', index: Math.trunc(index), optional: frame.optional };
          } else if (
            (parentValue === undefined || parentValue === null)
            && typeof index === 'string'
          ) {
            segment = { kind: 'field', key: index, optional: frame.optional };
          } else if (
            Array.isArray(parentValue)
            && typeof index === 'number'
            && Number.isFinite(index)
          ) {
            segment = { kind: 'index', index: Math.trunc(index), optional: frame.optional };
          } else if (
            parentValue !== undefined
            && isJsonObject(parentValue)
            && typeof index === 'string'
          ) {
            segment = { kind: 'field', key: index, optional: frame.optional };
          } else if (!frame.optional) {
            failedMessage = formatJqIndexError({ container: parentValue ?? null, index });
            break parentLoop;
          }
          if (segment !== undefined) {
            states.push(extendMaterializedPathState({ parent: parentState, segment }));
          }
        }
      }
      results.push(failedMessage === undefined
        ? { ok: true, states }
        : { ok: false, message: failedMessage });
      break;
    }
    case 'dynamic_slice': {
      const parentResult = results.pop();
      if (parentResult === undefined) throw new Error('jq path materialization result stack is empty');
      if (!parentResult.ok) {
        results.push(parentResult);
        break;
      }
      const evaluateBound = ({
        filter,
      }: {
        filter: JqFilter | undefined,
      }): { ok: true, bounds: (number | undefined)[] } | { ok: false, message: string } => {
        if (filter === undefined) return { ok: true, bounds: [undefined] };
        const evaluated = evaluateDynamicIndex({ filter, input: root });
        if (!evaluated.ok) return evaluated;
        const bounds: (number | undefined)[] = [];
        for (const output of evaluated.outputs) {
          if (output === null) {
            bounds.push(undefined);
          } else if (typeof output === 'number') {
            bounds.push(output);
          } else {
            return { ok: false, message: 'Array/string slice indices must be integers' };
          }
        }
        return { ok: true, bounds };
      };
      const starts = evaluateBound({ filter: frame.start });
      if (!starts.ok) {
        results.push(starts);
        break;
      }
      const ends = evaluateBound({ filter: frame.end });
      if (!ends.ok) {
        results.push(ends);
        break;
      }
      const states: MaterializedPathState[] = [];
      let failedMessage: string | undefined;
      for (const parentState of parentResult.states) {
        const parent = resolveMaterializedPathState({ root, state: parentState });
        if (!parent.ok) {
          failedMessage = parent.message;
          break;
        }
        if (parent.skipped) continue;
        if (
          parent.value !== undefined
          && parent.value !== null
          && !Array.isArray(parent.value)
          && typeof parent.value !== 'string'
        ) {
          if (frame.optional) continue;
          failedMessage = 'cannot slice non-array/string';
          break;
        }
        for (const start of starts.bounds) {
          for (const end of ends.bounds) {
            states.push(extendMaterializedPathState({
              parent: parentState,
              segment: { kind: 'slice', start, end, optional: frame.optional },
            }));
          }
        }
      }
      results.push(failedMessage === undefined
        ? { ok: true, states }
        : { ok: false, message: failedMessage });
      break;
    }
    case 'iterate': {
      const parentResult = results.pop();
      if (parentResult === undefined) throw new Error('jq path materialization result stack is empty');
      if (!parentResult.ok) {
        results.push(parentResult);
        break;
      }
      const states: MaterializedPathState[] = [];
      let failedMessage: string | undefined;
      for (const parentState of parentResult.states) {
        const parent = resolveMaterializedPathState({ root, state: parentState });
        if (!parent.ok) {
          failedMessage = parent.message;
          break;
        }
        if (parent.skipped) continue;
        if (Array.isArray(parent.value)) {
          for (let index = 0; index < parent.value.length; index += 1) {
            states.push(extendMaterializedPathState({
              parent: parentState,
              segment: { kind: 'index', index, optional: false },
            }));
          }
          continue;
        }
        if (parent.value !== undefined && isJsonObject(parent.value)) {
          for (const key of jsonObjectKeys({ object: parent.value })) {
            states.push(extendMaterializedPathState({
              parent: parentState,
              segment: { kind: 'field', key, optional: false },
            }));
          }
          continue;
        }
        if (!frame.optional) {
          failedMessage = 'cannot iterate over non-array/object';
          break;
        }
      }
      results.push(failedMessage === undefined
        ? { ok: true, states }
        : { ok: false, message: failedMessage });
      break;
    }
    default: {
      const _ex: never = frame;
      throw new Error(`Unhandled jq path materialization frame: ${JSON.stringify(_ex)}`);
    }
    }
  }

  if (results.length !== 1) {
    throw new Error(`jq path materialization produced ${results.length} result frames`);
  }
  const result = results[0]!;
  if (!result.ok) return result;
  const paths = new Array<JqPath>(result.states.length);
  for (let index = 0; index < result.states.length; index += 1) {
    paths[index] = flattenMaterializedPathState({ state: result.states[index]! });
  }
  return { ok: true, paths };
}

export function extractJqPath({
  filter,
}: {
  filter: JqFilter,
}): JqPath | undefined {
  const reversedSegments: JqPathSegment[] = [];
  let current = filter;

  while (true) {
    switch (current.kind) {
    case 'identity':
      reversedSegments.reverse();
      return { segments: reversedSegments };
    case 'field':
      if (current.optional) return undefined;
      reversedSegments.push({ kind: 'field', key: current.key, optional: false });
      current = current.input;
      break;
    case 'index':
      if (current.optional) return undefined;
      reversedSegments.push({ kind: 'index', index: current.index, optional: false });
      current = current.input;
      break;
    case 'slice':
      return undefined;
    default:
      return undefined;
    }
  }
}

function shallowCloneObject({
  value,
}: {
  value: { [key: string]: JsonValue },
}): { [key: string]: JsonValue } {
  const clone = createJsonObject();
  for (const [key, nested] of jsonObjectEntries({ object: value })) {
    defineJsonProperty({ object: clone, key, value: nested });
  }
  copyJsonChildNumberOrigins({ source: value, target: clone });
  return clone;
}

type JqPathDeletionResult =
  | { ok: true, value: JsonValue, changed: boolean }
  | { ok: false, message: string };

type JqPathDeletionFrame =
  | {
      kind: 'field',
      source: { [key: string]: JsonValue },
      key: string,
    }
  | {
      kind: 'index',
      source: JsonValue[],
      normalizedIndex: number,
    }
  | {
      kind: 'slice',
      source: JsonValue[],
      start: number,
      end: number,
    };

function deleteAtPath({
  value,
  segments,
}: {
  value: JsonValue,
  segments: readonly JqPathSegment[],
}): JqPathDeletionResult {
  if (segments.length === 0) {
    return { ok: true, value: null, changed: true };
  }

  const originalRoot = value;
  const frames: JqPathDeletionFrame[] = [];
  let currentValue = value;
  let nested: JqPathDeletionResult | undefined;

  traversal: for (let offset = 0; offset < segments.length; offset += 1) {
    if (currentValue === null) {
      return { ok: true, value: originalRoot, changed: false };
    }

    const segment = segments[offset]!;
    const isLeaf = offset + 1 === segments.length;
    switch (segment.kind) {
    case 'field': {
      if (!isJsonObject(currentValue)) {
        return segment.optional
          ? { ok: true, value: originalRoot, changed: false }
          : {
            ok: false,
            message: Array.isArray(currentValue)
              ? 'Cannot delete string element of array'
              : formatJqIndexError({
                container: currentValue,
                index: segment.key,
              }),
          };
      }
      if (!Object.hasOwn(currentValue, segment.key)) {
        return { ok: true, value: originalRoot, changed: false };
      }

      if (isLeaf) {
        const next = shallowCloneObject({ value: currentValue });
        delete next[segment.key];
        nested = { ok: true, value: next, changed: true };
        break traversal;
      }

      frames.push({
        kind: 'field',
        source: currentValue,
        key: segment.key,
      });
      currentValue = currentValue[segment.key]!;
      break;
    }
    case 'index': {
      if (!Array.isArray(currentValue)) {
        return segment.optional
          ? { ok: true, value: originalRoot, changed: false }
          : {
            ok: false,
            message: formatJqIndexError({
              container: currentValue,
              index: segment.index,
            }),
          };
      }
      const normalizedIndex = normalizeArrayIndex({
        array: currentValue,
        index: segment.index,
      });
      if (normalizedIndex === undefined) {
        return { ok: true, value: originalRoot, changed: false };
      }

      if (isLeaf) {
        const next = currentValue.slice();
        copyJsonChildNumberOrigins({ source: currentValue, target: next });
        next.splice(normalizedIndex, 1);
        for (let index = normalizedIndex; index < next.length; index += 1) {
          setJsonChildNumberOrigin({
            container: next,
            key: index,
            origin: getJsonChildNumberOrigin({ container: currentValue, key: index + 1 }),
          });
        }
        setJsonChildNumberOrigin({ container: next, key: next.length, origin: undefined });
        nested = { ok: true, value: next, changed: true };
        break traversal;
      }

      frames.push({
        kind: 'index',
        source: currentValue,
        normalizedIndex,
      });
      currentValue = currentValue[normalizedIndex]!;
      break;
    }
    case 'slice': {
      if (typeof currentValue === 'string') {
        return { ok: false, message: 'Cannot delete fields from string' };
      }
      if (!Array.isArray(currentValue)) {
        return segment.optional
          ? { ok: true, value: originalRoot, changed: false }
          : { ok: false, message: 'cannot slice non-array' };
      }

      const range = normalizeSliceRange({
        length: currentValue.length,
        start: segment.start,
        end: segment.end,
      });
      if (isLeaf) {
        if (range.end <= range.start) {
          return { ok: true, value: originalRoot, changed: false };
        }
        const next = currentValue.slice();
        copyJsonChildNumberOrigins({ source: currentValue, target: next });
        next.splice(range.start, range.end - range.start);
        for (let index = range.start; index < next.length; index += 1) {
          setJsonChildNumberOrigin({
            container: next,
            key: index,
            origin: getJsonChildNumberOrigin({
              container: currentValue,
              key: index + (range.end - range.start),
            }),
          });
        }
        for (let index = next.length; index < currentValue.length; index += 1) {
          setJsonChildNumberOrigin({ container: next, key: index, origin: undefined });
        }
        nested = { ok: true, value: next, changed: true };
        break traversal;
      }

      frames.push({
        kind: 'slice',
        source: currentValue,
        start: range.start,
        end: range.end,
      });
      currentValue = currentValue.slice(range.start, range.end);
      break;
    }
    default: {
      const _ex: never = segment;
      throw new Error(`Unhandled jq path segment: ${JSON.stringify(_ex)}`);
    }
    }
  }

  if (nested === undefined) {
    throw new Error('jq path deletion completed without a leaf result');
  }
  if (!nested.ok) return nested;

  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]!;
    switch (frame.kind) {
    case 'field': {
      const next = shallowCloneObject({ value: frame.source });
      defineJsonProperty({ object: next, key: frame.key, value: nested.value });
      nested = { ok: true, value: next, changed: true };
      break;
    }
    case 'index': {
      const next = frame.source.slice();
      copyJsonChildNumberOrigins({ source: frame.source, target: next });
      next[frame.normalizedIndex] = nested.value;
      nested = { ok: true, value: next, changed: true };
      break;
    }
    case 'slice': {
      if (!Array.isArray(nested.value)) {
        return {
          ok: false,
          message: 'A slice of an array can only be assigned another array',
        };
      }
      const replaced = replaceArraySlice({
        source: frame.source,
        start: frame.start,
        end: frame.end,
        replacement: nested.value,
      });
      if (!replaced.ok) return replaced;
      nested = { ok: true, value: replaced.value, changed: true };
      break;
    }
    default: {
      const _ex: never = frame;
      throw new Error(`Unhandled jq path deletion frame: ${JSON.stringify(_ex)}`);
    }
    }
  }

  return nested;
}

type JqPathCursor = {
  readonly segments: readonly JqPathSegment[],
  readonly offset: number,
};

type DeleteAtPathsSuccess = {
  readonly ok: true,
  readonly value: JsonValue,
  readonly changed: boolean,
};

type DeleteAtPathsTask =
  | {
      readonly kind: 'visit',
      readonly value: JsonValue,
      readonly paths: readonly JqPathCursor[],
    }
  | {
      readonly kind: 'rebuild_object',
      readonly source: JsonObject,
      readonly directDeletionKeys: readonly string[],
      readonly childKeys: readonly string[],
    }
  | {
      readonly kind: 'rebuild_array',
      readonly source: JsonValue[],
      readonly directDeletionIndices: ReadonlySet<number>,
      readonly childIndices: readonly number[],
    };

function popDeleteAtPathsResults({
  results,
  count,
}: {
  results: DeleteAtPathsSuccess[],
  count: number,
}): DeleteAtPathsSuccess[] {
  if (results.length < count) {
    throw new Error('jq grouped path deletion result stack is incomplete');
  }
  return results.splice(results.length - count, count);
}

function deleteAtPaths({
  value,
  paths,
}: {
  value: JsonValue,
  paths: readonly JqPathCursor[],
}): { ok: true, value: JsonValue, changed: boolean } | { ok: false, message: string } {
  const tasks: DeleteAtPathsTask[] = [{ kind: 'visit', value, paths }];
  const results: DeleteAtPathsSuccess[] = [];

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task === undefined) throw new Error('jq grouped path deletion task stack is empty');

    switch (task.kind) {
    case 'visit': {
      if (task.paths.some(({ segments, offset }) => offset >= segments.length)) {
        results.push({ ok: true, value: null, changed: true });
        break;
      }
      if (task.value === null) {
        results.push({ ok: true, value: task.value, changed: false });
        break;
      }

      const nonEmptyPaths = task.paths.filter(({ segments, offset }) => offset < segments.length);
      if (nonEmptyPaths.length === 0) {
        results.push({ ok: true, value: task.value, changed: false });
        break;
      }

      if (isJsonObject(task.value)) {
        const grouped = new Map<string, JqPathCursor[]>();
        for (const { segments, offset } of nonEmptyPaths) {
          const head = segments[offset];
          if (head === undefined) continue;
          switch (head.kind) {
          case 'field': {
            const group = grouped.get(head.key) ?? [];
            group.push({ segments, offset: offset + 1 });
            grouped.set(head.key, group);
            break;
          }
          case 'index':
            return { ok: false, message: 'cannot index an object with a numeric path segment' };
          case 'slice':
            return { ok: false, message: 'cannot slice an object path segment' };
          default: {
            const _ex: never = head;
            return { ok: false, message: `unsupported object path segment: ${String(_ex)}` };
          }
          }
        }

        const directDeletionKeys: string[] = [];
        const children: { readonly key: string, readonly paths: readonly JqPathCursor[] }[] = [];
        for (const [key, nestedPaths] of grouped) {
          if (!Object.hasOwn(task.value, key)) continue;
          if (nestedPaths.some(({ segments, offset }) => offset >= segments.length)) {
            directDeletionKeys.push(key);
          } else {
            children.push({ key, paths: nestedPaths });
          }
        }
        if (directDeletionKeys.length === 0 && children.length === 0) {
          results.push({ ok: true, value: task.value, changed: false });
          break;
        }

        tasks.push({
          kind: 'rebuild_object',
          source: task.value,
          directDeletionKeys,
          childKeys: children.map(({ key }) => key),
        });
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          if (child === undefined) throw new Error('jq grouped object deletion child is missing');
          tasks.push({
            kind: 'visit',
            value: task.value[child.key]!,
            paths: child.paths,
          });
        }
        break;
      }

      if (Array.isArray(task.value)) {
        const grouped = new Map<number, JqPathCursor[]>();
        for (const { segments, offset } of nonEmptyPaths) {
          const head = segments[offset];
          if (head === undefined) continue;
          switch (head.kind) {
          case 'index': {
            const normalizedIndex = normalizeArrayIndex({ array: task.value, index: head.index });
            if (normalizedIndex === undefined) continue;
            const group = grouped.get(normalizedIndex) ?? [];
            group.push({ segments, offset: offset + 1 });
            grouped.set(normalizedIndex, group);
            break;
          }
          case 'field':
            return { ok: false, message: 'cannot index an array with an object path segment' };
          case 'slice':
            return { ok: false, message: 'slice deletion requires sequential handling' };
          default: {
            const _ex: never = head;
            return { ok: false, message: `unsupported array path segment: ${String(_ex)}` };
          }
          }
        }

        if (grouped.size === 0) {
          results.push({ ok: true, value: task.value, changed: false });
          break;
        }

        const directDeletionIndices = new Set<number>();
        const children: { readonly index: number, readonly paths: readonly JqPathCursor[] }[] = [];
        for (let index = 0; index < task.value.length; index += 1) {
          const nestedPaths = grouped.get(index);
          if (nestedPaths === undefined) continue;
          if (nestedPaths.some(({ segments, offset }) => offset >= segments.length)) {
            directDeletionIndices.add(index);
          } else {
            children.push({ index, paths: nestedPaths });
          }
        }

        tasks.push({
          kind: 'rebuild_array',
          source: task.value,
          directDeletionIndices,
          childIndices: children.map(({ index }) => index),
        });
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          if (child === undefined) throw new Error('jq grouped array deletion child is missing');
          tasks.push({
            kind: 'visit',
            value: task.value[child.index]!,
            paths: child.paths,
          });
        }
        break;
      }

      const firstPath = nonEmptyPaths[0];
      const firstHead = firstPath?.segments[firstPath.offset];
      if (firstHead === undefined) {
        results.push({ ok: true, value: task.value, changed: false });
        break;
      }
      switch (firstHead.kind) {
      case 'field':
        return {
          ok: false,
          message: Array.isArray(task.value)
            ? 'Cannot delete string element of array'
            : formatJqIndexError({ container: task.value, index: firstHead.key }),
        };
      case 'index':
        return { ok: false, message: formatJqIndexError({ container: task.value, index: firstHead.index }) };
      case 'slice':
        return { ok: false, message: 'cannot slice non-array' };
      default: {
        const _ex: never = firstHead;
        return { ok: false, message: `unsupported path segment: ${String(_ex)}` };
      }
      }
    }
    case 'rebuild_object': {
      const childResults = popDeleteAtPathsResults({
        results,
        count: task.childKeys.length,
      });
      const changed = task.directDeletionKeys.length > 0
        || childResults.some((result) => result.changed);
      if (!changed) {
        results.push({ ok: true, value: task.source, changed: false });
        break;
      }

      const next = shallowCloneObject({ value: task.source });
      for (const key of task.directDeletionKeys) delete next[key];
      for (let index = 0; index < task.childKeys.length; index += 1) {
        const child = childResults[index];
        if (child === undefined) throw new Error('jq grouped object deletion result is missing');
        if (!child.changed) continue;
        defineJsonProperty({ object: next, key: task.childKeys[index]!, value: child.value });
      }
      results.push({ ok: true, value: next, changed: true });
      break;
    }
    case 'rebuild_array': {
      const childResults = popDeleteAtPathsResults({
        results,
        count: task.childIndices.length,
      });
      const changed = task.directDeletionIndices.size > 0
        || childResults.some((result) => result.changed);
      if (!changed) {
        results.push({ ok: true, value: task.source, changed: false });
        break;
      }

      const childResultsByIndex = new Map<number, DeleteAtPathsSuccess>();
      for (let index = 0; index < task.childIndices.length; index += 1) {
        const child = childResults[index];
        if (child === undefined) throw new Error('jq grouped array deletion result is missing');
        childResultsByIndex.set(task.childIndices[index]!, child);
      }
      const next: JsonValue[] = [];
      for (let index = 0; index < task.source.length; index += 1) {
        if (task.directDeletionIndices.has(index)) continue;
        const child = childResultsByIndex.get(index);
        next.push(child?.changed ? child.value : task.source[index]!);
      }
      results.push({ ok: true, value: next, changed: true });
      break;
    }
    default: {
      const _ex: never = task;
      throw new Error(`Unhandled jq grouped path deletion task: ${JSON.stringify(_ex)}`);
    }
    }
  }

  if (results.length !== 1) {
    throw new Error(`jq grouped path deletion produced ${results.length} results`);
  }
  return results[0]!;
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

export function applyPathDeletions({
  root,
  paths,
}: {
  root: JsonValue,
  paths: readonly JqPath[],
}): { ok: true, value: JsonValue } | { ok: false, message: string } {
  const concretePaths: JqPath[] = [];
  for (const path of paths) {
    const sliceIndex = path.segments.findIndex((segment) => segment.kind === 'slice');
    if (sliceIndex < 0) {
      concretePaths.push(path);
      continue;
    }
    if (sliceIndex + 1 !== path.segments.length) {
      let value = root;
      for (const sequentialPath of paths) {
        const deleted = deleteAtPath({ value, segments: sequentialPath.segments });
        if (!deleted.ok) return deleted;
        value = deleted.value;
      }
      return { ok: true, value };
    }

    const segment = path.segments[sliceIndex];
    if (segment === undefined) throw new Error('Expected a slice segment');
    const slice = (() => {
      switch (segment.kind) {
      case 'slice':
        return segment;
      case 'field':
      case 'index':
        throw new Error('Expected a slice segment');
      default: {
        const _ex: never = segment;
        throw new Error(`Unhandled jq path segment: ${JSON.stringify(_ex)}`);
      }
      }
    })();
    const parentPath: JqPath = { segments: path.segments.slice(0, sliceIndex) };
    const parent = readJqPathValue({ root, path: parentPath });
    if (!parent.ok) return parent;
    if (parent.skipped || parent.value === undefined || parent.value === null) continue;
    if (typeof parent.value === 'string') {
      return { ok: false, message: 'Cannot delete fields from string' };
    }
    if (!Array.isArray(parent.value)) {
      if (slice.optional) continue;
      return { ok: false, message: 'cannot slice non-array' };
    }
    const range = normalizeSliceRange({
      length: parent.value.length,
      start: slice.start,
      end: slice.end,
    });
    for (let index = range.start; index < range.end; index += 1) {
      concretePaths.push({
        segments: [
          ...parentPath.segments,
          { kind: 'index', index, optional: slice.optional },
        ],
      });
    }
  }

  if (concretePaths.length <= 1) {
    let value = root;
    for (const path of concretePaths) {
      const deleted = deleteAtPath({ value, segments: path.segments });
      if (!deleted.ok) return deleted;
      value = deleted.value;
    }
    return { ok: true, value };
  }

  const result = deleteAtPaths({
    value: root,
    paths: concretePaths.map((path) => ({ segments: path.segments, offset: 0 })),
  });
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
  }) => JqPathUpdateResult,
}): JqPathUpdateResult {
  return updateAtPath({
    value: root,
    segments: path.segments,
    update,
  });
}

type JqPathUpdateResult =
  | { ok: true, value: JsonValue, numberOrigin?: import('./number-origin').JqNumberOrigin }
  | { ok: false, message: string };

type JqPathUpdateFrame =
  | {
      kind: 'field',
      source: { [key: string]: JsonValue },
      originalValue: JsonValue | undefined,
      currentValue: JsonValue | undefined,
      currentNumberOrigin: import('./number-origin').JqNumberOrigin | undefined,
      key: string,
    }
  | {
      kind: 'index',
      source: JsonValue[],
      originalValue: JsonValue | undefined,
      currentValue: JsonValue | undefined,
      currentNumberOrigin: import('./number-origin').JqNumberOrigin | undefined,
      normalizedIndex: number,
    }
  | {
      kind: 'slice',
      source: JsonValue[],
      start: number,
      end: number,
    };

function updateAtPath({
  value,
  segments,
  update,
}: {
  value: JsonValue,
  segments: readonly JqPathSegment[],
  update: ({ currentValue }: {
    currentValue: JsonValue | undefined,
  }) => JqPathUpdateResult,
}): JqPathUpdateResult {
  const originalRoot = value;
  const frames: JqPathUpdateFrame[] = [];
  let currentValue: JsonValue | undefined = value;

  for (let offset = 0; offset < segments.length; offset += 1) {
    const segment = segments[offset]!;
    const isLeaf = offset + 1 === segments.length;

    switch (segment.kind) {
    case 'field': {
      if (
        currentValue !== undefined
        && currentValue !== null
        && !isJsonObject(currentValue)
      ) {
        return segment.optional
          ? { ok: true, value: originalRoot }
          : {
            ok: false,
            message: formatJqIndexError({
              container: currentValue,
              index: segment.key,
            }),
          };
      }

      const source: { [key: string]: JsonValue } = (
        currentValue !== undefined && isJsonObject(currentValue)
          ? currentValue
          : createJsonObject()
      );
      const childValue: JsonValue | undefined = source[segment.key];
      frames.push({
        kind: 'field',
        source,
        originalValue: currentValue,
        currentValue: childValue,
        currentNumberOrigin: getJsonChildNumberOrigin({ container: source, key: segment.key }),
        key: segment.key,
      });
      currentValue = childValue;
      break;
    }
    case 'index': {
      if (
        currentValue !== undefined
        && currentValue !== null
        && !Array.isArray(currentValue)
      ) {
        return segment.optional
          ? { ok: true, value: originalRoot }
          : {
            ok: false,
            message: formatJqIndexError({
              container: currentValue,
              index: segment.index,
            }),
          };
      }
      if (!Number.isFinite(segment.index)) {
        return { ok: false, message: `invalid array index ${segment.index}` };
      }

      const source = Array.isArray(currentValue) ? currentValue : [];
      const integerIndex = Math.trunc(segment.index);
      const normalizedIndex = integerIndex >= 0
        ? integerIndex
        : source.length + integerIndex;
      if (normalizedIndex < 0) {
        return { ok: false, message: 'Out of bounds negative array index' };
      }
      if (
        normalizedIndex >= source.length
        && normalizedIndex >= JQ_MAX_MATERIALIZED_VALUE_LENGTH
      ) {
        return {
          ok: false,
          message: `array materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
        };
      }

      const childValue = source[normalizedIndex];
      frames.push({
        kind: 'index',
        source,
        originalValue: currentValue,
        currentValue: childValue,
        currentNumberOrigin: getJsonChildNumberOrigin({ container: source, key: normalizedIndex }),
        normalizedIndex,
      });
      currentValue = childValue;
      break;
    }
    case 'slice': {
      if (typeof currentValue === 'string') {
        return { ok: false, message: 'Cannot update string slices' };
      }
      if (
        currentValue !== undefined
        && currentValue !== null
        && !Array.isArray(currentValue)
      ) {
        return segment.optional
          ? { ok: true, value: originalRoot }
          : { ok: false, message: 'cannot slice non-array' };
      }

      const source = Array.isArray(currentValue) ? currentValue : [];
      const range = normalizeSliceRange({
        length: source.length,
        start: segment.start,
        end: segment.end,
      });
      const sliceValue = source.slice(range.start, range.end);
      moveJsonArrayNumberOrigins({
        source,
        target: sliceValue,
        sourceStart: range.start,
        sourceEnd: range.end,
      });
      frames.push({
        kind: 'slice',
        source,
        start: range.start,
        end: range.end,
      });
      currentValue = isLeaf && (currentValue === undefined || currentValue === null)
        ? currentValue
        : sliceValue;
      break;
    }
    default: {
      const _ex: never = segment;
      throw new Error(`Unhandled jq path segment: ${JSON.stringify(_ex)}`);
    }
    }
  }

  let nested = update({ currentValue });
  if (!nested.ok) return nested;

  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]!;
    switch (frame.kind) {
    case 'field': {
      if (
        nested.value === frame.currentValue
        && frame.source === frame.originalValue
        && (typeof nested.value !== 'number' || nested.numberOrigin === frame.currentNumberOrigin)
      ) {
        nested = { ok: true, value: frame.source };
        break;
      }
      const next = shallowCloneObject({ value: frame.source });
      defineJsonProperty({ object: next, key: frame.key, value: nested.value });
      setJsonChildNumberOrigin({ container: next, key: frame.key, origin: nested.numberOrigin });
      nested = { ok: true, value: next };
      break;
    }
    case 'index': {
      if (
        nested.value === frame.currentValue
        && frame.source === frame.originalValue
        && (typeof nested.value !== 'number' || nested.numberOrigin === frame.currentNumberOrigin)
      ) {
        nested = { ok: true, value: frame.source };
        break;
      }
      const next = frame.source.slice();
      copyJsonChildNumberOrigins({ source: frame.source, target: next });
      if (next.length < frame.normalizedIndex) {
        const previousLength = next.length;
        next.length = frame.normalizedIndex;
        next.fill(null, previousLength);
      }
      next[frame.normalizedIndex] = nested.value;
      setJsonChildNumberOrigin({
        container: next,
        key: frame.normalizedIndex,
        origin: nested.numberOrigin,
      });
      nested = { ok: true, value: next };
      break;
    }
    case 'slice': {
      if (!Array.isArray(nested.value)) {
        return {
          ok: false,
          message: 'A slice of an array can only be assigned another array',
        };
      }
      nested = replaceArraySlice({
        source: frame.source,
        start: frame.start,
        end: frame.end,
        replacement: nested.value,
      });
      if (!nested.ok) return nested;
      break;
    }
    default: {
      const _ex: never = frame;
      throw new Error(`Unhandled jq path update frame: ${JSON.stringify(_ex)}`);
    }
    }
  }

  return nested;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
