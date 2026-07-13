<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  ArrowLeftIcon,
  BoxesIcon,
  ChevronRightIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  FileSearchIcon,
  FolderRootIcon,
  FolderTreeIcon,
  HardDriveIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-vue-next';
import { useDebugEncryptedOpfsWorkbench } from '@/features/debug-encrypted-opfs/composables/useDebugEncryptedOpfsWorkbench';
import { useDebugOpfsEncryptionInspector } from '@/features/debug-opfs-encryption/composables/useDebugOpfsEncryptionInspector';
import {
  createEncryptedOpfsWorkbenchWorkspace,
  destroyEncryptedOpfsWorkbenchWorkspace,
  listEncryptedOpfsWorkbenchSources,
  openEncryptedOpfsWorkbenchSource,
  type EncryptedOpfsWorkbenchSource,
  type EncryptedOpfsWorkbenchSourceSession,
} from '@/features/debug-encrypted-opfs/logic/workbench-sources';
import { createEncryptedOpfsInspectionWorkerClient } from '@/features/debug-encrypted-opfs/worker/client';
import type {
  EncryptedOpfsBinaryRecordInspectionView,
  EncryptedOpfsBinarySliceView,
  EncryptedOpfsInspectionOverviewView,
  EncryptedOpfsInspectionWorkerClient,
  EncryptedOpfsInspectedObjectView,
  EncryptedOpfsIntegrityScanResult,
  EncryptedOpfsNamespaceResult,
  EncryptedOpfsPhysicalObjectPageView,
  EncryptedOpfsResolvedNodeView,
} from '@/features/debug-encrypted-opfs/worker/types';
import FileExplorer from '@/features/file-explorer/components/FileExplorer.vue';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import type { FileExplorerRootDescriptor } from '@/features/file-explorer/worker/types';
import { JsonCodeView } from '@/features/json-viewer';
import BinaryHexView from './BinaryHexView.vue';
import BinaryRecordInspectionView from './BinaryRecordInspectionView.vue';

const OBJECT_ROW_HEIGHT = 58;
const OBJECT_OVERSCAN = 8;

/**
 * Persisted records and object references are the primary Workbench
 * navigation. Logical paths and File Explorer are intentionally represented as
 * explicit derived columns so a filesystem-shaped convenience view cannot be
 * mistaken for the EncryptedOpfs persistence protocol itself.
 */
type WorkbenchDetailColumn =
  | {
      readonly kind: 'descriptor';
      readonly id: string;
      readonly title: string;
    }
  | {
      readonly kind: 'superblock_slots';
      readonly id: string;
      readonly title: string;
    }
  | {
      readonly kind: 'superblock_slot';
      readonly id: string;
      readonly title: string;
      readonly slotIndex: number;
    }
  | {
      readonly kind: 'active_commit';
      readonly id: string;
      readonly title: string;
    }
  | {
      readonly kind: 'object_store';
      readonly id: string;
      readonly title: string;
    }
  | {
      readonly kind: 'object';
      readonly id: string;
      readonly title: string;
      readonly objectId: string;
      loading: boolean;
      value: EncryptedOpfsInspectedObjectView | undefined;
      errorMessage: string | undefined;
    }
  | {
      readonly kind: 'resolved_node';
      readonly id: string;
      readonly title: string;
      readonly commitObjectId: string;
      readonly nodeId: string;
      readonly logicalPath: string;
      loading: boolean;
      value: EncryptedOpfsResolvedNodeView | undefined;
      errorMessage: string | undefined;
    }
  | {
      readonly kind: 'derived_views';
      readonly id: string;
      readonly title: string;
    }
  | {
      readonly kind: 'logical_paths';
      readonly id: string;
      readonly title: string;
    }
  | {
      readonly kind: 'file_explorer';
      readonly id: string;
      readonly title: string;
    }
  | {
      readonly kind: 'integrity';
      readonly id: string;
      readonly title: string;
    };

const { closeDebugEncryptedOpfsWorkbench } = useDebugEncryptedOpfsWorkbench();
const { openDebugOpfsEncryptionInspector } = useDebugOpfsEncryptionInspector();
const { openFileExplorer } = useFileExplorerModal();

const sources = ref<readonly EncryptedOpfsWorkbenchSource[]>([]);
const selectedSource = ref<EncryptedOpfsWorkbenchSource>();
const sourceSession = ref<EncryptedOpfsWorkbenchSourceSession>();
const client = ref<EncryptedOpfsInspectionWorkerClient>();
const overview = ref<EncryptedOpfsInspectionOverviewView>();
const columns = ref<WorkbenchDetailColumn[]>([]);
const loadingSources = ref(true);
const loadingSource = ref(false);
const creatingWorkspace = ref(false);
const errorMessage = ref<string>();

const namespaceLoading = ref(false);
const namespaceResult = ref<EncryptedOpfsNamespaceResult>();
const objectsLoading = ref(false);
const objectPage = ref<EncryptedOpfsPhysicalObjectPageView>();
const objectEntries = ref<EncryptedOpfsPhysicalObjectPageView['entries']>([]);
const objectScrollTop = ref(0);
const objectViewportHeight = ref(520);
const integrityLoading = ref(false);
const integrityResult = ref<EncryptedOpfsIntegrityScanResult>();

const revisionLabel = computed(() => overview.value === undefined
  ? 'no open instance'
  : `revision ${String(overview.value.activeCommit.revision)}`);
/**
 * Navigation starts with the source and filesystem instance, not with files.
 * The Workbench can inspect both Naidan's active store and independent debug
 * instances, so retaining this identity prevents a logical path or object from
 * losing the context of which EncryptedOpfs it belongs to.
 */
const breadcrumbLabels = computed(() => [
  selectedSource.value?.label,
  'File system instance',
  ...columns.value.map(column => column.title),
].filter((value): value is string => value !== undefined));
const fileExplorerRoot = computed<FileExplorerRootDescriptor | undefined>(() => {
  const session = sourceSession.value;
  const source = selectedSource.value;
  if (session === undefined || source === undefined || source.type === 'stale_debug_workspace') {
    return undefined;
  }
  /**
   * The decrypted EncryptedOpfs root is passed directly to File Explorer.
   *
   * A Wesh mount is a shell-oriented abstraction for composing several roots;
   * it is not part of this filesystem instance. Passing a direct root avoids
   * inventing mount semantics and keeps paths such as /naidan-storage relative
   * to the actual EncryptedOpfs root.
   */
  return {
    kind: 'storage-directory',
    rootName: `${source.label} root`,
    handle: session.decryptedRoot,
    readOnly: source.access === 'read_only',
  };
});
const visibleObjectRange = computed(() => {
  const start = Math.max(0, Math.floor(objectScrollTop.value / OBJECT_ROW_HEIGHT) - OBJECT_OVERSCAN);
  const visibleCount = Math.ceil(objectViewportHeight.value / OBJECT_ROW_HEIGHT) + OBJECT_OVERSCAN * 2;
  return {
    start,
    end: Math.min(objectEntries.value.length, start + visibleCount),
  };
});
const visibleObjectEntries = computed(() => objectEntries.value.slice(
  visibleObjectRange.value.start,
  visibleObjectRange.value.end,
));
const objectTopSpacerHeight = computed(() => visibleObjectRange.value.start * OBJECT_ROW_HEIGHT);
const objectBottomSpacerHeight = computed(() => (
  objectEntries.value.length - visibleObjectRange.value.end
) * OBJECT_ROW_HEIGHT);

