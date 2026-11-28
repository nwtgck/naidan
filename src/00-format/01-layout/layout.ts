import * as layout from './layout-entries';
import { experimentalIndexedDbEntries, experimentalLocalStorageEntries, experimentalOpfsEntries, workflowResultsLayout } from './experimental.layout';
import { localCoreRecords, opfsCoreRecords } from '@/00-format/core-records';
import { binaryObjectRecord } from '@/00-format/binary-object-record';
import { bootstrapStorageTypeRecord } from '@/00-format/bootstrap-storage-type';
import { hostVolumeHandleRecords } from '@/00-format/indexed-db-records';
import { modelCacheOpfsRoot } from '@/00-format/model-cache-root';
import { binaryShardIndexFormat, volumeShardIndexFormat } from '@/00-format/shard-indexes';
import { idToRaw, toOPFSTmpOwnerScopeId, type BinaryObjectId, type OPFSTmpDirectoryId, type OPFSTmpOwnerScopeId, type VolumeId } from '@/01-models/ids';
import * as dtozod from '@/utils/dtozod';
import { mergeLegacyUploadedFileMetadata, readLegacyUploadedFileMetadata, remapLegacyUploadedFileReferences, selectMigratedUploadedFileMetadata } from '@/00-format/migrations/legacy-uploaded-file-content';
import { listLegacyAttachmentSources } from '@/00-format/migrations/legacy-uploaded-file-sources';
import { migrationStateFile } from '@/00-format/migrations/migration-state';
import { createLegacyUploadedFileId } from '@/00-format/migrations/legacy-uploaded-file-id';
import { featureFlagsRecord } from '@/00-format/feature-flags';
import { themeModeFormat } from '@/00-format/theme-mode';

export const STORAGE_KEY_PREFIX = 'naidan:';
export const FEATURE_FLAGS_STORAGE_KEY = `${STORAGE_KEY_PREFIX}feature_flags`;
export const STORAGE_BOOTSTRAP_KEY = `${STORAGE_KEY_PREFIX}storage_type`;
export const OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY = `${STORAGE_KEY_PREFIX}opfs_tmp:pending_owner_cleanups`;

function weshTerminalDirectory({ name, homeUser }: { name: string, homeUser: string }) {
  return layout.directory({
    parent: [],
    name,
    entries: ({ path }) => ({
      global: layout.directory({
        parent: path,
        name: 'global',
        entries: ({ path }) => ({
          home: layout.entry({ parent: [...path, 'home'], name: homeUser }),
          tmp: layout.entry({ parent: path, name: 'tmp' }),
        }),
      }),
    }),
  });
}

const legacyStoragePath = ['naidan-storage'] as const;
const tmp = layout.directory({
  parent: [],
  name: 'naidan-tmp',
  entries: ({ path }) => ({
    owner({ id }: { id: OPFSTmpOwnerScopeId }) {
      return layout.entry({ parent: path, name: idToRaw({ id }) });
    },
    directoryName: ({ prefix, id }: { prefix: string, id: OPFSTmpDirectoryId }) => prefix + '-' + idToRaw({ id }),
    workflowResults: workflowResultsLayout({ tmpPath: path }),
  }),
});

