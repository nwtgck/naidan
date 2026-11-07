export const MODEL_PAGE_PREFIX = '/llama-cpp-browser/';

export type ModelPageRequest =
  | Readonly<{ kind: 'outside' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'model', modelId: string, repository: string, quantization: string | undefined, launchInput: string }>;

/** The model namespace is relative to the hosted app, including ZIP mounts. */
export function modelPageLocation({ pathname }: { pathname: string }): Readonly<{ appBase: string, pathname: string }> | undefined {
  let index = pathname.indexOf(MODEL_PAGE_PREFIX);
  if (index < 0 && pathname.endsWith(MODEL_PAGE_PREFIX.slice(0, -1))) {
    index = pathname.length - MODEL_PAGE_PREFIX.length + 1;
  }
  if (index < 0 || !pathname.startsWith('/')) {
    return undefined;
  }
  const appBase = pathname.slice(0, index + 1);
  if (appBase.startsWith('//') || appBase.includes('\\')) {
    return undefined;
  }
  return { appBase, pathname: pathname.slice(index) };
}

export function isModelPagePath({ pathname }: { pathname: string }): boolean {
  return modelPageLocation({ pathname }) !== undefined;
}

// Public paths identify repositories, not model files. File selectors still use
// the existing fragment entry. This module is also loaded without app aliases.
export function modelPagePath({ modelId }: { modelId: string }): string {
  if (!/^hf\.co\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(modelId)
    || modelId.length > 512 || modelId.split('/').some(segment => segment.length > 255)) {
    throw new Error(`Invalid public model ID: ${modelId}`);
  }
  return `${MODEL_PAGE_PREFIX}${modelId}/`;
}

/** Decode exactly once. Never use a request path to resolve filesystem paths. */
export function modelIdFromPagePath({ pathname }: { pathname: string }): string | undefined {
  const location = modelPageLocation({ pathname });
  if (location === undefined || !location.pathname.startsWith(MODEL_PAGE_PREFIX)) {
    return undefined;
  }
  const segments = location.pathname.slice(MODEL_PAGE_PREFIX.length).replace(/\/$/, '').split('/');
  if (segments.length !== 3) {
    return undefined;
  }
  try {
    const decoded = segments.map(segment => decodeURIComponent(segment));
    if (decoded.some(segment => /[/%\\]/.test(segment))) {
      return undefined;
    }
    const modelId = decoded.join('/');
    modelPagePath({ modelId });
    return modelId;
  } catch {
    return undefined;
  }
}

function isQuantization({ value }: { value: string }): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Human-facing links omit the slash; static hosting may add it on arrival. */
export function modelPageHref({ modelId, quantization }: { modelId: string, quantization: string | undefined }): string {
  if (quantization !== undefined && !isQuantization({ value: quantization })) {
    throw new Error('Invalid model page quantization');
  }
  const pathname = modelPagePath({ modelId }).slice(0, -1);
  return quantization === undefined ? pathname : `${pathname}?${new URLSearchParams({ quant: quantization })}`;
}

/** Only quant is an instruction. Outer q/settings/model parameters are not. */
export function readModelPageRequest({ pathname, search }: { pathname: string, search: string }): ModelPageRequest {
  if (!isModelPagePath({ pathname })) {
    return { kind: 'outside' };
  }
  const modelId = modelIdFromPagePath({ pathname });
  const quantizations = new URLSearchParams(search).getAll('quant');
  const quantization = quantizations[0];
  if (modelId === undefined || quantizations.length > 1
    || (quantization !== undefined && !isQuantization({ value: quantization }))) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'model',
    modelId,
    repository: modelId.slice('hf.co/'.length),
    quantization,
    launchInput: quantization === undefined ? modelId : `${modelId}:${quantization}`,
  };
}

export const TEST_ONLY = {
};
