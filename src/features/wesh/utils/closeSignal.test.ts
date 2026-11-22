import { describe, expect, it, vi } from 'vitest';
import { WeshHandleCloseSignal } from './closeSignal';

describe('Wesh handle close notification', () => {
  it('resolves outstanding I/O on close and keeps results already returned to callers', async () => {
    const signal = new WeshHandleCloseSignal();
    const buildClosedResult = vi.fn(() => 'closed');
    const complete = await signal.raceWithClose({ operation: Promise.resolve('complete'), buildClosedResult });
    const blockedRead = Promise.withResolvers<string>();
    const blockedWrite = Promise.withResolvers<string>();
    const read = signal.raceWithClose({ operation: blockedRead.promise, buildClosedResult });
    const write = signal.raceWithClose({ operation: blockedWrite.promise, buildClosedResult });

    signal.close();
    signal.close();

    expect(complete).toBe('complete');
    await expect(read).resolves.toBe('closed');
    await expect(write).resolves.toBe('closed');
    blockedRead.resolve('late read');
    blockedWrite.reject(new Error('late write failure'));
    expect(buildClosedResult).toHaveBeenCalledTimes(2);
  });

  it('delivers an I/O completion already queued in the close turn', async () => {
    const signal = new WeshHandleCloseSignal();
    const operation = Promise.withResolvers<string>();
    const read = signal.raceWithClose({ operation: operation.promise, buildClosedResult: () => 'closed' });

    signal.close();
    operation.resolve('accepted');

    await expect(read).resolves.toBe('accepted');
  });

  it('surfaces an I/O rejection that settles before close', async () => {
    const signal = new WeshHandleCloseSignal();
    const error = new Error('read failed');
    const read = signal.raceWithClose({ operation: Promise.reject(error), buildClosedResult: () => undefined });

    await expect(read).rejects.toBe(error);
    signal.close();
  });

  it('observes a rejection from an operation supplied after close', async () => {
    const signal = new WeshHandleCloseSignal();
    signal.close();
    const write = signal.raceWithClose({
      operation: Promise.reject(new Error('write failed')),
      buildClosedResult: () => 'closed',
    });

    await expect(write).resolves.toBe('closed');
  });
});
