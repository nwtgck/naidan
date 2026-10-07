import { expect, it, vi } from 'vitest';
import { toImageGenerationId, toImageGenerationSessionId } from '@/01-models/ids';
import { generationRunFixture } from '@/00-storage/service/image-generation/test-support';
import { recoverImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import { createImageRecoveryStore } from './recovery';

function recovered() {
  const run = generationRunFixture({ id: 'run-example', sessionId: toImageGenerationSessionId({ raw: 'session-example' }), count: 1, seed: '42' });
  return recoverImageGenerationSnapshot({
    snapshot: { id: toImageGenerationId({ raw: 'output-example' }), createdAt: 1, request: run.request, inputFiles: [] },
    elapsedMs: 2,
    output: { png: new Blob(['pixels']), width: 256, height: 256, reported: undefined },
  });
}
it('retains unconfirmed pixels after the original view unsubscribes', () => {
  const store = createImageRecoveryStore({ capacity: 100 }), listener = vi.fn();
  const unsubscribe = store.subscribe({ listener }); const reservation = store.reserve({ bytes: 50 }); unsubscribe();
  const value = recovered(); const id = reservation.retain({ ...value, retry: undefined });
  value.record.request.parameters.prompt = 'mutated'; value.files.length = 0;
  expect(store.list()[0]).toMatchObject({ id, record: { result: { confirmation: 'unconfirmed', modelVersion: undefined } } });
  expect(store.list()[0]!.record.request.parameters.prompt).not.toBe('mutated');
  expect(store.list()[0]!.files).toHaveLength(1); expect(listener).not.toHaveBeenCalled();
});
it('reserves before inference, releases unused capacity and never evicts a recovery', () => {
  const store = createImageRecoveryStore({ capacity: 50 }), first = store.reserve({ bytes: 50 });
  expect(() => store.reserve({ bytes: 1 })).toThrow('Save or discard'); first.release(); first.release();
  const second = store.reserve({ bytes: 50 }), id = second.retain({ ...recovered(), retry: undefined });
  const remainder = store.reserve({ bytes: 44 });
  expect(() => store.reserve({ bytes: 1 })).toThrow(); remainder.release(); store.remove({ id }); store.remove({ id });
  expect(store.reserve({ bytes: 50 })).toBeDefined();
});
it('does not consume a reservation on invalid retention or retain twice', () => {
  const store = createImageRecoveryStore({ capacity: 50 }), reservation = store.reserve({ bytes: 50 }), value = recovered();
  expect(() => reservation.retain({ ...value, files: [], retry: undefined })).toThrow();
  const id = reservation.retain({ ...value, retry: undefined });
  expect(() => reservation.retain({ ...value, retry: undefined })).toThrow();
  reservation.release(); expect(store.list()).toHaveLength(1); store.remove({ id });
  expect(store.reserve({ bytes: 50 })).toBeDefined();
});
export const TEST_ONLY = {
};
