import { artifactRole } from './artifact-role';
import { type RepositoryCatalog, type ModelCandidate } from './catalog';
import { preferredProjector, quantizationName } from './presentation';
import { selectionSchema, type DownloadSelection } from './types';
import type { ModelSuggestion, MultimodalDownload } from './model-suggestions';
import type { LocalModel } from '@/features/llama-cpp-browser/types';

export class SuggestionPlanError extends Error {
  constructor() {
    super('The suggested model files cannot be selected unambiguously');
    this.name = 'SuggestionPlanError';
  }
}

function matchingCandidates({ suggestion, models }: { suggestion: ModelSuggestion, models: ModelCandidate[] }): ModelCandidate[] {
  return models.filter(model => model.files.length > 0 && model.files.every(file => artifactRole({ path: file.path }) === 'model' && quantizationName({ path: file.path }) === suggestion.preferredQuantization));
}

/** Pure resolution: approximate catalog fields never validate or identify files. */
export function resolveSuggestionPlan({ suggestion, catalog, multimodal }: { suggestion: ModelSuggestion, catalog: RepositoryCatalog, multimodal: MultimodalDownload }): DownloadSelection {
  // Do not silently follow a renamed/transferred repository for one-click installs.
  if (catalog.repository.toLowerCase() !== suggestion.repository.toLowerCase()) throw new SuggestionPlanError();
  const candidates = matchingCandidates({ suggestion, models: catalog.models });
  if (candidates.length !== 1) throw new SuggestionPlanError();
  const files = [...candidates[0]!.files];
  switch (multimodal) {
  case 'off': break;
  case 'on': {
    const projector = preferredProjector({ files: catalog.projectors });
    if (!projector) throw new SuggestionPlanError();
    files.push(projector); break;
  }
  default: { const exhaustive: never = multimodal; throw new Error(String(exhaustive)); }
  }
  return selectionSchema.parse({ repository: catalog.repository, revision: catalog.revision, files });
}

/** Uses already validated LOCAL model listings; never triggers remote discovery. */
export function findLocalSuggestedModel({ suggestion, models }: { suggestion: ModelSuggestion, models: readonly LocalModel[] }): LocalModel | undefined {
  const prefix = `hf.co/${suggestion.repository}:`.toLowerCase();
  const matches = models.filter(model => {
    if (!model.id.toLowerCase().startsWith(prefix)) return false;
    try {
      const path = decodeURIComponent(model.id.slice(prefix.length));
      return artifactRole({ path }) === 'model' && quantizationName({ path }) === suggestion.preferredQuantization;
    } catch {
      return false;
    }
  });
  // Arbitrary local imports cannot be equated to a repository by filename alone.
  return matches.length === 1 ? matches[0] : undefined;
}

export const TEST_ONLY = {
};
