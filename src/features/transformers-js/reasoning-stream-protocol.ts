export type ReasoningStreamProtocol =
  | "generated-output"
  | "prompt-open-think";

const THINK_OPEN_TAG = "<think>";

export function detectReasoningStreamProtocol({
  renderedGenerationPrompt,
  renderedConversationPrompt,
}: {
  renderedGenerationPrompt: string,
  renderedConversationPrompt: string | undefined,
}): ReasoningStreamProtocol {
  if (!renderedGenerationPrompt.trimEnd().endsWith(THINK_OPEN_TAG)) return "generated-output";
  if (renderedConversationPrompt === undefined) return "prompt-open-think";
  if (renderedConversationPrompt.trimEnd().endsWith(THINK_OPEN_TAG)) return "generated-output";
  if (!renderedGenerationPrompt.startsWith(renderedConversationPrompt)) return "generated-output";

  const generationSuffix = renderedGenerationPrompt.slice(renderedConversationPrompt.length).trimEnd();
  return generationSuffix.endsWith(THINK_OPEN_TAG)
    ? "prompt-open-think"
    : "generated-output";
}

export function createReasoningStreamNormalizer({
  protocol,
  onOutput,
}: {
  protocol: ReasoningStreamProtocol,
  onOutput: ({ output }: { output: string }) => void,
}): {
  feed({ output }: { output: string }): void,
  flush(): void,
} {
  let prefixBuffer = '';
  let decidedPromptOpenPrefix = protocol === 'generated-output';

  function emitPromptOpenPrefixIfNeeded(): void {
    if (decidedPromptOpenPrefix) return;
    decidedPromptOpenPrefix = true;
    if (prefixBuffer.startsWith(THINK_OPEN_TAG)) {
      onOutput({ output: prefixBuffer });
    } else {
      onOutput({ output: THINK_OPEN_TAG });
      if (prefixBuffer.length > 0) onOutput({ output: prefixBuffer });
    }
    prefixBuffer = '';
  }

  return {
    feed({ output }: { output: string }): void {
      if (output.length === 0) return;

      switch (protocol) {
      case 'generated-output':
        onOutput({ output });
        return;
      case 'prompt-open-think': {
        if (decidedPromptOpenPrefix) {
          onOutput({ output });
          return;
        }
        prefixBuffer += output;
        if (THINK_OPEN_TAG.startsWith(prefixBuffer) && prefixBuffer.length < THINK_OPEN_TAG.length) return;
        emitPromptOpenPrefixIfNeeded();
        return;
      }
      default: {
        const _ex: never = protocol;
        throw new Error(`Unhandled reasoning stream protocol: ${String(_ex)}`);
      }
      }
    },
    flush(): void {
      if (protocol === 'prompt-open-think' && prefixBuffer.length > 0) {
        emitPromptOpenPrefixIfNeeded();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
