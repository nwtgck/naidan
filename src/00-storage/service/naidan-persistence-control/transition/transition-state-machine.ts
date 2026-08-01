import type { FileSystemId } from '@/00-storage/service/hizofs/compatibility';
import type {
  NaidanPersistenceEndpointV1,
  NaidanPersistenceModeV1,
  NaidanTransitionOperationV1,
  TransitionOperationId,
} from '@/00-storage/service/naidan-persistence-control/00-format';

export type TransitionVerificationProof = Readonly<{
  contentVerified: true;
  metadataVerified: true;
  operationId: TransitionOperationId;
  source: NaidanPersistenceEndpointV1;
  target: NaidanPersistenceEndpointV1;
  targetDurable: true;
  targetNormalOpenVerified: true;
  targetWriterClosed: true;
}>;

export type StableTransitionCompletion = Readonly<{
  mode: Exclude<NaidanPersistenceModeV1, { type: 'transitioning' }>;
  retiredFileSystemIds: readonly FileSystemId[];
}>;

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

function expectedOperation({ source, target }: {
  source: NaidanPersistenceEndpointV1;
  target: NaidanPersistenceEndpointV1;
}): NaidanTransitionOperationV1 {
  if (source.type === 'plain' && target.type === 'hizofs') return 'encrypt';
  if (source.type === 'hizofs' && target.type === 'plain') return 'decrypt';
  if (source.type === 'hizofs' && target.type === 'hizofs' && source.fileSystemId !== target.fileSystemId) return 're_encrypt';
  throw new TypeError('transition endpoints do not describe encrypt, decrypt, or re-encrypt');
}

export function createBuildingTransitionMode({ operationId, source, target }: {
  operationId: TransitionOperationId;
  source: NaidanPersistenceEndpointV1;
  target: NaidanPersistenceEndpointV1;
}): Extract<NaidanPersistenceModeV1, { type: 'transitioning' }> {
  return {
    operation: expectedOperation({ source, target }),
    operationId,
    phase: { source, target, type: 'building_target' },
    type: 'transitioning',
  };
}

export function authoritativeTransitionEndpoint({ mode }: {
  mode: Extract<NaidanPersistenceModeV1, { type: 'transitioning' }>;
}): NaidanPersistenceEndpointV1 {
  switch (mode.phase.type) {
  case 'building_target': return mode.phase.source;
  case 'cleaning_up_source': return mode.phase.target;
  default: return mode.phase.type satisfies never;
  }
}

export function planTransitionAuthoritySwitch({ mode, verification }: {
  mode: Extract<NaidanPersistenceModeV1, { type: 'transitioning' }>;
  verification: TransitionVerificationProof;
}): Extract<NaidanPersistenceModeV1, { type: 'transitioning' }> {
  switch (mode.phase.type) {
  case 'building_target': break;
  case 'cleaning_up_source': throw new TypeError('transition authority was already switched');
  default: return mode.phase.type satisfies never;
  }
  if (verification.contentVerified !== true
    || verification.metadataVerified !== true
    || verification.targetDurable !== true
    || verification.targetNormalOpenVerified !== true
    || verification.targetWriterClosed !== true) {
    throw new TypeError('transition target is not fully verified and durable');
  }
  if (verification.operationId !== mode.operationId
    || !sameEndpoint({ left: verification.source, right: mode.phase.source })
    || !sameEndpoint({ left: verification.target, right: mode.phase.target })) {
    throw new TypeError('transition verification proof does not belong to the active operation');
  }
  return {
    ...mode,
    phase: { ...mode.phase, type: 'cleaning_up_source' },
  };
}

function addRetiredFileSystemId({ existing, fileSystemId }: {
  existing: readonly FileSystemId[];
  fileSystemId: FileSystemId;
}): readonly FileSystemId[] {
  return [...new Set([...existing, fileSystemId])].toSorted();
}

