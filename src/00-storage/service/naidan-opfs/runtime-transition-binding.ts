import type {
  NaidanPersistenceEndpointV1,
  TransitionOperationId,
} from '@/00-storage/service/naidan-persistence-control/00-format';

export type RuntimeTransitionBinding = Readonly<{
  operationId: TransitionOperationId;
  sourceAuthorityIdentity: string;
  sourceEndpoint: NaidanPersistenceEndpointV1;
  targetAuthorityIdentity: string;
  targetEndpoint: NaidanPersistenceEndpointV1;
}>;

export function sameRuntimeTransitionEndpoint({ left, right }: {
  left: NaidanPersistenceEndpointV1;
  right: NaidanPersistenceEndpointV1;
}): boolean {
  switch (left.type) {
  case 'plain': return right.type === 'plain';
  case 'hizofs': return right.type === 'hizofs' && left.fileSystemId === right.fileSystemId;
  default: return left satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
