import {
  FEATURE_FLAGS_STORAGE_KEY,
} from '@/01-models/feature-flags';
import {
  LOCK_CHAT_CONTENT_PREFIX,
  LOCK_METADATA,
  OPFS_TMP_CLEANUP_LOCK_KEY,
  OPFS_TMP_DIR,
  OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY,
  STORAGE_BOOTSTRAP_KEY,
  STORAGE_KEY_PREFIX,
  SYNC_LOCK_KEY,
  SYNC_SIGNAL_KEY,
  THEME_MODE_STORAGE_KEY,
} from '@/constants';

export type DataDeletionGroup = 'localStorage' | 'opfs' | 'indexedDb' | 'cacheStorage';

export type DataDeletionSelector =
  | { kind: 'localStoragePrefix', prefix: string }
  | { kind: 'localStorageKey', key: string }
  | { kind: 'localStorageUnknownNaidanKeys' }
  | { kind: 'opfsPath', path: string }
  | { kind: 'opfsRemoteModels' }
  | { kind: 'indexedDbDatabase', name: string }
  | { kind: 'indexedDbUnknownNaidanDatabases' }
  | { kind: 'cacheStorageAll' }
  | { kind: 'cacheStorageNameIncludes', text: string };

export type DataDeletionOption = {
  id: string,
  group: DataDeletionGroup,
  label: string,
  description: string,
  selector: DataDeletionSelector,
  advanced: boolean,
};

export type DataDeletionPreviewEntry = {
  path: string,
  location: 'localStorage' | 'OPFS' | 'IndexedDB' | 'Cache Storage',
};

export type DataDeletionPreview = {
  status: 'ready' | 'partial' | 'empty',
  entries: readonly DataDeletionPreviewEntry[],
  notes: readonly string[],
};

export type DataDeletionOptionSupport =
  | { status: 'available' }
  | { status: 'unavailable', message: string };

export type DataDeletionExecutionResult = {
  deletedSelectors: readonly string[],
  skippedSelectors: readonly { label: string, message: string }[],
  failedSelectors: readonly { label: string, message: string }[],
};

type IndexedDbFactoryWithDatabases = IDBFactory & {
  databases?: () => Promise<readonly { name?: string }[]>,
};

type IndexedDbDatabaseNames =
  | { status: 'available', names: readonly string[] }
  | { status: 'listingUnavailable' }
  | { status: 'unavailable' };

type DeleteSelectorResult =
  | { status: 'deleted' }
  | { status: 'skipped', message: string };

const NAIDAN_STORAGE_DIR = 'naidan-storage';
const MODELS_DIR = 'models';
const HOST_VOLUME_DB_NAME = 'naidan-volumes';
const LOCAL_STORAGE_NAIDAN_SYNC_PREFIX = `${STORAGE_KEY_PREFIX}sync:`;
const LOCAL_STORAGE_UNAVAILABLE_MESSAGE = 'localStorage is unavailable in this runtime.';
const OPFS_UNAVAILABLE_MESSAGE = 'OPFS is unavailable in this runtime.';
const INDEXED_DB_UNAVAILABLE_MESSAGE = 'IndexedDB is unavailable in this runtime.';
const INDEXED_DB_LISTING_UNAVAILABLE_MESSAGE = 'indexedDB.databases() is unavailable in this runtime.';
const CACHE_STORAGE_UNAVAILABLE_MESSAGE = 'Cache Storage is unavailable in this runtime.';

const LOCAL_STORAGE_KNOWN_KEYS = [
  THEME_MODE_STORAGE_KEY,
  FEATURE_FLAGS_STORAGE_KEY,
  STORAGE_BOOTSTRAP_KEY,
  SYNC_SIGNAL_KEY,
  SYNC_LOCK_KEY,
  LOCK_METADATA,
  OPFS_TMP_CLEANUP_LOCK_KEY,
  OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY,
] as const;

const LOCAL_STORAGE_KNOWN_PREFIXES = [
  `${STORAGE_KEY_PREFIX}lsp:`,
  LOCK_CHAT_CONTENT_PREFIX,
] as const;

