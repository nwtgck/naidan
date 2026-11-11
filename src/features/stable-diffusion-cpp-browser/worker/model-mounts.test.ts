// @vitest-environment node
import { expect, it } from 'vitest';
import { validateModelMounts } from './model-mounts';
import { createModelFileSource, createModelFileReadCache, MODEL_FILE_CACHE_BYTES, MODEL_FILE_PAGE_BYTES } from './gguf-file';
import { fixtureReader, ggufFixture, safetensorsFixture, sparseFile, tensor } from '@/features/stable-diffusion-cpp-browser/test-utils/weights.test-support';
import { minimaxH3ImageTensors, minimaxH3PrunedTextTensors } from '@/features/stable-diffusion-cpp-browser/test-utils/minimax-h3-weights.test-support';
import { ggufArrayFixture, inspectionGgufFixture, minimaxH3OriginalShapeFixture } from '@/logic/model-file-inspection/gguf.test-support';

function jsonFile({ text, name }: { text: string, name: string }): File {
  const header = new TextEncoder().encode(text);
  return sparseFile({ name, header, size: header.length }).file;
}

it('keeps a single 20-GiB GGUF with Unicode/spaces intact on the old core', async () => {
  const fixture = ggufFixture({ name: '重み 20GB.gguf', tensors: [tensor({ name: 'weight', shape: [1] })], metadata: {}, extraBytes: 20 * 1024 ** 3 });
  const input = { file: fixture.file, relativePath: 'weights/重み 20GB.gguf' };
  const plan = await validateModelMounts({ input, reader: fixtureReader, capabilities: 0 });
  expect(plan.relativePath).toBe(input.relativePath);
  expect(plan.files).toEqual([{ relativePath: input.relativePath, file: fixture.file }]);
  const source = createModelFileSource({ file: fixture.file, reader: fixtureReader, cache: createModelFileReadCache({ pageBytes: MODEL_FILE_PAGE_BYTES, capacityBytes: MODEL_FILE_CACHE_BYTES }) });
  expect(source.size).toBe(fixture.file.size);
  const output = new Uint8Array(9 * 1024 * 1024);
  const count = source.read(output, 19 * 1024 ** 3);
  expect(count).toBe(8 * 1024 * 1024);
  expect(source.read(output.subarray(count), 19 * 1024 ** 3 + count)).toBe(output.length - count);
  expect(Math.max(...fixture.reads.map(read => read.length))).toBeLessThanOrEqual(8 * 1024 * 1024);
});

it('allows ordinary safetensors on the old core, but requests an update for a huge file without suggesting conversion', async () => {
  const small = safetensorsFixture({ name: 'ae.safetensors', tensors: [tensor({ name: 'weight', shape: [1] })] }).file;
  await expect(validateModelMounts({ input: { file: small }, reader: fixtureReader, capabilities: 0 })).resolves.toMatchObject({ relativePath: small.name });
  const large = safetensorsFixture({ name: 'huge.safetensors', tensors: [{ name: 'weight', dtype: 'U8', shape: [20 * 1024 ** 3] }] }).file;
  await expect(validateModelMounts({ input: { file: large }, reader: fixtureReader, capabilities: 0 })).rejects.toThrow('do not split');
  await expect(validateModelMounts({ input: { file: large }, reader: fixtureReader, capabilities: 1 })).resolves.toMatchObject({ relativePath: large.name });
});

it('mounts a complete pre-split GGUF group only when the core declares support', async () => {
  const files = [0, 1].map(i => ({ relativePath: `weights/model-0000${i + 1}-of-00002.gguf`, file: ggufFixture({ name: `model-0000${i + 1}-of-00002.gguf`, tensors: [tensor({ name: `weight${i}`, shape: [1] })], metadata: { 'split.no': i, 'split.count': 2, 'split.tensors.count': 2 }, extraBytes: 0 }).file }));
  const input = { ...files[0]!, companions: [files[1]!] };
  await expect(validateModelMounts({ input, reader: fixtureReader, capabilities: 0 })).rejects.toThrow('shard-group update');
  expect((await validateModelMounts({ input, reader: fixtureReader, capabilities: 3 })).files).toEqual(files);
  await expect(validateModelMounts({ input: { ...input, companions: [] }, reader: fixtureReader, capabilities: 3 })).rejects.toThrow('Incomplete');
});

it('resolves only index-referenced siblings and leaves unselected files unmounted', async () => {
  const weight = safetensorsFixture({ name: 'part.safetensors', tensors: [tensor({ name: 'x', shape: [1] })] }).file;
  const unused = safetensorsFixture({ name: 'unused.safetensors', tensors: [tensor({ name: 'y', shape: [1] })] }).file;
  const file = jsonFile({ name: 'model.safetensors.index.json', text: '{"weight_map":{"x":"part.safetensors"}}' });
  const input = { file, relativePath: 'encoder/model.safetensors.index.json', companions: [{ relativePath: 'encoder/part.safetensors', file: weight }, { relativePath: 'unused.safetensors', file: unused }] };
  const plan = await validateModelMounts({ input, reader: fixtureReader, capabilities: 0 });
  expect(plan.files.map(entry => entry.relativePath)).toEqual(['encoder/model.safetensors.index.json', 'encoder/part.safetensors']);
});

