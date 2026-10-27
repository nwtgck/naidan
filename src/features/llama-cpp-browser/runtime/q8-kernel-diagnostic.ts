import { z } from 'zod';

type Scalar = number | bigint;
/** Internal capability, passed only by attachCore's private ownership lease. */
interface DiagnosticOwner {
  isHealthy(): boolean;
  poison(): void;
  version({ backend }: { backend: bigint }): Scalar;
  allocate({ length }: { length: number }): bigint | undefined;
  bytes({ pointer, length }: { pointer: bigint, length: number }): Uint8Array;
  free({ pointer }: { pointer: bigint }): void;
  invoke({ backend, dst, request, report, capacity }: { backend: bigint, dst: bigint, request: bigint, report: bigint, capacity: number }): Promise<unknown>;
}
/** Internal setup leaves; never exposed on Core or the returned adapter. */
export interface Q8DiagnosticAccess {
  assertIdle(): void;
  schemaHash(): Scalar;
  recordSize({ recordId }: { recordId: number }): Scalar;
  recordAlignment({ recordId }: { recordId: number }): Scalar;
  fieldOffset({ recordId, fieldId }: { recordId: number, fieldId: number }): Scalar;
  fieldSize({ recordId, fieldId }: { recordId: number, fieldId: number }): Scalar;
  constant({ id }: { id: number }): Scalar;
  bytes({ pointer, length }: { pointer: bigint, length: number }): Uint8Array;
  withAccess<T>({ operation }: { operation: ({ owner }: { owner: DiagnosticOwner }) => Promise<T> }): Promise<T>;
}

