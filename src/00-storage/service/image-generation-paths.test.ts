import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBinaryObjectId, toImageGenerationAssetId, toImageGenerationRunId, toImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationAsset, ImageGenerationRun, ImageGenerationSession, ImageGenerationSessionDraft } from '@/01-models/image-generation';
import * as service from './image-generation';
import { createImageGenerationStorageHarness, generationAssetFixture, generationDraftFixture, generationRunFixture, generationSessionFixture } from './image-generation/test-support';

let fs: ReturnType<typeof createImageGenerationStorageHarness>;

beforeEach(() => {
  fs = createImageGenerationStorageHarness();
});

afterEach(() => vi.unstubAllGlobals());

async function ready() {
  const catalog = await service.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' });
  if (!catalog) throw new Error('Missing fixture catalog.');
  fs.getDirectory.mockClear();
  fs.acquired.length = 0;
  fs.reads.length = 0;
  fs.writes.length = 0;
  return { storageType: 'opfs' as const, storeId: catalog.id };
}

function expectNoStorageAccess(): void {
  expect(fs.getDirectory).not.toHaveBeenCalled();
  expect(fs.acquired).toEqual([]);
  expect(fs.reads).toEqual([]);
  expect(fs.writes).toEqual([]);
}

describe('image persistence path preflight', () => {
  it.each(['', 'a', '.', '..', '/ab', 'a/b', 'a\\b', 'a\u0000b', 'a'.repeat(129)])('rejects session path components before any storage access: %j', async raw => {
    const store = await ready();
    await expect(service.loadImageGenerationSession({ store, sessionId: toImageGenerationSessionId({ raw }) })).rejects.toThrow();
    expectNoStorageAccess();
    await expect(service.saveImageGenerationSession({ store, session: generationSessionFixture({ id: raw }), expectedRevision: undefined })).rejects.toThrow();
    expectNoStorageAccess();
  });

  const mutations: {
    name: string,
    mutate: ({ raw, session, draft, run, asset }: {
      raw: string, session: ImageGenerationSession, draft: ImageGenerationSessionDraft, run: ImageGenerationRun, asset: ImageGenerationAsset,
    }) => 'session' | 'draft' | 'run' | 'asset',
  }[] = [
    {
      name: 'session id',
      mutate: ({ raw, session }) => {
        session.id = toImageGenerationSessionId({ raw }); return 'session';
      },
    },
    {
      name: 'draft session',
      mutate: ({ raw, draft }) => {
        draft.sessionId = toImageGenerationSessionId({ raw }); return 'draft';
      },
    },
    {
      name: 'draft initial input',
      mutate: ({ raw, draft }) => {
        draft.request.imageInputs.initImage = { binaryObjectId: toBinaryObjectId({ raw }), name: 'input.png' }; return 'draft';
      },
    },
    {
      name: 'draft reference input',
      mutate: ({ raw, draft }) => {
        draft.request.imageInputs.referenceImages.push({ binaryObjectId: toBinaryObjectId({ raw }), name: 'reference.png' }); return 'draft';
      },
    },
    {
      name: 'run id',
      mutate: ({ raw, run }) => {
        run.id = toImageGenerationRunId({ raw }); return 'run';
      },
    },
    {
      name: 'run session',
      mutate: ({ raw, run }) => {
        run.sessionId = toImageGenerationSessionId({ raw }); return 'run';
      },
    },
    {
      name: 'source session',
      mutate: ({ raw, run }) => {
        run.sources.push({ role: 'settings', sessionId: toImageGenerationSessionId({ raw }), assetId: toImageGenerationAssetId({ raw: 'source-aa' }) }); return 'run';
      },
    },
    {
      name: 'source asset',
      mutate: ({ raw, run }) => {
        run.sources.push({ role: 'settings', sessionId: run.sessionId, assetId: toImageGenerationAssetId({ raw }) }); return 'run';
      },
    },
    {
      name: 'run initial input',
      mutate: ({ raw, run }) => {
        run.request.imageInputs.initImage = { binaryObjectId: toBinaryObjectId({ raw }), name: 'input.png' }; return 'run';
      },
    },
    {
      name: 'run reference input',
      mutate: ({ raw, run }) => {
        run.request.imageInputs.referenceImages.push({ binaryObjectId: toBinaryObjectId({ raw }), name: 'reference.png' }); return 'run';
      },
    },
    {
      name: 'asset id',
      mutate: ({ raw, asset }) => {
        asset.id = toImageGenerationAssetId({ raw }); return 'asset';
      },
    },
    {
      name: 'asset session',
      mutate: ({ raw, asset }) => {
        asset.sessionId = toImageGenerationSessionId({ raw }); return 'asset';
      },
    },
    {
      name: 'asset run',
      mutate: ({ raw, asset }) => {
        asset.runId = toImageGenerationRunId({ raw }); return 'asset';
      },
    },
    {
      name: 'asset result binary',
      mutate: ({ raw, asset }) => {
        asset.result.binaryObjectId = toBinaryObjectId({ raw }); return 'asset';
      },
    },
    {
      name: 'asset preview binary',
      mutate: ({ raw, asset }) => {
        asset.previews.push({ binaryObjectId: toBinaryObjectId({ raw }), width: 128, height: 128, step: 2, steps: 9, mode: 'projection' }); return 'asset';
      },
    },
  ];

  it.each(mutations)('preflights $name before storage and publication callbacks', async ({ mutate }) => {
    const store = await ready();
    const session = generationSessionFixture({ id: 'session-aa' });
    const draft = generationDraftFixture({ sessionId: session.id });
    const run = generationRunFixture({ id: 'run-aa', sessionId: session.id, count: 1, seed: '42' });
    const asset = generationAssetFixture({ id: 'asset-aa', run, index: 0 });
    const publish = vi.fn(async () => {});
    const kind = mutate({ raw: '../escape', session, draft, run, asset });
    switch (kind) {
    case 'session': await expect(service.saveImageGenerationSession({ store, session, expectedRevision: undefined })).rejects.toThrow(); break;
    case 'draft': await expect(service.saveImageGenerationDraft({ store, draft, expectedRevision: undefined, writeInputs: publish })).rejects.toThrow(); break;
    case 'run': await expect(service.createImageGenerationRun({ store, run, writeInputs: publish })).rejects.toThrow(); break;
    case 'asset': await expect(service.commitImageGenerationAsset({ store, asset, writeImages: publish })).rejects.toThrow(); break;
    default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
    }
    expect(publish).not.toHaveBeenCalled();
    expectNoStorageAccess();
  });

  it.each(['aa', 'a'.repeat(128), '__proto__', 'constructor', 'A_-Z'])('keeps safe path identities usable: %s', async id => {
    const store = await ready();
    const session = generationSessionFixture({ id });
    const saved = await service.saveImageGenerationSession({ store, session, expectedRevision: undefined });
    expect(await service.loadImageGenerationSession({ store, sessionId: session.id })).toEqual(saved);
  });
});
