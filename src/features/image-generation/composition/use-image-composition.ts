import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { generateId } from '@/01-models/id';
import { idToRaw, type ImageGenerationJobId, type ImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import { loadImageGenerationComposition, saveImageGenerationComposition } from '@/00-storage/service/image-generation/composition';
import type { ImageCompositionDraft } from '@/01-models/image-generation';
import type { ImageGenerationDraft } from '@/features/image-generation/generation-draft';
import { captureImageModelConfiguration, type ImageCompositionJob, type ImageCompositionSlot } from './draft';
import { IMAGE_COMPOSITION_MAX_IMAGES, IMAGE_COMPOSITION_MAX_JOBS, parseImageGenerationInput, validateImageGenerationInput, type ImageGenerationInput } from './input';

type CompositionState = { mode: 'single' | 'multiple', jobs: ImageCompositionJob[], slots: ImageCompositionSlot[] };
type Checkpoint = {
  state: CompositionState, revision: number | undefined, dirty: boolean, loaded: boolean, failure: string,
  attempt: { draft: ImageCompositionDraft, state: CompositionState } | undefined,
  writing: Promise<boolean> | undefined,
};

const emptyState = (): CompositionState => ({ mode: 'single', jobs: [], slots: [] });

const checkpoint = (): Checkpoint => ({ state: emptyState(), revision: undefined, dirty: false, loaded: false, failure: '', attempt: undefined, writing: undefined });

/** Import is a one-way edit command. Text is not a second source of truth.
 * Every pending write retains its destination and exact retry payload. */
export function useImageComposition({ store, sessionId, blocked, commonCount, captureDraft }: {
  store: Readonly<Ref<ImageGenerationStoreAccess | undefined>>,
  sessionId: Readonly<Ref<ImageGenerationSessionId | undefined>>, blocked: Readonly<Ref<boolean>>,
  commonCount: Readonly<Ref<number>>, captureDraft(): ImageGenerationDraft | undefined,
}) {
  const state = shallowRef<CompositionState>(emptyState());
  const loading = ref(false), saving = ref(false), failure = ref('');
  const pastedText = ref(''), importOpen = ref(false), parsing = ref(false);
  const preview = shallowRef<Awaited<ReturnType<typeof parseImageGenerationInput>>>();
  const importFailure = ref('');
  const dirtyRevision = ref(0);
  const cache = new Map<string, Checkpoint>();
  let active = checkpoint(), destination: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId } | undefined;
  let epoch = 0, parseEpoch = 0, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let carry: Checkpoint | undefined;
  const reloadVersion = ref(0);
  const changed = () => {
    dirtyRevision.value++;
  };
  const editable = computed(() => !blocked.value && !loading.value);
  const dirty = computed(() => {
    void dirtyRevision.value;
    return active.dirty || [...cache.values()].some(item => item.dirty);
  });
  const slotNames = computed(() => [...new Set(state.value.jobs.map(job => job.input.uiModelConfigurationSlot).filter((name): name is string => name !== undefined))]);
  const validation = computed(() => {
    const issues: string[] = [];
    let images = 0;
    for (const [index, job] of state.value.jobs.entries()) {
      try {
        validateImageGenerationInput({ value: job.input });
        if (job.input.uiModelConfigurationSlot !== undefined && !state.value.slots.some(slot => slot.name === job.input.uiModelConfigurationSlot)) {
          throw new Error(`uiModelConfigurationSlot: ${job.input.uiModelConfigurationSlot}`);
        }
        images += job.input.count ?? commonCount.value;
      } catch (error) {
        issues.push(`${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!state.value.jobs.length || state.value.jobs.length > IMAGE_COMPOSITION_MAX_JOBS || images > IMAGE_COMPOSITION_MAX_IMAGES) {
      issues.push(`1–${IMAGE_COMPOSITION_MAX_JOBS} requests; 1–${IMAGE_COMPOSITION_MAX_IMAGES} images.`);
    }
    return { images, issues };
  });
  function synchronize(): void {
    state.value = active.state;
    failure.value = active.failure;
    saving.value = active.writing !== undefined;
    changed();
  }
  async function save({ entry, address }: { entry: Checkpoint, address: NonNullable<typeof destination> }): Promise<boolean> {
    if (entry.writing) {
      return entry.writing;
    }
    if (!entry.dirty) {
      return true;
    }
    entry.writing = (async () => {
      try {
        while (entry.dirty) {
          if (!entry.attempt) {
            const captured = entry.state;
            entry.attempt = {
              state: captured,
              draft: {
                sessionId: address.sessionId,
                revision: entry.revision === undefined ? 0 : entry.revision + 1,
                updatedAt: Date.now(),
                mode: captured.mode,
                jobs: captured.jobs.map(job => ({ id: job.id, input: { ...job.input } })),
                slots: captured.slots.map(({ name, configuration }) => {
                  const { modelFiles: _files, ...persisted } = configuration;
                  return { name, configuration: structuredClone(persisted) };
                }),
              },
            };
          }
          const attempt = entry.attempt;
          if (!attempt) {
            throw new Error('The composition save checkpoint is missing.');
          }
          await saveImageGenerationComposition({ store: address.store, draft: attempt.draft, expectedRevision: entry.revision });
          entry.revision = attempt.draft.revision;
          entry.dirty = entry.state !== attempt.state;
          entry.attempt = undefined;
          entry.failure = '';
        }
        return true;
      } catch (error) {
        entry.failure = error instanceof Error ? error.message : String(error);
        return false;
      } finally {
        entry.writing = undefined;
        if (!disposed) {
          if (entry === active) {
            synchronize();
          } else {
            changed();
          }
        }
      }
    })();
    if (!disposed && entry === active) {
      synchronize();
    }
    return entry.writing;
  }
  async function flush(): Promise<boolean> {
    clearTimeout(timer);
    const entry = active, address = destination;
    return address ? save({ entry, address }) : true;
  }
  function commit({ next }: { next: CompositionState }): void {
    if (!editable.value) {
      return;
    }
    active.state = next;
    active.dirty = true;
    synchronize();
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, 500);
  }
  watch(() => [store.value?.storeId, sessionId.value, reloadVersion.value], async () => {
    clearTimeout(timer);
    if (destination && active.dirty) {
      void save({ entry: active, address: destination });
    }
    const token = ++epoch;
    const target = store.value, id = sessionId.value;
    destination = target && id ? { store: { ...target }, sessionId: id } : undefined;
    const key = JSON.stringify([target?.storeId, id]);
    // An unbound composition survives the first session's creation only when
    // the caller explicitly asks. Ordinary navigation never copies its jobs.
    active = cache.get(key) ?? checkpoint();
    cache.set(key, active);
    if (carry && destination) {
      active.state = carry.state;
      carry.dirty = false;
      active.dirty = true;
      active.loaded = true;
      carry = undefined;
    }
    synchronize();
    loading.value = !!destination && !active.loaded;
    if (!destination || active.loaded) {
      return;
    }
    const entry = active, address = destination;
    try {
      const loaded = await loadImageGenerationComposition(address);
      if (loaded) {
        entry.state = { mode: loaded.mode, jobs: loaded.jobs, slots: loaded.slots.map(slot => ({ name: slot.name, configuration: { ...slot.configuration, modelFiles: [] } })) };
        entry.revision = loaded.revision;
      }
      entry.loaded = true;
    } catch (error) {
      entry.failure = error instanceof Error ? error.message : String(error);
      // Failed load is never treated as a blank writable checkpoint.
    } finally {
      if (!disposed && token === epoch) {
        synchronize();
        loading.value = !entry.loaded;
      }
    }
  }, { immediate: true });
  watch(pastedText, () => {
    parseEpoch++;
    preview.value = undefined;
    importFailure.value = '';
  });
  onScopeDispose(() => {
    void flush();
    disposed = true;
    epoch++;
    parseEpoch++;
    clearTimeout(timer);
  });
  return {
    state,
    loading,
    saving,
    failure,
    dirty,
    editable,
    slotNames,
    validation,
    pastedText,
    importOpen,
    setPastedText({ text }: { text: string }) {
      if (editable.value) {
        pastedText.value = text;
      }
    },
    toggleImport() {
      if (editable.value) {
        importOpen.value = !importOpen.value;
      }
    },
    parsing,
    preview,
    importFailure,
    flush,
    carryToNewSession() {
      carry = active;
    },
    cancelCarry() {
      carry = undefined;
    },
    reload() {
      if (blocked.value || active.writing) {
        return;
      }
      active.dirty = false;
      cache.delete(JSON.stringify([store.value?.storeId, sessionId.value]));
      reloadVersion.value++;
    },
    setMode({ mode }: { mode: CompositionState['mode'] }) {
      commit({ next: { ...state.value, mode } });
    },
    add() {
      if (state.value.jobs.length >= IMAGE_COMPOSITION_MAX_JOBS) {
        return;
      }
      commit({ next: { ...state.value, jobs: [...state.value.jobs, { id: idToRaw({ id: generateId<ImageGenerationJobId>() }), input: { prompt: '' } }] } });
    },
    update({ id, input }: { id: string, input: ImageGenerationInput }) {
      commit({ next: { ...state.value, jobs: state.value.jobs.map(job => job.id === id ? { ...job, input: { ...input } } : job) } });
    },
    remove({ id }: { id: string }) {
      commit({ next: { ...state.value, jobs: state.value.jobs.filter(job => job.id !== id) } });
    },
    duplicate({ id }: { id: string }) {
      if (state.value.jobs.length >= IMAGE_COMPOSITION_MAX_JOBS) {
        return;
      }
      const index = state.value.jobs.findIndex(job => job.id === id), job = state.value.jobs[index];
      if (!job) {
        return;
      }
      const jobs = [...state.value.jobs];
      jobs.splice(index + 1, 0, { id: idToRaw({ id: generateId<ImageGenerationJobId>() }), input: { ...job.input } });
      commit({ next: { ...state.value, jobs } });
    },
    move({ id, delta }: { id: string, delta: -1 | 1 }) {
      const jobs = [...state.value.jobs], index = jobs.findIndex(job => job.id === id), job = jobs[index];
      if (!job || index + delta < 0 || index + delta >= jobs.length) {
        return;
      }
      jobs.splice(index, 1);
      jobs.splice(index + delta, 0, job);
      commit({ next: { ...state.value, jobs } });
    },
    assignSlot({ name }: { name: string }) {
      if (!editable.value) {
        return;
      }
      const draft = captureDraft();
      if (!draft) {
        failure.value = 'Select a complete model configuration first.';
        return;
      }
      try {
        const configuration = captureImageModelConfiguration({ draft });
        commit({ next: { ...state.value, slots: [...state.value.slots.filter(slot => slot.name !== name && slotNames.value.includes(slot.name)), { name, configuration }] } });
      } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
      }
    },
    async parse() {
      if (parsing.value || !editable.value) {
        return;
      }
      const token = ++parseEpoch;
      parsing.value = true;
      try {
        const result = await parseImageGenerationInput({ text: pastedText.value });
        if (disposed || token !== parseEpoch) {
          return;
        }
        preview.value = result;
        importFailure.value = '';
      } catch (error) {
        if (!disposed && token === parseEpoch) {
          importFailure.value = error instanceof Error ? error.message : String(error);
        }
      } finally {
        parsing.value = false;
      }
    },
    importJobs({ replace }: { replace: boolean }) {
      if (!preview.value || !editable.value) {
        return;
      }
      const jobs = preview.value.inputs.map(input => ({ id: idToRaw({ id: generateId<ImageGenerationJobId>() }), input: { ...input } }));
      const next = [...(replace ? [] : state.value.jobs), ...jobs];
      if (next.length > IMAGE_COMPOSITION_MAX_JOBS) {
        importFailure.value = `Maximum ${IMAGE_COMPOSITION_MAX_JOBS} requests.`;
        return;
      }
      commit({ next: { ...state.value, mode: 'multiple', jobs: next } });
      preview.value = undefined;
      importOpen.value = false;
    },
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export type ImageCompositionEditor = ReturnType<typeof useImageComposition>;
export const TEST_ONLY = {
};
