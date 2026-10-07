import { expect, it } from 'vitest';
import { z } from 'zod';
import { contract, procedure } from './contract';
import { rpc } from './schema';
import { describeMethods, methodDescriptorSchema } from './description';

it('derives structural input, stream result and notifications from the callable contract', () => {
  const api = contract({
    name: 'describe',
    methods: {
    generate: procedure({
      input: z.object({ prompt: z.string().max(100), seed: z.number().int().optional() }),
      result: z.object({ image: rpc.byteStream(), events: rpc.stream({ item: z.object({ type: z.literal('complete'), bytes: z.number().int() }) }) }),
      notifications: { progress: z.object({ completed: z.number().int() }) },
    }),
  },
  });
  const methods = describeMethods({ contract: api, names: ['generate'] });
  expect(methods[0]).toMatchObject({
    name: 'generate',
    input: { kind: 'data', schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', maxLength: 100 }, seed: { type: 'integer' } } } },
    result: { kind: 'object', required: ['image', 'events'], properties: { image: { kind: 'byte-stream' }, events: { kind: 'stream', item: { type: 'object', properties: { type: { const: 'complete' } } } } } },
    notifications: { progress: { type: 'object', required: ['completed'] } },
  });
  expect(methodDescriptorSchema.safeParse(methods[0]).success).toBe(true);
});

it('describes optional and array capabilities without claiming they are plain JSON', () => {
  const api = contract({
    name: 'describe',
    methods: {
    use: procedure({ input: z.object({ files: z.array(rpc.byteStream()), answer: rpc.callback({ input: z.string(), result: z.boolean() }).optional() }), result: z.void(), notifications: {} }),
  },
  });
  expect(describeMethods({ contract: api, names: ['use'] })[0]).toMatchObject({
    input: { kind: 'object', required: ['files'], properties: { files: { kind: 'array', item: { kind: 'byte-stream' } }, answer: { kind: 'optional', value: { kind: 'callback', input: { type: 'string' }, result: { type: 'boolean' } } } } },
    result: { kind: 'undefined' },
  });
});

it('does not turn malformed or duplicated method names into advertised authority', () => {
  const api = contract({ name: 'describe', methods: { read: procedure({ input: z.object({}), result: z.string(), notifications: {} }) } });
  expect(() => describeMethods({ contract: api, names: ['read', 'read'] })).toThrow();
  const method = describeMethods({ contract: api, names: ['read'] })[0]!;
  expect(methodDescriptorSchema.safeParse({ ...method, name: '__proto__' }).success).toBe(false);
  expect(methodDescriptorSchema.safeParse({ ...method, result: { kind: 'stream' } }).success).toBe(false);
});

export const TEST_ONLY = {
};
