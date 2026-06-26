/* eslint-disable no-restricted-imports -- Dedicated highlight worker core intentionally owns the highlight.js dependency. */
import hljs from 'highlight.js';

export type HighlightMode = 'named-language' | 'auto-detect';

export interface HighlightResult {
  html: string,
  resolvedLanguage: string,
}

export function highlightCodeInWorker({
  code,
  language,
  mode,
}: {
  code: string,
  language: string | undefined,
  mode: HighlightMode,
}): HighlightResult {
  switch (mode) {
  case 'named-language':
    if (language && hljs.getLanguage(language)) {
      const result = hljs.highlight(code, { language });
      return {
        html: result.value,
        resolvedLanguage: language,
      };
    }

    return highlightCodeInWorker({
      code,
      language: undefined,
      mode: 'auto-detect',
    });
  case 'auto-detect': {
    const result = hljs.highlightAuto(code);
    return {
      html: result.value,
      resolvedLanguage: result.language ?? 'plaintext',
    };
  }
  default: {
    const _exhaustiveCheck: never = mode;
    throw new Error(`Unhandled highlight mode: ${_exhaustiveCheck}`);
  }
  }
}
