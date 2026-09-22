import type { Endpoint } from '@/01-models/types';
import type { LocalModel } from './types';
import { modelSuggestions } from './hugging-face/model-suggestions';
import { artifactRole } from './hugging-face/artifact-role';
import { quantizationName } from './hugging-face/presentation';

export type DefaultModelContext = { endpoint: Endpoint, modelId: string | undefined };
export type ApplyDefaultModel = ({ model, previous }: { model: LocalModel, previous: DefaultModelContext }) => Promise<'applied' | 'changed'>;

export function isDefaultLocalModel({ model, current }: { model: LocalModel, current: DefaultModelContext | undefined }): boolean {
  return current?.endpoint.type === 'llama_cpp_browser' && (current.modelId === model.name || current.modelId === model.id);
}

export function localModelDisplayName({ model }: { model: LocalModel }): string {
  const suggestion = modelSuggestions.find(entry => model.id.toLowerCase().startsWith(`hf.co/${entry.repository}:`.toLowerCase()));
  if (!suggestion) return model.name;
  try {
    const path = decodeURIComponent(model.id.slice(model.id.indexOf(':') + 1));
    const role = artifactRole({ path });
    switch (role) {
    case 'model': break;
    case 'projector': case 'auxiliary': return model.name;
    default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
    }
    const quantization = quantizationName({ path });
    return quantization ? `${suggestion.name} · ${quantization}` : model.name;
  } catch {
    return model.name;
  }
}
export const TEST_ONLY = {
};
