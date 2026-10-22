import { modelLaunchTargetSchema, type ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { formatHuggingFaceModelId } from '@/01-models/llama-cpp-browser-model-id';
import type { DownloadSelection } from '@/features/llama-cpp-browser/hugging-face/types';
import { parseRepository, type RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { artifactRole } from '@/features/llama-cpp-browser/hugging-face/artifact-role';
import { variantLabel } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { matchesQuantizationChoice, preferredProjector, projectorChoices, quantizationChoices } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { resolveModelFiles } from '@/features/llama-cpp-browser/runtime/model-directory';

export type ModelLaunchProblem = 'invalid-input' | 'variant-unavailable' | 'companion-required';
export class ModelLaunchTargetError extends Error {
  readonly problem: ModelLaunchProblem;

  constructor({ problem }: { problem: ModelLaunchProblem }) {
    super(`Model launch: ${problem}`);
    this.problem = problem;
  }
}

export function modelLaunchChoices({ catalog }: { catalog: RepositoryCatalog }) {
  return quantizationChoices({ repository: catalog.repository, models: catalog.models })
    .filter(choice => artifactRole({ path: choice.primaryRelativePath }) === 'model');
}

export function targetForChoice({ catalog, path }: { catalog: RepositoryCatalog, path: string }): ModelLaunchTarget {
  const model = catalog.models.find(candidate => candidate.files[0]?.path === path);
  if (model === undefined || artifactRole({ path }) !== 'model') {
    throw new ModelLaunchTargetError({ problem: 'variant-unavailable' });
  }
  const projector = preferredProjector({ files: catalog.projectors });
  // An ambiguous companion is not permission to guess or silently drop vision.
  if (catalog.projectors.length > 0 && projector === undefined) {
    throw new ModelLaunchTargetError({ problem: 'companion-required' });
  }
  const files = [...model.files, ...(projector === undefined ? [] : [projector])];
  const target = targetForSelection({ selection: { repository: catalog.repository, revision: catalog.revision, files } });
  const matching = modelLaunchChoices({ catalog }).filter(choice => formatHuggingFaceModelId({ repository: catalog.repository, mainFilePath: choice.primaryRelativePath }) === target.modelId);
  if (matching.length !== 1) {
    throw new ModelLaunchTargetError({ problem: 'variant-unavailable' });
  }
  return target;
}

export function targetForSelection({ selection }: { selection: DownloadSelection }): ModelLaunchTarget {
  const { primaryRelativePath } = resolveModelFiles({ files: selection.files.map(file => ({ relativePath: file.path })) });
  return modelLaunchTargetSchema.parse({
    selection,
    mainFilePath: primaryRelativePath,
    modelId: formatHuggingFaceModelId({ repository: selection.repository, mainFilePath: primaryRelativePath }),
  });
}

export function resolveModelLaunchTarget({ input, catalog }: { input: string, catalog: RepositoryCatalog }): { target: ModelLaunchTarget, requestedVariant: string | undefined } {
  if (input.length > 4096) {
    throw new ModelLaunchTargetError({ problem: 'invalid-input' });
  }
  const { requestedVariant } = parseRepository({ input });
  const choices = modelLaunchChoices({ catalog });
  const exact = requestedVariant === undefined ? [] : choices.filter(choice => matchesQuantizationChoice({ choice, variant: requestedVariant }));
  const matching = requestedVariant === undefined ? choices.slice(0, 1) : exact.length > 0 ? exact
    : choices.filter(choice => choice.quantization === requestedVariant.toUpperCase());
  if (matching.length !== 1) {
    throw new ModelLaunchTargetError({ problem: 'variant-unavailable' });
  }
  return { target: targetForChoice({ catalog, path: matching[0]!.primaryRelativePath }), requestedVariant };
}

export type ModelLaunchConfiguration =
  | { status: 'resolved', target: ModelLaunchTarget }
  | { status: 'needs-selection', mainChoices: { path: string, label: string, size: number }[], companionChoices: { path: string, label: string, size: number }[], selectedMainPath: string | undefined, selectedCompanionPath: string | undefined, companionRequirement: 'required' | 'optional' | 'none' }
  | { status: 'invalid', problem: ModelLaunchProblem };

/** Resolve only a catalog obtained by the current explicit Start operation. */
export function resolveModelLaunchConfiguration({ input, requestedVariant, catalog, multimodal }: {
  input: string, requestedVariant: string | undefined, catalog: RepositoryCatalog, multimodal: 'auto' | 'on' | 'off',
}): ModelLaunchConfiguration {
  let repository: string;
  try {
    repository = parseRepository({ input }).repository;
  } catch {
    return { status: 'invalid', problem: 'invalid-input' };
  }
  if (repository.toLowerCase() !== catalog.repository.toLowerCase()) {
    return { status: 'invalid', problem: 'invalid-input' };
  }
  const choices = modelLaunchChoices({ catalog });
  const exact = requestedVariant === undefined ? [] : choices.filter(choice => matchesQuantizationChoice({ choice, variant: requestedVariant }));
  const matching = requestedVariant === undefined ? choices : exact.length > 0 ? exact
    : choices.filter(choice => choice.quantization === requestedVariant.toUpperCase());
  if (matching.length === 0) {
    return { status: 'invalid', problem: 'variant-unavailable' };
  }
  const mainChoices = matching.map(choice => ({ path: choice.primaryRelativePath, label: choice.label, size: choice.models.reduce((sum, model) => sum + model.size, 0) }));
  const companions = (() => {
    switch (multimodal) {
    case 'off': return [];
    case 'auto': case 'on': return projectorChoices({ files: catalog.projectors });
    default: {
      const exhaustive: never = multimodal;
      throw new Error(String(exhaustive));
    }
    }
  })();
  if (multimodal === 'on' && companions.length === 0) {
    return { status: 'invalid', problem: 'companion-required' };
  }
  const companionRequirement = companions.length === 0 ? 'none' : 'required';
  const selectedMainPath = mainChoices.length === 1 ? mainChoices[0]!.path : undefined;
  const selectedCompanionPath = companions.length === 1 ? companions[0]!.file.path : undefined;
  if (selectedMainPath === undefined || companions.length > 1) {
    return {
      status: 'needs-selection',
      mainChoices,
      companionChoices: companions.map(choice => ({ path: choice.file.path, label: choice.label, size: choice.file.size })),
      selectedMainPath,
      selectedCompanionPath,
      companionRequirement,
    };
  }
  try {
    return { status: 'resolved', target: confirmModelLaunchConfiguration({ catalog, mainFilePath: selectedMainPath, companionFilePath: selectedCompanionPath, multimodal }) };
  } catch (error) {
    return { status: 'invalid', problem: error instanceof ModelLaunchTargetError ? error.problem : 'invalid-input' };
  }
}

/** Confirmation never refreshes metadata or substitutes a different file. */
export function confirmModelLaunchConfiguration({ catalog, mainFilePath, companionFilePath, multimodal }: {
  catalog: RepositoryCatalog, mainFilePath: string, companionFilePath: string | undefined, multimodal: 'auto' | 'on' | 'off',
}): ModelLaunchTarget {
  const model = catalog.models.find(candidate => candidate.files[0]?.path === mainFilePath);
  if (model === undefined || artifactRole({ path: mainFilePath }) !== 'model') {
    throw new ModelLaunchTargetError({ problem: 'variant-unavailable' });
  }
  const companion = companionFilePath === undefined ? undefined : catalog.projectors.find(file => file.path === companionFilePath);
  if (companionFilePath !== undefined && companion === undefined) {
    throw new ModelLaunchTargetError({ problem: 'companion-required' });
  }
  switch (multimodal) {
  case 'off': if (companion !== undefined) {
    throw new ModelLaunchTargetError({ problem: 'companion-required' });
  }
    break;
  case 'on': if (companion === undefined) {
    throw new ModelLaunchTargetError({ problem: 'companion-required' });
  }
    break;
  case 'auto': if (companion === undefined && catalog.projectors.length > 0) {
    throw new ModelLaunchTargetError({ problem: 'companion-required' });
  }
    break;
  default: {
    const exhaustive: never = multimodal;
    throw new Error(String(exhaustive));
  }
  }
  const target = targetForSelection({ selection: { repository: catalog.repository, revision: catalog.revision, files: [...model.files, ...(companion === undefined ? [] : [companion])] } });
  const matching = modelLaunchChoices({ catalog }).filter(choice => formatHuggingFaceModelId({ repository: catalog.repository, mainFilePath: choice.primaryRelativePath }) === target.modelId);
  if (matching.length !== 1) {
    throw new ModelLaunchTargetError({ problem: 'variant-unavailable' });
  }
  return target;
}

export function modelLaunchChatGroupName({ target }: { target: ModelLaunchTarget }): string {
  const repository = target.selection.repository;
  const label = variantLabel({ repository, path: target.mainFilePath });
  return `${repository.split('/')[1]} · ${label}`;
}

export function sameLaunchTarget({ left, right }: { left: ModelLaunchTarget, right: ModelLaunchTarget }): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Retain only catalogs obtained by explicit visits/checks. A chat reload never
// turns a cache miss into a remote request. The stored target remains usable.
const catalogs = new Map<string, RepositoryCatalog>();

export function rememberLaunchCatalog({ catalog }: { catalog: RepositoryCatalog }): void {
  catalogs.delete(catalog.repository);
  catalogs.set(catalog.repository, catalog);
  if (catalogs.size > 16) {
    catalogs.delete(catalogs.keys().next().value!);
  }
}

export function readLaunchCatalog({ repository }: { repository: string }): RepositoryCatalog | undefined {
  return catalogs.get(repository);
}

export const TEST_ONLY = {
  reset: () => catalogs.clear(),
};
