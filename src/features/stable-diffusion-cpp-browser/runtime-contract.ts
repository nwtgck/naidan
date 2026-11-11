import { z } from 'zod';

const valueSchema = z.object({ kind: z.string(), cType: z.string() });
const runtimeSchema = z.object({
  abiVersion: z.literal(2),
  pointerRepresentation: z.literal('bigint-u64'),
  functions: z.array(z.object({
    name: z.string(),
    returnType: z.string(),
    returnKind: z.string(),
    parameters: z.array(valueSchema),
  })),
  records: z.array(z.object({ name: z.string(), fields: z.array(valueSchema.extend({ name: z.string() })) })),
});

type ValueContract = readonly [kind: string, cType: string];
const functions = {
  sd_ctx_params_init: ['void', 'void', [['pointer', 'sd_ctx_params_t *']]],
  sd_img_gen_params_init: ['void', 'void', [['pointer', 'sd_img_gen_params_t *']]],
  new_sd_ctx: ['pointer', 'sd_ctx_t *', [['pointer', 'const sd_ctx_params_t *']]],
  free_sd_ctx: ['void', 'void', [['pointer', 'sd_ctx_t *']]],
  generate_image: ['boolean', 'bool', [['pointer', 'sd_ctx_t *'], ['pointer', 'const sd_img_gen_params_t *'], ['pointer', 'sd_image_generation_result_t **']]],
  free_sd_image_generation_result: ['void', 'void', [['pointer', 'sd_image_generation_result_t *']]],
  sd_get_model_version_name: ['pointer', 'const char *', [['pointer', 'const sd_ctx_t *']]],
  sd_get_default_sample_method: ['signed', 'enum sample_method_t', [['pointer', 'const sd_ctx_t *']]],
  sd_get_default_scheduler: ['signed', 'enum scheduler_t', [['pointer', 'const sd_ctx_t *'], ['signed', 'enum sample_method_t']]],
  sd_cancel_generation: ['void', 'void', [['pointer', 'sd_ctx_t *'], ['signed', 'enum sd_cancel_mode_t']]],
  sd_set_log_callback: ['void', 'void', [['pointer', 'sd_log_cb_t'], ['pointer', 'void *']]],
  sd_set_graph_diagnostics: ['void', 'void', [['boolean', 'bool']]],
  sd_set_progress_callback: ['void', 'void', [['pointer', 'sd_progress_cb_t'], ['pointer', 'void *']]],
  sd_set_generation_progress_callback: ['void', 'void', [['pointer', 'sd_ctx_t *'], ['pointer', 'sd_generation_progress_cb_t'], ['pointer', 'void *']]],
  sd_set_preview_callback: ['void', 'void', [['pointer', 'sd_preview_cb_t'], ['signed', 'enum preview_t'], ['signed', 'int'], ['boolean', 'bool'], ['boolean', 'bool'], ['pointer', 'void *']]],
  sd_get_preview_info: ['record', 'sd_preview_info_t', []],
  sd_ctx_supports_image_generation: ['boolean', 'bool', [['pointer', 'const sd_ctx_t *']]],
  str_to_sample_method: ['signed', 'enum sample_method_t', [['pointer', 'const char *']]],
  str_to_scheduler: ['signed', 'enum scheduler_t', [['pointer', 'const char *']]],
} as const satisfies Record<string, readonly [returnKind: string, returnType: string, parameters: readonly ValueContract[]]>;

const optionalFunctions = {
  sd_sample_method_name: ['pointer', 'const char *', [['signed', 'enum sample_method_t']]],
  sd_scheduler_name: ['pointer', 'const char *', [['signed', 'enum scheduler_t']]],
} as const satisfies Record<string, readonly [returnKind: string, returnType: string, parameters: readonly ValueContract[]]>;