onMounted(async () => {
  await refreshSources({ preferredSourceId: undefined });
});

onUnmounted(() => {
  void disposeSourceResources();
});

async function refreshSources({ preferredSourceId }: {
  preferredSourceId: string | undefined;
}): Promise<void> {
  loadingSources.value = true;
  errorMessage.value = undefined;
  try {
    const nextSources = await listEncryptedOpfsWorkbenchSources();
    sources.value = nextSources;
    const sourceId = preferredSourceId ?? selectedSource.value?.sourceId;
    const preferred = sourceId === undefined
      ? nextSources.find(source => source.type === 'naidan_active_store')
        ?? nextSources.find(source => source.type === 'ephemeral_debug_workspace')
      : nextSources.find(source => source.sourceId === sourceId);
    if (preferred !== undefined) {
      await selectSource({ source: preferred });
    } else {
      await disposeSourceResources();
      selectedSource.value = undefined;
      columns.value = [];
    }
  } catch (error) {
    errorMessage.value = toErrorMessage({ error });
  } finally {
    loadingSources.value = false;
  }
}

async function createWorkspace(): Promise<void> {
  if (creatingWorkspace.value) return;
  creatingWorkspace.value = true;
  errorMessage.value = undefined;
  try {
    const source = await createEncryptedOpfsWorkbenchWorkspace();
    await refreshSources({ preferredSourceId: source.sourceId });
  } catch (error) {
    errorMessage.value = toErrorMessage({ error });
  } finally {
    creatingWorkspace.value = false;
  }
}

async function destroyWorkspace({ source }: {
  source: Extract<EncryptedOpfsWorkbenchSource, {
    readonly type: 'ephemeral_debug_workspace' | 'stale_debug_workspace';
  }>;
}): Promise<void> {
  errorMessage.value = undefined;
  try {
    if (selectedSource.value?.sourceId === source.sourceId) {
      await disposeSourceResources();
      selectedSource.value = undefined;
      columns.value = [];
    }
    await destroyEncryptedOpfsWorkbenchWorkspace({ source });
    await refreshSources({ preferredSourceId: undefined });
  } catch (error) {
    errorMessage.value = toErrorMessage({ error });
  }
}

