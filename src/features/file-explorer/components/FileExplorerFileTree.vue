<script setup lang="ts">
import { AlertCircleIcon, ChevronDownIcon, ChevronRightIcon, Loader2Icon } from 'lucide-vue-next';
import { computed, nextTick, onScopeDispose, ref, shallowReactive, useTemplateRef, watch, watchEffect } from 'vue';
import { lazyStrings } from '@/strings';
import type { FileExplorerEntry, FileExplorerTreeMenuEvent } from '@/features/file-explorer/logic/types';
import { sortEntries } from '@/features/file-explorer/logic/utils';
import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import FileExplorerEntryIcon from './FileExplorerEntryIcon.vue';

const props = defineProps<{
  active: boolean,
  activePath: string | undefined,
  directoryPath?: string,
  readDirectory: ({ path }: { path: string }) => ReturnType<FileExplorerWorkerClient['readDirectory']>,
  directoryRevision?: number | undefined,
}>();

const emit = defineEmits<{
  (event: 'open', payload: { entry: FileExplorerEntry }): void,
  (event: 'entry-contextmenu', payload: FileExplorerTreeMenuEvent): void,
}>();

type BranchState = (
  | { status: 'loading' }
  | { status: 'ready', name: string, entries: FileExplorerEntry[], readOnly: boolean }
  | { status: 'error', message: string }
) & { revision: number };

type TreeRow = {
  path: string,
  parentPath: string | undefined,
  entry: FileExplorerEntry | undefined,
  level: number,
  position: number,
  siblingCount: number,
  expandable: boolean,
  branch: BranchState | undefined,
};

const tree = useTemplateRef<HTMLElement>('tree');
const branches = shallowReactive(new Map<string, BranchState>());
const branchRequests = new Map<string, { revision: number }>();
const expanded = shallowReactive(new Set(['/']));
const focusedPath = ref<string>();
const pendingReveal = ref<{ path: string, opener: Element | null }>();
const pathToReveal = computed(() => props.activePath ?? `${props.directoryPath ?? ''}/`);

onScopeDispose(() => {
  branches.clear();
  branchRequests.clear();
});

function revealAncestors({ path }: { path: string }): void {
  expanded.add('/');
  let ancestor = '';
  for (const name of path.split('/').slice(0, -1).filter(Boolean)) {
    ancestor += `/${name}`;
    expanded.add(ancestor);
  }
}

watch(pathToReveal, path => {
  revealAncestors({ path });
}, { immediate: true });

watch(() => props.readDirectory, () => {
  branches.clear();
  branchRequests.clear();
  expanded.clear();
  focusedPath.value = undefined;
  pendingReveal.value = undefined;
  revealAncestors({ path: pathToReveal.value });
}, { flush: 'sync' });

function appendChildren({ path, level, result }: { path: string, level: number, result: TreeRow[] }): void {
  const branch = branches.get(path);
  if (branch?.status !== 'ready' || !expanded.has(path)) {
    return;
  }

  for (const [index, entry] of branch.entries.entries()) {
    // A virtual filesystem may return the resolved target path for a symlink's children.
    const childPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
    const expandable = entry.canNavigate || entry.extension === '.zip';
    result.push({
      path: childPath,
      parentPath: path,
      entry: entry.path === childPath ? entry : { ...entry, path: childPath },
      level,
      position: index + 1,
      siblingCount: branch.entries.length,
      expandable,
      branch: expandable ? branches.get(childPath) : undefined,
    });
    if (expandable) {
      appendChildren({ path: childPath, level: level + 1, result });
    }
  }
}

const rows = computed(() => {
  const result: TreeRow[] = [{
    path: '/',
    parentPath: undefined,
    entry: undefined,
    level: 1,
    position: 1,
    siblingCount: 1,
    expandable: true,
    branch: branches.get('/'),
  }];
  appendChildren({ path: '/', level: 2, result });
  return result;
});

function isBranchOpen({ path }: { path: string }): boolean {
  let ancestor = path;
  while (expanded.has(ancestor)) {
    if (ancestor === '/') {
      return true;
    }
    ancestor = ancestor.slice(0, ancestor.lastIndexOf('/')) || '/';
  }
  return false;
}

