/* eslint-disable local-rules/enforce-dependency-directions --
 * Encrypted Storage Inspector is an intentional persistence-debugging exception.
 * It imports storage DTO schemas and low-level encrypted-store readers directly
 * so the UI can show the exact persisted structures instead of a storage-layer
 * projection that could hide, rename, or normalize fields. Keep this exception
 * confined to this read-only debug reader.
 */
import {
  EncryptedBinaryShardIndexSchemaDto,
  EncryptedChatGroupShardIndexSchemaDto,
  EncryptedChatMetaShardIndexSchemaDto,
  EncryptedDirectoryManifestSchemaDto,
  EncryptedDirectoryShardContentsSchemaDto,
  EncryptedFileChunkMapPageSchemaDto,
  EncryptedFileManifestSchemaDto,
  EncryptedFileSystemDescriptorSchemaDto,
  EncryptedObjectTransactionSchemaDto,
  NaidanEncryptedStoreManifestSchemaDto,
  type EncryptedObjectTransactionDto,
  type NaidanEncryptedCollectionTypeDto,
  type NaidanEncryptedStoreManifestDto,
} from '@/00-storage/00-dto/encryption.dto';
import { decodeBase64Url } from '@/00-storage/service/opfs-encryption/base64-url';
import { VolumeIndexSchemaDto, type VolumeDto } from '@/00-storage/00-dto/dto';
import { EncryptedStoreHeaderStore } from '@/00-storage/service/opfs-encryption/encrypted-store-header-store';
import {
  decodeEncryptedObjectPhysicalHeader,
  EncryptedObjectStore,
  type EncryptedObjectAddress,
  type EncryptedObjectLocator,
  type EncryptedObjectPhysicalArea,
} from '@/00-storage/service/opfs-encryption/encrypted-object-store';
import {
  EncryptionStateStore,
  type EncryptionStateInspection,
} from '@/00-storage/service/opfs-encryption/encryption-state-store';
import type { EncryptedStorageDebugCapability } from '@/00-storage/service/opfs-encryption/encrypted-storage-debug-capability';
import type {
  EncryptedStorageDebugField,
  EncryptedStorageDebugIntegrityFinding,
  EncryptedStorageDebugIntegrityReport,
  EncryptedStorageDebugNode,
  EncryptedStorageDebugNodeRef,
  EncryptedStorageDebugPersistedJson,
  EncryptedStorageDebugReference,
  EncryptedStorageDebugSearchResult,
} from './types';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const KNOWN_FILE_SYSTEMS = [
  { id: 'system/chat-wesh', area: 'durable' },
  { id: 'system/debug-wesh', area: 'durable' },
  { id: 'system/tmp', area: 'temporary' },
] as const;

interface KnownLogicalObject {
  readonly label: string,
  readonly detail: string,
  readonly locator: EncryptedObjectLocator,
  readonly area: EncryptedObjectPhysicalArea,
  readonly required: boolean,
}

function field({ label, value }: { label: string, value: unknown }): EncryptedStorageDebugField {
  return { label, value: String(value) };
}

type LogicalObjectNodeRef = Extract<
  EncryptedStorageDebugNodeRef,
  { type: 'logical_object' }
>;
type WriteTransactionOperation = Extract<
  EncryptedObjectTransactionDto['operations'][number],
  { type: 'write' }
>;

function getPhysicalAreaDirectoryName({
  area,
}: {
  area: EncryptedObjectPhysicalArea,
}): 'objects' | 'temporary-objects' {
  switch (area) {
  case 'durable':
    return 'objects';
  case 'temporary':
    return 'temporary-objects';
  default: {
    const _ex: never = area;
    throw new Error(`Unhandled encrypted object physical area: ${String(_ex)}`);
  }
  }
}

function getControlStatePresentation({
  inspection,
}: {
  inspection: EncryptionStateInspection,
}): {
  readonly references: readonly EncryptedStorageDebugReference[],
  readonly warnings: readonly string[],
} {
  switch (inspection.type) {
  case 'plain':
    return { references: [], warnings: [] };
  case 'encrypted':
    return {
      references: [{ label: 'Active store header', ref: { type: 'store_header' } }],
      warnings: [],
    };
  case 'invalid':
    return { references: [], warnings: [String(inspection.error)] };
  default: {
    const _ex: never = inspection;
    throw new Error(`Unhandled encryption state inspection: ${String(_ex)}`);
  }
  }
}

function getOpfsVolumeFileSystemId({
  volumeId,
  volume,
}: {
  volumeId: string,
  volume: VolumeDto,
}): string | undefined {
  switch (volume.type) {
  case 'host':
    return undefined;
  case 'opfs':
    return `volume/${volumeId}`;
  default: {
    const _ex: never = volume;
    throw new Error(`Unhandled volume type: ${String(_ex)}`);
  }
  }
}

function getWriteTransactionOperation({
  operation,
}: {
  operation: EncryptedObjectTransactionDto['operations'][number],
}): WriteTransactionOperation | undefined {
  switch (operation.type) {
  case 'delete':
    return undefined;
  case 'write':
    return operation;
  default: {
    const _ex: never = operation;
    throw new Error(`Unhandled encrypted transaction operation: ${String(_ex)}`);
  }
  }
}

function getLogicalObjectNodeRef({
  ref,
}: {
  ref: EncryptedStorageDebugNodeRef,
}): LogicalObjectNodeRef | undefined {
  switch (ref.type) {
  case 'logical_object':
    return ref;
  case 'root':
  case 'control_state':
  case 'store_header':
  case 'store_manifest':
  case 'collection':
  case 'physical_object':
  case 'file_system':
  case 'directory':
  case 'file':
    return undefined;
  default: {
    const _ex: never = ref;
    throw new Error(`Unhandled encrypted storage debug node reference: ${String(_ex)}`);
  }
  }
}

function logicalReference({
  label,
  area,
  namespace,
  key,
}: {
  label: string,
  area: EncryptedObjectPhysicalArea,
  namespace: string,
  key: string,
}): EncryptedStorageDebugReference {
  return {
    label,
    ref: { type: 'logical_object', area, namespace, key },
  };
}

function parseJsonBytes({ bytes }: { bytes: Uint8Array }): unknown {
  return JSON.parse(UTF8_DECODER.decode(bytes));
}

function decodePersistedJsonBytes({
  bytes,
}: {
  bytes: Uint8Array,
}): EncryptedStorageDebugPersistedJson | undefined {
  let json: string;
  try {
    json = UTF8_DECODER.decode(bytes);
  } catch {
    return undefined;
  }
  let parseStatus: EncryptedStorageDebugPersistedJson['parseStatus'];
  try {
    JSON.parse(json);
    parseStatus = 'valid';
  } catch {
    parseStatus = 'invalid';
  }
  return {
    json,
    parseStatus,
    source: 'decrypted_persisted_bytes',
  };
}

