import { expect, it } from 'vitest';
import { toImageGenerationOperationId, toImageGenerationRunId, toImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationOperation, ImageGenerationRunSummary } from '@/01-models/image-generation';
import { groupImageGenerationOperations } from './presentation';
const sessionId = toImageGenerationSessionId({ raw: 'session-aa' });

function group({ id, createdAt }: { id: string, createdAt: number }) {
  const run: ImageGenerationRunSummary = { id: toImageGenerationRunId({ raw: id }), sessionId, revision: 0, createdAt, execution: { type: 'queued' }, operationId: undefined, prompt: id, modelName: 'model.gguf', requestedCount: 1 };
  return { run, images: [] };
}

it('preserves accepted request order and distinct prompt groups within each operation', () => {
  const a = group({ id: 'run-aa', createdAt: 2 }), b = group({ id: 'run-bb', createdAt: 3 });
  const c = group({ id: 'run-cc', createdAt: 4 });
  const older: ImageGenerationOperation = { id: toImageGenerationOperationId({ raw: 'operation-aa' }), sessionId, createdAt: 2, runIds: [a.run.id, b.run.id] };
  const newer: ImageGenerationOperation = { id: toImageGenerationOperationId({ raw: 'operation-bb' }), sessionId, createdAt: 4, runIds: [c.run.id] };
  const result = groupImageGenerationOperations({ groups: [c, b, a], operations: [older, newer] });
  expect(result.map(entry => entry.groups.map(item => item.run.prompt))).toEqual([['run-cc'], ['run-aa', 'run-bb']]);
  expect(result[1]!.operation).toBe(older);
});

it('does not invent an exportable operation for unaccepted runs or empty filtered groups', () => {
  const visible = group({ id: 'run-aa', createdAt: 2 }), orphan = group({ id: 'run-orphan', createdAt: 3 });
  const operation: ImageGenerationOperation = { id: toImageGenerationOperationId({ raw: 'operation-aa' }), sessionId, createdAt: 2, runIds: [visible.run.id, toImageGenerationRunId({ raw: 'run-hidden' })] };
  const result = groupImageGenerationOperations({ groups: [orphan, visible], operations: [operation] });
  expect(result).toHaveLength(2);
  expect(result[0]!.operation).toBeUndefined();
  expect(result[1]!.groups).toEqual([visible]);
  expect(groupImageGenerationOperations({ groups: [], operations: [operation] })).toEqual([]);
});