async function loadBranch({ path, revision }: { path: string, revision: number }): Promise<void> {
  if (branchRequests.get(path)?.revision === revision) {
    return;
  }
  const request = { revision };
  branchRequests.set(path, request);
  const previous = branches.get(path);
  const keepListedEntries = previous !== undefined && 'entries' in previous;
  if (!keepListedEntries) {
    branches.set(path, { status: 'loading', revision });
  }
  let branch: BranchState;
  try {
    const response = await props.readDirectory({ path });
    branch = {
      status: 'ready',
      revision,
      name: response.directoryName,
      readOnly: response.readOnly,
      entries: sortEntries({ entries: response.entries, config: { field: 'name', direction: 'ascending' } }),
    };
  } catch (error) {
    branch = { status: 'error', revision, message: error instanceof Error ? error.message : String(error) };
  }
  if (branchRequests.get(path) !== request) {
    return;
  }
  branchRequests.delete(path);
  if (isBranchOpen({ path })) {
    branches.set(path, branch);
  } else if (!keepListedEntries) {
    branches.delete(path);
  }
}

watchEffect(() => {
  if (!props.active) {
    return;
  }
  const revision = props.directoryRevision ?? 0;
  for (const row of rows.value) {
    if (row.expandable && expanded.has(row.path) && row.branch?.revision !== revision) {
      void loadBranch({ path: row.path, revision });
    }
  }
});

const tabStop = computed(() => {
  if (rows.value.some(row => row.path === focusedPath.value)) {
    return focusedPath.value;
  }
  return rows.value.some(row => row.path === props.activePath) ? props.activePath : '/';
});

async function moveFocus({ path }: { path: string }): Promise<void> {
  focusedPath.value = path;
  await nextTick();
  const items = tree.value?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]');
  Array.from(items ?? []).find(item => item.dataset.path === path)?.focus();
}

function revealDirectory({ path }: { path: string }): void {
  pendingReveal.value = { path, opener: document.activeElement };
  revealAncestors({ path: `${path}/` });
}

watchEffect(() => {
  const target = pendingReveal.value;
  if (!props.active || target === undefined) {
    return;
  }
  if (document.activeElement !== target.opener) {
    pendingReveal.value = undefined;
    return;
  }
  if (rows.value.some(row => row.path === target.path)) {
    pendingReveal.value = undefined;
    void moveFocus({ path: target.path });
  }
}, { flush: 'post' });