export function planStableTransitionSourceRecovery({ mode, retiredFileSystemIds }: {
  mode: Extract<NaidanPersistenceModeV1, { type: 'transitioning' }>;
  retiredFileSystemIds: readonly FileSystemId[];
}): StableTransitionCompletion {
  switch (mode.phase.type) {
  case 'building_target': break;
  case 'cleaning_up_source': throw new TypeError('target remains authoritative after the transition switch');
  default: return mode.phase.type satisfies never;
  }
  const canonicalRetired = [...new Set(retiredFileSystemIds)].toSorted();
  if (canonicalRetired.length !== retiredFileSystemIds.length
    || canonicalRetired.some((value, index) => value !== retiredFileSystemIds[index])) {
    throw new TypeError('retired File System IDs must already be unique and canonically ordered');
  }
  for (const endpoint of [mode.phase.source, mode.phase.target]) {
    if (endpoint.type === 'hizofs' && retiredFileSystemIds.includes(endpoint.fileSystemId)) {
      throw new TypeError('active transition endpoints cannot already be retired');
    }
  }
  const nextRetired = (() => {
    switch (mode.phase.target.type) {
    case 'plain': return retiredFileSystemIds;
    case 'hizofs': return addRetiredFileSystemId({
      existing: retiredFileSystemIds,
      fileSystemId: mode.phase.target.fileSystemId,
    });
    default: return mode.phase.target satisfies never;
    }
  })();
  switch (mode.phase.source.type) {
  case 'plain': return { mode: { type: 'plain' }, retiredFileSystemIds: nextRetired };
  case 'hizofs': return {
    mode: { activeFileSystemId: mode.phase.source.fileSystemId, type: 'hizofs' },
    retiredFileSystemIds: nextRetired,
  };
  default: return mode.phase.source satisfies never;
  }
}

export function planStableTransitionCompletion({ mode, retiredFileSystemIds }: {
  mode: Extract<NaidanPersistenceModeV1, { type: 'transitioning' }>;
  retiredFileSystemIds: readonly FileSystemId[];
}): StableTransitionCompletion {
  switch (mode.phase.type) {
  case 'building_target': throw new TypeError('source remains authoritative before the transition switch');
  case 'cleaning_up_source': break;
  default: return mode.phase.type satisfies never;
  }
  const canonicalRetired = [...new Set(retiredFileSystemIds)].toSorted();
  if (canonicalRetired.length !== retiredFileSystemIds.length
    || canonicalRetired.some((value, index) => value !== retiredFileSystemIds[index])) {
    throw new TypeError('retired File System IDs must already be unique and canonically ordered');
  }
  for (const endpoint of [mode.phase.source, mode.phase.target]) {
    if (endpoint.type === 'hizofs' && retiredFileSystemIds.includes(endpoint.fileSystemId)) {
      throw new TypeError('active transition endpoints cannot already be retired');
    }
  }
  switch (mode.operation) {
  case 'encrypt': {
    switch (mode.phase.target.type) {
    case 'plain': throw new TypeError('encrypt target must be HizoFS');
    case 'hizofs': return { mode: { activeFileSystemId: mode.phase.target.fileSystemId, type: 'hizofs' }, retiredFileSystemIds: [...retiredFileSystemIds] };
    default: return mode.phase.target satisfies never;
    }
  }
  case 'decrypt': {
    switch (mode.phase.source.type) {
    case 'plain': throw new TypeError('decrypt source must be HizoFS');
    case 'hizofs': return {
      mode: { type: 'plain' },
      retiredFileSystemIds: addRetiredFileSystemId({ existing: retiredFileSystemIds, fileSystemId: mode.phase.source.fileSystemId }),
    };
    default: return mode.phase.source satisfies never;
    }
  }
  case 're_encrypt': {
    switch (mode.phase.source.type) {
    case 'plain': throw new TypeError('re-encrypt source must be HizoFS');
    case 'hizofs': break;
    default: return mode.phase.source satisfies never;
    }
    switch (mode.phase.target.type) {
    case 'plain': throw new TypeError('re-encrypt target must be HizoFS');
    case 'hizofs': return {
      mode: { activeFileSystemId: mode.phase.target.fileSystemId, type: 'hizofs' },
      retiredFileSystemIds: addRetiredFileSystemId({ existing: retiredFileSystemIds, fileSystemId: mode.phase.source.fileSystemId }),
    };
    default: return mode.phase.target satisfies never;
    }
  }
  default: return mode.operation satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
