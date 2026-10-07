import { afterEach, expect, it, vi } from 'vitest';
import { createRpcStopControl } from './stop-control';
import type { RpcControlMessage } from './stop-control';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose(); vi.useRealTimers();
});
function setup() {
  const queue: { sender: string, message: RpcControlMessage }[] = [];
  let sequence = 0;
  const make = ({ name }: { name: string }) => {
    const control = createRpcStopControl({
      send: ({ message }) => queue.push({ sender: name, message }),
      nextId: () => `${name}-${++sequence}`,
      changed: vi.fn(),
      registryChanged: vi.fn(),
      timeoutMs: 100,
    });
    disposers.push(control.dispose); return control;
  };
  const a = make({ name: 'a' }), b = make({ name: 'b' });
  const deliver = () => {
    for (let i = 0; queue.length > 0; i++) {
      if (i > 100) throw new Error('Control message loop');
      const item = queue.shift()!; (item.sender === 'a' ? b : a).receive({ value: item.message });
    }
  };
  return { a, b, queue, deliver };
}
it('does not connect, stop or send on creation or owner registration', () => {
  const { a, queue } = setup(); const stop = vi.fn(async () => {});
  a.registerOwner({ ownerId: 'epoch-a', stop }); expect(stop).not.toHaveBeenCalled(); expect(queue).toEqual([]);
});
it('discovers the current owner and separates admission acknowledgement from retirement', async () => {
  const { a, b, deliver } = setup(); const retired = Promise.withResolvers<void>(); let admission = 'open';
  b.registerOwner({
    ownerId: 'epoch-b',
    stop: () => {
      admission = 'closed'; return retired.promise;
    },
  });
  a.requestStop(); expect(a.status()).toBe('checking'); deliver();
  expect(admission).toBe('closed'); expect(a.status()).toBe('applied');
  retired.resolve(); await Promise.resolve(); deliver(); expect(a.status()).toBe('retired');
});
it('ignores stop requests for an old ownership epoch', () => {
  const { a } = setup(); const oldStop = vi.fn(async () => {}), newStop = vi.fn(async () => {});
  const release = a.registerOwner({ ownerId: 'old', stop: oldStop }); release();
  a.registerOwner({ ownerId: 'new', stop: newStop });
  a.receive({ value: { type: 'stop', requestId: 'pending', ownerId: 'old' } });
  expect(oldStop).not.toHaveBeenCalled(); expect(newStop).not.toHaveBeenCalled();
});
it('ignores acknowledgements for superseded requests or another owner', () => {
  const { a, b, deliver } = setup(); b.registerOwner({ ownerId: 'epoch-b', stop: () => new Promise(() => {}) });
  a.requestStop(); deliver(); a.requestStop();
  a.receive({ value: { type: 'applied', requestId: 'a-1', ownerId: 'epoch-b' } });
  a.receive({ value: { type: 'retired', ownerId: 'epoch-b' } }); expect(a.status()).toBe('checking');
});
it('reports unconfirmed rather than successful stopping when the owner does not respond', async () => {
  vi.useFakeTimers(); const { a } = setup(); a.requestStop();
  await vi.advanceTimersByTimeAsync(101); expect(a.status()).toBe('unconfirmed');
});
it('can acknowledge a late response without a false success while waiting', async () => {
  vi.useFakeTimers(); const { a, b, deliver } = setup(); b.registerOwner({ ownerId: 'b', stop: () => new Promise(() => {}) });
  a.requestStop(); await vi.advanceTimersByTimeAsync(101); expect(a.status()).toBe('unconfirmed');
  deliver(); expect(a.status()).toBe('applied');
});
it('stops a locally owned manager synchronously and only once for repeated requests', async () => {
  const { a } = setup(); const gate = Promise.withResolvers<void>(), stop = vi.fn(() => gate.promise);
  a.registerOwner({ ownerId: 'a', stop }); a.requestStop(); expect(stop).toHaveBeenCalledOnce(); expect(a.status()).toBe('applied');
  a.requestStop(); expect(stop).toHaveBeenCalledOnce(); gate.resolve(); await Promise.resolve(); expect(a.status()).toBe('retired');
});
it('never claims retirement when native cleanup fails', async () => {
  const { a } = setup(); a.registerOwner({
    ownerId: 'a',
    stop: async () => {
      throw new Error('cleanup failed');
    },
  });
  a.requestStop(); await Promise.resolve(); expect(a.status()).toBe('unconfirmed');
  a.requestStop(); expect(a.status()).toBe('unconfirmed');
});
it('does not acknowledge a stop whose synchronous admission boundary threw', async () => {
  vi.useFakeTimers(); const { a } = setup(); a.registerOwner({
    ownerId: 'a',
    stop: () => {
      throw new Error('not applied');
    },
  });
  a.requestStop(); await vi.advanceTimersByTimeAsync(101); expect(a.status()).toBe('unconfirmed');
});
it('drops malformed messages and never interprets a grant command', () => {
  const { a } = setup(); const stop = vi.fn(async () => {}); a.registerOwner({ ownerId: 'a', stop });
  for (const value of [undefined, { type: 'enable' }, { type: 'stop', requestId: 'x', ownerId: 'a', allowedMethods: ['generateImage'] },
    { type: 'stop', requestId: 'x'.repeat(129), ownerId: 'a' }]) a.receive({ value });
  expect(stop).not.toHaveBeenCalled();
});
it('disposing ignores delayed messages and releases its response timer', async () => {
  vi.useFakeTimers(); const { a } = setup(); a.requestStop(); a.dispose(); await vi.advanceTimersByTimeAsync(200);
  expect(a.status()).toBe('idle'); expect(() => a.requestStop()).toThrow('closed');
});
it('clearing an old status neither stops work nor lets a late acknowledgement overwrite the new view', async () => {
  const { a } = setup(); const gate = Promise.withResolvers<void>(); const stop = vi.fn(() => gate.promise);
  a.registerOwner({ ownerId: 'a', stop }); a.requestStop(); expect(a.status()).toBe('applied');
  a.clearRequest(); expect(a.status()).toBe('idle'); gate.resolve(); await Promise.resolve(); expect(a.status()).toBe('idle');
  expect(stop).toHaveBeenCalledOnce();
});
it('an owner announcement after timeout never changes uncertainty into an unbounded requested state', async () => {
  vi.useFakeTimers(); const { a } = setup(); a.requestStop(); await vi.advanceTimersByTimeAsync(101);
  a.receive({ value: { type: 'owner', requestId: 'a-1', ownerId: 'b' } }); expect(a.status()).toBe('unconfirmed');
});

it('does not reenter the admission boundary or acknowledge it before it returns', async () => {
  const { a } = setup(), gate = Promise.withResolvers<void>();
  let first = true;
  let during: ReturnType<typeof a.status> | undefined;
  const stop = vi.fn(() => {
    if (first) {
      first = false; a.requestStop(); during = a.status();
    }
    return gate.promise;
  });
  a.registerOwner({ ownerId: 'reentrant-owner', stop }); a.requestStop();
  expect(stop).toHaveBeenCalledOnce(); expect(during).toBe('checking');
  expect(a.status()).toBe('applied');
  gate.resolve(); await Promise.resolve(); expect(a.status()).toBe('retired');
});

it('retains a synchronous stopping failure instead of rerunning its partially applied boundary', async () => {
  const { a, queue } = setup();
  const stop = vi.fn(() => {
    throw new Error('Admission state is uncertain');
  });
  a.registerOwner({ ownerId: 'failed-owner', stop });
  a.requestStop(); a.requestStop();
  expect(stop).toHaveBeenCalledOnce(); expect(a.status()).toBe('unconfirmed');
  expect(queue.some(item => item.message.type === 'applied')).toBe(false);
});