function toggleBranch({ path }: { path: string }): void {
  const status = branches.get(path)?.status;
  switch (status) {
  case 'error':
    branches.delete(path);
    expanded.add(path);
    return;
  case 'loading':
  case 'ready':
  case undefined:
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      expanded.add(path);
    }
    return;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled branch status: ${_ex}`);
  }
  }
}

function handleClick({ row, event }: { row: TreeRow, event: MouseEvent }): void {
  focusedPath.value = row.path;
  if (event.detail >= 2) {
    return;
  }
  if (row.expandable) {
    toggleBranch({ path: row.path });
  } else {
    openFile({ row });
  }
}

function openFile({ row }: { row: TreeRow }): void {
  if (!row.expandable && row.entry?.kind === 'file') {
    emit('open', { entry: row.entry });
  }
}

function handleContextMenu({ row, event }: { row: TreeRow, event: MouseEvent }): void {
  const root = row.path === '/' ? branches.get('/') : undefined;
  const entry: FileExplorerEntry | undefined = row.entry ?? (root !== undefined && 'readOnly' in root ? {
    path: '/',
    name: root.name,
    kind: 'directory',
    size: undefined,
    lastModified: undefined,
    extension: '',
    mimeCategory: 'binary',
    readOnly: root.readOnly,
    canNavigate: true,
    canMutate: false,
  } : undefined);
  if (!entry) {
    return;
  }
  const directoryPath = (() => {
    switch (entry.kind) {
    case 'directory': return row.path;
    case 'file': return row.parentPath ?? '/';
    default: {
      const exhaustive: never = entry.kind;
      throw new Error(`Unhandled tree entry kind: ${String(exhaustive)}`);
    }
    }
  })();
  const directory = branches.get(directoryPath);
  focusedPath.value = row.path;
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.focus({ preventScroll: true });
  }
  emit('entry-contextmenu', {
    event,
    entry,
    directoryPath,
    directoryReadOnly: directory !== undefined && 'readOnly' in directory ? directory.readOnly : entry.readOnly,
    open: () => {
      if (row.expandable) {
        if (!expanded.has(row.path) || row.branch?.status === 'error') {
          toggleBranch({ path: row.path });
        }
      } else {
        openFile({ row });
      }
    },
  });
}

function handleKeydown({ row, event }: { row: TreeRow, event: KeyboardEvent }): void {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }

  const index = rows.value.findIndex(item => item.path === row.path);
  let nextPath: string | undefined;
  switch (event.key) {
  case 'ArrowDown':
    nextPath = rows.value[index + 1]?.path;
    break;
  case 'ArrowUp':
    nextPath = rows.value[index - 1]?.path;
    break;
  case 'Home':
    nextPath = '/';
    break;
  case 'End':
    nextPath = rows.value.at(-1)?.path;
    break;
  case 'ArrowRight':
    if (row.expandable) {
      if (!expanded.has(row.path) || row.branch?.status === 'error') {
        toggleBranch({ path: row.path });
      } else if (rows.value[index + 1]?.parentPath === row.path) {
        nextPath = rows.value[index + 1]?.path;
      }
    }
    break;
  case 'ArrowLeft':
    if (expanded.has(row.path)) {
      expanded.delete(row.path);
    } else {
      nextPath = row.parentPath;
    }
    break;
  case 'Enter':
    if (row.expandable) {
      toggleBranch({ path: row.path });
    } else {
      openFile({ row });
    }
    break;
  default:
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  if (nextPath !== undefined) {
    void moveFocus({ path: nextPath });
  }
}

const rootName = computed(() => {
  const root = branches.get('/');
  switch (root?.status) {
  case 'ready': return root.name;
  case 'loading':
  case 'error':
  case undefined: return '/';
  default: {
    const _ex: never = root;
    throw new Error(`Unhandled root branch: ${String(_ex)}`);
  }
  }
});


defineExpose({
  revealDirectory,
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div
    ref="tree"
    role="tree"
    :aria-label="lazyStrings.fileExplorer__file_tree()"
    data-testid="file-explorer-file-tree"
    tw-class="flex flex-col gap-0.5 p-1"
  >
    <button
      v-for="row in rows"
      :key="row.path"
      type="button"
      role="treeitem"
      :aria-level="row.level"
      :aria-posinset="row.position"
      :aria-setsize="row.siblingCount"
      :aria-selected="row.path === activePath"
      :aria-expanded="row.expandable ? expanded.has(row.path) : undefined"
      :aria-busy="row.branch?.status === 'loading' ? true : undefined"
      :tabindex="row.path === tabStop ? 0 : -1"
      :title="row.branch?.status === 'error' ? lazyStrings.fileExplorer__failed_to_load_directory({ errorMessage: row.branch.message }) : row.entry?.name ?? rootName"
      :data-path="row.path"
      data-testid="file-explorer-tree-entry"
      :style="{ paddingInlineStart: `${0.375 + (row.level - 1) * 0.75}rem` }"
      :tw-class="[
        'flex w-full min-w-0 items-center gap-1 rounded-md py-1 pr-1.5 text-start text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40',
        row.path === activePath ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
      ]"
      @focus="focusedPath = row.path"
      @click="handleClick({ row, event: $event })"
      @contextmenu="handleContextMenu({ row, event: $event })"
      @keydown="handleKeydown({ row, event: $event })"
    >
      <span tw-class="grid h-3.5 w-3.5 shrink-0 place-items-center text-gray-500 dark:text-gray-400">
        <Loader2Icon v-if="row.branch?.status === 'loading'" aria-hidden="true" tw-class="h-3 w-3 animate-spin" />
        <ChevronDownIcon v-else-if="row.expandable && expanded.has(row.path)" aria-hidden="true" tw-class="h-3 w-3" />
        <ChevronRightIcon v-else-if="row.expandable" aria-hidden="true" tw-class="h-3 w-3" />
      </span>
      <FileExplorerEntryIcon
        aria-hidden="true"
        :kind="row.entry?.kind ?? 'directory'"
        :extension="row.entry?.extension ?? ''"
        :mime-category="row.entry?.mimeCategory ?? 'binary'"
        size="sm"
        tw-class="shrink-0"
      />
      <span tw-class="min-w-0 flex-1 truncate">{{ row.entry?.name ?? rootName }}</span>
      <AlertCircleIcon
        v-if="row.branch?.status === 'error'"
        :aria-label="lazyStrings.fileExplorer__failed_to_load_directory({ errorMessage: row.branch.message })"
        tw-class="h-3.5 w-3.5 shrink-0 text-red-500"
      />
    </button>
  </div>
</template>
