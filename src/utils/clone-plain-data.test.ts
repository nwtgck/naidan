import { installSecretEqualityTester } from '@/utils/secret.test-support';
import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import { clonePlainData } from './clone-plain-data';
import { Secret } from './secret';

installSecretEqualityTester();

describe('clonePlainData', () => {
  it('copies Vue drafts without losing secrets or revealing their values', () => {
    const secret = Secret.from({ value: 'preserve-this-value' });
    const source = reactive({ endpoint: { headers: [['X-Key', secret]] }, title: { secret }, absent: undefined });
    const copy = clonePlainData({ value: source });
    expect(copy).not.toBe(source);
    expect(copy.endpoint).not.toBe(source.endpoint);
    expect(copy.endpoint.headers).not.toBe(source.endpoint.headers);
    expect(copy.title.secret).toBe(secret);
    expect(copy.title.secret.reveal()).toBe('preserve-this-value');
    expect(Object.hasOwn(copy, 'absent')).toBe(true);
    expect(JSON.stringify(copy)).not.toContain('preserve-this-value');
  });

  it('preserves cycles, aliases, null prototypes and sparse arrays', () => {
    const shared = Object.assign(Object.create(null) as { value: string }, { value: 'value' });
    const source: { left: typeof shared, right: typeof shared, self?: unknown, sparse: unknown[] } = { left: shared, right: shared, sparse: new Array(3) };
    source.self = source;
    source.sparse[1] = shared;
    const copy = clonePlainData({ value: source });
    expect(copy.self).toBe(copy);
    expect(copy.left).toBe(copy.right);
    expect(copy.left).not.toBe(shared);
    expect(Object.getPrototypeOf(copy.left)).toBe(null);
    expect(copy.sparse).toHaveLength(3);
    expect(0 in copy.sparse).toBe(false);
    expect(copy.sparse[1]).toBe(copy.left);
  });

  it('retains non-enumerable compatibility fields and symbol keys in editable copies', () => {
    const key = Symbol('metadata');
    const source = { [key]: { n: 1 }, visible: 'yes' };
    Object.defineProperty(source, 'unreadable', { value: { future: true }, enumerable: false });
    Object.freeze(source);
    const copy = clonePlainData({ value: source });
    expect(copy[key]).toEqual({ n: 1 });
    expect(copy[key]).not.toBe(source[key]);
    expect(Object.getOwnPropertyDescriptor(copy, 'unreadable')).toEqual({ value: { future: true }, enumerable: false, configurable: true, writable: true });
    copy.visible = 'edited';
    expect(source.visible).toBe('yes');
  });

  it('preserves dangerous property names as own data without changing the prototype', () => {
    const source: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    const copy = clonePlainData({ value: source });
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy as object, '__proto__')).toBe(true);
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });

  it.each([new Date(), new Map(), new Set(), new Blob(), () => 'not-plain'])('rejects unsupported values instead of silently losing state', value => {
    expect(() => clonePlainData({ value: { nested: value } })).toThrow(TypeError);
  });

  it('rejects accessors without executing them', () => {
    const value = {
      get secret() {
        throw new Error('Getter executed');
      },
    };
    expect(() => clonePlainData({ value })).toThrow('Cannot clone an accessor as plain data');
  });
});
