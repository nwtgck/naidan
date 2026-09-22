import type { Endpoint } from '@/01-models/types';
import type { LocalModel } from './types';
import { modelSuggestions, suggestedQuantizationLabel } from './hugging-face/model-suggestions';
import { artifactRole } from './hugging-face/artifact-role';
import { quantizationName } from './hugging-face/presentation';

export type DefaultModelContext = { endpoint: Endpoint, modelId: string | undefined };
export type ApplyDefaultModel = ({ model, previous }: { model: LocalModel, previous: DefaultModelContext }) => Promise<'applied' | 'changed'>;

export function isDefaultLocalModel({ model, current }: { model: LocalModel, current: DefaultModelContext | undefined }): boolean {
  return current?.endpoint.type === 'llama_cpp_browser' && (current.modelId === model.name || current.modelId === model.id);
}

export function localModelDisplayName({ model }: { model: LocalModel }): string {
  try {
    const path = decodeURIComponent(model.id.slice(model.id.indexOf(':') + 1));
    const role = artifactRole({ path });
    switch (role) {
    case 'model': break;
    case 'projector': case 'auxiliary': return model.name;
    default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
    }
    const token = quantizationName({ path });
    if (!token) return model.name;
    for (const suggestion of modelSuggestions) {
      const quantization = suggestion.quantizationHints.find(choice =>
        model.id.toLowerCase().startsWith(`hf.co/${choice.repository}:`.toLowerCase())
        && choice.preferredQuantization === token);
      if (quantization) return `${suggestion.name} · ${suggestedQuantizationLabel({ quantization })}`;
    }
    return model.name;
  } catch {
    return model.name;
  }
}
export const TEST_ONLY = {
};
