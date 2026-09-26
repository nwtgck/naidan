// @vitest-environment node
import { expect, it } from 'vitest';
import { validateModelMounts } from './model-mounts';
import { createModelFileSource, createModelFileReadCache, MODEL_FILE_CACHE_BYTES, MODEL_FILE_PAGE_BYTES } from './gguf-file';
import { fixtureReader, ggufFixture, safetensorsFixture, sparseFile, tensor } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';

function jsonFile({ text, name }: { text: string, name: string }): File {
  const header = new TextEncoder().encode(text);
  return sparseFile({ name, header, size: header.length }).file;
}
it('keeps a single 20-GiB GGUF with Unicode/spaces intact on the old core', async () => {
  const fixture = ggufFixture({ name: '重み 20GB.gguf', tensors: [tensor({ name: 'weight', shape: [1] })], metadata: {}, extraBytes: 20 * 1024 ** 3 });
  const input = { slot: 'model' as const, file: fixture.file, path: 'weights/重み 20GB.gguf' };
  const plan = await validateModelMounts({ input, reader: fixtureReader, capabilities: 0 });
  expect(plan.path).toBe(input.path); expect(plan.files).toEqual([{ path: input.path, file: fixture.file }]);
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
  await expect(validateModelMounts({ input: { slot: 'vae', file: small }, reader: fixtureReader, capabilities: 0 })).resolves.toMatchObject({ path: small.name });
  const large = safetensorsFixture({ name: 'huge.safetensors', tensors: [{ name: 'weight', dtype: 'U8', shape: [20 * 1024 ** 3] }] }).file;
  await expect(validateModelMounts({ input: { slot: 'vae', file: large }, reader: fixtureReader, capabilities: 0 })).rejects.toThrow('do not split');
  await expect(validateModelMounts({ input: { slot: 'vae', file: large }, reader: fixtureReader, capabilities: 1 })).resolves.toMatchObject({ path: large.name });
});
it('mounts a complete pre-split GGUF group only when the core declares support', async () => {
  const files = [0, 1].map(i => ({ path: `weights/model-0000${i + 1}-of-00002.gguf`, file: ggufFixture({ name: `model-0000${i + 1}-of-00002.gguf`, tensors: [tensor({ name: `weight${i}`, shape: [1] })], metadata: { 'split.no': i, 'split.count': 2, 'split.tensors.count': 2 }, extraBytes: 0 }).file }));
  const input = { slot: 'diffusion' as const, ...files[0]!, companions: [files[1]!] };
  await expect(validateModelMounts({ input, reader: fixtureReader, capabilities: 0 })).rejects.toThrow('shard-group update');
  expect((await validateModelMounts({ input, reader: fixtureReader, capabilities: 3 })).files).toEqual(files);
  await expect(validateModelMounts({ input: { ...input, companions: [] }, reader: fixtureReader, capabilities: 3 })).rejects.toThrow('Incomplete');
});
it('resolves only index-referenced siblings and leaves unselected files unmounted', async () => {
  const weight = safetensorsFixture({ name: 'part.safetensors', tensors: [tensor({ name: 'x', shape: [1] })] }).file;
  const unused = safetensorsFixture({ name: 'unused.safetensors', tensors: [tensor({ name: 'y', shape: [1] })] }).file;
  const file = jsonFile({ name: 'model.safetensors.index.json', text: '{"weight_map":{"x":"part.safetensors"}}' });
  const input = { slot: 'lm' as const, file, path: 'encoder/model.safetensors.index.json', companions: [{ path: 'encoder/part.safetensors', file: weight }, { path: 'unused.safetensors', file: unused }] };
  const plan = await validateModelMounts({ input, reader: fixtureReader, capabilities: 0 });
  expect(plan.files.map(entry => entry.path)).toEqual(['encoder/model.safetensors.index.json', 'encoder/part.safetensors']);
});
it.each(['../part.safetensors', '/part.safetensors', 'https://remote/part.safetensors', 'sub/../part.safetensors'])('rejects model-controlled path %s', async reference => {
  const file = jsonFile({ name: 'model.safetensors.index.json', text: JSON.stringify({ weight_map: { x: reference } }) });
  await expect(validateModelMounts({ input: { slot: 'lm', file }, reader: fixtureReader, capabilities: 3 })).rejects.toThrow('Unsafe');
});
it('rejects an index pointing to another index and duplicate tensors across shards', async () => {
  const index = jsonFile({ name: 'model.safetensors.index.json', text: '{"weight_map":{"x":"nested.index.json"}}' });
  const nested = jsonFile({ name: 'nested.index.json', text: '{"weight_map":{"x":"model.safetensors.index.json"}}' });
  await expect(validateModelMounts({ input: { slot: 'lm', file: index, companions: [{ path: nested.name, file: nested }] }, reader: fixtureReader, capabilities: 3 })).rejects.toThrow();
  const file = jsonFile({ name: index.name, text: '{"weight_map":{"x":"one.safetensors","y":"two.safetensors"}}' });
  const first = safetensorsFixture({ name: 'one.safetensors', tensors: [tensor({ name: 'x', shape: [1] })] }).file;
  const second = safetensorsFixture({ name: 'two.safetensors', tensors: [tensor({ name: 'x', shape: [1] }), tensor({ name: 'y', shape: [1] })] }).file;
  await expect(validateModelMounts({ input: { slot: 'lm', file, companions: [first, second].map(item => ({ path: item.name, file: item })) }, reader: fixtureReader, capabilities: 3 })).rejects.toThrow('Duplicate');
});
