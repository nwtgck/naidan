import { installSecretEqualityTester } from '@/utils/secret.test-support';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { inspect } from 'node:util';
import { reactive, readonly, ref, isProxy } from 'vue';
import { Secret } from './secret';

installSecretEqualityTester();

describe('Secret', () => {
  it.each(['', 'sensitive-value', 0, -0, NaN, 42, false, true, null, undefined, 12n, Symbol('value')])('retains %s only through explicit access', value => {
    const secret = Secret.from({ value });
    expect(Object.is(secret.reveal(), value)).toBe(true);
    expect(Object.isFrozen(secret)).toBe(true);
    expect(Reflect.ownKeys(secret)).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(secret)).toEqual({});
    expect({ ...secret }).toEqual({});
    expect(String(secret)).toBe('[masked]');
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Exercise accidental implicit coercion.
    expect(`${secret}`).toBe('[masked]');
    expect(secret + '').toBe('[masked]');
    expect(JSON.stringify({ nested: [secret] })).toBe('{"nested":["[masked]"]}');
  });

  it('never traverses or inspects the payload while formatting', () => {
    const payload = {
      token: 'private-token',
      toJSON() {
        throw new Error('Payload must not be inspected');
      },
    };
    const secret = Secret.from({ value: payload });
    expect(JSON.stringify(secret)).toBe('"[masked]"');
    expect(inspect(secret, { showHidden: true, depth: null })).not.toContain('private-token');
    expect(secret.reveal()).toBe(payload);
  });

  it('masks even cyclic and non-JSON payloads', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(JSON.stringify(Secret.from({ value }))).toBe('"[masked]"');
    expect(JSON.stringify(Secret.from({ value: () => 'secret' }))).toBe('"[masked]"');
  });

  it('does not intern values', () => {
    const left = Secret.from({ value: 'same' });
    const right = Secret.from({ value: 'same' });
    expect(left).not.toBe(right);
    expect(Secret.equals(left, right)).toBe(true);
    expect(Secret.equals(left, Secret.from({ value: 'different' }))).toBe(false);
  });

  it('uses Object.is equality including NaN and signed zero', () => {
    expect(Secret.equals(Secret.from({ value: NaN }), Secret.from({ value: NaN }))).toBe(true);
    expect(Secret.equals(Secret.from({ value: 0 }), Secret.from({ value: -0 }))).toBe(false);
    expect(Secret.equals(Secret.from({ value: undefined }), Secret.from({ value: undefined }))).toBe(true);
  });

  it('compares objects by identity and does not mutate their ownership', () => {
    const value = { token: 'original' };
    const left = Secret.from({ value });
    expect(Secret.equals(left, Secret.from({ value }))).toBe(true);
    expect(Secret.equals(left, Secret.from({ value: { token: 'original' } }))).toBe(false);
    value.token = 'updated';
    expect(left.reveal().token).toBe('updated');
    expect(Object.isFrozen(value)).toBe(false);
  });

  it('preserves the wrapper through Vue reactive and readonly state', () => {
    const secret = Secret.from({ value: 'vue-token' });
    const state = reactive({ secret });
    expect(state.secret).toBe(secret);
    expect(readonly(state).secret).toBe(secret);
    expect(ref(secret).value).toBe(secret);
    expect(isProxy(state.secret)).toBe(false);
    expect(state.secret.reveal()).toBe('vue-token');
    expectTypeOf(state.secret).toMatchTypeOf<Secret<string>>();
    expectTypeOf(readonly(state).secret).toMatchTypeOf<Secret<string>>();
    expectTypeOf(ref(secret).value).toMatchTypeOf<Secret<string>>();
  });

  it('keeps generic object payloads opaque to Vue type unwrapping', () => {
    const payload = { list: [1, 2], value: ref('nested-ref') };
    const secret = Secret.from({ value: payload });
    const state = readonly(reactive({ secret }));
    expectTypeOf(state.secret).toMatchTypeOf<Secret<typeof payload>>();
    expectTypeOf(ref(secret).value).toMatchTypeOf<Secret<typeof payload>>();
    expect(state.secret.reveal()).toBe(payload);
    expect(state.secret.reveal().value).toBe(payload.value);
  });

  it('fails closed for forged receivers instead of returning undefined', () => {
    expect(() => Secret.prototype.reveal.call({})).toThrow('Invalid Secret receiver');
    const forged = Object.create(Secret.prototype) as Secret<string>;
    expect(() => forged.reveal()).toThrow('Invalid Secret receiver');
    expect(JSON.stringify(forged)).toBe('"[masked]"');
  });

  it('does not send the payload through structured clone', () => {
    const clone = structuredClone(Secret.from({ value: 'not-transferable' }));
    expect(clone).toEqual({});
    expect(clone).not.toBeInstanceOf(Secret);
  });

  it('retains the generic value type without being assignable to a plain value', () => {
    const secret = Secret.from({ value: { token: 'value', count: 1 } });
    expectTypeOf(secret.reveal()).toEqualTypeOf<{ token: string, count: number }>();
    expectTypeOf<Secret<string>>().not.toEqualTypeOf<string>();
    expectTypeOf<Secret<string>>().not.toEqualTypeOf<Secret<number>>();
  });

  it('lets opted-in deep assertions distinguish values without displaying them', () => {
    const left = { token: Secret.from({ value: 'one' }) };
    expect(left).toEqual({ token: Secret.from({ value: 'one' }) });
    expect(left).not.toEqual({ token: Secret.from({ value: 'two' }) });
    expect(left).not.toEqual({ token: 'one' });
  });
});
