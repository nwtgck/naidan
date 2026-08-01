import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import { parseTransitionOperationId, type NaidanPersistenceEndpointV1 } from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  validatePersistenceEndpointReadiness,
  type TransitionEndpointReadiness,
  type TransitionEndpointReadinessProvider,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-endpoint-readiness';
import { createBuildingTransitionMode, planTransitionAuthoritySwitch } from '@/00-storage/service/naidan-persistence-control/transition/transition-state-machine';

const SOURCE = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
const TARGET = parsePortableFileSystemId({ value: 'ABCDEFGHIJ_0123456789' });
const OPERATION = parseTransitionOperationId({ value: 'transition_0123456789' });
const source = { fileSystemId: SOURCE, type: 'hizofs' } as const;
const target = { fileSystemId: TARGET, type: 'hizofs' } as const;

function key({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): string {
  return endpoint.type === 'plain' ? 'plain' : endpoint.fileSystemId;
}

function provider(states: Readonly<Record<string, TransitionEndpointReadiness>>): TransitionEndpointReadinessProvider {
  return {
    inspectEndpoint: async ({ endpoint }) => states[key({ endpoint })] ?? 'absent',
  };
}

function cleaningReEncrypt() {
  const building = createBuildingTransitionMode({ operationId: OPERATION, source, target });
  return planTransitionAuthoritySwitch({
    mode: building,
    verification: {
      contentVerified: true,
      metadataVerified: true,
      operationId: OPERATION,
      source,
      target,
      targetDurable: true,
      targetNormalOpenVerified: true,
      targetWriterClosed: true,
    },
  });
}

describe('Persistence Control endpoint readiness adapter', () => {
  it('requires stable endpoints to be fully verified', async () => {
    await expect(validatePersistenceEndpointReadiness({ mode: { type: 'plain' }, provider: provider({ plain: 'root_key_ready' }) })).resolves.toBe('invalid');
    await expect(validatePersistenceEndpointReadiness({ mode: { type: 'plain' }, provider: provider({ plain: 'fully_verified' }) })).resolves.toBe('valid');
    await expect(validatePersistenceEndpointReadiness({ mode: { activeFileSystemId: SOURCE, type: 'hizofs' }, provider: provider({ [SOURCE]: 'root_key_ready' }) })).resolves.toBe('invalid');
  });

  it('requires the building source to remain fully verified', async () => {
    const mode = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    await expect(validatePersistenceEndpointReadiness({ mode, provider: provider({ [SOURCE]: 'root_key_ready', [TARGET]: 'absent' }) })).resolves.toBe('invalid');
  });

  it('requires the plain-to-HizoFS target root-key plane before publishing building control', async () => {
    const plain = { type: 'plain' } as const;
    const mode = createBuildingTransitionMode({ operationId: OPERATION, source: plain, target });
    await expect(validatePersistenceEndpointReadiness({ mode, provider: provider({ plain: 'fully_verified', [TARGET]: 'absent' }) })).resolves.toBe('invalid');
    await expect(validatePersistenceEndpointReadiness({ mode, provider: provider({ plain: 'fully_verified', [TARGET]: 'root_key_ready' }) })).resolves.toBe('valid');
  });

  it('allows an absent non-authoritative re-encrypt target while building', async () => {
    const mode = createBuildingTransitionMode({ operationId: OPERATION, source, target });
    await expect(validatePersistenceEndpointReadiness({ mode, provider: provider({ [SOURCE]: 'fully_verified', [TARGET]: 'absent' }) })).resolves.toBe('valid');
  });

  it('requires the cleaning target to be fully verified', async () => {
    const mode = cleaningReEncrypt();
    await expect(validatePersistenceEndpointReadiness({ mode, provider: provider({ [SOURCE]: 'fully_verified', [TARGET]: 'root_key_ready' }) })).resolves.toBe('invalid');
    await expect(validatePersistenceEndpointReadiness({ mode, provider: provider({ [SOURCE]: 'absent', [TARGET]: 'fully_verified' }) })).resolves.toBe('valid');
  });

  it('rejects a HizoFS-only root-key readiness category for a plain endpoint', async () => {
    const plain = { type: 'plain' } as const;
    const decryptBuilding = createBuildingTransitionMode({ operationId: OPERATION, source, target: plain });
    await expect(validatePersistenceEndpointReadiness({
      mode: decryptBuilding,
      provider: provider({ [SOURCE]: 'fully_verified', plain: 'root_key_ready' }),
    })).resolves.toBe('invalid');

    const encryptBuilding = createBuildingTransitionMode({ operationId: OPERATION, source: plain, target });
    const encryptCleaning = planTransitionAuthoritySwitch({
      mode: encryptBuilding,
      verification: {
        contentVerified: true,
        metadataVerified: true,
        operationId: OPERATION,
        source: plain,
        target,
        targetDurable: true,
        targetNormalOpenVerified: true,
        targetWriterClosed: true,
      },
    });
    await expect(validatePersistenceEndpointReadiness({
      mode: encryptCleaning,
      provider: provider({ plain: 'root_key_ready', [TARGET]: 'fully_verified' }),
    })).resolves.toBe('invalid');
  });

  it('keeps the decrypt source root-key plane until stable plain authority is published', async () => {
    const plain = { type: 'plain' } as const;
    const building = createBuildingTransitionMode({ operationId: OPERATION, source, target: plain });
    const cleaning = planTransitionAuthoritySwitch({
      mode: building,
      verification: {
        contentVerified: true,
        metadataVerified: true,
        operationId: OPERATION,
        source,
        target: plain,
        targetDurable: true,
        targetNormalOpenVerified: true,
        targetWriterClosed: true,
      },
    });
    await expect(validatePersistenceEndpointReadiness({ mode: cleaning, provider: provider({ [SOURCE]: 'absent', plain: 'fully_verified' }) })).resolves.toBe('invalid');
    await expect(validatePersistenceEndpointReadiness({ mode: cleaning, provider: provider({ [SOURCE]: 'root_key_ready', plain: 'fully_verified' }) })).resolves.toBe('valid');
  });
});