function createSelectedPersistedDtoJson({
  value,
}: {
  value: unknown,
}): EncryptedStorageDebugPersistedJson {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error('Encrypted Storage Inspector could not serialize the selected persisted DTO');
  }
  return {
    json,
    parseStatus: 'valid',
    source: 'selected_persisted_dto',
  };
}

function tryParseJsonBytes({ bytes }: { bytes: Uint8Array }): unknown {
  try {
    return parseJsonBytes({ bytes });
  } catch {
    return {
      type: 'binary',
      byteLength: bytes.byteLength,
    };
  }
}

const DEBUG_PREVIEW_MAX_DEPTH = 10;
const DEBUG_PREVIEW_MAX_COLLECTION_ENTRIES = 200;
const DEBUG_PREVIEW_MAX_NODES = 5_000;
const DEBUG_PREVIEW_MAX_STRING_LENGTH = 16_384;
const DEBUG_DIRECTORY_CHILD_REFERENCE_LIMIT = 500;

/**
 * Builds a bounded runtime-only presentation model for summaries and derived
 * details. This representation is never the persisted DTO and must not be
 * displayed as though its synthetic fields were stored by Naidan.
 */
function createDebugValuePreview({ value }: { value: unknown }): {
  readonly value: unknown,
  readonly truncated: boolean,
} {
  let remainingNodes = DEBUG_PREVIEW_MAX_NODES;
  let truncated = false;

  const visit = ({ current, depth }: { current: unknown, depth: number }): unknown => {
    if (remainingNodes <= 0) {
      truncated = true;
      return { $debugInspectorTruncated: 'node budget exceeded' };
    }
    remainingNodes -= 1;

    if (typeof current === 'string') {
      if (current.length <= DEBUG_PREVIEW_MAX_STRING_LENGTH) {
        return current;
      }
      truncated = true;
      return `${current.slice(0, DEBUG_PREVIEW_MAX_STRING_LENGTH)}… [${String(current.length - DEBUG_PREVIEW_MAX_STRING_LENGTH)} characters omitted]`;
    }
    if (
      current === null
      || typeof current === 'number'
      || typeof current === 'boolean'
      || typeof current === 'undefined'
    ) {
      return current;
    }
    if (typeof current === 'bigint') {
      return `${String(current)}n`;
    }
    if (current instanceof Uint8Array) {
      const previewLength = Math.min(current.byteLength, 64);
      if (previewLength < current.byteLength) {
        truncated = true;
      }
      return {
        $debugInspectorRuntimeType: 'Uint8Array',
        byteLength: current.byteLength,
        hexPreview: [...current.subarray(0, previewLength)]
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join(''),
      };
    }
    if (depth >= DEBUG_PREVIEW_MAX_DEPTH) {
      truncated = true;
      return { $debugInspectorTruncated: 'maximum preview depth reached' };
    }
    if (Array.isArray(current)) {
      const previewLength = Math.min(current.length, DEBUG_PREVIEW_MAX_COLLECTION_ENTRIES);
      const result = current.slice(0, previewLength).map(item => visit({
        current: item,
        depth: depth + 1,
      }));
      if (previewLength < current.length) {
        truncated = true;
        result.push({
          $debugInspectorOmittedItems: current.length - previewLength,
        });
      }
      return result;
    }
    if (typeof current === 'object') {
      const entries = Object.entries(current as Record<string, unknown>);
      const previewLength = Math.min(entries.length, DEBUG_PREVIEW_MAX_COLLECTION_ENTRIES);
      const result: Record<string, unknown> = {};
      for (const [key, entryValue] of entries.slice(0, previewLength)) {
        result[key] = visit({ current: entryValue, depth: depth + 1 });
      }
      if (previewLength < entries.length) {
        truncated = true;
        result.$debugInspectorOmittedProperties = entries.length - previewLength;
      }
      return result;
    }
    return String(current);
  };

  return {
    value: visit({ current: value, depth: 0 }),
    truncated,
  };
}

function getCollection({
  manifest,
  type,
}: {
  manifest: NaidanEncryptedStoreManifestDto,
  type: NaidanEncryptedCollectionTypeDto,
}) {
  const collection = manifest.collections.find(candidate => candidate.type === type);
  if (collection === undefined) {
    throw new Error(`Encrypted store manifest is missing collection: ${type}`);
  }
  return collection;
}

export class EncryptedStorageDebugReader {
  constructor({ capability }: { capability: EncryptedStorageDebugCapability }) {
    this.capability = capability;
    this.durableObjectStore = new EncryptedObjectStore({
      storeDirectory: capability.storeDirectory,
      keys: {
        objectEncryptionKey: capability.objectEncryptionKey,
        objectAddressKey: capability.objectAddressKey,
      },
      area: 'durable',
    });
    this.temporaryObjectStore = new EncryptedObjectStore({
      storeDirectory: capability.storeDirectory,
      keys: {
        objectEncryptionKey: capability.objectEncryptionKey,
        objectAddressKey: capability.objectAddressKey,
      },
      area: 'temporary',
    });
  }

  private readonly capability: EncryptedStorageDebugCapability;
  private readonly durableObjectStore: EncryptedObjectStore;
  private readonly temporaryObjectStore: EncryptedObjectStore;

  async loadNode({ ref }: { ref: EncryptedStorageDebugNodeRef }): Promise<EncryptedStorageDebugNode> {
    switch (ref.type) {
    case 'root':
      return this.loadRootNode();
    case 'control_state':
      return this.loadControlStateNode({ ref });
    case 'store_header':
      return this.loadStoreHeaderNode({ ref });
    case 'store_manifest':
      return this.loadStoreManifestNode({ ref });
    case 'collection':
      return this.loadCollectionNode({ ref });
    case 'logical_object':
      return this.loadLogicalObjectNode({ ref });
    case 'physical_object':
      return this.loadPhysicalObjectNode({ ref });
    case 'file_system':
      return this.loadFileSystemNode({ ref });
    case 'directory':
      return this.loadDirectoryNode({ ref });
    case 'file':
      return this.loadFileNode({ ref });
    default: {
      const _ex: never = ref;
      throw new Error(`Unhandled encrypted storage debug node: ${String(_ex)}`);
    }
    }
  }

