import { storageService } from '@/00-storage/service';
import { parseRuntimeOptions, parsePerformanceRuntimeOptions } from './profile-policy';
import type { RuntimeOptions, GenerateInput } from '@/features/llama-cpp-browser/types';

/** Capture the chat allocation request before entering the native lane. Audio
 * uses its own bounded context; never apply this preference to audio requests.
 * Explicit caller options (including measurements) override the stored value. */
function captureOptions({ options, parse, image }: { options: RuntimeOptions, parse: typeof parseRuntimeOptions, image: 'needed' | 'deferred' }): Promise<RuntimeOptions> {
  const accepted = parse({ options });
  const needsRead = accepted.contextTokens === undefined || (image === 'needed' && accepted.visionBf16Storage === undefined);
  const pending = !needsRead ? Promise.resolve(accepted) : storageService.loadSettings().then(settings => {
    const stored = settings?.experimental?.llamaCppBrowser;
    const contextTokens = accepted.contextTokens ?? stored?.contextTokens;
    const visionBf16Storage = accepted.visionBf16Storage ?? stored?.visionBf16Storage;
    return parse({ options: { ...accepted, ...(contextTokens === undefined ? {} : { contextTokens }), ...(visionBf16Storage === undefined ? {} : { visionBf16Storage }) } });
  });
  // Acceptance can be superseded by a cancelled/skipped warmup. Its storage
  // read still settles; the lane owner observes errors when it awaits pending.
  void pending.catch(() => {});
  return pending;
}

export function captureChatOptions({ options }: { options: RuntimeOptions }): Promise<RuntimeOptions> {
  return captureOptions({ options, parse: parseRuntimeOptions, image: 'deferred' });
}

/** Explicit model preparation also loads an available image projector. */
export function captureProjectorOptions({ options }: { options: RuntimeOptions }): Promise<RuntimeOptions> {
  return captureOptions({ options, parse: parseRuntimeOptions, image: 'needed' });
}

export function capturePerformanceOptions({ options }: { options: RuntimeOptions }): Promise<RuntimeOptions> {
  return captureOptions({ options, parse: parsePerformanceRuntimeOptions, image: 'deferred' });
}

/** Only inspect modality; no I/O, hashing, native probes or new image copies. */
function imagePolicy({ messages }: { messages: GenerateInput['messages'] }): 'needed' | 'deferred' {
  for (const message of messages) {
    if (typeof message.content !== 'string') {
      for (const part of message.content) {
        switch (part.type) {
        case 'image': return 'needed';
        case 'text': break;
        default: {
          const exhaustive: never = part;
          throw new Error(String(exhaustive));
        }
        }
      }
    }
  }
  return 'deferred';
}

export function captureChatInputOptions({ options, messages }: { options: RuntimeOptions, messages: GenerateInput['messages'] }): Promise<RuntimeOptions> {
  return captureOptions({ options, parse: parseRuntimeOptions, image: options.contextTokens === undefined || options.visionBf16Storage !== undefined ? 'deferred' : imagePolicy({ messages }) });
}

/** One owner, no global settings cache. Capture absence/default as well as explicit values. */
export function createOperationOptionsCapture({ options, kind }: { options: RuntimeOptions, kind: 'chat' | 'measurement' }) {
  const parse = (() => {
    switch (kind) {
    case 'chat': return parseRuntimeOptions;
    case 'measurement': return parsePerformanceRuntimeOptions;
    default: {
      const exhaustive: never = kind;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const accepted = parse({ options });
  const initial = captureOptions({ options: accepted, parse, image: 'deferred' });
  // The existing context read already captures the storage preference, including undefined.
  let imageOptions = accepted.contextTokens === undefined || accepted.visionBf16Storage !== undefined ? initial : undefined;
  return {
    initial,
    forMessages({ messages }: { messages: GenerateInput['messages'] }): Promise<RuntimeOptions> {
      if (imageOptions) {
        return imageOptions;
      }
      const policy = imagePolicy({ messages });
      switch (policy) {
      case 'deferred': return initial;
      case 'needed':
        imageOptions ??= captureOptions({ options: accepted, parse, image: 'needed' });
        return imageOptions;
      default: {
        const exhaustive: never = policy;
        throw new Error(String(exhaustive));
      }
      }
    },
  };
}

export const TEST_ONLY = {
};
