import { describe, expect, it } from 'vitest';
import { modelIdSchema, modelSchema } from './types';

describe('public browser model references', () => {
  it.each([
    'hf.co/owner/Chat-GGUF:Q4',
    'host/MyModels1/owner/Chat-GGUF:Q4',
    'user/MyModel',
    'user/My:Model',
    'user/literal%2F',
    'temp/MyModel',
    'temp/MyModel:Q4',
    'temp/MyModel:Q8',
    'temp/MyModels1/owner/Chat-GGUF:Q4',
    'hf.co/owner/Chat-GGUF:imatrix/Q4',
    'hf.co/owner/Chat-GGUF:Q%2FA',
  ])('preserves the selection value %s', modelId => {
    expect(modelIdSchema.parse(modelId)).toBe(modelId);
  });

  it('admits a readable host reference beyond the retired exact-reference bound', () => {
    const mountName = encodeURIComponent('あ'.repeat(80));
    const modelId = `host/${mountName}/${'a'.repeat(150)}/${'b'.repeat(150)}:Q4`;
    expect(modelId.length).toBeGreaterThan(1024);
    expect(modelSchema.parse({ modelId, size: 24, importedAt: 1 }).modelId).toBe(modelId);
  });

  it('does not accept a second model name or an exact-id field in public inventory', () => {
    expect(modelSchema.safeParse({ modelId: 'user/MyModel', id: 'user/MyModel', name: 'MyModel', size: 24, importedAt: 1 }).success).toBe(false);
  });

  it.each(['', 'unknown', 'x'.repeat(8192), 'user/../model', 'temp/MyModel:../Q4', 'hf.co/owner/Chat-GGUF:Q4//model', 'host/MyModels1/owner/Chat-GGUF'])('preserves a string without deciding whether it resolves: %s', modelId => {
    expect(modelIdSchema.parse(modelId)).toBe(modelId);
  });

  it.each([undefined, 42, true, null, {}, []])('rejects a missing or non-string selection: %j', modelId => {
    expect(modelIdSchema.safeParse(modelId).success).toBe(false);
  });
});
