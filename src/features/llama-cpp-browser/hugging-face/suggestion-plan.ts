import { type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination-types';
import { artifactRole } from './artifact-role';
import { type RepositoryCatalog, type ModelCandidate } from './catalog';
import { preferredProjector, quantizationName } from './presentation';
import { selectionSchema, type DownloadSelection } from './types';
import type { SuggestedQuantization, MultimodalDownload } from './model-suggestions';
import type { LocalModel } from '@/features/llama-cpp-browser/types';

export class SuggestionPlanError extends Error {
  constructor() {
    super('The suggested model files cannot be selected unambiguously');
    this.name = 'SuggestionPlanError';
  }
}

function matchingCandidates({ quantization, models }: { quantization: SuggestedQuantization, models: ModelCandidate[] }): ModelCandidate[] {
  return models.filter(model => model.files.length > 0 && model.files.every(file => artifactRole({ path: file.path }) === 'model' && quantizationName({ path: file.path }) === quantization.preferredQuantization));
}

/** Pure resolution: approximate catalog fields never validate or identify files. */
export function resolveSuggestionPlan({ quantization, catalog, multimodal }: { quantization: SuggestedQuantization, catalog: RepositoryCatalog, multimodal: MultimodalDownload }): DownloadSelection {
  // Do not silently follow a renamed/transferred repository for one-click installs.
  if (catalog.repository.toLowerCase() !== quantization.hfRepository.toLowerCase()) {
    throw new SuggestionPlanError();
  }
  const candidates = matchingCandidates({ quantization, models: catalog.models });
  if (candidates.length !== 1) {
    throw new SuggestionPlanError();
  }
  const files = [...candidates[0]!.files];
  switch (multimodal) {
  case 'off': break;
  case 'on': {
    const projector = preferredProjector({ files: catalog.projectors });
    if (!projector) {
      throw new SuggestionPlanError();
    }
    files.push(projector);
    break;
  }
  default: {
    const exhaustive: never = multimodal;
    throw new Error(String(exhaustive));
  }
  }
  return selectionSchema.parse({ repository: catalog.repository, revision: catalog.revision, files });
}

/** Find a public selection to inspect locally; its file role still needs verification. */
export function findLocalSuggestedModel({ quantization, models, destination }: { quantization: SuggestedQuantization, models: readonly LocalModel[], destination?: ModelDestination }): LocalModel | undefined {
  const target = destination ?? { kind: 'opfs' };
  const matches = models.filter(model => {
    try {
      const path = (() => {
        switch (target.kind) {
        case 'opfs': {
          const prefix = `hf.co/${quantization.hfRepository}:`.toLowerCase();
          return model.modelId.toLowerCase().startsWith(prefix) ? model.modelId.slice(prefix.length) : undefined;
        }
        case 'host': {
          if (!model.modelId.startsWith('host/')) {
            return undefined;
          }
          const source = model.source;
          // The public modelId carries the folder alias; provenance identifies
          // the registered destination without embedding its ID in modelId.
          return source?.directoryId === target.directoryId && source.repository === quantization.hfRepository ? source.primaryRelativePath : undefined;
        }
        default: {
          const exhaustive: never = target;
          throw new Error(String(exhaustive));
        }
        }
      })();
      return path !== undefined && artifactRole({ path }) === 'model' && quantizationName({ path }) === quantization.preferredQuantization;
    } catch {
      return false;
    }
  });
  // Arbitrary local imports cannot be equated to a repository by filename alone.
  return matches.length === 1 ? matches[0] : undefined;
}

export const TEST_ONLY = {
};
