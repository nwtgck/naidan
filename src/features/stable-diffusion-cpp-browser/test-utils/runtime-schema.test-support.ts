type Value = { kind: string, cType: string };

/** A small generated-header fixture, never a Wasm module or inference result. */
export function imageRuntimeSchemaFixture() {
  const signatures: [string, string, string, [string, string][]][] = [
    ['sd_ctx_params_init', 'void', 'void', [['pointer', 'sd_ctx_params_t *']]],
    ['sd_img_gen_params_init', 'void', 'void', [['pointer', 'sd_img_gen_params_t *']]],
    ['new_sd_ctx', 'pointer', 'sd_ctx_t *', [['pointer', 'const sd_ctx_params_t *']]],
    ['free_sd_ctx', 'void', 'void', [['pointer', 'sd_ctx_t *']]],
    ['generate_image', 'boolean', 'bool', [['pointer', 'sd_ctx_t *'], ['pointer', 'const sd_img_gen_params_t *'], ['pointer', 'sd_image_generation_result_t **']]],
    ['free_sd_image_generation_result', 'void', 'void', [['pointer', 'sd_image_generation_result_t *']]],
    ['sd_get_model_version_name', 'pointer', 'const char *', [['pointer', 'const sd_ctx_t *']]],
    ['sd_get_default_sample_method', 'signed', 'enum sample_method_t', [['pointer', 'const sd_ctx_t *']]],
    ['sd_get_default_scheduler', 'signed', 'enum scheduler_t', [['pointer', 'const sd_ctx_t *'], ['signed', 'enum sample_method_t']]],
    ['sd_cancel_generation', 'void', 'void', [['pointer', 'sd_ctx_t *'], ['signed', 'enum sd_cancel_mode_t']]],
    ['sd_set_log_callback', 'void', 'void', [['pointer', 'sd_log_cb_t'], ['pointer', 'void *']]],
    ['sd_set_graph_diagnostics', 'void', 'void', [['boolean', 'bool']]],
    ['sd_set_progress_callback', 'void', 'void', [['pointer', 'sd_progress_cb_t'], ['pointer', 'void *']]],
    ['sd_set_generation_progress_callback', 'void', 'void', [['pointer', 'sd_ctx_t *'], ['pointer', 'sd_generation_progress_cb_t'], ['pointer', 'void *']]],
    ['sd_set_preview_callback', 'void', 'void', [['pointer', 'sd_preview_cb_t'], ['signed', 'enum preview_t'], ['signed', 'int'], ['boolean', 'bool'], ['boolean', 'bool'], ['pointer', 'void *']]],
    ['sd_get_preview_info', 'record', 'sd_preview_info_t', []],
    ['sd_ctx_supports_image_generation', 'boolean', 'bool', [['pointer', 'const sd_ctx_t *']]],
    ['str_to_sample_method', 'signed', 'enum sample_method_t', [['pointer', 'const char *']]],
    ['str_to_scheduler', 'signed', 'enum scheduler_t', [['pointer', 'const char *']]],
  ];
  const layouts: [string, [string, string, string][]][] = [
    ['sd_ctx_params_t', [['webgpu_bf16_type', 'signed', 'enum sd_type_t'], ['batched_cfg', 'boolean', 'bool'], ['flash_attn_mode', 'pointer', 'const char *'], ['conv_direct_mode', 'pointer', 'const char *']]],
    ['sd_img_gen_params_t', [['sample_params', 'record', 'sd_sample_params_t'], ['vae_tiling_params', 'record', 'sd_tiling_params_t']]],
    ['sd_image_generation_result_t', [['items', 'pointer', 'sd_image_result_t *'], ['count', 'signed', 'int']]],
    ['sd_image_result_t', [['image', 'record', 'sd_image_t'], ['generation_info', 'pointer', 'char *']]],
    ['sd_image_t', [['width', 'unsigned', 'uint32_t'], ['height', 'unsigned', 'uint32_t'], ['channel', 'unsigned', 'uint32_t'], ['data', 'pointer', 'uint8_t *']]],
    ['sd_sample_params_t', [['sample_method', 'signed', 'enum sample_method_t'], ['scheduler', 'signed', 'enum scheduler_t'], ['sample_steps', 'signed', 'int'], ['guidance', 'record', 'sd_guidance_params_t']]],
    ['sd_guidance_params_t', [['txt_cfg', 'float', 'float'], ['distilled_guidance', 'float', 'float']]],
    ['sd_tiling_params_t', [['enabled', 'boolean', 'bool'], ['tile_size_w', 'signed', 'int'], ['tile_size_h', 'signed', 'int'], ['target_overlap', 'float', 'float']]],
    ['sd_generation_progress_t', [['stage', 'pointer', 'const char *'], ['detail', 'pointer', 'const char *'], ['unit', 'pointer', 'const char *'], ['sample_pass', 'signed', 'int'], ['completed', 'i64', 'int64_t'], ['total', 'i64', 'int64_t']]],
    ['sd_preview_info_t', [['sample_pass', 'signed', 'int'], ['total_steps', 'signed', 'int']]],
  ];
  return {
    abiVersion: 2,
    pointerRepresentation: 'bigint-u64',
    functions: signatures.map(([name, returnKind, returnType, parameters]) => ({
      name,
      returnKind,
      returnType,
      parameters: parameters.map(([kind, cType]): Value => ({ kind, cType })),
    })),
    records: layouts.map(([name, fields]) => ({ name, fields: fields.map(([name, kind, cType]) => ({ name, kind, cType })) })),
  };
}