export const DATA_DELETION_OPTIONS = [
  {
    id: 'local-storage-naidan-all',
    group: 'localStorage',
    label: 'localStorage: naidan:* all',
    description: 'All Naidan-prefixed localStorage keys.',
    selector: { kind: 'localStoragePrefix', prefix: STORAGE_KEY_PREFIX },
    advanced: false,
  },
  {
    id: 'local-storage-lsp',
    group: 'localStorage',
    label: 'localStorage: naidan:lsp:*',
    description: 'LocalStorageProvider chats, settings, groups, and hierarchy.',
    selector: { kind: 'localStoragePrefix', prefix: `${STORAGE_KEY_PREFIX}lsp:` },
    advanced: false,
  },
  {
    id: 'local-storage-theme-mode',
    group: 'localStorage',
    label: 'localStorage: naidan:theme_mode',
    description: 'Theme mode preference.',
    selector: { kind: 'localStorageKey', key: THEME_MODE_STORAGE_KEY },
    advanced: true,
  },
  {
    id: 'local-storage-feature-flags',
    group: 'localStorage',
    label: 'localStorage: naidan:feature_flags',
    description: 'Feature flag state.',
    selector: { kind: 'localStorageKey', key: FEATURE_FLAGS_STORAGE_KEY },
    advanced: true,
  },
  {
    id: 'local-storage-storage-type',
    group: 'localStorage',
    label: 'localStorage: naidan:storage_type',
    description: 'Storage bootstrap choice.',
    selector: { kind: 'localStorageKey', key: STORAGE_BOOTSTRAP_KEY },
    advanced: true,
  },
  {
    id: 'local-storage-sync',
    group: 'localStorage',
    label: 'localStorage: naidan:sync:*',
    description: 'Synchronization signals and locks.',
    selector: { kind: 'localStoragePrefix', prefix: LOCAL_STORAGE_NAIDAN_SYNC_PREFIX },
    advanced: true,
  },
  {
    id: 'local-storage-opfs-tmp-pending-owner-cleanups',
    group: 'localStorage',
    label: 'localStorage: naidan:opfs_tmp:pending_owner_cleanups',
    description: 'Pending OPFS tmp owner cleanups.',
    selector: { kind: 'localStorageKey', key: OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY },
    advanced: true,
  },
  {
    id: 'local-storage-naidan-unknown-legacy',
    group: 'localStorage',
    label: 'localStorage: naidan:* unknown / legacy',
    description: 'Naidan-prefixed keys not covered by known selectors.',
    selector: { kind: 'localStorageUnknownNaidanKeys' },
    advanced: true,
  },
  {
    id: 'opfs-naidan-storage',
    group: 'opfs',
    label: 'OPFS: /naidan-storage',
    description: 'OPFSStorageProvider persistent application data.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}` },
    advanced: false,
  },
  {
    id: 'opfs-naidan-storage-settings',
    group: 'opfs',
    label: 'OPFS: /naidan-storage/settings.json',
    description: 'OPFS settings file.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}/settings.json` },
    advanced: true,
  },
  {
    id: 'opfs-naidan-storage-hierarchy',
    group: 'opfs',
    label: 'OPFS: /naidan-storage/hierarchy.json',
    description: 'OPFS sidebar hierarchy file.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}/hierarchy.json` },
    advanced: true,
  },
  {
    id: 'opfs-naidan-storage-chat-metas',
    group: 'opfs',
    label: 'OPFS: /naidan-storage/chat-metas',
    description: 'OPFS chat metadata directory.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}/chat-metas` },
    advanced: true,
  },
  {
    id: 'opfs-naidan-storage-chat-contents',
    group: 'opfs',
    label: 'OPFS: /naidan-storage/chat-contents',
    description: 'OPFS chat content directory.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}/chat-contents` },
    advanced: true,
  },
  {
    id: 'opfs-naidan-storage-chat-groups',
    group: 'opfs',
    label: 'OPFS: /naidan-storage/chat-groups',
    description: 'OPFS chat group directory.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}/chat-groups` },
    advanced: true,
  },
  {
    id: 'opfs-naidan-storage-binary-objects',
    group: 'opfs',
    label: 'OPFS: /naidan-storage/binary-objects',
    description: 'Binary objects and attachment bodies.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}/binary-objects` },
    advanced: true,
  },
  {
    id: 'opfs-naidan-storage-volumes',
    group: 'opfs',
    label: 'OPFS: /naidan-storage/volumes',
    description: 'Managed OPFS volume directory.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}/volumes` },
    advanced: true,
  },
  {
    id: 'opfs-naidan-storage-volume-shards',
    group: 'opfs',
    label: 'OPFS: /naidan-storage/volume-shards',
    description: 'Managed OPFS volume shards.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}/volume-shards` },
    advanced: true,
  },
  {
    id: 'opfs-naidan-storage-migration-state',
    group: 'opfs',
    label: 'OPFS: /naidan-storage/migration-state.json',
    description: 'Storage migration state.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}/migration-state.json` },
    advanced: true,
  },
  {
    id: 'opfs-naidan-storage-uploaded-files',
    group: 'opfs',
    label: 'OPFS: /naidan-storage/uploaded-files',
    description: 'Legacy uploaded files area.',
    selector: { kind: 'opfsPath', path: `/${NAIDAN_STORAGE_DIR}/uploaded-files` },
    advanced: true,
  },
  {
    id: 'opfs-naidan-tmp',
    group: 'opfs',
    label: 'OPFS: /naidan-tmp',
    description: 'Temporary working directories.',
    selector: { kind: 'opfsPath', path: `/${OPFS_TMP_DIR}` },
    advanced: false,
  },
  {
    id: 'opfs-models',
    group: 'opfs',
    label: 'OPFS: /models',
    description: 'Transformers.js model cache.',
    selector: { kind: 'opfsPath', path: `/${MODELS_DIR}` },
    advanced: false,
  },
  {
    id: 'opfs-models-user',
    group: 'opfs',
    label: 'OPFS: /models/user',
    description: 'User-provided local model cache.',
    selector: { kind: 'opfsPath', path: `/${MODELS_DIR}/user` },
    advanced: true,
  },
  {
    id: 'opfs-models-remote',
    group: 'opfs',
    label: 'OPFS: /models/<remote-host>/...',
    description: 'Remote model cache directories.',
    selector: { kind: 'opfsRemoteModels' },
    advanced: true,
  },
  {
    id: 'indexed-db-naidan-volumes',
    group: 'indexedDb',
    label: 'IndexedDB: naidan-volumes',
    description: 'Stored host volume directory handles.',
    selector: { kind: 'indexedDbDatabase', name: HOST_VOLUME_DB_NAME },
    advanced: false,
  },
  {
    id: 'indexed-db-unknown-naidan-dbs',
    group: 'indexedDb',
    label: 'IndexedDB: unknown Naidan DBs',
    description: 'Naidan-named IndexedDB databases detected by indexedDB.databases().',
    selector: { kind: 'indexedDbUnknownNaidanDatabases' },
    advanced: true,
  },
  {
    id: 'cache-storage-all',
    group: 'cacheStorage',
    label: 'Cache Storage: all caches',
    description: 'All Cache Storage entries for this origin.',
    selector: { kind: 'cacheStorageAll' },
    advanced: false,
  },
  {
    id: 'cache-storage-naidan-named',
    group: 'cacheStorage',
    label: 'Cache Storage: Naidan-named caches only',
    description: 'Only cache names that contain naidan.',
    selector: { kind: 'cacheStorageNameIncludes', text: 'naidan' },
    advanced: true,
  },
] as const satisfies readonly DataDeletionOption[];

