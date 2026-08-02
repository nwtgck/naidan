import type {
  NaidanPersistenceEndpointV1,
  NaidanPersistenceModeV1,
  TransitionOperationId,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import type { FileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  createTransitionNamespaceCopyCursor,
  runTransitionNamespaceCopySlice,
  type TransitionNamespaceCopyCursor,
  type TransitionNamespaceCopyPolicy,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';
import {
  createTransitionNamespaceVerificationCursor,
  runTransitionNamespaceVerificationSlice,
  type TransitionNamespaceVerificationCursor,
  type TransitionNamespaceVerificationPolicy,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-verification';
import {
  createBuildingTransitionMode,
  planStableTransitionCompletion,
  planStableTransitionSourceRecovery,
  planTransitionAuthoritySwitch,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-state-machine';
import {
  inspectPersistenceEndpointReadiness,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-endpoint-readiness';
import type {
  TransitionProviderAdapter,
  TransitionSourceEndpointSession,
  TransitionTargetEndpointSession,
  TransitionTargetOperationBinding,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-provider-adapter';

export type TransitionSemanticState = Readonly<{
  mode: NaidanPersistenceModeV1;
  retiredFileSystemIds: readonly FileSystemId[];
}>;

export interface TransitionControlPort {
  publishState({ state }: { state: TransitionSemanticState }): Promise<void>;
  readState(): Promise<TransitionSemanticState>;
}

export type TransitionRuntimeProgress =
  | Readonly<{
      copyCursor: TransitionNamespaceCopyCursor;
      operationId: TransitionOperationId;
      source: NaidanPersistenceEndpointV1;
      sourceAuthorityIdentity: string;
      stage: 'copying';
      target: NaidanPersistenceEndpointV1;
    }>
  | Readonly<{
      operationId: TransitionOperationId;
      source: NaidanPersistenceEndpointV1;
      sourceAuthorityIdentity: string;
      stage: 'verifying';
      target: NaidanPersistenceEndpointV1;
      verificationCursor: TransitionNamespaceVerificationCursor;
    }>;

export interface TransitionProgressPort {
  clear({ operationId }: { operationId: TransitionOperationId }): Promise<void>;
  load({ operationId }: { operationId: TransitionOperationId }): Promise<TransitionRuntimeProgress | undefined>;
  save({ progress }: { progress: TransitionRuntimeProgress }): Promise<void>;
}

export type TransitionCoordinatorPolicy = Readonly<{
  copy: TransitionNamespaceCopyPolicy;
  verification: TransitionNamespaceVerificationPolicy;
}>;

export type TransitionAdvanceResult =
  | Readonly<{ state: 'authority_switched' }>
  | Readonly<{ cursor: TransitionNamespaceCopyCursor; state: 'copying' }>
  | Readonly<{ remainingRetiredFileSystemIds: number; state: 'retired_cleanup' }>
  | Readonly<{ state: 'stable' }>
  | Readonly<{ cursor: TransitionNamespaceVerificationCursor; state: 'verifying' }>;

export class TransitionCoordinatorError extends Error {
  public constructor({ code, message }: {
    code: 'endpoint_not_ready' | 'progress_conflict' | 'stable_mode' | 'transition_changed';
    message: string;
  }) {
    super(message);
    this.code = code;
    this.name = 'TransitionCoordinatorError';
  }

  public readonly code: 'endpoint_not_ready' | 'progress_conflict' | 'stable_mode' | 'transition_changed';
}

function sameEndpoint({ left, right }: {
  left: NaidanPersistenceEndpointV1;
  right: NaidanPersistenceEndpointV1;
}): boolean {
  switch (left.type) {
  case 'plain': return right.type === 'plain';
  case 'hizofs': return right.type === 'hizofs' && left.fileSystemId === right.fileSystemId;
  default: return left satisfies never;
  }
}

function validateProgressIdentity({ mode, progress, sourceAuthorityIdentity }: {
  mode: Extract<NaidanPersistenceModeV1, { type: 'transitioning' }>;
  progress: TransitionRuntimeProgress;
  sourceAuthorityIdentity: string;
}): void {
  if (progress.sourceAuthorityIdentity !== sourceAuthorityIdentity
    || progress.operationId !== mode.operationId
    || !sameEndpoint({ left: progress.source, right: mode.phase.source })
    || !sameEndpoint({ left: progress.target, right: mode.phase.target })) {
    throw new TransitionCoordinatorError({ code: 'progress_conflict', message: 'transition progress belongs to a different operation, source authority, or endpoint pair' });
  }
}


async function closeTransitionSessions({ operationFailure, sourceSession, targetSession }: {
  operationFailure: unknown;
  sourceSession: TransitionSourceEndpointSession;
  targetSession: TransitionTargetEndpointSession;
}): Promise<void> {
  const results = await Promise.allSettled([sourceSession.close(), targetSession.close()]);
  const failures: unknown[] = [];
  for (const result of results) {
    switch (result.status) {
    case 'fulfilled': break;
    case 'rejected': failures.push(result.reason); break;
    default: result satisfies never;
    }
  }
  if (operationFailure !== undefined) {
    if (failures.length > 0) throw new AggregateError([operationFailure, ...failures], 'transition operation and endpoint close both failed');
    throw operationFailure;
  }
  if (failures.length > 0) throw new AggregateError(failures, 'failed to close transition endpoint sessions');
}

async function withTransitionSessions<T>({ binding, operation, provider }: {
  binding: TransitionTargetOperationBinding;
  operation: ({ sourceSession, targetSession }: {
    sourceSession: TransitionSourceEndpointSession;
    targetSession: TransitionTargetEndpointSession;
  }) => Promise<T>;
  provider: TransitionProviderAdapter;
}): Promise<T> {
  const sourceSession = await provider.openSourceEndpoint({ endpoint: binding.source });
  let targetSession: TransitionTargetEndpointSession;
  try {
    targetSession = await provider.openTargetEndpoint({ binding });
  } catch (cause: unknown) {
    try {
      await sourceSession.close();
    } catch (closeCause: unknown) {
      throw new AggregateError([cause, closeCause], 'target open and source close both failed');
    }
    throw cause;
  }
  let operationFailure: unknown;
  let value: T | undefined;
  try {
    value = await operation({ sourceSession, targetSession });
  } catch (cause: unknown) {
    operationFailure = cause;
  }
  await closeTransitionSessions({ operationFailure, sourceSession, targetSession });
  return value as T;
}

export async function startPersistenceTransition({ control, operationId, source, target }: {
  control: TransitionControlPort;
  operationId: TransitionOperationId;
  source: NaidanPersistenceEndpointV1;
  target: NaidanPersistenceEndpointV1;
}): Promise<void> {
  const current = await control.readState();
  switch (current.mode.type) {
  case 'plain':
  case 'hizofs':
    break;
  case 'transitioning': {
    if (current.mode.operationId === operationId
      && sameEndpoint({ left: current.mode.phase.source, right: source })
      && sameEndpoint({ left: current.mode.phase.target, right: target })) return;
    throw new TransitionCoordinatorError({ code: 'transition_changed', message: 'another persistence transition is already active' });
  }
  default: return current.mode satisfies never;
  }
  const expectedSource: NaidanPersistenceEndpointV1 = (() => {
    switch (current.mode.type) {
    case 'plain': return { type: 'plain' };
    case 'hizofs': return { fileSystemId: current.mode.activeFileSystemId, type: 'hizofs' };
    default: return current.mode satisfies never;
    }
  })();
  if (!sameEndpoint({ left: source, right: expectedSource })) {
    throw new TransitionCoordinatorError({ code: 'transition_changed', message: 'transition source is not the selected stable authority' });
  }
  await control.publishState({
    state: {
      mode: createBuildingTransitionMode({ operationId, source, target }),
      retiredFileSystemIds: current.retiredFileSystemIds,
    },
  });
}

export type TransitionConvergenceResult = Readonly<{
  authoritativeEndpoint: 'source' | 'target';
  stableState: TransitionSemanticState;
}>;

export async function convergeInterruptedPersistenceTransition({
  control,
  progressPort,
}: {
  control: TransitionControlPort;
  progressPort: Pick<TransitionProgressPort, 'clear'> | undefined;
}): Promise<TransitionConvergenceResult> {
  const state = await control.readState();
  const mode = state.mode;
  switch (mode.type) {
  case 'plain':
  case 'hizofs':
    throw new TransitionCoordinatorError({
      code: 'stable_mode',
      message: 'Persistence Control is already stable',
    });
  case 'transitioning': break;
  default: return mode satisfies never;
  }

  const convergence = (() => {
    switch (mode.phase.type) {
    case 'building_target': return {
      authoritativeEndpoint: 'source' as const,
      stableState: planStableTransitionSourceRecovery({
        mode,
        retiredFileSystemIds: state.retiredFileSystemIds,
      }),
    };
    case 'cleaning_up_source': return {
      authoritativeEndpoint: 'target' as const,
      stableState: planStableTransitionCompletion({
        mode,
        retiredFileSystemIds: state.retiredFileSystemIds,
      }),
    };
    default: return mode.phase.type satisfies never;
    }
  })();

  // Publish stable authority before releasing invocation-local work state.
  // Startup derives authority only from Persistence Control and starts any
  // later copy from the beginning.
  await control.publishState({ state: convergence.stableState });
  await progressPort?.clear({ operationId: mode.operationId });
  return convergence;
}

export async function advancePersistenceTransition({ control, policy, progressPort, provider, signal }: {
  control: TransitionControlPort;
  policy: TransitionCoordinatorPolicy;
  progressPort: TransitionProgressPort;
  provider: TransitionProviderAdapter;
  signal: AbortSignal | undefined;
}): Promise<TransitionAdvanceResult> {
  const state = await control.readState();
  switch (state.mode.type) {
  case 'plain':
  case 'hizofs': {
    const retiredFileSystemId = state.retiredFileSystemIds[0];
    if (retiredFileSystemId === undefined) return { state: 'stable' };
    await provider.cleanupEndpoint({ endpoint: { fileSystemId: retiredFileSystemId, type: 'hizofs' } });
    const remainingRetiredFileSystemIds = state.retiredFileSystemIds.slice(1);
    await control.publishState({ state: { mode: state.mode, retiredFileSystemIds: remainingRetiredFileSystemIds } });
    return remainingRetiredFileSystemIds.length === 0
      ? { state: 'stable' }
      : { remainingRetiredFileSystemIds: remainingRetiredFileSystemIds.length, state: 'retired_cleanup' };
  }
  case 'transitioning': break;
  default: return state.mode satisfies never;
  }
  const mode = state.mode;
  const targetBinding: TransitionTargetOperationBinding = {
    operationId: mode.operationId,
    source: mode.phase.source,
    target: mode.phase.target,
  };
  const readiness = await inspectPersistenceEndpointReadiness({ mode, provider });
  switch (readiness.result) {
  case 'valid': break;
  case 'invalid':
    throw new TransitionCoordinatorError({ code: 'endpoint_not_ready', message: 'transition endpoints are not ready for the persisted phase' });
  default: readiness.result satisfies never;
  }

  switch (mode.phase.type) {
  case 'building_target': {
    await provider.prepareTarget({ binding: targetBinding, readiness: readiness.targetReadiness });
    const loadedProgress = await progressPort.load({ operationId: mode.operationId });

    const outcome = await withTransitionSessions({
      operation: async ({ sourceSession, targetSession }) => {
        const progress: TransitionRuntimeProgress = loadedProgress ?? {
          copyCursor: createTransitionNamespaceCopyCursor(),
          operationId: mode.operationId,
          source: mode.phase.source,
          sourceAuthorityIdentity: sourceSession.authorityIdentity,
          stage: 'copying',
          target: mode.phase.target,
        };
        validateProgressIdentity({ mode, progress, sourceAuthorityIdentity: sourceSession.authorityIdentity });
        switch (progress.stage) {
        case 'copying': {
          const copyCursor = await runTransitionNamespaceCopySlice({
            cursor: progress.copyCursor,
            policy: policy.copy,
            signal,
            source: sourceSession.source,
            target: targetSession.target,
          });
          switch (copyCursor.state) {
          case 'copying': return {
            progress: { ...progress, copyCursor },
            result: { cursor: copyCursor, state: 'copying' } as const,
            type: 'checkpoint' as const,
          };
          case 'complete': {
            const verifyingProgress: TransitionRuntimeProgress = {
              operationId: mode.operationId,
              source: mode.phase.source,
              sourceAuthorityIdentity: progress.sourceAuthorityIdentity,
              stage: 'verifying',
              target: mode.phase.target,
              verificationCursor: createTransitionNamespaceVerificationCursor(),
            };
            return {
              progress: verifyingProgress,
              result: { cursor: verifyingProgress.verificationCursor, state: 'verifying' } as const,
              type: 'checkpoint' as const,
            };
          }
          default: return copyCursor.state satisfies never;
          }
        }
        case 'verifying': {
          const verificationCursor = await runTransitionNamespaceVerificationSlice({
            cursor: progress.verificationCursor,
            policy: policy.verification,
            signal,
            source: sourceSession.source,
            target: targetSession.source,
          });
          switch (verificationCursor.state) {
          case 'verifying': return {
            progress: { ...progress, verificationCursor },
            result: { cursor: verificationCursor, state: 'verifying' } as const,
            type: 'checkpoint' as const,
          };
          case 'complete': return { type: 'verified' as const };
          default: return verificationCursor.state satisfies never;
          }
        }
        default: return progress satisfies never;
        }
      },
      binding: targetBinding,
      provider,
    });

    switch (outcome.type) {
    case 'checkpoint':
      await progressPort.save({ progress: outcome.progress });
      return outcome.result;
    case 'verified': {
      // Endpoint sessions are closed before publication or normal-open proof.
      // This makes targetWriterClosed a demonstrated fact rather than a promise
      // about cleanup that has not happened yet.
      await provider.finalizeTarget({ binding: targetBinding });
      await provider.verifyNormalOpen({ binding: targetBinding });
      const cleaningMode = planTransitionAuthoritySwitch({
        mode,
        verification: {
          contentVerified: true,
          metadataVerified: true,
          operationId: mode.operationId,
          source: mode.phase.source,
          target: mode.phase.target,
          targetDurable: true,
          targetNormalOpenVerified: true,
          targetWriterClosed: true,
        },
      });
      await control.publishState({ state: { mode: cleaningMode, retiredFileSystemIds: state.retiredFileSystemIds } });
      await progressPort.clear({ operationId: mode.operationId });
      return { state: 'authority_switched' };
    }
    default: return outcome satisfies never;
    }
  }
  case 'cleaning_up_source': {
    const completed = planStableTransitionCompletion({ mode, retiredFileSystemIds: state.retiredFileSystemIds });
    // WHY: Stable authority publication is the transition completion point.
    // Physical source cleanup is retryable maintenance and must never delay
    // Naidan startup or turn a completed authority switch into a failed UI
    // operation. A lost response may leave only a retired-source inventory.
    await control.publishState({ state: completed });
    await progressPort.clear({ operationId: mode.operationId });
    return completed.retiredFileSystemIds.length === 0
      ? { state: 'stable' }
      : {
        remainingRetiredFileSystemIds: completed.retiredFileSystemIds.length,
        state: 'retired_cleanup',
      };
  }
  default: return mode.phase.type satisfies never;
  }
}

export const TEST_ONLY = {
  validateProgressIdentity,
};
