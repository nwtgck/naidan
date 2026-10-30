import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toVolumeId } from '@/01-models/ids';
import { openLiveWesh } from './wesh';
import { shellCall } from './controller.test-support';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), mount: vi.fn(), client: vi.fn(), tool: vi.fn(), format: vi.fn() }));
vi.mock('@/00-storage/service', () => ({ storageService: { resolveVolumeAccess: mocks.resolve } }));
vi.mock('@/features/wesh/volume-mount', () => ({ volumeAccessToWeshMount: mocks.mount }));
vi.mock('@/features/wesh/worker/client', () => ({ createFileProtocolCompatibleWeshWorkerClient: mocks.client }));
vi.mock('@/features/tools/wesh', () => ({ createWeshTool: mocks.tool }));
vi.mock('@/01-models/tool', () => ({ formatToolExecutionOutcomeForLm: mocks.format }));

beforeEach(() => vi.resetAllMocks());

function fixture() {
  const dispose = vi.fn(async () => {});
  const execute = vi.fn(async (_request: { args: unknown, signal: AbortSignal }) => ({ result: 'done' }));
  const volumeId = toVolumeId({ raw: 'live-volume' });
  const mount = { mountPoint: '/workspace' };
  mocks.resolve.mockResolvedValue({ type: 'test-volume' });
  mocks.mount.mockReturnValue(mount);
  mocks.client.mockResolvedValue({ dispose });
  mocks.tool.mockReturnValue({ name: 'shell_execute', description: 'Shell', execute });
  mocks.format.mockReturnValue('done');
  return { dispose, execute, volumeId, mount };
}

describe('live Wesh process ownership', () => {
  it('mounts only the explicitly selected persistent workspace and closes the process', async () => {
    const f = fixture();
    const session = await openLiveWesh({ volumeId: f.volumeId, access: 'read-only', signal: new AbortController().signal });
    await using resource = {
      async [Symbol.asyncDispose]() {
        await session.close();
      },
    };
    expect(mocks.mount.mock.calls[0]?.[0].mount).toEqual({ type: 'volume', volumeId: f.volumeId, mountPath: '/workspace', readOnly: true });
    expect(mocks.client).toHaveBeenCalledWith({ rootHandle: 'readonly', mounts: [f.mount], user: 'user', initialEnv: {}, initialCwd: '/workspace' });
    expect(await session.execute({ call: shellCall, signal: new AbortController().signal })).toBe('done');
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({ args: { shell_script: 'ls /workspace', stdout_limit: 16384, stderr_limit: 8192, timeout_ms: 8000 } });
    await session.close();
    await session.close();
    expect(f.dispose).toHaveBeenCalledOnce();
    await expect(session.execute({ call: shellCall, signal: new AbortController().signal })).rejects.toThrow('closed');
    void resource;
  });

  it('allows writes only when explicitly selected', async () => {
    const f = fixture();
    const session = await openLiveWesh({ volumeId: f.volumeId, access: 'read-write', signal: new AbortController().signal });
    await using resource = {
      async [Symbol.asyncDispose]() {
        await session.close();
      },
    };
    expect(mocks.mount.mock.calls[0]?.[0].mount.readOnly).toBe(false);
    void resource;
  });

  it('disposes an acquired client if tool initialization fails', async () => {
    const f = fixture();
    mocks.tool.mockImplementation(() => {
      throw new Error('tool initialization failed');
    });
    await expect(openLiveWesh({ volumeId: f.volumeId, access: 'read-only', signal: new AbortController().signal })).rejects.toThrow('tool initialization failed');
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it('disposes a client that resolves after session cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    mocks.client.mockImplementation(async () => {
      controller.abort();
      return { dispose: f.dispose };
    });
    await expect(openLiveWesh({ volumeId: f.volumeId, access: 'read-only', signal: controller.signal })).rejects.toThrow();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(mocks.tool).not.toHaveBeenCalled();
  });

  it('never creates a worker for a missing mount', async () => {
    const f = fixture();
    mocks.mount.mockReturnValue(undefined);
    await expect(openLiveWesh({ volumeId: f.volumeId, access: 'read-only', signal: new AbortController().signal })).rejects.toThrow('missing');
    expect(mocks.client).not.toHaveBeenCalled();
  });
});
