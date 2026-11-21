import { splitModelIdDisplay } from '@/01-models/llama-cpp-browser-model-id';
import { variantLabel } from './model-variants';
import { artifactRole } from './artifact-role';
import type { ModelCandidate } from './catalog';
import type { RepositoryFile } from './types';

import { quantizationName, quantizationPreference, rankedProjectors } from './projector-selection';
export { preferredProjector, quantizationName, rankedProjectors } from './projector-selection';

export type QuantizationChoice = { primaryRelativePath: string, label: string, quantization: string | undefined, models: ModelCandidate[] };
const fileNameOrder = new Intl.Collator('en', { numeric: true });

export function describeStoredModelVariant({ modelId }: { modelId: string }): { name: string, source: string, label: string, key: string } | undefined {
  if (!/^(?:hf\.co|host)\//.test(modelId)) {
    return undefined;
  }
  const { source, name, variant } = splitModelIdDisplay({ modelId });
  if (!variant) {
    return undefined;
  }
  return { name, source: source.slice(0, -1), label: variant, key: source + name };
}

export function compareModelVariantsBySize({ left, right }: { left: { bytes: number, path: string }, right: { bytes: number, path: string } }): number {
  return left.bytes - right.bytes || fileNameOrder.compare(left.path, right.path) || lexical({ left: left.path, right: right.path });
}

function lexical({ left, right }: { left: string, right: string }): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function quantizationFirstLabel({ variant, quantization }: { variant: string, quantization: string | undefined }): string {
  const token = quantization === undefined ? undefined : new RegExp(`(?:^|[-_.])${quantization}(?=[-.]|$)`, 'i');
  const qualifier = token ? variant.replace(token, '').replace(/^[-_.]+|[-_.]+$/g, '') : variant;
  return quantization && qualifier ? `${quantization} · ${qualifier}` : quantization ?? variant;
}

export function matchesQuantizationChoice({ choice, variant }: { choice: QuantizationChoice, variant: string }): boolean {
  // The metadata picker submits an exact path. Previously displayed labels
  // remain accepted as explicit input too.
  return choice.primaryRelativePath === variant || choice.label === variant || quantizationFirstLabel({ variant: choice.label, quantization: choice.quantization }) === variant;
}

export function selectedQuantizationChoice({ choices, variant }: { choices: readonly QuantizationChoice[], variant: string | undefined }): QuantizationChoice | undefined {
  if (variant === undefined) {
    return undefined;
  }
  const exact = choices.filter(choice => matchesQuantizationChoice({ choice, variant }));
  const matching = exact.length > 0 ? exact : choices.filter(choice => choice.quantization === variant.toUpperCase());
  return matching.length === 1 ? matching[0] : undefined;
}

export function quantizationChoices({ repository, models }: { repository: string, models: ModelCandidate[] }): QuantizationChoice[] {
  return models.map(model => {
    const path = model.files[0]!.path;
    const quantization = quantizationName({ path });
    const variant = variantLabel({ repository, path });
    // Keep the existing preference and tie-break order independent of display
    // labels, which retain the complete variant in its original order.
    const sortLabel = quantizationFirstLabel({ variant, quantization });
    return { choice: { primaryRelativePath: path, label: variant, quantization, models: [model] }, sortLabel };
  }).sort((a, b) => {
    const rank = ({ choice, sortLabel }: { choice: QuantizationChoice, sortLabel: string }): number => {
      if (choice.quantization !== undefined && quantizationPreference.includes(choice.quantization)) {
        return quantizationPreference.indexOf(choice.quantization);
      }
      // Unknown 4-bit schemes still precede higher/lower-bit defaults without enumerating vendor variants.
      return /(?:^|[-_.])(?:I?Q|MXFP|NVFP)4(?:[-_.]|$)/i.test(sortLabel) ? 7.5 : quantizationPreference.length;
    };
    const ordinary = ({ choice, sortLabel }: { choice: QuantizationChoice, sortLabel: string }): number => sortLabel.split('/').at(-1)?.toUpperCase() === choice.quantization ? 0 : 1;
    return Number(artifactRole({ path: a.choice.primaryRelativePath }) === 'auxiliary') - Number(artifactRole({ path: b.choice.primaryRelativePath }) === 'auxiliary') || rank(a) - rank(b) || ordinary(a) - ordinary(b) || lexical({ left: a.sortLabel, right: b.sortLabel }) || lexical({ left: a.choice.primaryRelativePath, right: b.choice.primaryRelativePath });
  }).map(({ choice }) => choice);
}

export function projectorChoices({ files }: { files: RepositoryFile[] }): { file: RepositoryFile, label: string }[] {
  return rankedProjectors({ files }).map(file => {
    const quantization = quantizationName({ path: file.path });
    return { file, label: quantization && files.filter(other => quantizationName({ path: other.path }) === quantization).length === 1 ? quantization : file.path.replace(/\.gguf$/i, '') };
  });
}

export function formatDownloadBytes({ bytes }: { bytes: number }): string {
  if (bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))} B`;
  }
  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export const TEST_ONLY = {
};
