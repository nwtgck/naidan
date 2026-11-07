import { clonePlainData } from '@/utils/clone-plain-data';
import { shareWorkflowStructure } from '@/features/workflow/logic/sharing';
import { workflowResultSources, type WorkflowResultSource } from '@/features/workflow/logic/result-view';
import { createWorkflowModelTools } from '@/features/workflow/logic/model-tools';
import type { PreviewFrame } from '@/features/stable-diffusion-cpp-browser/types';
import { executeWorkflowTool, type WorkflowToolAuthorization, type WorkflowToolExecutor } from '@/features/workflow/logic/tool-execution';
import { generateWorkflowImage } from '@/features/workflow/logic/image-generation';
import { createWorkflowImagePermissions } from '@/features/workflow/logic/image-permissions';
import type { createWorkflowImageProvider } from '@/features/workflow/providers/local-image';
import { computed, ref, shallowRef, toRaw } from 'vue';
import type { WorkflowDefinition, WorkflowStep, WorkflowDocument, WorkflowRunEntry, WorkflowExecutionLimits, WorkflowModelConfiguration } from '@/01-models/workflow';
import { idToRaw, type WorkflowId, type WorkflowStepId, type WorkflowRunId } from '@/01-models/ids';
import type { Volume, BrowserImageModelSelection } from '@/01-models/types';
import { cloneEndpoint, areEndpointsEqual } from '@/01-models/endpoint';
import { useSettings } from '@/composables/useSettings';
import { useConfirm } from '@/composables/useConfirm';
import { usePrompt } from '@/composables/usePrompt';
import { storageService } from '@/00-storage/service';
import { createWorkflowRunStore, type WorkflowRunSnapshot, type WorkflowRunListing } from '@/00-storage/service/workflow-run';
import { workflowResultsPath } from '@/features/workflow/logic/history-results';
import { createWorkflowDocumentStore, type WorkflowSnapshot, type WorkflowDocumentListing } from '@/00-storage/service/workflow-document';
import { parseWorkflowDefinition, formatWorkflowDefinition, applyWorkflowStepJson, parseWorkflowJson } from '@/00-storage/service/workflow-json';
import { createWorkflowHistory, findWorkflowStep, newWorkflowStep, replaceWorkflowStep, insertWorkflowSteps, moveWorkflowStep, removeWorkflowSteps, selectedWorkflowSteps, type WorkflowDropTarget } from '@/features/workflow/logic/editor';
import { editWorkflowGraph, type WorkflowGraphEdit } from '@/features/workflow/logic/graph';
import { copyWorkflowSteps, validateWorkflow } from '@/features/workflow/logic/definition';
import { executeWorkflow, type WorkflowRunResult, type WorkflowOutputs } from '@/features/workflow/logic/runtime';
import { createWorkflowOutputStore, type WorkflowOutputStore } from '@/features/workflow/logic/output-store';
import { resolveWorkflowExecutionLimits } from '@/features/workflow/logic/execution-control';
import { createWorkflowModelPermissions, type WorkflowConnectionReview } from '@/features/workflow/logic/model-permissions';
import { prepareWorkflowProvider } from '@/features/workflow/logic/provider-preparation';
import { generateWorkflowAudio } from '@/features/workflow/logic/audio-generation';
import { normalizeReferenceAudio } from '@/features/audio-generation/reference-audio';
import { defaultAudioLanguage } from '@/features/audio-generation/languages';
import { generateWorkflowText } from '@/features/workflow/logic/generation';
import { textChunks, WorkflowTextDecodingError } from '@/features/workflow/logic/values';
import { loadLmProvider } from '@/features/lm/providerFactory';
import { getOPFSTmpManager } from '@/logic/opfs-tmp-manager';
import { createWorkflowFileServices, exportWorkflowResults, zipWorkflowFolder, clearWorkflowStagingDirectory, type WorkflowWrittenFile } from '@/features/workflow/logic/files';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { downloadBlob, downloadFile } from '@/utils/stream-download';
import { createWorkflowInputDrafts } from './input-drafts';
import { volumeAccessToWeshMount } from '@/features/wesh/volume-mount';
import { ensureStrings, currentLocale } from '@/strings';

type RunState = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
type PendingInput = { token: number, title: string, prompt: string, kind: 'text' | 'json' | 'approval', choices?: string[], connection: WorkflowConnectionReview | undefined };
type LogEntry = WorkflowRunEntry;
let singleton: ReturnType<typeof createWorkspace> | undefined;

