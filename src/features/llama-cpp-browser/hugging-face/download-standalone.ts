import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import type * as hosted from './download';

// Standalone keeps the disabled download UI, but must not import its hosted worker.
const unavailable = async (): Promise<never> => {
  throw new LlamaCppBrowserError({ code: 'unavailable' });
};

export const downloadRepository: typeof hosted.downloadRepository = unavailable;
export const cancelDownload: typeof hosted.cancelDownload = unavailable;

export const TEST_ONLY = {
};
