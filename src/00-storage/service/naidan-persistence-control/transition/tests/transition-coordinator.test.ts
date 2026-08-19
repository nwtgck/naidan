import { describe, expect, it, vi } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import { parseTransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import type { TransitionNamespaceSourcePort, TransitionNamespaceTargetPort } from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';
import {
  advancePersistenceTransition,
  convergeInterruptedPersistenceTransition,
  startPersistenceTransition,
  type TransitionRuntimeProgress,
  type TransitionControlPort,
  type TransitionProgressPort,
  type TransitionSemanticState,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';
import {
  TransitionProviderAdapter,
  type TransitionEndpointDriver,
  type TransitionSourceEndpointSession,
  type TransitionTargetEndpointSession,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-provider-adapter';

const SOURCE_ID = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
const TARGET_ID = parsePortableFileSystemId({ value: 'ABCDEFGHIJ_0123456789' });
const OPERATION = parseTransitionOperationId({ value: 'transition_0123456789' });
const sourceEndpoint = { fileSystemId: SOURCE_ID, type: 'hizofs' } as const;
const targetEndpoint = { fileSystemId: TARGET_ID, type: 'hizofs' } as const;
const metadata = { createdAt: 1n, modifiedAt: 2n } as const;
const policy = {
  copy: { maximumBytesPerSlice: 2, maximumDirectoryEntriesPerRead: 1, maximumOperationsPerSlice: 2, maximumPathComponents: 16 },
  verification: { maximumBytesPerSlice: 2, maximumDirectoryEntriesPerRead: 1, maximumOperationsPerSlice: 2, maximumPathComponents: 16 },
} as const;

function control({ initial }: { initial: TransitionSemanticState }) {
  let state = initial;
  let throwAfterPublish = false;
  const port: TransitionControlPort = {
    publishState: async ({ state: next }) => {
      state = next;
      if (throwAfterPublish) {
        throwAfterPublish = false;
        throw new Error('simulated response loss after durable control publication');
      }
    },
    readState: async () => state,
  };
  return { get: () => state, loseNextResponse: () => {
    throwAfterPublish = true;
  }, port };
}

function progressPort(): TransitionProgressPort & { get(): TransitionRuntimeProgress | undefined } {
  let progress: TransitionRuntimeProgress | undefined;
  return {
    clear: async () => {
      progress = undefined;
    },
    get: () => progress,
    load: async () => progress,
    save: async ({ progress: next }) => {
      progress = structuredClone(next);
    },
  };
}

function namespacePorts() {
  const bytes = Uint8Array.from([1, 2, 3]);
  const written: number[] = [];
  const source: TransitionNamespaceSourcePort = {
    readRootMetadata: async () => metadata,
    listDirectory: async ({ afterName }) => afterName === undefined
      ? { entries: [{ kind: 'file', metadata, name: 'file', size: 3n }], state: 'complete' }
      : { entries: [], state: 'complete' },
    readFileChunk: async ({ maximumBytes, offset }) => {
      const chunk = bytes.slice(Number(offset), Number(offset) + maximumBytes);
      return { bytes: chunk, state: Number(offset) + chunk.byteLength === bytes.byteLength ? 'complete' : 'more' };
    },
    readSymlink: async () => {
      throw new Error('unexpected symlink');
    },
  };
  const targetRead: TransitionNamespaceSourcePort = {
    ...source,
    readFileChunk: async ({ maximumBytes, offset }) => {
      const chunk = Uint8Array.from(written.slice(Number(offset), Number(offset) + maximumBytes));
      return { bytes: chunk, state: Number(offset) + chunk.byteLength === written.length ? 'complete' : 'more' };
    },
  };
  const targetWrite: TransitionNamespaceTargetPort = {
    setRootMetadata: async ({ metadata: rootMetadata }) => {
      expect(rootMetadata).toEqual(metadata);
    },
    completeNamespace: async () => undefined,
    ensureDirectory: async () => undefined,
    finalizeFile: async () => undefined,
    writeFileChunk: async ({ bytes: chunk, offset }) => {
      written.splice(Number(offset), chunk.byteLength, ...chunk);
    },
    writeSymlink: async () => undefined,
  };
  return { source, targetRead, targetWrite, written };
}

function provider() {
  let sourceIdentity = 'source-v1';
  const ports = namespacePorts();
  const cleanup = vi.fn(async () => undefined);
  const discardStagedSliceState = vi.fn(async () => undefined);
  const finalized = vi.fn(async () => undefined);
  const stageSliceState = vi.fn(async () => undefined);
  const driver = ({ isTarget }: { isTarget: boolean }): TransitionEndpointDriver => ({
    cleanupEndpoint: cleanup,
    finalizeTarget: finalized,
    inspectEndpoint: async () => 'fully_verified',
    openSourceEndpoint: async (): Promise<TransitionSourceEndpointSession> => ({
      authorityIdentity: sourceIdentity,
      close: async () => undefined,
      source: ports.source,
    }),
    openTargetEndpoint: async (): Promise<TransitionTargetEndpointSession> => ({
      authorityIdentity: 'target-v1',
      close: async () => undefined,
      discardStagedSliceState,
      source: ports.targetRead,
      stageSliceState,
      target: isTarget ? ports.targetWrite : ports.targetWrite,
    }),
    prepareTarget: async () => undefined,
    verifyNormalOpen: async () => undefined,
  });
  return {
    adapter: new TransitionProviderAdapter({ hizofs: driver({ isTarget: true }), plain: driver({ isTarget: false }) }),
    cleanup,
    discardStagedSliceState,
    finalized,
    ports,
    setSourceIdentity: (value: string) => {
      sourceIdentity = value;
    },
    stageSliceState,
  };
}

async function runUntil({ controlPort, progress, providerAdapter, stop }: {
  controlPort: TransitionControlPort;
  progress: TransitionProgressPort;
  providerAdapter: TransitionProviderAdapter;
  stop: (state: string) => boolean;
}) {
  for (let attempts = 0; attempts < 30; attempts += 1) {
    const result = await advancePersistenceTransition({ control: controlPort, policy, progressPort: progress, provider: providerAdapter, signal: undefined });
    if (stop(result.state)) return result;
  }
  throw new Error('transition did not reach expected state');
}

describe('persisted transition coordinator', () => {

  it('treats the same persisted building transition as an idempotent start after response loss', async () => {
    const building = {
      operation: 're_encrypt',
      operationId: OPERATION,
      phase: { source: sourceEndpoint, target: targetEndpoint, type: 'building_target' },
      type: 'transitioning',
    } as const;
    const state = control({ initial: { mode: building, retiredFileSystemIds: [] } });
    await expect(startPersistenceTransition({ control: state.port, operationId: OPERATION, source: sourceEndpoint, target: targetEndpoint }))
      .resolves.toBeUndefined();
    await expect(startPersistenceTransition({
      control: state.port,
      operationId: parseTransitionOperationId({ value: 'different__0123456789' }),
      source: sourceEndpoint,
      target: targetEndpoint,
    })).rejects.toMatchObject({ code: 'transition_changed' });
  });

  it('publishes stable target authority before deferred source cleanup and retries cleanup idempotently', async () => {
    const cleaning = {
      operation: 're_encrypt',
      operationId: OPERATION,
      phase: { source: sourceEndpoint, target: targetEndpoint, type: 'cleaning_up_source' },
      type: 'transitioning',
    } as const;
    const state = control({ initial: { mode: cleaning, retiredFileSystemIds: [] } });
    const p = progressPort();
    const endpoints = provider();
    await expect(advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined }))
      .resolves.toEqual({ remainingRetiredFileSystemIds: 1, state: 'retired_cleanup' });
    expect(state.get()).toEqual({ mode: { activeFileSystemId: TARGET_ID, type: 'hizofs' }, retiredFileSystemIds: [SOURCE_ID] });
    endpoints.cleanup.mockRejectedValueOnce(new Error('cleanup interrupted'));
    await expect(advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined }))
      .rejects.toThrow('cleanup interrupted');
    expect(state.get().retiredFileSystemIds).toEqual([SOURCE_ID]);
    await expect(advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined }))
      .resolves.toEqual({ state: 'stable' });
  });
  it('publishes stable target authority before explicitly running deferred source cleanup', async () => {
    const state = control({ initial: { mode: { activeFileSystemId: SOURCE_ID, type: 'hizofs' }, retiredFileSystemIds: [] } });
    const p = progressPort();
    const endpoints = provider();
    await startPersistenceTransition({ control: state.port, operationId: OPERATION, source: sourceEndpoint, target: targetEndpoint });
    await runUntil({ controlPort: state.port, progress: p, providerAdapter: endpoints.adapter, stop: value => value === 'authority_switched' });
    expect(state.get().mode).toMatchObject({ phase: { type: 'cleaning_up_source' }, type: 'transitioning' });
    await expect(advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined }))
      .resolves.toEqual({ remainingRetiredFileSystemIds: 1, state: 'retired_cleanup' });
    expect(state.get()).toEqual({ mode: { activeFileSystemId: TARGET_ID, type: 'hizofs' }, retiredFileSystemIds: [SOURCE_ID] });
    expect(endpoints.cleanup).not.toHaveBeenCalled();
    await expect(advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined }))
      .resolves.toEqual({ state: 'stable' });
    expect(state.get()).toEqual({ mode: { activeFileSystemId: TARGET_ID, type: 'hizofs' }, retiredFileSystemIds: [] });
    expect(endpoints.cleanup).toHaveBeenCalledWith({ endpoint: sourceEndpoint });
    expect(p.get()).toBeUndefined();
  });

  it('discards staged target state when portable progress publication fails', async () => {
    const state = control({ initial: { mode: { activeFileSystemId: SOURCE_ID, type: 'hizofs' }, retiredFileSystemIds: [] } });
    const endpoints = provider();
    const progress: TransitionProgressPort = {
      clear: async () => undefined,
      load: async () => undefined,
      save: async () => {
        throw new Error('simulated progress publication failure');
      },
    };
    await startPersistenceTransition({ control: state.port, operationId: OPERATION, source: sourceEndpoint, target: targetEndpoint });

    await expect(advancePersistenceTransition({
      control: state.port,
      policy,
      progressPort: progress,
      provider: endpoints.adapter,
      signal: undefined,
    })).rejects.toThrow('simulated progress publication failure');

    expect(endpoints.stageSliceState).toHaveBeenCalledTimes(1);
    expect(endpoints.discardStagedSliceState).toHaveBeenCalledTimes(1);
  });

  it('continues bounded copy slices with invocation-local progress', async () => {
    const state = control({ initial: { mode: { activeFileSystemId: SOURCE_ID, type: 'hizofs' }, retiredFileSystemIds: [] } });
    const p = progressPort();
    const endpoints = provider();
    await startPersistenceTransition({ control: state.port, operationId: OPERATION, source: sourceEndpoint, target: targetEndpoint });
    const first = await advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined });
    expect(first.state).toBe('copying');
    const runtimeProgress = p.get();
    expect(runtimeProgress?.stage).toBe('copying');
    await runUntil({ controlPort: state.port, progress: p, providerAdapter: endpoints.adapter, stop: value => value === 'authority_switched' });
    expect(endpoints.ports.written).toEqual([1, 2, 3]);
  });

  it('does not roll back to the source after authority-switch response loss', async () => {
    const state = control({ initial: { mode: { activeFileSystemId: SOURCE_ID, type: 'hizofs' }, retiredFileSystemIds: [] } });
    const p = progressPort();
    const endpoints = provider();
    await startPersistenceTransition({ control: state.port, operationId: OPERATION, source: sourceEndpoint, target: targetEndpoint });
    state.loseNextResponse();
    let responseLost = false;
    for (let attempts = 0; attempts < 30; attempts += 1) {
      try {
        await advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined });
      } catch (cause: unknown) {
        expect(cause).toBeInstanceOf(Error);
        expect((cause as Error).message).toContain('response loss');
        responseLost = true;
        break;
      }
    }
    expect(responseLost).toBe(true);
    expect(state.get().mode).toMatchObject({ phase: { type: 'cleaning_up_source' } });
    await expect(advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined }))
      .resolves.toEqual({ remainingRetiredFileSystemIds: 1, state: 'retired_cleanup' });
    await expect(advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined }))
      .resolves.toEqual({ state: 'stable' });
    expect(state.get()).toEqual({ mode: { activeFileSystemId: TARGET_ID, type: 'hizofs' }, retiredFileSystemIds: [] });
  });

  it('publishes stable plain authority before deleting the HizoFS source', async () => {
    const plain = { type: 'plain' } as const;
    const cleaning = {
      operation: 'decrypt',
      operationId: OPERATION,
      phase: { source: sourceEndpoint, target: plain, type: 'cleaning_up_source' },
      type: 'transitioning',
    } as const;
    const state = control({ initial: { mode: cleaning, retiredFileSystemIds: [] } });
    const endpoints = provider();
    const result = await advancePersistenceTransition({
      control: state.port,
      policy,
      progressPort: progressPort(),
      provider: endpoints.adapter,
      signal: undefined,
    });
    expect(result).toEqual({ remainingRetiredFileSystemIds: 1, state: 'retired_cleanup' });
    expect(state.get()).toEqual({ mode: { type: 'plain' }, retiredFileSystemIds: [SOURCE_ID] });
    expect(endpoints.cleanup).not.toHaveBeenCalled();
    await advancePersistenceTransition({ control: state.port, policy, progressPort: progressPort(), provider: endpoints.adapter, signal: undefined });
    expect(endpoints.cleanup).toHaveBeenCalledWith({ endpoint: sourceEndpoint });
  });

  it('publishes stable plain authority before releasing its runtime target marker', async () => {
    const plain = { type: 'plain' } as const;
    const cleaning = {
      operation: 'decrypt',
      operationId: OPERATION,
      phase: { source: sourceEndpoint, target: plain, type: 'cleaning_up_source' },
      type: 'transitioning',
    } as const;
    let semanticState: TransitionSemanticState = { mode: cleaning, retiredFileSystemIds: [] };
    const events: string[] = [];
    const controlPort: TransitionControlPort = {
      publishState: async ({ state }) => {
        semanticState = state;
        events.push(state.mode.type === 'plain' ? 'stable-plain' : 'other-state');
      },
      readState: async () => semanticState,
    };
    const markerProgress: TransitionProgressPort = {
      clear: async () => {
        expect(semanticState.mode.type).toBe('plain');
        events.push('marker-clear');
      },
      load: async () => undefined,
      save: async () => undefined,
    };

    await advancePersistenceTransition({
      control: controlPort,
      policy,
      progressPort: markerProgress,
      provider: provider().adapter,
      signal: undefined,
    });

    expect(events).toEqual(['stable-plain', 'marker-clear']);
  });

  it('rejects a source authority change between bounded slices', async () => {
    const state = control({ initial: { mode: { activeFileSystemId: SOURCE_ID, type: 'hizofs' }, retiredFileSystemIds: [] } });
    const p = progressPort();
    const endpoints = provider();
    await startPersistenceTransition({ control: state.port, operationId: OPERATION, source: sourceEndpoint, target: targetEndpoint });
    await advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined });
    endpoints.setSourceIdentity('source-v2');
    await expect(advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: endpoints.adapter, signal: undefined }))
      .rejects.toMatchObject({ code: 'progress_conflict' });
  });

  it('rejects a stale progress cursor from another operation', async () => {
    const state = control({ initial: {
      mode: { operation: 're_encrypt', operationId: OPERATION, phase: { source: sourceEndpoint, target: targetEndpoint, type: 'building_target' }, type: 'transitioning' },
      retiredFileSystemIds: [],
    } });
    const p = progressPort();
    await p.save({ progress: {
      copyCursor: { activeFile: undefined, completedBytes: 0n, completedEntries: 0n, directories: [], state: 'complete' },
      operationId: parseTransitionOperationId({ value: 'different__0123456789' }),
      source: sourceEndpoint,
      sourceAuthorityIdentity: 'source-v1',
      stage: 'copying',
      target: targetEndpoint,
    } });
    await expect(advancePersistenceTransition({ control: state.port, policy, progressPort: p, provider: provider().adapter, signal: undefined }))
      .rejects.toMatchObject({ code: 'progress_conflict' });
  });
});


