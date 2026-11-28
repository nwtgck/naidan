import type { FileLocation, ReadFileText, WriteFileText } from '@/00-format/file-record';
import * as layout from './layout-entries';
import { assertImageGenerationSessionIdentity, parseImageGenerationRawId, unavailableImageGenerationRunRecord, type ImageGenerationIo } from '@/00-format/image-generation-record';
import { imageGenerationOperationToDomain, imageGenerationOperationToDto, validateImageGenerationOperation } from '@/00-format/image-generation-operation';
import { imageGenerationAssetToIndexSummary, imageGenerationRunToIndexSummary } from '@/00-format/image-generation-index';
import { imageGenerationAnnotationsToDomain, imageGenerationAnnotationsToDto, imageGenerationAssetSummaryToDomain, imageGenerationAssetToDomain, imageGenerationAssetToDto, imageGenerationRunSummaryToDomain, imageGenerationRunToDomain, imageGenerationRunToDto, imageGenerationSessionToDomain, imageGenerationSessionToDto } from '@/00-format/mapper/image-generation';
import { imageGenerationActivity, imageGenerationBinaryDeletion, imageGenerationCatalog, imageGenerationCompositionDraft, imageGenerationDraft } from '@/00-format/image-generation-workspace';
import { imageGenerationHistory } from '@/00-format/image-generation-history';
import { imageWorkspaceTable } from '@/00-format/image-generation-table';
import { createWorkflowDocumentFormat, createWorkflowRunFormat } from '@/00-format/workflow-records';
import { workflowResultsFormat } from '@/00-format/workflow-results';
import type { ImageGenerationRun, ImageGenerationSession } from '@/01-models/image-generation';
import type { ImageGenerationSessionId } from '@/01-models/ids';
import type { NaidanRpcIdentity } from '@/01-models/naidan-rpc';
import {
  ExperimentalImageGenerationAnnotationsIndexDtoSchema,
  ExperimentalImageGenerationAssetAnnotationsDtoSchema,
  ExperimentalImageGenerationAssetDtoSchema,
  ExperimentalImageGenerationAssetIndexDtoSchema,
  ExperimentalImageGenerationOperationDtoSchema,
  ExperimentalImageGenerationOperationIndexDtoSchema,
  ExperimentalImageGenerationRunDtoSchema,
  ExperimentalImageGenerationRunIndexDtoSchema,
  ExperimentalImageGenerationSessionDtoSchema,
  ExperimentalImageGenerationSessionIndexDtoSchema,
  type ExperimentalImageGenerationRunDto,
  type ExperimentalImageGenerationSessionDto,
} from '@/00-format/00-dto/experimental-image-generation.dto';
import { modelGraphRegistryFormat } from '@/00-format/model-graph-registry';
import { naidanRpcRegistryFormat } from '@/00-format/naidan-rpc-registry';
import { ExperimentalNaidanRpcIdentityDtoSchema } from '@/00-format/00-dto/experimental-naidan-rpc.dto';
import { hostModelDirectoryRecords, rpcIdentityRecord } from '@/00-format/indexed-db-records';

function registryFile<D>({ file, parse }: {
  file: FileLocation, parse({ value }: { value: unknown }): D,
}) {
  return {
    async readForTransfer({ readText }: { readText: ReadFileText }): Promise<D | undefined> {
      const text = await readText({ file });
      return text === undefined ? undefined : parse({ value: JSON.parse(text) });
    },
    async writeForTransfer({ registry, writeText, removeFile }: {
      registry: D | undefined, writeText: WriteFileText, removeFile({ file }: { file: FileLocation }): Promise<void>,
    }): Promise<void> {
      if (registry === undefined) {
        await removeFile({ file });
        return;
      }
      await writeText({ file, text: JSON.stringify(parse({ value: registry })) });
    },
  };
}

