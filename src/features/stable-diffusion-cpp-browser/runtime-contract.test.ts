import { expect, it } from 'vitest';
import { assertImageRuntimeContract } from './runtime-contract';
import { imageRuntimeSchemaFixture } from './test-utils/runtime-schema.test-support';

it('accepts the new generated contract and permits unrelated public additions', () => {
  const schema = imageRuntimeSchemaFixture();
  schema.functions.push({ name: 'additional_api', returnType: 'void', returnKind: 'void', parameters: [] });
  schema.records[0]!.fields.push({ name: 'additional_setting', kind: 'boolean', cType: 'bool' });
  expect(() => assertImageRuntimeContract({ schema })).not.toThrow();
});

it('requires the optional retention version signature only when the verified feature is advertised', () => {
  const schema = imageRuntimeSchemaFixture();
  expect(() => assertImageRuntimeContract({ schema, bf16WeightRetention: false })).not.toThrow();
  expect(() => assertImageRuntimeContract({ schema, bf16WeightRetention: true })).toThrow('sd_browser_bf16_retention_version');
  const getter = { name: 'sd_browser_bf16_retention_version', returnType: 'uint32_t', returnKind: 'unsigned', parameters: [] };
  schema.functions.push(getter);
  expect(() => assertImageRuntimeContract({ schema, bf16WeightRetention: true })).not.toThrow();
  getter.returnKind = 'signed';
  expect(() => assertImageRuntimeContract({ schema, bf16WeightRetention: true })).toThrow('incompatible upstream function: sd_browser_bf16_retention_version');
});

it('rejects the old four-argument result API even though it uses ABI 2', () => {
  const schema = imageRuntimeSchemaFixture();
  const generate = schema.functions.find(entry => entry.name === 'generate_image')!;
  generate.parameters[2]!.cType = 'sd_image_t **';
  generate.parameters.push({ kind: 'pointer', cType: 'int *' });
  expect(() => assertImageRuntimeContract({ schema })).toThrow('incompatible upstream function: generate_image');
});

it('requires the owner-specific free instead of the legacy image-array free', () => {
  const schema = imageRuntimeSchemaFixture();
  schema.functions = schema.functions.filter(entry => entry.name !== 'free_sd_image_generation_result');
  schema.functions.push({ name: 'free_sd_images', returnKind: 'void', returnType: 'void', parameters: [{ kind: 'pointer', cType: 'sd_image_t *' }, { kind: 'signed', cType: 'int' }] });
  expect(() => assertImageRuntimeContract({ schema })).toThrow('missing a required upstream function: free_sd_image_generation_result');
});

it.each([
  ['sd_image_generation_result_t', 'items', 'pointer', 'sd_image_t *'],
  ['sd_image_generation_result_t', 'count', 'unsigned', 'uint32_t'],
  ['sd_image_result_t', 'image', 'pointer', 'sd_image_t *'],
  ['sd_image_result_t', 'generation_info', 'record', 'sd_image_t'],
  ['sd_tiling_params_t', 'tile_size_w', 'unsigned', 'uint32_t'],
  ['sd_generation_progress_t', 'completed', 'signed', 'int'],
  ['sd_ctx_params_t', 'batched_cfg', 'signed', 'int'],
  ['sd_ctx_params_t', 'flash_attn_mode', 'boolean', 'bool'],
] as const)('rejects incompatible %s.%s fields', (record, name, kind, cType) => {
  const schema = imageRuntimeSchemaFixture();
  Object.assign(schema.records.find(entry => entry.name === record)!.fields.find(field => field.name === name)!, { kind, cType });
  expect(() => assertImageRuntimeContract({ schema })).toThrow('incompatible record field: ' + record + '.' + name);
});

it('rejects legacy tile fields and missing result records', () => {
  const schema = imageRuntimeSchemaFixture();
  schema.records.find(entry => entry.name === 'sd_tiling_params_t')!.fields.find(field => field.name === 'tile_size_w')!.name = 'tile_size_x';
  expect(() => assertImageRuntimeContract({ schema })).toThrow('incompatible record field: sd_tiling_params_t.tile_size_w');
  schema.records = schema.records.filter(entry => entry.name !== 'sd_image_result_t');
  expect(() => assertImageRuntimeContract({ schema })).toThrow('missing a required record: sd_image_result_t');
});

it('rejects duplicate declarations instead of using an ambiguous record or signature', () => {
  const schema = imageRuntimeSchemaFixture();
  schema.functions.push({ ...schema.functions[0]! });
  expect(() => assertImageRuntimeContract({ schema })).toThrow('duplicate generated function or record names');
  schema.functions.pop();
  schema.records[0]!.fields.push({ ...schema.records[0]!.fields[0]! });
  expect(() => assertImageRuntimeContract({ schema })).toThrow('duplicate generated field names');
});

it.each([undefined, {}, { abiVersion: 1 }, { ...imageRuntimeSchemaFixture(), pointerRepresentation: 'number' }])('rejects malformed or incompatible schema values', schema => {
  expect(() => assertImageRuntimeContract({ schema })).toThrow('incompatible generated API schema');
});
