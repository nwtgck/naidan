import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueuedTestLockManager } from '@/00-storage/service/hizofs/test-lock-manager';
import { HizoFSActiveStateCoordinator, TEST_ONLY } from './active-state-coordinator';
import type { HizoFSActiveState } from './active-state';
import { createHizoFSRuntimeDiagnostics } from './diagnostics';

function createState({ sequence, commitObjectId, inodeIndexRootObjectId }: {
  sequence: number;
  commitObjectId: string;
  inodeIndexRootObjectId: string;
}): HizoFSActiveState {
  return {
    superblock: {
      sequence,
      fileSystemId: 'coordinator-test-filesystem',
      subvolumeDescriptorObjectId: 'subvolume-descriptor',
      activeCommitObjectId: commitObjectId,
    },
    subvolumeDescriptorObjectId: 'descriptor',
    subvolumeDescriptor: {
      subvolumeId: 'root-subvolume',
      access: 'read_write',
    },
    commitObjectId,
    commit: {
      revision: sequence,
      publicationId: `publication-${String(sequence)}`,
      subvolumeId: 'root-subvolume',
      rootDirectoryNodeId: 'root-directory',
      inodeIndexRootObjectId,
      subvolumeMountIndexRootObjectId: 'subvolume-mount-index',
    },
    stateSelection: 'current',
  };
}

const originalLocks = navigator.locks;

afterEach(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: originalLocks,
  });
});

