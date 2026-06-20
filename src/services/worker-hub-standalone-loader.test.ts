import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureFileProtocolStandaloneWorkerMock,
  getFileProtocolStandaloneWorkerMockState,
} from '@/test-mocks/file-protocol-standalone-worker'
import {
  createFileProtocolCompatibleStandaloneWorkerHub,
  getFileProtocolCompatibleStandaloneWorkerHubDiagnostics,
  warmFileProtocolCompatibleStandaloneWorkerHubAssetAtIdle,
} from './worker-hub-standalone-loader'

const baseDiagnostics = {
  workerId: 'file-protocol-compatible-standalone-worker-hub',
  registryScriptLoads: 1,
  registryScriptLoadFailures: 0,
  blobRegistrations: 1,
  objectUrlsCreated: 1,
  workersCreated: 2,
  workersTerminated: 1,
  activeWorkers: 1,
  runtimeDigestCalls: 0,
  sourceStoredAsGlobalString: false as const,
  objectUrlLifetime: 'page' as const,
  registryEntryReleased: true,
  registryEntryPresent: false,
  blobUrlReady: true,
  timingsMs: {},
}

describe('worker-hub-standalone-loader', () => {
  beforeEach(() => {
    configureFileProtocolStandaloneWorkerMock({
      factory: async () => {
        throw new Error('Worker factory was not configured by this test.')
      },
      nextDiagnostics: baseDiagnostics,
    })
  })

  it('creates a named Worker through the shared file-protocol asset factory', async () => {
    const worker = { terminate: vi.fn() } as unknown as Worker
    const factory = vi.fn(async () => worker)
    configureFileProtocolStandaloneWorkerMock({
      factory,
      nextDiagnostics: baseDiagnostics,
    })

    await expect(createFileProtocolCompatibleStandaloneWorkerHub()).resolves.toBe(worker)
    expect(factory).toHaveBeenCalledWith({
      name: 'file-protocol-compatible-standalone-worker-hub',
    })
  })

  it('delegates idle warming without creating a Worker instance', () => {
    const factory = vi.fn(async () => ({ terminate: vi.fn() } as unknown as Worker))
    configureFileProtocolStandaloneWorkerMock({
      factory,
      nextDiagnostics: baseDiagnostics,
    })

    warmFileProtocolCompatibleStandaloneWorkerHubAssetAtIdle()

    expect(getFileProtocolStandaloneWorkerMockState().warmCallCount).toBe(1)
    expect(factory).not.toHaveBeenCalled()
  })

  it('exposes plugin diagnostics without adding a second state model', () => {
    expect(getFileProtocolCompatibleStandaloneWorkerHubDiagnostics()).toEqual(baseDiagnostics)
  })
})