  /**
   * Loads the persisted JSON independently from the runtime node preview.
   *
   * The Inspector is a persistence and protocol debugging tool. Exact stored
   * DTO structure is therefore preferred over derived summaries. Runtime-only
   * values such as Uint8Array previews remain available on the node, but never
   * replace this persisted representation.
   */
  async loadPersistedJson({
    ref,
  }: {
    ref: EncryptedStorageDebugNodeRef,
  }): Promise<EncryptedStorageDebugPersistedJson | undefined> {
    switch (ref.type) {
    case 'root':
      return undefined;
    case 'control_state': {
      const inspection = await new EncryptionStateStore({
        storageRoot: this.capability.storageRoot,
      }).inspect();
      switch (inspection.type) {
      case 'plain':
      case 'invalid':
        return undefined;
      case 'encrypted':
        return createSelectedPersistedDtoJson({ value: inspection.state });
      default: {
        const _ex: never = inspection;
        throw new Error(`Unhandled encryption state inspection: ${String(_ex)}`);
      }
      }
    }
    case 'store_header': {
      const header = await new EncryptedStoreHeaderStore({
        storageRoot: this.capability.storageRoot,
      }).read({ encryptedStoreId: this.capability.encryptedStoreId });
      return header === undefined
        ? undefined
        : createSelectedPersistedDtoJson({ value: header });
    }
    case 'store_manifest': {
      const bytes = await this.durableObjectStore.read({
        locator: { namespace: 'singleton', key: 'store_manifest' },
      });
      return bytes === undefined ? undefined : decodePersistedJsonBytes({ bytes });
    }
    case 'collection': {
      const manifest = await this.readManifest();
      const type = NaidanEncryptedStoreManifestSchemaDto.shape.collections.element.shape.type.parse(ref.collectionType);
      return createSelectedPersistedDtoJson({ value: getCollection({ manifest, type }) });
    }
    case 'logical_object': {
      if (ref.namespace === 'file_chunk') {
        return undefined;
      }
      const bytes = await this.getObjectStore({ area: ref.area }).read({
        locator: { namespace: ref.namespace, key: ref.key },
      });
      return bytes === undefined ? undefined : decodePersistedJsonBytes({ bytes });
    }
    case 'physical_object': {
      const store = this.getObjectStore({ area: ref.area });
      const address: EncryptedObjectAddress = {
        area: ref.area,
        objectId: ref.objectId,
        shardId: ref.shardId,
        path: `${getPhysicalAreaDirectoryName({ area: ref.area })}/${ref.shardId}/${ref.objectId}.enc`,
      };
      const physical = await store.readPhysical({ address });
      if (physical === undefined) {
        return undefined;
      }
      const plaintext = await store.decryptPhysical({ address, physical });
      if (plaintext === undefined) {
        return undefined;
      }
      const persisted = decodePersistedJsonBytes({ bytes: plaintext });
      if (persisted === undefined) {
        return undefined;
      }
      switch (persisted.parseStatus) {
      case 'valid':
        return persisted;
      case 'invalid':
        return undefined;
      default: {
        const _ex: never = persisted.parseStatus;
        throw new Error(`Unhandled persisted JSON parse status: ${String(_ex)}`);
      }
      }
    }
    case 'file_system': {
      const bytes = await this.getObjectStore({ area: ref.area }).read({
        locator: { namespace: 'file_system_descriptor', key: ref.fileSystemId },
      });
      return bytes === undefined ? undefined : decodePersistedJsonBytes({ bytes });
    }
    case 'directory': {
      const bytes = await this.getObjectStore({ area: ref.area }).read({
        locator: { namespace: 'directory_manifest', key: ref.directoryId },
      });
      return bytes === undefined ? undefined : decodePersistedJsonBytes({ bytes });
    }
    case 'file': {
      const bytes = await this.getObjectStore({ area: ref.area }).read({
        locator: { namespace: 'file_manifest', key: ref.fileId },
      });
      return bytes === undefined ? undefined : decodePersistedJsonBytes({ bytes });
    }
    default: {
      const _ex: never = ref;
      throw new Error(`Unhandled encrypted storage debug node: ${String(_ex)}`);
    }
    }
  }

