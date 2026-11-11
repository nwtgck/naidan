// @vitest-environment node
import { expect, it } from 'vitest';
import { inspectWeightFile } from './metadata';
import { ggufArrayFixture, ggufScalarFixture, inspectionGgufFixture, minimaxH3OriginalShapeFixture } from './gguf.test-support';
import { scanImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';

const key = 'comfy.gguf.orig_shape.weight';
const weight = { name: 'weight', shape: [12], dtype: 0, offset: 0 };

it.each([0, 1, 2, 3, 4, 5, 10, 11])('restores PyTorch-order original shape from GGUF integer array type %s', async elementType => {
  const { file } = inspectionGgufFixture({ metadata: [ggufArrayFixture({ key, elementType, values: [3, 4], declaredLength: undefined })], tensors: [weight], dataBytes: 48, alignment: 32 });
  const result = await inspectWeightFile({ file, signal: undefined });
  expect(result).toMatchObject({ status: 'weights', value: { tensors: [{ name: 'weight', shape: [3, 4], dtype: '0' }], requiresGgufOriginalShapes: true } });
  if (result.status !== 'weights') {
    throw new Error(result.reason);
  }
  expect(result.value.metadata.size).toBe(0);
});

it.each([
  { name: 'scalar instead of array', metadata: [ggufScalarFixture({ key, type: 5, value: 12 })] },
  { name: 'float array', metadata: [ggufArrayFixture({ key, elementType: 6, values: [3, 4], declaredLength: undefined })] },
  { name: 'double array', metadata: [ggufArrayFixture({ key, elementType: 12, values: [3, 4], declaredLength: undefined })] },
  { name: 'boolean array', metadata: [ggufArrayFixture({ key, elementType: 7, values: [true, true], declaredLength: undefined })] },
  { name: 'string array', metadata: [ggufArrayFixture({ key, elementType: 8, values: ['3', '4'], declaredLength: undefined })] },
  { name: 'unknown array type', metadata: [ggufArrayFixture({ key, elementType: 99, values: [], declaredLength: 2n })] },
  { name: 'zero rank', metadata: [ggufArrayFixture({ key, elementType: 5, values: [], declaredLength: undefined })] },
  { name: 'rank above native axes', metadata: [ggufArrayFixture({ key, elementType: 5, values: [1, 1, 1, 3, 4], declaredLength: undefined })] },
  { name: 'extreme declared rank', metadata: [ggufArrayFixture({ key, elementType: 5, values: [], declaredLength: 1000000000000n })] },
  { name: 'zero dimension', metadata: [ggufArrayFixture({ key, elementType: 5, values: [0, 4], declaredLength: undefined })] },
  { name: 'negative dimension', metadata: [ggufArrayFixture({ key, elementType: 5, values: [-3, 4], declaredLength: undefined })] },
  { name: 'inexact 64-bit dimension', metadata: [ggufArrayFixture({ key, elementType: 10, values: [9007199254740992n], declaredLength: undefined })] },
  { name: 'overflowing product', metadata: [ggufArrayFixture({ key, elementType: 10, values: [2147483648n, 4294967296n], declaredLength: undefined })] },
  { name: 'different element count', metadata: [ggufArrayFixture({ key, elementType: 5, values: [3, 5], declaredLength: undefined })] },
  { name: 'empty tensor name', metadata: [ggufArrayFixture({ key: 'comfy.gguf.orig_shape.', elementType: 5, values: [3, 4], declaredLength: undefined })] },
  { name: 'duplicate metadata key', metadata: [ggufArrayFixture({ key, elementType: 5, values: [3, 4], declaredLength: undefined }), ggufArrayFixture({ key, elementType: 5, values: [3, 4], declaredLength: undefined })] },
])('rejects $name without interpreting a different format', async ({ metadata }) => {
  const { file } = inspectionGgufFixture({ metadata, tensors: [weight], dataBytes: 48, alignment: 32 });
  expect((await inspectWeightFile({ file, signal: undefined })).status).toBe('invalid');
});

it('requires an existing multidimensional descriptor to agree exactly with PyTorch-order metadata', async () => {
  const metadata = [ggufArrayFixture({ key, elementType: 5, values: [3, 4], declaredLength: undefined })];
  const matching = inspectionGgufFixture({ metadata, tensors: [{ ...weight, shape: [4, 3] }], dataBytes: 48, alignment: 32 });
  expect(await inspectWeightFile({ file: matching.file, signal: undefined })).toMatchObject({ status: 'weights', value: { tensors: [{ shape: [3, 4] }], requiresGgufOriginalShapes: false } });
  const contradictory = inspectionGgufFixture({ metadata, tensors: [{ ...weight, shape: [3, 4] }], dataBytes: 48, alignment: 32 });
  expect(await inspectWeightFile({ file: contradictory.file, signal: undefined })).toMatchObject({ status: 'invalid', reason: expect.stringContaining('contradicts') });
});

it('validates row block size and exact Q4_K storage bytes after restoring a flat descriptor', async () => {
  const descriptor = { ...weight, shape: [512], dtype: 12 };
  const metadata = [ggufArrayFixture({ key, elementType: 5, values: [2, 256], declaredLength: undefined })];
  const matching = inspectionGgufFixture({ metadata, tensors: [descriptor], dataBytes: 288, alignment: 32 });
  expect(await inspectWeightFile({ file: matching.file, signal: undefined })).toMatchObject({ status: 'weights', value: { tensors: [{ shape: [2, 256], dtype: '12' }], requiresGgufOriginalShapes: true } });
  const short = inspectionGgufFixture({ metadata, tensors: [descriptor], dataBytes: 287, alignment: 32 });
  expect((await inspectWeightFile({ file: short.file, signal: undefined })).status).toBe('invalid');
  const wrongRow = inspectionGgufFixture({ metadata: [ggufArrayFixture({ key, elementType: 5, values: [4, 128], declaredLength: undefined })], tensors: [descriptor], dataBytes: 288, alignment: 32 });
  expect(await inspectWeightFile({ file: wrongRow.file, signal: undefined })).toMatchObject({ status: 'invalid', reason: expect.stringContaining('row block') });
  const wrongDescriptor = inspectionGgufFixture({ metadata: [ggufArrayFixture({ key, elementType: 5, values: [2, 128], declaredLength: undefined })], tensors: [{ ...descriptor, shape: [128, 2] }], dataBytes: 144, alignment: 32 });
  expect((await inspectWeightFile({ file: wrongDescriptor.file, signal: undefined })).status).toBe('invalid');
});

it.each([
  { name: 'unsupported dtype', tensor: { ...weight, dtype: 999 }, metadata: [] },
  { name: 'misaligned tensor offset', tensor: { ...weight, offset: 1 }, metadata: [] },
  { name: 'invalid alignment', tensor: weight, metadata: [ggufScalarFixture({ key: 'general.alignment', type: 4, value: 0 })] },
])('rejects original-shape storage with $name', async ({ tensor, metadata }) => {
  const { file } = inspectionGgufFixture({ metadata: [...metadata, ggufArrayFixture({ key, elementType: 5, values: [3, 4], declaredLength: undefined })], tensors: [tensor], dataBytes: 128, alignment: 32 });
  expect((await inspectWeightFile({ file, signal: undefined })).status).toBe('invalid');
});

it('uses explicit alignment without retaining unrelated arrays in the public scalar metadata map', async () => {
  const { file } = inspectionGgufFixture({ metadata: [ggufScalarFixture({ key: 'general.alignment', type: 4, value: 64 }), ggufArrayFixture({ key: 'tokenizer.scores', elementType: 6, values: [1.5, 2.5], declaredLength: undefined }), ggufArrayFixture({ key, elementType: 5, values: [3, 4], declaredLength: undefined })], tensors: [weight], dataBytes: 48, alignment: 64 });
  const result = await inspectWeightFile({ file, signal: undefined });
  expect(result).toMatchObject({ status: 'weights', value: { requiresGgufOriginalShapes: true } });
  if (result.status !== 'weights') {
    throw new Error(result.reason);
  }
  expect(result.value.metadata.size).toBe(0);
});

it('ignores valid original shapes for other shards but still rejects their invalid dimensions', async () => {
  const orphan = 'comfy.gguf.orig_shape.other_shard.weight';
  const matching = inspectionGgufFixture({ metadata: [ggufArrayFixture({ key: orphan, elementType: 5, values: [3, 4], declaredLength: undefined })], tensors: [weight], dataBytes: 48, alignment: 32 });
  expect(await inspectWeightFile({ file: matching.file, signal: undefined })).toMatchObject({ status: 'weights', value: { tensors: [{ shape: [12] }], requiresGgufOriginalShapes: false } });
  const malformed = inspectionGgufFixture({ metadata: [ggufArrayFixture({ key: orphan, elementType: 5, values: [0, 4], declaredLength: undefined })], tensors: [weight], dataBytes: 48, alignment: 32 });
  expect((await inspectWeightFile({ file: malformed.file, signal: undefined })).status).toBe('invalid');
});

it('keeps ordinary GGUF tensor order and unrelated numeric arrays unchanged', async () => {
  const { file } = inspectionGgufFixture({ metadata: [ggufScalarFixture({ key: 'general.architecture', type: 8, value: 'qwen3' }), ggufArrayFixture({ key: 'tokenizer.scores', elementType: 12, values: [0.5, 1.5], declaredLength: undefined })], tensors: [{ ...weight, shape: [4, 3] }], dataBytes: 48, alignment: 32 });
  const result = await inspectWeightFile({ file, signal: undefined });
  expect(result).toMatchObject({ status: 'weights', value: { tensors: [{ shape: [3, 4] }], requiresGgufOriginalShapes: false } });
  if (result.status !== 'weights') {
    throw new Error(result.reason);
  }
  expect([...result.value.metadata]).toEqual([['general.architecture', 'qwen3']]);
});

it('keeps Krea projector singleton recovery compatible with the existing structural family check', async () => {
  const { file } = inspectionGgufFixture({ metadata: [ggufArrayFixture({ key: 'comfy.gguf.orig_shape.txtfusion.projector.weight', elementType: 5, values: [1, 12], declaredLength: undefined })], tensors: [{ name: 'txtfusion.projector.weight', shape: [12], dtype: 0, offset: 0 }, { name: 'first.weight', shape: [64, 6144], dtype: 0, offset: 64 }], dataBytes: 64 + 6144 * 64 * 4, alignment: 32 });
  const result = await inspectWeightFile({ file, signal: undefined });
  expect(result).toMatchObject({ status: 'weights', value: { tensors: [{ shape: [1, 12] }, { shape: [6144, 64] }], requiresGgufOriginalShapes: false } });
  const inventory = await scanImageRepositories({ repositories: [{ repositoryKey: 'user/renamed', repositoryLabel: 'renamed', files: [{ relativePath: file.name, file }] }], signal: undefined });
  expect(inventory.candidates[0]).toMatchObject({ family: 'krea2', issue: undefined });
});

it('restores the H3 image projections observed in the GGUF without treating its wan label as the model family', async () => {
  const { file, reads } = minimaxH3OriginalShapeFixture();
  const inventory = await scanImageRepositories({ repositories: [{ repositoryKey: 'user/renamed', repositoryLabel: 'renamed', files: [{ relativePath: file.name, file }] }], signal: undefined });
  expect(inventory.issues).toEqual([]);
  expect(inventory.candidates[0]).toMatchObject({ family: 'minimax-h3-image', roles: ['diffusion'], variant: 'unknown', issue: undefined });
  expect(reads.reduce((total, read) => total + read.length, 0)).toBeLessThan(128 * 1024);
});

export const TEST_ONLY = {
};
