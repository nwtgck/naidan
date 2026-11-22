// @vitest-environment node
import { expect, it } from 'vitest';
import { sparseFile } from '@/features/stable-diffusion-cpp-browser/test-utils/weights.test-support';
import { ggufArrayFixture, ggufScalarFixture, inspectionGgufFixture } from './gguf.test-support';
import { inspectModelFileDetails, inspectWeightFile, prepareGgufMetadataRewrite, readModelMetadataValue } from './metadata';

const stringType = 8;
const alignment = 64;

it('inspects a sparse large GGUF and reads deferred metadata from bounded ranges', async () => {
  const template = 'テンプレート'.repeat(1000);
  const tokens = Array.from({ length: 1000 }, (_, index) => `token ${index}`);
  const { file, reads } = inspectionGgufFixture({
    metadata: [
      ggufScalarFixture({ key: 'general.alignment', type: 4, value: alignment }),
      ggufScalarFixture({ key: 'general.architecture', type: stringType, value: 'unknown-architecture' }),
      ggufScalarFixture({ key: 'tokenizer.chat_template', type: stringType, value: template }),
      ggufScalarFixture({ key: 'example.large-integer', type: 10, value: 9_007_199_254_740_993n }),
      ggufArrayFixture({ key: 'tokenizer.ggml.tokens', elementType: stringType, values: tokens, declaredLength: undefined }),
      ggufArrayFixture({ key: 'example.numbers', elementType: 5, values: [5, 8, 13, 21], declaredLength: undefined }),
    ],
    tensors: [
      { name: 'blk.0.weight', shape: [32, 2], dtype: 8, offset: 0 },
      { name: 'blk.1.future', shape: [128], dtype: 999, offset: 128 },
    ],
    dataBytes: 17_600_000_000,
    alignment,
  });
  const inspection = await inspectModelFileDetails({ file, signal: undefined });
  expect(inspection.status).toBe('weights');
  if (inspection.status !== 'weights') {
    throw new Error(inspection.reason);
  }
  const { value } = inspection;
  expect(value).toMatchObject({ format: 'gguf', version: 3, alignment });
  expect(value.dataOffset % alignment).toBe(0);
  expect(value.tensors).toMatchObject([
    { name: 'blk.0.weight', shape: [32, 2], dtype: 'Q8_0', dtypeCode: 8, offset: value.dataOffset, byteLength: 68 },
    { name: 'blk.1.future', dtype: '999', dtypeCode: 999, offset: value.dataOffset + 128 },
  ]);
  expect(value.metadata.find(({ key }) => key === 'example.large-integer')?.value).toBe('9007199254740993');
  const entry = value.metadata.find(({ key }) => key === 'tokenizer.chat_template')!;
  expect(entry.value).toBeUndefined();
  expect(await readModelMetadataValue({ file, entry, start: 0, limit: 1, signal: undefined })).toEqual({ values: [template], next: undefined });
  const tokenEntry = value.metadata.find(({ key }) => key === 'tokenizer.ggml.tokens')!;
  expect(tokenEntry).toMatchObject({ type: 'array', count: tokens.length, elementType: 'string' });
  expect(await readModelMetadataValue({ file, entry: tokenEntry, start: 772, limit: 2, signal: undefined })).toEqual({ values: tokens.slice(772, 774), next: 774 });
  const numbers = value.metadata.find(({ key }) => key === 'example.numbers')!;
  expect(await readModelMetadataValue({ file, entry: numbers, start: 2, limit: 10, signal: undefined })).toEqual({ values: [13, 21], next: undefined });
  expect(reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThan(128 * 1024);
});

it('reads a Safetensors header without touching embedded quantization data', async () => {
  const text = new TextEncoder().encode(JSON.stringify({
    __metadata__: { title: 'Model' },
    weight: { dtype: 'F32', shape: [2], data_offsets: [0, 8] },
    'weight.comfy_quant': { dtype: 'U8', shape: [4], data_offsets: [8, 12] },
  }));
  const header = new Uint8Array(8 + text.length);
  new DataView(header.buffer).setBigUint64(0, BigInt(text.length), true);
  header.set(text, 8);
  const { file, reads } = sparseFile({ name: 'sample.safetensors', header, size: header.length + 12 });
  expect(await inspectModelFileDetails({ file, signal: undefined })).toMatchObject({
    status: 'weights',
    value: {
      format: 'safetensors',
      dataOffset: header.length,
      metadata: [{ key: 'title', value: 'Model' }],
      tensors: [
        { name: 'weight', dtype: 'F32', shape: [2], offset: header.length, byteLength: 8 },
        { name: 'weight.comfy_quant', offset: header.length + 8, byteLength: 4 },
      ],
    },
  });
  expect(reads.every(({ offset, length }) => offset + length <= header.length)).toBe(true);
  // Inference inspection keeps its previous quantization-content validation.
  expect((await inspectWeightFile({ file, signal: undefined })).status).toBe('invalid');
});

it.each([
  { oldTemplate: 'short', newTemplate: '新規テンプレート'.repeat(20), shift: 'forward' },
  { oldTemplate: '既存テンプレート'.repeat(30), newTemplate: 'short', shift: 'backward' },
])('rewrites editable strings with tensor data moving $shift', async ({ oldTemplate, newTemplate, shift }) => {
  const payloadSize = 32;
  const { file: original } = inspectionGgufFixture({
    metadata: [
      ggufScalarFixture({ key: 'general.alignment', type: 4, value: alignment }),
      ggufScalarFixture({ key: 'tokenizer.chat_template', type: stringType, value: oldTemplate }),
      ggufArrayFixture({ key: 'example.untouched', elementType: 11, values: [-9_007_199_254_740_993n, 7n], declaredLength: undefined }),
    ],
    tensors: [{ name: 'blk.0.weight', shape: [8], dtype: 0, offset: 0 }],
    dataBytes: payloadSize,
    alignment,
  });
  const originalBytes = new Uint8Array(await original.slice(0, original.size).arrayBuffer());
  const weights = Uint8Array.from({ length: payloadSize }, (_, index) => index + 1);
  originalBytes.set(weights, original.size - payloadSize);
  const { file } = sparseFile({ name: 'original.gguf', header: originalBytes, size: originalBytes.length });
  const rewrite = await prepareGgufMetadataRewrite({
    file,
    changes: { 'tokenizer.chat_template': newTemplate, 'general.author': '著者' },
    signal: undefined,
  });
  expect(rewrite.bodyOffset).toBe(original.size - payloadSize);
  expect(rewrite.header.length % alignment).toBe(0);
  expect(Math.sign(rewrite.header.length - rewrite.bodyOffset)).toBe(shift === 'forward' ? 1 : -1);

  const output = new Blob([rewrite.header, file.slice(rewrite.bodyOffset)]);
  const result = await inspectModelFileDetails({ file: output, signal: undefined });
  expect(result.status).toBe('weights');
  if (result.status !== 'weights') {
    throw new Error(result.reason);
  }
  const { value } = result;
  expect(value.dataOffset).toBe(rewrite.header.length);
  expect(value.tensors).toMatchObject([{ name: 'blk.0.weight', shape: [8], dtype: 'F32', offset: rewrite.header.length, byteLength: payloadSize }]);
  const templateEntry = value.metadata.find(({ key }) => key === 'tokenizer.chat_template')!;
  expect(await readModelMetadataValue({ file: output, entry: templateEntry, start: 0, limit: 1, signal: undefined })).toMatchObject({ values: [newTemplate] });
  const authorEntry = value.metadata.find(({ key }) => key === 'general.author')!;
  expect(await readModelMetadataValue({ file: output, entry: authorEntry, start: 0, limit: 1, signal: undefined })).toMatchObject({ values: ['著者'] });
  const untouchedEntry = value.metadata.find(({ key }) => key === 'example.untouched')!;
  expect(await readModelMetadataValue({ file: output, entry: untouchedEntry, start: 0, limit: 2, signal: undefined })).toMatchObject({ values: ['-9007199254740993', 7] });
  expect(new Uint8Array(await output.slice(value.dataOffset).arrayBuffer())).toEqual(weights);
});

it('rejects editing structural fields and truncated tensor storage', async () => {
  const { file } = inspectionGgufFixture({
    metadata: [ggufScalarFixture({ key: 'general.architecture', type: stringType, value: 'llama' })],
    tensors: [{ name: 'weight', shape: [1], dtype: 0, offset: 0 }],
    dataBytes: 4,
    alignment: 32,
  });
  await expect(prepareGgufMetadataRewrite({ file, changes: { 'general.architecture': 'qwen3' }, signal: undefined })).rejects.toThrow('Unsupported GGUF metadata edit');
  const truncated = file.slice(0, file.size - 1);
  expect(await inspectModelFileDetails({ file: truncated, signal: undefined })).toMatchObject({ status: 'invalid', reason: expect.stringContaining('bounds') });
});

export const TEST_ONLY = {
};