  async search({ query }: { query: string }): Promise<EncryptedStorageDebugSearchResult[]> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      return [];
    }
    const results: EncryptedStorageDebugSearchResult[] = [];
    const areaPrefix = /^(durable|temporary)\/(.+)$/u.exec(query);
    const directLocator = areaPrefix === null ? query : areaPrefix[2];
    if (directLocator === undefined) {
      throw new Error('Encrypted Storage Inspector locator capture is missing');
    }
    const directArea = areaPrefix?.[1] === 'temporary' ? 'temporary' : 'durable';
    const separatorIndex = directLocator.indexOf(':');
    if (separatorIndex > 0) {
      const namespace = directLocator.slice(0, separatorIndex);
      const key = directLocator.slice(separatorIndex + 1);
      results.push({
        label: `${directArea}/${namespace}:${key}`,
        detail: `Direct ${directArea} logical object locator`,
        ref: { type: 'logical_object', area: directArea, namespace, key },
      });
    }
    for (const fileSystem of KNOWN_FILE_SYSTEMS) {
      if (fileSystem.id.includes(normalized)) {
        results.push({
          label: fileSystem.id,
          detail: `${fileSystem.area} encrypted filesystem`,
          ref: { type: 'file_system', area: fileSystem.area, fileSystemId: fileSystem.id },
        });
      }
    }
    for (const known of await this.collectKnownLogicalObjects({ includeFileChunks: false })) {
      const haystack = `${known.label}\n${known.detail}\n${known.locator.namespace}\n${known.locator.key}`.toLowerCase();
      if (!haystack.includes(normalized)) {
        continue;
      }
      results.push({
        label: known.label,
        detail: known.detail,
        ref: {
          type: 'logical_object',
          area: known.area,
          namespace: known.locator.namespace,
          key: known.locator.key,
        },
      });
      if (results.length >= 200) {
        break;
      }
    }
    if (results.length < 200) {
      for (const area of ['durable', 'temporary'] as const) {
        for await (const address of this.getObjectStore({ area }).listPhysicalObjectAddresses()) {
          if (!address.objectId.toLowerCase().includes(normalized) && !address.path.toLowerCase().includes(normalized)) {
            continue;
          }
          results.push({
            label: address.objectId,
            detail: address.path,
            ref: {
              type: 'physical_object',
              area,
              objectId: address.objectId,
              shardId: address.shardId,
            },
          });
          if (results.length >= 200) {
            break;
          }
        }
      }
    }
    return results;
  }

  async scanIntegrity(): Promise<EncryptedStorageDebugIntegrityReport> {
    const findings: EncryptedStorageDebugIntegrityFinding[] = [];
    const known = await this.collectKnownLogicalObjects({ includeFileChunks: true });
    const knownObjectIds = new Set<string>();
    for (const object of known) {
      const store = this.getObjectStore({ area: object.area });
      const address = await store.getObjectAddress({ locator: object.locator });
      knownObjectIds.add(`${object.area}:${address.objectId}`);
      try {
        const bytes = await store.read({ locator: object.locator });
        if (bytes === undefined && object.required) {
          findings.push({
            severity: 'error',
            message: `Missing referenced object: ${object.locator.namespace}:${object.locator.key}`,
            ref: {
              type: 'logical_object',
              area: object.area,
              namespace: object.locator.namespace,
              key: object.locator.key,
            },
          });
        }
      } catch (error) {
        findings.push({
          severity: 'error',
          message: `Object authentication or decoding failed: ${String(error)}`,
          ref: {
            type: 'logical_object',
            area: object.area,
            namespace: object.locator.namespace,
            key: object.locator.key,
          },
        });
      }
    }
    let scannedPhysicalObjects = 0;
    for (const area of ['durable', 'temporary'] as const) {
      for await (const address of this.getObjectStore({ area }).listPhysicalObjectAddresses()) {
        scannedPhysicalObjects += 1;
        if (!knownObjectIds.has(`${area}:${address.objectId}`)) {
          try {
            const physical = await this.getObjectStore({ area }).readPhysical({ address });
            if (physical === undefined) {
              throw new Error('The listed physical object disappeared during the scan');
            }
            await this.getObjectStore({ area }).decryptPhysical({ address, physical });
          } catch (error) {
            findings.push({
              severity: 'error',
              message: `Uncatalogued physical object authentication or decoding failed: ${String(error)}`,
              ref: {
                type: 'physical_object',
                area,
                objectId: address.objectId,
                shardId: address.shardId,
              },
            });
            continue;
          }
          findings.push({
            severity: 'warning',
            message: `Physical object is not reachable from the known Naidan catalog: ${address.path}`,
            ref: {
              type: 'physical_object',
              area,
              objectId: address.objectId,
              shardId: address.shardId,
            },
          });
        }
      }
    }
    return {
      scannedPhysicalObjects,
      knownLogicalObjects: known.length,
      findings,
    };
  }

  private async loadRootNode(): Promise<EncryptedStorageDebugNode> {
    const manifest = await this.readManifest();
    const references: EncryptedStorageDebugReference[] = [
      { label: 'Encryption control state', ref: { type: 'control_state' } },
      { label: 'Active store header', ref: { type: 'store_header' } },
      { label: 'Naidan store manifest', ref: { type: 'store_manifest' } },
      ...manifest.collections.map(collection => ({
        label: `Collection: ${collection.type}`,
        ref: { type: 'collection', collectionType: collection.type } as const,
      })),
      ...KNOWN_FILE_SYSTEMS.map(fileSystem => ({
        label: `Filesystem: ${fileSystem.id}`,
        ref: {
          type: 'file_system',
          area: fileSystem.area,
          fileSystemId: fileSystem.id,
        } as const,
      })),
    ];
    return {
      ref: { type: 'root' },
      kind: 'encrypted_storage_root',
      title: `Encrypted store ${this.capability.encryptedStoreId}`,
      fields: [
        field({ label: 'Store ID', value: this.capability.encryptedStoreId }),
        field({ label: 'Collections', value: manifest.collections.length }),
      ],
      value: manifest,
      references,
      warnings: [],
    };
  }

  private async loadControlStateNode({ ref }: { ref: Extract<EncryptedStorageDebugNodeRef, { type: 'control_state' }> }): Promise<EncryptedStorageDebugNode> {
    const inspection = await new EncryptionStateStore({ storageRoot: this.capability.storageRoot }).inspect();
    const presentation = getControlStatePresentation({ inspection });
    return {
      ref,
      kind: 'encryption_control_state',
      title: 'Encryption control state',
      fields: [field({ label: 'Inspection', value: inspection.type })],
      value: inspection,
      references: presentation.references,
      warnings: presentation.warnings,
      physicalPath: 'encryption-state/state-{0,1}.json',
    };
  }

  private async loadStoreHeaderNode({ ref }: { ref: Extract<EncryptedStorageDebugNodeRef, { type: 'store_header' }> }): Promise<EncryptedStorageDebugNode> {
    const header = await new EncryptedStoreHeaderStore({ storageRoot: this.capability.storageRoot }).read({
      encryptedStoreId: this.capability.encryptedStoreId,
    });
    return {
      ref,
      kind: 'encrypted_store_header',
      title: 'Active encrypted store header',
      fields: [
        field({ label: 'Store ID', value: this.capability.encryptedStoreId }),
        field({ label: 'Sequence', value: header?.sequence ?? 'missing' }),
        field({ label: 'Format version', value: header?.formatVersion ?? 'missing' }),
      ],
      value: header ?? null,
      references: [{ label: 'Store manifest', ref: { type: 'store_manifest' } }],
      warnings: header === undefined ? ['The active store header is missing or invalid.'] : [],
      physicalPath: `encrypted-stores/${this.capability.encryptedStoreId}/header/header-{0,1}.json`,
    };
  }

  private async loadStoreManifestNode({ ref }: { ref: Extract<EncryptedStorageDebugNodeRef, { type: 'store_manifest' }> }): Promise<EncryptedStorageDebugNode> {
    const manifest = await this.readManifest();
    const logical = { area: 'durable', namespace: 'singleton', key: 'store_manifest' } as const;
    const address = await this.durableObjectStore.getObjectAddress({ locator: logical });
    return {
      ref,
      kind: 'naidan_encrypted_store_manifest',
      title: 'Naidan encrypted store manifest',
      fields: [field({ label: 'Collections', value: manifest.collections.length }), field({ label: 'Object ID', value: address.objectId })],
      value: manifest,
      references: [
        ...manifest.collections.map(collection => ({
          label: collection.type,
          ref: { type: 'collection', collectionType: collection.type } as const,
        })),
        logicalReference({ label: 'Logical object', ...logical }),
      ],
      physicalPath: address.path,
      warnings: [],
    };
  }

  private async loadCollectionNode({ ref }: { ref: Extract<EncryptedStorageDebugNodeRef, { type: 'collection' }> }): Promise<EncryptedStorageDebugNode> {
    const manifest = await this.readManifest();
    const type = NaidanEncryptedStoreManifestSchemaDto.shape.collections.element.shape.type.parse(ref.collectionType);
    const collection = getCollection({ manifest, type });
    const references: EncryptedStorageDebugReference[] = [];
    for (const shardId of collection.shardIds) {
      const namespace = this.getCollectionIndexNamespace({ type });
      references.push(logicalReference({
        label: `Shard ${shardId}`,
        area: 'durable',
        namespace,
        key: shardId,
      }));
    }
    return {
      ref,
      kind: 'naidan_collection',
      title: `Collection: ${type}`,
      fields: [field({ label: 'Shard count', value: collection.shardIds.length })],
      value: collection,
      references,
      warnings: [],
    };
  }

  private async loadLogicalObjectNode({ ref }: { ref: Extract<EncryptedStorageDebugNodeRef, { type: 'logical_object' }> }): Promise<EncryptedStorageDebugNode> {
    const store = this.getObjectStore({ area: ref.area });
    const locator = { namespace: ref.namespace, key: ref.key };
    const address = await store.getObjectAddress({ locator });
    const bytes = await store.read({ locator });
    const value = bytes === undefined ? null : tryParseJsonBytes({ bytes });
    const references = await this.inferReferences({ ref, value });
    const preview = createDebugValuePreview({ value });
    return {
      ref,
      kind: 'logical_encrypted_object',
      title: `${ref.namespace}:${ref.key}`,
      fields: [
        field({ label: 'Area', value: ref.area }),
        field({ label: 'Object ID', value: address.objectId }),
        field({ label: 'Shard', value: address.shardId }),
        field({ label: 'Decoded bytes', value: bytes?.byteLength ?? 'missing' }),
      ],
      value: preview.value,
      references: [
        {
          label: 'Physical object',
          ref: {
            type: 'physical_object',
            area: ref.area,
            objectId: address.objectId,
            shardId: address.shardId,
          },
        },
        ...references,
      ],
      physicalPath: address.path,
      warnings: [
        ...(bytes === undefined ? ['The logical object does not exist.'] : []),
        ...(preview.truncated ? ['Decoded value preview was truncated in the Worker. Follow references or inspect the raw object for the complete structure.'] : []),
      ],
    };
  }

  private async loadPhysicalObjectNode({ ref }: { ref: Extract<EncryptedStorageDebugNodeRef, { type: 'physical_object' }> }): Promise<EncryptedStorageDebugNode> {
    const store = this.getObjectStore({ area: ref.area });
    const address: EncryptedObjectAddress = {
      area: ref.area,
      objectId: ref.objectId,
      shardId: ref.shardId,
      path: `${getPhysicalAreaDirectoryName({ area: ref.area })}/${ref.shardId}/${ref.objectId}.enc`,
    };
    const physical = await store.readPhysical({ address });
    const header = physical === undefined ? undefined : decodeEncryptedObjectPhysicalHeader({ physical });
    let decoded: unknown = null;
    let authentication: 'not_checked' | 'valid' | 'failed' = 'not_checked';
    const warnings: string[] = [];
    if (physical !== undefined) {
      try {
        const plaintext = await store.decryptPhysical({ address, physical });
        decoded = plaintext === undefined ? null : tryParseJsonBytes({ bytes: plaintext });
        authentication = 'valid';
      } catch (error) {
        authentication = 'failed';
        warnings.push(`Authentication or payload decoding failed: ${String(error)}`);
      }
    } else {
      warnings.push('The physical object is missing.');
    }
    const references: EncryptedStorageDebugReference[] = [];
    for (const known of await this.collectKnownLogicalObjects({ includeFileChunks: true })) {
      if (known.area !== ref.area) {
        continue;
      }
      const knownAddress = await store.getObjectAddress({ locator: known.locator });
      if (knownAddress.objectId !== ref.objectId) {
        continue;
      }
      references.push(logicalReference({
        label: `Logical locator: ${known.locator.namespace}:${known.locator.key}`,
        area: known.area,
        namespace: known.locator.namespace,
        key: known.locator.key,
      }));
    }
    if (physical !== undefined && references.length === 0) {
      warnings.push('No known Naidan logical locator resolves to this physical object.');
    }
    const preview = createDebugValuePreview({ value: { header: header ?? null, decoded } });
    if (preview.truncated) {
      warnings.push('Decoded value preview was truncated in the Worker.');
    }
    return {
      ref,
      kind: 'physical_encrypted_object',
      title: ref.objectId,
      fields: [
        field({ label: 'Area', value: ref.area }),
        field({ label: 'Shard', value: ref.shardId }),
        field({ label: 'Physical bytes', value: physical?.byteLength ?? 'missing' }),
        field({ label: 'Format version', value: header?.formatVersion ?? 'unknown' }),
        field({ label: 'Header bytes', value: header?.headerByteLength ?? 'unknown' }),
        field({ label: 'Ciphertext bytes', value: header?.ciphertextByteLength ?? 'unknown' }),
        field({ label: 'Authentication', value: authentication.replace('_', ' ') }),
      ],
      value: preview.value,
      references,
      physicalPath: address.path,
      warnings,
    };
  }

  private async loadFileSystemNode({ ref }: { ref: Extract<EncryptedStorageDebugNodeRef, { type: 'file_system' }> }): Promise<EncryptedStorageDebugNode> {
    const store = this.getObjectStore({ area: ref.area });
    const locator = { namespace: 'file_system_descriptor', key: ref.fileSystemId };
    const bytes = await store.read({ locator });
    const descriptor = bytes === undefined
      ? undefined
      : EncryptedFileSystemDescriptorSchemaDto.parse(parseJsonBytes({ bytes }));
    return {
      ref,
      kind: 'encrypted_file_system',
      title: ref.fileSystemId,
      fields: [
        field({ label: 'Area', value: ref.area }),
        field({ label: 'Root directory ID', value: descriptor?.rootDirectoryId ?? 'missing' }),
        field({ label: 'Created at', value: descriptor?.createdAt ?? 'missing' }),
      ],
      value: descriptor ?? null,
      references: descriptor === undefined
        ? [logicalReference({ label: 'Descriptor locator', area: ref.area, ...locator })]
        : [
          logicalReference({ label: 'Descriptor locator', area: ref.area, ...locator }),
          {
            label: '/',
            ref: {
              type: 'directory',
              area: ref.area,
              fileSystemId: ref.fileSystemId,
              directoryId: descriptor.rootDirectoryId,
              path: '/',
            },
          },
        ],
      warnings: descriptor === undefined ? ['The filesystem has not been created.'] : [],
    };
  }

  private async loadDirectoryNode({ ref }: { ref: Extract<EncryptedStorageDebugNodeRef, { type: 'directory' }> }): Promise<EncryptedStorageDebugNode> {
    const store = this.getObjectStore({ area: ref.area });
    const manifestLocator = { namespace: 'directory_manifest', key: ref.directoryId };
    const manifestBytes = await store.read({ locator: manifestLocator });
    if (manifestBytes === undefined) {
      return {
        ref,
        kind: 'encrypted_directory',
        title: ref.path,
        fields: [field({ label: 'Directory ID', value: ref.directoryId })],
        value: null,
        references: [logicalReference({ label: 'Directory manifest', area: ref.area, ...manifestLocator })],
        warnings: ['Directory manifest is missing.'],
      };
    }
    const manifest = EncryptedDirectoryManifestSchemaDto.parse(parseJsonBytes({ bytes: manifestBytes }));
    const references: EncryptedStorageDebugReference[] = [
      logicalReference({ label: 'Directory manifest', area: ref.area, ...manifestLocator }),
    ];
    const entries: unknown[] = [];
    let entryCount = 0;
    let childReferenceCount = 0;
    let omittedChildReferenceCount = 0;
    for (const shard of manifest.shards) {
      const shardLocator = { namespace: 'directory_shard', key: shard.objectId };
      references.push(logicalReference({ label: `Shard ${shard.shardId}`, area: ref.area, ...shardLocator }));
      const bytes = await store.read({ locator: shardLocator });
      if (bytes === undefined) {
        entries.push({ missingShard: shard });
        continue;
      }
      const contents = EncryptedDirectoryShardContentsSchemaDto.parse(parseJsonBytes({ bytes }));
      entries.push(contents);
      for (const entry of Object.values(contents.entries)) {
        entryCount += 1;
        const childPath = ref.path === '/' ? `/${entry.name}` : `${ref.path}/${entry.name}`;
        switch (entry.type) {
        case 'file':
          if (childReferenceCount >= DEBUG_DIRECTORY_CHILD_REFERENCE_LIMIT) {
            omittedChildReferenceCount += 1;
            break;
          }
          childReferenceCount += 1;
          references.push({
            label: entry.name,
            ref: {
              type: 'file',
              area: ref.area,
              fileSystemId: ref.fileSystemId,
              fileId: entry.fileId,
              path: childPath,
            },
          });
          break;
        case 'directory':
          if (childReferenceCount >= DEBUG_DIRECTORY_CHILD_REFERENCE_LIMIT) {
            omittedChildReferenceCount += 1;
            break;
          }
          childReferenceCount += 1;
          references.push({
            label: `${entry.name}/`,
            ref: {
              type: 'directory',
              area: ref.area,
              fileSystemId: ref.fileSystemId,
              directoryId: entry.directoryId,
              path: childPath,
            },
          });
          break;
        case 'symlink':
          break;
        default: {
          const _ex: never = entry;
          throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
        }
        }
      }
    }
    const preview = createDebugValuePreview({ value: { manifest, shards: entries } });
    return {
      ref,
      kind: 'encrypted_directory',
      title: ref.path,
      fields: [
        field({ label: 'Directory ID', value: ref.directoryId }),
        field({ label: 'Revision', value: manifest.revision }),
        field({ label: 'Shards', value: manifest.shards.length }),
        field({ label: 'Entries', value: entryCount }),
        field({ label: 'Created at', value: manifest.createdAt }),
        field({ label: 'Modified at', value: manifest.modifiedAt }),
      ],
      value: preview.value,
      references,
      warnings: [
        ...(preview.truncated ? ['Directory value preview was truncated in the Worker. Open an individual shard to inspect omitted entries.'] : []),
        ...(omittedChildReferenceCount > 0 ? [`${String(omittedChildReferenceCount)} child references were omitted. Open the directory shards to navigate them.`] : []),
      ],
    };
  }

  private async loadFileNode({ ref }: { ref: Extract<EncryptedStorageDebugNodeRef, { type: 'file' }> }): Promise<EncryptedStorageDebugNode> {
    const store = this.getObjectStore({ area: ref.area });
    const manifestLocator = { namespace: 'file_manifest', key: ref.fileId };
    const bytes = await store.read({ locator: manifestLocator });
    if (bytes === undefined) {
      return {
        ref,
        kind: 'encrypted_file',
        title: ref.path,
        fields: [field({ label: 'File ID', value: ref.fileId })],
        value: null,
        references: [logicalReference({ label: 'File manifest', area: ref.area, ...manifestLocator })],
        warnings: ['File manifest is missing.'],
      };
    }
    const manifest = EncryptedFileManifestSchemaDto.parse(parseJsonBytes({ bytes }));
    const references: EncryptedStorageDebugReference[] = [
      logicalReference({ label: 'File manifest', area: ref.area, ...manifestLocator }),
      ...manifest.chunkMapPageIds.map(pageId => logicalReference({
        label: `Chunk map page ${pageId}`,
        area: ref.area,
        namespace: 'file_chunk_map_page',
        key: pageId,
      })),
    ];
    return {
      ref,
      kind: 'encrypted_file',
      title: ref.path,
      fields: [
        field({ label: 'File ID', value: ref.fileId }),
        field({ label: 'Revision', value: manifest.revision }),
        field({ label: 'Size', value: manifest.size }),
        field({ label: 'Chunk size', value: manifest.chunkSize }),
        field({ label: 'Chunk map pages', value: manifest.chunkMapPageIds.length }),
        field({ label: 'Created at', value: manifest.createdAt }),
        field({ label: 'Modified at', value: manifest.modifiedAt }),
      ],
      value: manifest,
      references,
      warnings: [],
    };
  }

  private async inferReferences({
    ref,
    value,
  }: {
    ref: Extract<EncryptedStorageDebugNodeRef, { type: 'logical_object' }>,
    value: unknown,
  }): Promise<EncryptedStorageDebugReference[]> {
    const references: EncryptedStorageDebugReference[] = [];
    if (value === null || typeof value !== 'object') {
      return references;
    }
    switch (ref.namespace) {
    case 'chat_meta_shard_index': {
      const index = EncryptedChatMetaShardIndexSchemaDto.parse(value);
      for (const chatId of index.chatIds) {
        references.push(
          logicalReference({
            label: `Chat meta ${chatId}`,
            area: ref.area,
            namespace: 'chat_meta',
            key: chatId,
          }),
          logicalReference({
            label: `Chat content ${chatId}`,
            area: ref.area,
            namespace: 'chat_content',
            key: chatId,
          }),
        );
      }
      break;
    }
    case 'chat_group_shard_index': {
      const index = EncryptedChatGroupShardIndexSchemaDto.parse(value);
      for (const chatGroupId of index.chatGroupIds) {
        references.push(logicalReference({
          label: `Chat group ${chatGroupId}`,
          area: ref.area,
          namespace: 'chat_group',
          key: chatGroupId,
        }));
      }
      break;
    }
    case 'binary_shard_index': {
      const index = EncryptedBinaryShardIndexSchemaDto.parse(value);
      for (const [binaryObjectId, object] of Object.entries(index.objects)) {
        references.push(logicalReference({
          label: `Binary file ${binaryObjectId}`,
          area: ref.area,
          namespace: 'file_manifest',
          key: object.fileId,
        }));
      }
      break;
    }
    case 'volume_index': {
      const index = VolumeIndexSchemaDto.parse(value);
      for (const [volumeId, volume] of Object.entries(index.volumes)) {
        const fileSystemId = getOpfsVolumeFileSystemId({ volumeId, volume });
        if (fileSystemId === undefined) {
          continue;
        }
        references.push(logicalReference({
          label: `Volume filesystem ${volume.name}`,
          area: ref.area,
          namespace: 'file_system_descriptor',
          key: fileSystemId,
        }));
      }
      break;
    }
    case 'file_system_descriptor': {
      const descriptor = EncryptedFileSystemDescriptorSchemaDto.parse(value);
      references.push(
        {
          label: 'Filesystem',
          ref: { type: 'file_system', area: ref.area, fileSystemId: descriptor.id },
        },
        logicalReference({
          label: 'Root directory manifest',
          area: ref.area,
          namespace: 'directory_manifest',
          key: descriptor.rootDirectoryId,
        }),
        logicalReference({
          label: 'Filesystem mutation journal',
          area: ref.area,
          namespace: 'object_transaction_journal',
          key: `file-system/${descriptor.rootDirectoryId}`,
        }),
      );
      break;
    }
    case 'directory_manifest': {
      const manifest = EncryptedDirectoryManifestSchemaDto.parse(value);
      for (const shard of manifest.shards) {
        references.push(logicalReference({
          label: `Directory shard ${shard.shardId}`,
          area: ref.area,
          namespace: 'directory_shard',
          key: shard.objectId,
        }));
      }
      break;
    }
    case 'file_manifest': {
      const manifest = EncryptedFileManifestSchemaDto.parse(value);
      for (const pageId of manifest.chunkMapPageIds) {
        references.push(logicalReference({
          label: `Chunk map page ${pageId}`,
          area: ref.area,
          namespace: 'file_chunk_map_page',
          key: pageId,
        }));
      }
      break;
    }
    case 'directory_shard': {
      const shard = EncryptedDirectoryShardContentsSchemaDto.parse(value);
      for (const entry of Object.values(shard.entries)) {
        switch (entry.type) {
        case 'file':
          references.push(logicalReference({
            label: `File manifest ${entry.name}`,
            area: ref.area,
            namespace: 'file_manifest',
            key: entry.fileId,
          }));
          break;
        case 'directory':
          references.push(logicalReference({
            label: `Directory manifest ${entry.name}`,
            area: ref.area,
            namespace: 'directory_manifest',
            key: entry.directoryId,
          }));
          break;
        case 'symlink':
          break;
        default: {
          const _ex: never = entry;
          throw new Error(`Unhandled encrypted directory entry: ${String(_ex)}`);
        }
        }
      }
      break;
    }
    case 'file_chunk_map_page': {
      const page = EncryptedFileChunkMapPageSchemaDto.parse(value);
      for (const chunkId of page.chunkIds) {
        if (chunkId !== null) {
          references.push(logicalReference({
            label: `Chunk ${chunkId}`,
            area: ref.area,
            namespace: 'file_chunk',
            key: chunkId,
          }));
        }
      }
      break;
    }
    case 'object_transaction_journal': {
      const transaction = EncryptedObjectTransactionSchemaDto.parse(value);
      for (const operation of transaction.operations) {
        references.push(logicalReference({
          label: `${operation.type} ${operation.namespace}:${operation.key}`,
          area: ref.area,
          namespace: operation.namespace,
          key: operation.key,
        }));
      }
      break;
    }
    default:
      break;
    }
    return references;
  }

  private async readManifest(): Promise<NaidanEncryptedStoreManifestDto> {
    const bytes = await this.durableObjectStore.read({
      locator: { namespace: 'singleton', key: 'store_manifest' },
    });
    if (bytes === undefined) {
      throw new Error('Encrypted store manifest is missing');
    }
    return NaidanEncryptedStoreManifestSchemaDto.parse(parseJsonBytes({ bytes }));
  }

  private getObjectStore({ area }: { area: EncryptedObjectPhysicalArea }): EncryptedObjectStore {
    switch (area) {
    case 'durable':
      return this.durableObjectStore;
    case 'temporary':
      return this.temporaryObjectStore;
    default: {
      const _ex: never = area;
      throw new Error(`Unhandled encrypted object area: ${String(_ex)}`);
    }
    }
  }

  private getCollectionIndexNamespace({ type }: { type: NaidanEncryptedCollectionTypeDto }): string {
    switch (type) {
    case 'chat_meta':
      return 'chat_meta_shard_index';
    case 'chat_group':
      return 'chat_group_shard_index';
    case 'binary_object':
      return 'binary_shard_index';
    case 'volume':
      return 'volume_index';
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled encrypted collection type: ${String(_ex)}`);
    }
    }
  }

  private shouldInspectKnownObjectReferences({
    namespace,
    includeFileChunks,
  }: {
    namespace: string,
    includeFileChunks: boolean,
  }): boolean {
    switch (namespace) {
    case 'object_transaction_journal':
    case 'file_system_descriptor':
    case 'directory_manifest':
    case 'directory_shard':
    case 'file_manifest':
      return true;
    case 'file_chunk_map_page':
      return includeFileChunks;
    default:
      return false;
    }
  }

  private async collectKnownLogicalObjects({
    includeFileChunks,
  }: {
    includeFileChunks: boolean,
  }): Promise<KnownLogicalObject[]> {
    const knownByIdentity = new Map<string, KnownLogicalObject>();
    const pending: KnownLogicalObject[] = [];

    const addKnown = ({
      label,
      detail,
      locator,
      area,
      required = true,
    }: {
      label: string,
      detail: string,
      locator: EncryptedObjectLocator,
      area: EncryptedObjectPhysicalArea,
      required?: boolean,
    }): void => {
      const identity = `${area}\u0000${locator.namespace}\u0000${locator.key}`;
      const existing = knownByIdentity.get(identity);
      if (existing !== undefined) {
        if (required && !existing.required) {
          const promoted = { ...existing, required: true };
          knownByIdentity.set(identity, promoted);
          const pendingIndex = pending.indexOf(existing);
          if (pendingIndex >= 0) {
            pending[pendingIndex] = promoted;
          }
        }
        return;
      }
      const object: KnownLogicalObject = {
        label,
        detail,
        locator,
        area,
        required,
      };
      knownByIdentity.set(identity, object);
      pending.push(object);
    };

    addKnown({
      label: 'Settings',
      detail: 'Naidan singleton',
      locator: { namespace: 'singleton', key: 'settings' },
      area: 'durable',
      required: false,
    });
    addKnown({
      label: 'Hierarchy',
      detail: 'Naidan singleton',
      locator: { namespace: 'singleton', key: 'hierarchy' },
      area: 'durable',
      required: false,
    });
    addKnown({
      label: 'Store manifest',
      detail: 'Naidan encrypted store catalog',
      locator: { namespace: 'singleton', key: 'store_manifest' },
      area: 'durable',
    });
    addKnown({
      label: 'Naidan store transaction journal',
      detail: 'Optional in-progress atomic mutation',
      locator: { namespace: 'object_transaction_journal', key: 'naidan-store' },
      area: 'durable',
      required: false,
    });

    const manifest = await this.readManifest();
    for (const collection of manifest.collections) {
      for (const shardId of collection.shardIds) {
        const indexLocator = {
          namespace: this.getCollectionIndexNamespace({ type: collection.type }),
          key: shardId,
        };
        addKnown({
          label: `${collection.type} shard ${shardId}`,
          detail: 'Collection shard index',
          locator: indexLocator,
          area: 'durable',
        });
        const bytes = await this.durableObjectStore.read({ locator: indexLocator });
        if (bytes === undefined) {
          continue;
        }
        const value = parseJsonBytes({ bytes });
        switch (collection.type) {
        case 'chat_meta': {
          const index = EncryptedChatMetaShardIndexSchemaDto.parse(value);
          for (const id of index.chatIds) {
            addKnown({
              label: `Chat meta ${id}`,
              detail: 'ChatMetaDto',
              locator: { namespace: 'chat_meta', key: id },
              area: 'durable',
            });
            addKnown({
              label: `Chat content ${id}`,
              detail: 'ChatContentDto',
              locator: { namespace: 'chat_content', key: id },
              area: 'durable',
            });
          }
          break;
        }
        case 'chat_group': {
          const index = EncryptedChatGroupShardIndexSchemaDto.parse(value);
          for (const id of index.chatGroupIds) {
            addKnown({
              label: `Chat group ${id}`,
              detail: 'ChatGroupDto',
              locator: { namespace: 'chat_group', key: id },
              area: 'durable',
            });
          }
          break;
        }
        case 'binary_object': {
          const index = EncryptedBinaryShardIndexSchemaDto.parse(value);
          for (const [id, object] of Object.entries(index.objects)) {
            addKnown({
              label: `Binary file ${id}`,
              detail: object.metadata.mimeType,
              locator: { namespace: 'file_manifest', key: object.fileId },
              area: 'durable',
            });
          }
          break;
        }
        case 'volume': {
          const index = VolumeIndexSchemaDto.parse(value);
          for (const [id, volume] of Object.entries(index.volumes)) {
            const fileSystemId = getOpfsVolumeFileSystemId({ volumeId: id, volume });
            if (fileSystemId === undefined) {
              continue;
            }
            addKnown({
              label: `Volume filesystem ${volume.name}`,
              detail: fileSystemId,
              locator: { namespace: 'file_system_descriptor', key: fileSystemId },
              area: 'durable',
            });
          }
          break;
        }
        default: {
          const _ex: never = collection.type;
          throw new Error(`Unhandled collection type: ${String(_ex)}`);
        }
        }
      }
    }

    for (const fileSystem of KNOWN_FILE_SYSTEMS) {
      addKnown({
        label: `Filesystem ${fileSystem.id}`,
        detail: fileSystem.area,
        locator: { namespace: 'file_system_descriptor', key: fileSystem.id },
        area: fileSystem.area,
        required: false,
      });
    }

    for (let index = 0; index < pending.length; index += 1) {
      const object = pending[index];
      if (object === undefined) {
        continue;
      }
      if (!this.shouldInspectKnownObjectReferences({
        namespace: object.locator.namespace,
        includeFileChunks,
      })) {
        continue;
      }
      const bytes = await this.getObjectStore({ area: object.area }).read({
        locator: object.locator,
      });
      if (bytes === undefined) {
        continue;
      }
      let value: unknown;
      try {
        value = parseJsonBytes({ bytes });
      } catch {
        continue;
      }
      if (object.locator.namespace === 'object_transaction_journal') {
        let transaction;
        try {
          transaction = EncryptedObjectTransactionSchemaDto.parse(value);
        } catch {
          continue;
        }
        for (const operation of transaction.operations) {
          const operationRef = {
            type: 'logical_object' as const,
            area: object.area,
            namespace: operation.namespace,
            key: operation.key,
          };
          addKnown({
            label: `${operation.type} ${operation.namespace}:${operation.key}`,
            detail: `Prepared by ${object.locator.key}`,
            locator: {
              namespace: operation.namespace,
              key: operation.key,
            },
            area: object.area,
            required: false,
          });
          const writeOperation = getWriteTransactionOperation({ operation });
          if (writeOperation === undefined) {
            continue;
          }
          let preparedValue: unknown;
          try {
            preparedValue = parseJsonBytes({
              bytes: decodeBase64Url({ value: writeOperation.plaintextBase64Url }),
            });
          } catch {
            continue;
          }
          let preparedReferences: EncryptedStorageDebugReference[];
          try {
            preparedReferences = await this.inferReferences({
              ref: operationRef,
              value: preparedValue,
            });
          } catch {
            continue;
          }
          for (const reference of preparedReferences) {
            const logicalRef = getLogicalObjectNodeRef({ ref: reference.ref });
            if (logicalRef === undefined) {
              continue;
            }
            addKnown({
              label: reference.label,
              detail: `Prepared by ${object.locator.key}`,
              locator: {
                namespace: logicalRef.namespace,
                key: logicalRef.key,
              },
              area: logicalRef.area,
              required: logicalRef.namespace !== 'object_transaction_journal',
            });
          }
        }
        continue;
      }
      let references: EncryptedStorageDebugReference[];
      try {
        references = await this.inferReferences({
          ref: {
            type: 'logical_object',
            area: object.area,
            namespace: object.locator.namespace,
            key: object.locator.key,
          },
          value,
        });
      } catch {
        continue;
      }
      for (const reference of references) {
        const logicalRef = getLogicalObjectNodeRef({ ref: reference.ref });
        if (logicalRef === undefined) {
          continue;
        }
        addKnown({
          label: reference.label,
          detail: `Referenced by ${object.locator.namespace}:${object.locator.key}`,
          locator: {
            namespace: logicalRef.namespace,
            key: logicalRef.key,
          },
          area: logicalRef.area,
          required: logicalRef.namespace !== 'object_transaction_journal',
        });
      }
    }

    return [...knownByIdentity.values()];
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
