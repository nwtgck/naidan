import { describe, expect, it } from 'vitest';
import { generationContinuationOwnerSchema } from './generation-continuation-owner';

describe('internal generation continuation owner RPC value', () => {
  it('accepts only an opaque operation UUID or omitted legacy ownership', () => {
    const owner = 'f28f6802-947c-4b9d-bc99-223d8d469f4b';
    expect(generationContinuationOwnerSchema.parse(owner)).toBe(owner);
    expect(generationContinuationOwnerSchema.parse(undefined)).toBeUndefined();
  });
  it.each([null, 1, true, [], {}, '', 'user-supplied-chat-id', 'x'.repeat(1024)])('rejects malformed owner %#', owner => {
    expect(generationContinuationOwnerSchema.safeParse(owner).success).toBe(false);
  });
});
