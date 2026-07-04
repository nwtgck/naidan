import { describe, expect, expectTypeOf, it } from 'vitest';
import { promiseAllKeyed } from './promise';

describe('promiseAllKeyed', () => {
  it('preserves keys when promises resolve in a different order', async () => {
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();

    const resultPromise = promiseAllKeyed({
      first: first.promise,
      second: second.promise,
    });

    second.resolve('second result');
    first.resolve('first result');

    const result = await resultPromise;
    expect(result.first).toBe('first result');
    expect(result.second).toBe('second result');
  });

  it('preserves precise awaited value types', async () => {
    const result = await promiseAllKeyed({
      user: Promise.resolve({ id: 'user-1' }),
      count: 3 as const,
    });

    expectTypeOf(result.user).toEqualTypeOf<{ id: string }>();
    expectTypeOf(result.count).toEqualTypeOf<3>();
  });

  it('accepts typed dictionary interfaces and plain values', async () => {
    interface Requests {
      user: Promise<{ id: string }>,
      count: number,
    }

    const requests: Requests = {
      user: Promise.resolve({ id: 'user-1' }),
      count: 3,
    };
    const result = await promiseAllKeyed(requests);

    expect(result.user).toEqual({ id: 'user-1' });
    expect(result.count).toBe(3);
    expectTypeOf(result.user).toEqualTypeOf<{ id: string }>();
    expectTypeOf(result.count).toEqualTypeOf<number>();
  });

  it('preserves unique symbol key types', async () => {
    const symbolKey = Symbol('symbolKey');
    const result = await promiseAllKeyed({
      [symbolKey]: Promise.resolve('symbol value'),
    });

    expect(result[symbolKey]).toBe('symbol value');
    expectTypeOf(result[symbolKey]).toEqualTypeOf<string>();
  });

  it('returns an already-fulfilled promise for an empty dictionary', async () => {
    const events: string[] = [];
    const resultPromise = promiseAllKeyed({});

    void resultPromise.then(() => {
      events.push('result');
    });
    queueMicrotask(() => {
      events.push('later microtask');
    });

    const result = await resultPromise;
    await Promise.resolve();

    expect(events).toEqual(['result', 'later microtask']);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Reflect.ownKeys(result)).toEqual([]);
  });

  it('rejects positional collection inputs at the type boundary', () => {
    const compileOnly = () => {
      // @ts-expect-error Arrays are positional collections, not keyed dictionaries.
      void promiseAllKeyed([Promise.resolve(1)]);
      // @ts-expect-error Functions are callable objects, not keyed dictionaries.
      void promiseAllKeyed(() => Promise.resolve(1));
    };

    expect(compileOnly).toBeTypeOf('function');
  });

  it('uses own enumerable string and symbol properties only', async () => {
    const symbolKey = Symbol('symbolKey');
    const input = Object.create({
      inherited: Promise.resolve('inherited'),
    }) as Record<PropertyKey, unknown>;

    input.visible = Promise.resolve('visible');
    input[symbolKey] = Promise.resolve('symbol');
    Object.defineProperty(input, 'hidden', {
      enumerable: false,
      value: Promise.resolve('hidden'),
    });

    const result = await promiseAllKeyed(input);

    expect(result.visible).toBe('visible');
    expect(result[symbolKey]).toBe('symbol');
    expect(Object.hasOwn(result, 'inherited')).toBe(false);
    expect(Object.hasOwn(result, 'hidden')).toBe(false);
  });

  it('returns a null-prototype object with ordinary data properties', async () => {
    const result = await promiseAllKeyed({
      ['__proto__']: Promise.resolve('value'),
    });

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(result['__proto__']).toBe('value');
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')).toEqual({
      configurable: true,
      enumerable: true,
      value: 'value',
      writable: true,
    });
  });

  it('rejects when an input rejects', async () => {
    const error = new Error('request failed');

    await expect(promiseAllKeyed({
      successful: Promise.resolve('value'),
      failed: Promise.reject(error),
    })).rejects.toBe(error);
  });

  it('converts property access errors to promise rejections', async () => {
    const input = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(input, 'first', {
      enumerable: true,
      value: Promise.reject(new Error('earlier rejection')),
    });
    Object.defineProperty(input, 'second', {
      enumerable: true,
      get() {
        throw new Error('property access failed');
      },
    });

    await expect(promiseAllKeyed(input)).rejects.toThrow('property access failed');
  });

  it('converts own-key enumeration errors to promise rejections', async () => {
    const error = new Error('ownKeys failed');
    const input = new Proxy({}, {
      ownKeys() {
        throw error;
      },
    });

    await expect(promiseAllKeyed(input)).rejects.toBe(error);
  });

  it('reads each enumerable property once', async () => {
    let readCount = 0;
    const input = {
      get value() {
        readCount++;
        return Promise.resolve('value');
      },
    };

    const result = await promiseAllKeyed(input);

    expect(result.value).toBe('value');
    expect(readCount).toBe(1);
  });
});
