import { describe, expect, it } from 'vitest';
import { parametersSchema, requestSchema, responseSchema } from './types';
import { ggufFile, parametersFixture, requestFixture } from './test-fixtures';
describe('image experiment boundary', () => {
  it('accepts an unsharded GGUF without reading its bytes', () => {
    expect(requestSchema.parse(requestFixture()).models[0]?.file.size).toBe(24);
  });
  it.each([{ width: 4096 }, { width: 255 }, { steps: 0 }, { guidance: Infinity }, { seed: '-2' }, { seed: '9223372036854775808' }, { seed: 42 }, { seed: '' }, { seed: '-' }, { seed: 'abc' }, { seed: '1e3' }, { prompt: ' ' }, { prompt: 'a\0b' }])('rejects unsupported parameters %s', change => {
    expect(parametersSchema.safeParse({ ...parametersFixture(), ...change }).success).toBe(false);
  });
  it('preserves signed 64-bit seeds and allows caller-selected sampling and larger output', () => {
    const result = parametersSchema.parse({ ...parametersFixture(), width: 1024, seed: '9223372036854775807', sampler: 'heun', scheduler: 'karras' });
    expect(result.seed).toBe('9223372036854775807'); expect(result.width).toBe(1024);
    expect(parametersSchema.parse({ ...result, seed: '-1' }).seed).toBe('-1');
  });
  it('rejects two primary models, duplicate slots, empty files, non-GGUF, shards and no primary', () => {
    const base = requestFixture(); const file = ggufFile();
    for (const models of [[{ slot: 'model', file }, { slot: 'diffusion', file }], [{ slot: 'model', file }, { slot: 'model', file }], [{ slot: 'vae', file }], [{ slot: 'model', file: new File([], 'empty.gguf') }], [{ slot: 'model', file: new File([new Uint8Array(24)], 'x.safetensors') }], [{ slot: 'model', file: new File([new Uint8Array(24)], 'x-00001-of-00002.gguf') }]]) {
      expect(requestSchema.safeParse({ ...base, models }).success).toBe(false);
    }
  });
  it('does not impose a 4 GiB file-size ceiling on Wasm32', () => {
    const base = requestFixture(); Object.defineProperty(base.models[0]!.file, 'size', { value: 18 * 1024 ** 3 });
    expect(requestSchema.parse(base).models[0]!.file.size).toBe(18 * 1024 ** 3);
    expect(requestSchema.safeParse({ ...base, gpuBudgetMiB: 4096 }).success).toBe(false);
  });
  it('rejects remote code, mixed sources, and output disguised as an image', () => {
    const base = requestFixture();
    expect(requestSchema.safeParse({ ...base, artifact: { ...base.artifact, modulePath: 'https://example.net/core.mjs' } }).success).toBe(false);
    expect(requestSchema.safeParse({ ...base, artifact: { ...base.artifact, helpersPath: base.artifact.helpersPath.replace('a'.repeat(40), 'b'.repeat(40)) } }).success).toBe(false);
    expect(responseSchema.safeParse({ png: new Blob(['x'], { type: 'text/html' }), width: 256, height: 256, modelVersion: 'fixture' }).success).toBe(false);
  });
});
