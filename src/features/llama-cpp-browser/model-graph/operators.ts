import { z } from 'zod';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { graphNameSchema, graphNumberSchema, type GraphNumber } from './expressions';
import { graphAxes, graphSameShape, graphStorageFormats, graphTensorBytes, requireGraphContiguous, requireGraphF32, type GraphTensorLayout } from './tensor-layout';

type Resolver = ({ value }: { value: GraphNumber }) => number;
type Field<T> = { syntax: z.ZodType; resolve: ({ value, number }: { value: unknown; number: Resolver }) => T };

const real = (): Field<number> => ({
  syntax: graphNumberSchema,
  resolve: ({ value, number }) => {
    const result = Math.fround(number({ value: graphNumberSchema.parse(value) }));
    if (!Number.isFinite(result)) {
      throw new Error('Operator attribute is not a finite F32 value');
    }
    return result;
  },
});

const integer = (): Field<number> => ({
  syntax: graphNumberSchema,
  resolve: ({ value, number }) => {
    const result = number({ value: graphNumberSchema.parse(value) });
    if (!Number.isSafeInteger(result) || Math.abs(result) > 2147483647) {
      throw new Error('Operator attribute is not an exact signed 32-bit integer');
    }
    return result;
  },
});

const dimensions = (): Field<number[]> => ({
  syntax: z.array(graphNumberSchema).min(1).max(4),
  resolve: ({ value, number }) => {
    const shape = z.array(graphNumberSchema).parse(value).map(item => number({ value: item }));
    graphTensorBytes({ shape, type: 'F32' });
    return shape;
  },
});

const choice = <const T extends readonly [string, ...string[]]>({ values }: { values: T }): Field<T[number]> => ({
  syntax: z.enum(values),
  resolve: ({ value }) => z.enum(values).parse(value),
});

const numbers = ({ integers }: { integers: boolean }): Field<number[]> => ({
  syntax: z.array(graphNumberSchema).min(1).max(4096),
  resolve: ({ value, number }) => z.array(graphNumberSchema).parse(value).map(item => {
    const result = number({ value: item });
    if (integers ? !Number.isSafeInteger(result) || result < 0 || result > 2147483647 : !Number.isFinite(Math.fround(result))) {
      throw new Error('Constant elements exceed the declared numeric contract');
    }
    return integers ? result : Math.fround(result);
  }),
});

export type OperatorLoweringContext = {
  core: Core; context: bigint; inputs: readonly bigint[];
  constant: ({ shape, type, values }: { shape: readonly number[]; type: 'F32' | 'I32'; values: readonly number[] }) => Promise<bigint>;
};
export type BoundTensorOperation = {
  tensor: GraphTensorLayout;
  extraTensorCount: number;
  nativeFunctions: readonly (keyof Core['api'])[];
  lower: ({ environment }: { environment: OperatorLoweringContext }) => Promise<bigint>;
};
type Values<F extends Record<string, Field<unknown>>> = { [K in keyof F]: ReturnType<F[K]['resolve']> };
type Operator = {
  syntax: z.ZodType;
  inputCount: number;
  bind: ({ input, attributes, number }: { input: readonly GraphTensorLayout[]; attributes: Record<string, unknown>; number: Resolver }) => BoundTensorOperation;
};

function operator<F extends Record<string, Field<unknown>>>({ fields, inputCount, functions, prepare }: {
  fields: F; inputCount: number; functions: readonly (keyof Core['api'])[];
  prepare: ({ input, attributes }: { input: readonly GraphTensorLayout[]; attributes: Values<F> }) => Omit<BoundTensorOperation, 'nativeFunctions'>;
}): Operator {
  const syntax = z.strictObject(Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.syntax])));
  return {
    syntax,
    inputCount,
    bind: ({ input, attributes, number }) => {
      if (input.length !== inputCount) {
        throw new Error(`Operator requires exactly ${inputCount} inputs`);
      }
      const raw = syntax.parse(attributes);
      // The key set is exactly the checked schema above; field resolvers validate
      // each value. No model-supplied key is used to index the native API.
      const resolved = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.resolve({ value: raw[name], number })])) as Values<F>;
      return { ...prepare({ input, attributes: resolved }), nativeFunctions: functions };
    },
  };
}