function createWorkspace() {
  const modelPermissions = createWorkflowModelPermissions();
  // Audio authority is distinct from text authority even for the same local model.
  const audioPermissions = createWorkflowModelPermissions();
  const imagePermissions = createWorkflowImagePermissions();
  function resetModelReviews(): void {
    modelPermissions.reset();
    audioPermissions.reset();
    imagePermissions.reset();
  }
  function reviewImageModel({ selection }: { selection: BrowserImageModelSelection }): void {
    if (!editingLocked.value) {
      imagePermissions.review({ target: selection });
    }
  }
  function reviewAudioModel({ modelId }: { modelId: string }): void {
    if (!editingLocked.value) {
      audioPermissions.review({ target: { endpoint: { type: 'llama_cpp_browser' }, modelId } });
    }
  }
  function reviewModel({ target }: { target: WorkflowModelConfiguration }): void {
    // Editing just a model ID must not bless an imported endpoint or hidden
    // headers. Only an exact connection already configured in Settings may be
    // selected here without a first-run review. Custom connections use ask().
    if (!editingLocked.value && areEndpointsEqual({ left: target.endpoint, right: settings.value.endpoint })) {
      modelPermissions.review({ target });
    }
  }
  function forgetModelReviews(): void {
    if (!running.value) {
      resetModelReviews();
    }
  }

  const { settings } = useSettings();
  const { showConfirm } = useConfirm();
  const { showPrompt } = usePrompt();
  const definition = shallowRef<WorkflowDefinition>({ name: '', steps: [] });
  const saved = shallowRef<WorkflowSnapshot>();
  const savedDefinition = ref(formatWorkflowDefinition({ definition: definition.value }));
  const kind = ref<WorkflowDocument['kind']>('workflow');
  const library = shallowRef<WorkflowDocumentListing>({ items: [], unreadable: [] });
  const volumes = shallowRef<Volume[]>([]);
  const selectedIds = shallowRef(new Set<WorkflowStepId>());
  const selectedId = shallowRef<WorkflowStepId>();
  const mode = ref<'steps' | 'json' | 'graph'>('steps');
  const jsonDraft = ref('');
  const partialDraft = ref('');
  const partialOpen = ref(false);
  const partialBase = ref('');
  const error = ref('');
  const busy = ref(false);
  const dialogOpen = ref(false);
  const inlineDrafts = createWorkflowInputDrafts();
  const history = createWorkflowHistory();
  const historyState = ref(history.getState());
  const runState = ref<RunState>('idle');
  const log = shallowRef<LogEntry[]>([]);
  const runs = shallowRef<WorkflowRunListing>({ items: [], unreadable: [] });
  const activeRunId = shallowRef<WorkflowRunId>();
  const historyError = ref('');
  const finalizing = ref(false);
  const historySavePending = ref(false);
  let historyRequest = 0;
  let retainedExport = false;
  let pendingHistorySave: (() => Promise<WorkflowRunSnapshot>) | undefined;
  let pendingHistoryRelease: (() => Promise<void>) | undefined;
  const pending = shallowRef<PendingInput>();
  const imagePreview = shallowRef<PreviewFrame>();
  let serial = 0, editing = 0;
  let answer: (({ token, text }: { token: number, text: string }) => void) | undefined;
  let controller: AbortController | undefined;
  let result: WorkflowRunResult | undefined;
  let outputStore: WorkflowOutputStore | undefined;
  let exportDirectory: FileSystemDirectoryHandle | undefined;
  const hasResults = ref(false);
  const resultSources = shallowRef<WorkflowResultSource[]>([]);
  const writtenFiles = shallowRef<WorkflowWrittenFile[]>([]);
  let zipCache: { file: File, directory: FileSystemDirectoryHandle } | undefined;
  const selected = computed(() => selectedId.value === undefined ? undefined : findWorkflowStep({ steps: definition.value.steps, id: selectedId.value }));
  const encoded = computed(() => formatWorkflowDefinition({ definition: definition.value }));
  const draftDirty = computed(() => inlineDrafts.dirty.value || (mode.value === 'json' && jsonDraft.value !== encoded.value) || (partialOpen.value && partialDraft.value !== partialBase.value));
  const dirty = computed(() => encoded.value !== savedDefinition.value || draftDirty.value);
  const issues = computed(() => validateWorkflow({ definition: definition.value }));
  const executable = computed(() => kind.value === 'workflow' && !draftDirty.value && issues.value.length === 0);
  const canSave = computed(() => settings.value.storageType === 'opfs' && typeof navigator !== 'undefined' && !!navigator.locks);
  const editingLocked = computed(() => busy.value || dialogOpen.value || mode.value === 'json' || partialOpen.value);
  const navigationLocked = computed(() => editingLocked.value || inlineDrafts.dirty.value);
  const running = computed(() => runState.value === 'running' || finalizing.value);

  async function confirmDialog({ options }: { options: Parameters<typeof showConfirm>[0] }): Promise<boolean> {
    if (busy.value || dialogOpen.value) {
      return false;
    }
    dialogOpen.value = true;
    try {
      return await showConfirm(options);
    } finally {
      dialogOpen.value = false;
    }
  }
  async function promptDialog({ options }: { options: Parameters<typeof showPrompt>[0] }): Promise<string | null> {
    if (busy.value || dialogOpen.value) {
      return null;
    }
    dialogOpen.value = true;
    try {
      return await showPrompt(options);
    } finally {
      dialogOpen.value = false;
    }
  }
  function setError({ reason }: { reason: unknown }): void {
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
  async function attempt({ action }: { action: () => Promise<void> }): Promise<void> {
    if (busy.value || dialogOpen.value) {
      return;
    }
    busy.value = true;
    error.value = '';
    try {
      await action();
    } catch (reason) {
      setError({ reason });
    } finally {
      busy.value = false;
    }
  }
  function commit({ next }: { next: WorkflowDefinition }): void {
    // Parse the editable schema before changing either view. Metadata never enters this projection.
    const normalized = parseWorkflowDefinition({ text: formatWorkflowDefinition({ definition: next }) });
    history.push({ definition: definition.value });
    definition.value = normalized;
    editing++;
    historyState.value = history.getState();
    error.value = '';
  }
  function updateExecutionLimits({ limits }: { limits: WorkflowExecutionLimits | undefined }): void {
    if (!editingLocked.value) {
      tryCommit({ next: { ...definition.value, executionLimits: limits } });
    }
  }
  function tryCommit({ next }: { next: WorkflowDefinition }): void {
    try {
      commit({ next });
    } catch (reason) {
      setError({ reason });
    }
  }
  function select({ id, multiple }: { id: WorkflowStepId, multiple: boolean }): void {
    if (navigationLocked.value) {
      return;
    }
    selectedId.value = id;
    const ids = multiple ? new Set(selectedIds.value) : new Set<WorkflowStepId>();
    if (multiple && ids.has(id)) {
      ids.delete(id);
    } else {
      ids.add(id);
    }
    selectedIds.value = ids;
  }
  async function confirmDiscard(): Promise<boolean> {
    if (!dirty.value) {
      return true;
    }
    const observed = editing;
    const inline = inlineDrafts.checkpoint();
    const json = jsonDraft.value, partial = partialDraft.value;
    const accepted = await confirmDialog({ options: { message: await ensureStrings.workflow__confirm_discard(), confirmButtonText: await ensureStrings.workflow__discard() } });
    return accepted && inlineDrafts.unchanged({ snapshot: inline }) && editing === observed && json === jsonDraft.value && partial === partialDraft.value;
  }
  function adopt({ next, snapshot, documentKind }: { next: WorkflowDefinition, snapshot: WorkflowSnapshot | undefined, documentKind: WorkflowDocument['kind'] }): void {
    resetModelReviews();
    inlineDrafts.discardAll();
    definition.value = next;
    saved.value = snapshot;
    kind.value = documentKind;
    savedDefinition.value = snapshot ? formatWorkflowDefinition({ definition: snapshot.document.definition }) : '';
    selectedId.value = next.steps[0]?.id;
    selectedIds.value = new Set();
    mode.value = 'steps';
    partialOpen.value = false;
    jsonDraft.value = '';
    history.clear();
    historyState.value = history.getState();
    editing++;
  }
  async function refreshRuns(): Promise<void> {
    const request = ++historyRequest;
    if (!canSave.value || typeof navigator.locks?.request !== 'function') {
      runs.value = { items: [], unreadable: [] };
      return;
    }
    try {
      const listing = await createWorkflowRunStore({ storageType: storageService.getCurrentType() }).list();
      if (request === historyRequest) {
        runs.value = listing;
      }
    } catch (reason) {
      if (request === historyRequest) {
        historyError.value = reason instanceof Error ? reason.message : String(reason);
      }
    }
  }
  async function discardHistorySave(): Promise<void> {
    const save = pendingHistorySave, release = pendingHistoryRelease;
    if (!save || !release || finalizing.value || !await confirmDialog({
      options: {
        message: await ensureStrings.workflow__continue_without_history_save(),
        confirmButtonVariant: 'danger',
      },
    }) || pendingHistorySave !== save || finalizing.value) {
      return;
    }
    finalizing.value = true;
    try {
      // A failed terminal write still owns the run. Only an explicit discard
      // makes its last durable checkpoint eligible for abandoned-run recovery.
      await release();
      pendingHistorySave = undefined;
      pendingHistoryRelease = undefined;
      historySavePending.value = false;
      historyError.value = '';
    } catch (reason) {
      historyError.value = reason instanceof Error ? reason.message : String(reason);
    } finally {
      finalizing.value = false;
    }
  }
  async function retryHistorySave(): Promise<void> {
    if (!pendingHistorySave || finalizing.value || dialogOpen.value) {
      return;
    }
    finalizing.value = true;
    try {
      await pendingHistorySave();
      pendingHistorySave = undefined;
      pendingHistoryRelease = undefined;
      historySavePending.value = false;
      historyError.value = '';
      await refreshRuns();
    } catch (reason) {
      historyError.value = reason instanceof Error ? reason.message : String(reason);
    } finally {
      finalizing.value = false;
    }
  }
  function adoptDocument({ snapshot }: { snapshot: WorkflowSnapshot }): void {
    adopt({ next: snapshot.document.definition, snapshot, documentKind: snapshot.document.kind });
  }
  async function copyRun({ snapshot, canApply }: { snapshot: WorkflowRunSnapshot, canApply: () => boolean }): Promise<boolean> {
    if (busy.value || dialogOpen.value || !await confirmDiscard() || !canApply()) {
      return false;
    }
    // Copying history creates an unsaved document. It never edits the historical
    // definition, restores approval state, or starts model/file side effects.
    adopt({ next: { ...clonePlainData({ value: snapshot.record.definition }), steps: copyWorkflowSteps({ steps: snapshot.record.definition.steps }) }, snapshot: undefined, documentKind: 'workflow' });
    return true;
  }
  async function refresh(): Promise<void> {
    await attempt({
      action: async () => {
        library.value = canSave.value ? await createWorkflowDocumentStore({ storageType: storageService.getCurrentType() }).list() : { items: [], unreadable: [] };
        const found: Volume[] = [];
        for await (const volume of storageService.listVolumes()) {
          found.push(volume);
        }
        volumes.value = found;
        await refreshRuns();
      },
    });
  }
  async function create({ documentKind }: { documentKind: WorkflowDocument['kind'] }): Promise<void> {
    if (busy.value || dialogOpen.value || !await confirmDiscard()) {
      return;
    }
    adopt({ next: { name: await ensureStrings.workflow__untitled(), steps: [] }, snapshot: undefined, documentKind });
  }
  async function open({ id }: { id: WorkflowId }): Promise<void> {
    if (busy.value || dialogOpen.value || !await confirmDiscard()) {
      return;
    }
    await attempt({
      action: async () => {
        const snapshot = await createWorkflowDocumentStore({ storageType: storageService.getCurrentType() }).load({ id });
        adopt({ next: snapshot.document.definition, snapshot, documentKind: snapshot.document.kind });
      },
    });
  }
  async function save({ copy }: { copy: boolean }): Promise<void> {
    if (!canSave.value || draftDirty.value) {
      return;
    }
    await attempt({
      action: async () => {
        const observed = editing;
        const store = createWorkflowDocumentStore({ storageType: storageService.getCurrentType() });
        const snapshot = await store.save({ previous: copy ? undefined : saved.value, definition: definition.value, kind: kind.value });
        saved.value = snapshot;
        savedDefinition.value = formatWorkflowDefinition({ definition: snapshot.document.definition });
        if (editing === observed) {
          definition.value = snapshot.document.definition;
        }
        library.value = await store.list();
      },
    });
  }
  async function remove(): Promise<void> {
    const previous = saved.value;
    if (!previous || busy.value || !await confirmDialog({ options: { message: await ensureStrings.workflow__confirm_delete(), confirmButtonVariant: 'danger' } })) {
      return;
    }
    if (saved.value !== previous) {
      return;
    }
    await attempt({
      action: async () => {
        const store = createWorkflowDocumentStore({ storageType: storageService.getCurrentType() });
        await store.remove({ previous });
        adopt({ next: { name: await ensureStrings.workflow__untitled(), steps: [] }, snapshot: undefined, documentKind: 'workflow' });
        library.value = await store.list();
      },
    });
  }
  function defaults() {
    return { endpoint: cloneEndpoint({ endpoint: settings.value.endpoint }), modelId: settings.value.defaultModelId ?? '', lmParameters: structuredClone(toRaw(settings.value.lmParameters)) };
  }
  function add({ type, name, target }: { type: WorkflowStep['type'], name: string, target: WorkflowDropTarget }): void {
    if (navigationLocked.value) {
      return;
    }
    const configuration = defaults();
    const step = newWorkflowStep({ type, name, ...configuration });
    switch (step.type) {
    case 'audio_generation': step.parameters.language = { type: 'literal', value: defaultAudioLanguage({ locale: currentLocale.value }) };
      break;
    case 'tool_call': case 'image_generation': case 'value': case 'model_selection': case 'parse_json': case 'text_generation': case 'request_input': case 'repeat': case 'for_each': case 'if': case 'read_file': case 'write_file': break;
    default: {
      const exhaustive: never = step;
      throw new Error(String(exhaustive));
    }
    }
    try {
      commit({ next: insertWorkflowSteps({ definition: definition.value, steps: [step], target }) });
      if (type === 'text_generation' || type === 'model_selection') {
        reviewModel({ target: configuration });
      }
      select({ id: step.id, multiple: false });
    } catch (reason) {
      setError({ reason });
    }
  }

  function updateStep({ step }: { step: WorkflowStep }): void {
    if (!editingLocked.value) {
      tryCommit({ next: replaceWorkflowStep({ definition: definition.value, step }) });
    }
  }
  function updateName({ name }: { name: string }): void {
    if (!navigationLocked.value) {
      tryCommit({ next: { ...definition.value, name } });
    }
  }
  function move({ id, target }: { id: WorkflowStepId, target: WorkflowDropTarget }): void {
    if (navigationLocked.value) {
      return;
    }
    try {
      commit({ next: moveWorkflowStep({ definition: definition.value, id, target }) });
    } catch (reason) {
      setError({ reason });
    }
  }
  function editGraph({ definition: expectedDefinition, edit }: { definition: WorkflowDefinition, edit: WorkflowGraphEdit }): void {
    // A late drop or selection from another document must not mutate this one.
    if (navigationLocked.value || expectedDefinition !== definition.value) {
      return;
    }
    try {
      const next = editWorkflowGraph({ definition: definition.value, edit });
      if (formatWorkflowDefinition({ definition: next }) !== formatWorkflowDefinition({ definition: definition.value })) {
        commit({ next });
      }
    } catch (reason) {
      setError({ reason });
    }
  }
  function deleteSteps(): void {
    if (!navigationLocked.value) {
      tryCommit({ next: removeWorkflowSteps({ definition: definition.value, ids: selectedIds.value }) });
    }
  }
  function duplicate(): void {
    if (navigationLocked.value) {
      return;
    }
    tryCommit({ next: insertWorkflowSteps({ definition: definition.value, steps: selectedWorkflowSteps({ definition: definition.value, ids: selectedIds.value }), target: { parentId: undefined, branch: 'root', index: definition.value.steps.length } }) });
  }
  async function savePart(): Promise<void> {
    if (navigationLocked.value || !canSave.value || !selectedIds.value.size) {
      return;
    }
    const selected = selectedWorkflowSteps({ definition: definition.value, ids: selectedIds.value });
    const name = await promptDialog({ options: { title: await ensureStrings.workflow__save_as_part(), defaultValue: definition.value.name } });
    if (typeof name !== 'string' || !name.trim()) {
      return;
    }
    await attempt({
      action: async () => {
        const store = createWorkflowDocumentStore({ storageType: storageService.getCurrentType() });
        await store.save({ previous: undefined, definition: { name, steps: selected }, kind: 'part' });
        library.value = await store.list();
      },
    });
  }
  async function insertPart({ id, target }: { id: WorkflowId, target: WorkflowDropTarget }): Promise<void> {
    if (navigationLocked.value) {
      return;
    }
    await attempt({
      action: async () => {
        const part = await createWorkflowDocumentStore({ storageType: storageService.getCurrentType() }).load({ id });
        switch (part.document.kind) {
        case 'part': break;
        case 'workflow': throw new Error('Select a reusable part.');
        default: {
          const exhaustive: never = part.document.kind;
          throw new Error(`Unknown document kind: ${exhaustive}`);
        }
        }
        commit({ next: insertWorkflowSteps({ definition: definition.value, steps: copyWorkflowSteps({ steps: part.document.definition.steps }), target }) });
      },
    });
  }
  function travel({ direction }: { direction: 'undo' | 'redo' }): void {
    if (navigationLocked.value) {
      return;
    }
    const next = history[direction]({ current: definition.value });
    if (next) {
      definition.value = next;
      editing++;
    }
    historyState.value = history.getState();
  }
  async function confirmInlineExit(): Promise<boolean> {
    if (!inlineDrafts.dirty.value) {
      return true;
    }
    const snapshot = inlineDrafts.checkpoint();
    const accepted = await confirmDialog({ options: { message: await ensureStrings.workflow__confirm_discard() } });
    if (!accepted || !inlineDrafts.unchanged({ snapshot })) {
      return false;
    }
    inlineDrafts.discardAll();
    return true;
  }
  async function changeMode({ next }: { next: 'steps' | 'json' | 'graph' }): Promise<void> {
    if (busy.value || dialogOpen.value || next === mode.value) {
      return;
    }
    if (draftDirty.value) {
      const observed = editing, json = jsonDraft.value, partial = partialDraft.value, inline = inlineDrafts.checkpoint();
      if (!await confirmDialog({ options: { message: await ensureStrings.workflow__confirm_discard() } }) || observed !== editing || json !== jsonDraft.value || partial !== partialDraft.value || !inlineDrafts.unchanged({ snapshot: inline })) {
        return;
      }
    }
    inlineDrafts.discardAll();
    partialOpen.value = false;
    mode.value = next;
    jsonDraft.value = encoded.value;
  }
  function applyJson(): void {
    try {
      commit({ next: parseWorkflowDefinition({ text: jsonDraft.value }) });
      jsonDraft.value = encoded.value;
      resetModelReviews();
    } catch (reason) {
      setError({ reason });
    }
  }
  function openPartial(): void {
    if (!selected.value || navigationLocked.value) {
      return;
    }
    partialOpen.value = true;
    partialDraft.value = '{}';
    partialBase.value = '{}';
  }
  function closePartial(): void {
    partialOpen.value = false;
    partialDraft.value = '';
  }
  function applyPartial(): void {
    if (!selected.value) {
      return;
    }
    try {
      const step = applyWorkflowStepJson({ step: selected.value, text: partialDraft.value });
      commit({ next: replaceWorkflowStep({ definition: definition.value, step }) });
      closePartial();
      resetModelReviews();
    } catch (reason) {
      setError({ reason });
    }
  }
  async function exportStructure(): Promise<void> {
    if (navigationLocked.value) {
      return;
    }
    const observed = definition.value;
    const text = formatWorkflowDefinition({ definition: shareWorkflowStructure({ definition: observed }) });
    if (!await confirmDialog({ options: { message: await ensureStrings.workflow__share_structure_notice() } }) || definition.value !== observed) {
      return;
    }
    downloadBlob({ blob: new Blob([text], { type: 'application/json' }), filename: 'workflow-structure.json' });
  }

  async function exportDefinition(): Promise<void> {
    const text = encoded.value;
    if (!await confirmDialog({ options: { message: await ensureStrings.workflow__export_secret_warning() } })) {
      return;
    }
    downloadBlob({ blob: new Blob([text], { type: 'application/json' }), filename: 'workflow.json' });
  }
  async function sample(): Promise<void> {
    if (busy.value || dialogOpen.value || !await confirmDiscard()) {
      return;
    }
    const loop = newWorkflowStep({ type: 'for_each', name: await ensureStrings.workflow__for_each(), ...defaults() });
    const generation = newWorkflowStep({ type: 'text_generation', name: await ensureStrings.workflow__text_generation(), ...defaults() });
    if (loop.type !== 'for_each' || generation.type !== 'text_generation') {
      return;
    }
    loop.source = { type: 'literal', value: ['Explain how a rainbow forms.', 'Explain why the sky is blue.'] };
    generation.appendMessages = [{ role: 'user', parts: [{ type: 'value', value: { type: 'loop_item', stepId: loop.id } }] }];
    loop.body.steps = [generation];
    loop.emit = { type: 'step_output', stepId: generation.id, output: 'text' };
    adopt({ next: { name: await ensureStrings.workflow__new_sample(), steps: [loop] }, snapshot: undefined, documentKind: 'workflow' });
  }
  function ask({ title, prompt, inputKind, signal, connection, choices }: { title: string, prompt: string, inputKind: PendingInput['kind'], signal: AbortSignal, connection: WorkflowConnectionReview | undefined, choices?: string[] }): Promise<string> {
    signal.throwIfAborted();
    if (pending.value) {
      return Promise.reject(new Error('Another Workflow input request is active.'));
    }
    const token = ++serial;
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', abort);
        if (pending.value?.token === token) {
          pending.value = undefined;
          answer = undefined;
        }
      };
      const abort = (): void => {
        cleanup();
        reject(signal.reason);
      };
      answer = ({ token: responseToken, text }) => {
        if (responseToken !== token) {
          return;
        }
        cleanup();
        resolve(text);
      };
      pending.value = { token, title, prompt, kind: inputKind, connection, choices: choices === undefined ? undefined : [...choices] };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
  }
  function respond({ token, text }: { token: number, text: string }): void {
    if (pending.value?.token !== token) {
      return;
    }
    try {
      if (pending.value.choices !== undefined && !pending.value.choices.includes(text)) {
        throw new Error('Select one of the supplied choices.');
      }
      switch (pending.value.kind) {
      case 'json': parseWorkflowJson({ text });
        break;
      case 'text': case 'approval': break;
      default: {
        const exhaustive: never = pending.value.kind;
        throw new Error(`Unknown input kind: ${exhaustive}`);
      }
      }
      answer?.({ token, text });
      error.value = '';
    } catch (reason) {
      setError({ reason });
    }
  }
  async function preview({ outputs }: { outputs: WorkflowOutputs }): Promise<string> {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(outputs)) {
      switch (value.type) {
      case 'model': lines.push(`${key}: ${value.modelId}`);
        break;
      case 'text': {
        let text = '';
        try {
          for await (const chunk of textChunks({ value, signal: undefined })) {
            text += chunk.slice(0, Math.max(0, 2000 - text.length));
            if (text.length >= 2000) {
              break;
            }
          }
        } catch (reason) {
          if (!(reason instanceof WorkflowTextDecodingError)) {
            throw reason;
          }
          text = await ensureStrings.workflow__text_preview_unavailable();
        }
        lines.push(`${key}: ${text}`);
        break;
      }
      case 'json': lines.push(`${key}: ${JSON.stringify(value.value).slice(0, 1000)}`);
        break;
      case 'binary': case 'sequence': lines.push(`${key}: ${value.output.byteLength} bytes`);
        break;
      case 'conversation': lines.push(`${key}: ${value.messages.length} messages`);
        break;
      case 'range': lines.push(`${key}: ${value.start}, ${value.step}, ${value.end ?? '…'}`);
        break;
      case 'array': case 'object': lines.push(`${key}: ${value.type}`);
        break;
      default: {
        const exhaustive: never = value;
        throw new Error(`Unknown value: ${exhaustive}`);
      }
      }
      if (lines.join('\n').length > 4000) {
        break;
      }
    }
    return lines.join('\n').slice(0, 4096);
  }
  async function clearResults({ confirm }: { confirm: boolean }): Promise<boolean> {
    if (running.value || busy.value || pendingHistorySave) {
      return false;
    }
    if (result && confirm && !await confirmDialog({ options: { message: await ensureStrings.workflow__confirm_clear(), confirmButtonVariant: 'danger' } })) {
      return false;
    }
    if (running.value || busy.value || dialogOpen.value || pendingHistorySave) {
      return false;
    }
    busy.value = true;
    try {
      if (zipCache) {
        await clearWorkflowStagingDirectory({ directory: zipCache.directory });
        zipCache = undefined;
      }
      if (exportDirectory && !retainedExport) {
        await clearWorkflowStagingDirectory({ directory: exportDirectory });
        exportDirectory = undefined;
      }
      await result?.release();
      // A failed nested cleanup can leave a charged, ownerless output. Closing
      // this run's store retries it before a new run may reuse the budget.
      await outputStore?.close();
      outputStore = undefined;
      resultSources.value = [];
      result = undefined;
      exportDirectory = undefined;
      retainedExport = false;
      activeRunId.value = undefined;
      hasResults.value = false;
      log.value = [];
      writtenFiles.value = [];
      runState.value = 'idle';
      return true;
    } catch (reason) {
      setError({ reason });
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function start(): Promise<void> {
    if (running.value || busy.value || dialogOpen.value || pendingHistorySave || !executable.value) {
      return;
    }
    let historySnapshot: WorkflowRunSnapshot | undefined;
    let imageProvider: ReturnType<typeof createWorkflowImageProvider> | undefined;
    let historyStore: ReturnType<typeof createWorkflowRunStore> | undefined;
    try {
      if (!await clearResults({ confirm: false })) {
        return;
      }
      if (!executable.value) {
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      historyError.value = '';
      const snapshot = clonePlainData({ value: { ...definition.value, executionLimits: resolveWorkflowExecutionLimits({ limits: definition.value.executionLimits }) } });
      const modelAuthorization = modelPermissions.beginRun();
      const audioAuthorization = audioPermissions.beginRun();
      const imageAuthorization = imagePermissions.beginRun();
      const imageDirectories = (settings.value.experimental?.hostModelDirectories ?? []).map(({ id, name }) => ({ directoryId: idToRaw({ id }), directoryName: name }));
      historyStore = canSave.value && typeof navigator.locks?.request === 'function' ? createWorkflowRunStore({ storageType: storageService.getCurrentType() }) : undefined;
      // Persist the exact run input before any provider or file side effect.
      // Saving can fail; in that case no execution has started.
      if (historyStore) {
        finalizing.value = true;
        try {
          historySnapshot = await historyStore.create({ workflowId: saved.value?.document.id, definition: snapshot });
          activeRunId.value = historySnapshot.record.id;
          historyError.value = '';
          await refreshRuns();
        } finally {
          finalizing.value = false;
        }
      }
      signal.throwIfAborted();
      const fakeLm = settings.value.experimental?.fakeLm ?? 'disabled';
      runState.value = 'running';
      error.value = '';
      let logNumber = 0;
      let checkpointSavedAt: number | undefined;
      async function saveProgress({ force }: { force: boolean }): Promise<void> {
        if (!historySnapshot || !historyStore) {
          return;
        }
        // This is a bounded progress checkpoint, not a heartbeat. A suspended
        // tab never loses ownership because its clock or timers stopped.
        if (!force && checkpointSavedAt !== undefined && performance.now() - checkpointSavedAt < 1000) {
          return;
        }
        historySnapshot = await historyStore.checkpoint({ previous: historySnapshot, entries: structuredClone(log.value) });
        checkpointSavedAt = performance.now();
      }
      if (!outputStore) {
        const directory = await getOPFSTmpManager().createTmpDirectory({ prefix: 'workflow-output' });
        outputStore = createWorkflowOutputStore({ directory, limits: { maxEntries: 4096, maxBytes: 256 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024, maxPendingWriteBytes: 4 * 1024 * 1024, maxWriteChunkBytes: 32768, readChunkBytes: 32768, maxReaders: 32 } });
      }
      const grantedFolders = new Set<string>();
      const fileServices = createWorkflowFileServices({
        onWritten({ file }) {
          writtenFiles.value = [...writtenFiles.value.filter(existing => existing.volumeId !== file.volumeId || existing.relativePath !== file.relativePath), file];
        },
        authorize: async ({ volumeId, mode, signal }) => {
          const key = `${idToRaw({ id: volumeId })}:${mode}`;
          if (grantedFolders.has(key)) {
            return;
          }
          const volume = volumes.value.find(volume => volume.id === volumeId);
          const response = await ask({ title: await ensureStrings.workflow__folder_permission(), prompt: `${volume?.name ?? idToRaw({ id: volumeId })} · ${mode}`, inputKind: 'approval', signal, connection: undefined });
          if (response !== 'allow') {
            throw new Error('Folder access was denied.');
          }
          grantedFolders.add(key);
        },
      });
      const authorizeTool: WorkflowToolAuthorization = async ({ request, signal }) => {
        const details = (() => {
          switch (request.name) {
          case 'shell_execute': return { folder: volumes.value.find(volume => volume.id === request.volumeId)?.name };
          case 'wikipedia_search': case 'wikipedia_get_page': return { destination: `https://${request.args.lang.toLowerCase()}.wikipedia.org/w/api.php` };
          case 'calculator': return {};
          default: {
            const exhaustive: never = request;
            throw new Error(String(exhaustive));
          }
          }
        })();
        const prompt = `${await ensureStrings.workflow__tool_permission_notice()}\n\n${JSON.stringify({ ...details, ...request }, undefined, 2)}`;
        await saveProgress({ force: true });
        return await ask({ title: await ensureStrings.workflow__tool_permission(), prompt, inputKind: 'approval', signal, connection: undefined }) === 'allow';
      };
      const executeTool: WorkflowToolExecutor = async ({ request, signal }) => {
        const provider = await prepareWorkflowProvider({ signal, load: () => import('@/features/workflow/providers/tools') });
        signal.throwIfAborted();
        return provider.executeWorkflowBuiltinTool({ request, signal });
      };
      result = await executeWorkflow({
        definition: snapshot,
        store: outputStore,
        signal,
        services: {
          ...fileServices,
          async callTool({ input }) {
            return executeWorkflowTool({ input, authorize: authorizeTool, execute: executeTool });
          },
          async generateImage({ input }) {
            const update = ({ preview }: { preview: string }): void => {
              if (input.signal.aborted) {
                return;
              }
              const index = log.value.findLastIndex(entry => entry.stepId === input.step.id && entry.phase === 'running');
              if (index >= 0) {
                const entries = [...log.value];
                entries[index] = { ...entries[index]!, inputPreview: input.request.prompt.slice(0, 4096), preview: preview.slice(0, 4096) };
                log.value = entries;
              }
            };
            update({ preview: '' });
            await imageAuthorization.authorize({
              target: input.request.model,
              sources: input.targetSources,
              signal: input.signal,
              async request({ review, signal }) {
                return await ask({ title: await ensureStrings.workflow__image_connection_permission(), prompt: '', inputKind: 'approval', signal, connection: review }) === 'allow';
              },
            });
            if (!imageProvider) {
              const provider = await prepareWorkflowProvider({ signal: input.signal, load: () => import('@/features/workflow/providers/local-image') });
              input.signal.throwIfAborted();
              imageProvider = provider.createWorkflowImageProvider({ directories: imageDirectories });
            }
            imagePreview.value = undefined;
            try {
              return await generateWorkflowImage({
                input,
                generate: imageProvider.generate,
                onProgress: ({ event }) => update({ preview: `${event.phase} · ${event.step}/${event.steps}` }),
                onPreview: ({ frame }) => {
                  if (!input.signal.aborted) {
                    imagePreview.value = frame;
                  }
                },
              });
            } finally {
              imagePreview.value = undefined;
            }
          },
          async generateAudio({ input }) {
            const index = log.value.findLastIndex(entry => entry.stepId === input.step.id && entry.phase === 'running');
            if (index >= 0) {
              const entries = [...log.value];
              entries[index] = { ...entries[index]!, inputPreview: input.request.text.slice(0, 4096) };
              log.value = entries;
            }
            await audioAuthorization.authorize({
              target: { endpoint: { type: 'llama_cpp_browser' }, modelId: input.request.modelId },
              sources: input.targetSources,
              signal: input.signal,
              async request({ review, signal }) {
                return await ask({ title: await ensureStrings.workflow__audio_connection_permission(), prompt: '', inputKind: 'approval', signal, connection: review }) === 'allow';
              },
            });
            const service = await prepareWorkflowProvider({ signal: input.signal, load: async () => (await import('@/features/llama-cpp-browser')).llamaCppBrowserService });
            input.signal.throwIfAborted();
            return generateWorkflowAudio({ input, generate: ({ input, cancellationSignal }) => service.generateAudio({ input, cancellationSignal }), normalizeReference: normalizeReferenceAudio });
          },
          async generate({ input }) {
            await modelAuthorization.authorize({
              target: input.target,
              sources: input.targetSources,
              signal: input.signal,
              async request({ review, signal }) {
                return await ask({ title: await ensureStrings.workflow__connection_permission(), prompt: '', inputKind: 'approval', signal, connection: review }) === 'allow';
              },
            });
            input.signal.throwIfAborted();
            const provider = await prepareWorkflowProvider({ signal: input.signal, load: () => loadLmProvider({ endpoint: input.target.endpoint, fakeLmDebugModeStatus: fakeLm }) });
            input.signal.throwIfAborted();
            const parts = new Map<string, { index: number, text: string }>();
            let request = '', lastPublish = 0;
            let pendingPublish: ReturnType<typeof setTimeout> | undefined;
            const publish = ({ force }: { force: boolean }): void => {
              const now = Date.now();
              if (!force && now - lastPublish < 80) {
                // A chunk can be followed by a long provider pause. Schedule a
                // trailing update instead of waiting for another chunk to arrive.
                pendingPublish ??= setTimeout(() => publish({ force: true }), Math.max(0, 80 - (now - lastPublish)));
                return;
              }
              if (pendingPublish !== undefined) {
                clearTimeout(pendingPublish);
                pendingPublish = undefined;
              }
              lastPublish = now;
              const entries = [...log.value];
              const index = entries.findLastIndex(entry => entry.stepId === input.step.id && entry.phase === 'running');
              if (index < 0) {
                return;
              }
              const preview = [...parts.values()].sort((a, b) => a.index - b.index).map(part => part.text).join('\n').slice(-4096);
              entries[index] = { ...entries[index]!, preview, inputPreview: request };
              log.value = entries;
            };
            try {
              return await generateWorkflowText({
                input,
                provider,
                tools: createWorkflowModelTools({
                  configs: input.step.toolConfigs,
                  policy: input.step.toolExecution,
                  authorize: authorizeTool,
                  execute: executeTool,
                  requestChoice: async ({ prompt, choices, signal }) => {
                    await saveProgress({ force: true });
                    const selected = await ask({ title: input.step.name, prompt, inputKind: 'text', signal, connection: undefined, choices });
                    return choices.indexOf(selected);
                  },
                }),
                onProgress({ event }) {
                  switch (event.type) {
                  case 'input': request = event.text;
                    parts.clear();
                    publish({ force: true });
                    break;
                  case 'tool':
                    parts.set(`tool:${event.callId}`, { index: parts.size, text: `${event.name} · ${event.phase}\n${event.text}`.slice(-4096) });
                    publish({ force: true });
                    break;
                  case 'chunk': {
                    const previous = parts.get(event.partId)?.text ?? '';
                    parts.set(event.partId, { index: event.index, text: (previous + event.text).slice(-4096) });
                    publish({ force: false });
                    break;
                  }
                  default: {
                    const exhaustive: never = event;
                    throw new Error(String(exhaustive));
                  }
                  }
                },
              });
            } finally {
              publish({ force: true });
            }

          },
          requestInput: async ({ step, prompt, choices, signal }) => ask({ title: step.name, prompt, inputKind: step.responseType, signal, connection: undefined, choices }),
          async onStep({ step, phase, trace, outputs }) {
            switch (phase) {
            case 'running': {
              log.value = [...log.value.slice(-199), { number: ++logNumber, name: step.name, stepId: step.id, trace, phase, preview: '', inputPreview: '' }];
              break;
            }
            case 'completed': {
              const value = outputs ? await preview({ outputs }) : '';
              const entries = [...log.value];
              const index = entries.findLastIndex(entry => entry.stepId === step.id && entry.phase === 'running' && JSON.stringify(entry.trace) === JSON.stringify(trace));
              if (index >= 0) {
                entries[index] = { ...entries[index]!, phase, preview: value };
              }
              log.value = entries;
              break;
            }
            default: {
              const exhaustive: never = phase;
              throw new Error(`Unknown phase: ${exhaustive}`);
            }
            }
            // Save before interactive waiting as well as throttled boundaries.
            // A write failure stops execution; it must not replay a side effect.
            await saveProgress({ force: phase === 'running' && step.type === 'request_input' });
          },
        },
      });
      hasResults.value = true;
      resultSources.value = workflowResultSources({ result });
      runState.value = result.status;
      if (result.error) {
        setError({ reason: result.error });
      }
    } catch (reason) {
      runState.value = controller?.signal.aborted ? 'cancelled' : 'failed';
      setError({ reason });
    } finally {
      try {
        imageProvider?.close();
      } catch (reason) {
        // Cleanup failure must not strand an otherwise finalizable run in history.
        runState.value = controller?.signal.aborted ? 'cancelled' : 'failed';
        setError({ reason: new Error([error.value, reason instanceof Error ? reason.message : String(reason)].filter(Boolean).join('\n')) });
      }
      if (historySnapshot && historyStore) {
        await finishHistory({ historySnapshot, historyStore });
      }
    }
  }
  async function finishHistory({ historySnapshot, historyStore }: { historySnapshot: WorkflowRunSnapshot, historyStore: ReturnType<typeof createWorkflowRunStore> }): Promise<void> {
    finalizing.value = true;
    let resultsPath: string[] | undefined, resultError: string | undefined;
    try {
      if (result) {
        const directory = await getOPFSTmpManager().createTmpDirectory({ prefix: 'workflow-results' });
        try {
          // Archive immutable runtime outputs only. Reading mutable user
          // Volume files still requires the explicit open/export operation.
          await exportWorkflowResults({ result, directory, signal: new AbortController().signal, writtenFiles: [] });
          resultsPath = await workflowResultsPath({ root: await navigator.storage.getDirectory(), directory });
          exportDirectory = directory;
          retainedExport = true;
        } catch (reason) {
          await clearWorkflowStagingDirectory({ directory }).catch(() => undefined);
          throw reason;
        }
      }
    } catch (reason) {
      resultError = reason instanceof Error ? reason.message : String(reason);
    }
    const terminal = runState.value;
    let status: 'completed' | 'failed' | 'cancelled', executionError: string | undefined;
    switch (terminal) {
    case 'completed': case 'cancelled':
      status = terminal;
      break;
    case 'failed': case 'running': case 'idle':
      status = 'failed';
      executionError = error.value.slice(0, 4096);
      break;
    default: {
      const exhaustive: never = terminal;
      throw new Error(String(exhaustive));
    }
    }
    const previous = historySnapshot;
    const entries = structuredClone(log.value);
    historySavePending.value = true;
    pendingHistoryRelease = () => historyStore.release({ id: previous.record.id });
    pendingHistorySave = () => historyStore.finish({ previous, status, entries, error: executionError, resultsPath, resultError });
    try {
      await pendingHistorySave();
      pendingHistorySave = undefined;
      pendingHistoryRelease = undefined;
      historySavePending.value = false;
      historyError.value = '';
      await refreshRuns();
    } catch (reason) {
      historyError.value = reason instanceof Error ? reason.message : String(reason);
    } finally {
      finalizing.value = false;
    }
  }
  function stop(): void {
    controller?.abort(new DOMException('Workflow stopped', 'AbortError'));
  }
  async function openResults({ zip }: { zip: boolean }): Promise<void> {
    if (!result || running.value) {
      return;
    }
    const completed = result;
    await attempt({
      action: async () => {
        const signal = new AbortController().signal;
        if (!exportDirectory || (retainedExport && writtenFiles.value.length > 0)) {
          const directory = await getOPFSTmpManager().createTmpDirectory({ prefix: 'workflow-results' });
          try {
            await exportWorkflowResults({ result: completed, directory, signal, writtenFiles: writtenFiles.value });
          } catch (reason) {
            await clearWorkflowStagingDirectory({ directory });
            throw reason;
          }
          exportDirectory = directory;
          retainedExport = false;
        }
        if (zip) {
          if (!zipCache) {
            const zipDirectory = await getOPFSTmpManager().createTmpDirectory({ prefix: 'workflow-zip' });
            try {
              zipCache = { file: await zipWorkflowFolder({ directory: exportDirectory, zipDirectory, signal }), directory: zipDirectory };
            } catch (reason) {
              await clearWorkflowStagingDirectory({ directory: zipDirectory });
              throw reason;
            }
          }
          await downloadFile({ file: zipCache.file, filename: 'workflow-results.zip', signal });
        } else {
          useFileExplorerModal().openFileExplorer({ options: { kind: 'native-directory', title: await ensureStrings.workflow__results(), rootName: 'workflow-results', handle: exportDirectory, readOnly: true, initialPath: undefined } });
        }
      },
    });
  }
  async function openWrittenFile({ file }: { file: WorkflowWrittenFile }): Promise<void> {
    if (!writtenFiles.value.includes(file)) {
      return;
    }
    await attempt({
      action: async () => {
        const access = await storageService.resolveVolumeAccess({ volumeId: file.volumeId });
        const mount = volumeAccessToWeshMount({ mount: { type: 'volume', volumeId: file.volumeId, mountPath: '/output', readOnly: true }, access });
        if (!mount) {
          throw new Error('The output folder is unavailable.');
        }
        useFileExplorerModal().openFileExplorer({ options: { kind: 'wesh-mounts', title: await ensureStrings.workflow__results(), rootName: 'output', mounts: [mount], initialPath: ['output', ...file.relativePath.split('/').slice(0, -1)] } });
      },
    });
  }
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native beforeunload listener.
  const beforeUnload = (event: BeforeUnloadEvent): void => {
    if (dirty.value || running.value || historySavePending.value) {
      event.preventDefault();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', beforeUnload);
  }
  return {
    inlineDrafts,
    runs,
    activeRunId,
    historyError,
    finalizing,
    historySavePending,
    retryHistorySave,
    discardHistorySave,
    refreshRuns,
    copyRun,
    adoptDocument,
    updateExecutionLimits,
    confirmDiscard,
    navigationLocked,
    confirmInlineExit,
    definition,
    saved,
    kind,
    library,
    volumes,
    selectedIds,
    selectedId,
    selected,
    mode,
    jsonDraft,
    partialDraft,
    partialOpen,
    error,
    busy,
    dirty,
    draftDirty,
    canSave,
    editingLocked,
    issues,
    historyState,
    runState,
    running,
    log,
    pending,
    imagePreview,
    hasResults,
    resultSources,
    writtenFiles,
    openWrittenFile,
    defaults,
    reviewModel,
    reviewAudioModel,
    reviewImageModel,
    forgetModelReviews,
    refresh,
    create,
    open,
    save,
    remove,
    select,
    add,
    updateStep,
    updateName,
    move,
    editGraph,
    deleteSteps,
    duplicate,
    savePart,
    insertPart,
    travel,
    changeMode,
    applyJson,
    openPartial,
    closePartial,
    applyPartial,
    exportDefinition,
    exportStructure,
    sample,
    respond,
    start,
    stop,
    clearResults,
    openResults,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        async close() {
          window.removeEventListener('beforeunload', beforeUnload);
          stop();
          await pendingHistoryRelease?.();
          await result?.release();
          await outputStore?.close();
        },
      },
    }) || {}),
  };
}

/** The workspace outlives its route; navigating back to chat does not cancel a run. */
export function useWorkflowWorkspace() {
  singleton ??= createWorkspace();
  return singleton;
}

export type WorkflowWorkspace = ReturnType<typeof useWorkflowWorkspace>;
export const TEST_ONLY = {
  createWorkspace,
};