const variantConstants = {
  auto: 'AUTO',
  'cooperative-wg256-r4': 'COOPERATIVE_WG256_R4',
  'independent-wg128-r4': 'INDEPENDENT_WG128_R4',
  'independent-wg128-r1': 'INDEPENDENT_WG128_R1',
  'independent-wg128-r2': 'INDEPENDENT_WG128_R2',
  'cooperative-wg128-r2': 'COOPERATIVE_WG128_R2',
} as const;
const phaseConstants = { prepare: 'PREPARE', execute: 'EXECUTE' } as const;
const statusConstants = { ok: 'OK', unavailable: 'UNAVAILABLE', 'bad-request': 'BAD_REQUEST', unsupported: 'UNSUPPORTED', 'not-prepared': 'NOT_PREPARED', busy: 'BUSY' } as const;
const algorithmConstants = { none: 'ALGORITHM_NONE', cooperative: 'ALGORITHM_COOPERATIVE', independent: 'ALGORITHM_INDEPENDENT' } as const;
const forcedLaunches = {
  auto: undefined,
  'cooperative-wg256-r4': { algorithm: 'cooperative', workgroup: 256, rows: 4 },
  'independent-wg128-r4': { algorithm: 'independent', workgroup: 128, rows: 4 },
  'independent-wg128-r1': { algorithm: 'independent', workgroup: 128, rows: 1 },
  'independent-wg128-r2': { algorithm: 'independent', workgroup: 128, rows: 2 },
  'cooperative-wg128-r2': { algorithm: 'cooperative', workgroup: 128, rows: 2 },
} as const satisfies Record<Q8KernelDiagnosticVariant, unknown>;
export type Q8KernelDiagnosticVariant = keyof typeof variantConstants;
export type Q8KernelDiagnosticPhase = keyof typeof phaseConstants;
export type Q8KernelDiagnosticStatus = keyof typeof statusConstants;
export type Q8KernelDiagnosticAlgorithm = keyof typeof algorithmConstants;
const u32 = z.number().int().min(0).max(0xffffffff);
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z_0-9]*$/);
const prefix = '_lcb_webgpu_q8_diagnostic_';
const requestName = 'ggml_webgpu_q8_diagnostic_request_v1';
const reportName = 'ggml_webgpu_q8_diagnostic_report_v1';
const requestFields = ['abi_version', 'struct_size', 'variant', 'phase', 'repetitions', 'reserved'] as const;
const reportFields = ['abi_version', 'struct_size', 'status', 'requested_variant', 'phase', 'actual_algorithm', 'workgroup_size', 'logical_subgroup_size', 'real_min_subgroup_size', 'real_max_subgroup_size', 'rows_per_tile', 'outputs_per_workgroup', 'cooperative_subgroup_reduction', 'grid_x', 'grid_y', 'grid_z', 'dispatches', 'codegen_revision', 'shader_identity_id', 'reserved', 'shader_sha256'] as const;
const fieldSchema = z.strictObject({ id: u32, name: identifier, cType: z.enum(['uint32_t', 'uint8_t[32]']), kind: z.enum(['unsigned', 'array']) });
const extensionSchema = z.strictObject({
  abiVersion: z.literal(1),
  extensionId: z.literal('webgpu-q8-diagnostic-v1'),
  baseAbiVersion: z.literal(1),
  pointerRepresentation: z.literal('bigint-u64'),
  versionExport: z.literal(prefix + 'version'),
  schemaHashExport: z.literal(prefix + 'schema_hash'),
  recordQueryNamespace: z.literal(prefix),
  functions: z.array(z.strictObject({
    name: identifier,
    export: identifier,
    returnType: z.enum(['int32_t', 'uint32_t']),
    returnKind: z.enum(['signed', 'unsigned']),
    suspension: z.enum(['jspi', 'none']),
    parameters: z.array(z.strictObject({ name: identifier, cType: z.enum(['uint64_t', 'uint32_t']), kind: z.enum(['u64', 'unsigned']) })),
  })).length(2),
  records: z.array(z.strictObject({ name: identifier, cType: z.string(), fields: z.array(fieldSchema), id: u32 })).length(2),
  constants: z.array(identifier),
  schemaSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
type ExtensionSchema = z.infer<typeof extensionSchema>;
type RecordLayout = Readonly<{ size: number, alignment: number, fields: ReadonlyMap<string, Readonly<{ offset: number, size: number }>> }>;

export type Q8KernelDiagnosticResult = Readonly<{
  status: Q8KernelDiagnosticStatus;
  variant: Q8KernelDiagnosticVariant;
  phase: Q8KernelDiagnosticPhase;
  algorithm: Q8KernelDiagnosticAlgorithm;
  workgroupSize: number;
  logicalSubgroupSize: number;
  realMinSubgroupSize: number;
  realMaxSubgroupSize: number;
  rowsPerTile: number;
  outputsPerWorkgroup: number;
  cooperativeSubgroupReduction: boolean;
  grid: Readonly<{ x: number, y: number, z: number }>;
  dispatches: number;
  codegenRevision: number;
  shaderSha256: string | undefined;
  /** Only the native invoke and its JSPI suspension, excluding marshal/cleanup. */
  nativeWallMs: number;
}>;
export interface Q8KernelDiagnosticAdapter {
  /** Keep backend/dst alive through settlement. On fatal failure or timeout
   * discard the Worker; never race this Promise with individual native frees. */
  run({ backend, dst, variant, phase, repetitions }: {
    backend: bigint, dst: bigint, variant: Q8KernelDiagnosticVariant, phase: Q8KernelDiagnosticPhase, repetitions: number,
  }): Promise<Q8KernelDiagnosticResult>;
}
export class Q8KernelDiagnosticFatalError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('Q8 diagnostic runtime must be discarded', { cause });
    this.name = 'Q8KernelDiagnosticFatalError';
  }
}

function exactNames({ actual, expected }: { actual: readonly string[], expected: readonly string[] }): void {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || expected.some(name => !actual.includes(name))) {
    throw new Error('Unsupported Q8 diagnostic schema entries');
  }
}

function safeNumber({ value }: { value: Scalar }): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 0xffffffff) {
    throw new RangeError('Invalid Q8 diagnostic layout or constant');
  }
  return number;
}

