<script setup lang="ts">
import { computed, ref } from "vue";
import { LoaderCircleIcon, RefreshCwIcon, SearchIcon } from "lucide-vue-next";
import { createHizoFSNamespaceInspectionView } from "@/features/debug-hizofs/logic/namespace-inspection-view";
import {
  formatHizoFSInspectorNamespacePath,
  parseHizoFSInspectorNamespacePath,
} from "@/features/debug-hizofs/logic/namespace-path-input";
import {
  createHizoFSPhysicalContainerInspectionView,
  type HizoFSPhysicalCopyInspectionRow,
  type HizoFSPhysicalFrameInspectionRow,
} from "@/features/debug-hizofs/logic/physical-container-inspection-view";
import {
  createHizoFSPhysicalRecordInspectionView,
  type HizoFSPhysicalRecordNavigationTarget,
} from "@/features/debug-hizofs/logic/physical-record-inspection-view";
import type { HizoFSPhysicalInspectionWorker } from "@/features/debug-hizofs/worker/physical-inspection";

const props = defineProps<{
  inspector: HizoFSPhysicalInspectionWorker;
}>();


const passphrase = ref("");
const namespacePath = ref("/");
const loading = ref<"container" | "home_record" | "namespace" | "record">();
const errorMessage = ref<string>();
const containerView = ref<ReturnType<typeof createHizoFSPhysicalContainerInspectionView>>();
const namespaceView = ref<ReturnType<typeof createHizoFSNamespaceInspectionView>>();
const recordView = ref<ReturnType<typeof createHizoFSPhysicalRecordInspectionView>>();
const selectedFrame = ref<HizoFSPhysicalFrameInspectionRow>();
const selectedPageRole = ref<"non_root" | "root" | "unspecified">("unspecified");

const canInspect = computed(() => loading.value === undefined && passphrase.value.length > 0);

