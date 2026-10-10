import vm from 'node:vm';
import { BroadcastChannel } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const envelopeSchema = z.object({ value: z.string(), nested: z.object({ count: z.number() }) });

describe('actual internal message serialization (Node, not a browser origin test)', () => {
  it('delivers a copied envelope without using network or persistent storage', async () => {
    const name = `effects-${randomUUID()}`;
    const sender = new BroadcastChannel(name);
    const receiver = new BroadcastChannel(name);
    const message = { value: 'before', nested: { count: 1 } };
    try {
      const incoming = new Promise<z.infer<typeof envelopeSchema>>((resolve, reject) => {
        receiver.onmessage = event => {
          const result = envelopeSchema.safeParse(event.data);
          if (result.success) resolve(result.data); else reject(result.error);
        };
        receiver.onmessageerror = reject;
      });
      sender.postMessage(message);
      message.value = 'after'; message.nested.count = 2;
      expect(await incoming).toEqual({ value: 'before', nested: { count: 1 } });
    } finally {
      sender.close(); receiver.close();
    }
  });

  it('executes an enumerable getter while serializing even with no receiver', () => {
    const sender = new BroadcastChannel(`effects-${randomUUID()}`);
    let reads = 0;
    try {
      sender.postMessage({
        get value() {
          reads++; return 'x';
        },
      });
      expect(reads).toBe(1);
    } finally {
      sender.close();
    }
  });

  it('does not use the TypeScript view as an enumerable property filter', () => {
    const sender = new BroadcastChannel(`effects-${randomUUID()}`);
    let reads = 0;
    const original = {
      value: 'x',
      get hidden() {
        reads++; return 'secret';
      },
    };
    const view: { value: string } = original;
    try {
      sender.postMessage(view); expect(reads).toBe(1);
    } finally {
      sender.close();
    }
  });

  it('does not assimilate a then method like Promise resolution', () => {
    const sender = new BroadcastChannel(`effects-${randomUUID()}`);
    let called = 0;
    try {
      expect(() => sender.postMessage({
        then() {
          called++;
        },
      })).toThrow();
      expect(called).toBe(0);
    } finally {
      sender.close();
    }
  });

  it('rejects a function even when there is no listener', () => {
    const sender = new BroadcastChannel(`effects-${randomUUID()}`);
    let called = 0;
    try {
      expect(() => sender.postMessage(() => {
        called++;
      })).toThrow();
      expect(called).toBe(0);
    } finally {
      sender.close();
    }
  });

  it('does not clone custom enumerable properties of a platform Blob', () => {
    let reads = 0;
    const blob = new Blob(['x']);
    Object.defineProperty(blob, 'extra', {
      enumerable: true,
      get() {
        reads++; return 'x';
      },
    });
    const clone = structuredClone(blob);
    expect(clone.size).toBe(1); expect(reads).toBe(0);
  });

  it('executes a conversion hook on a local binding named undefined', () => {
    let writes = 0;
    vm.runInNewContext(`(() => { const undefined = { toString() { save(); return '*'; } }; String(undefined); })()`, {
      save: () => {
        writes++;
      },
    });
    expect(writes).toBe(1);
  });

  it('executes the targetOrigin getter in an options dictionary read, not its unrelated callback', () => {
    // The browser overload itself is verified separately with Chromium. This
    // test only records why dictionary reads cannot use an open shape as proof.
    let reads = 0;
    let called = 0;
    const options = {
      get targetOrigin() {
        reads++; return '/';
      },
      unrelated() {
        called++;
      },
    };
    const view: object = options;
    expect(Reflect.get(view, 'targetOrigin')).toBe('/');
    expect(reads).toBe(1); expect(called).toBe(0);
  });
});