function registryKey<D>({ key, parse }: {
  key: string, parse({ value }: { value: unknown }): D,
}) {
  return {
    readForTransfer({ storage }: { storage: Pick<Storage, 'getItem'> }): D | undefined {
      const text = storage.getItem(key);
      return text === null ? undefined : parse({ value: JSON.parse(text) });
    },
    writeForTransfer({ registry, storage }: {
      registry: D | undefined, storage: Pick<Storage, 'setItem' | 'removeItem'>,
    }): void {
      if (registry === undefined) {
        storage.removeItem(key);
        return;
      }
      storage.setItem(key, JSON.stringify(parse({ value: registry })));
    },
  };
}

export function experimentalOpfsEntries({ path, matchesWorkflowResultsPath }: {
  path: readonly string[],
  matchesWorkflowResultsPath({ path }: { path: readonly string[] }): boolean,
}) {
  return {
    modelGraph: registryFile({ file: layout.entry({ parent: path, name: 'experimental-model-graph-registry.json' }), parse: modelGraphRegistryFormat.parseForTransfer }),
    rpcConnections: registryFile({ file: layout.entry({ parent: path, name: 'naidan-rpc-connections.json' }), parse: naidanRpcRegistryFormat.parseForTransfer }),
    workflows: layout.directory({
      parent: path,
      name: 'workflows',
      entries: ({ path }) => ({
        documents: layout.directory({ parent: path, name: 'documents', entries: ({ path }) => createWorkflowDocumentFormat({ parent: path }) }),
        runs: layout.directory({ parent: path, name: 'runs', entries: ({ path }) => createWorkflowRunFormat({ parent: path, matchesResultsPath: matchesWorkflowResultsPath }) }),
      }),
    }),
    imageGeneration: layout.directory({ parent: path, name: 'image-generation', entries: imageGenerationEntries }),
  };
}

export function experimentalLocalStorageEntries({ prefix }: { prefix: string }) {
  return {
    modelGraph: registryKey({ key: prefix + 'experimental-model-graph-registry', parse: modelGraphRegistryFormat.parseForTransfer }),
    rpcConnections: registryKey({ key: prefix + 'experimental-naidan-rpc-connections', parse: naidanRpcRegistryFormat.parseForTransfer }),
  };
}

/** The persisted identity includes an existing non-extractable browser key. */
function validateIdentity({ value }: { value: unknown }): NaidanRpcIdentity {
  const identity = ExperimentalNaidanRpcIdentityDtoSchema.parse(value), key = identity.privateKey;
  if (key.type !== 'private' || key.extractable || key.algorithm.name !== 'X25519' || key.usages.length !== 1 || key.usages[0] !== 'deriveBits'
    || !/^[A-Za-z0-9_-]{43}$/.test(identity.publicKey)) {
    throw new Error('Invalid RPC identity');
  }
  return identity;
}

export const experimentalIndexedDbEntries = {
  hostModelDirectories: hostModelDirectoryRecords({
    name: 'naidan-experimental-model-handles',
    version: 1,
    store: {
      name: 'handles',
      options: { keyPath: null, autoIncrement: false },
    },
  }),
  rpcIdentity: rpcIdentityRecord({
    name: 'naidan-experimental-rpc-identity',
    version: 1,
    store: {
      name: 'identity',
      options: { keyPath: null, autoIncrement: false },
    },
    key: 'self',
    validateIdentity,
  }),
} as const;

export function workflowResultsLayout({ tmpPath }: { tmpPath: readonly string[] }) {
  const directoryPrefix = 'workflow-results';
  return {
    createWriter: workflowResultsFormat.createWriter,
    listViewableResults: workflowResultsFormat.listViewableResults,
    readConversation: workflowResultsFormat.readConversation,
    serializeConversation: workflowResultsFormat.serializeConversation,
    createDirectory({ createTmpDirectory }: {
      createTmpDirectory({ prefix }: { prefix: string }): Promise<FileSystemDirectoryHandle>,
    }): Promise<FileSystemDirectoryHandle> {
      return createTmpDirectory({ prefix: directoryPrefix });
    },
    matchesPath({ path }: { path: readonly string[] }): boolean {
      return path.length === tmpPath.length + 2
        && tmpPath.every((segment, index) => path[index] === segment)
        && path[tmpPath.length + 1]?.startsWith(directoryPrefix + '-') === true
        && path.every(segment => segment && segment !== '.' && segment !== '..' && !segment.includes('/') && !segment.includes('\\'));
    },
  };
}