export const FACTORY_RESET_OPTION_IDS = [
  'local-storage-naidan-all',
  'opfs-naidan-storage',
  'opfs-naidan-tmp',
  'opfs-models',
  'indexed-db-naidan-volumes',
  'cache-storage-all',
] as const;

export function getVisibleDataDeletionOptions({ advancedMode }: { advancedMode: boolean }): readonly DataDeletionOption[] {
  return DATA_DELETION_OPTIONS.filter(option => advancedMode || !option.advanced);
}

export function groupDataDeletionOptions({ options }: { options: readonly DataDeletionOption[] }): readonly { group: DataDeletionGroup, options: readonly DataDeletionOption[] }[] {
  const groups: DataDeletionGroup[] = ['localStorage', 'opfs', 'indexedDb', 'cacheStorage'];
  return groups
    .map(group => ({
      group,
      options: options.filter(option => option.group === group),
    }))
    .filter(group => group.options.length > 0);
}

export function getDataDeletionOptionSupport({ option }: { option: DataDeletionOption }): DataDeletionOptionSupport {
  switch (option.selector.kind) {
  case 'localStoragePrefix':
  case 'localStorageKey':
  case 'localStorageUnknownNaidanKeys':
    return getLocalStorage() === undefined
      ? { status: 'unavailable', message: LOCAL_STORAGE_UNAVAILABLE_MESSAGE }
      : { status: 'available' };
  case 'opfsPath':
  case 'opfsRemoteModels':
    return isOpfsSupported()
      ? { status: 'available' }
      : { status: 'unavailable', message: OPFS_UNAVAILABLE_MESSAGE };
  case 'indexedDbDatabase':
    return getIndexedDb() === undefined
      ? { status: 'unavailable', message: INDEXED_DB_UNAVAILABLE_MESSAGE }
      : { status: 'available' };
  case 'indexedDbUnknownNaidanDatabases': {
    const indexedDb = getIndexedDb();
    if (indexedDb === undefined) {
      return { status: 'unavailable', message: INDEXED_DB_UNAVAILABLE_MESSAGE };
    }
    return getIndexedDbDatabases({ indexedDb }) === undefined
      ? { status: 'unavailable', message: INDEXED_DB_LISTING_UNAVAILABLE_MESSAGE }
      : { status: 'available' };
  }
  case 'cacheStorageAll':
  case 'cacheStorageNameIncludes':
    return getCacheStorage() === undefined
      ? { status: 'unavailable', message: CACHE_STORAGE_UNAVAILABLE_MESSAGE }
      : { status: 'available' };
  default: {
    const _ex: never = option.selector;
    return _ex;
  }
  }
}

