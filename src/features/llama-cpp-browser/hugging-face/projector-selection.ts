// A fixed preference order, independent of device capabilities or repository order.
export const quantizationPreference = ['Q4_K_M', 'Q4_K_S', 'Q4_0', 'Q4_1', 'IQ4_NL', 'IQ4_XS', 'MXFP4', 'NVFP4', 'Q5_K_M', 'Q5_K_S', 'Q5_0', 'Q5_1', 'IQ5_XS', 'Q6_K', 'IQ6_K', 'Q8_0', 'Q8_1', 'Q3_K_M', 'Q3_K_L', 'Q3_K_S', 'IQ3_M', 'IQ3_S', 'IQ3_XS', 'IQ3_XXS', 'Q2_K', 'IQ2_M', 'IQ2_S', 'IQ2_XS', 'IQ2_XXS', 'IQ1_M', 'IQ1_S', 'BF16', 'F16', 'F32'];

export function quantizationName({ path }: { path: string }): string | undefined {
  const name = (path.split('/').at(-1) ?? '').toUpperCase();
  // Read the entire token, including extensions such as Q4_K_XL. A prefix
  // match must never silently turn a new scheme into a familiar quantization.
  const matches = [...name.matchAll(/(?:^|[-_.])((?:(?:I?Q|PQ|P?TQ)[1-8](?:_[A-Z0-9]+)+|(?:MXFP|NVFP)[0-9]+|BF16|F16|F32))(?=[-.]|$)/g)];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function lexical({ left, right }: { left: string, right: string }): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function projectorFamily({ path }: { path: string }): string {
  const quantization = quantizationName({ path });
  const normalized = path.toLowerCase().replace(/\.gguf$/i, '');
  return quantization === undefined ? normalized : normalized.replace(new RegExp(`(?:^|[-_.])${quantization.toLowerCase()}(?=[-.]|$)`), '').replace(/[-_.]+$/g, '');
}

export function rankedProjectors<T extends { path: string }>({ files }: { files: T[] }): T[] {
  const preference = ['Q8_0', 'F16', 'BF16', 'F32', 'Q8_1', ...quantizationPreference];
  const rank = ({ path }: { path: string }): number => {
    const quantization = quantizationName({ path });
    return quantization === undefined || !preference.includes(quantization) ? preference.length : preference.indexOf(quantization);
  };
  return [...files].sort((a, b) => rank(a) - rank(b) || lexical({ left: a.path, right: b.path }));
}

export function preferredProjector<T extends { path: string }>({ files }: { files: readonly T[] }): T | undefined {
  if (files.length === 1) {
    return files[0];
  }
  if (!files.length || new Set(files.map(file => projectorFamily({ path: file.path }))).size !== 1) {
    return undefined;
  }
  const preference = ['Q8_0', 'F16', 'BF16', 'F32', 'Q8_1', ...quantizationPreference];
  const ranked = files.map(file => ({ file, quantization: quantizationName({ path: file.path }) }));
  if (ranked.some(entry => entry.quantization === undefined || !preference.includes(entry.quantization))) {
    return undefined;
  }
  ranked.sort((a, b) => preference.indexOf(a.quantization!) - preference.indexOf(b.quantization!));
  if (ranked[0]?.quantization === ranked[1]?.quantization) {
    return undefined;
  }
  return ranked[0]?.file;
}

export const TEST_ONLY = {
};
