import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, shallowRef, nextTick } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { useImageComposition } from './use-image-composition';
import { compositionDraftFixture } from './draft.test-support';
import { toImageGenerationSessionId, toImageGenerationStoreId } from '@/01-models/ids';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import type { ImageCompositionDraft } from '@/01-models/image-generation';
const storage = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('@/00-storage/service/image-generation/composition', () => ({ loadImageGenerationComposition: storage.load, saveImageGenerationComposition: storage.save }));

function open({ bound }: { bound: boolean }) {
  const scope = effectScope(), store = shallowRef<ImageGenerationStoreAccess>(), sessionId = shallowRef<ReturnType<typeof toImageGenerationSessionId>>(), blocked = ref(false), count = ref(2);
  const view = scope.run(() => useImageComposition({ store, sessionId, blocked, commonCount: count, captureDraft: compositionDraftFixture }))!;
  const bind = ({ id }: { id: string }) => {
    store.value = { storageType: 'opfs', storeId: toImageGenerationStoreId({ raw: 'store-aa' }) };
    sessionId.value = toImageGenerationSessionId({ raw: id });
  };
  if (bound) {
    bind({ id: 'session-aa' });
  }
  return {
    view,
    store,
    sessionId,
    blocked,
    count,
    bind,
    async [Symbol.asyncDispose]() {
      await view.flush();
      scope.stop();
      await flushPromises();
    },
  };
}

beforeEach(() => {
  storage.load.mockReset().mockResolvedValue(undefined);
  storage.save.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shared editable requests', () => {
  it('loads pasted objects into exactly the manually editable list, preserving omitted fields', async () => {
    await using h = open({ bound: false });
    h.view.add();
    const first = h.view.state.value.jobs[0]!;
    h.view.update({ id: first.id, input: { prompt: 'manual' } });
    h.view.pastedText.value = `\
prompt: pasted
count: 3
---
prompt: second`;
    await nextTick();
    await h.view.parse();
    expect(h.view.preview.value?.format).toBe('YAML');
    h.view.importJobs({ replace: false });
    const imported = h.view.state.value.jobs[1]!;
    h.view.update({ id: imported.id, input: { ...imported.input, prompt: 'edited', width: 512 } });
    h.view.move({ id: imported.id, delta: -1 });
    h.view.duplicate({ id: imported.id });
    h.view.remove({ id: first.id });
    expect(h.view.state.value.jobs.map(job => job.input.prompt)).toEqual(['edited', 'edited', 'second']);
    expect(h.view.state.value.jobs[2]!.input).toEqual({ prompt: 'second' });
    expect(h.view.validation.value.images).toBe(8);
    h.count.value = 4;
    expect(h.view.validation.value.images).toBe(10);
  });

  it('does not partially import invalid documents or replace the edited list on a parse error', async () => {
    await using h = open({ bound: false });
    h.view.add();
    const before = h.view.state.value;
    h.view.pastedText.value = `\
prompt: valid
---
propt: misspelled`;
    await nextTick();
    await h.view.parse();
    expect(h.view.importFailure.value).toContain('propt');
    expect(h.view.preview.value).toBeUndefined();
    h.view.importJobs({ replace: true });
    expect(h.view.state.value).toBe(before);
    expect(h.view.pastedText.value).toContain('misspelled');
  });

  it('invalidates a preview when the pasted text changes, and detects JSONL', async () => {
    await using h = open({ bound: false });
    h.view.pastedText.value = `\
{"prompt":"one"}
{"prompt":"two"}`;
    await nextTick();
    await h.view.parse();
    expect(h.view.preview.value?.format).toBe('JSONL');
    h.view.pastedText.value = 'new invalid input';
    await nextTick();
    expect(h.view.preview.value).toBeUndefined();
  });

  it('requires explicit model assignment and shares one slot without copying prompts', async () => {
    await using h = open({ bound: false });
    h.view.add();
    const id = h.view.state.value.jobs[0]!.id;
    h.view.update({ id, input: { prompt: 'cat', uiModelConfigurationSlot: 'style' } });
    expect(h.view.validation.value.issues[0]).toContain('style');
    h.view.assignSlot({ name: 'style' });
    expect(h.view.validation.value.issues).toEqual([]);
    expect(h.view.state.value.slots[0]!.configuration.request).not.toHaveProperty('parameters');
    h.view.duplicate({ id });
    expect(h.view.slotNames.value).toEqual(['style']);
  });

  it('blocks edits during preparation or execution, including import application', async () => {
    await using h = open({ bound: false });
    h.view.add();
    const before = h.view.state.value;
    h.blocked.value = true;
    h.view.add();
    h.view.remove({ id: before.jobs[0]!.id });
    h.view.assignSlot({ name: 'bad' });
    expect(h.view.state.value).toBe(before);
  });
});

