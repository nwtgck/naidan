// Public error-origin contract of Naidan's Transformers.js Vite fixes.
// Error.name survives Comlink; constructor identity and custom fields do not.
export const TRANSFORMERS_JS_OPTIONAL_CONFIGURATION_ERROR_NAME = 'TransformersJsOptionalConfigurationError';

export function isTransformersJsOptionalConfigurationError({ error }: { error: unknown }): boolean {
  return error instanceof Error && error.name === TRANSFORMERS_JS_OPTIONAL_CONFIGURATION_ERROR_NAME;
}

export const TEST_ONLY = {
};
