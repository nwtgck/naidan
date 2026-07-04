import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createHighlightWorkerClientMock } = vi.hoisted(() => ({
  createHighlightWorkerClientMock: vi.fn(),
}));

vi.mock('@/features/highlight/worker/client', () => ({
  createHighlightWorkerClient: createHighlightWorkerClientMock,
}));

describe('shared highlight worker client leases', () => {
  beforeEach(() => {
    vi.resetModules();
    createHighlightWorkerClientMock.mockReset();
  });

  it('shares one client and disposes it after the final lease is released', async () => {
    const client = {
      highlight: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    createHighlightWorkerClientMock.mockResolvedValue(client);
    const { acquireSharedHighlightWorkerClientLease } = await import('./client-shared');

    const firstLease = await acquireSharedHighlightWorkerClientLease();
    const secondLease = await acquireSharedHighlightWorkerClientLease();

    expect(firstLease.client).toBe(client);
    expect(secondLease.client).toBe(client);
    expect(createHighlightWorkerClientMock).toHaveBeenCalledOnce();

    await firstLease.release();
    expect(client.dispose).not.toHaveBeenCalled();

    await secondLease.release();
    await secondLease.release();
    expect(client.dispose).toHaveBeenCalledOnce();
  });


  it('keeps the client alive while a resolved second acquisition is still pending', async () => {
    const client = {
      highlight: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    createHighlightWorkerClientMock.mockResolvedValue(client);
    const { acquireSharedHighlightWorkerClientLease } = await import('./client-shared');

    const firstLease = await acquireSharedHighlightWorkerClientLease();
    const secondLeasePromise = acquireSharedHighlightWorkerClientLease();

    await firstLease.release();
    expect(client.dispose).not.toHaveBeenCalled();

    const secondLease = await secondLeasePromise;
    expect(secondLease.client).toBe(client);
    await secondLease.release();
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('clears a failed creation so a later acquisition can retry', async () => {
    const error = new Error('worker startup failed');
    const client = {
      highlight: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    createHighlightWorkerClientMock
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(client);
    const { acquireSharedHighlightWorkerClientLease } = await import('./client-shared');

    await expect(acquireSharedHighlightWorkerClientLease()).rejects.toBe(error);
    const lease = await acquireSharedHighlightWorkerClientLease();

    expect(lease.client).toBe(client);
    expect(createHighlightWorkerClientMock).toHaveBeenCalledTimes(2);
    await lease.release();
  });
});