describe('HizoFS active-state coordinator', () => {
  it('keeps local leaders isolated by subvolume coordination scope', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    const localCoordinationIdentity = {};
    const fileSystemId = `coordinator-${crypto.randomUUID()}`;
    const rootState = createState({
      sequence: 1,
      commitObjectId: 'root-commit',
      inodeIndexRootObjectId: 'root-index',
    });
    const childState = createState({
      sequence: 2,
      commitObjectId: 'child-commit',
      inodeIndexRootObjectId: 'child-index',
    });
    const rootLoad = vi.fn(async () => rootState);
    const childLoad = vi.fn(async () => childState);
    const createCoordinator = ({
      coordinationScope,
      loadFromBacking,
    }: {
      coordinationScope: string;
      loadFromBacking: () => Promise<HizoFSActiveState>;
    }) => new HizoFSActiveStateCoordinator({
      fileSystemId,
      fileSystemInstanceId: fileSystemId,
      coordinationScope,
      localCoordinationIdentity,
      loadFromBacking,
      publishFromState: async () => {
        throw new Error('Unexpected publication');
      },
      setHeadHandleRetention: async () => {},
      diagnostics: undefined,
    });
    const root = createCoordinator({
      coordinationScope: 'root',
      loadFromBacking: rootLoad,
    });
    const child = createCoordinator({
      coordinationScope: 'subvolume/child',
      loadFromBacking: childLoad,
    });
    try {
      await expect(root.loadActiveState()).resolves.toMatchObject({
        commitObjectId: 'root-commit',
      });
      await expect(child.loadActiveState()).resolves.toMatchObject({
        commitObjectId: 'child-commit',
      });
      expect(rootLoad).toHaveBeenCalledTimes(1);
      expect(childLoad).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([root.close(), child.close()]);
    }
  });

  it('isolates local leaders by both filesystem instance and cryptographic identity', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    const localCoordinationIdentity = {};
    const baselineState = createState({
      sequence: 1,
      commitObjectId: 'baseline-commit',
      inodeIndexRootObjectId: 'baseline-index',
    });
    const anotherKeyState = createState({
      sequence: 2,
      commitObjectId: 'another-key-commit',
      inodeIndexRootObjectId: 'another-key-index',
    });
    const anotherInstanceState = createState({
      sequence: 3,
      commitObjectId: 'another-instance-commit',
      inodeIndexRootObjectId: 'another-instance-index',
    });
    const baselineLoad = vi.fn(async () => baselineState);
    const anotherKeyLoad = vi.fn(async () => anotherKeyState);
    const anotherInstanceLoad = vi.fn(async () => anotherInstanceState);
    const createCoordinator = ({
      fileSystemId,
      fileSystemInstanceId,
      loadFromBacking,
    }: {
      fileSystemId: string;
      fileSystemInstanceId: string;
      loadFromBacking: () => Promise<HizoFSActiveState>;
    }) => new HizoFSActiveStateCoordinator({
      fileSystemId,
      fileSystemInstanceId,
      coordinationScope: 'root',
      localCoordinationIdentity,
      loadFromBacking,
      publishFromState: async () => {
        throw new Error('Unexpected publication');
      },
      setHeadHandleRetention: async () => {},
      diagnostics: undefined,
    });
    const baseline = createCoordinator({
      fileSystemId: 'root-key-a',
      fileSystemInstanceId: 'instance-a',
      loadFromBacking: baselineLoad,
    });
    const anotherKey = createCoordinator({
      fileSystemId: 'root-key-b',
      fileSystemInstanceId: 'instance-a',
      loadFromBacking: anotherKeyLoad,
    });
    const anotherInstance = createCoordinator({
      fileSystemId: 'root-key-a',
      fileSystemInstanceId: 'instance-b',
      loadFromBacking: anotherInstanceLoad,
    });
    try {
      await expect(baseline.loadActiveState()).resolves.toMatchObject({
        commitObjectId: 'baseline-commit',
      });
      await expect(anotherKey.loadActiveState()).resolves.toMatchObject({
        commitObjectId: 'another-key-commit',
      });
      await expect(anotherInstance.loadActiveState()).resolves.toMatchObject({
        commitObjectId: 'another-instance-commit',
      });
      expect(baselineLoad).toHaveBeenCalledTimes(1);
      expect(anotherKeyLoad).toHaveBeenCalledTimes(1);
      expect(anotherInstanceLoad).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([
        baseline.close(),
        anotherKey.close(),
        anotherInstance.close(),
      ]);
    }
  });

  it('serializes slow duplicate remote requests and reloads only on failover', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createQueuedTestLockManager({ onRequest: undefined }),
    });
    let persistedState = createState({
      sequence: 1,
      commitObjectId: 'commit-1',
      inodeIndexRootObjectId: 'index-1',
    });
    const leaderLoads = vi.fn(async () => persistedState);
    const followerLoads = vi.fn(async () => persistedState);
    let publicationCount = 0;
    const publish = async ({ currentState, inodeIndexRootObjectId }: {
      currentState: HizoFSActiveState;
      inodeIndexRootObjectId: string;
    }): Promise<HizoFSActiveState> => {
      publicationCount += 1;
      await new Promise(resolve => setTimeout(resolve, 80));
      persistedState = createState({
        sequence: currentState.superblock.sequence + 1,
        commitObjectId: `commit-${currentState.superblock.sequence + 1}`,
        inodeIndexRootObjectId,
      });
      return persistedState;
    };
    const leaderDiagnostics = createHizoFSRuntimeDiagnostics();
    const followerDiagnostics = createHizoFSRuntimeDiagnostics();
    const leaderRetention: string[] = [];
    const followerRetention: string[] = [];
    const fileSystemId = `coordinator-${crypto.randomUUID()}`;
    const leader = new HizoFSActiveStateCoordinator({
      fileSystemId,
      fileSystemInstanceId: fileSystemId,
      coordinationScope: 'root',
      localCoordinationIdentity: {},
      loadFromBacking: leaderLoads,
      publishFromState: publish,
      setHeadHandleRetention: async ({ retention }) => {
        leaderRetention.push(retention);
      },
      diagnostics: leaderDiagnostics,
    });
    const follower = new HizoFSActiveStateCoordinator({
      fileSystemId,
      fileSystemInstanceId: fileSystemId,
      coordinationScope: 'root',
      localCoordinationIdentity: {},
      loadFromBacking: followerLoads,
      publishFromState: publish,
      setHeadHandleRetention: async ({ retention }) => {
        followerRetention.push(retention);
      },
      diagnostics: followerDiagnostics,
    });

    try {
      const leaderState = await leader.loadActiveState();
      expect(leaderState).toEqual(persistedState);
      expect(Object.isFrozen(leaderState)).toBe(true);
      expect(Object.isFrozen(leaderState.superblock)).toBe(true);
      expect(Object.isFrozen(leaderState.commit)).toBe(true);
      expect(Reflect.set(leaderState.commit, 'revision', 999)).toBe(false);
      await expect(follower.loadActiveState()).resolves.toEqual(persistedState);
      expect(leaderLoads).toHaveBeenCalledTimes(1);
      expect(followerLoads).not.toHaveBeenCalled();

      const flushPreparedRecords = vi.fn(async () => {});
      await expect(follower.publish({
        publicationId: 'remote-publication',
        expectedCommitObjectId: 'commit-1',
        expectedRevision: 1,
        inodeIndexRootObjectId: 'index-2',
        subvolumeMountIndexRootObjectId: 'subvolume-mount-index',
        flushPreparedRecords,
      })).resolves.toMatchObject({ type: 'published' });
      expect(flushPreparedRecords).toHaveBeenCalledTimes(1);
      expect(publicationCount).toBe(1);
      await expect(leader.loadActiveState()).resolves.toEqual(persistedState);
      expect(leaderLoads).toHaveBeenCalledTimes(1);

      await leader.close();
      await expect(follower.loadActiveState()).resolves.toEqual(persistedState);
      expect(followerLoads).toHaveBeenCalledTimes(1);
      expect(followerDiagnostics.snapshot().coordinator.failovers).toBe(1);
      expect(leaderRetention).toEqual(['persistent', 'ephemeral']);
      expect(followerRetention).toContain('persistent');
    } finally {
      await follower.close();
      await leader.close();
    }
  });


  it('lets the authoritative runtime combine prepared records with head publication', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    let persistedState = createState({
      sequence: 1,
      commitObjectId: 'commit-1',
      inodeIndexRootObjectId: 'index-1',
    });
    const flushPreparedRecords = vi.fn(async () => {});
    const coordinator = new HizoFSActiveStateCoordinator({
      fileSystemId: 'file-system-id',
      fileSystemInstanceId: `coordinator-${crypto.randomUUID()}`,
      coordinationScope: 'root',
      localCoordinationIdentity: {},
      loadFromBacking: async () => persistedState,
      publishFromState: async ({ currentState, inodeIndexRootObjectId }) => {
        persistedState = createState({
          sequence: currentState.superblock.sequence + 1,
          commitObjectId: 'commit-2',
          inodeIndexRootObjectId,
        });
        return persistedState;
      },
      setHeadHandleRetention: async () => {},
      diagnostics: undefined,
    });

    try {
      await coordinator.loadActiveState();
      await expect(coordinator.publish({
        publicationId: 'local-publication',
        expectedCommitObjectId: 'commit-1',
        expectedRevision: 1,
        inodeIndexRootObjectId: 'index-2',
        subvolumeMountIndexRootObjectId: 'subvolume-mount-index',
        flushPreparedRecords,
      })).resolves.toMatchObject({ type: 'published' });
      expect(flushPreparedRecords).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
    }
  });


  it('serves the previous complete state while a publication is still durable-pending', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    const initialState = createState({
      sequence: 1,
      commitObjectId: 'commit-1',
      inodeIndexRootObjectId: 'index-1',
    });
    const publicationStarted = Promise.withResolvers<void>();
    const releasePublication = Promise.withResolvers<void>();
    const coordinator = new HizoFSActiveStateCoordinator({
      fileSystemId: 'file-system-id',
      fileSystemInstanceId: `coordinator-${crypto.randomUUID()}`,
      coordinationScope: 'root',
      localCoordinationIdentity: {},
      loadFromBacking: async () => initialState,
      publishFromState: async ({ currentState, inodeIndexRootObjectId }) => {
        publicationStarted.resolve();
        await releasePublication.promise;
        return createState({
          sequence: currentState.superblock.sequence + 1,
          commitObjectId: 'commit-2',
          inodeIndexRootObjectId,
        });
      },
      setHeadHandleRetention: async () => {},
      diagnostics: undefined,
    });

    try {
      await coordinator.loadActiveState();
      const publication = coordinator.publish({
        publicationId: 'pending-publication',
        expectedCommitObjectId: 'commit-1',
        expectedRevision: 1,
        inodeIndexRootObjectId: 'index-2',
        subvolumeMountIndexRootObjectId: 'subvolume-mount-index',
        flushPreparedRecords: async () => {},
      });
      await publicationStarted.promise;
      await expect(coordinator.loadActiveState()).resolves.toEqual(initialState);
      releasePublication.resolve();
      await expect(publication).resolves.toMatchObject({ type: 'published' });
      await expect(coordinator.loadActiveState()).resolves.toMatchObject({
        commitObjectId: 'commit-2',
      });
    } finally {
      releasePublication.resolve();
      await coordinator.close();
    }
  });

  it('linearizes current-state checks behind an in-flight publication', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    const initialState = createState({
      sequence: 1,
      commitObjectId: 'commit-1',
      inodeIndexRootObjectId: 'index-1',
    });
    const publicationStarted = Promise.withResolvers<void>();
    const releasePublication = Promise.withResolvers<void>();
    const coordinator = new HizoFSActiveStateCoordinator({
      fileSystemId: 'file-system-id',
      fileSystemInstanceId: `coordinator-${crypto.randomUUID()}`,
      coordinationScope: 'root',
      localCoordinationIdentity: {},
      loadFromBacking: async () => initialState,
      publishFromState: async ({ currentState, inodeIndexRootObjectId }) => {
        publicationStarted.resolve();
        await releasePublication.promise;
        return createState({
          sequence: currentState.superblock.sequence + 1,
          commitObjectId: 'commit-2',
          inodeIndexRootObjectId,
        });
      },
      setHeadHandleRetention: async () => {},
      diagnostics: undefined,
    });

    try {
      await coordinator.loadActiveState();
      const publication = coordinator.publish({
        publicationId: 'linearized-publication',
        expectedCommitObjectId: 'commit-1',
        expectedRevision: 1,
        inodeIndexRootObjectId: 'index-2',
        subvolumeMountIndexRootObjectId: 'subvolume-mount-index',
        flushPreparedRecords: async () => {},
      });
      await publicationStarted.promise;
      const currentCheck = coordinator.isCurrent({
        commitObjectId: 'commit-1',
      });
      let currentCheckSettled = false;
      void currentCheck.finally(() => {
        currentCheckSettled = true;
      });
      await Promise.resolve();
      expect(currentCheckSettled).toBe(false);

      releasePublication.resolve();
      await expect(publication).resolves.toMatchObject({ type: 'published' });
      await expect(currentCheck).resolves.toBe(false);
    } finally {
      releasePublication.resolve();
      await coordinator.close();
    }
  });

  it('recognizes a durable publication after the response is lost', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    const committedState = createState({
      sequence: 2,
      commitObjectId: 'commit-2',
      inodeIndexRootObjectId: 'index-2',
    });
    const publishFromState = vi.fn(async () => {
      throw new Error('publication must not run twice');
    });
    const coordinator = new HizoFSActiveStateCoordinator({
      fileSystemId: 'file-system-id',
      fileSystemInstanceId: `coordinator-${crypto.randomUUID()}`,
      coordinationScope: 'root',
      localCoordinationIdentity: {},
      loadFromBacking: async () => ({
        ...committedState,
        commit: {
          ...committedState.commit,
          publicationId: 'already-published',
        },
      }),
      publishFromState,
      setHeadHandleRetention: async () => {},
      diagnostics: undefined,
    });

    try {
      await expect(coordinator.publish({
        publicationId: 'already-published',
        expectedCommitObjectId: 'commit-1',
        expectedRevision: 1,
        inodeIndexRootObjectId: 'index-2',
        subvolumeMountIndexRootObjectId: 'subvolume-mount-index',
        flushPreparedRecords: async () => {},
      })).resolves.toMatchObject({
        type: 'published',
        state: { commitObjectId: 'commit-2' },
      });
      expect(publishFromState).not.toHaveBeenCalled();
    } finally {
      await coordinator.close();
    }
  });

  it('fails closed when an acknowledged prior leader has an obsolete outcome', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createQueuedTestLockManager({ onRequest: undefined }),
    });
    const fileSystemId = `coordinator-${crypto.randomUUID()}`;
    const coordinator = new HizoFSActiveStateCoordinator({
      fileSystemId,
      fileSystemInstanceId: fileSystemId,
      coordinationScope: 'root',
      localCoordinationIdentity: {},
      loadFromBacking: async () => createState({
        sequence: 3,
        commitObjectId: 'commit-3',
        inodeIndexRootObjectId: 'index-3',
      }),
      publishFromState: async () => {
        throw new Error('publication must not be replayed');
      },
      setHeadHandleRetention: async () => {},
      diagnostics: undefined,
    });
    const channel = new BroadcastChannel(`hizofs/${fileSystemId}/${fileSystemId}/root/coordinator`);

    try {
      await coordinator.loadActiveState();
      const response = Promise.withResolvers<unknown>();
      channel.addEventListener('message', (event: MessageEvent<unknown>) => {
        const value = event.data as {
          readonly messageType?: unknown;
          readonly requestId?: unknown;
        };
        if (value.messageType === 'response' && value.requestId === 'request-1') {
          response.resolve(event.data);
        }
      });
      channel.postMessage({
        protocolVersion: 2,
        messageType: 'request',
        requestId: 'request-1',
        senderId: 'external-sender',
        previouslyAcknowledgedLeaderId: 'previous-leader',
        operation: {
          type: 'publish',
          publicationId: 'lost-publication',
          expectedCommitObjectId: 'commit-1',
          expectedRevision: 1,
          inodeIndexRootObjectId: 'index-2',
          subvolumeMountIndexRootObjectId: 'subvolume-mount-index',
        },
      });

      await expect(response.promise).resolves.toMatchObject({
        messageType: 'response',
        response: {
          type: 'failure',
          error: { type: 'publication_outcome_unknown' },
        },
      });
    } finally {
      channel.close();
      await coordinator.close();
    }
  });

  it('propagates persistent head-handle cleanup failures', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    const coordinator = new HizoFSActiveStateCoordinator({
      fileSystemId: 'file-system-id',
      fileSystemInstanceId: `coordinator-${crypto.randomUUID()}`,
      coordinationScope: 'root',
      localCoordinationIdentity: {},
      loadFromBacking: async () => createState({
        sequence: 1,
        commitObjectId: 'commit-1',
        inodeIndexRootObjectId: 'index-1',
      }),
      publishFromState: async () => {
        throw new Error('not used');
      },
      setHeadHandleRetention: async ({ retention }) => {
        if (retention === 'ephemeral') {
          throw new Error('head close failed');
        }
      },
      diagnostics: undefined,
    });

    await coordinator.loadActiveState();
    await expect(coordinator.close()).rejects.toThrow('head close failed');
  });

  it('rejects malformed protocol messages at the transport boundary', () => {
    expect(TEST_ONLY.CoordinatorMessageSchema.safeParse({
      protocolVersion: 1,
      messageType: 'request',
      requestId: 'request',
      senderId: 'sender',
      operation: {
        type: 'publish',
        expectedCommitObjectId: 42,
        inodeIndexRootObjectId: 'index',
      },
    }).success).toBe(false);
  });
});
