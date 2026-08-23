<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronRightIcon, CopyIcon, LoaderCircleIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-vue-next";
import { JsonCodeView } from "@/features/json-viewer";
import { createHizoFSNamespaceInspectionView } from "@/features/debug-hizofs/logic/namespace-inspection-view";
import {
  appendHizoFSPhysicalInspectorRecordTraversalColumn,
  attachHizoFSPhysicalInspectorRecordFrame,
  createHizoFSPhysicalInspectorAuthorityTraversalColumn,
  createHizoFSPhysicalInspectorNamespaceTraversalColumn,
  createHizoFSPhysicalInspectorRecordTraversalColumn,
  type HizoFSPhysicalInspectorRecordTraversalColumn,
  type HizoFSPhysicalInspectorTraversalBreadcrumb,
} from "@/features/debug-hizofs/logic/physical-inspector-record-traversal";
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
import { bindHizoFSPhysicalInspectionWorkerPassphrase, type HizoFSAuthenticatedInspectionSession } from "@/features/debug-hizofs/worker/authenticated-inspection-session";
import type { HizoFSPhysicalInspectionWorker } from "@/features/debug-hizofs/worker/physical-inspection";

const props = defineProps<{
  authenticatedSession?: HizoFSAuthenticatedInspectionSession;
  embeddedInWorkbench?: boolean;
  inspector?: HizoFSPhysicalInspectionWorker;
  requestedNamespacePath?: string;
}>();
const emit = defineEmits<{
  namespaceInspected: [payload: {
    authorityMode: ReturnType<typeof createHizoFSNamespaceInspectionView>["authorityMode"];
    commitSequence: string;
    path: string;
  }];
  traversalChanged: [payload: { breadcrumbs: readonly HizoFSPhysicalInspectorTraversalBreadcrumb[] }];
}>();

const NAMESPACE_TRAVERSAL_ORIGIN = "namespace" as const;

const passphrase = ref("");
const namespacePath = ref("/");
const loading = ref<"container" | "frame" | "home_record" | "namespace" | "record">();
const errorMessage = ref<string>();
const containerView = ref<ReturnType<typeof createHizoFSPhysicalContainerInspectionView>>();
type NamespaceInspectionView = ReturnType<typeof createHizoFSNamespaceInspectionView>;
const namespaceViews = ref<readonly NamespaceInspectionView[]>([]);
const namespaceView = computed(() => namespaceViews.value.at(-1));
const recordTraversalColumns = ref<readonly HizoFSPhysicalInspectorRecordTraversalColumn[]>([]);
const traversalOrigin = ref<"authority" | "frame" | "namespace">();
const selectedFrame = ref<HizoFSPhysicalFrameInspectionRow>();
const selectedPageRole = ref<"non_root" | "root" | "unspecified">("unspecified");
const payloadCopyFeedback = ref<Readonly<{
  columnIndex: number;
  detail: string;
  status: "failure" | "success";
}>>();
const columnScroll = ref<HTMLElement>();
let payloadCopyFeedbackTimeout: ReturnType<typeof setTimeout> | undefined;
let recordTraversalRevision = 0;
let authenticatedNamespaceInspectionQueued = false;
let inspectorPanelDisposed = false;
let inspectionSourceRevision = 0;

onBeforeUnmount(() => {
  inspectorPanelDisposed = true;
  authenticatedNamespaceInspectionQueued = false;
  invalidateRecordTraversal();
  if (payloadCopyFeedbackTimeout !== undefined) clearTimeout(payloadCopyFeedbackTimeout);
});

const requiresPassphrase = computed(() => props.authenticatedSession === undefined);
const canInspect = computed(() => loading.value === undefined && (
  props.authenticatedSession !== undefined
  || (props.inspector !== undefined && passphrase.value.length > 0)
));
const authorityTraversalColumn = computed(() => (
  containerView.value === undefined
    ? undefined
    : createHizoFSPhysicalInspectorAuthorityTraversalColumn({ view: containerView.value })
));
const namespaceTraversalColumn = computed(() => (
  namespaceView.value === undefined
    ? undefined
    : createHizoFSPhysicalInspectorNamespaceTraversalColumn({ view: namespaceView.value })
));

const traversalBreadcrumbs = computed<readonly HizoFSPhysicalInspectorTraversalBreadcrumb[]>(() => {
  const recordBreadcrumbs: readonly HizoFSPhysicalInspectorTraversalBreadcrumb[] = recordTraversalColumns.value.map((column, columnIndex) => ({
    columnIndex,
    kind: "record",
    label: column.title,
  }));
  switch (traversalOrigin.value) {
  case undefined: return recordBreadcrumbs;
  case "authority": return authorityTraversalColumn.value === undefined
    ? recordBreadcrumbs
    : [{ kind: "authority", label: authorityTraversalColumn.value.title }, ...recordBreadcrumbs];
  case "namespace": return namespaceTraversalColumn.value === undefined
    ? recordBreadcrumbs
    : [{ kind: "namespace", label: namespaceTraversalColumn.value.title }, ...recordBreadcrumbs];
  case "frame": return [{ kind: "frame", label: "Physical frame" }, ...recordBreadcrumbs];
  default: return traversalOrigin.value satisfies never;
  }
});

watch(
  traversalBreadcrumbs,
  breadcrumbs => emit("traversalChanged", { breadcrumbs }),
  { immediate: true },
);

watch(
  loading,
  currentLoading => {
    if (currentLoading !== undefined || !authenticatedNamespaceInspectionQueued) return;
    requestAuthenticatedNamespaceInspection();
  },
);

