import { describe, expect, it, vi } from 'vitest';
import type { NaidanPersistenceControlV1 } from '@/00-storage/service/naidan-persistence-control/00-format';
import { TEST_ONLY as RUNTIME_CONTRACT_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import {
  validatePhaseSpecificPersistenceEndpointReadiness,
  type PhaseSpecificEndpointInspectionPort,
} from '@/00-storage/service/naidan-opfs/native-persistence-endpoint-readiness';

function port({ hizofs = 'absent', plain = 'fully_verified' }: {
  hizofs?: Awaited<ReturnType<PhaseSpecificEndpointInspectionPort['inspectHizoFSEndpoint']>>;
  plain?: Awaited<ReturnType<PhaseSpecificEndpointInspectionPort['inspectPlainEndpoint']>>;
} = {}): PhaseSpecificEndpointInspectionPort & {
  inspectHizoFSEndpoint: ReturnType<typeof vi.fn<PhaseSpecificEndpointInspectionPort['inspectHizoFSEndpoint']>>;
  inspectPlainEndpoint: ReturnType<typeof vi.fn<PhaseSpecificEndpointInspectionPort['inspectPlainEndpoint']>>;
} {
  return {
    inspectHizoFSEndpoint: vi.fn(async () => hizofs),
    inspectPlainEndpoint: vi.fn(async () => plain),
  };
}

function control({ operation, phase, sourceFileSystemId, targetFileSystemId }: {
  operation: 'decrypt' | 'encrypt' | 're_encrypt';
  phase: 'building_target' | 'cleaning_up_source';
  sourceFileSystemId: string | undefined;
  targetFileSystemId: string | undefined;
}): NaidanPersistenceControlV1 {
  return RUNTIME_CONTRACT_TEST_ONLY.createTransitioningInspection({
    operation,
    phase,
    sourceFileSystemId,
    targetFileSystemId,
  }).control;
}

describe('phase-specific native Persistence Control endpoint readiness', () => {
  it('projects a stable authenticated HizoFS normal open without reopening it', async () => {
    const inspection = RUNTIME_CONTRACT_TEST_ONLY.createEncryptedInspection({ fileSystemId: 'stableFileSystem00001' });
    const endpointPort = port();

    await expect(validatePhaseSpecificPersistenceEndpointReadiness({
      control: inspection.control,
      openedAuthenticationEndpoint: {
        fileSystemId: inspection.mode.activeFileSystemId,
        openProfile: 'normal_read',
      },
      port: endpointPort,
    })).resolves.toBe('valid');

    expect(endpointPort.inspectHizoFSEndpoint).not.toHaveBeenCalled();
    expect(endpointPort.inspectPlainEndpoint).not.toHaveBeenCalled();
  });

  it('requires normal plain traversal while accepting a root-key-only encrypt target', async () => {
    const transition = control({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'encryptTarget00000001',
    });
    if (transition.mode.type !== 'transitioning' || transition.mode.phase.target.type !== 'hizofs') {
      throw new Error('expected encrypt transition');
    }
    const endpointPort = port();

    await expect(validatePhaseSpecificPersistenceEndpointReadiness({
      control: transition,
      openedAuthenticationEndpoint: {
        fileSystemId: transition.mode.phase.target.fileSystemId,
        openProfile: 'root_key_proof',
      },
      port: endpointPort,
    })).resolves.toBe('valid');

    expect(endpointPort.inspectPlainEndpoint).toHaveBeenCalledOnce();
    expect(endpointPort.inspectHizoFSEndpoint).not.toHaveBeenCalled();
  });

  it('allows an absent re-encrypt building target while requiring the authenticated source normal open', async () => {
    const transition = control({
      operation: 're_encrypt',
      phase: 'building_target',
      sourceFileSystemId: 'reencryptSource00001',
      targetFileSystemId: 'reencryptTarget00001',
    });
    if (transition.mode.type !== 'transitioning' || transition.mode.phase.source.type !== 'hizofs') {
      throw new Error('expected re-encrypt transition');
    }
    const endpointPort = port({ hizofs: 'absent' });

    await expect(validatePhaseSpecificPersistenceEndpointReadiness({
      control: transition,
      openedAuthenticationEndpoint: {
        fileSystemId: transition.mode.phase.source.fileSystemId,
        openProfile: 'normal_read',
      },
      port: endpointPort,
    })).resolves.toBe('valid');

    expect(endpointPort.inspectHizoFSEndpoint).toHaveBeenCalledWith({
      fileSystemId: transition.mode.phase.target.type === 'hizofs'
        ? transition.mode.phase.target.fileSystemId
        : undefined,
      openProfile: 'root_key_proof',
    });
  });

  it('requires the cleaning target normal open and does not reopen a retired re-encrypt source', async () => {
    const transition = control({
      operation: 're_encrypt',
      phase: 'cleaning_up_source',
      sourceFileSystemId: 'oldFileSystem0000001',
      targetFileSystemId: 'newFileSystem0000001',
    });
    if (transition.mode.type !== 'transitioning' || transition.mode.phase.target.type !== 'hizofs') {
      throw new Error('expected re-encrypt transition');
    }
    const endpointPort = port();

    await expect(validatePhaseSpecificPersistenceEndpointReadiness({
      control: transition,
      openedAuthenticationEndpoint: {
        fileSystemId: transition.mode.phase.target.fileSystemId,
        openProfile: 'normal_read',
      },
      port: endpointPort,
    })).resolves.toBe('valid');

    expect(endpointPort.inspectHizoFSEndpoint).not.toHaveBeenCalled();
  });

  it('requires a fully traversable plain target during decrypt cleanup', async () => {
    const transition = control({
      operation: 'decrypt',
      phase: 'cleaning_up_source',
      sourceFileSystemId: 'decryptSource0000001',
      targetFileSystemId: undefined,
    });
    if (transition.mode.type !== 'transitioning' || transition.mode.phase.source.type !== 'hizofs') {
      throw new Error('expected decrypt transition');
    }
    const endpointPort = port({ plain: 'invalid' });

    await expect(validatePhaseSpecificPersistenceEndpointReadiness({
      control: transition,
      openedAuthenticationEndpoint: {
        fileSystemId: transition.mode.phase.source.fileSystemId,
        openProfile: 'root_key_proof',
      },
      port: endpointPort,
    })).resolves.toBe('invalid');

    expect(endpointPort.inspectPlainEndpoint).toHaveBeenCalledOnce();
  });

  it('rejects an authentication profile that is weaker than the phase requires', async () => {
    const inspection = RUNTIME_CONTRACT_TEST_ONLY.createEncryptedInspection({ fileSystemId: 'stableFileSystem00002' });

    await expect(validatePhaseSpecificPersistenceEndpointReadiness({
      control: inspection.control,
      openedAuthenticationEndpoint: {
        fileSystemId: inspection.mode.activeFileSystemId,
        openProfile: 'root_key_proof',
      },
      port: port(),
    })).rejects.toThrow('does not match Persistence Control phase readiness');
  });

  it('propagates secondary endpoint infrastructure failures', async () => {
    const transition = control({
      operation: 're_encrypt',
      phase: 'building_target',
      sourceFileSystemId: 'sourceInfrastructure01',
      targetFileSystemId: 'targetInfrastructure01',
    });
    if (transition.mode.type !== 'transitioning' || transition.mode.phase.source.type !== 'hizofs') {
      throw new Error('expected re-encrypt transition');
    }
    const endpointPort = port();
    endpointPort.inspectHizoFSEndpoint.mockRejectedValueOnce(new Error('native OPFS read failed'));

    await expect(validatePhaseSpecificPersistenceEndpointReadiness({
      control: transition,
      openedAuthenticationEndpoint: {
        fileSystemId: transition.mode.phase.source.fileSystemId,
        openProfile: 'normal_read',
      },
      port: endpointPort,
    })).rejects.toThrow('native OPFS read failed');
  });
});
