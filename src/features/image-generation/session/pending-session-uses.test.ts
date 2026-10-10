import { expect, it } from 'vitest';
import { toImageGenerationRunId, toImageGenerationSessionId, toImageGenerationStoreId } from '@/01-models/ids';
import { createImagePendingSessionUses } from './pending-session-uses';

it('keeps retry identities independent of route objects and filters the original store', () => {
  const queue = createImagePendingSessionUses();
  const store = { storageType: 'opfs' as const, storeId: toImageGenerationStoreId({ raw: 'store-aa' }) };
  const other = { ...store, storeId: toImageGenerationStoreId({ raw: 'store-bb' }) };
  const accepted = { store, sessionId: toImageGenerationSessionId({ raw: 'session-aa' }), runId: toImageGenerationRunId({ raw: 'run-aa' }) };
  queue.add(accepted); queue.add(accepted);
  expect(queue.list({ store })).toEqual([accepted]); expect(queue.list({ store: other })).toEqual([]);
  const copy = queue.list({ store })[0]!; copy.store.storeId = other.storeId;
  expect(queue.list({ store })).toEqual([accepted]);
  queue.add({ ...accepted, store: other }); queue.complete(accepted);
  expect(queue.list({ store })).toEqual([]); expect(queue.list({ store: other })).toHaveLength(1);
});

it('removes a deleted session without losing another session or store retry', () => {
  const queue = createImagePendingSessionUses();
  const store = { storageType: 'opfs' as const, storeId: toImageGenerationStoreId({ raw: 'store-aa' }) };
  const other = { ...store, storeId: toImageGenerationStoreId({ raw: 'store-bb' }) };
  const sessionId = toImageGenerationSessionId({ raw: 'session-aa' });
  queue.add({ store, sessionId, runId: toImageGenerationRunId({ raw: 'run-aa' }) });
  queue.add({ store, sessionId: toImageGenerationSessionId({ raw: 'session-bb' }), runId: toImageGenerationRunId({ raw: 'run-bb' }) });
  queue.add({ store: other, sessionId, runId: toImageGenerationRunId({ raw: 'run-aa' }) });
  queue.removeSession({ store, sessionId });
  expect(queue.list({ store }).map(value => value.runId)).toEqual([toImageGenerationRunId({ raw: 'run-bb' })]);
  expect(queue.list({ store: other })).toHaveLength(1);
});
