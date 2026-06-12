import type { TokenizerAndRendererExtension } from 'marked';

/**
 * Custom extension for <details> support.
 * Handles <details> blocks with balanced tag matching for nesting support.
 * Extracts <summary> for explicit rendering.
 */
export const detailsExtension: TokenizerAndRendererExtension = {
  name: 'details',
  level: 'block',
  start(src: string) {
    return src.match(/<details>/)?.index;
  },
  tokenizer(src: string) {
    if (!src.startsWith('<details>')) return undefined;

    let depth = 0;
    let index = 0;
    const startTag = '<details>';
    const endTag = '</details>';

    // Balanced tag matching for nesting support
    while (index < src.length) {
      if (src.substring(index).startsWith(startTag)) {
        depth++;
        index += startTag.length;
      } else if (src.substring(index).startsWith(endTag)) {
        depth--;
        index += endTag.length;
        if (depth === 0) {
          const raw = src.substring(0, index);
          const content = raw.substring(startTag.length, raw.length - endTag.length);

          const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(content);
          const summary = (summaryMatch?.[1] ?? '').trim();
          const body = summaryMatch ? content.replace(summaryMatch[0] ?? '', '').trim() : content.trim();

          return {
            type: 'details',
            raw,
            summary,
            // Pre-tokenize summary as inline
            summaryTokens: this.lexer.inlineTokens(summary),
            // Body is always block level
            tokens: this.lexer.blockTokens(body, []),
          };
        }
      } else {
        index++;
      }
    }
    return undefined;
  },
};