const records = {
  sd_ctx_params_t: {
    webgpu_bf16_type: ['signed', 'enum sd_type_t'],
    batched_cfg: ['boolean', 'bool'],
    flash_attn_mode: ['pointer', 'const char *'],
    conv_direct_mode: ['pointer', 'const char *'],
  },
  sd_img_gen_params_t: {
    sample_params: ['record', 'sd_sample_params_t'],
    vae_tiling_params: ['record', 'sd_tiling_params_t'],
  },
  sd_image_generation_result_t: { items: ['pointer', 'sd_image_result_t *'], count: ['signed', 'int'] },
  sd_image_result_t: { image: ['record', 'sd_image_t'], generation_info: ['pointer', 'char *'] },
  sd_image_t: {
    width: ['unsigned', 'uint32_t'],
    height: ['unsigned', 'uint32_t'],
    channel: ['unsigned', 'uint32_t'],
    data: ['pointer', 'uint8_t *'],
  },
  sd_sample_params_t: {
    sample_method: ['signed', 'enum sample_method_t'],
    scheduler: ['signed', 'enum scheduler_t'],
    sample_steps: ['signed', 'int'],
    guidance: ['record', 'sd_guidance_params_t'],
  },
  sd_guidance_params_t: { txt_cfg: ['float', 'float'], distilled_guidance: ['float', 'float'] },
  sd_tiling_params_t: {
    enabled: ['boolean', 'bool'],
    tile_size_w: ['signed', 'int'],
    tile_size_h: ['signed', 'int'],
    target_overlap: ['float', 'float'],
  },
  sd_generation_progress_t: {
    stage: ['pointer', 'const char *'],
    detail: ['pointer', 'const char *'],
    unit: ['pointer', 'const char *'],
    sample_pass: ['signed', 'int'],
    completed: ['i64', 'int64_t'],
    total: ['i64', 'int64_t'],
  },
  sd_preview_info_t: { sample_pass: ['signed', 'int'], total_steps: ['signed', 'int'] },
} as const satisfies Record<string, Record<string, ValueContract>>;

/** ABI 2 fixes the bridge convention; the generated upstream API also has to match the caller. */
export function assertImageRuntimeContract({ schema, bf16WeightRetention }: { schema: unknown, bf16WeightRetention?: boolean }): void {
  const parsed = runtimeSchema.safeParse(schema);
  if (!parsed.success) {
    throw new Error('Image core has an incompatible generated API schema', { cause: parsed.error });
  }
  const functionMap = new Map(parsed.data.functions.map(entry => [entry.name, entry]));
  const recordMap = new Map(parsed.data.records.map(entry => [entry.name, entry]));
  if (functionMap.size !== parsed.data.functions.length || recordMap.size !== parsed.data.records.length) {
    throw new Error('Image core has duplicate generated function or record names');
  }
  // Existing ABI-2 artifacts retain their F32/F16 contract. The new function
  // becomes mandatory only when their verified manifest advertises retention.
  const requiredFunctions = bf16WeightRetention ? {
    ...functions,
    sd_browser_bf16_retention_version: ['unsigned', 'uint32_t', []],
  } as const : functions;
  for (const [name, [returnKind, returnType, parameters]] of Object.entries({ ...requiredFunctions, ...optionalFunctions })) {
    const actual = functionMap.get(name);
    if (!actual) {
      // Old generated schemas can omit observational naming APIs.
      if (Object.hasOwn(optionalFunctions, name)) {
        continue;
      }
      throw new Error('Image core is missing a required upstream function: ' + name);
    }
    if (actual.returnKind !== returnKind || actual.returnType !== returnType || actual.parameters.length !== parameters.length
      || parameters.some(([kind, cType], index) => actual.parameters[index]?.kind !== kind || actual.parameters[index]?.cType !== cType)) {
      throw new Error('Image core has an incompatible upstream function: ' + name);
    }
  }
  for (const [name, fields] of Object.entries(records)) {
    const actual = recordMap.get(name);
    if (!actual) {
      throw new Error('Image core is missing a required record: ' + name);
    }
    const fieldMap = new Map(actual.fields.map(field => [field.name, field]));
    if (fieldMap.size !== actual.fields.length) {
      throw new Error('Image core has duplicate generated field names: ' + name);
    }
    for (const [field, [kind, cType]] of Object.entries(fields)) {
      const value = fieldMap.get(field);
      if (!value || value.kind !== kind || value.cType !== cType) {
        throw new Error('Image core has an incompatible record field: ' + name + '.' + field);
      }
    }
  }
}

export const TEST_ONLY = {
};