describe('composition checkpoints and session boundaries', () => {
  it('adopts unbound input once into the first session and becomes clean after saving', async () => {
    await using h = open({ bound: false });
    h.view.setMode({ mode: 'multiple' });
    h.view.add();
    const job = h.view.state.value.jobs[0]!;
    h.view.update({ id: job.id, input: { prompt: 'adopted' } });
    h.view.carryToNewSession();
    h.bind({ id: 'session-aa' });
    await nextTick();
    expect(h.view.state.value.jobs[0]!.input.prompt).toBe('adopted');
    expect(storage.load).not.toHaveBeenCalled();
    await h.view.flush();
    expect(h.view.dirty.value).toBe(false);
    expect(storage.save.mock.lastCall?.[0].draft).toMatchObject({ sessionId: toImageGenerationSessionId({ raw: 'session-aa' }), mode: 'multiple', revision: 0 });
    h.bind({ id: 'session-bb' });
    await flushPromises();
    expect(h.view.state.value.jobs).toEqual([]);
    expect(h.view.state.value.mode).toBe('single');
    h.bind({ id: 'session-aa' });
    await flushPromises();
    expect(h.view.state.value.jobs[0]!.input.prompt).toBe('adopted');
  });

  it('retries an identical attempted revision after lost acknowledgement and then drains newer edits', async () => {
    await using h = open({ bound: true });
    await flushPromises();
    h.view.add();
    const id = h.view.state.value.jobs[0]!.id;
    h.view.update({ id, input: { prompt: 'first' } });
    storage.save.mockRejectedValueOnce(new Error('ack lost'));
    expect(await h.view.flush()).toBe(false);
    const attempted = storage.save.mock.calls[0]![0];
    h.view.update({ id, input: { prompt: 'newer' } });
    expect(await h.view.flush()).toBe(true);
    expect(storage.save.mock.calls[1]![0]).toEqual(attempted);
    expect(storage.save.mock.calls[2]![0].draft).toMatchObject({ revision: 1, jobs: [{ id, input: { prompt: 'newer' } }] });
    expect(h.view.dirty.value).toBe(false);
  });

  it('retains failed writes at their original address when changing sessions', async () => {
    await using h = open({ bound: true });
    await flushPromises();
    h.view.add();
    storage.save.mockRejectedValue(new Error('conflict'));
    expect(await h.view.flush()).toBe(false);
    h.bind({ id: 'session-bb' });
    await flushPromises();
    expect(h.view.state.value.jobs).toEqual([]);
    expect(h.view.dirty.value).toBe(true);
    expect(storage.save.mock.calls.every(call => call[0].draft.sessionId === 'session-aa')).toBe(true);
    storage.save.mockResolvedValue(undefined);
    h.bind({ id: 'session-aa' });
    await flushPromises();
    await h.view.flush();
    expect(h.view.dirty.value).toBe(false);
  });

  it('restores full model assignments without in-memory File capabilities', async () => {
    await using h = open({ bound: true });
    await flushPromises();
    h.view.assignSlot({ name: 'style' });
    await h.view.flush();
    const saved: ImageCompositionDraft = storage.save.mock.lastCall![0].draft;
    expect(saved.slots[0]!.configuration).not.toHaveProperty('modelFiles');
    storage.load.mockResolvedValue(saved);
    h.view.reload();
    await flushPromises();
    expect(h.view.state.value.slots[0]!.configuration.modelFiles).toEqual([]);
    expect(h.view.state.value.slots[0]!.configuration.request.models).toHaveLength(1);
  });

  it('never overwrites a checkpoint after a failed read, and allows an explicit retry', async () => {
    storage.load.mockRejectedValueOnce(new Error('corrupt'));
    await using h = open({ bound: true });
    await flushPromises();
    h.view.add();
    expect(h.view.state.value.jobs).toEqual([]);
    expect(h.view.loading.value).toBe(true);
    expect(storage.save).not.toHaveBeenCalled();
    h.view.reload();
    await flushPromises();
    expect(h.view.loading.value).toBe(false);
    h.view.add();
    expect(h.view.state.value.jobs).toHaveLength(1);
  });
});