export function normalizeDataDeletionOptionIds({ selectedOptionIds }: { selectedOptionIds: ReadonlySet<string> }): readonly string[] {
  const selectedOptions = DATA_DELETION_OPTIONS.filter(option => selectedOptionIds.has(option.id));
  const normalized: string[] = [];
  for (const option of selectedOptions) {
    const isIncluded = selectedOptions.some(parent => parent.id !== option.id && selectorIncludes({ parent: parent.selector, child: option.selector }));
    if (!isIncluded) {
      normalized.push(option.id);
    }
  }
  return normalized;
}

export async function createDataDeletionPreview({ selectedOptionIds }: { selectedOptionIds: ReadonlySet<string> }): Promise<DataDeletionPreview> {
  const normalizedIds = normalizeDataDeletionOptionIds({ selectedOptionIds });
  const options = DATA_DELETION_OPTIONS.filter(option => normalizedIds.includes(option.id));
  const entries: DataDeletionPreviewEntry[] = [];
  const notes: string[] = [];

  for (const option of options) {
    const result = await previewSelector({ selector: option.selector });
    entries.push(...result.entries);
    notes.push(...result.notes);
  }

  return {
    status: notes.length > 0 ? 'partial' : (entries.length > 0 ? 'ready' : 'empty'),
    entries,
    notes,
  };
}

