import { computed, onScopeDispose, shallowRef } from 'vue';
import { checkReferenceFile, ReferenceAudioError } from '@/features/audio-generation/reference-audio';

export const MAX_REFERENCE_ENTRIES = 32;
export const MAX_REFERENCE_LIBRARY_BYTES = 64 * 1024 * 1024;
export type AudioReferenceEntry = { id: number, file: File, url: string };
/** Page-local ownership only. Deselect does not delete; delete never selects
 * another voice implicitly. Latest successful input becomes the sole selection.
 */
export function useAudioReferences() {
  const entries = shallowRef<readonly AudioReferenceEntry[]>([]);
  const selected = shallowRef<ReadonlySet<number>>(new Set());
  const totalBytes = computed(() => entries.value.reduce((sum, entry) => sum + entry.file.size, 0));
  const sources = computed(() => entries.value.filter(entry => selected.value.has(entry.id)).map(entry => entry.file));
  let nextId = 0; let disposed = false;
  function add({ file }: { file: File }): void {
    if (disposed) return;
    checkReferenceFile({ file });
    if (entries.value.length >= MAX_REFERENCE_ENTRIES || totalBytes.value + file.size > MAX_REFERENCE_LIBRARY_BYTES) throw new ReferenceAudioError({ code: 'library-full' });
    const entry = { id: ++nextId, file, url: URL.createObjectURL(file) };
    entries.value = [entry, ...entries.value]; selected.value = new Set([entry.id]);
  }
  function select({ id, checked }: { id: number, checked: boolean }): void {
    if (!entries.value.some(entry => entry.id === id)) return;
    const next = new Set(selected.value);
    if (checked) next.add(id); else next.delete(id);
    selected.value = next;
  }
  function deselectAll(): void {
    selected.value = new Set();
  }
  function remove({ id }: { id: number }): void {
    const entry = entries.value.find(entry => entry.id === id);
    if (!entry) return;
    select({ id, checked: false }); entries.value = entries.value.filter(entry => entry.id !== id); URL.revokeObjectURL(entry.url);
  }
  function clear(): void {
    const previous = entries.value; entries.value = []; deselectAll();
    for (const entry of previous) URL.revokeObjectURL(entry.url);
  }
  onScopeDispose(() => {
    disposed = true; clear();
  });
  return { entries, selected, sources, totalBytes, add, select, deselectAll, remove, clear, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}
export const TEST_ONLY = {
};
