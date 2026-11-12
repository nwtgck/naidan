import { z } from 'zod';

export const graphWeightTypes = ['F32', 'F16', 'BF16', 'Q4_0', 'Q4_1', 'Q5_0', 'Q5_1', 'Q8_0', 'Q2_K', 'Q3_K', 'Q4_K', 'Q5_K', 'Q6_K', 'IQ2_XXS', 'IQ2_XS', 'IQ3_XXS', 'IQ1_S', 'IQ4_NL', 'IQ3_S', 'IQ2_S', 'IQ4_XS', 'IQ1_M'] as const;
export const graphWeightTypeSchema = z.enum(graphWeightTypes);
export type GraphWeightType = typeof graphWeightTypes[number];
export type GraphTensorType = GraphWeightType | 'I32' | 'I64';
export type GraphTensorLayout = {
  shape: readonly number[];
  type: GraphTensorType;
  layout: 'contiguous' | 'strided';
  indices: { minimum: number; maximum: number } | undefined;
};
export const graphStorageFormats: Readonly<Record<GraphTensorType, { code: number; block: number; bytes: number }>> = {
  F32: { code: 0, block: 1, bytes: 4 },
  F16: { code: 1, block: 1, bytes: 2 },
  BF16: { code: 30, block: 1, bytes: 2 },
  Q4_0: { code: 2, block: 32, bytes: 18 },
  Q4_1: { code: 3, block: 32, bytes: 20 },
  Q5_0: { code: 6, block: 32, bytes: 22 },
  Q5_1: { code: 7, block: 32, bytes: 24 },
  Q8_0: { code: 8, block: 32, bytes: 34 },
  Q2_K: { code: 10, block: 256, bytes: 84 },
  Q3_K: { code: 11, block: 256, bytes: 110 },
  Q4_K: { code: 12, block: 256, bytes: 144 },
  Q5_K: { code: 13, block: 256, bytes: 176 },
  Q6_K: { code: 14, block: 256, bytes: 210 },
  IQ2_XXS: { code: 16, block: 256, bytes: 66 },
  IQ2_XS: { code: 17, block: 256, bytes: 74 },
  IQ3_XXS: { code: 18, block: 256, bytes: 98 },
  IQ1_S: { code: 19, block: 256, bytes: 50 },
  IQ4_NL: { code: 20, block: 32, bytes: 18 },
  IQ3_S: { code: 21, block: 256, bytes: 110 },
  IQ2_S: { code: 22, block: 256, bytes: 82 },
  IQ4_XS: { code: 23, block: 256, bytes: 136 },
  IQ1_M: { code: 29, block: 256, bytes: 56 },
  I32: { code: 26, block: 1, bytes: 4 },
  I64: { code: 27, block: 1, bytes: 8 },
};

export function graphTensorBytes({ shape, type }: { shape: readonly number[]; type: GraphTensorType }): number {
  if (shape.length < 1 || shape.length > 4 || shape.some(value => !Number.isSafeInteger(value) || value < 1 || value > 2147483647)) {
    throw new Error('Invalid tensor shape');
  }
  const format = graphStorageFormats[type];
  if (shape[0]! % format.block !== 0) {
    throw new Error('Quantized tensor row is not block-aligned');
  }
  const size = shape.reduce((product, value) => product * BigInt(value), 1n) / BigInt(format.block) * BigInt(format.bytes);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Tensor byte size overflow');
  }
  return Number(size);
}

export function graphAxes({ shape }: { shape: readonly number[] }): [number, number, number, number] {
  return [shape[0] ?? 1, shape[1] ?? 1, shape[2] ?? 1, shape[3] ?? 1];
}

export function graphSameShape({ left, right }: { left: readonly number[]; right: readonly number[] }): boolean {
  return graphAxes({ shape: left }).every((size, index) => size === (right[index] ?? 1));
}

export function requireGraphContiguous({ tensor }: { tensor: GraphTensorLayout }): void {
  switch (tensor.layout) {
  case 'contiguous': return;
  case 'strided': throw new Error('Materialize the strided tensor with contiguous before this operation');
  default: {
    const exhaustive: never = tensor.layout;
    throw new Error(String(exhaustive));
  }
  }
}

export function requireGraphF32Type({ type }: { type: GraphTensorType }): void {
  switch (type) {
  case 'F32': return;
  case 'F16': case 'BF16': case 'Q4_0': case 'Q4_1': case 'Q5_0': case 'Q5_1': case 'Q8_0': case 'Q2_K': case 'Q3_K': case 'Q4_K': case 'Q5_K': case 'Q6_K': case 'IQ2_XXS': case 'IQ2_XS': case 'IQ3_XXS': case 'IQ1_S': case 'IQ4_NL': case 'IQ3_S': case 'IQ2_S': case 'IQ4_XS': case 'IQ1_M': case 'I32': case 'I64':
    throw new Error('Operation requires an F32 tensor; use an explicit cast');
  default: {
    const exhaustive: never = type;
    throw new Error(String(exhaustive));
  }
  }
}

export function requireGraphF32({ tensor }: { tensor: GraphTensorLayout }): void {
  requireGraphContiguous({ tensor });
  requireGraphF32Type({ type: tensor.type });
}

export const TEST_ONLY = {
};