function hex({ bytes }: { bytes: Uint8Array }): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateFunctions({ schema }: { schema: ExtensionSchema }): void {
  exactNames({ actual: schema.functions.map(fn => fn.name), expected: ['lcb_webgpu_q8_diagnostic_run_v1', 'lcb_webgpu_q8_diagnostic_version'] });
  for (const fn of schema.functions) {
    const run = fn.name.endsWith('run_v1');
    const parameters = run ? ['backend', 'dst', 'request', 'report', 'report_capacity'] : ['backend'];
    if (fn.export !== '_' + fn.name || fn.returnType !== (run ? 'int32_t' : 'uint32_t') || fn.returnKind !== (run ? 'signed' : 'unsigned')
      || fn.suspension !== (run ? 'jspi' : 'none') || fn.parameters.length !== parameters.length
      || fn.parameters.some((p, i) => p.name !== parameters[i] || p.cType !== (i === 4 ? 'uint32_t' : 'uint64_t') || p.kind !== (i === 4 ? 'unsigned' : 'u64'))) {
      throw new Error('Unsupported Q8 diagnostic signature');
    }
  }
}

function readLayout({ schema, name, names, access }: { schema: ExtensionSchema, name: string, names: readonly string[], access: Q8DiagnosticAccess }): RecordLayout {
  const record = schema.records.find(record => record.name === name);
  if (!record || record.cType !== 'struct ' + name) {
    throw new Error('Unsupported Q8 diagnostic record');
  }
  exactNames({ actual: record.fields.map(field => field.name), expected: names });
  if (new Set(record.fields.map(field => field.id)).size !== record.fields.length) {
    throw new Error('Duplicate Q8 diagnostic field ID');
  }
  const size = safeNumber({ value: access.recordSize({ recordId: record.id }) });
  const alignment = safeNumber({ value: access.recordAlignment({ recordId: record.id }) });
  if (!size || size > 4096 || alignment < 4 || alignment > 16 || (alignment & (alignment - 1)) || size % alignment) {
    throw new Error('Unsupported Q8 diagnostic record layout');
  }
  const fields = new Map<string, Readonly<{ offset: number, size: number }>>();
  for (const field of record.fields) {
    const array = field.name === 'shader_sha256';
    const offset = safeNumber({ value: access.fieldOffset({ recordId: record.id, fieldId: field.id }) });
    const fieldSize = safeNumber({ value: access.fieldSize({ recordId: record.id, fieldId: field.id }) });
    if (field.cType !== (array ? 'uint8_t[32]' : 'uint32_t') || field.kind !== (array ? 'array' : 'unsigned')
      || fieldSize !== (array ? 32 : 4) || (!array && offset % 4) || offset > size || fieldSize > size - offset
      || [...fields.values()].some(other => offset < other.offset + other.size && other.offset < offset + fieldSize)) {
      throw new Error('Invalid Q8 diagnostic field layout');
    }
    fields.set(field.name, Object.freeze({ offset, size: fieldSize }));
  }
  return Object.freeze({ size, alignment, fields });
}