it.each(['../part.safetensors', '/part.safetensors', 'https://remote/part.safetensors', 'sub/../part.safetensors'])('rejects model-controlled path %s', async reference => {
  const file = jsonFile({ name: 'model.safetensors.index.json', text: JSON.stringify({ weight_map: { x: reference } }) });
  await expect(validateModelMounts({ input: { file }, reader: fixtureReader, capabilities: 3 })).rejects.toThrow('Unsafe');
});

it('rejects an index pointing to another index and duplicate tensors across shards', async () => {
  const index = jsonFile({ name: 'model.safetensors.index.json', text: '{"weight_map":{"x":"nested.index.json"}}' });
  const nested = jsonFile({ name: 'nested.index.json', text: '{"weight_map":{"x":"model.safetensors.index.json"}}' });
  await expect(validateModelMounts({ input: { file: index, companions: [{ relativePath: nested.name, file: nested }] }, reader: fixtureReader, capabilities: 3 })).rejects.toThrow();
  const file = jsonFile({ name: index.name, text: '{"weight_map":{"x":"one.safetensors","y":"two.safetensors"}}' });
  const first = safetensorsFixture({ name: 'one.safetensors', tensors: [tensor({ name: 'x', shape: [1] })] }).file;
  const second = safetensorsFixture({ name: 'two.safetensors', tensors: [tensor({ name: 'x', shape: [1] }), tensor({ name: 'y', shape: [1] })] }).file;
  await expect(validateModelMounts({ input: { file, companions: [first, second].map(item => ({ relativePath: item.name, file: item })) }, reader: fixtureReader, capabilities: 3 })).rejects.toThrow('Duplicate');
});

it('identifies the required metadata-free H3 BF16 embedding using bounded header reads', async () => {
  const fixture = ggufFixture({ name: 'renamed.gguf', tensors: minimaxH3PrunedTextTensors, metadata: {}, extraBytes: 0 });
  const plan = await validateModelMounts({ input: { file: fixture.file }, reader: fixtureReader, capabilities: 0 });
  expect(plan.minimaxH3Image).toBe(false);
  expect(plan.minimaxH3BF16Embedding).toEqual({ name: 'model.embed_tokens.weight', elements: 777912320n });
  expect(plan.summary.largestBF16TensorElements).toBe('777912320');
  expect(JSON.parse(plan.summary.dtypes)).toMatchObject({ BF16: 1 });
  expect(fixture.reads.reduce((total, read) => total + read.length, 0)).toBeLessThan(128 * 1024);
  expect(fixture.reads.every(read => read.offset + read.length < 128 * 1024)).toBe(true);
});

it('recognizes the active H3 Image structure independently of BF16 source counts', async () => {
  const fixture = safetensorsFixture({ name: 'renamed.safetensors', tensors: minimaxH3ImageTensors });
  const plan = await validateModelMounts({ input: { file: fixture.file }, reader: fixtureReader, capabilities: 0 });
  expect(plan.minimaxH3Image).toBe(true);
  expect(plan.minimaxH3BF16Embedding).toBeUndefined();
  expect(plan.summary.largestBF16TensorElements).toBe(String(5376 * 5120));
});

it.each(['BF16', '30'])('reports raw BF16 size for %s without treating an arbitrary tensor as a consumed H3 embedding', async dtype => {
  const entry = { name: 'unused.weight', shape: [2 ** 30], dtype };
  const fixture = dtype === 'BF16'
    ? safetensorsFixture({ name: 'source.safetensors', tensors: [entry] })
    : ggufFixture({ name: 'source.gguf', tensors: [entry], metadata: {}, extraBytes: 0 });
  const plan = await validateModelMounts({ input: { file: fixture.file }, reader: fixtureReader, capabilities: 3 });
  expect(plan.summary.largestBF16TensorElements).toBe('1073741824');
  expect(plan.minimaxH3Image).toBe(false);
  expect(plan.minimaxH3BF16Embedding).toBeUndefined();
});

it('keeps an unrelated larger BF16 tensor out of the H3 embedding conversion decision', async () => {
  const tensors = [...minimaxH3PrunedTextTensors, { name: 'unused.weight', shape: [2 ** 30], dtype: 'BF16' }];
  const fixture = ggufFixture({ name: 'renamed.gguf', tensors, metadata: {}, extraBytes: 0 });
  const plan = await validateModelMounts({ input: { file: fixture.file }, reader: fixtureReader, capabilities: 0 });
  expect(plan.summary.largestBF16TensorElements).toBe('1073741824');
  expect(plan.minimaxH3BF16Embedding).toEqual({ name: 'model.embed_tokens.weight', elements: 777912320n });
});

