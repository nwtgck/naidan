import type { Endpoint } from '@/01-models/types';
import type { LocalModel } from './types';

export type DefaultModelContext = { endpoint: Endpoint, modelId: string | undefined };
export type ApplyDefaultModel = ({ model, previous }: { model: LocalModel, previous: DefaultModelContext }) => Promise<'applied' | 'changed'>;

export function isDefaultLocalModel({ model, current }: { model: LocalModel, current: DefaultModelContext | undefined }): boolean {
  return current?.endpoint.type === 'llama_cpp_browser' && current.modelId === model.modelId;
}

export const TEST_ONLY = {
};
