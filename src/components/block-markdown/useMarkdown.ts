import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';

// Import custom extensions from the extensions/ directory to keep this file lean.
import { detailsExtension } from './extensions/details';
import { encodeExternalImagePayload } from '@/logic/security/markdownExternalImage';

export const marked = new Marked();

// Register extensions. Add new extensions to the ./extensions directory.
marked.use({
  extensions: [
    detailsExtension,
  ],
  renderer: {
    image({ href, title, text }: { href: string, title: string | null, text: string }): string {
      // Return a custom tag that can be parsed by MarkdownInline.
      // Use Base64 to prevent any issues with quotes or characters in JSON.
      // Use encodeURIComponent + btoa to handle potential non-ASCII characters in alt text/title.
      const payload = encodeExternalImagePayload({
        payload: { href, title, text },
      });
      return `<naidan-external-image data-payload="${payload}"></naidan-external-image>`;
    },
  },
});

marked.use(markedKatex({
  throwOnError: false,
  output: 'html',
  nonStandard: true, // Allow $$...$$ to be treated as display math even if not in a block context
}));

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
