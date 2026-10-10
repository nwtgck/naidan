import { expect, it, vi } from 'vitest';
import { ref, shallowRef } from 'vue';
import { useImageEngineState } from './use-image-engine-state';
import { engineSnapshotFixture } from './test-utils/engine-state';
import type { ImageClient } from './worker/types';
import type { ImageEngineInspection } from './engine-state';
import type { Progress } from './types';

function harness() {
  const inspectEngine = vi.fn(async (): Promise<ImageEngineInspection> => ({ status: 'ready', snapshot: engineSnapshotFixture() }));
  const client: ImageClient = { inspectEngine, generate: vi.fn(), cancel() {}, updatePreview() {}, release() {}, dispose() {} };
  const progress = shallowRef<Progress>(), modelResident = ref(true), supported = ref(true);
  let current: ImageClient | undefined = client;
  const owner = useImageEngineState({ client: () => current, supported, progress, modelResident });
  return {
    ...owner,
    inspectEngine,
    progress,
    modelResident,
    supported,
    setClient({ value }: { value: ImageClient | undefined }) {
      current = value;
    },
  };
}

it('does not inspect before opening or during closed lifecycle events, and never creates a missing client', async () => {
  const h = harness(); h.afterRun(); await h.view.refresh();
  expect(h.inspectEngine).not.toHaveBeenCalled();
  h.setClient({ value: undefined }); h.view.setOpened({ opened: true });
  expect(h.view.reason.value).toBe('not-loaded'); expect(h.inspectEngine).not.toHaveBeenCalled();
});

it('keeps the idle timestamp during generation and refreshes only after a visible completed run', async () => {
  const h = harness(); h.view.setOpened({ opened: true }); await Promise.resolve();
  expect(h.view.snapshot.value?.collectedAt).toBe(1700000000000);
  h.progress.value = { phase: 'sampling', step: 1, steps: 8 }; await h.view.refresh();
  expect(h.view.canRefresh.value).toBe(false); expect(h.view.reason.value).toBe('busy'); expect(h.inspectEngine).toHaveBeenCalledOnce();
  h.progress.value = undefined; h.afterRun(); await Promise.resolve(); expect(h.inspectEngine).toHaveBeenCalledTimes(2);
  h.view.setOpened({ opened: false }); h.afterRun(); expect(h.inspectEngine).toHaveBeenCalledTimes(2);
});

it('drops reads completed after closing or releasing the model, and clears old model values', async () => {
  const h = harness(); const pending = Promise.withResolvers<ImageEngineInspection>(); h.inspectEngine.mockReturnValueOnce(pending.promise);
  h.view.setOpened({ opened: true }); h.view.setOpened({ opened: false });
  pending.resolve({ status: 'ready', snapshot: engineSnapshotFixture() }); await pending.promise; await Promise.resolve();
  expect(h.view.snapshot.value).toBeUndefined();
  h.view.setOpened({ opened: true }); await Promise.resolve(); expect(h.view.snapshot.value).toBeDefined();
  h.invalidate(); expect(h.view.snapshot.value).toBeUndefined(); expect(h.view.reason.value).toBe('released');
});

it('recovers from observation errors and ignores obsolete responses from another client or disposed UI', async () => {
  const h = harness(); h.inspectEngine.mockRejectedValueOnce(new Error('Getter failed'));
  h.view.setOpened({ opened: true }); await Promise.resolve(); expect(h.view.status.value).toBe('failed');
  await h.view.refresh(); expect(h.view.status.value).toBe('idle');
  const pending = Promise.withResolvers<ImageEngineInspection>(); h.inspectEngine.mockReturnValueOnce(pending.promise);
  const reading = h.view.refresh(); h.dispose(); h.setClient({ value: undefined });
  pending.resolve({ status: 'ready', snapshot: engineSnapshotFixture() }); await reading;
  expect(h.view.snapshot.value).toBeUndefined(); expect(h.view.canRefresh.value).toBe(false);
});