export async function executeDataDeletion({ selectedOptionIds }: { selectedOptionIds: ReadonlySet<string> }): Promise<DataDeletionExecutionResult> {
  const normalizedIds = normalizeDataDeletionOptionIds({ selectedOptionIds });
  const options = DATA_DELETION_OPTIONS.filter(option => normalizedIds.includes(option.id));
  const deletedSelectors: string[] = [];
  const skippedSelectors: { label: string, message: string }[] = [];
  const failedSelectors: { label: string, message: string }[] = [];

  for (const option of options) {
    try {
      const result = await deleteSelector({ selector: option.selector });
      switch (result.status) {
      case 'deleted':
        deletedSelectors.push(option.label);
        break;
      case 'skipped':
        skippedSelectors.push({ label: option.label, message: result.message });
        break;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled delete selector result: ${JSON.stringify(_ex)}`);
      }
      }
    } catch (error) {
      failedSelectors.push({
        label: option.label,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    deletedSelectors,
    skippedSelectors,
    failedSelectors,
  };
}

function selectorIncludes({ parent, child }: { parent: DataDeletionSelector, child: DataDeletionSelector }): boolean {
  switch (parent.kind) {
  case 'localStoragePrefix':
    switch (child.kind) {
    case 'localStoragePrefix':
      return child.prefix.startsWith(parent.prefix);
    case 'localStorageKey':
      return child.key.startsWith(parent.prefix);
    case 'localStorageUnknownNaidanKeys':
      return STORAGE_KEY_PREFIX.startsWith(parent.prefix);
    case 'opfsPath':
    case 'opfsRemoteModels':
    case 'indexedDbDatabase':
    case 'indexedDbUnknownNaidanDatabases':
    case 'cacheStorageAll':
    case 'cacheStorageNameIncludes':
      return false;
    default: {
      const _ex: never = child;
      return _ex;
    }
    }
  case 'opfsPath':
    switch (child.kind) {
    case 'opfsPath':
      return isSameOrChildPath({ parentPath: parent.path, childPath: child.path });
    case 'opfsRemoteModels':
      return isSameOrChildPath({ parentPath: parent.path, childPath: `/${MODELS_DIR}` });
    case 'localStoragePrefix':
    case 'localStorageKey':
    case 'localStorageUnknownNaidanKeys':
    case 'indexedDbDatabase':
    case 'indexedDbUnknownNaidanDatabases':
    case 'cacheStorageAll':
    case 'cacheStorageNameIncludes':
      return false;
    default: {
      const _ex: never = child;
      return _ex;
    }
    }
  case 'cacheStorageAll':
    return child.kind === 'cacheStorageNameIncludes';
  case 'localStorageKey':
  case 'localStorageUnknownNaidanKeys':
  case 'opfsRemoteModels':
  case 'indexedDbDatabase':
  case 'indexedDbUnknownNaidanDatabases':
  case 'cacheStorageNameIncludes':
    return false;
  default: {
    const _ex: never = parent;
    return _ex;
  }
  }
}

function isSameOrChildPath({ parentPath, childPath }: { parentPath: string, childPath: string }): boolean {
  const normalizedParent = normalizeOpfsPath({ path: parentPath });
  const normalizedChild = normalizeOpfsPath({ path: childPath });
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

async function previewSelector({ selector }: { selector: DataDeletionSelector }): Promise<{ entries: readonly DataDeletionPreviewEntry[], notes: readonly string[] }> {
  switch (selector.kind) {
  case 'localStoragePrefix':
    return previewLocalStorageKeys({ keys: getLocalStorageKeysByPrefix({ prefix: selector.prefix }) });
  case 'localStorageKey':
    return previewLocalStorageKeys({ keys: getLocalStorageKeyIfExists({ key: selector.key }) });
  case 'localStorageUnknownNaidanKeys':
    return previewLocalStorageKeys({ keys: getUnknownLocalStorageNaidanKeys() });
  case 'opfsPath':
    return previewOpfsPathSelector({ path: selector.path });
  case 'opfsRemoteModels':
    return previewRemoteModelsSelector();
  case 'indexedDbDatabase':
    return previewIndexedDbDatabase({ name: selector.name });
  case 'indexedDbUnknownNaidanDatabases':
    return previewUnknownNaidanIndexedDbs();
  case 'cacheStorageAll':
    return previewCacheStorage({ filter: undefined });
  case 'cacheStorageNameIncludes':
    return previewCacheStorage({ filter: selector.text });
  default: {
    const _ex: never = selector;
    return _ex;
  }
  }
}

async function deleteSelector({ selector }: { selector: DataDeletionSelector }): Promise<DeleteSelectorResult> {
  switch (selector.kind) {
  case 'localStoragePrefix':
    return deleteLocalStorageKeys({ keys: getLocalStorageKeysByPrefix({ prefix: selector.prefix }) });
  case 'localStorageKey':
    return deleteLocalStorageKeys({ keys: getLocalStorageKeyIfExists({ key: selector.key }) });
  case 'localStorageUnknownNaidanKeys':
    return deleteLocalStorageKeys({ keys: getUnknownLocalStorageNaidanKeys() });
  case 'opfsPath':
    return await deleteOpfsPath({ path: selector.path });
  case 'opfsRemoteModels':
    return await deleteRemoteModelDirectories();
  case 'indexedDbDatabase':
    return await deleteIndexedDbDatabase({ name: selector.name });
  case 'indexedDbUnknownNaidanDatabases':
    return await deleteUnknownNaidanIndexedDbs();
  case 'cacheStorageAll':
    return await deleteCacheStorage({ filter: undefined });
  case 'cacheStorageNameIncludes':
    return await deleteCacheStorage({ filter: selector.text });
  default: {
    const _ex: never = selector;
    return _ex;
  }
  }
}

function getLocalStorage(): Storage | undefined {
  try {
    if (typeof globalThis.localStorage === 'undefined') return undefined;
    const storage = globalThis.localStorage;
    void storage.length;
    return storage;
  } catch {
    return undefined;
  }
}

function getIndexedDb(): IDBFactory | undefined {
  try {
    return typeof indexedDB === 'undefined' ? undefined : indexedDB;
  } catch {
    return undefined;
  }
}

function getCacheStorage(): CacheStorage | undefined {
  try {
    return typeof caches === 'undefined' ? undefined : caches;
  } catch {
    return undefined;
  }
}

function isOpfsSupported(): boolean {
  return typeof navigator !== 'undefined' && navigator.storage?.getDirectory !== undefined;
}

function getIndexedDbDatabases({ indexedDb }: { indexedDb: IDBFactory }): (() => Promise<readonly { name?: string }[]>) | undefined {
  return (indexedDb as IndexedDbFactoryWithDatabases).databases;
}

function getLocalStorageKeysByPrefix({ prefix }: { prefix: string }): readonly string[] {
  const storage = getLocalStorage();
  if (storage === undefined) return [];

  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(prefix)) {
      keys.push(key);
    }
  }
  return keys.sort();
}

function getLocalStorageKeyIfExists({ key }: { key: string }): readonly string[] {
  const storage = getLocalStorage();
  if (storage === undefined || storage.getItem(key) === null) return [];
  return [key];
}

function getUnknownLocalStorageNaidanKeys(): readonly string[] {
  return getLocalStorageKeysByPrefix({ prefix: STORAGE_KEY_PREFIX }).filter(key => {
    if (LOCAL_STORAGE_KNOWN_KEYS.includes(key as typeof LOCAL_STORAGE_KNOWN_KEYS[number])) {
      return false;
    }
    return !LOCAL_STORAGE_KNOWN_PREFIXES.some(prefix => key.startsWith(prefix));
  });
}

function previewLocalStorageKeys({ keys }: { keys: readonly string[] }): { entries: readonly DataDeletionPreviewEntry[], notes: readonly string[] } {
  const storage = getLocalStorage();
  if (storage === undefined) {
    return {
      entries: [],
      notes: [LOCAL_STORAGE_UNAVAILABLE_MESSAGE],
    };
  }

  return {
    entries: keys.map(key => ({ path: key, location: 'localStorage' as const })),
    notes: [],
  };
}

function deleteLocalStorageKeys({ keys }: { keys: readonly string[] }): DeleteSelectorResult {
  const storage = getLocalStorage();
  if (storage === undefined) return { status: 'skipped', message: LOCAL_STORAGE_UNAVAILABLE_MESSAGE };
  for (const key of keys) {
    storage.removeItem(key);
  }
  return { status: 'deleted' };
}

function getOpfsApi(): { getDirectory: () => Promise<FileSystemDirectoryHandle> } | undefined {
  if (!isOpfsSupported()) {
    return undefined;
  }
  return {
    getDirectory: () => navigator.storage.getDirectory(),
  };
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle | undefined> {
  const api = getOpfsApi();
  if (api === undefined) return undefined;
  try {
    return await api.getDirectory();
  } catch {
    return undefined;
  }
}

async function previewOpfsPathSelector({ path }: { path: string }): Promise<{ entries: readonly DataDeletionPreviewEntry[], notes: readonly string[] }> {
  const root = await getOpfsRoot();
  if (root === undefined) {
    return {
      entries: [],
      notes: [OPFS_UNAVAILABLE_MESSAGE],
    };
  }

  const resolved = await resolveOpfsHandle({ root, path });
  if (resolved === undefined) {
    return {
      entries: [],
      notes: [`OPFS path not found: ${path}`],
    };
  }

  return {
    entries: [{ path: normalizeOpfsPath({ path }), location: 'OPFS' }],
    notes: [],
  };
}

async function previewRemoteModelsSelector(): Promise<{ entries: readonly DataDeletionPreviewEntry[], notes: readonly string[] }> {
  const root = await getOpfsRoot();
  if (root === undefined) {
    return {
      entries: [],
      notes: [OPFS_UNAVAILABLE_MESSAGE],
    };
  }

  const models = await getChildDirectoryIfExists({ parent: root, name: MODELS_DIR });
  if (models === undefined) {
    return {
      entries: [],
      notes: [`OPFS path not found: /${MODELS_DIR}`],
    };
  }

  const entries: DataDeletionPreviewEntry[] = [];
  for await (const child of models.values()) {
    if (child.kind === 'directory' && child.name !== 'user') {
      entries.push({ path: `/${MODELS_DIR}/${child.name}`, location: 'OPFS' });
    }
  }

  return {
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
    notes: [],
  };
}

async function deleteOpfsPath({ path }: { path: string }): Promise<DeleteSelectorResult> {
  const root = await getOpfsRoot();
  if (root === undefined) return { status: 'skipped', message: OPFS_UNAVAILABLE_MESSAGE };

  const segments = getOpfsPathSegments({ path });
  if (segments.length === 0) return { status: 'deleted' };

  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    const next = await getChildDirectoryIfExists({ parent, name: segment });
    if (next === undefined) return { status: 'deleted' };
    parent = next;
  }

  const target = segments.at(-1);
  if (target === undefined) return { status: 'deleted' };
  await parent.removeEntry(target, { recursive: true }).catch(error => {
    if (isNotFoundError({ error })) return;
    throw error;
  });
  return { status: 'deleted' };
}

async function deleteRemoteModelDirectories(): Promise<DeleteSelectorResult> {
  const root = await getOpfsRoot();
  if (root === undefined) return { status: 'skipped', message: OPFS_UNAVAILABLE_MESSAGE };
  const models = await getChildDirectoryIfExists({ parent: root, name: MODELS_DIR });
  if (models === undefined) return { status: 'deleted' };
  const names: string[] = [];
  for await (const child of models.values()) {
    if (child.kind === 'directory' && child.name !== 'user') {
      names.push(child.name);
    }
  }
  for (const name of names) {
    await models.removeEntry(name, { recursive: true });
  }
  return { status: 'deleted' };
}

async function resolveOpfsHandle({ root, path }: { root: FileSystemDirectoryHandle, path: string }): Promise<FileSystemHandle | undefined> {
  const segments = getOpfsPathSegments({ path });
  if (segments.length === 0) return root;

  let current: FileSystemDirectoryHandle = root;
  for (const segment of segments.slice(0, -1)) {
    const next = await getChildDirectoryIfExists({ parent: current, name: segment });
    if (next === undefined) return undefined;
    current = next;
  }

  const finalSegment = segments.at(-1);
  if (finalSegment === undefined) return current;

  const directory = await getChildDirectoryIfExists({ parent: current, name: finalSegment });
  if (directory !== undefined) return directory;
  return await getChildFileIfExists({ parent: current, name: finalSegment });
}

async function getChildDirectoryIfExists({ parent, name }: { parent: FileSystemDirectoryHandle, name: string }): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (error) {
    if (isNotFoundError({ error })) return undefined;
    throw error;
  }
}

async function getChildFileIfExists({ parent, name }: { parent: FileSystemDirectoryHandle, name: string }): Promise<FileSystemFileHandle | undefined> {
  try {
    return await parent.getFileHandle(name);
  } catch (error) {
    if (isNotFoundError({ error })) return undefined;
    throw error;
  }
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof Error && (error.name === 'NotFoundError' || ('code' in error && error.code === 8));
}

function normalizeOpfsPath({ path }: { path: string }): string {
  return `/${getOpfsPathSegments({ path }).join('/')}`;
}

function getOpfsPathSegments({ path }: { path: string }): string[] {
  return path.split('/').filter(segment => segment.length > 0);
}

async function previewIndexedDbDatabase({ name }: { name: string }): Promise<{ entries: readonly DataDeletionPreviewEntry[], notes: readonly string[] }> {
  const databaseNames = await getIndexedDbDatabaseNames();
  switch (databaseNames.status) {
  case 'unavailable':
    return {
      entries: [],
      notes: [INDEXED_DB_UNAVAILABLE_MESSAGE],
    };
  case 'listingUnavailable':
    return {
      entries: [{ path: name, location: 'IndexedDB' }],
      notes: [INDEXED_DB_LISTING_UNAVAILABLE_MESSAGE],
    };
  case 'available':
    break;
  default: {
    const _ex: never = databaseNames;
    return _ex;
  }
  }

  if (!databaseNames.names.includes(name)) {
    return {
      entries: [],
      notes: [`IndexedDB database not found: ${name}`],
    };
  }

  return {
    entries: [{ path: name, location: 'IndexedDB' }],
    notes: [],
  };
}

async function previewUnknownNaidanIndexedDbs(): Promise<{ entries: readonly DataDeletionPreviewEntry[], notes: readonly string[] }> {
  const databaseNames = await getIndexedDbDatabaseNames();
  switch (databaseNames.status) {
  case 'unavailable':
    return {
      entries: [],
      notes: [INDEXED_DB_UNAVAILABLE_MESSAGE],
    };
  case 'listingUnavailable':
    return {
      entries: [],
      notes: [INDEXED_DB_LISTING_UNAVAILABLE_MESSAGE],
    };
  case 'available':
    break;
  default: {
    const _ex: never = databaseNames;
    return _ex;
  }
  }

  const names = databaseNames.names.filter(name => name.toLowerCase().includes('naidan') && name !== HOST_VOLUME_DB_NAME);
  return {
    entries: names.map(name => ({ path: name, location: 'IndexedDB' as const })),
    notes: [],
  };
}

async function deleteIndexedDbDatabase({ name }: { name: string }): Promise<DeleteSelectorResult> {
  const indexedDb = getIndexedDb();
  if (indexedDb === undefined) return { status: 'skipped', message: INDEXED_DB_UNAVAILABLE_MESSAGE };
  await new Promise<void>((resolve, reject) => {
    const request = indexedDb.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Failed to delete IndexedDB database: ${name}`));
    request.onblocked = () => reject(new Error(`IndexedDB deletion was blocked: ${name}`));
  });
  return { status: 'deleted' };
}

