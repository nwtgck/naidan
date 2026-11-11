import { sparseFile } from '@/features/stable-diffusion-cpp-browser/test-utils/weights.test-support';

type Value = number | bigint | string | boolean;
export type GgufMetadataFixture = { key: string, type: number, payload: Uint8Array<ArrayBuffer> };
export type GgufTensorFixture = { name: string, shape: readonly number[], dtype: number, offset: number };

function concatenate({ chunks }: { chunks: readonly Uint8Array<ArrayBuffer>[] }): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function scalar({ type, value }: { type: number, value: Value }): Uint8Array<ArrayBuffer> {
  if (type === 8) {
    const text = new TextEncoder().encode(String(value));
    return concatenate({ chunks: [scalar({ type: 10, value: text.length }), text] });
  }
  const sizes: Readonly<Record<number, number>> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const size = sizes[type];
  if (size === undefined) {
    throw new Error('Unknown scalar fixture type');
  }
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  switch (type) {
  case 0: view.setUint8(0, Number(value));
    break;
  case 1: view.setInt8(0, Number(value));
    break;
  case 2: view.setUint16(0, Number(value), true);
    break;
  case 3: view.setInt16(0, Number(value), true);
    break;
  case 4: view.setUint32(0, Number(value), true);
    break;
  case 5: view.setInt32(0, Number(value), true);
    break;
  case 6: view.setFloat32(0, Number(value), true);
    break;
  case 7: view.setUint8(0, Number(value));
    break;
  case 10: view.setBigUint64(0, BigInt(value), true);
    break;
  case 11: view.setBigInt64(0, BigInt(value), true);
    break;
  case 12: view.setFloat64(0, Number(value), true);
    break;
  default: throw new Error('Unknown scalar fixture type');
  }
  return bytes;
}

export function ggufScalarFixture({ key, type, value }: { key: string, type: number, value: Value }): GgufMetadataFixture {
  return { key, type, payload: scalar({ type, value }) };
}

export function ggufArrayFixture({ key, elementType, values, declaredLength }: { key: string, elementType: number, values: readonly Value[], declaredLength: bigint | undefined }): GgufMetadataFixture {
  return { key, type: 9, payload: concatenate({ chunks: [scalar({ type: 4, value: elementType }), scalar({ type: 10, value: declaredLength ?? BigInt(values.length) }), ...values.map(value => scalar({ type: elementType, value }))] }) };
}

/** Real GGUF metadata/descriptors with virtual zero-filled weight ranges.
 * Descriptor shapes use GGML ne order, unlike Comfy original-shape arrays. */
export function inspectionGgufFixture({ metadata, tensors, dataBytes, alignment }: { metadata: readonly GgufMetadataFixture[], tensors: readonly GgufTensorFixture[], dataBytes: number, alignment: number }): ReturnType<typeof sparseFile> {
  const chunks = [scalar({ type: 4, value: 0x46554747 }), scalar({ type: 4, value: 3 }), scalar({ type: 10, value: tensors.length }), scalar({ type: 10, value: metadata.length })];
  for (const entry of metadata) {
    chunks.push(scalar({ type: 8, value: entry.key }), scalar({ type: 4, value: entry.type }), entry.payload);
  }
  for (const tensor of tensors) {
    chunks.push(scalar({ type: 8, value: tensor.name }), scalar({ type: 4, value: tensor.shape.length }), ...tensor.shape.map(dimension => scalar({ type: 10, value: dimension })), scalar({ type: 4, value: tensor.dtype }), scalar({ type: 10, value: tensor.offset }));
  }
  const header = concatenate({ chunks });
  return sparseFile({ name: 'renamed.gguf', header, size: Math.ceil(header.length / alignment) * alignment + dataBytes });
}

export function minimaxH3OriginalShapeFixture(): ReturnType<typeof sparseFile> {
  const projections = [
    { name: 'video_patch_proj.weight', shape: [5376, 96] },
    { name: 'condition_proj.weight', shape: [5376, 5120] },
    { name: 'final_layer.video_out.weight', shape: [576, 5376] },
  ];
  const metadata = [ggufScalarFixture({ key: 'general.architecture', type: 8, value: 'wan' }), ...projections.map(projection => ggufArrayFixture({ key: `comfy.gguf.orig_shape.${projection.name}`, elementType: 5, values: projection.shape, declaredLength: undefined }))];
  let dataBytes = 0;
  const tensors = projections.map(projection => {
    const elements = projection.shape.reduce((total, dimension) => total * dimension, 1);
    const descriptor = { name: projection.name, shape: [elements], dtype: 0, offset: dataBytes };
    dataBytes += elements * 4;
    return descriptor;
  });
  return inspectionGgufFixture({ metadata, tensors, dataBytes, alignment: 32 });
}

export const TEST_ONLY = {
};
