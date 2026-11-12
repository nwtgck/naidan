import { beforeEach, expect, it, vi } from 'vitest';
import { generationAssetFixture, generationRunFixture } from '@/00-storage/service/image-generation/index.test-support';
import type { ImageGenerationAssetSummary } from '@/01-models/image-generation';
import { toImageGenerationSessionId } from '@/01-models/ids';
import { createImageGenerationQueryWorker } from './impl';
import { generationQueryResultSchema } from './types';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/00-storage/service/image-generation', () => ({ readImageGenerationSessionIndex: mocks.read }));

beforeEach(() => vi.resetAllMocks());

it('counts saved confirmed images independently of gallery filters and excludes unconfirmed or deleting images', async () => {
  const sessionId = toImageGenerationSessionId({ raw: 'session-aa' });
  const runs = ['run-aa', 'run-bb'].map(id => generationRunFixture({ id, sessionId, count: 3, seed: '42' }));
  const assets: ImageGenerationAssetSummary[] = Array.from({ length: 6 }, (_, index) => {
    const asset = generationAssetFixture({ id: `asset-${index}`, run: runs[index < 3 ? 0 : 1]!, index: index % 3 });
    const { result, previews, ...metadata } = asset;
    return { ...metadata, binaryObjectId: result.binaryObjectId, width: result.width, height: result.height, previewCount: previews.length, ...(index === 2 ? { confirmation: 'unconfirmed' as const } : {}) };
  });
  const states = ['active', 'archived', 'active', 'deleting', 'deleted', 'active'] as const;
  mocks.read.mockResolvedValue({
    assets: { items: assets, warnings: [], warningCount: 0 },
    annotations: { items: assets.map((asset, index) => ({ assetId: asset.id, sessionId, revision: 0, state: states[index]!, tags: [] })), warnings: [], warningCount: 0 },
    runs: { items: runs.map(({ id, createdAt, execution }) => ({ id, sessionId, revision: 0, createdAt, execution, prompt: 'source prompt', modelName: 'model', requestedCount: 3 })), warnings: [], warningCount: 0 },
  });
  const worker = createImageGenerationQueryWorker();
  const result = generationQueryResultSchema.parse(await worker.query({
    request: {
      store: { storageType: 'opfs', storeId: 'store-aa' },
      sessionId: 'session-aa',
      query: { visibility: 'active', text: 'no matching prompt', tags: [], match: 'all', runId: undefined, cursor: undefined, limit: 1 },
    },
  }));
  expect(result.page.items).toEqual([]);
  expect(result.savedImageCounts).toEqual([{ runId: runs[0]!.id, count: 2 }, { runId: runs[1]!.id, count: 1 }]);
});
