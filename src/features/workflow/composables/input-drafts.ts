import { computed, shallowRef, type InjectionKey } from 'vue';

type Entry = { text: string, discard: () => void };

/** Inline JSON stays local to its field, but its lifetime is part of the editor's
 * navigation contract. An invalid draft must not disappear when its parent moves.
 */
export function createWorkflowInputDrafts() {
  const entries = shallowRef(new Map<symbol, Entry>());
  const dirty = computed(() => entries.value.size > 0);
  function update({ owner, text, discard }: { owner: symbol, text: string | undefined, discard: () => void }): void {
    const next = new Map(entries.value);
    if (text === undefined) {
      next.delete(owner);
    } else {
      next.set(owner, { text, discard });
    }
    entries.value = next;
  }
  function checkpoint(): ReadonlyMap<symbol, string> {
    return new Map([...entries.value].map(([key, value]) => [key, value.text]));
  }
  function unchanged({ snapshot }: { snapshot: ReadonlyMap<symbol, string> }): boolean {
    return snapshot.size === entries.value.size && [...snapshot].every(([key, text]) => entries.value.get(key)?.text === text);
  }
  function hasOther({ owner }: { owner: symbol }): boolean {
    return [...entries.value.keys()].some(key => key !== owner);
  }
  function discardAll(): void {
    const current = [...entries.value.values()];
    entries.value = new Map();
    for (const entry of current) {
      entry.discard();
    }
  }
  return { dirty, update, checkpoint, unchanged, hasOther, discardAll };
}

export const workflowInputDraftsKey: InjectionKey<ReturnType<typeof createWorkflowInputDrafts>> = Symbol('workflow-input-drafts');
export const TEST_ONLY = {
};
