import { effectScope, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioReferences, MAX_REFERENCE_ENTRIES, MAX_REFERENCE_LIBRARY_BYTES } from './useAudioReferences';
import { MAX_REFERENCE_BYTES } from '@/features/audio-generation/types';
const urls = { create: vi.fn(), revoke: vi.fn() };
let scope: EffectScope;
beforeEach(() => {
  scope = effectScope(); vi.resetAllMocks(); let id = 0; urls.create.mockImplementation(() => `blob:ref-${++id}`);
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = urls.create; static override revokeObjectURL = urls.revoke;
  });
});
afterEach(() => {
  scope.stop(); vi.unstubAllGlobals();
});
function library() {
  return scope.run(useAudioReferences)!;
}
function file({ name, bytes }: { name: string, bytes: number }): File {
  const value = new File(['x'], name); Object.defineProperty(value, 'size', { value: bytes }); return value;
}
describe('page-local reference library', () => {
  it('keeps older sources while selecting only the newest successful input', () => {
    const refs = library(); const first = file({ name: 'first.wav', bytes: 1 }); const second = file({ name: 'second.wav', bytes: 2 });
    refs.add({ file: first }); refs.add({ file: second });
    expect(refs.entries.value.map(entry => entry.file)).toEqual([second, first]); expect(refs.sources.value).toEqual([second]);
    refs.select({ id: 1, checked: true }); expect(refs.sources.value).toEqual([second, first]);
    refs.deselectAll(); expect(refs.sources.value).toEqual([]); expect(refs.entries.value).toHaveLength(2); expect(urls.revoke).not.toHaveBeenCalled();
    refs.select({ id: 1, checked: true }); expect(refs.sources.value).toEqual([first]);
  });
  it('deleting a selected voice does not implicitly choose another one', () => {
    const refs = library(); refs.add({ file: file({ name: 'first.wav', bytes: 1 }) }); refs.add({ file: file({ name: 'second.wav', bytes: 2 }) });
    refs.remove({ id: 2 }); expect(refs.selected.value.size).toBe(0); expect(refs.entries.value).toHaveLength(1); expect(urls.revoke).toHaveBeenCalledWith('blob:ref-2');
    refs.select({ id: 999, checked: true }); refs.remove({ id: 999 }); expect(refs.sources.value).toEqual([]);
  });
  it('releases each URL exactly once on removal, bulk deletion and route disposal', () => {
    const refs = library(); refs.add({ file: file({ name: 'one', bytes: 1 }) }); refs.add({ file: file({ name: 'two', bytes: 2 }) }); refs.remove({ id: 1 });
    refs.clear(); refs.add({ file: file({ name: 'three', bytes: 3 }) }); scope.stop();
    expect(urls.revoke.mock.calls.flat()).toEqual(['blob:ref-1', 'blob:ref-2', 'blob:ref-3']); expect(refs.totalBytes.value).toBe(0);
    refs.add({ file: file({ name: 'late', bytes: 1 }) }); expect(urls.create).toHaveBeenCalledTimes(3);
  });
  it('rejects empty and oversize input without losing selection or retaining a URL', () => {
    const refs = library(); refs.add({ file: file({ name: 'ok', bytes: 1 }) });
    expect(() => refs.add({ file: file({ name: 'empty', bytes: 0 }) })).toThrow();
    expect(() => refs.add({ file: file({ name: 'large', bytes: MAX_REFERENCE_BYTES + 1 }) })).toThrow();
    expect(refs.selected.value).toEqual(new Set([1])); expect(urls.create).toHaveBeenCalledOnce();
  });
  it('bounds retained bytes without silently evicting any references', () => {
    const refs = library();
    for (let i = 0; i < MAX_REFERENCE_LIBRARY_BYTES / MAX_REFERENCE_BYTES; i++) refs.add({ file: file({ name: String(i), bytes: MAX_REFERENCE_BYTES }) });
    expect(() => refs.add({ file: file({ name: 'over', bytes: 1 }) })).toThrow('library-full'); expect(urls.revoke).not.toHaveBeenCalled();
    refs.remove({ id: 1 }); expect(() => refs.add({ file: file({ name: 'fits', bytes: 1 }) })).not.toThrow();
  });
  it('also bounds the number of tiny entries', () => {
    const refs = library(); for (let i = 0; i < MAX_REFERENCE_ENTRIES; i++) refs.add({ file: file({ name: String(i), bytes: 1 }) });
    expect(() => refs.add({ file: file({ name: 'over', bytes: 1 }) })).toThrow('library-full'); expect(refs.entries.value).toHaveLength(MAX_REFERENCE_ENTRIES);
  });
});