const imageWorkspaceFileNames = {
  recordSuffix: '.json',
  session: 'session.json',
  index: 'index.json',
  dirty: 'index.dirty',
};

function imageGenerationEntries({ path }: { path: readonly string[] }) {
  const sessions = imageWorkspaceTable({
    location: layout.entry({ parent: path, name: 'sessions' }),
    names: imageWorkspaceFileNames,
    sessionDirectories: true,
    serializeBeforeOpening: true,
    schema: ExperimentalImageGenerationSessionDtoSchema,
    indexSchema: ExperimentalImageGenerationSessionIndexDtoSchema,
    recordId: ({ record }) => record.id,
    summaryId: ({ summary }) => summary.id,
    summarize: ({ record }) => ({ ...record }),
    toDomain: imageGenerationSessionToDomain,
    toDto: ({ value }) => imageGenerationSessionToDto({ session: value }),
    summaryToDomain: imageGenerationSessionToDomain,
    applyChanges({ dto, changes }: {
      dto: ExperimentalImageGenerationSessionDto,
      changes: Pick<ImageGenerationSession, 'revision' | 'updatedAt'> & (
        Pick<ImageGenerationSession, 'activityOrder'>
        | { state: 'deleting' }
        | { state: 'deleted', title: string, clearAssociations: boolean }
      ),
    }): ExperimentalImageGenerationSessionDto {
      const updated = { ...dto, revision: changes.revision, updatedAt: changes.updatedAt };
      if (!('state' in changes)) {
        return { ...updated, activityOrder: changes.activityOrder };
      }
      switch (changes.state) {
      case 'deleting':
        return { ...updated, state: 'deleting', assistantChatId: undefined, translation: undefined };
      case 'deleted':
        return {
          ...updated,
          state: 'deleted',
          title: changes.title,
          assistantChatId: changes.clearAssociations ? undefined : dto.assistantChatId,
          translation: changes.clearAssociations ? undefined : dto.translation,
        };
      default: {
        const exhaustive: never = changes;
        throw new Error(String(exhaustive));
      }
      }
    },
  });

  return {
    catalog: imageGenerationCatalog({ location: layout.entry({ parent: path, name: 'catalog.json' }) }),
    activity: imageGenerationActivity({ location: layout.entry({ parent: path, name: 'session-activity.json' }) }),
    generations: layout.directory({
      parent: path,
      name: 'generations',
      entries: ({ path }) => imageGenerationHistory({ parent: path, recordSuffix: '.json', indexName: 'index.json', deletionSuffix: '.deleted' }),
    }),
    deletedBinaries: layout.directory({
      parent: path,
      name: 'deleted-binaries',
      entries: ({ path }) => imageGenerationBinaryDeletion({ parent: path, suffix: '.json' }),
    }),
    sessions: {
      path: sessions.path,
      open: sessions.open,
      prepareWrite: sessions.prepareWrite,
      async readForExport({ id, io }: { id: ImageGenerationSessionId, io: ImageGenerationIo }) {
        const captured = await sessions.captureForExport({ id, io });
        if (captured === undefined) {
          return undefined;
        }
        const { dto } = captured;
        return { dto, state: imageGenerationSessionToDomain({ dto }).state };
      },
      root({ rawId: raw }: { rawId: string }) {
        const sessionId = parseImageGenerationRawId({ raw });
        return layout.directory({
          parent: [...sessions.path, layout.storageShardName({ rawId: sessionId })],
          name: sessionId,
          entries: ({ path }) => {
            const validate = ({ record }: { record: { sessionId: string } }) => assertImageGenerationSessionIdentity({ actual: record.sessionId, expected: sessionId });
            return {
              draft: imageGenerationDraft({ location: layout.entry({ parent: path, name: 'draft.json' }), sessionId }),
              compositionDraft: imageGenerationCompositionDraft({ location: layout.entry({ parent: path, name: 'composition-draft.json' }), sessionId }),
              operations: imageWorkspaceTable({
                location: layout.entry({ parent: path, name: 'operations' }),
                names: imageWorkspaceFileNames,
                schema: ExperimentalImageGenerationOperationDtoSchema,
                indexSchema: ExperimentalImageGenerationOperationIndexDtoSchema,
                recordId: ({ record }) => record.id,
                summaryId: ({ summary }) => summary.id,
                summarize: ({ record }) => ({ ...record, runIds: [...record.runIds] }),
                toDto: ({ value }) => imageGenerationOperationToDto({ operation: value }),
                toDomain: imageGenerationOperationToDomain,
                summaryToDomain: imageGenerationOperationToDomain,
                validate: ({ record }) => validateImageGenerationOperation({ record, sessionId }),
              }),
              runs: imageWorkspaceTable({
                location: layout.entry({ parent: path, name: 'runs' }),
                names: imageWorkspaceFileNames,
                schema: ExperimentalImageGenerationRunDtoSchema,
                indexSchema: ExperimentalImageGenerationRunIndexDtoSchema,
                recordId: ({ record }) => record.id,
                summaryId: ({ summary }) => summary.id,
                summarize: imageGenerationRunToIndexSummary,
                toDomain: ({ dto }) => imageGenerationRunToDomain({ dto, validateRuntime: false }),
                toDomainForEditing: imageGenerationRunToDomain,
                toDto: ({ value }) => imageGenerationRunToDto({ run: value }),
                summaryToDomain: imageGenerationRunSummaryToDomain,
                applyChanges({ dto, changes }: {
                  dto: ExperimentalImageGenerationRunDto,
                  changes: Pick<ImageGenerationRun, 'revision' | 'execution'>,
                }) {
                  return { ...dto, revision: changes.revision, execution: changes.execution };
                },
                validate,
                unavailableRecord: ({ raw }) => unavailableImageGenerationRunRecord({ raw, sessionId }),
              }),
              assets: imageWorkspaceTable({
                location: layout.entry({ parent: path, name: 'assets' }),
                names: imageWorkspaceFileNames,
                schema: ExperimentalImageGenerationAssetDtoSchema,
                indexSchema: ExperimentalImageGenerationAssetIndexDtoSchema,
                recordId: ({ record }) => record.id,
                summaryId: ({ summary }) => summary.id,
                summarize: imageGenerationAssetToIndexSummary,
                toDomain: imageGenerationAssetToDomain,
                toDto: ({ value }) => imageGenerationAssetToDto({ asset: value }),
                summaryToDomain: imageGenerationAssetSummaryToDomain,
                validate,
              }),
              annotations: imageWorkspaceTable({
                location: layout.entry({ parent: path, name: 'annotations' }),
                names: imageWorkspaceFileNames,
                schema: ExperimentalImageGenerationAssetAnnotationsDtoSchema,
                indexSchema: ExperimentalImageGenerationAnnotationsIndexDtoSchema,
                recordId: ({ record }) => record.assetId,
                summaryId: ({ summary }) => summary.assetId,
                summarize: ({ record }) => ({ ...record }),
                toDomain: imageGenerationAnnotationsToDomain,
                toDto: ({ value }) => imageGenerationAnnotationsToDto({ annotations: value }),
                summaryToDomain: imageGenerationAnnotationsToDomain,
                validate,
              }),
              async removableChildren({ io }: { io: ImageGenerationIo }) {
                const removals = [];
                for await (const { name } of io.entries()) {
                  if (name !== imageWorkspaceFileNames.session) {
                    removals.push(layout.entry({ parent: path, name }));
                  }
                }
                return removals;
              },
            };
          },
        });
      },
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
