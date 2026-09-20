import type { LmProvider } from '@/01-models/lm';
import { LlamaCppBrowserError } from './types';
export class LlamaCppBrowserProvider implements LmProvider {
  async listModels(): Promise<string[]> {
    return [];
  }
  async chat(): Promise<void> {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
}
export const TEST_ONLY = {
};
