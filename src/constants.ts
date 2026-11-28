// TODO(strings-localize): Localize endpoint preset labels without changing this shared preset data contract.
export const ENDPOINT_PRESETS = [
  { name: 'Ollama (local)', type: 'ollama', url: 'http://localhost:11434' },
  { name: 'LM Studio (local)', type: 'openai', url: 'http://localhost:1234/v1' },
  { name: 'llama-server (local)', type: 'openai', url: 'http://localhost:8080/v1' },
  // Shared presets focus on local servers; cloud URLs can be entered directly.
  // { name: 'OpenAI', type: 'openai', url: 'https://api.openai.com/v1' },
  // { name: 'Groq', type: 'openai', url: 'https://api.groq.com/openai/v1' },
  // { name: 'Mistral', type: 'openai', url: 'https://api.mistral.ai/v1' },
] as const;

// Synchronization keys

export const SYNC_KEY_PREFIX = 'naidan:sync:';
export const SYNC_SIGNAL_KEY = `${SYNC_KEY_PREFIX}signal`;

const syncLockPrefix = `${SYNC_KEY_PREFIX}lock`;

export const SYNC_LOCK_KEY = syncLockPrefix; // Legacy/Global lock

export const LOCK_METADATA = `${syncLockPrefix}:metadata`;

export const LOCK_CHAT_CONTENT_PREFIX = `${syncLockPrefix}:chat_content:`;

// TODO(strings-localize): Separate the persisted title fallback and search-worker title from locale-specific display copy before localizing this shared domain value.
export const UNTITLED_CHAT_TITLE = 'New Chat';
export const OPFS_TMP_CLEANUP_LOCK_KEY = `${syncLockPrefix}:opfs_tmp_cleanup`;
export const FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME = 'file-protocol-compatible-wesh-worker';


export const GLOBAL_SEARCH_WORKER_NAME = 'global-search-worker';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
