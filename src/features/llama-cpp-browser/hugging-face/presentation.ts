import { variantLabel } from './model-variants';
import type { ModelCandidate } from './catalog';
import type { RepositoryFile } from './types';

// A fixed preference order, independent of device capabilities or repository order.
const quantizationPreference = ['Q4_K_M', 'Q4_K_S', 'Q4_0', 'Q4_1', 'IQ4_NL', 'IQ4_XS', 'MXFP4', 'NVFP4', 'Q5_K_M', 'Q5_K_S', 'Q5_0', 'Q5_1', 'IQ5_XS', 'Q6_K', 'IQ6_K', 'Q8_0', 'Q8_1', 'Q3_K_M', 'Q3_K_L', 'Q3_K_S', 'IQ3_M', 'IQ3_S', 'IQ3_XS', 'IQ3_XXS', 'Q2_K', 'IQ2_M', 'IQ2_S', 'IQ2_XS', 'IQ2_XXS', 'IQ1_M', 'IQ1_S', 'BF16', 'F16', 'F32'];
export type QuantizationChoice = { id: string, label: string, quantization: string | undefined, models: ModelCandidate[] };
export function quantizationName({ path }: { path: string }): string | undefined {
  const name = (path.split('/').at(-1) ?? '').toUpperCase();
  return quantizationPreference.find(quantization => new RegExp(`(?:^|[-_.])${quantization}(?=[-.]|$)`).test(name));
}
function lexical({ left, right }: { left: string, right: string }): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function quantizationChoices({ repository, models }: { repository: string, models: ModelCandidate[] }): QuantizationChoice[] {
  return models.map(model => ({ id: model.files[0]!.path, label: variantLabel({ repository, path: model.files[0]!.path }), quantization: quantizationName({ path: model.files[0]!.path }), models: [model] })).sort((a, b) => {
    const rank = ({ choice }: { choice: QuantizationChoice }): number => {
      if (choice.quantization !== undefined) return quantizationPreference.indexOf(choice.quantization);
      // Unknown 4-bit schemes still precede higher/lower-bit defaults without enumerating vendor variants.
      return /(?:^|[-_.])(?:I?Q|MXFP|NVFP)4(?:[-_.]|$)/i.test(choice.label) ? 7.5 : quantizationPreference.length;
    };
    const ordinary = ({ choice }: { choice: QuantizationChoice }): number => choice.label.split('/').at(-1)?.toUpperCase() === choice.quantization ? 0 : 1;
    return rank({ choice: a }) - rank({ choice: b }) || ordinary({ choice: a }) - ordinary({ choice: b }) || lexical({ left: a.label, right: b.label }) || lexical({ left: a.id, right: b.id });
  });
}
function projectorFamily({ path }: { path: string }): string {
  const quantization = quantizationName({ path });
  const normalized = path.toLowerCase().replace(/\.gguf$/i, '');
  return quantization === undefined ? normalized : normalized.replace(new RegExp(`(?:^|[-_.])${quantization.toLowerCase()}(?=[-.]|$)`), '').replace(/[-_.]+$/g, '');
}
export function rankedProjectors<T extends { path: string }>({ files }: { files: T[] }): T[] {
  const preference = ['Q8_0', 'F16', 'BF16', 'F32', 'Q8_1', ...quantizationPreference];
  const rank = ({ path }: { path: string }): number => {
    const quantization = quantizationName({ path }); return quantization === undefined ? preference.length : preference.indexOf(quantization);
  };
  return [...files].sort((a, b) => rank(a) - rank(b) || lexical({ left: a.path, right: b.path }));
}
export function projectorChoices({ files }: { files: RepositoryFile[] }): { file: RepositoryFile, label: string }[] {
  return rankedProjectors({ files }).map(file => {
    const quantization = quantizationName({ path: file.path });
    return { file, label: quantization && files.filter(other => quantizationName({ path: other.path }) === quantization).length === 1 ? quantization : file.path.replace(/\.gguf$/i, '') };
  });
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
