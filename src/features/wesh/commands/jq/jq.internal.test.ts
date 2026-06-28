import { describe, expect, it } from 'vitest';
import type { JsonValue, JqPath } from './ast';
import { applyPathDeletion, applyPathUpdate } from './path';
import {
  compareJsonValues,
  createJsonObject,
  defineJsonProperty,
  isJsonObject,
  normalizeJsonValue,
} from './value';

function jsonObject({
  entries,
}: {
  entries: readonly (readonly [string, JsonValue])[],
}): { [key: string]: JsonValue } {
  const object = createJsonObject();
  for (const [key, value] of entries) {
    defineJsonProperty({ object, key, value });
  }
  return object;
}

const nestedValuePath: JqPath = {
  segments: [
    { kind: 'field', key: 'changed' },
    { kind: 'field', key: 'value' },
  ],
};

describe('jq internal value safety and path updates', () => {
  it('uses copy-on-write and preserves unrelated branches', () => {
    const changed = jsonObject({ entries: [['value', 1]] });
    const unchanged = jsonObject({ entries: [['stable', true]] });
    const root = jsonObject({
      entries: [
        ['changed', changed],
        ['unchanged', unchanged],
      ],
    });

    const updated = applyPathUpdate({
      root,
      path: nestedValuePath,
      update: () => ({ ok: true, value: 2 }),
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok || !isJsonObject(updated.value)) return;
    expect(updated.value).not.toBe(root);
    const updatedChanged = updated.value.changed;
    expect(updatedChanged).not.toBe(changed);
    expect(updated.value.unchanged).toBe(unchanged);
    expect(changed.value).toBe(1);
    if (updatedChanged === undefined) return;
    expect(isJsonObject(updatedChanged)).toBe(true);
    if (!isJsonObject(updatedChanged)) return;
    expect(updatedChanged.value).toBe(2);
  });

  it('uses copy-on-write for deletion and retains the source value', () => {
    const changed = jsonObject({
      entries: [
        ['value', 1],
        ['retained', 2],
      ],
    });
    const unchanged = jsonObject({ entries: [['stable', true]] });
    const root = jsonObject({
      entries: [
        ['changed', changed],
        ['unchanged', unchanged],
      ],
    });

    const deleted = applyPathDeletion({ root, path: nestedValuePath });

    expect(deleted.ok).toBe(true);
    if (!deleted.ok || !isJsonObject(deleted.value)) return;
    expect(deleted.value.unchanged).toBe(unchanged);
    expect(Object.hasOwn(changed, 'value')).toBe(true);
    const deletedChanged = deleted.value.changed;
    if (deletedChanged === undefined) return;
    expect(isJsonObject(deletedChanged)).toBe(true);
    if (!isJsonObject(deletedChanged)) return;
    expect(Object.hasOwn(deletedChanged, 'value')).toBe(false);
    expect(deletedChanged.retained).toBe(2);
  });

  it('keeps prototype-related JSON keys as inert own properties', () => {
    const normalized = normalizeJsonValue({
      value: JSON.parse('{"__proto__":{"polluted":true},"constructor":1}') as JsonValue,
    });

    expect(isJsonObject(normalized)).toBe(true);
    if (!isJsonObject(normalized)) return;
    expect(Object.getPrototypeOf(normalized)).toBeNull();
    expect(Object.hasOwn(normalized, '__proto__')).toBe(true);
    expect(Object.hasOwn(normalized, 'constructor')).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('implements jq type ordering recursively', () => {
    const values: JsonValue[] = [
      jsonObject({ entries: [] }),
      [],
      'a',
      1,
      true,
      false,
      null,
    ];

    values.sort((left, right) => compareJsonValues({ left, right }));

    expect(values).toEqual([
      null,
      false,
      true,
      1,
      'a',
      [],
      {},
    ]);
  });
});