function activation({ shape }: { shape: readonly number[] }): GraphTensorLayout {
  return { shape: [...shape], type: 'F32', layout: 'contiguous', indices: undefined };
}

function elementwise({ fn }: { fn: ({ environment }: { environment: OperatorLoweringContext }) => Promise<bigint> }) {
  return ({ input }: { input: readonly GraphTensorLayout[] }) => {
    const a = input[0]!;
    requireGraphF32({ tensor: a });
    return { tensor: activation({ shape: a.shape }), extraTensorCount: 1, lower: fn };
  };
}

function pointwise({ broadcasting, call }: {
  broadcasting: 'equal' | 'rows';
  call: ({ environment }: { environment: OperatorLoweringContext }) => Promise<bigint>;
}) {
  return ({ input }: { input: readonly GraphTensorLayout[] }) => {
    const a = input[0]!, b = input[1]!;
    requireGraphF32({ tensor: a });
    requireGraphF32({ tensor: b });
    const aa = graphAxes({ shape: a.shape }), bb = graphAxes({ shape: b.shape });
    switch (broadcasting) {
    case 'equal':
      if (!graphSameShape({ left: aa, right: bb })) {
        throw new Error('Operator requires equal operand shapes');
      }
      break;
    case 'rows':
      if (bb.some((size, axis) => aa[axis]! % size !== 0)) {
        throw new Error('Invalid elementwise broadcast');
      }
      break;
    default: {
      const exhaustive: never = broadcasting;
      throw new Error(String(exhaustive));
    }
    }
    return { tensor: activation({ shape: a.shape }), extraTensorCount: 1, lower: call };
  };
}

function normalization({ fn }: { fn: ({ environment, epsilon }: { environment: OperatorLoweringContext; epsilon: number }) => Promise<bigint> }) {
  return ({ input, attributes }: { input: readonly GraphTensorLayout[]; attributes: { epsilon: number } }) => {
    requireGraphF32({ tensor: input[0]! });
    if (attributes.epsilon <= 0 || attributes.epsilon > 1) {
      throw new Error('Normalization epsilon must be in (0, 1]');
    }
    return { tensor: activation({ shape: input[0]!.shape }), extraTensorCount: 1, lower: ({ environment }: { environment: OperatorLoweringContext }) => fn({ environment, epsilon: attributes.epsilon }) };
  };
}

/** A single reviewed contract per operator: declaration syntax, attributes,
 * shape/dtype/layout rules, native dependencies and lowering live together.
 * Adding an operator is not adding a model architecture. This catalog never
 * exposes allocation/free/callback entry points or arbitrary native names. */
