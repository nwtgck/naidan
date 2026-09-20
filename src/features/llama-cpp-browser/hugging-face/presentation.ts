import type { ModelCandidate } from './catalog';
import type { RepositoryFile } from './types';

// A fixed preference order, independent of device capabilities or repository order.
const quantizationPreference = ['Q4_K_M', 'Q4_K_S', 'Q4_0', 'Q4_1', 'IQ4_NL', 'IQ4_XS', 'MXFP4', 'NVFP4', 'Q5_K_M', 'Q5_K_S', 'Q5_0', 'Q5_1', 'IQ5_XS', 'Q6_K', 'IQ6_K', 'Q8_0', 'Q8_1', 'Q3_K_M', 'Q3_K_L', 'Q3_K_S', 'IQ3_M', 'IQ3_S', 'IQ3_XS', 'IQ3_XXS', 'Q2_K', 'IQ2_M', 'IQ2_S', 'IQ2_XS', 'IQ2_XXS', 'IQ1_M', 'IQ1_S', 'BF16', 'F16', 'F32'];
export type QuantizationChoice = { quantization: string | undefined, models: ModelCandidate[] };
export function quantizationName({ path }: { path: string }): string | undefined {
  const name = (path.split('/').at(-1) ?? '').toUpperCase();
  return quantizationPreference.find(quantization => new RegExp(`(?:^|[-_.])${quantization}(?=[-.]|$)`).test(name));
}
function lexical({ left, right }: { left: string, right: string }): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function quantizationChoices({ models }: { models: ModelCandidate[] }): QuantizationChoice[] {
  const groups = new Map<string | undefined, ModelCandidate[]>();
  for (const model of models) {
    const quantization = quantizationName({ path: model.files[0]?.path ?? model.label });
    const group = groups.get(quantization) ?? []; group.push(model); groups.set(quantization, group);
  }
  return [...groups].map(([quantization, variants]) => ({ quantization, models: variants.sort((a, b) => lexical({ left: a.label, right: b.label })) })).sort((a, b) => {
    const left = a.quantization === undefined ? quantizationPreference.length : quantizationPreference.indexOf(a.quantization);
    const right = b.quantization === undefined ? quantizationPreference.length : quantizationPreference.indexOf(b.quantization);
    return left - right;
  });
}
function projectorFamily({ path }: { path: string }): string {
  const quantization = quantizationName({ path });
  const normalized = path.toLowerCase().replace(/\.gguf$/i, '');
  return quantization === undefined ? normalized : normalized.replace(new RegExp(`(?:^|[-_.])${quantization.toLowerCase()}(?=[-.]|$)`), '').replace(/[-_.]+$/g, '');
}
export function preferredProjector({ files }: { files: RepositoryFile[] }): RepositoryFile | undefined {
  if (files.length === 1) return files[0];
  if (!files.length || new Set(files.map(file => projectorFamily({ path: file.path }))).size !== 1) return undefined;
  const preference = ['Q8_0', 'F16', 'BF16', 'F32', 'Q8_1', ...quantizationPreference];
  const ranked = files.map(file => ({ file, quantization: quantizationName({ path: file.path }) }));
  if (ranked.some(entry => entry.quantization === undefined)) return undefined;
  ranked.sort((a, b) => preference.indexOf(a.quantization!) - preference.indexOf(b.quantization!));
  if (ranked[0]?.quantization === ranked[1]?.quantization) return undefined;
  return ranked[0]?.file;
}
export const TEST_ONLY = {
};
