import type { JsonValue } from '@/01-models/lm';

export type WorkflowJsonPath = readonly (string | number)[];

/** Paths address JSON values, never JavaScript properties inherited from a prototype. */
export function inspectJsonAssignment({ base, path }: { base: JsonValue, path: WorkflowJsonPath }): void {
  if (path.length > 64) {
    throw new Error('A JSON assignment path exceeds 64 segments.');
  }
  let current = base;
  for (const [index, key] of path.entries()) {
    const last = index === path.length - 1;
    if (Array.isArray(current)) {
      if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0 || key >= current.length) {
        throw new Error('A JSON array assignment needs an existing nonnegative integer index.');
      }
      current = current[key]!;
    } else if (current !== null && typeof current === 'object') {
      if (typeof key !== 'string') {
        throw new Error('A JSON object assignment needs a field name.');
      }
      if (!Object.hasOwn(current, key)) {
        if (last) {
          return;
        }
        throw new Error('An intermediate JSON assignment field does not exist.');
      }
      current = current[key]!;
    } else {
      throw new Error('A JSON assignment cannot descend into a scalar.');
    }
  }
}

/** Reject overlaps rather than giving assignment order hidden meaning. */
export function validateJsonAssignments({ base, paths }: { base: JsonValue, paths: readonly WorkflowJsonPath[] }): void {
  if (paths.length > 256) {
    throw new Error('A JSON composition exceeds 256 assignments.');
  }
  for (const [index, path] of paths.entries()) {
    inspectJsonAssignment({ base, path });
    for (const previous of paths.slice(0, index)) {
      const shared = Math.min(previous.length, path.length);
      if (previous.slice(0, shared).every((key, i) => key === path[i])) {
        throw new Error('JSON assignment paths overlap. Replace a value or its children, not both.');
      }
    }
  }
}

export function replaceJsonValue({ base, path, value }: { base: JsonValue, path: WorkflowJsonPath, value: JsonValue }): JsonValue {
  inspectJsonAssignment({ base, path });
  const [key, ...rest] = path;
  if (key === undefined) {
    return value;
  }
  if (Array.isArray(base) && typeof key === 'number') {
    return base.map((item, index) => index === key ? replaceJsonValue({ base: item, path: rest, value }) : item);
  }
  if (base !== null && !Array.isArray(base) && typeof base === 'object' && typeof key === 'string') {
    const replacement = rest.length === 0 ? value : replaceJsonValue({ base: base[key]!, path: rest, value });
    // Object.fromEntries also treats __proto__ as an ordinary own data field.
    return Object.fromEntries([...Object.entries(base).filter(([name]) => name !== key), [key, replacement]]);
  }
  throw new Error('Invalid JSON assignment path.');
}

/** Raw JSON editing cannot infer element identity after an array insertion or
 * reorder. Reject those ambiguous changes instead of silently retargeting a
 * binding. The user may remove the affected bindings before restructuring it.
 */
export function validateJsonCompositionBaseEdit({ before, after, paths }: { before: JsonValue, after: JsonValue, paths: readonly WorkflowJsonPath[] }): void {
  validateJsonAssignments({ base: after, paths });
  for (const path of paths) {
    let oldValue: JsonValue | undefined = before;
    let newValue: JsonValue | undefined = after;
    for (const key of path) {
      if (Array.isArray(oldValue) && JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        throw new Error('Remove references inside this array before changing its base elements. Their positions would be ambiguous.');
      }
      oldValue = oldValue !== null && typeof oldValue === 'object' && Object.hasOwn(oldValue, key) ? Reflect.get(oldValue, key) as JsonValue : undefined;
      newValue = newValue !== null && typeof newValue === 'object' && Object.hasOwn(newValue, key) ? Reflect.get(newValue, key) as JsonValue : undefined;
    }
  }
}

export const TEST_ONLY = {
};