export const modelGraphOperators = {
  add: operator({ fields: {}, inputCount: 2, functions: ['ggml_add'], prepare: pointwise({ broadcasting: 'rows', call: ({ environment: e }) => e.core.api.ggml_add(e.context, e.inputs[0]!, e.inputs[1]!) }) }),
  subtract: operator({ fields: {}, inputCount: 2, functions: ['ggml_sub'], prepare: pointwise({ broadcasting: 'equal', call: ({ environment: e }) => e.core.api.ggml_sub(e.context, e.inputs[0]!, e.inputs[1]!) }) }),
  multiply: operator({ fields: {}, inputCount: 2, functions: ['ggml_mul'], prepare: pointwise({ broadcasting: 'rows', call: ({ environment: e }) => e.core.api.ggml_mul(e.context, e.inputs[0]!, e.inputs[1]!) }) }),
  divide: operator({ fields: {}, inputCount: 2, functions: ['ggml_div'], prepare: pointwise({ broadcasting: 'rows', call: ({ environment: e }) => e.core.api.ggml_div(e.context, e.inputs[0]!, e.inputs[1]!) }) }),
  silu: operator({ fields: {}, inputCount: 1, functions: ['ggml_silu'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_silu(e.context, e.inputs[0]!) }) }),
  sigmoid: operator({ fields: {}, inputCount: 1, functions: ['ggml_sigmoid'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_sigmoid(e.context, e.inputs[0]!) }) }),
  gelu: operator({ fields: {}, inputCount: 1, functions: ['ggml_gelu'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_gelu(e.context, e.inputs[0]!) }) }),
  relu: operator({ fields: {}, inputCount: 1, functions: ['ggml_relu'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_relu(e.context, e.inputs[0]!) }) }),
  tanh: operator({ fields: {}, inputCount: 1, functions: ['ggml_tanh'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_tanh(e.context, e.inputs[0]!) }) }),
  abs: operator({ fields: {}, inputCount: 1, functions: ['ggml_abs'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_abs(e.context, e.inputs[0]!) }) }),
  negate: operator({ fields: {}, inputCount: 1, functions: ['ggml_neg'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_neg(e.context, e.inputs[0]!) }) }),
  square: operator({ fields: {}, inputCount: 1, functions: ['ggml_sqr'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_sqr(e.context, e.inputs[0]!) }) }),
  sqrt: operator({ fields: {}, inputCount: 1, functions: ['ggml_sqrt'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_sqrt(e.context, e.inputs[0]!) }) }),
  log: operator({ fields: {}, inputCount: 1, functions: ['ggml_log'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_log(e.context, e.inputs[0]!) }) }),
  exp: operator({ fields: {}, inputCount: 1, functions: ['ggml_exp'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_exp(e.context, e.inputs[0]!) }) }),
  softplus: operator({ fields: {}, inputCount: 1, functions: ['ggml_softplus'], prepare: elementwise({ fn: ({ environment: e }) => e.core.api.ggml_softplus(e.context, e.inputs[0]!) }) }),
  rmsNorm: operator({ fields: { epsilon: real() }, inputCount: 1, functions: ['ggml_rms_norm'], prepare: normalization({ fn: ({ environment: e, epsilon }) => e.core.api.ggml_rms_norm(e.context, e.inputs[0]!, epsilon) }) }),
  norm: operator({ fields: { epsilon: real() }, inputCount: 1, functions: ['ggml_norm'], prepare: normalization({ fn: ({ environment: e, epsilon }) => e.core.api.ggml_norm(e.context, e.inputs[0]!, epsilon) }) }),
  scale: operator({
    fields: { scale: real(), bias: real() },
    inputCount: 1,
    functions: ['ggml_scale_bias'],
    prepare: ({ input, attributes }) => {
      requireGraphF32({ tensor: input[0]! });
      return { tensor: activation({ shape: input[0]!.shape }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_scale_bias(e.context, e.inputs[0]!, attributes.scale, attributes.bias) };
    },
  }),
  clamp: operator({
    fields: { minimum: real(), maximum: real() },
    inputCount: 1,
    functions: ['ggml_clamp'],
    prepare: ({ input, attributes }) => {
      requireGraphF32({ tensor: input[0]! });
      if (attributes.minimum > attributes.maximum) {
        throw new Error('Clamp minimum exceeds maximum');
      }
      return { tensor: activation({ shape: input[0]!.shape }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_clamp(e.context, e.inputs[0]!, attributes.minimum, attributes.maximum) };
    },
  }),
  swigluClamped: operator({
    fields: { limit: real() },
    inputCount: 2,
    functions: ['ggml_swiglu_clamp'],
    prepare: ({ input, attributes }) => {
      requireGraphF32({ tensor: input[0]! });
      requireGraphF32({ tensor: input[1]! });
      if (!graphSameShape({ left: input[0]!.shape, right: input[1]!.shape }) || attributes.limit <= 0) {
        throw new Error('Clamped SwiGLU needs equal shapes and a positive limit');
      }
      return { tensor: activation({ shape: input[0]!.shape }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_swiglu_clamp(e.context, e.inputs[0]!, e.inputs[1]!, attributes.limit) };
    },
  }),
  matmul: operator({
    fields: {},
    inputCount: 2,
    functions: ['ggml_mul_mat'],
    prepare: ({ input }) => {
      const a = input[0]!, b = input[1]!;
      requireGraphContiguous({ tensor: a });
      requireGraphF32({ tensor: b });
      if (a.type === 'I32' || a.type === 'I64') {
        throw new Error('Integer weights are not matrix operands');
      }
      const aa = graphAxes({ shape: a.shape }), bb = graphAxes({ shape: b.shape });
      if (aa[0] !== bb[0] || bb[2] % aa[2] || bb[3] % aa[3]) {
        throw new Error('Invalid batched matrix product shape');
      }
      return { tensor: activation({ shape: [aa[1], bb[1], bb[2], bb[3]] }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_mul_mat(e.context, e.inputs[0]!, e.inputs[1]!) };
    },
  }),
  matmulIndexed: operator({
    fields: {},
    inputCount: 3,
    functions: ['ggml_mul_mat_id'],
    prepare: ({ input }) => {
      const a = input[0]!, b = input[1]!, ids = input[2]!;
      requireGraphContiguous({ tensor: a });
      requireGraphF32({ tensor: b });
      requireGraphContiguous({ tensor: ids });
      const aa = graphAxes({ shape: a.shape }), bb = graphAxes({ shape: b.shape }), ii = graphAxes({ shape: ids.shape });
      if (a.type === 'I32' || a.type === 'I64' || ids.type !== 'I32' || !ids.indices || ids.indices.minimum < 0 || ids.indices.maximum >= aa[2]
      || aa[3] !== 1 || bb[3] !== 1 || ii[2] !== 1 || ii[3] !== 1 || ii[1] !== bb[2] || aa[0] !== bb[0] || ii[0] % bb[1]) {
        throw new Error('Indexed matrix product needs compatible shapes and intrinsically bounded expert indices');
      }
      return { tensor: activation({ shape: [aa[1], ii[0], bb[2]] }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_mul_mat_id(e.context, e.inputs[0]!, e.inputs[1]!, e.inputs[2]!) };
    },
  }),
  gatherRows: operator({
    fields: {},
    inputCount: 2,
    functions: ['ggml_get_rows'],
    prepare: ({ input }) => {
      const a = input[0]!, ids = input[1]!;
      requireGraphContiguous({ tensor: a });
      requireGraphContiguous({ tensor: ids });
      const aa = graphAxes({ shape: a.shape }), ii = graphAxes({ shape: ids.shape });
      if (a.type === 'I64' || ids.type !== 'I32' || !ids.indices || ids.indices.minimum < 0 || ids.indices.maximum >= aa[1]
      || aa[2] !== ii[1] || aa[3] !== ii[2] || ii[3] !== 1) {
        throw new Error('Row gather requires shape-compatible bounded I32 indices');
      }
      const tensor: GraphTensorLayout = (() => {
        const shape = [aa[0], ii[0], ii[1], ii[2]];
        switch (a.type) {
        case 'I32': return { shape, type: 'I32', layout: 'contiguous', indices: a.indices };
        case 'F32': case 'F16': case 'BF16': case 'Q4_0': case 'Q4_1': case 'Q5_0': case 'Q5_1': case 'Q8_0': case 'Q2_K': case 'Q3_K': case 'Q4_K': case 'Q5_K': case 'Q6_K': case 'IQ2_XXS': case 'IQ2_XS': case 'IQ3_XXS': case 'IQ1_S': case 'IQ4_NL': case 'IQ3_S': case 'IQ2_S': case 'IQ4_XS': case 'IQ1_M':
          return { shape, type: 'F32', layout: 'contiguous', indices: undefined };
        default: {
          const exhaustive: never = a.type;
          throw new Error(String(exhaustive));
        }
        }
      })();
      return { tensor, extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_get_rows(e.context, e.inputs[0]!, e.inputs[1]!) };
    },
  }),
  topK: operator({
    fields: { count: integer() },
    inputCount: 1,
    functions: ['ggml_top_k'],
    prepare: ({ input, attributes }) => {
      const a = input[0]!;
      requireGraphF32({ tensor: a });
      if (attributes.count < 1 || attributes.count > a.shape[0]!) {
        throw new Error('Top-K count exceeds the row width');
      }
      return { tensor: { shape: [attributes.count, ...a.shape.slice(1)], type: 'I32', layout: 'contiguous', indices: { minimum: 0, maximum: a.shape[0]! - 1 } }, extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_top_k(e.context, e.inputs[0]!, attributes.count) };
    },
  }),
  cast: operator({
    fields: { type: choice({ values: ['F32', 'F16', 'BF16'] }) },
    inputCount: 1,
    functions: ['ggml_cast'],
    prepare: ({ input, attributes }) => {
      const a = input[0]!;
      requireGraphContiguous({ tensor: a });
      if (!['F32', 'F16', 'BF16'].includes(a.type)) {
        throw new Error('Cast accepts floating point inputs only; it cannot manufacture index bounds');
      }
      return { tensor: { ...a, type: attributes.type, indices: undefined }, extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_cast(e.context, e.inputs[0]!, e.core.constant({ name: `GGML_TYPE_${attributes.type}` })) };
    },
  }),
  contiguous: operator({
    fields: {},
    inputCount: 1,
    functions: ['ggml_cont'],
    prepare: ({ input }) => ({
      tensor: { ...input[0]!, layout: 'contiguous' },
      extraTensorCount: 1,
      lower: ({ environment: e }) => e.core.api.ggml_cont(e.context, e.inputs[0]!),
    }),
  }),
  reshape: operator({
    fields: { shape: dimensions() },
    inputCount: 1,
    functions: ['ggml_reshape_4d'],
    prepare: ({ input, attributes }) => {
      const a = input[0]!;
      requireGraphContiguous({ tensor: a });
      if (graphTensorBytes({ shape: a.shape, type: a.type }) !== graphTensorBytes({ shape: attributes.shape, type: a.type })) {
        throw new Error('Reshape changes the tensor size');
      }
      return { tensor: { ...a, shape: attributes.shape }, extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_reshape_4d(e.context, e.inputs[0]!, ...graphAxes({ shape: attributes.shape }).map(BigInt) as [bigint, bigint, bigint, bigint]) };
    },
  }),
  transpose: operator({
    fields: {},
    inputCount: 1,
    functions: ['ggml_transpose'],
    prepare: ({ input }) => {
      const a = input[0]!, shape = graphAxes({ shape: a.shape });
      [shape[0], shape[1]] = [shape[1], shape[0]];
      if (graphStorageFormats[a.type].block !== 1) {
        throw new Error('Materialize quantized rows before transposing');
      }
      return { tensor: { ...a, shape, layout: 'strided' }, extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_transpose(e.context, e.inputs[0]!) };
    },
  }),
  repeat: operator({
    fields: { shape: dimensions() },
    inputCount: 1,
    functions: ['ggml_repeat_4d'],
    prepare: ({ input, attributes }) => {
      const a = input[0]!;
      requireGraphF32({ tensor: a });
      const from = graphAxes({ shape: a.shape }), to = graphAxes({ shape: attributes.shape });
      if (to.some((size, index) => size % from[index]!)) {
        throw new Error('Repeat dimensions must be divisible by input dimensions');
      }
      return { tensor: activation({ shape: to }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_repeat_4d(e.context, e.inputs[0]!, ...to.map(BigInt) as [bigint, bigint, bigint, bigint]) };
    },
  }),
  slice: operator({
    fields: { axis: integer(), start: integer(), length: integer() },
    inputCount: 1,
    functions: ['ggml_view_4d'],
    prepare: ({ input, attributes }) => {
      const a = input[0]!;
      requireGraphContiguous({ tensor: a });
      const original = graphAxes({ shape: a.shape }), { axis, start, length } = attributes;
      if (axis < 0 || axis > 3 || start < 0 || length < 1 || start + length > original[axis]! || graphStorageFormats[a.type].block !== 1) {
        throw new Error('Invalid or quantized tensor slice');
      }
      const unit = graphStorageFormats[a.type].bytes;
      const strides = [unit, unit * original[0], unit * original[0] * original[1], unit * original[0] * original[1] * original[2]];
      const shape = [...original];
      shape[axis] = length;
      const offset = strides[axis]! * start;
      return {
        tensor: { ...a, shape, layout: start === 0 && length === original[axis] ? a.layout : 'strided' },
        extraTensorCount: 1,
        lower: ({ environment: e }) => e.core.api.ggml_view_4d(e.context, e.inputs[0]!, BigInt(shape[0]!), BigInt(shape[1]!), BigInt(shape[2]!), BigInt(shape[3]!), BigInt(strides[1]!), BigInt(strides[2]!), BigInt(strides[3]!), BigInt(offset)),
      };
    },
  }),
  concat: operator({
    fields: { axis: integer() },
    inputCount: 2,
    functions: ['ggml_concat'],
    prepare: ({ input, attributes }) => {
      const a = input[0]!, b = input[1]!;
      requireGraphF32({ tensor: a });
      requireGraphF32({ tensor: b });
      const shape = graphAxes({ shape: a.shape }), other = graphAxes({ shape: b.shape });
      if (attributes.axis < 0 || attributes.axis > 3 || shape.some((size, axis) => axis !== attributes.axis && size !== other[axis])) {
        throw new Error('Concatenation non-axis dimensions differ');
      }
    shape[attributes.axis]! += other[attributes.axis]!;
    return { tensor: activation({ shape }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_concat(e.context, e.inputs[0]!, e.inputs[1]!, attributes.axis) };
    },
  }),
  sumRows: operator({
    fields: {},
    inputCount: 1,
    functions: ['ggml_sum_rows'],
    prepare: ({ input }) => {
      const a = input[0]!;
      requireGraphF32({ tensor: a });
      return { tensor: activation({ shape: [1, ...a.shape.slice(1)] }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_sum_rows(e.context, e.inputs[0]!) };
    },
  }),
  meanRows: operator({
    fields: {},
    inputCount: 1,
    functions: ['ggml_mean'],
    prepare: ({ input }) => {
      const a = input[0]!;
      requireGraphF32({ tensor: a });
      return { tensor: activation({ shape: [1, ...a.shape.slice(1)] }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_mean(e.context, e.inputs[0]!) };
    },
  }),
  sum: operator({
    fields: {},
    inputCount: 1,
    functions: ['ggml_sum'],
    prepare: ({ input }) => {
      requireGraphF32({ tensor: input[0]! });
      return { tensor: activation({ shape: [1] }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_sum(e.context, e.inputs[0]!) };
    },
  }),
  softmax: operator({
    fields: { scale: real() },
    inputCount: 1,
    functions: ['ggml_soft_max_ext'],
    prepare: ({ input, attributes }) => {
      const a = input[0]!;
      requireGraphF32({ tensor: a });
      return { tensor: activation({ shape: a.shape }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_soft_max_ext(e.context, e.inputs[0]!, 0n, attributes.scale, 0) };
    },
  }),
  maskedSoftmax: operator({
    fields: { scale: real(), maxBias: real() },
    inputCount: 2,
    functions: ['ggml_soft_max_ext'],
    prepare: ({ input, attributes }) => {
      const a = input[0]!, mask = input[1]!;
      requireGraphF32({ tensor: a });
      requireGraphContiguous({ tensor: mask });
      const aa = graphAxes({ shape: a.shape }), mm = graphAxes({ shape: mask.shape });
      if (!['F16', 'F32'].includes(mask.type) || aa[0] !== mm[0] || aa[1] > mm[1] || aa[2] % mm[2] || aa[3] % mm[3] || attributes.maxBias < 0) {
        throw new Error('Invalid attention mask layout or bias');
      }
      return { tensor: activation({ shape: a.shape }), extraTensorCount: 1, lower: ({ environment: e }) => e.core.api.ggml_soft_max_ext(e.context, e.inputs[0]!, e.inputs[1]!, attributes.scale, attributes.maxBias) };
    },
  }),
  constant: operator({
    fields: { shape: dimensions(), values: numbers({ integers: false }) },
    inputCount: 0,
    functions: ['ggml_new_tensor_4d', 'ggml_set_input'],
    prepare: ({ attributes }) => {
      const elements = graphTensorBytes({ shape: attributes.shape, type: 'F32' }) / 4;
      if (attributes.values.length !== 1 && attributes.values.length !== elements) {
        throw new Error('Constant needs one fill value or exactly the tensor element count');
      }
      return { tensor: activation({ shape: attributes.shape }), extraTensorCount: 1, lower: ({ environment: e }) => e.constant({ shape: attributes.shape, type: 'F32', values: attributes.values }) };
    },
  }),
  indexList: operator({
    fields: { shape: dimensions(), values: numbers({ integers: true }) },
    inputCount: 0,
    functions: ['ggml_new_tensor_4d', 'ggml_set_input'],
    prepare: ({ attributes }) => {
      const elements = graphTensorBytes({ shape: attributes.shape, type: 'I32' }) / 4;
      if (attributes.values.length !== elements) {
        throw new Error('Index list length does not match its tensor shape');
      }
      return { tensor: { shape: attributes.shape, type: 'I32', layout: 'contiguous', indices: { minimum: Math.min(...attributes.values), maximum: Math.max(...attributes.values) } }, extraTensorCount: 1, lower: ({ environment: e }) => e.constant({ shape: attributes.shape, type: 'I32', values: attributes.values }) };
    },
  }),
} satisfies Record<string, Operator>;

export type TensorOperatorName = keyof typeof modelGraphOperators;
export const tensorOperatorNames = Object.keys(modelGraphOperators) as [TensorOperatorName, ...TensorOperatorName[]];

export function createTensorOperatorNodeSchema<T extends z.ZodType>({ reference }: { reference: T }) {
  return z.strictObject({
    id: graphNameSchema,
    op: z.literal('tensor'),
    operator: z.enum(tensorOperatorNames),
    inputs: z.array(reference).max(4),
    attributes: z.record(z.string(), z.unknown()),
  }).superRefine((node, context) => {
    const descriptor = modelGraphOperators[node.operator];
    if (node.inputs.length !== descriptor.inputCount) {
      context.addIssue({ code: 'custom', message: `Expected ${descriptor.inputCount} tensor operands`, path: ['inputs'] });
    }
    const attributes = descriptor.syntax.safeParse(node.attributes);
    if (!attributes.success) {
      for (const issue of attributes.error.issues) {
        context.addIssue({ code: 'custom', message: issue.message, path: ['attributes', ...issue.path] });
      }
    }
  });
}

export const tensorOperatorNodeSchema = createTensorOperatorNodeSchema({ reference: graphNameSchema });
export type TensorOperatorNode = z.infer<typeof tensorOperatorNodeSchema>;

export function bindTensorOperator({ node, inputs, number }: { node: TensorOperatorNode; inputs: readonly GraphTensorLayout[]; number: Resolver }): BoundTensorOperation {
  return modelGraphOperators[node.operator].bind({ input: inputs, attributes: node.attributes, number });
}

export const TEST_ONLY = {
};
