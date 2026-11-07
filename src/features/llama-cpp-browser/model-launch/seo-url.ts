export const MODEL_SEO_PREFIX = '/llama-cpp-browser/';

// Public paths deliberately support the repository/quantization subset only.
// Nested file selectors remain supported by the existing fragment entry point.
export function modelSeoPath({ modelId }: { modelId: string }): string {
  const match = /^hf\.co\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(modelId);
  if (!match) {
    throw new Error(`Invalid public model ID: ${modelId}`);
  }
  return `${MODEL_SEO_PREFIX}${modelId}/`;
}

/** Decode one time, before allowlist lookup; never use this to resolve files. */
export function modelIdFromSeoPath({ pathname }: { pathname: string }): string | undefined {
  if (!pathname.startsWith(MODEL_SEO_PREFIX)) {
    return undefined;
  }
  const rest = pathname.slice(MODEL_SEO_PREFIX.length).replace(/\/$/, '');
  const segments = rest.split('/');
  if (segments.length !== 3) {
    return undefined;
  }
  try {
    const decoded = segments.map(segment => decodeURIComponent(segment));
    if (decoded.some(segment => /[/%\\]/.test(segment))) {
      return undefined;
    }
    const modelId = decoded.join('/');
    modelSeoPath({ modelId });
    return modelId;
  } catch {
    return undefined;
  }
}

export const TEST_ONLY = {
};
