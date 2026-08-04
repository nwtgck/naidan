type NaidanOpfsRootDirectoryRegistryEntry = Readonly<{
  containerRootDisposition: 'copy_into_container_root' | 'outside_container_root';
  directoryName: string;
  purpose: 'application_storage' | 'reconstructible_model_cache' | 'special_file_system';
}>;

/**
 * Register every Naidan-owned raw OPFS root here.
 *
 * The disposition is deliberately mandatory: introducing a new raw root must
 * make its container-root encryption boundary an explicit review decision.
 * Consumers derive names and routing types from this registry so a rename or
 * policy change propagates instead of leaving transition and runtime paths out
 * of sync.
 */
export const NAIDAN_OPFS_ROOT_DIRECTORY_REGISTRY = {
  storage: {
    containerRootDisposition: 'copy_into_container_root',
    directoryName: 'naidan-storage',
    purpose: 'application_storage',
  },
  chat_wesh: {
    containerRootDisposition: 'copy_into_container_root',
    directoryName: 'naidan-chat-wesh',
    purpose: 'special_file_system',
  },
  debug_wesh: {
    containerRootDisposition: 'copy_into_container_root',
    directoryName: 'naidan-debug-wesh',
    purpose: 'special_file_system',
  },
  tmp: {
    containerRootDisposition: 'copy_into_container_root',
    directoryName: 'naidan-tmp',
    purpose: 'special_file_system',
  },
  models: {
    containerRootDisposition: 'outside_container_root',
    directoryName: 'models',
    purpose: 'reconstructible_model_cache',
  },
} as const satisfies Readonly<Record<string, NaidanOpfsRootDirectoryRegistryEntry>>;

type NaidanOpfsRootDirectoryRegistry = typeof NAIDAN_OPFS_ROOT_DIRECTORY_REGISTRY;
type NaidanOpfsRootDirectoryDefinition = NaidanOpfsRootDirectoryRegistry[keyof NaidanOpfsRootDirectoryRegistry];

export type NaidanOpfsRootDirectoryType = keyof NaidanOpfsRootDirectoryRegistry;
export type NaidanOpfsRootDirectoryName = NaidanOpfsRootDirectoryDefinition['directoryName'];

type RootDirectoryTypeWith<
  Property extends keyof NaidanOpfsRootDirectoryDefinition,
  Value,
> = {
  [Type in NaidanOpfsRootDirectoryType]:
    NaidanOpfsRootDirectoryRegistry[Type][Property] extends Value ? Type : never;
}[NaidanOpfsRootDirectoryType];

export type NaidanOpfsContainerRootDirectoryType = RootDirectoryTypeWith<
  'containerRootDisposition',
  'copy_into_container_root'
>;

export type NaidanOpfsContainerRootDirectoryName = {
  [Type in NaidanOpfsContainerRootDirectoryType]:
    NaidanOpfsRootDirectoryRegistry[Type]['directoryName'];
}[NaidanOpfsContainerRootDirectoryType];

export type OpfsSpecialFileSystemType = RootDirectoryTypeWith<
  'purpose',
  'special_file_system'
>;

export type NaidanOpfsSpecialFileSystemDirectoryName = {
  [Type in OpfsSpecialFileSystemType]:
    NaidanOpfsRootDirectoryRegistry[Type]['directoryName'];
}[OpfsSpecialFileSystemType];

export const NAIDAN_OPFS_STORAGE_DIRECTORY_NAME =
  NAIDAN_OPFS_ROOT_DIRECTORY_REGISTRY.storage.directoryName;
export const NAIDAN_OPFS_MODELS_DIRECTORY_NAME =
  NAIDAN_OPFS_ROOT_DIRECTORY_REGISTRY.models.directoryName;

function registryEntries(): ReadonlyArray<readonly [
  NaidanOpfsRootDirectoryType,
  NaidanOpfsRootDirectoryDefinition,
]> {
  return Object.entries(NAIDAN_OPFS_ROOT_DIRECTORY_REGISTRY) as Array<[
    NaidanOpfsRootDirectoryType,
    NaidanOpfsRootDirectoryDefinition,
  ]>;
}

function validateRegistry(): void {
  const directoryNames = new Set<string>();
  for (const [, definition] of registryEntries()) {
    if (directoryNames.has(definition.directoryName)) {
      throw new TypeError(`duplicate Naidan OPFS root directory name: ${definition.directoryName}`);
    }
    directoryNames.add(definition.directoryName);
  }
}

validateRegistry();

export const NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_TYPES = Object.freeze(
  registryEntries()
    .filter(([, definition]) => definition.containerRootDisposition === 'copy_into_container_root')
    .map(([type]) => type as NaidanOpfsContainerRootDirectoryType),
);

export const NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES = Object.freeze(
  NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_TYPES.map(
    type => NAIDAN_OPFS_ROOT_DIRECTORY_REGISTRY[type].directoryName,
  ),
) as readonly NaidanOpfsContainerRootDirectoryName[];

export const NAIDAN_OPFS_SPECIAL_FILE_SYSTEM_DIRECTORY_NAMES = Object.freeze(
  registryEntries()
    .filter(([, definition]) => definition.purpose === 'special_file_system')
    .map(([, definition]) => definition.directoryName as NaidanOpfsSpecialFileSystemDirectoryName),
);

export function getNaidanOpfsRootDirectoryName({ type }: {
  type: NaidanOpfsRootDirectoryType;
}): NaidanOpfsRootDirectoryName {
  return NAIDAN_OPFS_ROOT_DIRECTORY_REGISTRY[type].directoryName;
}

export function getNaidanOpfsSpecialFileSystemDirectoryName({ type }: {
  type: OpfsSpecialFileSystemType;
}): NaidanOpfsSpecialFileSystemDirectoryName {
  return NAIDAN_OPFS_ROOT_DIRECTORY_REGISTRY[type].directoryName;
}

export function parseNaidanOpfsContainerRootDirectoryName({ name }: {
  name: string;
}): NaidanOpfsContainerRootDirectoryName | undefined {
  for (const candidate of NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES) {
    if (candidate === name) return candidate;
  }
  return undefined;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  registryEntries,
  validateRegistry,
};