it.each(['F32', 'F16', '12'])('does not request BF16 conversion for an H3 embedding stored as %s', async dtype => {
  const tensors = minimaxH3PrunedTextTensors.map(tensor => tensor.name === 'model.embed_tokens.weight' ? { ...tensor, dtype } : tensor);
  const fixture = ggufFixture({ name: 'renamed.gguf', tensors, metadata: {}, extraBytes: 0 });
  const plan = await validateModelMounts({ input: { file: fixture.file }, reader: fixtureReader, capabilities: 0 });
  expect(plan.minimaxH3BF16Embedding).toBeUndefined();
  expect(plan.summary.largestBF16TensorElements).toBe('0');
});

it('leaves a large unused BF16 source tensor diagnostic when the actual H3 embedding is F16', async () => {
  const tensors = [...minimaxH3PrunedTextTensors.map(tensor => tensor.name === 'model.embed_tokens.weight' ? { ...tensor, dtype: 'F16' } : tensor), { name: 'unused.weight', shape: [2 ** 30], dtype: 'BF16' }];
  const fixture = ggufFixture({ name: 'renamed.gguf', tensors, metadata: {}, extraBytes: 0 });
  const plan = await validateModelMounts({ input: { file: fixture.file }, reader: fixtureReader, capabilities: 0 });
  expect(plan.summary.largestBF16TensorElements).toBe('1073741824');
  expect(plan.minimaxH3BF16Embedding).toBeUndefined();
});

it('does not infer a required embedding from its name and shape without the pruned H3 vision encoder', async () => {
  const fixture = safetensorsFixture({ name: 'source.safetensors', tensors: [minimaxH3PrunedTextTensors[0]!] });
  const plan = await validateModelMounts({ input: { file: fixture.file }, reader: fixtureReader, capabilities: 0 });
  expect(plan.summary.largestBF16TensorElements).toBe('777912320');
  expect(plan.minimaxH3BF16Embedding).toBeUndefined();
});

it('excludes unselected sibling BF16 tensors from both the size summary and H3 embedding facts', async () => {
  const first = safetensorsFixture({ name: 'selected.safetensors', tensors: [tensor({ name: 'selected.weight', shape: [1] })] }).file;
  const unused = ggufFixture({ name: 'unused.gguf', tensors: minimaxH3PrunedTextTensors, metadata: {}, extraBytes: 0 }).file;
  const plan = await validateModelMounts({ input: { file: first, companions: [{ relativePath: unused.name, file: unused }] }, reader: fixtureReader, capabilities: 3 });
  expect(plan.files).toEqual([{ relativePath: first.name, file: first }]);
  expect(plan.summary.largestBF16TensorElements).toBe('0');
  expect(plan.minimaxH3BF16Embedding).toBeUndefined();
});

it('requires native original-shape support only when a mounted GGUF changes physical GGML axes', async () => {
  const { file } = minimaxH3OriginalShapeFixture();
  await expect(validateModelMounts({ input: { file }, reader: fixtureReader, capabilities: 3 })).rejects.toThrow('original-shape update');
  const plan = await validateModelMounts({ input: { file }, reader: fixtureReader, capabilities: 7 });
  expect(plan.minimaxH3Image).toBe(true);
  expect(plan.files).toEqual([{ relativePath: file.name, file }]);
});

it('preserves old-core support when Krea projector metadata adds only a leading singleton', async () => {
  const { file } = inspectionGgufFixture({ metadata: [ggufArrayFixture({ key: 'comfy.gguf.orig_shape.txtfusion.projector.weight', elementType: 5, values: [1, 12], declaredLength: undefined })], tensors: [{ name: 'txtfusion.projector.weight', shape: [12], dtype: 0, offset: 0 }], dataBytes: 48, alignment: 32 });
  await expect(validateModelMounts({ input: { file }, reader: fixtureReader, capabilities: 0 })).resolves.toMatchObject({ relativePath: file.name });
});

it('does not demand original-shape support for an unmounted companion file', async () => {
  const primary = ggufFixture({ name: 'primary.gguf', tensors: [tensor({ name: 'weight', shape: [1] })], metadata: {}, extraBytes: 0 }).file;
  const unused = minimaxH3OriginalShapeFixture().file;
  const plan = await validateModelMounts({ input: { file: primary, companions: [{ relativePath: 'unused.gguf', file: unused }] }, reader: fixtureReader, capabilities: 0 });
  expect(plan.files).toEqual([{ relativePath: primary.name, file: primary }]);
});
