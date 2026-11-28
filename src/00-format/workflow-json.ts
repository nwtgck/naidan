import { parseJsonText } from '@/utils/json-text';

const maxBytes = 2 * 1024 * 1024;
const maxDepth = 64;

export const workflowJsonFormat = {
  maxBytes,
  maxDepth,
  toDto({ text }: { text: string }) {
    if (text.length > maxBytes || new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error('Workflow JSON exceeds the 2 MiB editing limit.');
    }
    return parseJsonText({ text, maxDepth, depthErrorMessage: 'Workflow JSON is nested too deeply.' });
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
