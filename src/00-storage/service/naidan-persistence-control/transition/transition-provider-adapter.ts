import type { NaidanPersistenceEndpointV1, TransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import type {
  TransitionNamespaceSourcePort,
  TransitionNamespaceTargetPort,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';
import type {
  TransitionEndpointReadiness,
  TransitionEndpointReadinessProvider,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-endpoint-readiness';

/**
 * Stable identity for a private transition target across bounded copy slices
 * and process restarts. A target driver must never infer this identity from the
 * endpoint alone because another operation may reuse the same endpoint path.
 */
export type TransitionTargetOperationBinding = Readonly<{
  operationId: TransitionOperationId;
  source: NaidanPersistenceEndpointV1;
  target: NaidanPersistenceEndpointV1;
}>;

type TransitionEndpointSessionBase = Readonly<{
  authorityIdentity: string;
  close(): Promise<void>;
}>;

export type TransitionSourceEndpointSession = TransitionEndpointSessionBase & Readonly<{
  source: TransitionNamespaceSourcePort;
}>;

export type TransitionTargetEndpointSession = TransitionEndpointSessionBase & Readonly<{
  discardStagedSliceState(): Promise<void>;
  source: TransitionNamespaceSourcePort;
  stageSliceState(): Promise<void>;
  target: TransitionNamespaceTargetPort;
}>;

/**
 * Drivers expose the Naidan transition namespace, not a raw backend root.
 * This keeps control/container collections and out-of-scope model assets outside the copy graph,
 * recreates temporary storage according to the profile, and makes metadata conversion limits
 * observable before this coordinator can publish the target as authority.
 */
export interface TransitionEndpointDriver {
  cleanupEndpoint({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): Promise<void>;
  finalizeTarget({ binding }: { binding: TransitionTargetOperationBinding }): Promise<void>;
  inspectEndpoint({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): Promise<TransitionEndpointReadiness>;
  openSourceEndpoint({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): Promise<TransitionSourceEndpointSession>;
  openTargetEndpoint({ binding }: { binding: TransitionTargetOperationBinding }): Promise<TransitionTargetEndpointSession>;
  prepareTarget({ binding, readiness }: {
    binding: TransitionTargetOperationBinding;
    readiness?: TransitionEndpointReadiness;
  }): Promise<void>;
  verifyNormalOpen({ binding }: { binding: TransitionTargetOperationBinding }): Promise<void>;
}

export class TransitionProviderAdapter implements TransitionEndpointReadinessProvider {
  public constructor({ hizofs, plain }: {
    hizofs: TransitionEndpointDriver;
    plain: TransitionEndpointDriver;
  }) {
    this.hizofs = hizofs;
    this.plain = plain;
  }

  private readonly hizofs: TransitionEndpointDriver;
  private readonly plain: TransitionEndpointDriver;

  private driver({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): TransitionEndpointDriver {
    switch (endpoint.type) {
    case 'plain': return this.plain;
    case 'hizofs': return this.hizofs;
    default: return endpoint satisfies never;
    }
  }

  public async cleanupEndpoint({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): Promise<void> {
    await this.driver({ endpoint }).cleanupEndpoint({ endpoint });
  }

  public async finalizeTarget({ binding }: { binding: TransitionTargetOperationBinding }): Promise<void> {
    await this.driver({ endpoint: binding.target }).finalizeTarget({ binding });
  }

  public async inspectEndpoint({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): Promise<TransitionEndpointReadiness> {
    return await this.driver({ endpoint }).inspectEndpoint({ endpoint });
  }

  public async openSourceEndpoint({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): Promise<TransitionSourceEndpointSession> {
    return await this.driver({ endpoint }).openSourceEndpoint({ endpoint });
  }

  public async openTargetEndpoint({ binding }: { binding: TransitionTargetOperationBinding }): Promise<TransitionTargetEndpointSession> {
    return await this.driver({ endpoint: binding.target }).openTargetEndpoint({ binding });
  }

  public async prepareTarget({ binding, readiness }: {
    binding: TransitionTargetOperationBinding;
    readiness?: TransitionEndpointReadiness;
  }): Promise<void> {
    const driver = this.driver({ endpoint: binding.target });
    await (readiness === undefined
      ? driver.prepareTarget({ binding })
      : driver.prepareTarget({ binding, readiness }));
  }

  public async verifyNormalOpen({ binding }: { binding: TransitionTargetOperationBinding }): Promise<void> {
    await this.driver({ endpoint: binding.target }).verifyNormalOpen({ binding });
  }
}

export const TEST_ONLY = {
};