export const opfsFormat = {
  storage: layout.directory({
    parent: [],
    name: 'naidan-storage',
    entries: ({ path }) => ({
      ...opfsCoreRecords({
        settings: layout.entry({ parent: path, name: 'settings.json' }),
        hierarchy: layout.entry({ parent: path, name: 'hierarchy.json' }),
        chatMetas: layout.entry({ parent: path, name: 'chat-metas' }),
        chatContents: layout.entry({ parent: path, name: 'chat-contents' }),
        chatGroups: layout.entry({ parent: path, name: 'chat-groups' }),
      }),
      binaryObjects: layout.directory({
        parent: path,
        name: 'binary-objects',
        entries: ({ path }) => ({
          shardName: ({ id }: { id: BinaryObjectId }) => layout.storageShardName({ rawId: idToRaw({ id }) }),
          index: binaryShardIndexFormat({ parent: path, name: 'index.json' }),
          files({ id }: { id: BinaryObjectId }) {
            const rawId = idToRaw({ id });
            const parent = [...path, layout.storageShardName({ rawId })];
            return binaryObjectRecord({
              parentPath: parent,
              body: rawId + '.bin',
              // The body is readable only after this empty marker exists.
              complete: '.' + rawId + '.bin.complete',
            });
          },
        }),
      }),
      volumes: layout.directory({
        parent: path,
        name: 'volumes',
        entries: ({ path }) => ({
          index: volumeShardIndexFormat({ parent: path, name: 'index.json' }),
          root({ id }: { id: VolumeId }) {
            const rawId = idToRaw({ id });
            return layout.entry({ parent: [...path, layout.storageShardName({ rawId })], name: rawId });
          },
        }),
      }),
      experimental: layout.directory({
        parent: path,
        name: 'experimental',
        entries: ({ path }) => experimentalOpfsEntries({ path, matchesWorkflowResultsPath: tmp.workflowResults.matchesPath }),
      }),
      // V1 stores each attachment at uploaded-files/<attachmentId>/<originalName>.
      uploadedFiles: layout.entry({ parent: legacyStoragePath, name: 'uploaded-files' }),
      // Retained for explicit deletion of the historical directory.
      volumeShards: layout.entry({ parent: legacyStoragePath, name: 'volume-shards' }),
      migrationState: migrationStateFile({ file: layout.entry({ parent: path, name: 'migration-state.json' }) }),
    }),
  }),
  chatWesh: weshTerminalDirectory({ name: 'naidan-chat-wesh', homeUser: 'user' }),
  debugWesh: weshTerminalDirectory({ name: 'naidan-debug-wesh', homeUser: 'debug' }),
  tmp,
  models: modelCacheOpfsRoot,
};

export const storageMigrations = {
  uploadedFilesToBinaryObjects: {
    id: 'v1_uploaded_files_to_binary_objects',
    from: opfsFormat.storage.uploadedFiles,
    listSources: listLegacyAttachmentSources,
    chatContents: layout.entry({ parent: legacyStoragePath, name: 'chat-contents' }),
    isChatContentFile: ({ name }: { name: string }) => name.endsWith('.json'),
    readMetadata: readLegacyUploadedFileMetadata,
    mergeMetadata: mergeLegacyUploadedFileMetadata,
    selectMetadata: selectMigratedUploadedFileMetadata,
    rewriteReferences: remapLegacyUploadedFileReferences,
    toBinaryObjectId: createLegacyUploadedFileId,
  },
} as const;

const lspPrefix = STORAGE_KEY_PREFIX + 'lsp:';

const PendingOwnerCleanupSchema = dtozod.object({
  ownerScopeIds: dtozod.array(dtozod.string()),
});

export const localStorageFormat = {
  prefix: STORAGE_KEY_PREFIX,
  provider: {
    prefix: lspPrefix,
    ...localCoreRecords({
      settings: lspPrefix + 'settings',
      hierarchy: lspPrefix + 'hierarchy',
      chatMetas: lspPrefix + 'chat_meta:',
      chatGroups: lspPrefix + 'chat_group:',
      chatContents: lspPrefix + 'chat_content:',
    }),
    ownsKey({ key }: { key: string }): boolean {
      return key.startsWith(lspPrefix);
    },
    ...experimentalLocalStorageEntries({ prefix: lspPrefix }),
  },
  featureFlags: featureFlagsRecord({ key: FEATURE_FLAGS_STORAGE_KEY }),
  themeMode: themeModeFormat,
  storageType: bootstrapStorageTypeRecord({ key: STORAGE_BOOTSTRAP_KEY }),
  pendingTmpCleanups: {
    key: OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY,
    read({ storage }: { storage: Pick<Storage, 'getItem'> }): OPFSTmpOwnerScopeId[] {
      const text = storage.getItem(OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY);
      return text ? PendingOwnerCleanupSchema.parse(JSON.parse(text)).ownerScopeIds.map(raw => toOPFSTmpOwnerScopeId({ raw })) : [];
    },
    write({ storage, ownerScopeIds }: { storage: Pick<Storage, 'setItem'>, ownerScopeIds: readonly OPFSTmpOwnerScopeId[] }): void {
      const dto = PendingOwnerCleanupSchema.parse({ ownerScopeIds: Array.from(new Set(ownerScopeIds), id => idToRaw({ id })) });
      storage.setItem(OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY, JSON.stringify(dto));
    },
  },
};

export const indexedDbFormat = {
  hostVolumes: hostVolumeHandleRecords({
    name: 'naidan-volumes',
    version: 1,
    store: {
      name: 'handles',
      options: { keyPath: null, autoIncrement: false },
    },
  }),
  ...experimentalIndexedDbEntries,
} as const;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
