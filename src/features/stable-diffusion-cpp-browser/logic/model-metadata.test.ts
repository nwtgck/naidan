// @vitest-environment node
import { expect, it } from 'vitest';
import { readModelRange, inspectWeightFile, readModelJson } from './model-metadata';
import { parseModelJson } from './model-json';
import { relativeCompanionPath, validModelPath } from './model-path';
import { ggufFixture, safetensorsFixture, sparseFile, tensor } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';

it('inspects a 20 GiB GGUF from header ranges without whole-file allocation', async () => {
  const { file, reads } = ggufFixture({ name: 'renamed.data', tensors: [tensor({ name: 'weight', shape: [1] })], metadata: { 'general.architecture': 'qwen3', 'split.no': 0, 'split.count': 1, 'split.tensors.count': 1 }, extraBytes: 20 * 1024 ** 3 });
  const info = await inspectWeightFile({ file, signal: undefined });
  expect(info.status).toBe('weights'); if (info.status !== 'weights') throw new Error(info.reason);
  expect(info.value.metadata.get('general.architecture')).toBe('qwen3');
  expect(reads.reduce((n, entry) => n + entry.length, 0)).toBeLessThan(1024 * 1024);
});
it('sniffs huge safetensors independently of extension and never reads the payload', async () => {
  const { file, reads } = safetensorsFixture({ name: 'weights.bin', tensors: [tensor({ name: 'weight', shape: [5 * 1024 ** 3] })] });
  const result = await inspectWeightFile({ file, signal: undefined });
  expect(result.status).toBe('weights');
  expect(reads.every(read => read.length < 4096 && read.offset <= 8)).toBe(true);
});
it.each(['{"a":1,"a":2}', '{"a":{"x":1,"x":2}}', '{"a":1,"\\u0061":2}', '['.repeat(65) + ']'.repeat(65)])('rejects ambiguous or excessive model JSON %s', value => {
  expect(() => parseModelJson({ text: value })).toThrow();
});
it('accepts the same key in distinct JSON objects without executing data', () => {
  expect(parseModelJson({ text: '{"a":{"x":1},"b":{"x":2},"__proto__":{}}' })).toHaveProperty('b.x', 2);
});
it.each(['../a', '/a', 'a/../../b', 'a\\b', 'https://example/model', './a', 'a//b', 'a\0b'])('rejects unsafe companion paths %s', reference => {
  expect(() => relativeCompanionPath({ indexPath: 'encoder/model.index.json', reference })).toThrow();
});
it('preserves Unicode, spaces, and harmless double dots inside a segment', () => {
  expect(validModelPath({ path: '重み files/model..Q4.gguf' })).toBe(true);
  expect(relativeCompanionPath({ indexPath: 'encoder/model.index.json', reference: 'nested/part.safetensors' })).toBe('encoder/nested/part.safetensors');
});
it('recognizes Git LFS pointers rather than presenting them as usable weights', async () => {
  const header = new TextEncoder().encode(`\
version https://git-lfs.github.com/spec/v1
oid sha256:abc
size 20000000000`);
  const { file } = sparseFile({ name: 'fake.gguf', header, size: header.length });
  expect((await inspectWeightFile({ file, signal: undefined })).status).toBe('lfs-pointer');
});
it.each([
  '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,8]}}',
  '{"w":{"dtype":"F32","shape":[1],"data_offsets":[1,4]}}',
  '{"w":{"dtype":"F32","shape":[-1],"data_offsets":[0,4]}}',
  '{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,4]},"w":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}',
])('rejects invalid safetensors descriptors %s', async text => {
  const json = new TextEncoder().encode(text), header = new Uint8Array(json.length + 8);
  new DataView(header.buffer).setBigUint64(0, BigInt(json.length), true); header.set(json, 8);
  const { file } = sparseFile({ name: 'a.safetensors', header, size: header.length + 4 });
  expect((await inspectWeightFile({ file, signal: undefined })).status).toBe('invalid');
});
it('honors cancellation before reading metadata or JSON', async () => {
  const controller = new AbortController(); controller.abort(); const file = new File(['{}'], 'config.json');
  await expect(inspectWeightFile({ file, signal: controller.signal })).rejects.toThrow();
  await expect(readModelJson({ file, signal: controller.signal })).rejects.toThrow();
});

it('does not keep a cancelled inspection waiting for a stalled Blob read', async () => {
  const stop = new AbortController();
  const file = { size: 24, slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined) }) };
  const task = readModelRange({ file, offset: 0, length: 24, signal: stop.signal });
  stop.abort(); await expect(task).rejects.toMatchObject({ name: 'AbortError' });
});