async function deleteUnknownNaidanIndexedDbs(): Promise<DeleteSelectorResult> {
  const databaseNames = await getIndexedDbDatabaseNames();
  switch (databaseNames.status) {
  case 'unavailable':
    return { status: 'skipped', message: INDEXED_DB_UNAVAILABLE_MESSAGE };
  case 'listingUnavailable':
    return { status: 'skipped', message: INDEXED_DB_LISTING_UNAVAILABLE_MESSAGE };
  case 'available':
    break;
  default: {
    const _ex: never = databaseNames;
    return _ex;
  }
  }

  const names = databaseNames.names.filter(name => name.toLowerCase().includes('naidan') && name !== HOST_VOLUME_DB_NAME);
  for (const name of names) {
    await deleteIndexedDbDatabase({ name });
  }
  return { status: 'deleted' };
}

async function getIndexedDbDatabaseNames(): Promise<IndexedDbDatabaseNames> {
  const indexedDb = getIndexedDb();
  if (indexedDb === undefined) {
    return { status: 'unavailable' };
  }
  const databasesMethod = getIndexedDbDatabases({ indexedDb });
  if (databasesMethod === undefined) {
    return { status: 'listingUnavailable' };
  }
  try {
    const databases = await databasesMethod.call(indexedDb);
    return {
      status: 'available',
      names: databases.map(database => database.name).filter((name): name is string => name !== undefined).sort(),
    };
  } catch {
    return { status: 'listingUnavailable' };
  }
}

