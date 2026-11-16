/** Metadata-only protocol fixture. It never claims a compiled target. */
export const diagnosticPrefix = '_lcb_webgpu_q8_diagnostic_';
const constantPrefix = 'GGML_WEBGPU_Q8_DIAGNOSTIC_';
export const diagnosticConstants = {
  AUTO: 0,
  COOPERATIVE_WG256_R4: 1,
  INDEPENDENT_WG128_R4: 2,
  INDEPENDENT_WG128_R1: 3,
  INDEPENDENT_WG128_R2: 4,
  COOPERATIVE_WG128_R2: 5,
  PREPARE: 1,
  EXECUTE: 2,
  OK: 0,
  UNAVAILABLE: 1,
  BAD_REQUEST: 2,
  UNSUPPORTED: 3,
  NOT_PREPARED: 4,
  BUSY: 5,
  ALGORITHM_NONE: 0,
  ALGORITHM_COOPERATIVE: 1,
  ALGORITHM_INDEPENDENT: 2,
  VERSION: 1,
  K_MIN: 32,
  K_MAX: 16384,
  M_MIN: 1,
  M_MAX: 65536,
  WEIGHT_BYTES_MAX: 67108864,
  REPETITIONS_MAX: 128,
} as const;
export const diagnosticReportFields = ['abi_version', 'struct_size', 'status', 'requested_variant', 'phase', 'actual_algorithm', 'workgroup_size', 'logical_subgroup_size', 'real_min_subgroup_size', 'real_max_subgroup_size', 'rows_per_tile', 'outputs_per_workgroup', 'cooperative_subgroup_reduction', 'grid_x', 'grid_y', 'grid_z', 'dispatches', 'codegen_revision', 'shader_identity_id', 'reserved', 'shader_sha256'];
export const diagnosticRequestFields = ['abi_version', 'struct_size', 'variant', 'phase', 'repetitions', 'reserved'];

export function diagnosticSchemaFixture() {
  const record = ({ name, id, names }: { name: string, id: number, names: string[] }) => ({
    name,
    cType: 'struct ' + name,
    size: name.endsWith('report_v1') ? 112 : 24,
    alignment: 4,
    fields: names.map((name, id) => ({
      id,
      name,
      cType: name === 'shader_sha256' ? 'uint8_t[32]' : 'uint32_t',
      kind: name === 'shader_sha256' ? 'array' : 'unsigned',
      abiType: name === 'shader_sha256' ? { kind: 'array', dimensions: [32] } : { kind: 'integer', bits: 32, signed: false },
      offset: id * 4,
      size: name === 'shader_sha256' ? 32 : 4,
    })),
    id,
  });
  return {
    version: 1,
    abiVersion: 1,
    extensionId: 'webgpu-q8-diagnostic-v1',
    baseAbiVersion: 3,
    pointerRepresentation: 'bigint_u64',
    versionExport: diagnosticPrefix + 'version',
    schemaHashExport: diagnosticPrefix + 'schema_hash',
    suspension: 'jspi',
    functions: [
      {
        name: 'lcb_webgpu_q8_diagnostic_run_v1',
        export: diagnosticPrefix + 'run_v1',
        returnType: 'int32_t',
        returnKind: 'signed',
        abiType: { kind: 'integer', bits: 32, signed: true },
        bridge: false,
        parameters: ['backend', 'dst', 'request', 'report', 'report_capacity'].map((name, index) => ({
          name,
          cType: index === 4 ? 'uint32_t' : 'uint64_t',
          kind: index === 4 ? 'unsigned' : 'u64',
          abiType: { kind: 'integer', bits: index === 4 ? 32 : 64, signed: false },
        })),
      },
      {
        name: 'lcb_webgpu_q8_diagnostic_version',
        export: diagnosticPrefix + 'version',
        returnType: 'uint32_t',
        returnKind: 'unsigned',
        abiType: { kind: 'integer', bits: 32, signed: false },
        bridge: false,
        parameters: [{ name: 'backend', cType: 'uint64_t', kind: 'u64', abiType: { kind: 'integer', bits: 64, signed: false } }],
      },
    ],
    records: [record({ name: 'ggml_webgpu_q8_diagnostic_report_v1', id: 0, names: diagnosticReportFields }), record({ name: 'ggml_webgpu_q8_diagnostic_request_v1', id: 1, names: diagnosticRequestFields })],
    constants: Object.keys(diagnosticConstants).map(name => constantPrefix + name + '_V1').sort(),
    constantValues: Object.fromEntries(Object.entries(diagnosticConstants).map(([name, value]) => [constantPrefix + name + '_V1', String(value)])),
  };
}
