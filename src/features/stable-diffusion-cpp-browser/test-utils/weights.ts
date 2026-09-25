/** Sparse, synthetic file descriptors. They contain no trained weights. */
import type { TensorInfo } from '@/features/stable-diffusion-cpp-browser/logic/model-metadata';
import type { SyncBlobReader } from '@/features/stable-diffusion-cpp-browser/worker/gguf-file';
const ranges = new WeakMap<Blob, ArrayBuffer>();
export const fixtureReader: SyncBlobReader = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- FileReaderSync test double signature.
  readAsArrayBuffer(blob) {
    const result = ranges.get(blob); if (!result) throw new Error('Unknown fixture range'); return result;
  },
};
export function sparseFile({ name, header, size }: { name: string, header: Uint8Array<ArrayBuffer>, size: number }): { file: File, reads: { offset: number, length: number }[] } {
  const file = new File([header], name);
  const reads: { offset: number, length: number }[] = [];
  Object.defineProperty(file, 'size', { value: size });
  Object.defineProperty(file, 'slice', { value: (start: number | undefined, end: number | undefined): Blob => {
    const offset = start ?? 0, length = Math.min(end ?? size, size) - offset;
    if (length < 0 || length > 16 * 1024 * 1024) throw new Error('Fixture forbids whole-model reads');
    reads.push({ offset, length }); const bytes = new Uint8Array(length);
    if (offset < header.length) bytes.set(header.subarray(offset, Math.min(offset + length, header.length)));
    const blob = new Blob([bytes]); ranges.set(blob, bytes.buffer);
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => bytes.buffer });
    return blob;
  } });
  Object.defineProperty(file, 'arrayBuffer', { value: () => {
    throw new Error('Never materialize a complete model');
  } });
  return { file, reads };
}
export function ggufFixture({ name, tensors, metadata, extraBytes }: { name: string, tensors: TensorInfo[], metadata: Record<string, string | number>, extraBytes: number }): { file: File, reads: { offset: number, length: number }[] } {
  const bytes: number[] = [];
  function u32({ value }: { value: number }): void {
    for (let i = 0; i < 4; i++) bytes.push(value >>> (8 * i) & 255);
  }
  function u64({ value }: { value: number }): void {
    const n = BigInt(value); for (let i = 0; i < 8; i++) bytes.push(Number(n >> BigInt(8 * i) & 255n));
  }
  function str({ value }: { value: string }): void {
    const encoded = new TextEncoder().encode(value); u64({ value: encoded.length }); bytes.push(...encoded);
  }
  u32({ value: 0x46554747 }); u32({ value: 3 }); u64({ value: tensors.length }); u64({ value: Object.keys(metadata).length });
  for (const [key, value] of Object.entries(metadata)) {
    str({ value: key }); u32({ value: typeof value === 'string' ? 8 : 4 });
    if (typeof value === 'string') str({ value }); else u32({ value });
  }
  let dataBytes = 0;
  for (const tensor of tensors) {
    str({ value: tensor.name }); u32({ value: tensor.shape.length });
    for (const dimension of [...tensor.shape].reverse()) u64({ value: dimension });
    u32({ value: 0 }); u64({ value: dataBytes });
    dataBytes += Math.ceil(tensor.shape.reduce((n, d) => n * d, 4) / 32) * 32;
  }
  const header = new Uint8Array(Math.ceil(bytes.length / 32) * 32); header.set(bytes);
  return sparseFile({ name, header, size: header.length + dataBytes + extraBytes });
}
export function safetensorsFixture({ name, tensors }: { name: string, tensors: TensorInfo[] }): { file: File, reads: { offset: number, length: number }[] } {
  let offset = 0; const data: Record<string, { dtype: string, shape: number[], data_offsets: number[] }> = {};
  for (const tensor of tensors) {
    const end = offset + tensor.shape.reduce((n, d) => n * d, tensor.dtype === 'U8' ? 1 : tensor.dtype === 'F16' || tensor.dtype === 'BF16' ? 2 : 4);
    data[tensor.name] = { dtype: tensor.dtype, shape: tensor.shape, data_offsets: [offset, end] }; offset = end;
  }
  const text = new TextEncoder().encode(JSON.stringify(data)); const header = new Uint8Array(8 + text.length);
  new DataView(header.buffer).setBigUint64(0, BigInt(text.length), true); header.set(text, 8);
  return sparseFile({ name, header, size: header.length + offset });
}
export function tensor({ name, shape }: { name: string, shape: number[] }): TensorInfo {
  return { name, shape, dtype: 'F32' };
}
export const zImageTensors: TensorInfo[] = [tensor({ name: 'cap_embedder.0.weight', shape: [2560] }), tensor({ name: 'cap_embedder.1.weight', shape: [3840, 2560] }), tensor({ name: 'all_x_embedder.2-1.weight', shape: [3840, 64] })];
export const qwenImageTensors: TensorInfo[] = [tensor({ name: 'txt_in.text_norm.weight', shape: [4096] }), tensor({ name: 'img_in.weight', shape: [4096, 64] }), tensor({ name: 'txt_in.in_layer.weight', shape: [4096, 4096] })];
export const fluxVaeTensors: TensorInfo[] = [tensor({ name: 'decoder.conv_in.weight', shape: [512, 16, 3, 3] }), tensor({ name: 'decoder.conv_out.weight', shape: [3, 128, 3, 3] }), tensor({ name: 'encoder.conv_out.weight', shape: [32, 512, 3, 3] })];
export const qwenVaeTensors: TensorInfo[] = [tensor({ name: 'conv2.weight', shape: [64, 64, 1, 1, 1] }), tensor({ name: 'decoder.conv1.weight', shape: [1152, 64, 3, 3, 3] }), tensor({ name: 'decoder.head.2.weight', shape: [4, 144, 3, 3, 3] })];
export function qwenTextTensors({ width, layers }: { width: number, layers: number }): TensorInfo[] {
  return [tensor({ name: 'token_embd.weight', shape: [151936, width] }), tensor({ name: 'blk.0.attn_q_norm.weight', shape: [128] }), tensor({ name: `blk.${layers - 1}.attn_norm.weight`, shape: [width] })];
}
export const TEST_ONLY = {
};
