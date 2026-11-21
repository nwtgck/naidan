import type { AbiFunction, AbiSchema, AbiType, NativeInvoker, NativeScalar, PublicKind } from 'llama-cpp-browser-core/llama-cpp/host/abi';
import { copyNativeUtf8 } from './native-utf8';
import { visionBf16CandidateSchema, visionBf16LoadReportSchema, type VisionBf16Candidate } from './vision-bf16-storage-schema';

const version = 'mtmd_vision_bf16_diagnostics_version';
const classify = 'mtmd_vision_bf16_classify_metadata';
const initialize = 'mtmd_init_from_file_with_vision_bf16_report';
const reportName = 'mtmd_vision_bf16_load_report';
const reportFields = { version: 'unsigned', size: 'unsigned', status: 'signed', reason: 'signed', phase: 'signed', cleanup: 'signed' } as const;
const enumValues = [
  ['CANDIDATE', visionBf16CandidateSchema.options],
  ['LOAD', visionBf16LoadReportSchema.shape.status.options],
  ['REASON', visionBf16LoadReportSchema.shape.reason.options],
  ['PHASE', visionBf16LoadReportSchema.shape.phase.options],
  ['CLEANUP', visionBf16LoadReportSchema.shape.cleanup.options],
] as const;

function matchesType({ abiType, kind, type, pointerBytes }: { abiType: AbiType, kind: PublicKind, type: string, pointerBytes: 4 | 8 }): boolean {
  switch (kind) {
  case 'signed': case 'unsigned': return abiType.kind === 'integer' && abiType.bits === 32 && abiType.signed === (kind === 'signed') && !abiType.pointerSized;
  case 'pointer': return abiType.kind === 'pointer' && abiType.bits === pointerBytes * 8;
  case 'record': return abiType.kind === 'record' && abiType.record === type;
  case 'void': case 'array': case 'boolean': case 'u64': case 'i64': case 'float': return false;
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
}

// The native diagnostics version 1 contract. Calls still use the package's
// marshaler for pointer widths, record lowering, and suspension.
function matches({ fn, name, bridge, result, params, schema, module }: {
  fn: AbiFunction | undefined, name: string, bridge: boolean, result: [PublicKind, string],
  params: [PublicKind, string][], schema: AbiSchema, module: object,
}): boolean {
  const exportName = bridge ? `_bicore_${name}` : `_${name}`;
  const canonical = ({ value }: { value: string }) => value.replace(/\b(?:const|struct)\s+/g, '').replace(/\s+/g, '');
  return fn !== undefined && fn.bridge === bridge && fn.export === exportName && schema.exports.includes(exportName)
    && typeof Reflect.get(module, exportName) === 'function'
    && fn.returnKind === result[0] && canonical({ value: fn.returnType }) === result[1]
    && matchesType({ abiType: fn.abiType, kind: result[0], type: result[1], pointerBytes: schema.pointerBytes })
    && fn.parameters.length === params.length && params.every(([kind, type], index) => {
    const parameter = fn.parameters[index];
    return parameter?.kind === kind && canonical({ value: parameter.cType }) === type
        && matchesType({ abiType: parameter.abiType, kind, type, pointerBytes: schema.pointerBytes });
  });
}

export function attachVisionBf16Diagnostics({ schema, module, invoker, assertIdle, alloc, bytes, free }: {
  schema: AbiSchema, module: object, invoker: NativeInvoker, assertIdle: () => void,
  alloc: ({ bytes }: { bytes: NativeScalar }) => bigint, bytes: ({ pointer, length }: { pointer: bigint, length: NativeScalar }) => Uint8Array,
  free: ({ pointer }: { pointer: bigint }) => void,
}) {
  const find = ({ name }: { name: string }) => schema.functions.find(fn => fn.name === name);
  if (!matches({ fn: find({ name: version }), name: version, bridge: false, result: ['unsigned', 'uint32_t'], params: [], schema, module })
    || !matches({ fn: find({ name: classify }), name: classify, bridge: false, result: ['signed', 'int32_t'], params: [['signed', 'int32_t'], ['pointer', 'char*'], ['pointer', 'char*']], schema, module })
    || !matches({ fn: find({ name: initialize }), name: initialize, bridge: true, result: ['pointer', 'mtmd_context*'], params: [['pointer', 'char*'], ['pointer', 'llama_model*'], ['record', 'mtmd_context_params'], ['signed', 'int32_t'], ['pointer', `${reportName}*`], ['unsigned', 'uint32_t']], schema, module })) {
    return undefined;
  }
  if (!enumValues.every(([family, values]) => values.every((value, index) => {
    const name = `MTMD_VISION_BF16_${family}_${value.replaceAll('-', '_').toUpperCase()}`;
    return schema.constants.includes(name) && schema.constantValues[name] === String(index);
  }))) {
    return undefined;
  }
  const record = schema.records.find(entry => entry.name === reportName);
  const fields = Object.entries(reportFields);
  if (!record || record.size !== fields.length * 4 || record.fields.length !== fields.length
    || new Set(record.fields.map(field => field.offset)).size !== fields.length
    || !fields.every(([name, kind]) => record.fields.some(field => field.name === name && field.kind === kind && field.size === 4 && field.offset % 4 === 0 && field.offset >= 0 && field.offset + 4 <= record.size))) {
    return undefined;
  }
  const offsets = new Map(record.fields.map(field => [field.name, field.offset]));

  return {
    version: () => invoker.number({ name: version, args: [] }),
    async classify({ hasVision, commonProjector, visionProjector }: {
      hasVision: boolean, commonProjector: string | undefined, visionProjector: string | undefined,
    }): Promise<VisionBf16Candidate> {
      assertIdle();
      const encode = ({ text }: { text: string | undefined }) => text === undefined ? 0n : copyNativeUtf8({ core: { alloc, bytes, free }, data: new TextEncoder().encode(text) });
      const common = encode({ text: commonProjector });
      try {
        const vision = encode({ text: visionProjector });
        try {
          const candidate = await invoker.number({ name: classify, args: [hasVision ? 1 : 0, common, vision] });
          return visionBf16CandidateSchema.options[candidate] ?? 'unknown';
        } finally {
          if (vision !== 0n) {
            free({ pointer: vision });
          }
        }
      } finally {
        if (common !== 0n) {
          free({ pointer: common });
        }
      }
    },
    async initialize({ path, model, params, mode, onProjector }: {
      path: bigint, model: bigint, params: bigint, mode: number, onProjector: ({ pointer }: { pointer: bigint }) => void,
    }) {
      assertIdle();
      const buffer = alloc({ bytes: record.size });
      try {
        bytes({ pointer: buffer, length: record.size }).fill(0);
        const pointer = await invoker.bigint({ name: initialize, args: [path, model, params, mode, buffer, record.size] });
        if (pointer !== 0n) {
          // The caller owns the context even if report validation later fails.
          onProjector({ pointer });
        }
        const span = bytes({ pointer: buffer, length: record.size });
        const view = new DataView(span.buffer, span.byteOffset, span.byteLength);
        const read = ({ field }: { field: 'status' | 'reason' | 'phase' | 'cleanup' }) => view.getInt32(offsets.get(field)!, true);
        if (view.getUint32(offsets.get('version')!, true) !== 1 || view.getUint32(offsets.get('size')!, true) !== record.size) {
          throw new Error('Invalid vision BF16 load report header');
        }
        const report = visionBf16LoadReportSchema.parse({
          status: visionBf16LoadReportSchema.shape.status.options[read({ field: 'status' })],
          reason: visionBf16LoadReportSchema.shape.reason.options[read({ field: 'reason' })],
          phase: visionBf16LoadReportSchema.shape.phase.options[read({ field: 'phase' })],
          cleanup: visionBf16LoadReportSchema.shape.cleanup.options[read({ field: 'cleanup' })],
        });
        if ((pointer !== 0n) !== (report.status === 'succeeded')) {
          throw new Error('Vision BF16 load report disagrees with its result');
        }
        return { pointer, report };
      } finally {
        free({ pointer: buffer });
      }
    },
  };
}

export type VisionBf16Diagnostics = NonNullable<ReturnType<typeof attachVisionBf16Diagnostics>>;

export const TEST_ONLY = {
};