async function selectSource({ source }: { source: EncryptedOpfsWorkbenchSource }): Promise<void> {
  if (selectedSource.value?.sourceId === source.sourceId && sourceSession.value !== undefined) {
    return;
  }
  loadingSource.value = true;
  errorMessage.value = undefined;
  await disposeSourceResources();
  selectedSource.value = source;
  columns.value = [];
  resetDerivedState();
  switch (source.type) {
  case 'stale_debug_workspace':
    loadingSource.value = false;
    return;
  case 'naidan_active_store':
  case 'ephemeral_debug_workspace':
    break;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled EncryptedOpfs Workbench source: ${String(_ex)}`);
  }
  }
  try {
    const nextSession = await openEncryptedOpfsWorkbenchSource({ source });
    const nextClient = await createEncryptedOpfsInspectionWorkerClient({
      reader: nextSession.encryptedOpfsReader,
    });
    sourceSession.value = nextSession;
    client.value = nextClient;
    overview.value = await nextClient.readOverview();
  } catch (error) {
    errorMessage.value = toErrorMessage({ error });
    await disposeSourceResources();
  } finally {
    loadingSource.value = false;
  }
}

async function refreshSelectedInstance(): Promise<void> {
  const source = selectedSource.value;
  if (source === undefined || source.type === 'stale_debug_workspace') return;
  await selectSourceAfterReset({ source });
}

async function selectSourceAfterReset({ source }: {
  source: Exclude<EncryptedOpfsWorkbenchSource, { readonly type: 'stale_debug_workspace' }>;
}): Promise<void> {
  selectedSource.value = undefined;
  await selectSource({ source });
}

async function disposeSourceResources(): Promise<void> {
  const previousClient = client.value;
  const previousSession = sourceSession.value;
  client.value = undefined;
  sourceSession.value = undefined;
  overview.value = undefined;
  try {
    await previousClient?.dispose();
  } finally {
    await previousSession?.dispose();
  }
}

function resetDerivedState(): void {
  namespaceResult.value = undefined;
  objectPage.value = undefined;
  objectEntries.value = [];
  integrityResult.value = undefined;
  objectScrollTop.value = 0;
}

function openDescriptor(): void {
  appendColumn({
    afterIndex: -1,
    column: { kind: 'descriptor', id: 'descriptor', title: 'Descriptor' },
  });
}

function openSuperblockSlots(): void {
  appendColumn({
    afterIndex: -1,
    column: { kind: 'superblock_slots', id: 'superblock-slots', title: 'Superblock slots' },
  });
}

function openActiveCommit(): void {
  appendColumn({
    afterIndex: -1,
    column: { kind: 'active_commit', id: 'active-commit', title: 'Active commit' },
  });
}

/**
 * Exposes the root directory as a shallow Workbench entry point so routine
 * filesystem traversal does not require reopening the active superblock and
 * commit chain every time. This does not invent a separate persisted root
 * concept: the selected commit, rootDirectoryNodeId, every inode-index page,
 * and the resolved inode object remain explicit navigation targets.
 */
async function openActiveRootDirectory({ afterIndex }: {
  afterIndex: number;
}): Promise<void> {
  const currentOverview = overview.value;
  if (currentOverview === undefined) return;
  await openResolvedNode({
    commitObjectId: currentOverview.activeCommitObjectId,
    nodeId: currentOverview.activeCommit.rootDirectoryNodeId,
    logicalPath: '/',
    title: 'Root directory',
    afterIndex,
  });
}

async function openRootDirectoryEntryPoint({
  entryPoint,
  afterIndex,
}: {
  entryPoint: NonNullable<EncryptedOpfsInspectedObjectView['rootDirectoryEntryPoint']>;
  afterIndex: number;
}): Promise<void> {
  await openResolvedNode({
    commitObjectId: entryPoint.commitObjectId,
    nodeId: entryPoint.rootDirectoryNodeId,
    logicalPath: '/',
    title: `Root directory · revision ${String(entryPoint.revision)}`,
    afterIndex,
  });
}

async function openResolvedNode({
  commitObjectId,
  nodeId,
  logicalPath,
  title,
  afterIndex,
}: {
  commitObjectId: string;
  nodeId: string;
  logicalPath: string;
  title: string;
  afterIndex: number;
}): Promise<void> {
  const column = reactive<Extract<WorkbenchDetailColumn, { readonly kind: 'resolved_node' }>>({
    kind: 'resolved_node',
    id: `node:${commitObjectId}:${nodeId}:${String(Date.now())}`,
    title,
    commitObjectId,
    nodeId,
    logicalPath,
    loading: true,
    value: undefined,
    errorMessage: undefined,
  });
  appendColumn({ afterIndex, column });
  const currentClient = client.value;
  if (currentClient === undefined) {
    column.loading = false;
    column.errorMessage = 'No EncryptedOpfs inspection worker is open';
    return;
  }
  try {
    column.value = await currentClient.readNode({
      commitObjectId,
      nodeId,
      logicalPath,
      maximumDirectoryEntryCount: 10_000,
    });
  } catch (error) {
    column.errorMessage = toErrorMessage({ error });
  } finally {
    column.loading = false;
  }
}

async function openChildNode({
  parent,
  entry,
  afterIndex,
}: {
  parent: EncryptedOpfsResolvedNodeView;
  entry: NonNullable<EncryptedOpfsResolvedNodeView['directory']>['entries'][number]['entry'];
  afterIndex: number;
}): Promise<void> {
  const logicalPath = parent.logicalPath === '/'
    ? `/${entry.name}`
    : `${parent.logicalPath}/${entry.name}`;
  await openResolvedNode({
    commitObjectId: parent.commitObjectId,
    nodeId: entry.nodeId,
    logicalPath,
    title: entry.name,
    afterIndex,
  });
}

function getDirectoryEntrySourceObjectId({
  source,
}: {
  source: NonNullable<EncryptedOpfsResolvedNodeView['directory']>['entries'][number]['source'];
}): string {
  switch (source.type) {
  case 'inline':
    return source.directoryInodeObjectId;
  case 'indexed':
    return source.directoryIndexPageObjectId;
  default: {
    const _ex: never = source;
    return _ex;
  }
  }
}

async function openObjectStore(): Promise<void> {
  appendColumn({
    afterIndex: -1,
    column: { kind: 'object_store', id: 'object-store', title: 'Physical object store' },
  });
  if (objectPage.value === undefined) {
    await loadFirstObjectPage();
  }
}

function openDerivedViews(): void {
  appendColumn({
    afterIndex: -1,
    column: { kind: 'derived_views', id: 'derived-views', title: 'Derived views' },
  });
}

function openIntegrity(): void {
  appendColumn({
    afterIndex: -1,
    column: { kind: 'integrity', id: 'integrity', title: 'Integrity and reachability' },
  });
}

function openSuperblockSlot({ slotIndex, afterIndex }: {
  slotIndex: number;
  afterIndex: number;
}): void {
  appendColumn({
    afterIndex,
    column: {
      kind: 'superblock_slot',
      id: `superblock-slot-${String(slotIndex)}`,
      title: `Superblock slot ${String(slotIndex)}`,
      slotIndex,
    },
  });
}

async function openObject({ objectId, relation, afterIndex }: {
  objectId: string;
  relation: string;
  afterIndex: number;
}): Promise<void> {
  const column = reactive<Extract<WorkbenchDetailColumn, { readonly kind: 'object' }>>({
    kind: 'object',
    id: `object:${objectId}:${String(Date.now())}`,
    title: relation,
    objectId,
    loading: true,
    value: undefined,
    errorMessage: undefined,
  });
  appendColumn({ afterIndex, column });
  const currentClient = client.value;
  if (currentClient === undefined) {
    column.loading = false;
    column.errorMessage = 'No EncryptedOpfs inspection worker is open';
    return;
  }
  try {
    column.value = await currentClient.inspectObject({
      objectId,
      binaryPreviewByteLength: 1024,
    });
    if (column.value === undefined) {
      column.errorMessage = `Object not found: ${objectId}`;
    }
  } catch (error) {
    column.errorMessage = toErrorMessage({ error });
  } finally {
    column.loading = false;
  }
}

async function openLogicalPaths({ afterIndex }: { afterIndex: number }): Promise<void> {
  appendColumn({
    afterIndex,
    column: { kind: 'logical_paths', id: 'logical-paths', title: 'Derived logical paths' },
  });
  if (namespaceResult.value === undefined) {
    await loadNamespace();
  }
}

function openFileExplorerColumn({ afterIndex }: { afterIndex: number }): void {
  appendColumn({
    afterIndex,
    column: { kind: 'file_explorer', id: 'file-explorer', title: 'Derived filesystem view' },
  });
}

function appendColumn({ afterIndex, column }: {
  afterIndex: number;
  column: WorkbenchDetailColumn;
}): void {
  columns.value = [...columns.value.slice(0, afterIndex + 1), column];
  void nextTick(() => {
    const scrollContainer = document.querySelector<HTMLElement>('[data-workbench-column-scroll]');
    if (scrollContainer === null) return;
    if (typeof scrollContainer.scrollTo === 'function') {
      scrollContainer.scrollTo({
        left: Number.MAX_SAFE_INTEGER,
        behavior: 'smooth',
      });
      return;
    }
    scrollContainer.scrollLeft = scrollContainer.scrollWidth;
  });
}

function truncateColumns({ lastIndex }: { lastIndex: number }): void {
  columns.value = columns.value.slice(0, lastIndex + 1);
}

function navigateBack(): void {
  columns.value = columns.value.slice(0, -1);
}

async function loadNamespace(): Promise<void> {
  const currentClient = client.value;
  if (currentClient === undefined || namespaceLoading.value) return;
  namespaceLoading.value = true;
  try {
    namespaceResult.value = await currentClient.readNamespace({ maximumEntryCount: 10_000 });
  } catch (error) {
    errorMessage.value = toErrorMessage({ error });
  } finally {
    namespaceLoading.value = false;
  }
}

async function loadFirstObjectPage(): Promise<void> {
  objectEntries.value = [];
  objectPage.value = undefined;
  objectScrollTop.value = 0;
  await loadMoreObjects({ cursor: undefined });
}

async function loadMoreObjects({ cursor }: { cursor: string | undefined }): Promise<void> {
  const currentClient = client.value;
  if (currentClient === undefined || objectsLoading.value) return;
  objectsLoading.value = true;
  try {
    const page = await currentClient.listPhysicalObjects({ cursor, limit: 200 });
    objectPage.value = page;
    objectEntries.value = [...objectEntries.value, ...page.entries];
  } catch (error) {
    errorMessage.value = toErrorMessage({ error });
  } finally {
    objectsLoading.value = false;
  }
}

function handleObjectListScroll({ event }: { event: Event }): void {
  const element = event.currentTarget;
  if (!(element instanceof HTMLElement)) return;
  objectScrollTop.value = element.scrollTop;
  objectViewportHeight.value = element.clientHeight;
  if (
    element.scrollTop + element.clientHeight >= element.scrollHeight - OBJECT_ROW_HEIGHT * 4
    && objectPage.value?.nextCursor !== undefined
    && !objectsLoading.value
  ) {
    void loadMoreObjects({ cursor: objectPage.value.nextCursor });
  }
}

async function runIntegrityScan(): Promise<void> {
  const currentClient = client.value;
  if (currentClient === undefined || integrityLoading.value) return;
  integrityLoading.value = true;
  integrityResult.value = undefined;
  try {
    integrityResult.value = await currentClient.runIntegrityScan();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      errorMessage.value = toErrorMessage({ error });
    }
  } finally {
    integrityLoading.value = false;
  }
}

async function cancelIntegrityScan(): Promise<void> {
  await client.value?.cancelCurrentOperation();
}

function requireSuperblockSlot({ slotIndex }: { slotIndex: number }): EncryptedOpfsInspectionOverviewView['superblockSlots'][number] {
  const slot = overview.value?.superblockSlots[slotIndex];
  if (slot === undefined) {
    throw new Error(`Superblock slot is unavailable: ${String(slotIndex)}`);
  }
  return slot;
}

function requireSuperblockPersistedDto({ slotIndex }: { slotIndex: number }): unknown {
  const slot = requireSuperblockSlot({ slotIndex });
  switch (slot.status) {
  case 'valid':
    return slot.persistedDto;
  case 'missing':
  case 'invalid':
  case 'unsupported':
    throw new Error(`Superblock slot has no persisted DTO: ${String(slotIndex)}`);
  default: {
    const _ex: never = slot;
    return _ex;
  }
  }
}

function requireInvalidSuperblockErrorMessage({ slotIndex }: {
  slotIndex: number;
}): string {
  const slot = requireSuperblockSlot({ slotIndex });
  switch (slot.status) {
  case 'invalid':
  case 'unsupported':
    return slot.errorMessage;
  case 'missing':
  case 'valid':
    throw new Error(`Superblock slot has no decode error: ${String(slotIndex)}`);
  default: {
    const _ex: never = slot;
    return _ex;
  }
  }
}

function getSuperblockSlotPhysicalPath({ slotIndex }: { slotIndex: number }): string {
  return overview.value?.superblockSlots[slotIndex]?.physicalPath.join('/') ?? '(unknown)';
}

function isSuperblockSlotValid({ slotIndex }: { slotIndex: number }): boolean {
  return overview.value?.superblockSlots[slotIndex]?.status === 'valid';
}

function requireSuperblockSlotBinary({ slotIndex }: {
  slotIndex: number;
}): EncryptedOpfsBinaryRecordInspectionView {
  const slot = requireSuperblockSlot({ slotIndex });
  switch (slot.status) {
  case 'valid':
    return slot.binary;
  case 'missing':
  case 'invalid':
  case 'unsupported':
    throw new Error(`Superblock slot is not valid: ${String(slotIndex)}`);
  default: {
    const _ex: never = slot;
    return _ex;
  }
  }
}

function requireInvalidSuperblockPhysicalBytes({ slotIndex }: {
  slotIndex: number;
}): EncryptedOpfsBinarySliceView {
  const slot = requireSuperblockSlot({ slotIndex });
  switch (slot.status) {
  case 'invalid':
  case 'unsupported':
    return slot.physicalBytes;
  case 'missing':
  case 'valid':
    throw new Error(`Superblock slot has no invalid physical bytes: ${String(slotIndex)}`);
  default: {
    const _ex: never = slot;
    return _ex;
  }
  }
}

function isSuperblockSlotInvalid({ slotIndex }: { slotIndex: number }): boolean {
  const status = overview.value?.superblockSlots[slotIndex]?.status;
  return status === 'invalid' || status === 'unsupported';
}

function getObjectPersistedDto({ value }: {
  value: EncryptedOpfsInspectedObjectView;
}): unknown {
  // Schema validation must never hide the JSON metadata that was actually decrypted.
  return value.object.record.metadata;
}

function getObjectValidationError({ value }: {
  value: EncryptedOpfsInspectedObjectView;
}): string | undefined {
  switch (value.validation.status) {
  case 'valid':
    return undefined;
  case 'invalid':
    return value.validation.errorMessage;
  default: {
    const _ex: never = value.validation;
    return _ex;
  }
  }
}

function rawJson({ value }: { value: unknown }): string {
  /**
   * Raw DTO views preserve the persisted property names and values exactly as
   * parsed. Base64URL strings, identifiers, arrays, timestamps, and property
   * order are not normalized for presentation. Any interpretation belongs in
   * a separately labelled derived or parsed-binary section.
   */
  return JSON.stringify(value, undefined, 2);
}

function openRawOpfs(): void {
  closeDebugEncryptedOpfsWorkbench();
  openFileExplorer({ options: { kind: 'opfs-root' } });
}

function openControlPlane(): void {
  closeDebugEncryptedOpfsWorkbench();
  openDebugOpfsEncryptionInspector();
}

function toErrorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      refreshSources,
      createWorkspace,
      runIntegrityScan,
    },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div tw-class="fixed inset-0 z-[125] flex items-center justify-center bg-black/55 p-2 sm:p-4" @click.self="closeDebugEncryptedOpfsWorkbench">
      <section role="dialog" aria-modal="true" aria-labelledby="encrypted-opfs-workbench-title" tw-class="flex h-[96vh] w-full max-w-[1800px] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <header tw-class="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <DatabaseIcon tw-class="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          <div tw-class="min-w-0 flex-1">
            <h2 id="encrypted-opfs-workbench-title" tw-class="text-sm font-semibold text-gray-900 dark:text-gray-100">EncryptedOpfs Workbench</h2>
            <div tw-class="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[10px] text-gray-500 dark:text-gray-400">
              <span tw-class="truncate">{{ selectedSource?.label ?? 'No source selected' }}</span>
              <span>·</span>
              <span>{{ revisionLabel }}</span>
            </div>
          </div>
          <button type="button" tw-class="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="openRawOpfs"><ExternalLinkIcon tw-class="mr-1 inline h-3.5 w-3.5" /> Raw OPFS</button>
          <button v-if="selectedSource?.type === 'naidan_active_store'" type="button" data-testid="encrypted-opfs-open-control-plane" tw-class="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="openControlPlane">Naidan control plane</button>
          <button type="button" aria-label="Refresh EncryptedOpfs instance" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" :disabled="loadingSource" @click="refreshSelectedInstance"><RefreshCwIcon :tw-class="['h-4 w-4', loadingSource ? 'animate-spin' : '']" /></button>
          <button type="button" aria-label="Close EncryptedOpfs Workbench" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="closeDebugEncryptedOpfsWorkbench"><XIcon tw-class="h-5 w-5" /></button>
        </header>

        <div v-if="errorMessage" tw-class="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 font-mono text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ errorMessage }}</div>

        <nav tw-class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-gray-200 bg-gray-50 px-3 py-1.5 font-mono text-[10px] text-gray-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-400">
          <button v-if="columns.length > 0" type="button" aria-label="Back one Workbench column" tw-class="mr-1 rounded p-1 hover:bg-gray-200 dark:hover:bg-gray-800" @click="navigateBack"><ArrowLeftIcon tw-class="h-3.5 w-3.5" /></button>
          <template v-for="(label, index) in breadcrumbLabels" :key="`${label}:${String(index)}`">
            <ChevronRightIcon v-if="index > 0" tw-class="h-3 w-3 shrink-0" />
            <button type="button" tw-class="max-w-[260px] truncate rounded px-1.5 py-0.5 hover:bg-gray-200 dark:hover:bg-gray-800" @click="index >= 2 ? truncateColumns({ lastIndex: index - 2 }) : undefined">{{ label }}</button>
          </template>
        </nav>

        <div data-workbench-column-scroll tw-class="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-gray-100 dark:bg-gray-950">
          <aside tw-class="flex w-[300px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <div tw-class="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
              <div>
                <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Sources</div>
                <div tw-class="text-[9px] text-gray-400">EncryptedOpfs instances</div>
              </div>
              <button type="button" data-testid="encrypted-opfs-create-workspace" tw-class="rounded border border-emerald-300 px-2 py-1 text-[10px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30" :disabled="creatingWorkspace" @click="createWorkspace"><PlusIcon tw-class="mr-1 inline h-3 w-3" />{{ creatingWorkspace ? 'Creating…' : 'Ephemeral' }}</button>
            </div>
            <div v-if="loadingSources" tw-class="flex flex-1 items-center justify-center gap-2 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" /> Loading sources…</div>
            <div v-else tw-class="min-h-0 flex-1 overflow-auto">
              <div v-if="sources.length === 0" tw-class="p-4 text-xs text-gray-500">No EncryptedOpfs instance is open. Create an ephemeral workspace to inspect the filesystem before enabling Naidan encryption.</div>
              <div v-for="source in sources" :key="source.sourceId" :tw-class="['group flex border-b border-gray-100 dark:border-gray-800', selectedSource?.sourceId === source.sourceId ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'bg-white dark:bg-gray-900']">
                <button type="button" data-testid="encrypted-opfs-source" :data-source-id="source.sourceId" tw-class="min-w-0 flex-1 px-3 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800" @click="selectSource({ source })">
                  <div tw-class="truncate text-xs font-medium text-gray-800 dark:text-gray-200">{{ source.label }}</div>
                  <div tw-class="mt-1 flex items-center gap-2 font-mono text-[9px] text-gray-500 dark:text-gray-400">
                    <span>{{ source.type }}</span>
                    <span>{{ source.access }}</span>
                  </div>
                </button>
                <button v-if="source.type === 'ephemeral_debug_workspace' || source.type === 'stale_debug_workspace'" type="button" aria-label="Destroy debug workspace" tw-class="self-center rounded p-2 text-gray-400 opacity-70 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:hover:bg-red-950/30" @click="destroyWorkspace({ source })"><Trash2Icon tw-class="h-3.5 w-3.5" /></button>
              </div>
            </div>
          </aside>

          <aside v-if="selectedSource" tw-class="flex w-[330px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <header tw-class="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-500">File system instance</div>
              <div tw-class="mt-1 truncate font-mono text-[10px] text-gray-700 dark:text-gray-300">{{ sourceSession?.fileSystemId ?? selectedSource.sourceId }}</div>
            </header>
            <div v-if="selectedSource.type === 'stale_debug_workspace'" tw-class="p-4 text-xs text-amber-700 dark:text-amber-300">
              <div tw-class="font-semibold">Stale ephemeral workspace</div>
              <p tw-class="mt-2">Its memory-only root key no longer exists. The backing directory is intentionally retained for raw physical inspection and explicit deletion.</p>
              <div tw-class="mt-3 font-mono text-[10px]">{{ selectedSource.workspace.physicalPath.join('/') }}</div>
            </div>
            <div v-else-if="loadingSource" tw-class="flex flex-1 items-center justify-center gap-2 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" /> Opening instance…</div>
            <div v-else-if="overview" tw-class="min-h-0 flex-1 overflow-auto">
              <div tw-class="border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
                <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-gray-500">Runtime source metadata</div>
                <dl tw-class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[9px] text-gray-500 dark:text-gray-400">
                  <dt>source</dt><dd tw-class="truncate text-gray-700 dark:text-gray-300">{{ selectedSource.type }}</dd>
                  <dt>access</dt><dd tw-class="truncate text-gray-700 dark:text-gray-300">{{ selectedSource.access }}</dd>
                  <dt>backing</dt><dd tw-class="truncate text-gray-700 dark:text-gray-300">{{ sourceSession?.physicalPath.join('/') }}</dd>
                  <template v-if="selectedSource.type === 'ephemeral_debug_workspace'">
                    <dt>root key</dt><dd tw-class="text-gray-700 dark:text-gray-300">random · memory only</dd>
                    <dt>key slots</dt><dd tw-class="text-gray-700 dark:text-gray-300">none</dd>
                    <dt>reload</dt><dd tw-class="text-gray-700 dark:text-gray-300">cannot reopen</dd>
                  </template>
                  <template v-else-if="selectedSource.type === 'naidan_active_store'">
                    <dt>key management</dt><dd tw-class="text-gray-700 dark:text-gray-300">Naidan control plane</dd>
                    <dt>mutation</dt><dd tw-class="text-gray-700 dark:text-gray-300">disabled in Workbench</dd>
                  </template>
                </dl>
              </div>
              <button type="button" data-testid="encrypted-opfs-open-descriptor" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openDescriptor"><FileCode2Icon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Descriptor</span><span tw-class="block text-[9px] text-gray-400">RAW DTO · persisted plaintext</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5 text-gray-400" /></button>
              <button type="button" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openSuperblockSlots"><HardDriveIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Superblock slots</span><span tw-class="block text-[9px] text-gray-400">PERSISTED RECORDS · A/B selection</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5 text-gray-400" /></button>
              <button type="button" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openActiveCommit"><DatabaseIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Active commit</span><span tw-class="block text-[9px] text-gray-400">RAW DTO · revision {{ overview.activeCommit.revision }}</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5 text-gray-400" /></button>
              <div tw-class="border-b border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-700 dark:bg-gray-950">Resolved persisted entry points</div>
              <button type="button" data-testid="encrypted-opfs-open-root-directory" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openActiveRootDirectory({ afterIndex: -1 })"><FolderRootIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Root directory</span><span tw-class="block text-[9px] text-gray-400">SHORTCUT · commit.rootDirectoryNodeId → inode index → inode</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5 text-gray-400" /></button>
              <button type="button" data-testid="encrypted-opfs-open-object-store" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openObjectStore"><BoxesIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Physical object store</span><span tw-class="block text-[9px] text-gray-400">PERSISTED OBJECTS · cursor paged</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5 text-gray-400" /></button>
              <button type="button" data-testid="encrypted-opfs-open-integrity" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openIntegrity"><ShieldCheckIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Integrity and reachability</span><span tw-class="block text-[9px] text-gray-400">DERIVED FROM PERSISTED REFERENCES</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5 text-gray-400" /></button>
              <div tw-class="mt-3 border-y border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-700 dark:bg-gray-950">Derived convenience views</div>
              <button type="button" data-testid="encrypted-opfs-open-derived-views" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openDerivedViews"><FolderTreeIcon tw-class="h-4 w-4 text-blue-500" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Logical filesystem views</span><span tw-class="block text-[9px] text-blue-500">DERIVED · reconstructed from persisted records</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5 text-gray-400" /></button>
            </div>
          </aside>

          <section v-for="(column, columnIndex) in columns" :key="column.id" tw-class="flex w-[440px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <header tw-class="flex shrink-0 items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
              <div tw-class="min-w-0">
                <div tw-class="truncate text-xs font-semibold text-gray-800 dark:text-gray-200">{{ column.title }}</div>
                <div tw-class="font-mono text-[9px] uppercase text-gray-400">{{ column.kind }}</div>
              </div>
              <button type="button" aria-label="Close columns to the right" tw-class="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800" @click="truncateColumns({ lastIndex: columnIndex - 1 })"><XIcon tw-class="h-3.5 w-3.5" /></button>
            </header>

            <div v-if="column.kind === 'descriptor'" tw-class="min-h-0 flex-1 overflow-auto">
              <div tw-class="border-b border-gray-200 bg-emerald-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-gray-700 dark:bg-emerald-950/20 dark:text-emerald-300">Raw DTO · exact persisted representation</div>
              <JsonCodeView :source="rawJson({ value: overview?.persistedDescriptorDto ?? null })" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
            </div>

            <div v-else-if="column.kind === 'superblock_slots'" tw-class="min-h-0 flex-1 overflow-auto">
              <button v-for="(slot, slotIndex) in overview?.superblockSlots ?? []" :key="String(slot.slot)" type="button" tw-class="block w-full border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openSuperblockSlot({ slotIndex, afterIndex: columnIndex })">
                <div tw-class="flex items-center justify-between gap-2"><span tw-class="font-mono text-xs">slot {{ slot.slot }}</span><span :tw-class="['rounded px-1.5 py-0.5 text-[9px] uppercase', slot.selected ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-800']">{{ slot.selected ? 'selected' : slot.status }}</span></div>
                <div tw-class="mt-1 truncate font-mono text-[9px] text-gray-400">{{ slot.physicalPath.join('/') }}</div>
              </button>
            </div>

            <div v-else-if="column.kind === 'superblock_slot'" tw-class="min-h-0 flex-1 overflow-auto">
              <template v-if="isSuperblockSlotValid({ slotIndex: column.slotIndex })">
                <BinaryRecordInspectionView
                  :binary="requireSuperblockSlotBinary({ slotIndex: column.slotIndex })"
                  :persisted-dto="requireSuperblockPersistedDto({ slotIndex: column.slotIndex })"
                  :dto-validation-error="undefined"
                />
              </template>
              <template v-else-if="isSuperblockSlotInvalid({ slotIndex: column.slotIndex })">
                <div tw-class="border-b border-red-200 bg-red-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">Persisted bytes · record could not be decoded</div>
                <BinaryHexView
                  :bytes="requireInvalidSuperblockPhysicalBytes({ slotIndex: column.slotIndex }).bytes"
                  :offset="requireInvalidSuperblockPhysicalBytes({ slotIndex: column.slotIndex }).offset"
                  :region-byte-length="requireInvalidSuperblockPhysicalBytes({ slotIndex: column.slotIndex }).regionByteLength"
                  :truncated-after="requireInvalidSuperblockPhysicalBytes({ slotIndex: column.slotIndex }).truncatedAfter"
                />
                <div tw-class="border-t border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950/20">
                  <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-red-500">Validation · derived</div>
                  <div tw-class="mt-1 break-all font-mono text-[10px] text-red-700 dark:text-red-300">{{ requireInvalidSuperblockErrorMessage({ slotIndex: column.slotIndex }) }}</div>
                </div>
              </template>
              <div v-else tw-class="p-3 text-xs text-gray-500">
                No bytes are persisted at <span tw-class="font-mono">{{ getSuperblockSlotPhysicalPath({ slotIndex: column.slotIndex }) }}</span>.
              </div>
            </div>

            <div v-else-if="column.kind === 'active_commit'" tw-class="min-h-0 flex-1 overflow-auto">
              <div tw-class="border-b border-gray-200 bg-emerald-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-gray-700 dark:bg-emerald-950/20 dark:text-emerald-300">Raw DTO · exact persisted representation</div>
              <JsonCodeView :source="rawJson({ value: overview?.activeCommitPersistedDto ?? null })" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
              <div v-if="overview" tw-class="m-3 space-y-2">
                <button type="button" tw-class="flex w-full items-center justify-between rounded border border-gray-300 px-3 py-2 text-left text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="openObject({ objectId: overview.activeCommitObjectId, relation: 'Commit object', afterIndex: columnIndex })"><span>Inspect physical commit object</span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
                <button type="button" data-testid="encrypted-opfs-open-root-from-commit" tw-class="flex w-full items-center justify-between rounded border border-emerald-300 px-3 py-2 text-left text-xs text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30" @click="openActiveRootDirectory({ afterIndex: columnIndex })"><span>Resolve commit.rootDirectoryNodeId</span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
              </div>
            </div>

            <div v-else-if="column.kind === 'object_store'" tw-class="flex min-h-0 flex-1 flex-col">
              <div tw-class="flex shrink-0 items-center justify-between border-b border-gray-200 px-3 py-2 text-[9px] text-gray-500 dark:border-gray-700"><span>{{ objectEntries.length }} loaded</span><span>virtualized · cursor paged</span></div>
              <div tw-class="min-h-0 flex-1 overflow-auto" @scroll="handleObjectListScroll({ event: $event })">
                <div :style="{ height: `${String(objectTopSpacerHeight)}px` }" />
                <button v-for="entry in visibleObjectEntries" :key="entry.objectId" type="button" :style="{ height: `${String(OBJECT_ROW_HEIGHT)}px` }" data-testid="encrypted-opfs-object-entry" tw-class="block w-full border-b border-gray-100 px-3 py-2 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openObject({ objectId: entry.objectId, relation: 'Object record', afterIndex: columnIndex })">
                  <div tw-class="truncate font-mono text-[10px] text-gray-800 dark:text-gray-200">{{ entry.objectId }}</div>
                  <div tw-class="mt-1 truncate font-mono text-[9px] text-gray-400">{{ entry.physicalPath.join('/') }}</div>
                </button>
                <div :style="{ height: `${String(objectBottomSpacerHeight)}px` }" />
                <div v-if="objectsLoading" tw-class="flex items-center justify-center gap-2 p-3 text-[10px] text-gray-500"><LoaderCircleIcon tw-class="h-3.5 w-3.5 animate-spin" /> Reading next shard page…</div>
              </div>
            </div>

            <div v-else-if="column.kind === 'object'" tw-class="min-h-0 flex-1 overflow-auto">
              <div v-if="column.loading" tw-class="flex h-full items-center justify-center gap-2 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" /> Decrypting object…</div>
              <div v-else-if="column.errorMessage" tw-class="p-3 font-mono text-xs text-red-600">{{ column.errorMessage }}</div>
              <template v-else-if="column.value">
                <dl tw-class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[9px] text-gray-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-400">
                  <dt>object ID</dt><dd tw-class="break-all text-gray-700 dark:text-gray-200">{{ column.value.object.objectId }}</dd>
                  <dt>physical path</dt><dd tw-class="break-all text-gray-700 dark:text-gray-200">{{ column.value.object.physicalPath.join('/') }}</dd>
                  <dt>physical length</dt><dd tw-class="text-gray-700 dark:text-gray-200">{{ column.value.object.physicalByteLength }} bytes</dd>
                  <dt>record kind</dt><dd tw-class="text-gray-700 dark:text-gray-200">{{ column.value.object.record.kind }}</dd>
                </dl>
                <BinaryRecordInspectionView
                  :binary="column.value.object.binary"
                  :persisted-dto="getObjectPersistedDto({ value: column.value })"
                  :dto-validation-error="getObjectValidationError({ value: column.value })"
                />
                <div v-if="column.value.rootDirectoryEntryPoint" tw-class="border-t border-gray-200 p-3 dark:border-gray-700">
                  <div tw-class="mb-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Resolved persisted entry point</div>
                  <button type="button" data-testid="encrypted-opfs-open-root-from-object" tw-class="flex w-full items-center justify-between rounded border border-emerald-300 px-3 py-2 text-left text-xs text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30" @click="openRootDirectoryEntryPoint({ entryPoint: column.value.rootDirectoryEntryPoint, afterIndex: columnIndex })"><span>Resolve rootDirectoryNodeId through inode index</span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
                </div>
                <div v-if="column.value.references.length > 0" tw-class="border-t border-gray-200 p-3 dark:border-gray-700">
                  <div tw-class="mb-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Persisted outgoing object references</div>
                  <button v-for="reference in column.value.references" :key="`${reference.relation}:${reference.objectId}`" type="button" tw-class="mb-1 flex w-full items-center justify-between gap-2 rounded border border-gray-200 px-2 py-1.5 text-left hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800" @click="openObject({ objectId: reference.objectId, relation: reference.relation, afterIndex: columnIndex })"><span tw-class="text-[9px] text-gray-500">{{ reference.relation }}</span><span tw-class="min-w-0 truncate font-mono text-[9px]">{{ reference.objectId }}</span></button>
                </div>
              </template>
            </div>

            <div v-else-if="column.kind === 'resolved_node'" tw-class="min-h-0 flex-1 overflow-auto">
              <div v-if="column.loading" tw-class="flex h-full items-center justify-center gap-2 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" /> Resolving persisted references…</div>
              <div v-else-if="column.errorMessage" tw-class="p-3 font-mono text-xs text-red-600">{{ column.errorMessage }}</div>
              <template v-else-if="column.value">
                <div tw-class="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">Resolved navigation shortcut · every skipped persisted record remains inspectable</div>
                <dl tw-class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-gray-200 px-3 py-2 font-mono text-[9px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <dt>logical path</dt><dd tw-class="break-all text-blue-600 dark:text-blue-300">{{ column.value.logicalPath }} · DERIVED</dd>
                  <dt>commit</dt><dd tw-class="break-all text-gray-700 dark:text-gray-200">{{ column.value.commitObjectId }}</dd>
                  <dt>revision</dt><dd tw-class="text-gray-700 dark:text-gray-200">{{ column.value.commitRevision }}</dd>
                  <dt>node ID</dt><dd tw-class="break-all text-gray-700 dark:text-gray-200">{{ column.value.nodeId }}</dd>
                  <dt>inode object</dt><dd tw-class="break-all text-gray-700 dark:text-gray-200">{{ column.value.inodeObjectId }}</dd>
                  <dt>kind</dt><dd tw-class="text-gray-700 dark:text-gray-200">{{ column.value.inodeKind }}</dd>
                </dl>
                <div tw-class="border-b border-gray-200 p-3 dark:border-gray-700">
                  <div tw-class="mb-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Persisted reference chain</div>
                  <button type="button" tw-class="mb-1 flex w-full items-center justify-between gap-2 rounded border border-gray-200 px-2 py-1.5 text-left hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800" @click="openObject({ objectId: column.value.commitObjectId, relation: 'Commit object', afterIndex: columnIndex })"><span tw-class="text-[9px]">commit.rootDirectoryNodeId</span><span tw-class="truncate font-mono text-[9px]">{{ column.value.rootDirectoryNodeId }}</span></button>
                  <button type="button" tw-class="mb-1 flex w-full items-center justify-between gap-2 rounded border border-gray-200 px-2 py-1.5 text-left hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800" @click="openObject({ objectId: column.value.inodeIndexRootObjectId, relation: 'Inode index root', afterIndex: columnIndex })"><span tw-class="text-[9px]">inodeIndexRootObjectId</span><span tw-class="truncate font-mono text-[9px]">{{ column.value.inodeIndexRootObjectId }}</span></button>
                  <button v-for="(step, stepIndex) in column.value.inodeIndexLookup" :key="`${step.pageObjectId}:${String(stepIndex)}`" type="button" tw-class="mb-1 block w-full rounded border border-gray-200 px-2 py-1.5 text-left hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800" @click="openObject({ objectId: step.pageObjectId, relation: `Inode index ${step.type} page`, afterIndex: columnIndex })">
                    <span tw-class="block font-mono text-[9px]">{{ step.pageObjectId }}</span>
                    <span v-if="step.type === 'branch'" tw-class="mt-1 block text-[9px] text-gray-400">selected child {{ step.selectedChildPageObjectId }} · upper bound {{ step.selectedUpperBoundNodeId }}</span>
                    <span v-else tw-class="mt-1 block text-[9px] text-gray-400">leaf entry → inode {{ step.inodeObjectId }}</span>
                  </button>
                  <button type="button" data-testid="encrypted-opfs-open-resolved-inode" tw-class="flex w-full items-center justify-between gap-2 rounded border border-emerald-300 px-2 py-1.5 text-left text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30" @click="openObject({ objectId: column.value.inodeObjectId, relation: `${column.value.inodeKind} inode`, afterIndex: columnIndex })"><span tw-class="text-[9px]">resolved inode object</span><span tw-class="truncate font-mono text-[9px]">{{ column.value.inodeObjectId }}</span></button>
                </div>
                <div tw-class="border-b border-gray-200 bg-emerald-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-gray-700 dark:bg-emerald-950/20 dark:text-emerald-300">Raw DTO · exact inode metadata</div>
                <JsonCodeView :source="rawJson({ value: column.value.inodePersistedDto })" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
                <template v-if="column.value.directory">
                  <div v-if="column.value.directory.directoryIndexRootObjectId" tw-class="border-t border-gray-200 p-3 dark:border-gray-700">
                    <button type="button" tw-class="flex w-full items-center justify-between rounded border border-gray-300 px-3 py-2 text-left text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="openObject({ objectId: column.value.directory.directoryIndexRootObjectId, relation: 'Directory index root', afterIndex: columnIndex })"><span>Inspect directory index root</span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
                  </div>
                  <div tw-class="border-t border-gray-200 bg-gray-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-950">Persisted directory entries · {{ column.value.directory.storageType }}</div>
                  <div v-for="resolvedEntry in column.value.directory.entries" :key="`${resolvedEntry.entry.nodeId}:${resolvedEntry.entry.name}`" tw-class="border-b border-gray-100 p-2 dark:border-gray-800">
                    <button type="button" data-testid="encrypted-opfs-open-child-node" tw-class="block w-full rounded px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800" @click="openChildNode({ parent: column.value, entry: resolvedEntry.entry, afterIndex: columnIndex })">
                      <span tw-class="block truncate text-xs font-medium">{{ resolvedEntry.entry.name }}</span>
                      <span tw-class="mt-1 block font-mono text-[9px] text-gray-500">{{ resolvedEntry.entry.kind }} · {{ resolvedEntry.entry.nodeId }}</span>
                    </button>
                    <button type="button" tw-class="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-left font-mono text-[9px] text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800" @click="openObject({ objectId: getDirectoryEntrySourceObjectId({ source: resolvedEntry.source }), relation: resolvedEntry.source.type === 'inline' ? 'Directory inode containing entry' : 'Directory index leaf containing entry', afterIndex: columnIndex })">source {{ resolvedEntry.source.type }} · {{ getDirectoryEntrySourceObjectId({ source: resolvedEntry.source }) }}</button>
                  </div>
                  <div v-if="column.value.directory.truncated" tw-class="border-t border-amber-200 bg-amber-50 px-3 py-2 text-[9px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">Directory entry list was truncated at the Workbench safety limit.</div>
                  <div v-for="issue in column.value.directory.issues" :key="issue" tw-class="border-t border-red-200 bg-red-50 px-3 py-2 font-mono text-[9px] text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">{{ issue }}</div>
                </template>
              </template>
            </div>

            <div v-else-if="column.kind === 'derived_views'" tw-class="min-h-0 flex-1 overflow-auto">
              <div tw-class="border-b border-blue-200 bg-blue-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-300">Derived · reconstructed from persisted records</div>
              <button type="button" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openLogicalPaths({ afterIndex: columnIndex })"><FileSearchIcon tw-class="h-4 w-4 text-blue-500" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Derived logical path index</span><span tw-class="block text-[9px] text-gray-400">Flattened paths reconstructed from directory and inode records</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
              <button type="button" data-testid="encrypted-opfs-open-derived-file-explorer" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openFileExplorerColumn({ afterIndex: columnIndex })"><FolderTreeIcon tw-class="h-4 w-4 text-blue-500" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Derived filesystem view</span><span tw-class="block text-[9px] text-gray-400">Direct decrypted root · {{ selectedSource?.access }}</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
            </div>

            <div v-else-if="column.kind === 'logical_paths'" tw-class="min-h-0 flex-1 overflow-auto">
              <div tw-class="border-b border-blue-200 bg-blue-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-300">Derived view · not persisted as one map</div>
              <div v-if="namespaceLoading" tw-class="flex items-center justify-center gap-2 p-8 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" /> Traversing persisted records…</div>
              <template v-else-if="namespaceResult">
                <button v-for="entry in namespaceResult.entries" :key="`${entry.nodeId}:${entry.path}`" type="button" tw-class="block w-full border-b border-gray-100 px-3 py-2 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="openObject({ objectId: entry.inodeObjectId, relation: entry.path, afterIndex: columnIndex })">
                  <div tw-class="truncate font-mono text-[10px] text-gray-800 dark:text-gray-200">{{ entry.path }}</div>
                  <div tw-class="mt-1 flex gap-2 text-[9px] text-gray-400"><span>{{ entry.kind }}</span><span>rev {{ entry.revision }}</span><span>{{ entry.storage }}</span></div>
                </button>
              </template>
            </div>

            <div v-else-if="column.kind === 'file_explorer'" tw-class="flex min-h-0 flex-1 flex-col">
              <div tw-class="shrink-0 border-b border-blue-200 bg-blue-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-300">Derived filesystem view · {{ selectedSource?.access }}</div>
              <Suspense v-if="fileExplorerRoot">
                <FileExplorer :key="selectedSource?.sourceId" :root="fileExplorerRoot" initial-view-mode="column" initial-preview-visibility="visible" :initial-path="undefined" :initial-locked="selectedSource?.access === 'read_only'" />
                <template #fallback><div tw-class="flex h-full items-center justify-center gap-2 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" /> Opening decrypted root…</div></template>
              </Suspense>
            </div>

            <div v-else-if="column.kind === 'integrity'" tw-class="min-h-0 flex-1 overflow-auto">
              <div tw-class="flex items-center gap-2 border-b border-gray-200 p-3 dark:border-gray-700">
                <button type="button" data-testid="encrypted-opfs-run-integrity" tw-class="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50" :disabled="integrityLoading" @click="runIntegrityScan">Run scan</button>
                <button v-if="integrityLoading" type="button" tw-class="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-600" @click="cancelIntegrityScan">Cancel</button>
              </div>
              <div v-if="integrityLoading" tw-class="flex items-center justify-center gap-2 p-8 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" /> Traversing object references in worker…</div>
              <template v-else-if="integrityResult">
                <div tw-class="border-b border-gray-200 bg-amber-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:border-gray-700 dark:bg-amber-950/20 dark:text-amber-300">Derived from persisted object graph</div>
                <JsonCodeView :source="rawJson({ value: integrityResult })" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
              </template>
            </div>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>
