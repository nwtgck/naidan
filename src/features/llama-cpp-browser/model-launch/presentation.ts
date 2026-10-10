import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/catalog';

/** A local display hint only: never authorizes a download or guesses model files. */
export function modelLaunchPresentation({ input }: { input: unknown }): ReturnType<typeof parseRepository> | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096) return undefined;
  try {
    return parseRepository({ input });
  } catch {
    return undefined;
  }
}

export const TEST_ONLY = {
};
