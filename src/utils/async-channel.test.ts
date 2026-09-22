import { describe, expect, it, vi } from 'vitest';
import { createAsyncChannel } from './async-channel';

describe('bounded async channel', () => {
  it('blocks a producer at capacity, then drains accepted values after close', async () => {
    const channel = createAsyncChannel<string>({ capacity: 1, onCancel: () => {} });
    await channel.send({ value: 'A' });
    let sent = false;
    const pending = channel.send({ value: 'B' }).then(() => {
      sent = true;
    });
    await Promise.resolve(); expect(sent).toBe(false);
    const iterator = channel.values[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 'A', done: false });
    await pending; channel.close();
    expect(await iterator.next()).toEqual({ value: 'B', done: false });
    expect((await iterator.next()).done).toBe(true);
  });
  it('cancellation settles pending reads and writers without preserving unread values', async () => {
    const cancelled = vi.fn(); const channel = createAsyncChannel<string>({ capacity: 1, onCancel: cancelled });
    await channel.send({ value: 'A' });
    const write = channel.send({ value: 'B' });
    const failure = expect(write).rejects.toThrow('closed');
    const iterator = channel.values[Symbol.asyncIterator]();
    await iterator.return?.(); await failure;
    expect((await iterator.next()).done).toBe(true); expect(cancelled).toHaveBeenCalledOnce();
    const empty = createAsyncChannel<string>({ capacity: 1, onCancel: () => {} });
    const reader = empty.values[Symbol.asyncIterator](); const read = reader.next();
    empty.cancel(); expect((await read).done).toBe(true);
  });
  it('rejects a second reader and invalid capacities', () => {
    const channel = createAsyncChannel<string>({ capacity: 1, onCancel: () => {} });
    channel.values[Symbol.asyncIterator]();
    expect(() => channel.values[Symbol.asyncIterator]()).toThrow('already');
    expect(() => createAsyncChannel({ capacity: 0, onCancel: () => {} })).toThrow('capacity');
  });
});