function errorText({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

function recordReferenceSummary({ reference }: {
  reference: Extract<HizoFSPhysicalCopyInspectionRow, { kind: "superblock" }>["activeCommit"];
}): string {
  if (reference === undefined) return "unavailable";
  const { byteOffset, frameLength, recordKind, segmentId, ...unhandledReference } = reference;
  unhandledReference satisfies Record<PropertyKey, never>;
  return `${segmentId}:${byteOffset}, frame ${String(frameLength)}, kind ${String(recordKind)}`;
}

function copySequence({ row }: { row: HizoFSPhysicalCopyInspectionRow }): string {
  switch (row.kind) {
  case "unlock_envelope": return row.sequence ?? "unobserved";
  case "superblock": return row.publicationSequence ?? "unobserved";
  default: return row satisfies never;
  }
}

function copyDetails({ row }: { row: HizoFSPhysicalCopyInspectionRow }): string {
  switch (row.kind) {
  case "unlock_envelope": {
    const {
      copy: _copy,
      credentialSlotCount,
      envelope: _envelope,
      envelopeJson: _envelopeJson,
      fileSystemId,
      kind: _kind,
      path: _path,
      reason: _reason,
      selected: _selected,
      sequence: _sequence,
      state: _state,
      ...unhandledRow
    } = row;
    unhandledRow satisfies Record<PropertyKey, never>;
    return `filesystem ${fileSystemId ?? "unavailable"}; credential slots ${credentialSlotCount === undefined ? "unavailable" : String(credentialSlotCount)}`;
  }
  case "superblock": {
    const {
      activeCommit,
      activeCommitSequence,
      copy: _copy,
      header: _header,
      headerJson: _headerJson,
      kind: _kind,
      minimumUnlockSequence,
      path: _path,
      plaintext: _plaintext,
      plaintextJson: _plaintextJson,
      publicationSequence: _publicationSequence,
      reason: _reason,
      relocationIndexRoot,
      requiredFeatureBits,
      selected: _selected,
      state: _state,
      ...unhandledRow
    } = row;
    unhandledRow satisfies Record<PropertyKey, never>;
    return `active Commit sequence ${activeCommitSequence ?? "unavailable"}; minimum Unlock sequence ${minimumUnlockSequence ?? "unavailable"}; required feature bits ${requiredFeatureBits ?? "unavailable"}; active Commit ${recordReferenceSummary({ reference: activeCommit })}; relocation root ${recordReferenceSummary({ reference: relocationIndexRoot })}`;
  }
  default: return row satisfies never;
  }
}

type PersistedDtoDocument = Readonly<{ json: string; label: string }>;

function persistedDtoDocuments({ row }: { row: HizoFSPhysicalCopyInspectionRow }): readonly PersistedDtoDocument[] {
  switch (row.kind) {
  case "unlock_envelope": {
    const {
      copy: _copy,
      credentialSlotCount: _credentialSlotCount,
      envelope: _envelope,
      envelopeJson,
      fileSystemId: _fileSystemId,
      kind: _kind,
      path: _path,
      reason: _reason,
      selected: _selected,
      sequence: _sequence,
      state: _state,
      ...unhandledRow
    } = row;
    unhandledRow satisfies Record<PropertyKey, never>;
    return [{ json: envelopeJson, label: "Exact Unlock Envelope DTO" }];
  }
  case "superblock": {
    const {
      activeCommit: _activeCommit,
      activeCommitSequence: _activeCommitSequence,
      copy: _copy,
      header: _header,
      headerJson,
      kind: _kind,
      minimumUnlockSequence: _minimumUnlockSequence,
      path: _path,
      plaintext: _plaintext,
      plaintextJson,
      publicationSequence: _publicationSequence,
      reason: _reason,
      relocationIndexRoot: _relocationIndexRoot,
      requiredFeatureBits: _requiredFeatureBits,
      selected: _selected,
      state: _state,
      ...unhandledRow
    } = row;
    unhandledRow satisfies Record<PropertyKey, never>;
    return [
      { json: headerJson, label: "Exact Superblock Header DTO" },
      { json: plaintextJson, label: "Exact Superblock Plaintext DTO" },
    ];
  }
  default: return row satisfies never;
  }
}

function selectNamespacePath({ pathComponents }: { pathComponents: readonly string[] }): void {
  namespacePath.value = formatHizoFSInspectorNamespacePath({ pathComponents });
}

async function inspectContainer(): Promise<void> {
  if (!canInspect.value) return;
  const submittedPassphrase = passphrase.value;
  loading.value = "container";
  errorMessage.value = undefined;
  containerView.value = undefined;
  selectedFrame.value = undefined;
  recordView.value = undefined;
  try {
    const inspection = await props.inspector.inspectContainer({ passphrase: submittedPassphrase });
    containerView.value = createHizoFSPhysicalContainerInspectionView({ inspection });
  } catch (error) {
    errorMessage.value = errorText({ error });
  } finally {
    passphrase.value = "";
    loading.value = undefined;
  }
}

function physicalRecordRequest({
  frame,
  pageRole,
}: {
  frame: HizoFSPhysicalFrameInspectionRow;
  pageRole: "non_root" | "root" | "unspecified";
}): Parameters<HizoFSPhysicalInspectionWorker["inspectRecord"]>[0]["request"] {
  const common = {
    frameLength: frame.frameLength,
    homeOffset: frame.homeOffset,
    homeSegmentId: frame.homeSegmentId,
    physicalOffset: frame.physicalOffset,
    physicalSegmentId: frame.physicalSegmentId,
    recordKind: frame.recordKind,
  };
  switch (pageRole) {
  case "unspecified": return common;
  case "root": return { ...common, pageIsRoot: true };
  case "non_root": return { ...common, pageIsRoot: false };
  default: return pageRole satisfies never;
  }
}

function selectFrame({ frame }: { frame: HizoFSPhysicalFrameInspectionRow }): void {
  selectedFrame.value = frame;
  recordView.value = undefined;
  selectedPageRole.value = "unspecified";
}

async function inspectSelectedRecord(): Promise<void> {
  const frame = selectedFrame.value;
  if (!canInspect.value || frame === undefined) return;
  await inspectPhysicalRecord({
    request: physicalRecordRequest({
      frame,
      pageRole: selectedPageRole.value,
    }),
  });
}

async function inspectPhysicalRecord({ request }: {
  request: Parameters<HizoFSPhysicalInspectionWorker["inspectRecord"]>[0]["request"];
}): Promise<void> {
  if (!canInspect.value) return;
  const submittedPassphrase = passphrase.value;
  loading.value = "record";
  errorMessage.value = undefined;
  recordView.value = undefined;
  try {
    const inspection = await props.inspector.inspectRecord({
      maximumPreviewBytes: 4096,
      passphrase: submittedPassphrase,
      request,
    });
    recordView.value = createHizoFSPhysicalRecordInspectionView({ inspection });
  } catch (error) {
    errorMessage.value = errorText({ error });
  } finally {
    passphrase.value = "";
    loading.value = undefined;
  }
}

async function inspectNavigationTarget({ target }: {
  target: HizoFSPhysicalRecordNavigationTarget;
}): Promise<void> {
  switch (target.targetType) {
  case "home_record":
    await inspectHomeRecord({ request: target.request });
    break;
  case "physical_record":
    await inspectPhysicalRecord({ request: target.request });
    break;
  default: target satisfies never;
  }
}

function navigationTargetKey({ target }: {
  target: HizoFSPhysicalRecordNavigationTarget;
}): string {
  switch (target.targetType) {
  case "home_record": return `${target.targetType}:${target.request.homeSegmentId}:${target.request.homeOffset}`;
  case "physical_record": return `${target.targetType}:${target.request.physicalSegmentId}:${target.request.physicalOffset}`;
  default: return target satisfies never;
  }
}

function navigationTargetTestId({ target }: {
  target: HizoFSPhysicalRecordNavigationTarget;
}): string {
  switch (target.targetType) {
  case "home_record": return "hizofs-physical-inspector-home-record";
  case "physical_record": return "hizofs-physical-inspector-physical-record";
  default: return target satisfies never;
  }
}

function isNavigationTargetLoading({ target }: {
  target: HizoFSPhysicalRecordNavigationTarget;
}): boolean {
  switch (target.targetType) {
  case "home_record": return loading.value === "home_record";
  case "physical_record": return loading.value === "record";
  default: return target satisfies never;
  }
}

async function inspectHomeRecord({ request }: {
  request: Parameters<HizoFSPhysicalInspectionWorker["inspectHomeRecord"]>[0]["request"];
}): Promise<void> {
  if (!canInspect.value) return;
  const submittedPassphrase = passphrase.value;
  loading.value = "home_record";
  errorMessage.value = undefined;
  recordView.value = undefined;
  try {
    const inspection = await props.inspector.inspectHomeRecord({
      maximumPreviewBytes: 4096,
      passphrase: submittedPassphrase,
      request,
    });
    recordView.value = createHizoFSPhysicalRecordInspectionView({ inspection });
  } catch (error) {
    errorMessage.value = errorText({ error });
  } finally {
    passphrase.value = "";
    loading.value = undefined;
  }
}

async function inspectNamespace(): Promise<void> {
  if (!canInspect.value) return;
  const submittedPassphrase = passphrase.value;
  loading.value = "namespace";
  errorMessage.value = undefined;
  namespaceView.value = undefined;
  recordView.value = undefined;
  try {
    const inspection = await props.inspector.inspectNamespacePath({
      maximumDirectoryEntries: 256,
      maximumPages: 4096,
      passphrase: submittedPassphrase,
      pathComponents: parseHizoFSInspectorNamespacePath({ path: namespacePath.value }),
    });
    namespaceView.value = createHizoFSNamespaceInspectionView({ inspection });
  } catch (error) {
    errorMessage.value = errorText({ error });
  } finally {
    passphrase.value = "";
    loading.value = undefined;
  }
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="min-h-full">
    <section aria-labelledby="hizofs-physical-inspector-title" tw-class="flex min-h-full w-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <header tw-class="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <SearchIcon tw-class="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
        <div tw-class="min-w-0 flex-1">
          <h2 id="hizofs-physical-inspector-title" tw-class="text-sm font-semibold text-gray-900 dark:text-gray-100">Physical Inspector</h2>
          <p tw-class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">One-shot physical authority and namespace inspection. Secrets are not retained.</p>
        </div>
      </header>

      <div tw-class="grid shrink-0 gap-3 border-b border-gray-200 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] dark:border-gray-700">
        <label tw-class="min-w-0 text-xs font-medium text-gray-700 dark:text-gray-200">
          Passphrase
          <input v-model="passphrase" data-testid="hizofs-physical-inspector-passphrase" type="password" autocomplete="off" tw-class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-950" />
        </label>
        <label tw-class="min-w-0 text-xs font-medium text-gray-700 dark:text-gray-200">
          Namespace path
          <input v-model="namespacePath" data-testid="hizofs-physical-inspector-path" type="text" spellcheck="false" tw-class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-950" />
        </label>
        <button type="button" data-testid="hizofs-physical-inspector-read-container" :disabled="!canInspect" tw-class="self-end rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="inspectContainer">
          <LoaderCircleIcon v-if="loading === 'container'" tw-class="mr-1 inline h-3.5 w-3.5 animate-spin" />
          <RefreshCwIcon v-else tw-class="mr-1 inline h-3.5 w-3.5" />
          Read physical state
        </button>
        <button type="button" data-testid="hizofs-physical-inspector-read-namespace" :disabled="!canInspect" tw-class="self-end rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50" @click="inspectNamespace">
          <LoaderCircleIcon v-if="loading === 'namespace'" tw-class="mr-1 inline h-3.5 w-3.5 animate-spin" />
          <SearchIcon v-else tw-class="mr-1 inline h-3.5 w-3.5" />
          Inspect path
        </button>
      </div>

      <div v-if="errorMessage" data-testid="hizofs-physical-inspector-error" tw-class="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 font-mono text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ errorMessage }}</div>

      <div tw-class="min-h-0 flex-1 overflow-y-auto p-4">
        <div v-if="containerView === undefined && namespaceView === undefined" tw-class="flex min-h-64 items-center justify-center text-center text-sm text-gray-500 dark:text-gray-400">
          Enter a passphrase, then read physical state or inspect a namespace path.
        </div>

        <div v-else tw-class="space-y-5">
          <section v-if="containerView" data-testid="hizofs-physical-inspector-container" tw-class="space-y-3">
            <h3 tw-class="text-sm font-semibold text-gray-900 dark:text-gray-100">Physical authority</h3>
            <div tw-class="grid gap-3 md:grid-cols-3">
              <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><div tw-class="text-[10px] font-semibold uppercase text-gray-400">Unlock selection</div><div tw-class="mt-1 break-words font-mono text-xs">{{ containerView.unlockSelectionSummary }}</div></div>
              <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <div tw-class="text-[10px] font-semibold uppercase text-gray-400">Superblock selection</div>
                <div tw-class="mt-1 break-words font-mono text-xs">{{ containerView.superblockSelectionSummary }}</div>
                <div v-if="containerView.authorityNavigationTargets.length > 0" tw-class="mt-2 flex flex-wrap gap-1">
                  <button
                    v-for="target in containerView.authorityNavigationTargets"
                    :key="target.label"
                    type="button"
                    data-testid="hizofs-physical-inspector-authority-navigation"
                    :disabled="!canInspect"
                    tw-class="rounded border border-emerald-300 px-2 py-1 text-[10px] font-medium text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                    @click="inspectPhysicalRecord({ request: target.request })"
                  >Inspect {{ target.label }}</button>
                </div>
              </div>
              <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <div tw-class="text-[10px] font-semibold uppercase text-gray-400">Root shortcut</div>
                <div tw-class="mt-1 break-words font-mono text-xs">{{ containerView.rootDirectorySummary }}</div>
                <div v-if="containerView.rootNavigationTargets.length > 0" tw-class="mt-2 flex flex-wrap gap-1">
                  <button
                    v-for="target in containerView.rootNavigationTargets"
                    :key="target.label"
                    type="button"
                    data-testid="hizofs-physical-inspector-root-navigation"
                    :disabled="!canInspect"
                    tw-class="rounded border border-emerald-300 px-2 py-1 text-[10px] font-medium text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                    @click="inspectHomeRecord({ request: target.request })"
                  >Inspect {{ target.label }}</button>
                </div>
              </div>
            </div>

            <div tw-class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table tw-class="min-w-full text-left text-xs">
                <thead tw-class="bg-gray-50 text-[10px] uppercase text-gray-500 dark:bg-gray-950"><tr><th tw-class="px-3 py-2">Kind</th><th tw-class="px-3 py-2">Copy</th><th tw-class="px-3 py-2">State</th><th tw-class="px-3 py-2">Sequence</th><th tw-class="px-3 py-2">Path</th><th tw-class="px-3 py-2">Persisted fields</th><th tw-class="px-3 py-2">Reason</th></tr></thead>
                <tbody>
                  <tr v-for="row in containerView.copyRows" :key="`${row.kind}:${String(row.copy)}`" data-testid="hizofs-physical-inspector-copy-row" tw-class="border-t border-gray-100 font-mono dark:border-gray-800">
                    <td tw-class="px-3 py-2">{{ row.kind }}</td><td tw-class="px-3 py-2">{{ row.copy }}<span v-if="row.selected"> · selected</span></td><td tw-class="px-3 py-2">{{ row.state }}</td><td tw-class="px-3 py-2">{{ copySequence({ row }) }}</td><td tw-class="px-3 py-2">{{ row.path }}</td><td data-testid="hizofs-physical-inspector-copy-details" tw-class="min-w-80 break-words px-3 py-2">
                      <div>{{ copyDetails({ row }) }}</div>
                      <details
                        v-for="document in persistedDtoDocuments({ row })"
                        :key="document.label"
                        data-testid="hizofs-physical-inspector-persisted-dto"
                        tw-class="mt-2 rounded border border-gray-200 p-2 dark:border-gray-700"
                      >
                        <summary tw-class="cursor-pointer text-[10px] font-semibold uppercase text-gray-500">{{ document.label }}</summary>
                        <pre tw-class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-[10px]">{{ document.json }}</pre>
                      </details>
                    </td><td tw-class="px-3 py-2">{{ row.reason ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="containerView.frameRowsTruncated" data-testid="hizofs-physical-inspector-frame-budget" tw-class="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 font-mono text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
              Showing {{ containerView.displayedFrameCount }} of {{ containerView.totalFrameCount }} observed frame rows.
            </div>

            <div tw-class="grid gap-3 lg:grid-cols-2">
              <article v-for="segment in containerView.segmentRows" :key="segment.path" data-testid="hizofs-physical-inspector-segment" tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <div tw-class="flex items-start justify-between gap-3"><div tw-class="min-w-0"><div tw-class="truncate font-mono text-xs font-semibold">{{ segment.path }}</div><div tw-class="mt-1 text-[10px] text-gray-500">{{ segment.segmentClass }} · {{ segment.state }} · {{ segment.physicalSegmentId ?? 'unobserved ID' }} · {{ segment.fileSize ?? 'unobserved size' }} bytes</div></div><div tw-class="shrink-0 font-mono text-[10px] text-gray-500">{{ segment.frameCount }} frames<span v-if="segment.frameRowsTruncated"> · rows truncated</span></div></div>
                <div v-if="segment.reason" tw-class="mt-2 break-words font-mono text-[10px] text-red-600 dark:text-red-300">{{ segment.reason }}</div>
                <div v-if="segment.frames.length > 0" tw-class="mt-3 flex max-h-36 flex-wrap gap-1 overflow-y-auto">
                  <button
                    v-for="frame in segment.frames"
                    :key="`${frame.physicalSegmentId}:${frame.physicalOffset}`"
                    type="button"
                    data-testid="hizofs-physical-inspector-frame"
                    :tw-class="['rounded border px-2 py-1 font-mono text-[10px]', selectedFrame?.physicalSegmentId === frame.physicalSegmentId && selectedFrame?.physicalOffset === frame.physicalOffset ? 'border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300' : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800']"
                    @click="selectFrame({ frame })"
                  >
                    {{ frame.physicalOffset }} · kind {{ frame.recordKind }} · frame {{ frame.frameLength }} · plaintext {{ frame.plaintextLength }}
                  </button>
                </div>
              </article>
            </div>

            <section v-if="selectedFrame" data-testid="hizofs-physical-inspector-record-selection" tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div tw-class="flex flex-wrap items-end gap-3">
                <div tw-class="min-w-0 flex-1">
                  <div tw-class="text-[10px] font-semibold uppercase text-gray-400">Selected physical frame</div>
                  <div tw-class="mt-1 break-words font-mono text-xs">{{ selectedFrame.physicalSegmentId }}:{{ selectedFrame.physicalOffset }} · home {{ selectedFrame.homeSegmentId }}:{{ selectedFrame.homeOffset }}</div>
                </div>
                <label tw-class="text-xs font-medium text-gray-700 dark:text-gray-200">Page role
                  <select v-model="selectedPageRole" data-testid="hizofs-physical-inspector-page-role" tw-class="ml-2 rounded border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-gray-600 dark:bg-gray-950">
                    <option value="unspecified">unspecified</option>
                    <option value="root">root</option>
                    <option value="non_root">non-root</option>
                  </select>
                </label>
                <button type="button" data-testid="hizofs-physical-inspector-read-record" :disabled="!canInspect" tw-class="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50" @click="inspectSelectedRecord">
                  <LoaderCircleIcon v-if="loading === 'record'" tw-class="mr-1 inline h-3.5 w-3.5 animate-spin" />
                  Inspect selected frame
                </button>
              </div>
            </section>

            <ul v-if="containerView.physicalAnomalies.length > 0" tw-class="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 font-mono text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              <li v-for="anomaly in containerView.physicalAnomalies" :key="anomaly">{{ anomaly }}</li>
            </ul>
          </section>

          <section v-if="namespaceView" data-testid="hizofs-physical-inspector-namespace" tw-class="space-y-3">
            <div tw-class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div tw-class="flex flex-wrap items-center gap-2">
                  <h3 tw-class="text-sm font-semibold text-gray-900 dark:text-gray-100">Namespace {{ namespaceView.path }}</h3>
                  <button
                    v-if="namespaceView.parentPathComponents !== undefined"
                    type="button"
                    data-testid="hizofs-physical-inspector-parent-path"
                    tw-class="rounded border border-gray-200 px-2 py-1 font-mono text-[10px] hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                    @click="selectNamespacePath({ pathComponents: namespaceView.parentPathComponents })"
                  >
                    parent {{ namespaceView.parentPath }}
                  </button>
                </div>
                <p tw-class="mt-1 font-mono text-xs text-gray-500">{{ namespaceView.authoritySummary }} · {{ namespaceView.resourceSummary }}</p>
              </div>
              <div tw-class="font-mono text-xs text-gray-600 dark:text-gray-300">{{ namespaceView.inodeSummary }}</div>
            </div>
            <dl data-testid="hizofs-physical-inspector-inode-fields" tw-class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-gray-200 p-3 font-mono text-xs dark:border-gray-700">
              <dt tw-class="text-gray-400">Commit sequence</dt><dd>{{ namespaceView.commitSequence }}</dd>
              <dt tw-class="text-gray-400">Inode number</dt><dd>{{ namespaceView.inodeNumber }}</dd>
              <dt tw-class="text-gray-400">Inode revision</dt><dd>{{ namespaceView.inodeRevision }}</dd>
              <dt tw-class="text-gray-400">Inode kind</dt><dd>{{ namespaceView.inodeKind }}</dd>
              <dt tw-class="text-gray-400">Created at</dt><dd>{{ namespaceView.createdAt ?? 'unavailable' }}</dd>
              <dt tw-class="text-gray-400">Modified at</dt><dd>{{ namespaceView.modifiedAt ?? 'unavailable' }}</dd>
              <dt tw-class="text-gray-400">File size</dt><dd>{{ namespaceView.fileSize ?? 'unavailable' }}</dd>
              <dt tw-class="text-gray-400">Page reads</dt><dd>{{ namespaceView.pagesRead }}<span v-if="namespaceView.pageReadsTruncated"> · reported references truncated</span></dd>
            </dl>
            <div v-if="namespaceView.directorySummary" tw-class="text-xs text-gray-500">{{ namespaceView.directorySummary }}</div>
            <div v-if="namespaceView.pageNavigationTargets.length > 0" tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div tw-class="text-[10px] font-semibold uppercase text-gray-400">Authenticated page reads</div>
              <div tw-class="mt-1 text-xs text-gray-500">{{ namespaceView.pageNavigationSummary }}</div>
              <div tw-class="mt-2 flex flex-wrap gap-1">
                <button
                  v-for="target in namespaceView.pageNavigationTargets"
                  :key="`${target.label}:${target.request.homeSegmentId}:${target.request.homeOffset}`"
                  type="button"
                  data-testid="hizofs-physical-inspector-namespace-page"
                  :disabled="!canInspect"
                  tw-class="rounded border border-emerald-300 px-2 py-1 text-[10px] font-medium text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                  @click="inspectHomeRecord({ request: target.request })"
                >
                  {{ target.label }} · {{ target.role }} · {{ target.request.homeSegmentId }}:{{ target.request.homeOffset }} · frame {{ target.request.frameLength }} · kind {{ target.request.recordKind }} · {{ target.request.pageIsRoot ? 'root' : 'non-root' }}
                </button>
              </div>
            </div>
            <div v-if="namespaceView.symlinkTarget" tw-class="rounded-lg border border-gray-200 p-3 font-mono text-xs dark:border-gray-700">→ {{ namespaceView.symlinkTarget }}</div>
            <div v-if="namespaceView.directoryEntries.length > 0" tw-class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table tw-class="min-w-full text-left text-xs"><thead tw-class="bg-gray-50 text-[10px] uppercase text-gray-500 dark:bg-gray-950"><tr><th tw-class="px-3 py-2">Name</th><th tw-class="px-3 py-2">Kind</th><th tw-class="px-3 py-2">Target</th></tr></thead><tbody><tr v-for="entry in namespaceView.directoryEntries" :key="entry.name" data-testid="hizofs-physical-inspector-namespace-row" tw-class="border-t border-gray-100 font-mono dark:border-gray-800"><td tw-class="px-3 py-2"><button type="button" data-testid="hizofs-physical-inspector-namespace-entry" tw-class="font-mono underline decoration-dotted underline-offset-2 hover:text-emerald-700 dark:hover:text-emerald-300" @click="selectNamespacePath({ pathComponents: entry.pathComponents })">{{ entry.name }}</button></td><td tw-class="px-3 py-2">{{ entry.kind }}</td><td tw-class="px-3 py-2">{{ entry.target }}</td></tr></tbody></table>
            </div>
          </section>

          <section v-if="recordView" data-testid="hizofs-physical-inspector-record" tw-class="grid gap-2 rounded-lg border border-gray-200 p-3 md:grid-cols-2 dark:border-gray-700">
            <div tw-class="rounded border border-gray-200 p-2 font-mono text-xs dark:border-gray-700">{{ recordView.identitySummary }}</div>
            <div tw-class="rounded border border-gray-200 p-2 font-mono text-xs dark:border-gray-700">{{ recordView.recordKindName }} ({{ recordView.recordKind }}) · {{ recordView.plaintextSummary }}</div>
            <dl data-testid="hizofs-physical-inspector-record-fields" tw-class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 rounded border border-gray-200 p-2 font-mono text-xs md:col-span-2 dark:border-gray-700">
              <dt tw-class="text-gray-400">Frame length</dt><dd>{{ recordView.frameLength }}</dd>
              <dt tw-class="text-gray-400">Sealed length</dt><dd>{{ recordView.sealedLength }}</dd>
              <dt tw-class="text-gray-400">Header flags</dt><dd>{{ recordView.headerFlags }}</dd>
              <dt tw-class="text-gray-400">Plaintext length</dt><dd>{{ recordView.plaintextByteLength }}</dd>
              <dt tw-class="text-gray-400">Preview length</dt><dd>{{ recordView.plaintextPreviewByteLength }}</dd>
              <dt tw-class="text-gray-400">Preview truncated</dt><dd>{{ recordView.plaintextPreviewTruncated }}</dd>
              <dt tw-class="text-gray-400">Preview Base64URL</dt><dd tw-class="break-all">{{ recordView.plaintextPreviewBase64Url === '' ? '(empty)' : recordView.plaintextPreviewBase64Url }}</dd>
            </dl>
            <div tw-class="rounded border border-gray-200 p-2 font-mono text-xs md:col-span-2 dark:border-gray-700">{{ recordView.payloadSummary }}</div>
            <section tw-class="rounded border border-gray-200 md:col-span-2 dark:border-gray-700">
              <div data-testid="hizofs-physical-inspector-record-payload-label" tw-class="border-b border-gray-200 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700">{{ recordView.payloadDocumentLabel }}</div>
              <pre data-testid="hizofs-physical-inspector-record-payload" tw-class="max-h-80 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[10px]">{{ recordView.payloadJson }}</pre>
            </section>
            <div v-if="recordView.navigationTargets.length > 0" tw-class="flex flex-wrap gap-2 md:col-span-2">
              <button
                v-for="target in recordView.navigationTargets"
                :key="navigationTargetKey({ target })"
                type="button"
                :data-testid="navigationTargetTestId({ target })"
                :disabled="!canInspect"
                tw-class="rounded-lg border border-emerald-300 px-3 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                @click="inspectNavigationTarget({ target })"
              >
                <LoaderCircleIcon v-if="isNavigationTargetLoading({ target })" tw-class="mr-1 inline h-3.5 w-3.5 animate-spin" />
                Inspect {{ target.label }}
              </button>
            </div>
          </section>
        </div>
      </div>
    </section>
  </div>
</template>
