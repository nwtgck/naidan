import { huggingFaceModelId, modelLaunchTargetSchema, type ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { parseRepository, type RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { artifactRole } from '@/features/llama-cpp-browser/hugging-face/artifact-role';
import { variantLabel } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { preferredProjector, quantizationChoices } from '@/features/llama-cpp-browser/hugging-face/presentation';
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
    .filter(choice => artifactRole({ path: choice.id }) === 'model');
}
export function targetForChoice({ catalog, path }: { catalog: RepositoryCatalog, path: string }): ModelLaunchTarget {
  const model = catalog.models.find(candidate => candidate.files[0]?.path === path);
  if (model === undefined || artifactRole({ path }) !== 'model') throw new ModelLaunchTargetError({ problem: 'variant-unavailable' });
  const projector = preferredProjector({ files: catalog.projectors });
  // An ambiguous companion is not permission to guess or silently drop vision.
  if (catalog.projectors.length > 0 && projector === undefined) throw new ModelLaunchTargetError({ problem: 'companion-required' });
  const files = [...model.files, ...(projector === undefined ? [] : [projector])];
  const { modelPath } = resolveModelFiles({ files });
  return modelLaunchTargetSchema.parse({
    selection: { repository: catalog.repository, revision: catalog.revision, files },
    mainFilePath: modelPath,
    modelId: huggingFaceModelId({ repository: catalog.repository, modelPath }),
  });
}
export function resolveModelLaunchTarget({ input, catalog }: { input: string, catalog: RepositoryCatalog }): { target: ModelLaunchTarget, requestedVariant: string | undefined } {
  if (input.length > 4096) throw new ModelLaunchTargetError({ problem: 'invalid-input' });
  const { requestedVariant } = parseRepository({ input });
  const choices = modelLaunchChoices({ catalog });
  const exact = requestedVariant === undefined ? [] : choices.filter(choice => choice.label === requestedVariant
    || variantLabel({ repository: catalog.repository, path: choice.id }) === requestedVariant);
  const matching = requestedVariant === undefined ? choices.slice(0, 1) : exact.length > 0 ? exact
    : choices.filter(choice => choice.quantization === requestedVariant.toUpperCase());
  if (matching.length !== 1) throw new ModelLaunchTargetError({ problem: 'variant-unavailable' });
  return { target: targetForChoice({ catalog, path: matching[0]!.id }), requestedVariant };
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
  if (catalogs.size > 16) catalogs.delete(catalogs.keys().next().value!);
}
export function readLaunchCatalog({ repository }: { repository: string }): RepositoryCatalog | undefined {
  return catalogs.get(repository);
}
export const TEST_ONLY = {
  reset: () => catalogs.clear(),
};