describe('interrupted transition phase convergence', () => {
  it('publishes stable source and clears invocation-local progress before returning', async () => {
    const building = {
      mode: {
        operation: 're_encrypt',
        operationId: OPERATION,
        phase: { source: sourceEndpoint, target: targetEndpoint, type: 'building_target' },
        type: 'transitioning',
      },
      retiredFileSystemIds: [],
    } as const;
    const state = control({ initial: building });
    const clear = vi.fn(async () => undefined);

    await expect(convergeInterruptedPersistenceTransition({
      control: state.port,
      progressPort: { clear },
    })).resolves.toEqual({
      authoritativeEndpoint: 'source',
      stableState: {
        mode: { activeFileSystemId: SOURCE_ID, type: 'hizofs' },
        retiredFileSystemIds: [TARGET_ID],
      },
    });
    expect(state.get()).toEqual({
      mode: { activeFileSystemId: SOURCE_ID, type: 'hizofs' },
      retiredFileSystemIds: [TARGET_ID],
    });
    expect(clear).toHaveBeenCalledWith({ operationId: OPERATION });
  });

  it('publishes stable target without waiting for retired source cleanup after the switch', async () => {
    const cleaning = {
      mode: {
        operation: 're_encrypt',
        operationId: OPERATION,
        phase: { source: sourceEndpoint, target: targetEndpoint, type: 'cleaning_up_source' },
        type: 'transitioning',
      },
      retiredFileSystemIds: [],
    } as const;
    const state = control({ initial: cleaning });

    await expect(convergeInterruptedPersistenceTransition({
      control: state.port,
      progressPort: { clear: async () => undefined },
    })).resolves.toEqual({
      authoritativeEndpoint: 'target',
      stableState: {
        mode: { activeFileSystemId: TARGET_ID, type: 'hizofs' },
        retiredFileSystemIds: [SOURCE_ID],
      },
    });
  });

  it('leaves durable stable authority selected when progress clearing loses its response', async () => {
    const building = {
      mode: {
        operation: 'encrypt',
        operationId: OPERATION,
        phase: { source: { type: 'plain' }, target: targetEndpoint, type: 'building_target' },
        type: 'transitioning',
      },
      retiredFileSystemIds: [],
    } as const;
    const state = control({ initial: building });

    await expect(convergeInterruptedPersistenceTransition({
      control: state.port,
      progressPort: { clear: async () => {
        throw new Error('lost clear response');
      } },
    })).rejects.toThrow('lost clear response');
    expect(state.get()).toEqual({
      mode: { type: 'plain' },
      retiredFileSystemIds: [TARGET_ID],
    });
  });
});
