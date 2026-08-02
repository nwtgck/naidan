import type {
  NaidanPersistenceEndpointV1,
  NaidanPersistenceModeV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';

export type TransitionEndpointReadiness = 'absent' | 'fully_verified' | 'invalid' | 'root_key_ready';

export interface TransitionEndpointReadinessProvider {
  inspectEndpoint({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): Promise<TransitionEndpointReadiness>;
}

export type TransitionEndpointReadinessValidation = Readonly<{
  result: 'invalid' | 'valid';
  targetReadiness: TransitionEndpointReadiness | undefined;
}>;

function isReadinessCompatibleWithEndpoint({ endpoint, readiness }: {
  endpoint: NaidanPersistenceEndpointV1;
  readiness: TransitionEndpointReadiness;
}): boolean {
  switch (endpoint.type) {
  case 'plain': return readiness !== 'root_key_ready';
  case 'hizofs': return true;
  default: return endpoint satisfies never;
  }
}

function isFullyVerified({ readiness }: { readiness: TransitionEndpointReadiness }): boolean {
  switch (readiness) {
  case 'fully_verified': return true;
  case 'absent':
  case 'invalid':
  case 'root_key_ready': return false;
  default: return readiness satisfies never;
  }
}

function hasRootKeyPlane({ readiness }: { readiness: TransitionEndpointReadiness }): boolean {
  switch (readiness) {
  case 'fully_verified':
  case 'root_key_ready': return true;
  case 'absent':
  case 'invalid': return false;
  default: return readiness satisfies never;
  }
}

function isUsableIncompleteTarget({ readiness }: { readiness: TransitionEndpointReadiness }): boolean {
  switch (readiness) {
  case 'absent':
  case 'fully_verified':
  case 'root_key_ready': return true;
  case 'invalid': return false;
  default: return readiness satisfies never;
  }
}

export async function inspectPersistenceEndpointReadiness({ mode, provider }: {
  mode: NaidanPersistenceModeV1;
  provider: TransitionEndpointReadinessProvider;
}): Promise<TransitionEndpointReadinessValidation> {
  switch (mode.type) {
  case 'plain': return {
    result: isFullyVerified({ readiness: await provider.inspectEndpoint({ endpoint: { type: 'plain' } }) }) ? 'valid' : 'invalid',
    targetReadiness: undefined,
  };
  case 'hizofs': return {
    result: isFullyVerified({
      readiness: await provider.inspectEndpoint({ endpoint: { fileSystemId: mode.activeFileSystemId, type: 'hizofs' } }),
    }) ? 'valid' : 'invalid',
    targetReadiness: undefined,
  };
  case 'transitioning': {
    const sourceReadiness = await provider.inspectEndpoint({ endpoint: mode.phase.source });
    const targetReadiness = await provider.inspectEndpoint({ endpoint: mode.phase.target });
    if (!isReadinessCompatibleWithEndpoint({ endpoint: mode.phase.source, readiness: sourceReadiness })
      || !isReadinessCompatibleWithEndpoint({ endpoint: mode.phase.target, readiness: targetReadiness })) {
      return { result: 'invalid', targetReadiness };
    }
    switch (mode.phase.type) {
    case 'building_target': {
      if (!isFullyVerified({ readiness: sourceReadiness })) return { result: 'invalid', targetReadiness };
      switch (mode.operation) {
      case 'encrypt': return {
        result: hasRootKeyPlane({ readiness: targetReadiness }) ? 'valid' : 'invalid',
        targetReadiness,
      };
      case 'decrypt':
      case 're_encrypt': return {
        result: isUsableIncompleteTarget({ readiness: targetReadiness }) ? 'valid' : 'invalid',
        targetReadiness,
      };
      default: return mode.operation satisfies never;
      }
    }
    case 'cleaning_up_source': {
      if (!isFullyVerified({ readiness: targetReadiness })) return { result: 'invalid', targetReadiness };
      switch (mode.operation) {
      case 'decrypt': return {
        result: hasRootKeyPlane({ readiness: sourceReadiness }) ? 'valid' : 'invalid',
        targetReadiness,
      };
      case 'encrypt':
      case 're_encrypt': return { result: 'valid', targetReadiness };
      default: return mode.operation satisfies never;
      }
    }
    default: return mode.phase.type satisfies never;
    }
  }
  default: return mode satisfies never;
  }
}

export async function validatePersistenceEndpointReadiness({ mode, provider }: {
  mode: NaidanPersistenceModeV1;
  provider: TransitionEndpointReadinessProvider;
}): Promise<'invalid' | 'valid'> {
  return (await inspectPersistenceEndpointReadiness({ mode, provider })).result;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
