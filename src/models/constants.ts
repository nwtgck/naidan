export const ENDPOINT_PRESETS = [
  { name: 'Ollama (local)', type: 'ollama', url: 'http://localhost:11434' },
  { name: 'LM Studio (local)', type: 'openai', url: 'http://localhost:1234/v1' },
  { name: 'llama-server (local)', type: 'openai', url: 'http://localhost:8080/v1' },
  // Cloud providers commented out until API key support is added
  // { name: 'OpenAI', type: 'openai', url: 'https://api.openai.com/v1' },
  // { name: 'Groq', type: 'openai', url: 'https://api.groq.com/openai/v1' },
  // { name: 'Mistral', type: 'openai', url: 'https://api.mistral.ai/v1' },
] as const;

export const STORAGE_KEY_PREFIX = 'lm-web-ui:';
export const STORAGE_BOOTSTRAP_KEY = `${STORAGE_KEY_PREFIX}storage-type`;
