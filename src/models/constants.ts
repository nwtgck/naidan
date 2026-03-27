export const ENDPOINT_PRESETS = [
  { name: 'Ollama (local)', type: 'ollama', url: 'http://localhost:11434' },
  { name: 'LM Studio (local)', type: 'openai', url: 'http://localhost:1234/v1' },
  { name: 'llama-server (local)', type: 'openai', url: 'http://localhost:8080/v1' },
  // Cloud providers commented out until API key support is added
  // { name: 'OpenAI', type: 'openai', url: 'https://api.openai.com/v1' },
  // { name: 'Groq', type: 'openai', url: 'https://api.groq.com/openai/v1' },
  // { name: 'Mistral', type: 'openai', url: 'https://api.mistral.ai/v1' },
] as const;

export const STORAGE_KEY_PREFIX = 'naidan:';
export const STORAGE_BOOTSTRAP_KEY = `${STORAGE_KEY_PREFIX}storage_type`;

// Synchronization keys

export const SYNC_SIGNAL_KEY = `${STORAGE_KEY_PREFIX}sync:signal`;

export const SYNC_LOCK_KEY = `${STORAGE_KEY_PREFIX}sync:lock`; // Legacy/Global lock

export const LOCK_METADATA = `${STORAGE_KEY_PREFIX}sync:lock:metadata`;

export const LOCK_CHAT_CONTENT_PREFIX = `${STORAGE_KEY_PREFIX}sync:lock:chat_content:`;

export const UNTITLED_CHAT_TITLE = 'New Chat';
/** OPFS directory used for per-session shell /tmp scratch space. */
export const OPFS_TMP_DIR = 'naidan-tmp';
export const NAIDAN_CACHE_DIRECTORY_NAME = 'naidan-cache';
export const STANDALONE_WORKER_CACHE_DIRECTORY_NAME = 'standalone-workers';
export const STANDALONE_WORKER_MANIFEST_SCRIPT_ID = 'naidan-standalone-worker-manifest';
export const FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME = 'file-protocol-compatible-wesh-worker';
export const FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_ID = FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME;

export const FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_ID = 'file-protocol-compatible-standalone-worker-hub';
export const FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_NAME = 'file-protocol-compatible-standalone-worker-hub';

export const GLOBAL_SEARCH_WORKER_NAME = 'global-search-worker';