async function previewCacheStorage({ filter }: { filter: string | undefined }): Promise<{ entries: readonly DataDeletionPreviewEntry[], notes: readonly string[] }> {
  const cacheStorage = getCacheStorage();
  if (cacheStorage === undefined) {
    return {
      entries: [],
      notes: [CACHE_STORAGE_UNAVAILABLE_MESSAGE],
    };
  }

  let names: string[];
  try {
    names = (await cacheStorage.keys())
      .filter(name => filter === undefined || name.toLowerCase().includes(filter.toLowerCase()))
      .sort();
  } catch {
    return {
      entries: [],
      notes: [CACHE_STORAGE_UNAVAILABLE_MESSAGE],
    };
  }
  return {
    entries: names.map(name => ({ path: name, location: 'Cache Storage' as const })),
    notes: [],
  };
}

async function deleteCacheStorage({ filter }: { filter: string | undefined }): Promise<DeleteSelectorResult> {
  const cacheStorage = getCacheStorage();
  if (cacheStorage === undefined) return { status: 'skipped', message: CACHE_STORAGE_UNAVAILABLE_MESSAGE };
  let names: string[];
  try {
    names = (await cacheStorage.keys()).filter(name => filter === undefined || name.toLowerCase().includes(filter.toLowerCase()));
  } catch {
    return { status: 'skipped', message: CACHE_STORAGE_UNAVAILABLE_MESSAGE };
  }
  for (const name of names) {
    await cacheStorage.delete(name);
  }
  return { status: 'deleted' };
}

export const TEST_ONLY = {
  LOCAL_STORAGE_KNOWN_KEYS,
  LOCAL_STORAGE_KNOWN_PREFIXES,
  selectorIncludes,
};
