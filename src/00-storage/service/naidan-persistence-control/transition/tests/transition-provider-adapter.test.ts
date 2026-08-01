import { describe, expect, it, vi } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import { parseTransitionOperationId, type NaidanPersistenceEndpointV1 } from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  TransitionProviderAdapter,
  type TransitionEndpointDriver,
  type TransitionSourceEndpointSession,
  type TransitionTargetEndpointSession,
  type TransitionTargetOperationBinding,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-provider-adapter';

const OPERATION = parseTransitionOperationId({ value: 'transition_0123456789' });
const hizofsEndpoint = { fileSystemId: parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' }), type: 'hizofs' } as const;
const plainEndpoint = { type: 'plain' } as const;
const sourceSession: TransitionSourceEndpointSession = {
  authorityIdentity: 'source-identity-v1',
  close: async () => undefined,
  source: {} as TransitionSourceEndpointSession['source'],
};
const targetSession: TransitionTargetEndpointSession = {
  authorityIdentity: 'target-identity-v1',
  close: async () => undefined,
  source: {} as TransitionTargetEndpointSession['source'],
  target: {} as TransitionTargetEndpointSession['target'],
};

function driver({ label }: { label: string }): TransitionEndpointDriver {
  return {
    cleanupEndpoint: vi.fn(async () => undefined),
    finalizeTarget: vi.fn(async () => undefined),
    inspectEndpoint: vi.fn(async () => label === 'plain' ? 'fully_verified' : 'root_key_ready'),
    openSourceEndpoint: vi.fn(async () => sourceSession),
    openTargetEndpoint: vi.fn(async () => targetSession),
    prepareTarget: vi.fn(async () => undefined),
    verifyNormalOpen: vi.fn(async () => undefined),
  };
}

describe('transition provider adapter', () => {
  it('routes exact endpoint kinds without exposing either provider to the other', async () => {
    const plain = driver({ label: 'plain' });
    const hizofs = driver({ label: 'hizofs' });
    const adapter = new TransitionProviderAdapter({ hizofs, plain });
    await expect(adapter.inspectEndpoint({ endpoint: plainEndpoint })).resolves.toBe('fully_verified');
    await expect(adapter.inspectEndpoint({ endpoint: hizofsEndpoint })).resolves.toBe('root_key_ready');
    expect(plain.inspectEndpoint).toHaveBeenCalledTimes(1);
    expect(hizofs.inspectEndpoint).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['plain', plainEndpoint],
    ['hizofs', hizofsEndpoint],
  ] as const)('routes all lifecycle operations for %s', async (_label, endpoint: NaidanPersistenceEndpointV1) => {
    const plain = driver({ label: 'plain' });
    const hizofs = driver({ label: 'hizofs' });
    const adapter = new TransitionProviderAdapter({ hizofs, plain });
    const selected = endpoint.type === 'plain' ? plain : hizofs;
    const binding: TransitionTargetOperationBinding = {
      operationId: OPERATION,
      source: endpoint.type === 'plain' ? hizofsEndpoint : plainEndpoint,
      target: endpoint,
    };
    await adapter.prepareTarget({ binding });
    await adapter.openSourceEndpoint({ endpoint });
    await adapter.openTargetEndpoint({ binding });
    await adapter.finalizeTarget({ binding });
    await adapter.verifyNormalOpen({ binding });
    await adapter.cleanupEndpoint({ endpoint });
    expect(selected.prepareTarget).toHaveBeenCalledWith({ binding });
    expect(selected.openSourceEndpoint).toHaveBeenCalledWith({ endpoint });
    expect(selected.openTargetEndpoint).toHaveBeenCalledWith({ binding });
    expect(selected.finalizeTarget).toHaveBeenCalledWith({ binding });
    expect(selected.verifyNormalOpen).toHaveBeenCalledWith({ binding });
    expect(selected.cleanupEndpoint).toHaveBeenCalledWith({ endpoint });
  });
});