watch(
  () => [
    traversalOrigin.value,
    recordTraversalColumns.value.length,
    recordTraversalColumns.value.at(-1)?.view.identitySummary,
  ] as const,
  async () => {
    await nextTick();
    const scroll = columnScroll.value;
    if (scroll === undefined) return;
    const scrollTarget = props.embeddedInWorkbench
      ? scroll.closest<HTMLElement>("[data-workbench-column-scroll]")
      : scroll;
    if (scrollTarget === null) return;
    scrollTarget.scrollLeft = scrollTarget.scrollWidth;
  },
);
function errorText({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

async function copyDecodedPayload({ columnIndex, payloadJson }: {
  columnIndex: number;
  payloadJson: string;
}): Promise<void> {
  if (payloadCopyFeedbackTimeout !== undefined) clearTimeout(payloadCopyFeedbackTimeout);
  try {
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) throw new Error("Clipboard API is unavailable");
    await clipboard.writeText(payloadJson);
    payloadCopyFeedback.value = { columnIndex, detail: "Copied", status: "success" };
  } catch (error: unknown) {
    payloadCopyFeedback.value = {
      columnIndex,
      detail: `Copy failed: ${errorText({ error })}`,
      status: "failure",
    };
  }
  payloadCopyFeedbackTimeout = setTimeout(() => {
    payloadCopyFeedback.value = undefined;
    payloadCopyFeedbackTimeout = undefined;
  }, 2_000);
}

function currentInspectionSession(): HizoFSAuthenticatedInspectionSession {
  const authenticatedSession = props.authenticatedSession;
  if (authenticatedSession !== undefined) return authenticatedSession;
  const inspector = props.inspector;
  if (inspector === undefined) throw new TypeError("HizoFS Inspector source is unavailable");
  if (passphrase.value.length === 0) throw new TypeError("HizoFS Inspector passphrase is required");
  return bindHizoFSPhysicalInspectionWorkerPassphrase({
    passphrase: passphrase.value,
    worker: inspector,
  });
}

function clearOneShotPassphrase(): void {
  if (requiresPassphrase.value) passphrase.value = "";
}

async function loadRecordFrame({ columnIndex }: { columnIndex: number }): Promise<void> {
  const column = recordTraversalColumns.value[columnIndex];
  if (column === undefined) return;
  loading.value = "frame";
  errorMessage.value = undefined;
  try {
    const framedBinary = await currentInspectionSession().inspectRecordFrame({
      request: {
        frameLength: column.view.frameLength,
        homeOffset: column.view.homeOffset,
        homeSegmentId: column.view.homeSegmentId,
        physicalOffset: column.view.physicalOffset,
        physicalSegmentId: column.view.physicalSegmentId,
        recordKind: column.view.recordKind,
      },
    });
    if (inspectorPanelDisposed || recordTraversalColumns.value[columnIndex] !== column) return;
    recordTraversalColumns.value = recordTraversalColumns.value.map((candidate, index) => (
      index === columnIndex
        ? attachHizoFSPhysicalInspectorRecordFrame({ column: candidate, framedBinary })
        : candidate
    ));
  } catch (error: unknown) {
    if (!inspectorPanelDisposed && recordTraversalColumns.value[columnIndex] === column) {
      errorMessage.value = errorText({ error });
    }
  } finally {
    clearOneShotPassphrase();
    loading.value = undefined;
  }
}

function invalidateRecordTraversal(): void {
  recordTraversalRevision += 1;
}

function clearRecordTraversal(): void {
  invalidateRecordTraversal();
  recordTraversalColumns.value = [];
}

function clearNamespaceTraversal(): void {
  namespaceViews.value = [];
}

function namespaceObservationForRecord({ sourceColumnIndex }: {
  sourceColumnIndex: number | undefined;
}): HizoFSPhysicalInspectorRecordTraversalColumn["namespaceObservation"] {
  if (sourceColumnIndex !== undefined) {
    return recordTraversalColumns.value[sourceColumnIndex]?.namespaceObservation;
  }
  if (traversalOrigin.value !== NAMESPACE_TRAVERSAL_ORIGIN) return undefined;
  const currentNamespaceView = namespaceView.value;
  if (currentNamespaceView === undefined) return undefined;
  return {
    authorityMode: currentNamespaceView.authorityMode,
    commitSequence: currentNamespaceView.commitSequence,
    path: currentNamespaceView.path,
    pathComponents: [...currentNamespaceView.pathComponents],
  };
}

async function returnToNamespaceObservation({ observation }: {
  observation: NonNullable<HizoFSPhysicalInspectorRecordTraversalColumn["namespaceObservation"]>;
}): Promise<void> {
  selectNamespacePath({ pathComponents: observation.pathComponents });
  const currentNamespaceView = namespaceView.value;
  if (currentNamespaceView?.path === observation.path) {
    traversalOrigin.value = NAMESPACE_TRAVERSAL_ORIGIN;
    clearRecordTraversal();
    return;
  }
  await navigateNamespacePath({ pathComponents: observation.pathComponents });
}

function closeRecordTraversalColumn({ columnIndex }: { columnIndex: number }): void {
  invalidateRecordTraversal();
  recordTraversalColumns.value = recordTraversalColumns.value.slice(0, columnIndex);
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
      fallbackCommit,
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
    return `active Commit sequence ${activeCommitSequence ?? "unavailable"}; minimum Unlock sequence ${minimumUnlockSequence ?? "unavailable"}; required feature bits ${requiredFeatureBits ?? "unavailable"}; active Commit ${recordReferenceSummary({ reference: activeCommit })}; fallback Commit ${recordReferenceSummary({ reference: fallbackCommit })}; relocation root ${recordReferenceSummary({ reference: relocationIndexRoot })}`;
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
      fallbackCommit: _fallbackCommit,
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

function requestAuthenticatedNamespaceInspection(): void {
  if (inspectorPanelDisposed || props.authenticatedSession === undefined) return;
  const currentLoading = loading.value;
  switch (currentLoading) {
  case undefined:
    authenticatedNamespaceInspectionQueued = false;
    void inspectNamespace();
    return;
  case "namespace":
    // The in-flight namespace read already follows the latest requested path
    // before publishing its result, so a second queued read is unnecessary.
    return;
  case "container":
  case "frame":
  case "home_record":
  case "record":
    authenticatedNamespaceInspectionQueued = true;
    return;
  default:
    currentLoading satisfies never;
  }
}

async function navigateNamespacePath({ pathComponents }: { pathComponents: readonly string[] }): Promise<void> {
  selectNamespacePath({ pathComponents });
  if (props.authenticatedSession === undefined) return;
  if (loading.value !== undefined) {
    requestAuthenticatedNamespaceInspection();
    return;
  }
  await inspectNamespace();
}

function namespacePathPrefixes({ pathComponents }: {
  pathComponents: readonly string[];
}): readonly (readonly string[])[] {
  return Array.from(
    { length: pathComponents.length + 1 },
    (_unused, length) => pathComponents.slice(0, length),
  );
}

function matchingNamespacePrefixCount({ pathPrefixes }: {
  pathPrefixes: readonly (readonly string[])[];
}): number {
  let count = 0;
  while (
    count < pathPrefixes.length
    && namespaceViews.value[count]?.path === formatHizoFSInspectorNamespacePath({
      pathComponents: pathPrefixes[count] ?? [],
    })
  ) count += 1;
  return count;
}

async function inspectContainer(): Promise<void> {
  if (!canInspect.value) return;
  const sourceRevision = inspectionSourceRevision;
  loading.value = "container";
  errorMessage.value = undefined;
  containerView.value = undefined;
  selectedFrame.value = undefined;
  clearRecordTraversal();
  traversalOrigin.value = "authority";
  try {
    const inspection = await currentInspectionSession().inspectContainer();
    if (inspectorPanelDisposed || sourceRevision !== inspectionSourceRevision) return;
    containerView.value = createHizoFSPhysicalContainerInspectionView({ inspection });
  } catch (error) {
    if (!inspectorPanelDisposed && sourceRevision === inspectionSourceRevision) errorMessage.value = errorText({ error });
  } finally {
    clearOneShotPassphrase();
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
  clearRecordTraversal();
  traversalOrigin.value = "frame";
  selectedPageRole.value = "unspecified";
}

async function inspectSelectedRecord(): Promise<void> {
  const frame = selectedFrame.value;
  if (!canInspect.value || frame === undefined) return;
  traversalOrigin.value = "frame";
  await inspectPhysicalRecord({
    request: physicalRecordRequest({
      frame,
      pageRole: selectedPageRole.value,
    }),
  });
}

async function inspectSelectedHomeRecord(): Promise<void> {
  const reference = selectedFrame.value?.homeReference;
  if (!canInspect.value || reference === undefined) return;
  traversalOrigin.value = "frame";
  await inspectHomeRecord({
    request: {
      frameLength: reference.frameLength,
      homeOffset: reference.byteOffset,
      homeSegmentId: reference.segmentId,
      recordKind: reference.recordKind,
    },
    title: "Logical Home Record",
  });
}

async function inspectPhysicalRecord({ request, sourceColumnIndex, title = "Physical Record" }: {
  request: Parameters<HizoFSPhysicalInspectionWorker["inspectRecord"]>[0]["request"];
  sourceColumnIndex?: number;
  title?: string;
}): Promise<void> {
  if (!canInspect.value) return;
  const namespaceObservation = namespaceObservationForRecord({ sourceColumnIndex });
  const requestRevision = ++recordTraversalRevision;
  loading.value = "record";
  errorMessage.value = undefined;
  try {
    const inspection = await currentInspectionSession().inspectRecord({
      maximumPreviewBytes: 4096,
      request,
    });
    if (requestRevision !== recordTraversalRevision) return;
    const view = createHizoFSPhysicalRecordInspectionView({ inspection });
    recordTraversalColumns.value = appendHizoFSPhysicalInspectorRecordTraversalColumn({
      column: createHizoFSPhysicalInspectorRecordTraversalColumn({ namespaceObservation, title, view }),
      columns: recordTraversalColumns.value,
      sourceColumnIndex,
    });
  } catch (error) {
    if (requestRevision === recordTraversalRevision) errorMessage.value = errorText({ error });
  } finally {
    clearOneShotPassphrase();
    loading.value = undefined;
  }
}

async function inspectNavigationTarget({ sourceColumnIndex, target }: {
  sourceColumnIndex?: number;
  target: HizoFSPhysicalRecordNavigationTarget;
}): Promise<void> {
  switch (target.targetType) {
  case "home_record":
    await inspectHomeRecord({ request: target.request, sourceColumnIndex, title: target.label });
    break;
  case "physical_record":
    await inspectPhysicalRecord({ request: target.request, sourceColumnIndex, title: target.label });
    break;
  default: target satisfies never;
  }
}

async function inspectAuthorityNavigationTarget({ target }: {
  target: HizoFSPhysicalRecordNavigationTarget;
}): Promise<void> {
  traversalOrigin.value = "authority";
  clearRecordTraversal();
  await inspectNavigationTarget({ target });
}

function authorityPhysicalTargetSummary({ target }: {
  target: NonNullable<ReturnType<typeof createHizoFSPhysicalContainerInspectionView>>["authorityNavigationTargets"][number];
}): string {
  const { label, request, ...unhandledTarget } = target;
  unhandledTarget satisfies Record<PropertyKey, never>;
  return navigationTargetDestinationSummary({ target: { label, request, targetType: "physical_record" } });
}

function authorityHomeTargetSummary({ target }: {
  target:
    | NonNullable<ReturnType<typeof createHizoFSPhysicalContainerInspectionView>>["recoveryNavigationTargets"][number]
    | NonNullable<ReturnType<typeof createHizoFSPhysicalContainerInspectionView>>["rootNavigationTargets"][number];
}): string {
  const { label, request, ...unhandledTarget } = target;
  unhandledTarget satisfies Record<PropertyKey, never>;
  return navigationTargetDestinationSummary({ target: { label, request, targetType: "home_record" } });
}

async function inspectAuthorityPhysicalTarget({ target }: {
  target: NonNullable<ReturnType<typeof createHizoFSPhysicalContainerInspectionView>>["authorityNavigationTargets"][number];
}): Promise<void> {
  const { label, request, ...unhandledTarget } = target;
  unhandledTarget satisfies Record<PropertyKey, never>;
  await inspectAuthorityNavigationTarget({ target: { label, request, targetType: "physical_record" } });
}

async function inspectAuthorityHomeTarget({ target }: {
  target:
    | NonNullable<ReturnType<typeof createHizoFSPhysicalContainerInspectionView>>["recoveryNavigationTargets"][number]
    | NonNullable<ReturnType<typeof createHizoFSPhysicalContainerInspectionView>>["rootNavigationTargets"][number];
}): Promise<void> {
  const { label, request, ...unhandledTarget } = target;
  unhandledTarget satisfies Record<PropertyKey, never>;
  await inspectAuthorityNavigationTarget({ target: { label, request, targetType: "home_record" } });
}

async function inspectNamespaceNavigationTarget({ target }: {
  target: HizoFSPhysicalRecordNavigationTarget;
}): Promise<void> {
  traversalOrigin.value = "namespace";
  clearRecordTraversal();
  await inspectNavigationTarget({ target });
}

function selectNamespaceColumn({ columnIndex }: { columnIndex: number }): void {
  const selected = namespaceViews.value[columnIndex];
  if (selected === undefined) return;
  namespaceViews.value = namespaceViews.value.slice(0, columnIndex + 1);
  namespacePath.value = selected.path;
  traversalOrigin.value = NAMESPACE_TRAVERSAL_ORIGIN;
  clearRecordTraversal();
  emit("namespaceInspected", {
    authorityMode: selected.authorityMode,
    commitSequence: selected.commitSequence,
    path: selected.path,
  });
}

async function inspectNamespaceValidationReference({ reference }: {
  reference: NonNullable<ReturnType<typeof createHizoFSNamespaceInspectionView>>["validationEvidence"]["uniqueHomeRecordReferences"][number];
}): Promise<void> {
  const { occurrenceCount: _occurrenceCount, request, roles: _roles, ...unhandledReference } = reference;
  unhandledReference satisfies Record<PropertyKey, never>;
  await inspectNamespaceNavigationTarget({
    target: {
      label: `Validation Home Record ${request.homeSegmentId}:${request.homeOffset}`,
      request,
      targetType: "home_record",
    },
  });
}

function namespaceValidationReferenceSummary({ reference }: {
  reference: NonNullable<ReturnType<typeof createHizoFSNamespaceInspectionView>>["validationEvidence"]["uniqueHomeRecordReferences"][number];
}): string {
  const { occurrenceCount, request, roles, ...unhandledReference } = reference;
  unhandledReference satisfies Record<PropertyKey, never>;
  const { frameLength, homeOffset, homeSegmentId, pageIsRoot, recordKind, ...unhandledRequest } = request;
  unhandledRequest satisfies Record<PropertyKey, never>;
  return `home ${homeSegmentId}:${homeOffset} · frame ${String(frameLength)} · kind ${String(recordKind)} · ${pageIsRoot ? "root" : "non-root"} · roles ${roles.join(", ")} · ${String(occurrenceCount)} events`;
}

function namespaceValidationEventSummary({ event }: {
  event: NonNullable<ReturnType<typeof createHizoFSNamespaceInspectionView>>["validationEvidence"]["rawPageReadEvents"][number];
}): string {
  const { label, request, role, ...unhandledEvent } = event;
  unhandledEvent satisfies Record<PropertyKey, never>;
  const { frameLength, homeOffset, homeSegmentId, pageIsRoot, recordKind, ...unhandledRequest } = request;
  unhandledRequest satisfies Record<PropertyKey, never>;
  return `${label} · ${role} · home ${homeSegmentId}:${homeOffset} · frame ${String(frameLength)} · kind ${String(recordKind)} · ${pageIsRoot ? "root" : "non-root"}`;
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

function navigationTargetDestinationSummary({ target }: {
  target: HizoFSPhysicalRecordNavigationTarget;
}): string {
  switch (target.targetType) {
  case "home_record": {
    const { frameLength, homeOffset, homeSegmentId, pageIsRoot, recordKind, ...unhandledRequest } = target.request;
    unhandledRequest satisfies Record<PropertyKey, never>;
    return `home ${homeSegmentId}:${homeOffset} · frame ${String(frameLength)} · kind ${String(recordKind)}${pageIsRoot === undefined ? "" : pageIsRoot ? " · root" : " · non-root"}`;
  }
  case "physical_record": {
    const {
      frameLength,
      homeOffset,
      homeSegmentId,
      pageIsRoot,
      physicalOffset,
      physicalSegmentId,
      recordKind,
      ...unhandledRequest
    } = target.request;
    unhandledRequest satisfies Record<PropertyKey, never>;
    const home = homeSegmentId === undefined || homeOffset === undefined
      ? ""
      : ` · home ${homeSegmentId}:${homeOffset}`;
    const pageRole = pageIsRoot === undefined ? "" : pageIsRoot ? " · root" : " · non-root";
    return `physical ${physicalSegmentId}:${physicalOffset} · frame ${String(frameLength)} · kind ${String(recordKind)}${home}${pageRole}`;
  }
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

async function inspectHomeRecord({ request, sourceColumnIndex, title = "Home Record" }: {
  request: Parameters<HizoFSPhysicalInspectionWorker["inspectHomeRecord"]>[0]["request"];
  sourceColumnIndex?: number;
  title?: string;
}): Promise<void> {
  if (!canInspect.value) return;
  const namespaceObservation = namespaceObservationForRecord({ sourceColumnIndex });
  const requestRevision = ++recordTraversalRevision;
  loading.value = "home_record";
  errorMessage.value = undefined;
  try {
    const inspection = await currentInspectionSession().inspectHomeRecord({
      maximumPreviewBytes: 4096,
      request,
    });
    if (requestRevision !== recordTraversalRevision) return;
    const view = createHizoFSPhysicalRecordInspectionView({ inspection });
    recordTraversalColumns.value = appendHizoFSPhysicalInspectorRecordTraversalColumn({
      column: createHizoFSPhysicalInspectorRecordTraversalColumn({ namespaceObservation, title, view }),
      columns: recordTraversalColumns.value,
      sourceColumnIndex,
    });
  } catch (error) {
    if (requestRevision === recordTraversalRevision) errorMessage.value = errorText({ error });
  } finally {
    clearOneShotPassphrase();
    loading.value = undefined;
  }
}

async function inspectNamespace(): Promise<void> {
  if (!canInspect.value) return;
  const sourceRevision = inspectionSourceRevision;
  const requestedPath = namespacePath.value;
  let followLatestRequestedPath = false;
  loading.value = "namespace";
  errorMessage.value = undefined;
  clearRecordTraversal();
  traversalOrigin.value = "namespace";
  let retainedCount = 0;
  try {
    const requestedPathComponents = parseHizoFSInspectorNamespacePath({ path: requestedPath });
    const pathPrefixes = namespacePathPrefixes({ pathComponents: requestedPathComponents });
    retainedCount = Math.min(
      matchingNamespacePrefixCount({ pathPrefixes }),
      pathPrefixes.length - 1,
    );
    const nextNamespaceViews = namespaceViews.value.slice(0, retainedCount);
    for (const pathComponents of pathPrefixes.slice(retainedCount)) {
      const inspection = await currentInspectionSession().inspectNamespacePath({
        maximumDirectoryEntries: 256,
        maximumPages: 4096,
        pathComponents,
      });
      if (inspectorPanelDisposed || sourceRevision !== inspectionSourceRevision) return;
      followLatestRequestedPath = props.authenticatedSession !== undefined && namespacePath.value !== requestedPath;
      if (followLatestRequestedPath) return;
      const nextView = createHizoFSNamespaceInspectionView({ inspection });
      const expectedPath = formatHizoFSInspectorNamespacePath({ pathComponents });
      if (nextView.path !== expectedPath) {
        throw new Error(`HizoFS namespace inspection returned ${nextView.path} for ${expectedPath}`);
      }
      nextNamespaceViews.push(nextView);
      namespaceViews.value = [...nextNamespaceViews];
    }
    const nextNamespaceView = nextNamespaceViews.at(-1);
    if (nextNamespaceView === undefined) throw new Error("HizoFS namespace traversal did not produce a root observation");
    namespaceViews.value = [...nextNamespaceViews];
    emit("namespaceInspected", {
      authorityMode: nextNamespaceView.authorityMode,
      commitSequence: nextNamespaceView.commitSequence,
      path: nextNamespaceView.path,
    });
  } catch (error) {
    if (!inspectorPanelDisposed && sourceRevision === inspectionSourceRevision) {
      followLatestRequestedPath = props.authenticatedSession !== undefined && namespacePath.value !== requestedPath;
      if (!followLatestRequestedPath) {
        namespaceViews.value = namespaceViews.value.slice(0, retainedCount);
        errorMessage.value = errorText({ error });
      }
    }
  } finally {
    clearOneShotPassphrase();
    loading.value = undefined;
    if (!inspectorPanelDisposed && sourceRevision === inspectionSourceRevision && followLatestRequestedPath) void inspectNamespace();
  }
}

watch(
  () => [props.authenticatedSession, props.inspector] as const,
  () => {
    inspectionSourceRevision += 1;
    authenticatedNamespaceInspectionQueued = false;
    containerView.value = undefined;
    clearNamespaceTraversal();
    selectedFrame.value = undefined;
    traversalOrigin.value = undefined;
    clearRecordTraversal();
    errorMessage.value = undefined;
    if (props.authenticatedSession === undefined || props.requestedNamespacePath === undefined) return;
    namespacePath.value = props.requestedNamespacePath;
    const currentLoading = loading.value;
    switch (currentLoading) {
    case undefined:
      requestAuthenticatedNamespaceInspection();
      return;
    case "container":
    case "frame":
    case "home_record":
    case "namespace":
    case "record":
      authenticatedNamespaceInspectionQueued = true;
      return;
    default:
      currentLoading satisfies never;
    }
  },
);

watch(
  () => props.requestedNamespacePath,
  path => {
    if (path === undefined) return;
    namespacePath.value = path;
    requestAuthenticatedNamespaceInspection();
  },
  { immediate: true },
);


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
  <div :tw-class="props.embeddedInWorkbench ? 'contents' : 'min-h-full'">
    <section aria-labelledby="hizofs-physical-inspector-title" :tw-class="props.embeddedInWorkbench ? 'contents' : 'flex min-h-full w-full flex-col overflow-hidden bg-white dark:bg-gray-900'">
      <div
        v-if="!props.embeddedInWorkbench"
        tw-class="contents"
      >
        <header tw-class="flex shrink-0 items-center gap-3 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          <SearchIcon tw-class="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          <div tw-class="min-w-0 flex-1">
            <h2 id="hizofs-physical-inspector-title" tw-class="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Physical Inspector · authenticated persisted structure</h2>
            <p tw-class="mt-0.5 font-mono text-[9px] text-gray-500 dark:text-gray-400">Reference-driven traversal · <span v-if="requiresPassphrase">source-owned inspection authority pending</span><span v-else>source already supplies authenticated read-only inspection authority</span></p>
          </div>
        </header>

        <div :tw-class="props.embeddedInWorkbench ? 'flex shrink-0 items-end gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950' : 'grid shrink-0 gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 md:grid-cols-[minmax(180px,0.7fr)_minmax(220px,1fr)_auto_auto] dark:border-gray-700 dark:bg-gray-950'">
          <details v-if="requiresPassphrase" data-testid="hizofs-physical-inspector-credential-fallback" tw-class="border border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20">
            <summary tw-class="cursor-pointer px-2.5 py-2 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Temporary credential fallback</summary>
            <div tw-class="border-t border-amber-200 px-2.5 py-2 dark:border-amber-900">
              <p tw-class="mb-2 text-[10px] leading-4 text-amber-700 dark:text-amber-300">The intended Workbench source owns authenticated read authority. Until that source session is connected, this compatibility fallback performs a one-shot physical read.</p>
              <label tw-class="min-w-0 text-xs font-medium text-gray-700 dark:text-gray-200">
                Passphrase
                <input v-model="passphrase" data-testid="hizofs-physical-inspector-passphrase" type="password" autocomplete="off" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-[10px] dark:border-gray-600 dark:bg-gray-950" />
              </label>
            </div>
          </details>
          <label :tw-class="props.embeddedInWorkbench ? 'min-w-[180px] flex-1 text-[10px] font-medium text-gray-700 dark:text-gray-200' : 'min-w-0 text-xs font-medium text-gray-700 dark:text-gray-200'">
            Namespace path
            <input v-model="namespacePath" data-testid="hizofs-physical-inspector-path" type="text" spellcheck="false" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-[10px] dark:border-gray-600 dark:bg-gray-950" />
          </label>
          <button type="button" data-testid="hizofs-physical-inspector-read-container" :disabled="!canInspect" tw-class="self-end rounded border border-gray-300 px-2.5 py-1.5 text-[10px] font-medium hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-900" @click="inspectContainer">
            <LoaderCircleIcon v-if="loading === 'container'" tw-class="mr-1 inline h-3.5 w-3.5 animate-spin" />
            <RefreshCwIcon v-else tw-class="mr-1 inline h-3.5 w-3.5" />
            {{ containerView === undefined ? 'Read physical state' : 'Refresh physical state' }}
          </button>
          <button type="button" data-testid="hizofs-physical-inspector-read-namespace" :disabled="!canInspect" tw-class="self-end rounded bg-emerald-600 px-2.5 py-1.5 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50" @click="inspectNamespace">
            <LoaderCircleIcon v-if="loading === 'namespace'" tw-class="mr-1 inline h-3.5 w-3.5 animate-spin" />
            <SearchIcon v-else tw-class="mr-1 inline h-3.5 w-3.5" />
            Inspect path
          </button>
        </div>

        <div v-if="errorMessage" data-testid="hizofs-physical-inspector-error" tw-class="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 font-mono text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ errorMessage }}</div>
      </div>

      <div
        ref="columnScroll"
        data-testid="hizofs-physical-inspector-column-scroll"
        :data-embedded-columns="props.embeddedInWorkbench ? 'true' : undefined"
        :tw-class="props.embeddedInWorkbench ? 'contents' : 'min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-gray-100 dark:bg-gray-950'"
      >
        <div v-if="containerView === undefined && namespaceView === undefined" data-testid="hizofs-physical-inspector-empty-columns" :tw-class="props.embeddedInWorkbench ? 'contents' : 'flex h-full min-w-max'">
          <section data-workbench-inspector-surface="physical-authority" tw-class="h-full w-[440px] shrink-0 border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <div tw-class="flex items-center gap-3 border-b border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20">
              <div tw-class="min-w-0 flex-1"><div tw-class="text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Persisted structure</div><div tw-class="mt-0.5 font-mono text-[9px] text-gray-500 dark:text-gray-400">Not loaded</div></div>
              <button v-if="props.embeddedInWorkbench" type="button" data-testid="hizofs-physical-inspector-read-container" title="Read physical state" :disabled="!canInspect" tw-class="shrink-0 border border-emerald-300 px-2 py-1 text-[9px] font-medium text-emerald-800 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-gray-900" @click="inspectContainer"><LoaderCircleIcon v-if="loading === 'container'" tw-class="mr-1 inline h-3 w-3 animate-spin" /><RefreshCwIcon v-else tw-class="mr-1 inline h-3 w-3" />Read physical state</button>
            </div>
            <details v-if="props.embeddedInWorkbench && requiresPassphrase" data-testid="hizofs-physical-inspector-credential-fallback" tw-class="border-b border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20"><summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">One-shot inspection credential</summary><label tw-class="block border-t border-amber-200 px-3 py-2 text-[10px] font-medium text-gray-700 dark:border-amber-900 dark:text-gray-200">Passphrase<input v-model="passphrase" data-testid="hizofs-physical-inspector-passphrase" type="password" autocomplete="off" tw-class="mt-1 w-full border border-gray-300 bg-white px-2 py-1.5 font-mono text-[10px] dark:border-gray-600 dark:bg-gray-950" /></label></details>
            <div v-if="props.embeddedInWorkbench && errorMessage" data-testid="hizofs-physical-inspector-error" tw-class="border-b border-red-200 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ errorMessage }}</div>
            <div tw-class="divide-y divide-gray-100 dark:divide-gray-800">
              <div v-for="label in ['Unlock authority', 'Superblock authority', 'Active Commit', 'Root directory / Inode Table']" :key="label" tw-class="flex items-center gap-3 px-3 py-3 text-xs">
                <span tw-class="min-w-0 flex-1 text-gray-700 dark:text-gray-300">{{ label }}</span>
                <span tw-class="font-mono text-[9px] text-gray-400">not loaded</span>
              </div>
            </div>
          </section>
          <section data-workbench-inspector-surface="namespace" tw-class="h-full w-[440px] shrink-0 border-r border-blue-200 bg-white dark:border-blue-900 dark:bg-gray-900">
            <div tw-class="border-b border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-900 dark:bg-blue-950/20">
              <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Logical traversal</div>
              <div tw-class="mt-0.5 font-mono text-[9px] text-gray-500 dark:text-gray-400">No logical path inspected</div>
            </div>
            <form v-if="props.embeddedInWorkbench" data-testid="hizofs-physical-inspector-path-toolbar" tw-class="flex items-end gap-2 border-b border-blue-100 px-3 py-2.5 dark:border-blue-900" @submit.prevent="inspectNamespace">
              <label tw-class="min-w-0 flex-1 text-[9px] font-medium text-gray-600 dark:text-gray-300">Jump to path<input v-model="namespacePath" data-testid="hizofs-physical-inspector-path" type="text" spellcheck="false" tw-class="mt-1 w-full min-w-0 border border-gray-300 bg-white px-2 py-1.5 font-mono text-[10px] dark:border-gray-600 dark:bg-gray-950" /></label>
              <button type="submit" data-testid="hizofs-physical-inspector-read-namespace" title="Inspect path" aria-label="Inspect path" :disabled="!canInspect" tw-class="shrink-0 border border-blue-300 p-1.5 text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"><LoaderCircleIcon v-if="loading === 'namespace'" tw-class="h-3.5 w-3.5 animate-spin" /><SearchIcon v-else tw-class="h-3.5 w-3.5" /></button>
            </form>
            <div tw-class="px-3 py-3 text-xs leading-5 text-gray-500 dark:text-gray-400">
              Select a directory entry to extend the column chain, or use the path jump to construct it from root.
            </div>
          </section>
        </div>

        <div v-else :tw-class="props.embeddedInWorkbench ? 'contents' : 'flex h-full min-w-max'">
          <section v-if="containerView === undefined" data-workbench-inspector-surface="physical-authority" tw-class="h-full w-[440px] shrink-0 border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <div tw-class="flex items-center gap-3 border-b border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20">
              <div tw-class="min-w-0 flex-1"><div tw-class="text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Persisted structure</div><div tw-class="mt-0.5 font-mono text-[9px] text-gray-500 dark:text-gray-400">Not loaded</div></div>
              <button v-if="props.embeddedInWorkbench" type="button" data-testid="hizofs-physical-inspector-read-container" title="Read physical state" :disabled="!canInspect" tw-class="shrink-0 border border-emerald-300 px-2 py-1 text-[9px] font-medium text-emerald-800 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-gray-900" @click="inspectContainer"><LoaderCircleIcon v-if="loading === 'container'" tw-class="mr-1 inline h-3 w-3 animate-spin" /><RefreshCwIcon v-else tw-class="mr-1 inline h-3 w-3" />Read physical state</button>
            </div>
            <details v-if="props.embeddedInWorkbench && requiresPassphrase" data-testid="hizofs-physical-inspector-credential-fallback" tw-class="border-b border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20"><summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">One-shot inspection credential</summary><label tw-class="block border-t border-amber-200 px-3 py-2 text-[10px] font-medium text-gray-700 dark:border-amber-900 dark:text-gray-200">Passphrase<input v-model="passphrase" data-testid="hizofs-physical-inspector-passphrase" type="password" autocomplete="off" tw-class="mt-1 w-full border border-gray-300 bg-white px-2 py-1.5 font-mono text-[10px] dark:border-gray-600 dark:bg-gray-950" /></label></details>
            <div v-if="props.embeddedInWorkbench && errorMessage" data-testid="hizofs-physical-inspector-error" tw-class="border-b border-red-200 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ errorMessage }}</div>
            <div tw-class="divide-y divide-gray-100 dark:divide-gray-800">
              <div v-for="label in ['Unlock authority', 'Superblock authority', 'Active Commit', 'Root directory / Inode Table']" :key="label" tw-class="flex items-center gap-3 px-3 py-3 text-xs">
                <span tw-class="min-w-0 flex-1 text-gray-700 dark:text-gray-300">{{ label }}</span>
                <span tw-class="font-mono text-[9px] text-gray-400">not loaded</span>
              </div>
            </div>
          </section>
          <div v-if="containerView" data-testid="hizofs-physical-inspector-container" tw-class="flex h-full shrink-0">
            <section data-workbench-inspector-surface="physical-authority" tw-class="h-full w-[440px] shrink-0 overflow-y-auto border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <div tw-class="flex items-center gap-3 border-b border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20"><div tw-class="min-w-0 flex-1"><h3 tw-class="text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Persisted structure</h3><p tw-class="mt-0.5 font-mono text-[9px] text-gray-500 dark:text-gray-400">Loaded · authenticated physical observation</p></div><button v-if="props.embeddedInWorkbench" type="button" data-testid="hizofs-physical-inspector-read-container" title="Refresh physical state" :disabled="!canInspect" tw-class="shrink-0 border border-emerald-300 px-2 py-1 text-[9px] font-medium text-emerald-800 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-gray-900" @click="inspectContainer"><LoaderCircleIcon v-if="loading === 'container'" tw-class="mr-1 inline h-3 w-3 animate-spin" /><RefreshCwIcon v-else tw-class="mr-1 inline h-3 w-3" />Refresh</button></div>
              <details v-if="props.embeddedInWorkbench && requiresPassphrase" data-testid="hizofs-physical-inspector-credential-fallback" tw-class="border-b border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20"><summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">One-shot inspection credential</summary><label tw-class="block border-t border-amber-200 px-3 py-2 text-[10px] font-medium text-gray-700 dark:border-amber-900 dark:text-gray-200">Passphrase<input v-model="passphrase" data-testid="hizofs-physical-inspector-passphrase" type="password" autocomplete="off" tw-class="mt-1 w-full border border-gray-300 bg-white px-2 py-1.5 font-mono text-[10px] dark:border-gray-600 dark:bg-gray-950" /></label></details>
              <div v-if="props.embeddedInWorkbench && errorMessage" data-testid="hizofs-physical-inspector-error" tw-class="border-b border-red-200 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ errorMessage }}</div>
              <div tw-class="divide-y divide-gray-100 border-b border-gray-200 dark:divide-gray-800 dark:border-gray-700">
                <div tw-class="px-3 py-2.5"><div tw-class="text-[10px] font-semibold uppercase text-gray-400">Authority copies</div><div tw-class="mt-1 font-mono text-[9px] text-gray-500 dark:text-gray-400">Unlock / Superblock selection and exact persisted DTOs</div></div>
                <div tw-class="px-3 py-2.5"><div tw-class="text-[10px] font-semibold uppercase text-gray-400">Unlock selection</div><div tw-class="mt-1 break-words font-mono text-xs">{{ containerView.unlockSelectionSummary }}</div></div>
                <div tw-class="px-3 py-2.5">
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
                      @click="inspectAuthorityPhysicalTarget({ target })"
                    >
                      <span tw-class="block">Inspect {{ target.label }}</span>
                      <span data-testid="hizofs-physical-inspector-authority-destination" tw-class="mt-0.5 block break-all font-mono text-[9px] font-normal opacity-80">{{ authorityPhysicalTargetSummary({ target }) }}</span>
                    </button>
                  </div>
                </div>
                <div v-if="containerView.recoveryNavigationTargets.length > 0" tw-class="px-3 py-2.5">
                  <div tw-class="text-[10px] font-semibold uppercase text-gray-400">Recovery references</div>
                  <div tw-class="mt-1 font-mono text-[9px] text-gray-500 dark:text-gray-400">Authenticated reference stored by the selected Superblock; inspect the referenced record to evaluate it.</div>
                  <div tw-class="mt-2 flex flex-wrap gap-1">
                    <button
                      v-for="target in containerView.recoveryNavigationTargets"
                      :key="target.label"
                      type="button"
                      data-testid="hizofs-physical-inspector-recovery-navigation"
                      :disabled="!canInspect"
                      tw-class="rounded border border-amber-300 px-2 py-1 text-[10px] font-medium text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30"
                      @click="inspectAuthorityHomeTarget({ target })"
                    >
                      <span tw-class="block">Inspect {{ target.label }}</span>
                      <span data-testid="hizofs-physical-inspector-recovery-destination" tw-class="mt-0.5 block break-all font-mono text-[9px] font-normal opacity-80">{{ authorityHomeTargetSummary({ target }) }}</span>
                    </button>
                  </div>
                </div>
                <div tw-class="px-3 py-2.5">
                  <div tw-class="text-[10px] font-semibold uppercase text-gray-400">Root shortcut</div>
                  <div tw-class="mt-1 break-words font-mono text-xs">{{ containerView.rootDirectorySummary }}</div>
                  <div
                    v-if="containerView.rootRecoveryReason !== undefined"
                    data-testid="hizofs-physical-inspector-root-recovery-reason"
                    tw-class="mt-2 border-l-2 border-amber-300 pl-2 font-mono text-[9px] leading-4 text-amber-800 dark:border-amber-800 dark:text-amber-300"
                  >
                    <span tw-class="font-semibold uppercase tracking-wide">Active authority read failure</span>
                    <span tw-class="mt-0.5 block break-words">{{ containerView.rootRecoveryReason }}</span>
                  </div>
                  <div v-if="containerView.rootNavigationTargets.length > 0" tw-class="mt-2 flex flex-wrap gap-1">
                    <button
                      v-for="target in containerView.rootNavigationTargets"
                      :key="target.label"
                      type="button"
                      data-testid="hizofs-physical-inspector-root-navigation"
                      :disabled="!canInspect"
                      tw-class="rounded border border-emerald-300 px-2 py-1 text-[10px] font-medium text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                      @click="inspectAuthorityHomeTarget({ target })"
                    >
                      <span tw-class="block">Inspect {{ target.label }}</span>
                      <span data-testid="hizofs-physical-inspector-root-destination" tw-class="mt-0.5 block break-all font-mono text-[9px] font-normal opacity-80">{{ authorityHomeTargetSummary({ target }) }}</span>
                    </button>
                  </div>
                </div>
              </div>

              <div data-testid="hizofs-physical-inspector-authority-copies" tw-class="divide-y divide-gray-100 border-b border-gray-200 dark:divide-gray-800 dark:border-gray-700">
                <article
                  v-for="row in containerView.copyRows"
                  :key="`${row.kind}:${String(row.copy)}`"
                  data-testid="hizofs-physical-inspector-copy-row"
                  tw-class="px-3 py-3"
                >
                  <div tw-class="flex items-start gap-3">
                    <div tw-class="min-w-0 flex-1">
                      <div tw-class="flex flex-wrap items-center gap-1.5">
                        <span tw-class="font-mono text-[10px] font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-200">{{ row.kind }}</span>
                        <span tw-class="border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[9px] text-gray-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-400">copy {{ row.copy }}</span>
                        <span v-if="row.selected" tw-class="border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">selected</span>
                      </div>
                      <div tw-class="mt-1.5 grid grid-cols-[84px_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono text-[10px] leading-4">
                        <span tw-class="text-gray-400">state</span><span tw-class="break-words text-gray-700 dark:text-gray-300">{{ row.state }}</span>
                        <span tw-class="text-gray-400">sequence</span><span tw-class="break-words text-gray-700 dark:text-gray-300">{{ copySequence({ row }) }}</span>
                        <span tw-class="text-gray-400">path</span><span tw-class="break-all text-gray-700 dark:text-gray-300">{{ row.path }}</span>
                        <template v-if="row.reason !== undefined"><span tw-class="text-gray-400">reason</span><span tw-class="break-words text-red-600 dark:text-red-300">{{ row.reason }}</span></template>
                      </div>
                    </div>
                  </div>

                  <div data-testid="hizofs-physical-inspector-copy-details" tw-class="mt-3 border-t border-gray-100 pt-2.5 dark:border-gray-800">
                    <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-gray-400">Persisted fields</div>
                    <p tw-class="mt-1 break-words font-mono text-[10px] leading-4 text-gray-600 dark:text-gray-300">{{ copyDetails({ row }) }}</p>
                    <details
                      v-for="document in persistedDtoDocuments({ row })"
                      :key="document.label"
                      data-testid="hizofs-physical-inspector-persisted-dto"
                      tw-class="mt-2 border-t border-gray-100 pt-2 dark:border-gray-800"
                    >
                      <summary tw-class="cursor-pointer text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">{{ document.label }}</summary>
                      <pre tw-class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all border-l-2 border-emerald-200 pl-2 font-mono text-[10px] leading-4 text-gray-600 dark:border-emerald-900 dark:text-gray-300">{{ document.json }}</pre>
                    </details>
                  </div>
                </article>
              </div>

            </section>

            <section data-testid="hizofs-physical-inspector-segments-column" data-workbench-inspector-surface="segments" tw-class="h-full w-[440px] shrink-0 overflow-y-auto border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <header tw-class="border-b border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20">
                <div tw-class="text-xs font-semibold text-gray-800 dark:text-gray-200">Segments / frames</div>
                <div tw-class="font-mono text-[9px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">physical persisted records</div>
              </header>

              <div v-if="containerView.frameRowsTruncated" data-testid="hizofs-physical-inspector-frame-budget" tw-class="border-b border-blue-200 bg-blue-50 px-3 py-2 font-mono text-[10px] text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
                Showing {{ containerView.displayedFrameCount }} of {{ containerView.totalFrameCount }} observed frame rows.
              </div>

              <div tw-class="divide-y divide-gray-100 dark:divide-gray-800">
                <article v-for="segment in containerView.segmentRows" :key="segment.path" data-testid="hizofs-physical-inspector-segment" tw-class="px-3 py-2.5">
                  <div tw-class="flex items-start justify-between gap-3"><div tw-class="min-w-0"><div tw-class="truncate font-mono text-xs font-semibold">{{ segment.path }}</div><div tw-class="mt-1 text-[10px] text-gray-500">{{ segment.segmentClass }} · {{ segment.state }} · {{ segment.physicalSegmentId ?? 'unobserved ID' }} · {{ segment.fileSize ?? 'unobserved size' }} bytes</div></div><div tw-class="shrink-0 font-mono text-[10px] text-gray-500">{{ segment.frameCount }} frames<span v-if="segment.frameRowsTruncated"> · rows truncated</span></div></div>
                  <div v-if="segment.reason" tw-class="mt-2 break-words font-mono text-[10px] text-red-600 dark:text-red-300">{{ segment.reason }}</div>
                  <section data-testid="hizofs-physical-inspector-segment-structure" tw-class="mt-2 border-l-2 border-emerald-200 pl-2 dark:border-emerald-900">
                    <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Persisted Segment structure</div>
                    <dl tw-class="mt-1 grid grid-cols-[68px_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono text-[9px] leading-4">
                      <dt tw-class="text-gray-400">Header</dt><dd>{{ segment.header === undefined ? 'unavailable' : 'authenticated' }}</dd>
                      <dt tw-class="text-gray-400">Frames</dt><dd>{{ segment.frameCount }} authenticated Record Frame headers</dd>
                      <dt tw-class="text-gray-400">Footer</dt><dd>{{ segment.footerHeader === undefined ? 'not authenticated / not present' : `authenticated @${segment.footerPhysicalOffset}, ${segment.footerTotalLength} bytes, ${segment.footerIndexEntries?.length ?? 0} index entries` }}</dd>
                    </dl>
                    <details v-if="segment.header !== undefined" data-testid="hizofs-physical-inspector-segment-header" tw-class="mt-1 border-t border-gray-100 pt-1 dark:border-gray-800">
                      <summary tw-class="cursor-pointer font-mono text-[9px] text-emerald-700 dark:text-emerald-300">Exact Segment Header DTO</summary>
                      <pre tw-class="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] text-gray-600 dark:text-gray-300">{{ segment.headerJson }}</pre>
                    </details>
                    <details v-if="segment.footerHeader !== undefined" data-testid="hizofs-physical-inspector-segment-footer" tw-class="mt-1 border-t border-gray-100 pt-1 dark:border-gray-800">
                      <summary tw-class="cursor-pointer font-mono text-[9px] text-emerald-700 dark:text-emerald-300">Exact authenticated Segment Footer DTOs</summary>
                      <div tw-class="mt-1 font-mono text-[9px] text-gray-400">Header</div>
                      <pre tw-class="max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] text-gray-600 dark:text-gray-300">{{ segment.footerHeaderJson }}</pre>
                      <div tw-class="mt-1 font-mono text-[9px] text-gray-400">Decrypted authenticated index entries</div>
                      <pre data-testid="hizofs-physical-inspector-segment-footer-index" tw-class="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] text-gray-600 dark:text-gray-300">{{ segment.footerIndexEntriesJson }}</pre>
                      <div tw-class="mt-1 font-mono text-[9px] text-gray-400">Trailer</div>
                      <pre tw-class="max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] text-gray-600 dark:text-gray-300">{{ segment.footerTrailerJson }}</pre>
                    </details>
                  </section>
                  <div v-if="segment.frames.length > 0" tw-class="mt-3 max-h-44 overflow-y-auto border-y border-gray-100 dark:border-gray-800">
                    <button
                      v-for="frame in segment.frames"
                      :key="`${frame.physicalSegmentId}:${frame.physicalOffset}`"
                      type="button"
                      data-testid="hizofs-physical-inspector-frame"
                      :tw-class="['grid w-full grid-cols-[76px_64px_minmax(0,1fr)] items-center gap-2 border-b border-gray-100 px-2 py-1.5 text-left font-mono text-[9px] last:border-b-0 dark:border-gray-800', selectedFrame?.physicalSegmentId === frame.physicalSegmentId && selectedFrame?.physicalOffset === frame.physicalOffset ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300' : 'hover:bg-gray-50 dark:hover:bg-gray-800']"
                      @click="selectFrame({ frame })"
                    >
                      <span tw-class="truncate">@{{ frame.physicalOffset }}</span>
                      <span>kind {{ frame.recordKind }}</span>
                      <span tw-class="truncate text-gray-500 dark:text-gray-400">frame {{ frame.frameLength }} · plaintext {{ frame.plaintextLength }}</span>
                    </button>
                  </div>
                </article>
              </div>

              <section v-if="selectedFrame" data-testid="hizofs-physical-inspector-record-selection" tw-class="border-t border-gray-200 dark:border-gray-700">
                <div tw-class="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-950">Selected physical frame</div>
                <div tw-class="px-3 py-2.5">
                  <dl tw-class="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono text-[10px] leading-4">
                    <dt tw-class="text-gray-400">physical</dt><dd tw-class="break-all">{{ selectedFrame.physicalSegmentId }}:{{ selectedFrame.physicalOffset }}</dd>
                    <dt tw-class="text-gray-400">header home</dt><dd tw-class="break-all">{{ selectedFrame.homeSegmentId }}:{{ selectedFrame.homeOffset }}</dd>
                    <dt tw-class="text-gray-400">record kind</dt><dd>{{ selectedFrame.recordKind }}</dd>
                    <dt tw-class="text-gray-400">flags</dt><dd>{{ selectedFrame.flags }}</dd>
                    <dt tw-class="text-gray-400">frame length</dt><dd>{{ selectedFrame.frameLength }}</dd>
                    <dt tw-class="text-gray-400">plaintext</dt><dd>{{ selectedFrame.plaintextLength }} bytes</dd>
                    <dt tw-class="text-gray-400">home reference</dt>
                    <dd data-testid="hizofs-physical-inspector-selected-home-reference" tw-class="break-all">
                      {{ selectedFrame.homeReference === undefined ? 'unavailable (physical-only frame)' : recordReferenceSummary({ reference: selectedFrame.homeReference }) }}
                    </dd>
                  </dl>
                  <details data-testid="hizofs-physical-inspector-frame-header" tw-class="mt-2 border-t border-gray-100 pt-2 dark:border-gray-800">
                    <summary tw-class="cursor-pointer font-mono text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Exact Record Frame Header DTO</summary>
                    <pre tw-class="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] text-gray-600 dark:text-gray-300">{{ selectedFrame.headerJson }}</pre>
                  </details>
                  <label tw-class="mt-3 flex items-center gap-2 text-[10px] font-medium text-gray-600 dark:text-gray-300">
                    <span tw-class="shrink-0">Page role</span>
                    <select v-model="selectedPageRole" data-testid="hizofs-physical-inspector-page-role" tw-class="min-w-0 flex-1 border border-gray-300 bg-white px-2 py-1 font-mono text-[10px] dark:border-gray-600 dark:bg-gray-950">
                      <option value="unspecified">unspecified</option>
                      <option value="root">root</option>
                      <option value="non_root">non-root</option>
                    </select>
                  </label>
                  <button type="button" data-testid="hizofs-physical-inspector-read-record" :disabled="!canInspect" tw-class="mt-2 w-full bg-emerald-600 px-3 py-2 text-left text-[10px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50" @click="inspectSelectedRecord">
                    <LoaderCircleIcon v-if="loading === 'record'" tw-class="mr-1 inline h-3.5 w-3.5 animate-spin" />
                    Inspect selected frame
                  </button>
                  <button v-if="selectedFrame.homeReference" type="button" data-testid="hizofs-physical-inspector-read-home-record" :disabled="!canInspect" tw-class="mt-2 w-full border border-emerald-300 bg-white px-3 py-2 text-left text-[10px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:bg-gray-950 dark:text-emerald-300 dark:hover:bg-emerald-950/30" @click="inspectSelectedHomeRecord">
                    <LoaderCircleIcon v-if="loading === 'home_record'" tw-class="mr-1 inline h-3.5 w-3.5 animate-spin" />
                    Inspect logical Home Record
                  </button>
                </div>
              </section>

              <section v-if="containerView.physicalAnomalies.length > 0" tw-class="border-t border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30">
                <div tw-class="border-b border-amber-200 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-900 dark:text-amber-300">Physical anomalies</div>
                <ul tw-class="space-y-1 px-3 py-2.5 font-mono text-[10px] leading-4 text-amber-800 dark:text-amber-300">
                  <li v-for="anomaly in containerView.physicalAnomalies" :key="anomaly">{{ anomaly }}</li>
                </ul>
              </section>
            </section>
          </div>

          <section
            v-for="(namespaceColumn, namespaceColumnIndex) in namespaceViews"
            :key="`${namespaceColumn.commitSequence}:${namespaceColumn.path}`"
            :data-testid="namespaceColumnIndex === namespaceViews.length - 1 ? 'hizofs-physical-inspector-namespace' : 'hizofs-physical-inspector-namespace-ancestor'"
            :data-workbench-inspector-surface="namespaceColumnIndex === namespaceViews.length - 1 ? 'namespace' : undefined"
            :data-namespace-column-path="namespaceColumn.path"
            tw-class="h-full w-[440px] shrink-0 overflow-y-auto border-r border-blue-200 bg-white dark:border-blue-900 dark:bg-gray-900"
          >
            <form v-if="props.embeddedInWorkbench && namespaceColumnIndex === namespaceViews.length - 1" data-testid="hizofs-physical-inspector-path-toolbar" tw-class="flex items-end gap-2 border-b border-blue-100 px-3 py-2 dark:border-blue-900" @submit.prevent="inspectNamespace">
              <label tw-class="min-w-0 flex-1 text-[9px] font-medium text-gray-600 dark:text-gray-300">Jump to path<input v-model="namespacePath" data-testid="hizofs-physical-inspector-path" type="text" spellcheck="false" tw-class="mt-1 w-full min-w-0 border border-gray-300 bg-white px-2 py-1.5 font-mono text-[10px] dark:border-gray-600 dark:bg-gray-950" /></label>
              <button type="submit" data-testid="hizofs-physical-inspector-read-namespace" title="Inspect path" aria-label="Inspect path" :disabled="!canInspect" tw-class="shrink-0 border border-blue-300 p-1.5 text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"><LoaderCircleIcon v-if="loading === 'namespace'" tw-class="h-3.5 w-3.5 animate-spin" /><SearchIcon v-else tw-class="h-3.5 w-3.5" /></button>
            </form>
            <button type="button" data-testid="hizofs-physical-inspector-select-namespace-column" tw-class="block w-full border-b border-blue-200 bg-blue-50 px-3 py-2 text-left dark:border-blue-900 dark:bg-blue-950/20" @click="selectNamespaceColumn({ columnIndex: namespaceColumnIndex })"><span tw-class="block text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Derived namespace view</span><span tw-class="mt-0.5 block truncate font-mono text-[10px] text-gray-700 dark:text-gray-300">{{ namespaceColumn.path }}</span><span tw-class="mt-0.5 block font-mono text-[9px] text-gray-500 dark:text-gray-400">Authenticated reconstruction from persisted records</span></button>
            <div tw-class="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-3 py-2.5 dark:border-gray-800">
              <div>
                <div tw-class="flex flex-wrap items-center gap-2">
                  <h3 tw-class="text-sm font-semibold text-gray-900 dark:text-gray-100">Decrypted namespace {{ namespaceColumn.path }}</h3>
                </div>
                <p tw-class="mt-1 font-mono text-xs text-gray-500">{{ namespaceColumn.authoritySummary }}</p>
              </div>
              <div tw-class="font-mono text-xs text-gray-600 dark:text-gray-300">{{ namespaceColumn.inodeSummary }}</div>
            </div>
            <dl data-testid="hizofs-physical-inspector-inode-fields" tw-class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-gray-100 px-3 py-2.5 font-mono text-[10px] dark:border-gray-800">
              <dt tw-class="text-gray-400">Commit sequence</dt><dd>{{ namespaceColumn.commitSequence }}</dd>
              <dt tw-class="text-gray-400">Inode number</dt><dd>{{ namespaceColumn.inodeNumber }}</dd>
              <dt tw-class="text-gray-400">Inode revision</dt><dd>{{ namespaceColumn.inodeRevision }}</dd>
              <dt tw-class="text-gray-400">Inode kind</dt><dd>{{ namespaceColumn.inodeKind }}</dd>
              <dt tw-class="text-gray-400">Created at</dt><dd>{{ namespaceColumn.createdAt ?? 'unavailable' }}</dd>
              <dt tw-class="text-gray-400">Modified at</dt><dd>{{ namespaceColumn.modifiedAt ?? 'unavailable' }}</dd>
              <dt tw-class="text-gray-400">File size</dt><dd>{{ namespaceColumn.fileSize ?? 'unavailable' }}</dd>
            </dl>
            <div v-if="namespaceColumn.directorySummary" tw-class="border-b border-gray-100 px-3 py-2 text-xs text-gray-500 dark:border-gray-800">{{ namespaceColumn.directorySummary }}</div>
            <div v-if="namespaceColumn.symlinkTarget" tw-class="border-b border-gray-100 px-3 py-2.5 font-mono text-[10px] dark:border-gray-800">→ {{ namespaceColumn.symlinkTarget }}</div>
            <section v-if="namespaceColumn.directoryEntries.length > 0" tw-class="border-b border-gray-200 dark:border-gray-700">
              <div tw-class="border-b border-blue-100 bg-blue-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-300">Derived directory entries</div>
              <div tw-class="divide-y divide-gray-100 dark:divide-gray-800">
                <button
                  v-for="entry in namespaceColumn.directoryEntries"
                  :key="entry.name"
                  type="button"
                  data-testid="hizofs-physical-inspector-namespace-row"
                  tw-class="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-blue-50 dark:hover:bg-blue-950/20"
                  @click="navigateNamespacePath({ pathComponents: entry.pathComponents })"
                >
                  <span tw-class="min-w-0 flex-1">
                    <span data-testid="hizofs-physical-inspector-namespace-entry" tw-class="block truncate font-mono text-xs font-medium text-gray-800 dark:text-gray-200">{{ entry.name }}</span>
                    <span tw-class="mt-0.5 block break-words font-mono text-[9px] text-gray-400">{{ entry.kind }} · {{ entry.target }}</span>
                  </span>
                  <ChevronRightIcon tw-class="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-400" />
                </button>
              </div>
            </section>
          </section>

          <section v-if="namespaceView !== undefined" data-testid="hizofs-physical-inspector-validation-evidence" data-workbench-inspector-surface="validation-evidence" tw-class="h-full w-[440px] shrink-0 overflow-y-auto border-r border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-900">
            <div tw-class="border-b border-gray-300 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950">
              <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">Inspection validation evidence</div>
              <div tw-class="mt-0.5 truncate font-mono text-[9px] text-gray-500 dark:text-gray-400">Commit {{ namespaceView.commitSequence }} · requested path {{ namespaceView.path }}</div>
              <div tw-class="mt-0.5 font-mono text-[9px] text-amber-700 dark:text-amber-300">Runtime authenticated read activity · not persisted structure</div>
            </div>
            <dl data-testid="hizofs-physical-inspector-validation-summary" tw-class="grid grid-cols-[minmax(0,1fr)_max-content] gap-x-3 gap-y-1 border-b border-gray-200 px-3 py-2.5 font-mono text-[10px] dark:border-gray-700">
              <dt tw-class="text-gray-500">Total authenticated page-read events</dt><dd>{{ namespaceView.validationEvidence.totalPageReadEventCount }}</dd>
              <dt tw-class="text-gray-500">Recorded raw trace events</dt><dd>{{ namespaceView.validationEvidence.recordedPageReadEventCount }}</dd>
              <dt tw-class="text-gray-500">Unique Home Record References</dt><dd>{{ namespaceView.validationEvidence.uniqueHomeRecordReferences.length }}</dd>
              <dt tw-class="text-gray-500">Repeated events in recorded trace</dt><dd>{{ namespaceView.validationEvidence.repeatedPageReadEventCount }}</dd>
              <dt tw-class="text-gray-500">Trace bound</dt><dd>{{ namespaceView.validationEvidence.traceTruncated ? 'truncated' : 'complete' }}</dd>
            </dl>
            <details data-testid="hizofs-physical-inspector-validation-references" tw-class="border-b border-gray-200 dark:border-gray-700">
              <summary tw-class="cursor-pointer px-3 py-2 text-[10px] font-semibold text-gray-700 dark:text-gray-200">Unique Home Record References (recorded trace)</summary>
              <div tw-class="divide-y divide-gray-100 border-t border-gray-200 dark:divide-gray-800 dark:border-gray-700">
                <button v-for="reference in namespaceView.validationEvidence.uniqueHomeRecordReferences" :key="`${reference.request.homeSegmentId}:${reference.request.homeOffset}:${reference.request.frameLength}:${reference.request.recordKind}`" type="button" data-testid="hizofs-physical-inspector-validation-reference" :disabled="!canInspect" tw-class="block w-full px-3 py-2 text-left font-mono text-[9px] leading-4 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800" @click="inspectNamespaceValidationReference({ reference })">{{ namespaceValidationReferenceSummary({ reference }) }}</button>
              </div>
            </details>
            <details data-testid="hizofs-physical-inspector-validation-raw-trace" tw-class="border-b border-gray-200 dark:border-gray-700">
              <summary tw-class="cursor-pointer px-3 py-2 text-[10px] font-semibold text-gray-700 dark:text-gray-200">Raw page-read event trace</summary>
              <ol tw-class="divide-y divide-gray-100 border-t border-gray-200 dark:divide-gray-800 dark:border-gray-700">
                <li v-for="event in namespaceView.validationEvidence.rawPageReadEvents" :key="event.label" data-testid="hizofs-physical-inspector-validation-event" tw-class="break-all px-3 py-2 font-mono text-[9px] leading-4 text-gray-600 dark:text-gray-300">{{ namespaceValidationEventSummary({ event }) }}</li>
              </ol>
              <div v-if="namespaceView.validationEvidence.traceTruncated" tw-class="border-t border-amber-200 bg-amber-50 px-3 py-2 font-mono text-[9px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">Raw trace is bounded: {{ namespaceView.validationEvidence.recordedPageReadEventCount }} of {{ namespaceView.validationEvidence.totalPageReadEventCount }} events are shown.</div>
            </details>
          </section>

          <section v-if="recordTraversalColumns.length === 0" :data-workbench-inspector-surface="namespaceViews.length === 0 ? 'namespace' : 'reference-destination'" :tw-class="namespaceViews.length === 0 ? 'h-full w-[440px] shrink-0 border-r border-blue-200 bg-white dark:border-blue-900 dark:bg-gray-900' : 'h-full w-[440px] shrink-0 border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'">
            <div v-if="namespaceViews.length === 0" tw-class="border-b border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-900 dark:bg-blue-950/20">
              <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Logical traversal</div>
              <div tw-class="mt-0.5 font-mono text-[9px] text-gray-500 dark:text-gray-400">No logical path inspected</div>
            </div>
            <form v-if="props.embeddedInWorkbench && namespaceViews.length === 0" data-testid="hizofs-physical-inspector-path-toolbar" tw-class="flex items-end gap-2 border-b border-blue-100 px-3 py-2.5 dark:border-blue-900" @submit.prevent="inspectNamespace">
              <label tw-class="min-w-0 flex-1 text-[9px] font-medium text-gray-600 dark:text-gray-300">Jump to path<input v-model="namespacePath" data-testid="hizofs-physical-inspector-path" type="text" spellcheck="false" tw-class="mt-1 w-full min-w-0 border border-gray-300 bg-white px-2 py-1.5 font-mono text-[10px] dark:border-gray-600 dark:bg-gray-950" /></label>
              <button type="submit" data-testid="hizofs-physical-inspector-read-namespace" title="Inspect path" aria-label="Inspect path" :disabled="!canInspect" tw-class="shrink-0 border border-blue-300 p-1.5 text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"><LoaderCircleIcon v-if="loading === 'namespace'" tw-class="h-3.5 w-3.5 animate-spin" /><SearchIcon v-else tw-class="h-3.5 w-3.5" /></button>
            </form>
            <div v-if="namespaceViews.length > 0" tw-class="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
              <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-gray-500">Reference traversal</div>
              <div tw-class="mt-0.5 font-mono text-[9px] text-gray-400">No persisted record selected</div>
            </div>
            <div tw-class="px-3 py-3 text-xs leading-5 text-gray-500 dark:text-gray-400">{{ namespaceViews.length === 0 ? 'Select a directory entry to extend the column chain, or use the path jump to construct it from root.' : 'Select an authenticated page or record reference from a logical or physical column. The source columns remain to the left.' }}</div>
          </section>

          <section v-if="recordTraversalColumns.length > 0" data-testid="hizofs-physical-inspector-record-traversal" tw-class="flex h-full shrink-0">
            <div tw-class="flex h-full">
              <article
                v-for="(column, columnIndex) in recordTraversalColumns"
                :key="`${String(columnIndex)}:${column.view.identitySummary}`"
                data-testid="hizofs-physical-inspector-traversal-column"
                :data-workbench-traversal-column-index="columnIndex"
                tw-class="flex h-full w-[440px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
              >
                <header tw-class="flex shrink-0 items-center justify-between gap-3 border-b border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20">
                  <div tw-class="min-w-0">
                    <div tw-class="truncate text-xs font-semibold text-gray-800 dark:text-gray-200">{{ column.title }}</div>
                    <div tw-class="font-mono text-[9px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">authenticated persisted record</div>
                  </div>
                  <button
                    type="button"
                    data-testid="hizofs-physical-inspector-close-traversal-column"
                    aria-label="Close this record column and columns to the right"
                    tw-class="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                    @click="closeRecordTraversalColumn({ columnIndex })"
                  ><XIcon tw-class="h-3.5 w-3.5" /></button>
                </header>
                <div
                  :data-testid="columnIndex === recordTraversalColumns.length - 1 ? 'hizofs-physical-inspector-record' : undefined"
                  tw-class="min-h-0 flex-1 overflow-y-auto"
                >
                  <section tw-class="border-b border-gray-100 dark:border-gray-800">
                    <div tw-class="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-950">Overview</div>
                    <div tw-class="p-3">
                      <div tw-class="font-mono text-xs font-semibold text-gray-900 dark:text-gray-100">{{ column.view.recordKindName }} ({{ column.view.recordKind }})</div>
                      <div tw-class="mt-2 break-words font-mono text-[10px] text-gray-500">{{ column.view.identitySummary }}</div>
                      <div tw-class="mt-2 text-xs text-gray-700 dark:text-gray-300">{{ column.view.payloadSummary }}</div>
                      <div tw-class="mt-1 font-mono text-[10px] text-gray-400">{{ column.view.plaintextSummary }}</div>
                    </div>
                  </section>
                  <dl
                    :data-testid="columnIndex === recordTraversalColumns.length - 1 ? 'hizofs-physical-inspector-record-fields' : undefined"
                    tw-class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-gray-100 px-3 py-2.5 font-mono text-[10px] dark:border-gray-800"
                  >
                    <dt tw-class="text-gray-400">Frame length</dt><dd>{{ column.view.frameLength }}</dd>
                    <dt tw-class="text-gray-400">Sealed length</dt><dd>{{ column.view.sealedLength }}</dd>
                    <dt tw-class="text-gray-400">Header flags</dt><dd>{{ column.view.headerFlags }}</dd>
                    <dt tw-class="text-gray-400">Plaintext length</dt><dd>{{ column.view.plaintextByteLength }}</dd>
                    <dt tw-class="text-gray-400">Preview length</dt><dd>{{ column.view.plaintextPreviewByteLength }}</dd>
                    <dt tw-class="text-gray-400">Preview truncated</dt><dd>{{ column.view.plaintextPreviewTruncated }}</dd>
                  </dl>
                  <details data-testid="hizofs-physical-inspector-record-header" tw-class="border-b border-gray-100 px-3 py-2.5 dark:border-gray-800">
                    <summary tw-class="cursor-pointer text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Exact authenticated Record Frame Header DTO</summary>
                    <pre tw-class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all border-l-2 border-emerald-200 pl-2 font-mono text-[10px] leading-4 text-gray-600 dark:border-emerald-900 dark:text-gray-300">{{ column.view.headerJson }}</pre>
                  </details>
                  <section data-testid="hizofs-physical-inspector-record-references" tw-class="border-b border-gray-200 dark:border-gray-700">
                    <div tw-class="border-b border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">Persisted references</div>
                    <div v-if="column.namespaceObservation !== undefined" data-testid="hizofs-physical-inspector-record-logical-context" tw-class="border-b border-emerald-100 p-3 dark:border-emerald-950/50">
                      <div tw-class="font-mono text-[9px] text-gray-400">Observed while resolving {{ column.namespaceObservation.authorityMode }} logical {{ column.namespaceObservation.path }} at Commit {{ column.namespaceObservation.commitSequence }} · observation context, not ownership</div>
                      <button
                        type="button"
                        data-testid="hizofs-physical-inspector-return-logical-context"
                        tw-class="mt-2 border border-blue-300 px-2 py-1.5 text-left text-[10px] font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"
                        @click="returnToNamespaceObservation({ observation: column.namespaceObservation })"
                      >
                        Return to logical {{ column.namespaceObservation.path }}
                      </button>
                    </div>
                    <div v-if="column.view.navigationTargets.length > 0" tw-class="space-y-1 p-3">
                      <button
                        v-for="target in column.view.navigationTargets"
                        :key="navigationTargetKey({ target })"
                        type="button"
                        :data-testid="navigationTargetTestId({ target })"
                        :disabled="!canInspect"
                        tw-class="block w-full border border-emerald-300 px-2 py-1.5 text-left text-[10px] font-medium text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                        @click="inspectNavigationTarget({ sourceColumnIndex: columnIndex, target })"
                      >
                        <span tw-class="block">{{ target.label }} →</span>
                        <span data-testid="hizofs-physical-inspector-reference-destination" tw-class="mt-0.5 block break-all font-mono text-[9px] font-normal text-emerald-600/80 dark:text-emerald-400/80">{{ navigationTargetDestinationSummary({ target }) }}</span>
                      </button>
                    </div>
                    <div v-else tw-class="px-3 py-3 font-mono text-[10px] text-gray-400">No outgoing persisted reference is exposed by this decoded record.</div>
                  </section><section tw-class="border-b border-gray-200 dark:border-gray-700">
                    <div tw-class="flex min-h-8 items-center gap-2 border-b border-gray-200 bg-emerald-50 px-3 py-1.5 dark:border-gray-700 dark:bg-emerald-950/20">
                      <div
                        :data-testid="columnIndex === recordTraversalColumns.length - 1 ? 'hizofs-physical-inspector-record-payload-label' : undefined"
                        tw-class="min-w-0 flex-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
                      >Exact decoded representation · {{ column.view.payloadDocumentLabel }}</div>
                      <span
                        aria-live="polite"
                        :data-testid="payloadCopyFeedback?.columnIndex === columnIndex ? 'hizofs-physical-inspector-record-payload-copy-status' : undefined"
                        :title="payloadCopyFeedback?.columnIndex === columnIndex ? payloadCopyFeedback.detail : undefined"
                        tw-class="w-16 shrink-0 truncate text-right font-mono text-[9px] text-gray-500 dark:text-gray-400"
                      >{{ payloadCopyFeedback?.columnIndex === columnIndex ? payloadCopyFeedback.status === 'success' ? 'Copied' : 'Copy failed' : '' }}</span>
                      <button
                        type="button"
                        aria-label="Copy exact decoded payload JSON"
                        data-testid="hizofs-physical-inspector-copy-record-payload"
                        title="Copy exact decoded payload JSON"
                        tw-class="shrink-0 rounded p-1 text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-950/50"
                        @click="copyDecodedPayload({ columnIndex, payloadJson: column.view.payloadJson })"
                      ><CopyIcon tw-class="h-3.5 w-3.5" /></button>
                    </div>
                    <JsonCodeView
                      :data-testid="columnIndex === recordTraversalColumns.length - 1 ? 'hizofs-physical-inspector-record-payload' : undefined"
                      :source="column.view.payloadJson"
                      display-mode="raw"
                      height-mode="content"
                      overflow-mode="wrap"
                      tw-class="max-h-80 overflow-auto"
                    />
                  </section>
                  <section data-testid="hizofs-physical-inspector-record-plaintext-preview" tw-class="border-b border-gray-200 dark:border-gray-700">
                    <div tw-class="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-950">Authenticated plaintext preview</div>
                    <div tw-class="px-3 py-2">
                      <div tw-class="font-mono text-[9px] text-gray-400">Base64URL · {{ column.view.plaintextPreviewByteLength }} / {{ column.view.plaintextByteLength }} bytes<span v-if="column.view.plaintextPreviewTruncated"> · truncated</span></div>
                      <pre tw-class="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-gray-700 dark:text-gray-300">{{ column.view.plaintextPreviewBase64Url === '' ? '(empty)' : column.view.plaintextPreviewBase64Url }}</pre>
                    </div>
                  </section>
                  <section data-testid="hizofs-physical-inspector-record-binary-shell" tw-class="border-b border-gray-200 dark:border-gray-700">
                    <div tw-class="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-950">Binary representation</div>
                    <div v-if="column.framedBinary !== undefined" tw-class="px-3 py-2 text-[10px] leading-5 text-gray-500 dark:text-gray-400">
                      <div tw-class="break-all font-mono text-[9px] text-gray-400">Authenticated full Record Frame · physical {{ column.framedBinary.physicalSegmentId }}:{{ column.framedBinary.physicalOffset }} · {{ column.framedBinary.frameByteLength }} bytes · Base64URL</div>
                      <pre data-testid="hizofs-physical-inspector-record-framed-binary" tw-class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-gray-700 dark:text-gray-300">{{ column.framedBinary.frameBase64Url }}</pre>
                    </div>
                    <div v-else tw-class="px-3 py-2 text-[10px] leading-5 text-gray-500 dark:text-gray-400">
                      <p>Load the exact persisted Record Frame through a fresh authenticated read of this Physical Record Reference.</p>
                      <button type="button" data-testid="hizofs-physical-inspector-load-framed-binary" :disabled="!canInspect" tw-class="mt-2 border border-gray-300 px-2 py-1 font-mono text-[9px] hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800" @click="loadRecordFrame({ columnIndex })">
                        <LoaderCircleIcon v-if="loading === 'frame'" tw-class="mr-1 inline h-3 w-3 animate-spin" />Load authenticated framed binary
                      </button>
                    </div>
                  </section>

                </div>
              </article>
            </div>
          </section>

        </div>
      </div>
    </section>
  </div>
</template>