export async function createQ8KernelDiagnosticAdapter({ schemaBytes, access }: { schemaBytes: Uint8Array, access: Q8DiagnosticAccess }): Promise<Q8KernelDiagnosticAdapter> {
  access.assertIdle();
  // Copy before the hash await: callers cannot mutate a validated schema while
  // digest() is pending. ASCII matches the generator's ensure_ascii contract.
  const snapshot = new Uint8Array(schemaBytes);
  if (!snapshot.length || snapshot.length > 256 * 1024 || snapshot.some(byte => byte > 0x7f)) {
    throw new Error('Invalid Q8 diagnostic schema bytes');
  }
  const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot)));
  const schema = extensionSchema.parse(raw);
  validateFunctions({ schema });
  exactNames({ actual: schema.records.map(record => record.name), expected: [requestName, reportName] });
  if (new Set(schema.records.map(record => record.id)).size !== schema.records.length) {
    throw new Error('Duplicate Q8 diagnostic record ID');
  }
  delete raw.schemaSha256;
  const digest = hex({ bytes: new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(raw, undefined, 2) + '\n'))) });
  access.assertIdle();
  if (digest !== schema.schemaSha256) {
    throw new Error('Q8 diagnostic canonical schema mismatch');
  }
  const compiled = new TextDecoder('utf-8', { fatal: true }).decode(access.bytes({ pointer: BigInt(access.schemaHash()), length: 64 }));
  if (compiled !== digest) {
    throw new Error('Q8 diagnostic compiled schema mismatch');
  }
  const constantNames = [...Object.values(variantConstants), ...Object.values(phaseConstants), ...Object.values(statusConstants), ...Object.values(algorithmConstants),
    'VERSION', 'K_MIN', 'K_MAX', 'M_MIN', 'M_MAX', 'WEIGHT_BYTES_MAX', 'REPETITIONS_MAX'].map(name => `GGML_WEBGPU_Q8_DIAGNOSTIC_${name}_V1`);
  exactNames({ actual: schema.constants, expected: constantNames });
  const constants = new Map(schema.constants.map((name, id) => [name, safeNumber({ value: access.constant({ id }) })]));
  const constant = ({ name }: { name: string }): number => {
    const value = constants.get(`GGML_WEBGPU_Q8_DIAGNOSTIC_${name}_V1`);
    if (value === undefined) {
      throw new Error('Missing Q8 diagnostic constant');
    }
    return value;
  };
  for (const family of [variantConstants, phaseConstants, statusConstants, algorithmConstants]) {
    const values = Object.values(family).map(name => constant({ name }));
    if (new Set(values).size !== values.length) {
      throw new Error('Duplicate Q8 diagnostic enum value');
    }
  }
  if (constant({ name: 'VERSION' }) !== 1 || !constant({ name: 'REPETITIONS_MAX' }) || constant({ name: 'REPETITIONS_MAX' }) > 128) {
    throw new Error('Unsupported Q8 diagnostic bounds');
  }
  const request = readLayout({ schema, name: requestName, names: requestFields, access });
  const report = readLayout({ schema, name: reportName, names: reportFields, access });
  const getU32 = ({ owner, pointer, layout, name }: { owner: DiagnosticOwner, pointer: bigint, layout: RecordLayout, name: string }): number => {
    const field = layout.fields.get(name)!;
    const bytes = owner.bytes({ pointer: pointer + BigInt(field.offset), length: field.size });
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  };
  const setU32 = ({ owner, pointer, name, value }: { owner: DiagnosticOwner, pointer: bigint, name: string, value: number }): void => {
    const field = request.fields.get(name)!;
    const bytes = owner.bytes({ pointer: pointer + BigInt(field.offset), length: field.size });
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, value, true);
  };
  const findEnum = <T extends Record<string, string>>({ family, value }: { family: T, value: number }): keyof T => {
    const entry = Object.entries(family).find(([, name]) => constant({ name }) === value);
    if (!entry) {
      throw new Error('Unknown Q8 diagnostic result');
    }
    return entry[0];
  };
  return Object.freeze<Q8KernelDiagnosticAdapter>({
    async run({ backend, dst, variant, phase, repetitions }) {
      access.assertIdle();
      const pointer = z.bigint().positive().max((1n << 64n) - 1n);
      pointer.parse(backend);
      pointer.parse(dst);
      const variantName = z.enum(Object.keys(variantConstants) as [Q8KernelDiagnosticVariant, ...Q8KernelDiagnosticVariant[]]).parse(variant);
      const phaseName = z.enum(['prepare', 'execute']).parse(phase);
      u32.parse(repetitions);
      if ((phaseName === 'prepare' && repetitions !== 0) || (phaseName === 'execute' && (!repetitions || repetitions > constant({ name: 'REPETITIONS_MAX' })))) {
        throw new RangeError('Invalid Q8 diagnostic repetitions');
      }
      return access.withAccess({
        operation: async ({ owner }) => {
          let requestPointer: bigint | undefined;
          let reportPointer: bigint | undefined;
          let invoked = false;
          const perform = async (): Promise<Q8KernelDiagnosticResult> => {
            try {
              const version = owner.version({ backend });
              if (version !== 0 && version !== 1) {
                owner.poison();
                throw new Error('Unsupported Q8 diagnostic backend version');
              }
              requestPointer = owner.allocate({ length: request.size });
              if (requestPointer === undefined) {
                throw new Error('Q8 diagnostic allocation failed');
              }
              reportPointer = owner.allocate({ length: report.size });
              if (reportPointer === undefined) {
                throw new Error('Q8 diagnostic allocation failed');
              }
              if (requestPointer % BigInt(request.alignment) || reportPointer % BigInt(report.alignment)) {
                throw new Error('Misaligned Q8 diagnostic allocation');
              }
              owner.bytes({ pointer: requestPointer, length: request.size }).fill(0);
              owner.bytes({ pointer: reportPointer, length: report.size }).fill(0);
              for (const [name, value] of Object.entries({ abi_version: 1, struct_size: request.size, variant: constant({ name: variantConstants[variantName] }), phase: constant({ name: phaseConstants[phaseName] }), repetitions, reserved: 0 })) {
                setU32({ owner, pointer: requestPointer, name, value });
              }
              const started = performance.now();
              invoked = true;
              const result = await owner.invoke({ backend, dst, request: requestPointer, report: reportPointer, capacity: report.size });
              const nativeWallMs = performance.now() - started;
              // No heap/DataView survives the suspension. A resolved value still
              // needs a complete, trustworthy report before records can be freed.
              try {
                const values = Object.fromEntries(reportFields.filter(name => name !== 'shader_sha256').map(name => [name, getU32({ owner, pointer: reportPointer!, layout: report, name })]));
                const read = ({ name }: { name: Exclude<typeof reportFields[number], 'shader_sha256'> }) => u32.parse(values[name]);
                const status = findEnum({ family: statusConstants, value: read({ name: 'status' }) });
                const algorithm = findEnum({ family: algorithmConstants, value: read({ name: 'actual_algorithm' }) });
                if (typeof result !== 'number' || result !== read({ name: 'status' }) || read({ name: 'abi_version' }) !== 1 || read({ name: 'struct_size' }) !== report.size
                  || read({ name: 'reserved' }) !== 0 || read({ name: 'shader_identity_id' }) !== 0 || read({ name: 'requested_variant' }) !== constant({ name: variantConstants[variantName] })
                  || read({ name: 'phase' }) !== constant({ name: phaseConstants[phaseName] }) || (version === 0 && status !== 'unavailable')
                  || (status === 'not-prepared' && phaseName === 'prepare')) {
                  throw new Error('Invalid Q8 diagnostic report header');
                }
                const shaField = report.fields.get('shader_sha256')!;
                const digest = owner.bytes({ pointer: reportPointer + BigInt(shaField.offset), length: shaField.size });
                const shaderSha256 = digest.some(byte => byte !== 0) ? hex({ bytes: digest }) : undefined;
                const dispatches = read({ name: 'dispatches' });
                const shaped = status === 'ok' || status === 'not-prepared';
                if (shaped) {
                  const wg = read({ name: 'workgroup_size' }), sg = read({ name: 'logical_subgroup_size' }), rows = read({ name: 'rows_per_tile' });
                  const minimum = read({ name: 'real_min_subgroup_size' }), maximum = read({ name: 'real_max_subgroup_size' });
                  if (wg < 32 || wg > 256 || (wg & (wg - 1)) || ![1, 2, 4].includes(rows) || minimum > maximum
                    || !read({ name: 'grid_x' }) || !read({ name: 'grid_y' }) || read({ name: 'grid_z' }) !== 1 || read({ name: 'codegen_revision' }) !== 1
                    || read({ name: 'cooperative_subgroup_reduction' }) > 1) {
                    throw new Error('Invalid Q8 diagnostic launch report');
                  }
                  switch (algorithm) {
                  case 'none': throw new Error('Missing Q8 diagnostic algorithm');
                  case 'independent':
                    if (wg !== 128 || sg < 4 || sg > 64 || (sg & (sg - 1)) || sg !== minimum || sg !== maximum
                    || read({ name: 'cooperative_subgroup_reduction' }) !== 0 || read({ name: 'outputs_per_workgroup' }) !== rows * wg / sg) {
                      throw new Error('Invalid Q8 diagnostic independent launch');
                    }
                    break;
                  case 'cooperative':
                    if (sg !== 0 || read({ name: 'outputs_per_workgroup' }) !== rows) {
                      throw new Error('Invalid Q8 diagnostic cooperative launch');
                    }
                    break;
                  default: {
                    const exhaustive: never = algorithm;
                    throw new Error(`Unhandled Q8 diagnostic algorithm: ${exhaustive}`);
                  }
                  }
                  const forced = forcedLaunches[variantName];
                  if (forced && (algorithm !== forced.algorithm || wg !== forced.workgroup || rows !== forced.rows)) {
                    throw new Error('Q8 diagnostic forced variant mismatch');
                  }
                } else if (reportFields.slice(5).filter(name => name !== 'shader_sha256').some(name => read({ name }) !== 0)) {
                  throw new Error('Unexpected Q8 diagnostic failure metadata');
                }
                if (dispatches !== (status === 'ok' && phaseName === 'execute' ? repetitions : 0) || (status === 'ok') !== (shaderSha256 !== undefined)) {
                  throw new Error('Invalid Q8 diagnostic dispatch count or digest');
                }
                return Object.freeze({
                  status,
                  variant: variantName,
                  phase: phaseName,
                  algorithm,
                  workgroupSize: read({ name: 'workgroup_size' }),
                  logicalSubgroupSize: read({ name: 'logical_subgroup_size' }),
                  realMinSubgroupSize: read({ name: 'real_min_subgroup_size' }),
                  realMaxSubgroupSize: read({ name: 'real_max_subgroup_size' }),
                  rowsPerTile: read({ name: 'rows_per_tile' }),
                  outputsPerWorkgroup: read({ name: 'outputs_per_workgroup' }),
                  cooperativeSubgroupReduction: read({ name: 'cooperative_subgroup_reduction' }) === 1,
                  grid: Object.freeze({ x: read({ name: 'grid_x' }), y: read({ name: 'grid_y' }), z: read({ name: 'grid_z' }) }),
                  dispatches,
                  codegenRevision: read({ name: 'codegen_revision' }),
                  shaderSha256,
                  nativeWallMs,
                });
              } catch (error) {
                owner.poison();
                throw error;
              }
            } catch (error) {
              if (invoked) {
                owner.poison();
              }
              if (!owner.isHealthy()) {
                throw new Q8KernelDiagnosticFatalError({ cause: error });
              }
              throw error;
            }
          };
          let completed: Q8KernelDiagnosticResult | undefined;
          let failure: { error: unknown } | undefined;
          try {
            completed = await perform();
          } catch (error) {
            failure = { error };
          }
          if (owner.isHealthy()) {
            try {
              if (reportPointer !== undefined) {
                owner.free({ pointer: reportPointer });
              }
              if (requestPointer !== undefined) {
                owner.free({ pointer: requestPointer });
              }
            } catch (error) {
              owner.poison();
              throw new Q8KernelDiagnosticFatalError({ cause: error });
            }
          }
          if (failure) {
            throw failure.error;
          }
          if (!completed) {
            throw new Error('Missing Q8 diagnostic result');
          }
          return completed;
        },
      });
    },
  });
}

export const TEST_ONLY = {
};
