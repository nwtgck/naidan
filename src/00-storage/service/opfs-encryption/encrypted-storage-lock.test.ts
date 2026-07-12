import { afterEach, describe, expect, it } from 'vitest';
import { TEST_ONLY } from './encrypted-storage-lock';

afterEach(() => {
  TEST_ONLY.localLockStates.clear();
});

describe('encrypted storage local lock', () => {
  it('does not queue an exclusive best-effort cleanup behind an active reader', async () => {
    const lockName = `best-effort-exclusive-${crypto.randomUUID()}`;
    const reader = await TEST_ONLY.acquireLocalLock({
      lockName,
      mode: 'shared',
    });

    await expect(TEST_ONLY.tryAcquireLocalLock({
      lockName,
      mode: 'exclusive',
    })).resolves.toBeUndefined();

    const anotherReader = await TEST_ONLY.tryAcquireLocalLock({
      lockName,
      mode: 'shared',
    });
    expect(anotherReader).toBeDefined();
    anotherReader?.release();
    await anotherReader?.completion;

    reader.release();
    await reader.completion;

    const writer = await TEST_ONLY.tryAcquireLocalLock({
      lockName,
      mode: 'exclusive',
    });
    expect(writer).toBeDefined();
    writer?.release();
    await writer?.completion;
  });

  it('does not let a best-effort reader bypass a queued writer', async () => {
    const lockName = `queued-writer-${crypto.randomUUID()}`;
    const firstReader = await TEST_ONLY.acquireLocalLock({
      lockName,
      mode: 'shared',
    });
    const writerPromise = TEST_ONLY.acquireLocalLock({
      lockName,
      mode: 'exclusive',
    });

    await expect(TEST_ONLY.tryAcquireLocalLock({
      lockName,
      mode: 'shared',
    })).resolves.toBeUndefined();

    firstReader.release();
    await firstReader.completion;
    const writer = await writerPromise;
    writer.release();
    await writer.completion;
  });
});
