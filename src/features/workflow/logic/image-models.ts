import type { BrowserImageModelLocation, BrowserImageModelSelection } from '@/01-models/types';
import { imageModelLocation, sameImageModelLocation } from '@/features/stable-diffusion-cpp-browser/logic/model-location';
import type { ModelInventory, ModelCandidate } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import { componentRequirements, componentMatch } from '@/features/image-generation/model-configuration';
import { imagePrimarySlot } from '@/features/image-generation/model-selection';
import { modelForImageCandidate } from '@/features/stable-diffusion-cpp-browser/logic/model-files';
import type { Request } from '@/features/stable-diffusion-cpp-browser/types';
import { workflowImageModelSchema, workflowImageLocationLabel } from './image-model-schema';

/** Exact locators only. Missing components must never be replaced with recommendations. */
export function resolveWorkflowImageModels({ selection: source, inventory }: { selection: BrowserImageModelSelection, inventory: ModelInventory }): Pick<Request, 'models' | 'loras'> {
  const selection = workflowImageModelSchema.parse(source);
  function candidateAt({ location }: { location: BrowserImageModelLocation }): ModelCandidate {
    const candidates = inventory.candidates.filter(candidate => sameImageModelLocation({ left: location, right: imageModelLocation({ repositoryKey: candidate.repositoryKey, hostSource: candidate.hostSource, relativePath: candidate.primaryRelativePath }) }));
    const candidate = candidates[0];
    if (candidates.length !== 1 || !candidate || candidate.issue) {
      throw new Error(`Image model is unavailable or ambiguous: ${workflowImageLocationLabel({ location })}`);
    }
    return candidate;
  }
  const primary = candidateAt({ location: selection.primary.location });
  if (imagePrimarySlot({ family: primary.family }) !== selection.primary.slot) {
    throw new Error('Image primary model does not match the selected slot or has an unknown family.');
  }
  const requirements = componentRequirements({ family: primary.family });
  if (selection.components.length !== requirements.length || requirements.some(requirement => !selection.components.some(component => component.slot === requirement.slot))) {
    throw new Error('Image selection must explicitly specify every required or optional component. Select the model again.');
  }
  const models: Request['models'] = [modelForImageCandidate({ candidate: primary, slot: selection.primary.slot })];
  for (const requirement of requirements) {
    const choice = selection.components.find(component => component.slot === requirement.slot)!.choice;
    switch (choice.kind) {
    case 'none':
      if (requirement.required) {
        throw new Error(`Image component is required: ${requirement.slot}`);
      }
      break;
    case 'file': {
      const candidate = candidateAt({ location: choice.location });
      if (componentMatch({ candidate, requirement }) === 'incompatible' || candidate.classes.includes('lora') || candidate === primary) {
        throw new Error(`Image component is incompatible: ${requirement.slot}`);
      }
      models.push(modelForImageCandidate({ candidate, slot: requirement.slot }));
      break;
    }
    default: {
      const exhaustive: never = choice;
      throw new Error(String(exhaustive));
    }
    }
  }
  const loras = selection.loras.flatMap(lora => {
    switch (lora.enabled) {
    case 'disabled': return [];
    case 'enabled': {
      const candidate = candidateAt({ location: lora.location });
      const entry = candidate.files.find(entry => entry.relativePath === candidate.primaryRelativePath);
      if (!candidate.classes.includes('lora') || !entry || candidate.files.length !== 1) {
        throw new Error('Select a single-file local LoRA adapter.');
      }
      return [{ file: entry.file, relativePath: entry.relativePath, strength: lora.strength }];
    }
    default: {
      const exhaustive: never = lora.enabled;
      throw new Error(String(exhaustive));
    }
    }
  });
  return { models, loras };
}

export const TEST_ONLY = {
};
