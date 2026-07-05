import { z } from 'zod';

import { getPromptApiCoreOptions } from './constants';
import { PromptApiError, normalizePromptApiError } from './errors';
import type {
  PromptApiAvailability,
  PromptApiInputMode,
  PromptApiLanguageModelStatic,
  PromptApiMessage,
  PromptApiSession,
} from './language-model';

const PromptApiAvailabilitySchema = z.enum([
  'available',
  'downloadable',
  'downloading',
  'unavailable',
]);

function isPromptApiLanguageModelStatic(value: unknown): value is PromptApiLanguageModelStatic {
  const valueType = typeof value;
  if ((valueType !== 'object' && valueType !== 'function') || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.availability === 'function'
    && typeof candidate.create === 'function'
  );
}

function isPromptApiSession(value: unknown): value is PromptApiSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.promptStreaming === 'function'
    && typeof candidate.destroy === 'function'
  );
}

export function getPromptApiLanguageModel(): PromptApiLanguageModelStatic | undefined {
  const candidate = (globalThis as typeof globalThis & {
    LanguageModel?: unknown,
  }).LanguageModel;

  return isPromptApiLanguageModelStatic(candidate)
    ? candidate
    : undefined;
}

export async function getPromptApiAvailability({ inputMode }: {
  inputMode: PromptApiInputMode,
}): Promise<PromptApiAvailability> {
  const languageModel = getPromptApiLanguageModel();
  if (languageModel === undefined) {
    throw new PromptApiError({
      code: 'api_unavailable',
      message: 'LanguageModel API is unavailable.',
    });
  }

  try {
    return PromptApiAvailabilitySchema.parse(
      await languageModel.availability(getPromptApiCoreOptions({ inputMode })),
    );
  } catch (error) {
    throw normalizePromptApiError({ error });
  }
}

export async function createPromptApiSession({
  initialPrompts,
  signal,
  onDownloadProgress,
  inputMode,
}: {
  initialPrompts: PromptApiMessage[],
  signal: AbortSignal | undefined,
  onDownloadProgress: (({ progress }: { progress: number }) => void) | undefined,
  inputMode: PromptApiInputMode,
}): Promise<PromptApiSession> {
  const languageModel = getPromptApiLanguageModel();
  if (languageModel === undefined) {
    throw new PromptApiError({
      code: 'api_unavailable',
      message: 'LanguageModel API is unavailable.',
    });
  }

  try {
    // Call create() synchronously before awaiting its promise so a caller invoked
    // from a click handler does not lose transient user activation.
    const sessionPromise = languageModel.create({
      ...getPromptApiCoreOptions({ inputMode }),
      initialPrompts,
      signal,
      ...(onDownloadProgress === undefined
        ? {}
        : {
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the browser Prompt API monitor callback signature.
          monitor: monitor => {
            monitor.addEventListener('downloadprogress', event => {
              if (!Number.isFinite(event.loaded)) return;
              onDownloadProgress({
                progress: Math.min(1, Math.max(0, event.loaded)),
              });
            });
          },
        }),
    });

    const session = await sessionPromise;
    if (!isPromptApiSession(session)) {
      throw new TypeError('LanguageModel.create() returned an invalid session.');
    }
    return session;
  } catch (error) {
    throw normalizePromptApiError({ error });
  }
}

export const TEST_ONLY = {
};
