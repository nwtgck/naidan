import { z } from 'zod';
import { check, validName } from './primitives';
import { compile } from './schema';
import type { Plan, Finite } from './schema';
import type { Contract, NaidanRpcMethodName } from './contract';

type JsonData = boolean | number | string | JsonData[] | { [key: string]: JsonData };
type JsonSchema = { [key: string]: JsonData };
export type ValueDescriptor =
  | { kind: 'data'; schema: JsonSchema }
  | { kind: 'undefined' }
  | { kind: 'optional'; value: ValueDescriptor }
  | { kind: 'object'; properties: { [key: string]: ValueDescriptor }; required: string[] }
  | { kind: 'array'; item: ValueDescriptor }
  | { kind: 'stream'; item: JsonSchema }
  | { kind: 'byte-stream' }
  | { kind: 'callback'; input: JsonSchema; result: JsonSchema };
export type MethodDescriptor = {
  name: string;
  input: ValueDescriptor;
  result: ValueDescriptor;
  notifications: { [key: string]: JsonSchema };
};

const jsonDataSchema: z.ZodType<JsonData> = z.lazy(() => z.union([
  z.boolean(), z.number().finite(), z.string(), z.array(jsonDataSchema), z.record(z.string(), jsonDataSchema),
]));
const jsonSchema = z.record(z.string(), jsonDataSchema);
const valueDescriptorSchema: z.ZodType<ValueDescriptor> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('data'), schema: jsonSchema }),
  z.object({ kind: z.literal('undefined') }),
  z.object({ kind: z.literal('optional'), value: valueDescriptorSchema }),
  z.object({ kind: z.literal('object'), properties: z.record(z.string(), valueDescriptorSchema), required: z.array(z.string()) }),
  z.object({ kind: z.literal('array'), item: valueDescriptorSchema }),
  z.object({ kind: z.literal('stream'), item: jsonSchema }),
  z.object({ kind: z.literal('byte-stream') }),
  z.object({ kind: z.literal('callback'), input: jsonSchema, result: jsonSchema }),
]));
const methodDescription = z.object({
  name: z.string().max(64).refine(name => validName({ name })),
  input: valueDescriptorSchema,
  result: valueDescriptorSchema,
  notifications: z.record(z.string(), jsonSchema),
});
// Descriptions are finite documents, never executable capabilities. RPC's
// codec bounds their raw structure before this recursive validator runs.
export const methodDescriptorSchema = z.custom<MethodDescriptor>(value => methodDescription.safeParse(value).success);

function dataSchema({ schema }: { schema: z.ZodType }): JsonSchema {
  // JSON Schema expresses structural validation. Application refinements and
  // current authority still run on every call and are not advertised as types.
  return jsonSchema.parse(z.toJSONSchema(schema, { io: 'input', cycles: 'throw', reused: 'inline' }));
}
function containsCapability({ plan }: { plan: Plan }): boolean {
  const node = plan.node;
  switch (node.kind) {
  case 'capability': return true;
  case 'object': return [...node.fields.values()].some(plan => containsCapability({ plan }));
  case 'array': return containsCapability({ plan: node.item });
  case 'optional': return containsCapability({ plan: node.inner });
  case 'finite': return false;
  default: { const exhaustive: never = node; throw new Error(String(exhaustive)); }
  }
}
function describeValue({ plan }: { plan: Plan }): ValueDescriptor {
  const { schema, node } = plan;
  if (schema instanceof z.ZodUndefined || schema instanceof z.ZodVoid) return { kind: 'undefined' };
  if (!containsCapability({ plan })) return { kind: 'data', schema: dataSchema({ schema }) };
  switch (node.kind) {
  case 'optional': return { kind: 'optional', value: describeValue({ plan: node.inner }) };
  case 'object': return {
    kind: 'object',
    properties: Object.fromEntries([...node.fields].map(([name, plan]) => [name, describeValue({ plan })])),
    required: [...node.fields].filter(([, plan]) => !(plan.schema instanceof z.ZodOptional)).map(([name]) => name),
  };
  case 'array': return { kind: 'array', item: describeValue({ plan: node.item }) };
  case 'capability': {
    const capability = node.capability;
    switch (capability.kind) {
    case 'stream': {
      const mode = capability.mode;
      switch (mode) {
      case 'bytes': return { kind: 'byte-stream' };
      case 'items': return { kind: 'stream', item: dataSchema({ schema: capability.item }) };
      default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
      }
    }
    case 'callback': return { kind: 'callback', input: dataSchema({ schema: capability.input }), result: dataSchema({ schema: capability.result }) };
    default: { const exhaustive: never = capability; throw new Error(String(exhaustive)); }
    }
  }
  case 'finite': return { kind: 'data', schema: dataSchema({ schema }) };
  default: { const exhaustive: never = node; throw new Error(String(exhaustive)); }
  }
}
export function describeMethods<C extends Contract>({ contract, names }: {
  contract: C; names: readonly NaidanRpcMethodName<NoInfer<C>>[];
}): MethodDescriptor[] {
  check({ condition: names.length <= 64 && new Set(names).size === names.length, code: 'INVALID_ARGUMENT' });
  return names.map(name => {
    const method = contract.methods[name];
    check({ condition: method !== undefined, code: 'INVALID_ARGUMENT' });
    if (!method) throw new Error('Unknown method');
    const { input, result, notifications, ...rest } = method;
    rest satisfies Record<PropertyKey, never>;
    const description: MethodDescriptor = {
      name,
      input: describeValue({ plan: compile({ schema: input, capabilitiesAllowed: true, callbacksAllowed: true }) }),
      result: describeValue({ plan: compile({ schema: result, capabilitiesAllowed: true, callbacksAllowed: false }) }),
      notifications: Object.fromEntries(Object.entries(notifications).map(([name, schema]) => [name, dataSchema({ schema })])),
    };
    description satisfies Finite;
    return methodDescriptorSchema.parse(description);
  });
}

export const TEST_ONLY = {
};
