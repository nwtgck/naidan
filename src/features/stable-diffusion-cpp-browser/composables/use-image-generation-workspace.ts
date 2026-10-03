import { type Ref, computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { storageService } from '@/00-storage/service';
import * as persistence from '@/00-storage/service/image-generation';
import { listImageGenerationRunAssets, setImageGenerationAssetState } from '@/00-storage/service/image-generation-curation';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import { generateId } from '@/01-models/id';
import type { BinaryObjectId, ChatId, ImageGenerationAssetId, ImageGenerationRunId, ImageGenerationDraftRevisionId, ImageGenerationSessionId, ImageGenerationTagId } from '@/01-models/ids';
import type { ImageGenerationAsset, ImageGenerationAssetPage, ImageGenerationCatalog, ImageGenerationSessionDraft, ImageGenerationRun, ImageGenerationRunSummary, ImageGenerationSession, ImageGenerationSource, ImageGenerationTagReference, ImageGenerationTranslationOverride } from '@/01-models/image-generation';
import { imageGenerationTagNameSchema, imageGenerationTagReferenceKey } from '@/01-models/image-generation';
import { promiseAllKeyed } from '@/utils/promise';
import { ensureStrings } from '@/strings';
import type { ImageGenerationView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
import type { ImageGenerationDraft } from '@/features/stable-diffusion-cpp-browser/generation-draft';
import { createImageGenerationRunSink } from '@/features/stable-diffusion-cpp-browser/session/run-sink';
import { createImageGenerationQueryClient } from '@/features/stable-diffusion-cpp-browser/session/query-worker/client';

export type ImageGenerationTile = ImageGenerationAssetPage['items'][number];
export type ImageGenerationCurationAction = { type: 'archive' | 'restore' | 'delete' } | { type: 'tag', tag: ImageGenerationTagReference, assignment: 'add' | 'remove' };
type DraftCheckpoint = { value: ImageGenerationDraft, count: number, revision: number | undefined, dirty: boolean };

/** The page owns generation; selection owns only the visible session. In-flight
 * publication always uses the store and session captured by its run sink. */
export function useImageGenerationWorkspace({ generation, requestedSessionId }: {
  generation: ImageGenerationView, requestedSessionId: Readonly<Ref<ImageGenerationSessionId | undefined>> | undefined,
}) {
  const initialized = ref(false);
  const sessions = shallowRef<ImageGenerationSession[]>([]);
  const catalog = shallowRef<ImageGenerationCatalog>();
  const store = shallowRef<ImageGenerationStoreAccess>();
  const selectedSessionId = ref<ImageGenerationSessionId>();
  const editingSessionId = ref<ImageGenerationSessionId>();
  const runs = shallowRef<ImageGenerationRunSummary[]>([]);
  const runsWithAssets = shallowRef<ImageGenerationRunId[]>([]);
  const tiles = shallowRef<ImageGenerationTile[]>([]);
  const nextCursor = shallowRef<ImageGenerationAssetPage['nextCursor']>();
  const total = ref(0), count = ref(1);
  // A filter or session switch must not hide the first-result notice.
  const hasGeneratedImages = ref(false);
  const loading = ref(false), switching = ref(false), starting = ref(false), mutation = ref(false);
  const failure = ref(''), warnings = ref<string[]>([]);
  const text = ref(''), onlyFavorite = ref(false), filterTagId = ref<ImageGenerationTagId>();
  const visibility = ref<'active' | 'archived' | 'all'>('active');
  const pendingDeletions = shallowRef<{ assetId: ImageGenerationAssetId, sessionId: ImageGenerationSessionId, revision: number }[]>([]);
  const deletedAssetIds = shallowRef<ImageGenerationAssetId[]>([]);
  const operationProgress = ref<{ completed: number, total: number }>();
  const mode = ref<'runs' | 'gallery' | 'compare'>('runs');
  const selection = shallowRef<ImageGenerationTile[]>([]);
  const details = shallowRef<{ asset: ImageGenerationAsset, run: ImageGenerationRun }>();
  const inspectedTile = shallowRef<ImageGenerationTile>();
  const inspectLoading = ref(false), inspectFailure = ref('');
  const draftStatus = ref<'saved' | 'dirty' | 'saving' | 'failed'>('saved');
  const draftFailure = ref('');
  // IDs are primitive runtime values; deep Ref unwrapping expands the private brand
  // and makes declaration emit fail (TS4058/TS4023). Keep the public alias intact.
  const draftRevision = shallowRef<ImageGenerationDraftRevisionId>(generateId<ImageGenerationDraftRevisionId>());
  const storageRevision = ref(0), runRevision = ref(0);
  let disposed = false, epoch = 0, queryEpoch = 0, detailEpoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draftWriting: Promise<void> | undefined;
  const attempts = new Map<ImageGenerationSessionId, { checkpoint: ImageGenerationSessionDraft, source: DraftCheckpoint }>();
  const drafts = new Map<ImageGenerationSessionId, DraftCheckpoint>();
  const sources = new Map<ImageGenerationSessionId, { source: ImageGenerationSource, binaryObjectId: BinaryObjectId | undefined }[]>();
  let queries = createImageGenerationQueryClient();
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let owner: ReturnType<typeof createImageGenerationRunSink> | undefined;
  let ownerStore: ImageGenerationStoreAccess | undefined;
  const available = computed(() => {
    void storageRevision.value;
    try {
      return storageService.getCurrentType() === 'opfs';
    } catch {
      return false;
    }
  });
  const assistantVisibility = computed(() => catalog.value?.preferences.assistantVisibility ?? 'closed');
  const assistantLayout = computed(() => catalog.value?.preferences.assistantLayout ?? 'floating');
  const experimentalNoticeVisible = computed(() => hasGeneratedImages.value && catalog.value !== undefined && catalog.value.preferences.experimentalNoticeDismissedAt === undefined);
  const currentSession = computed(() => sessions.value.find(session => session.id === selectedSessionId.value && session.state !== 'deleting' && session.state !== 'deleted'));
  const editorReady = computed(() => !switching.value && !starting.value && editingSessionId.value === selectedSessionId.value);
  const runState = computed(() => {
    void runRevision.value; return owner?.snapshot();
  });
  const hasPendingSave = computed(() => runState.value?.needsRetry ?? false);
  const reusing = ref(false);
  const busy = computed(() => starting.value || switching.value || mutation.value || reusing.value);
  const userTags = computed(() => catalog.value?.tags.filter(tag => tag.state === 'active') ?? []);
  function errorText({ error }: { error: unknown }): string {
    return error instanceof Error ? error.message : String(error);
  }
  function touchDraft(): void {
    draftRevision.value = generateId<ImageGenerationDraftRevisionId>();
  }

  async function openStore({ creation }: { creation: 'allow' | 'forbid' }): Promise<ImageGenerationStoreAccess | undefined> {
    if (!available.value) return undefined;
    const operationEpoch = epoch;
    const value = await persistence.openImageGenerationStore({ storageType: 'opfs', creation });
    if (disposed || operationEpoch !== epoch) return undefined;
    if (!value) return undefined;
    catalog.value = value;
    store.value = { storageType: 'opfs', storeId: value.id };
    return store.value;
  }
  async function refreshSessions(): Promise<void> {
    const target = store.value, token = epoch;
    if (!target) return;
    const result = await persistence.listImageGenerationSessions({ store: target });
    if (disposed || token !== epoch) return;
    sessions.value = result.items;
    warnings.value = result.warnings.map(warning => `${warning.path}: ${warning.message}`);
  }
  async function refresh({ append }: { append: boolean }): Promise<void> {
    clearTimeout(searchTimer);
    if (append && !nextCursor.value) return;
    const target = store.value, sessionId = selectedSessionId.value;
    if (!target || !sessionId) {
      tiles.value = []; runs.value = []; runsWithAssets.value = []; loading.value = false; return;
    }
    const token = ++queryEpoch;
    loading.value = true;
    const tags: ImageGenerationTagReference[] = [];
    if (onlyFavorite.value) tags.push({ type: 'system', key: 'favorite' });
    if (filterTagId.value) tags.push({ type: 'user', tagId: filterTagId.value });
    try {
      const result = await queries.query({ store: target, sessionId, query: { visibility: visibility.value, text: text.value, tags, match: 'all', runId: undefined, cursor: append ? nextCursor.value : undefined, limit: 40 } });
      if (disposed || token !== queryEpoch || selectedSessionId.value !== sessionId) return;
      const seen = new Set(append ? tiles.value.map(tile => tile.id) : []);
      tiles.value = [...(append ? tiles.value : []), ...result.page.items.filter(tile => !seen.has(tile.id))];
      pendingDeletions.value = result.pendingDeletions; runsWithAssets.value = result.runsWithAssets;
      if (result.runsWithAssets.length) hasGeneratedImages.value = true;
      deletedAssetIds.value = [...new Set([...deletedAssetIds.value, ...result.deletedAssetIds])];
      const unavailableIds = new Set([...result.pendingDeletions.map(item => item.assetId), ...deletedAssetIds.value]);
      if (inspectedTile.value && unavailableIds.has(inspectedTile.value.id)) closeDetails();
      selection.value = selection.value.filter(item => !unavailableIds.has(item.id));
      const updated = new Map(tiles.value.map(tile => [tile.id, tile]));
      selection.value = selection.value.map(tile => updated.get(tile.id) ?? tile);
      total.value = result.page.total; nextCursor.value = result.page.nextCursor; runs.value = result.runs.items;
      warnings.value = [...result.page.warnings, ...result.runs.warnings].map(warning => `${warning.path}: ${warning.message}`);
    } catch (error) {
      if (!disposed && token === queryEpoch) failure.value = errorText({ error });
    } finally {
      if (token === queryEpoch) loading.value = false;
    }
  }
  function rememberDraft(): void {
    const sessionId = editingSessionId.value;
    if (!sessionId || !editorReady.value) return;
    const value = generation.captureDraft?.();
    if (!value) return;
    const previous = drafts.get(sessionId);
    drafts.set(sessionId, { value, count: count.value, revision: previous?.revision, dirty: true });
    draftStatus.value = 'dirty';
  }
  function saveDraft(): Promise<void> {
    clearTimeout(timer);
    if (draftWriting) return draftWriting;
    const target = store.value, token = epoch;
    if (!target) return Promise.resolve();
    const operation = (async () => {
      try {
        for (const sessionId of drafts.keys()) {
          // Drain edits made during an awaited write. Reuse the exact attempted
          // payload after a lost acknowledgement rather than inventing a new timestamp.
          while (token === epoch) {
            const source = drafts.get(sessionId);
            if (!source?.dirty) break;
            let attempt = attempts.get(sessionId);
            if (!attempt) {
              const { files: _files, modelFiles: _modelFiles, ...fields } = source.value;
              attempt = { source, checkpoint: { ...fields, sessionId, revision: source.revision === undefined ? 0 : source.revision + 1, updatedAt: Date.now(), count: source.count } };
              attempts.set(sessionId, attempt);
            }
            if (!disposed && sessionId === editingSessionId.value) draftStatus.value = 'saving';
            await storageService.publishImageGeneration({ store: target,
              publication: { type: 'draft', draft: attempt.checkpoint, expectedRevision: attempt.source.revision }, files: attempt.source.value.files });
            if (token !== epoch) return;
            const latest = drafts.get(sessionId);
            if (latest) {
              latest.revision = attempt.checkpoint.revision;
              if (latest === attempt.source) latest.dirty = false;
            }
            attempts.delete(sessionId);
            if (!disposed && sessionId === editingSessionId.value) {
              draftStatus.value = latest?.dirty ? 'dirty' : 'saved'; draftFailure.value = '';
            }
          }
        }
      } catch (error) {
        if (!disposed && token === epoch) {
          draftStatus.value = 'failed'; draftFailure.value = errorText({ error });
        }
      }
    })();
    draftWriting = operation;
    void operation.finally(() => {
      if (draftWriting === operation) draftWriting = undefined;
    });
    return operation;
  }
  async function flushDraft(): Promise<boolean> {
    rememberDraft();
    await saveDraft();
    // A different session may have been added while a previous save was settling.
    if (draftStatus.value !== 'failed' && [...drafts.values()].some(value => value.dirty)) await saveDraft();
    return ![...drafts.values()].some(value => value.dirty);
  }
  async function restoreActiveDraft(): Promise<void> {
    const target = store.value, sessionId = selectedSessionId.value;
    if (!target || !sessionId || switching.value || generation.formDisabled.value || editingSessionId.value === sessionId) return;
    switching.value = true; touchDraft();
    const token = epoch;
    try {
      let cached = drafts.get(sessionId);
      if (!cached) {
        const saved = await persistence.loadImageGenerationDraft({ store: target, sessionId });
        if (saved) {
          const { sessionId: _sessionId, revision, updatedAt: _updatedAt, count: imageCount, ...value } = saved;
          cached = { value: { ...value, files: [], modelFiles: [] }, count: imageCount, revision, dirty: false };
          drafts.set(sessionId, cached);
        }
      }
      if (disposed || token !== epoch || selectedSessionId.value !== sessionId) return;
      if (cached) {
        await generation.restoreDraft?.({ draft: cached.value });
        if (generation.historyActions.error.value) throw new Error(generation.historyActions.error.value);
        count.value = cached.count;
      } else {
        generation.resetDraft?.(); count.value = 1;
      }
      if (disposed || token !== epoch) return;
      editingSessionId.value = sessionId;
      draftStatus.value = cached?.dirty ? 'dirty' : 'saved'; draftFailure.value = '';
    } catch (error) {
      if (!disposed && token === epoch) failure.value = errorText({ error });
    } finally {
      switching.value = false;
    }
  }
  async function selectSession({ sessionId }: { sessionId: ImageGenerationSessionId }): Promise<void> {
    if (busy.value || disposed || sessionId === selectedSessionId.value) return;
    rememberDraft(); void saveDraft();
    selectedSessionId.value = sessionId; touchDraft();
    selection.value = []; closeDetails();
    text.value = ''; onlyFavorite.value = false; filterTagId.value = undefined; visibility.value = 'active'; pendingDeletions.value = []; deletedAssetIds.value = [];
    nextCursor.value = undefined; tiles.value = []; runs.value = []; runsWithAssets.value = [];
    total.value = 0; failure.value = '';
    if (!sessions.value.some(session => session.id === sessionId && session.state !== 'deleting' && session.state !== 'deleted')) {
      editingSessionId.value = undefined;
      failure.value = await ensureStrings.imageGeneration__session_unavailable();
      return;
    }
    await refresh({ append: false });
    await restoreActiveDraft();
  }
  async function newSession({ preserveDraft }: { preserveDraft: boolean }): Promise<ImageGenerationSession | undefined> {
    if (busy.value || disposed) return undefined;
    rememberDraft(); void saveDraft();
    starting.value = true; failure.value = ''; touchDraft();
    const token = epoch;
    const previous = generation.captureDraft?.();
    try {
      const target = store.value ?? await openStore({ creation: 'allow' });
      if (!target || disposed || token !== epoch) return undefined;
      const now = Date.now();
      const title = preserveDraft && generation.parameters.value.prompt.trim()
        ? Array.from(generation.parameters.value.prompt.trim().replace(/\s+/g, ' ')).slice(0, 80).join('')
        : await ensureStrings.imageGeneration__new_session();
      const session: ImageGenerationSession = { translation: undefined, assistantChatId: undefined, id: generateId<ImageGenerationSessionId>(), revision: 0, title, createdAt: now, updatedAt: now, state: 'active' };
      await persistence.saveImageGenerationSession({ store: target, session, expectedRevision: undefined });
      if (disposed || token !== epoch) return undefined;
      sessions.value = [session, ...sessions.value]; selectedSessionId.value = session.id;
      if (previous) {
        const value = preserveDraft ? previous : { ...previous, seedMode: 'random' as const,
          request: { ...previous.request, parameters: { ...previous.request.parameters, prompt: '', negativePrompt: '' }, imageInputs: { initImage: undefined, strength: previous.request.imageInputs.strength, referenceImages: [] } }, files: [] };
        drafts.set(session.id, { value, count: preserveDraft ? count.value : 1, revision: undefined, dirty: true });
      }
      if (preserveDraft) editingSessionId.value = session.id;
      selection.value = []; closeDetails();
      tiles.value = []; runs.value = []; runsWithAssets.value = []; total.value = 0; nextCursor.value = undefined;
      text.value = ''; onlyFavorite.value = false; filterTagId.value = undefined; visibility.value = 'active'; pendingDeletions.value = []; deletedAssetIds.value = [];
      return session;
    } catch (error) {
      if (!disposed && token === epoch) failure.value = errorText({ error });
      return undefined;
    } finally {
      starting.value = false;
      if (!preserveDraft) await restoreActiveDraft();
    }
  }
  async function reload(): Promise<void> {
    if (busy.value) return;
    failure.value = '';
    try {
      const target = await openStore({ creation: 'forbid' });
      if (!target) return;
      await refreshSessions();
      if (requestedSessionId?.value && requestedSessionId.value !== selectedSessionId.value) {
        await selectSession({ sessionId: requestedSessionId.value });
      } else if (!selectedSessionId.value) {
        const first = sessions.value.find(session => session.state === 'active');
        if (first) await selectSession({ sessionId: first.id });
      } else await refresh({ append: false });
    } catch (error) {
      if (!disposed) failure.value = errorText({ error });
    } finally {
      if (!disposed) initialized.value = true;
    }
  }
  async function renameSession({ sessionId, title }: { sessionId: ImageGenerationSessionId, title: string }): Promise<void> {
    const target = store.value, previous = sessions.value.find(session => session.id === sessionId);
    if (!target || !previous || mutation.value) return;
    mutation.value = true; failure.value = '';
    try {
      const next = { ...previous, title: title.trim(), revision: previous.revision + 1, updatedAt: Date.now() };
      await persistence.saveImageGenerationSession({ store: target, session: next, expectedRevision: previous.revision });
      if (store.value?.storeId === target.storeId) sessions.value = sessions.value.map(session => session.id === next.id ? next : session);
    } catch (error) {
      failure.value = errorText({ error });
    } finally {
      mutation.value = false;
    }
  }
  async function updatePreferences({ change }: { change:
    | { type: 'dismiss-notice' }
    | { type: 'assistant-layout', layout: 'floating' | 'docked' }
    | { type: 'assistant-visibility', visibility: 'open' | 'closed' }
    | { type: 'translation', translation: ImageGenerationTranslationOverride | undefined },
  }): Promise<boolean> {
    if (disposed || busy.value || !available.value) return false;
    const token = epoch;
    mutation.value = true; failure.value = '';
    try {
      const target = store.value ?? await openStore({ creation: 'allow' });
      if (!target || disposed || token !== epoch) return false;
      // Load the current catalog so changing display preferences does not undo
      // tags renamed by another tab. The revision check still guards the write.
      const previous = await persistence.loadImageGenerationCatalog({ store: target });
      const preferences = { ...previous.preferences };
      switch (change.type) {
      case 'dismiss-notice': preferences.experimentalNoticeDismissedAt ??= Date.now(); break;
      case 'assistant-layout': preferences.assistantLayout = change.layout; break;
      case 'assistant-visibility': preferences.assistantVisibility = change.visibility; break;
      case 'translation': preferences.translation = change.translation; break;
      default: { const exhaustive: never = change; throw new Error(String(exhaustive)); }
      }
      if (disposed || token !== epoch || store.value?.storeId !== target.storeId) return false;
      const next = { ...previous, revision: previous.revision + 1, preferences };
      await persistence.saveImageGenerationCatalog({ store: target, catalog: next, expectedRevision: previous.revision });
      if (disposed || token !== epoch || store.value?.storeId !== target.storeId) return false;
      catalog.value = next;
      return true;
    } catch (error) {
      if (!disposed && token === epoch) failure.value = errorText({ error });
      return false;
    } finally {
      mutation.value = false;
    }
  }
  async function updateSessionTranslation({ translation }: { translation: ImageGenerationTranslationOverride | undefined }): Promise<boolean> {
    if (disposed || busy.value) return false;
    const token = epoch;
    const selected = currentSession.value ?? await newSession({ preserveDraft: true });
    const target = store.value;
    if (!selected || !target || token !== epoch || disposed || mutation.value) return false;
    mutation.value = true; failure.value = '';
    try {
      // Read latest metadata before changing one field, then guard its revision.
      const previous = await persistence.loadImageGenerationSession({ store: target, sessionId: selected.id });
      if (!previous) throw new Error(await ensureStrings.imageGeneration__session_unavailable());
      if (disposed || token !== epoch || selectedSessionId.value !== selected.id) return false;
      const next = { ...previous, translation, revision: previous.revision + 1, updatedAt: Date.now() };
      await persistence.saveImageGenerationSession({ store: target, session: next, expectedRevision: previous.revision });
      if (disposed || token !== epoch) return false;
      sessions.value = sessions.value.map(item => item.id === next.id ? next : item);
      return true;
    } catch (error) {
      if (!disposed && token === epoch) failure.value = errorText({ error });
      return false;
    } finally {
      mutation.value = false;
    }
  }
  async function deleteSession({ sessionId }: { sessionId: ImageGenerationSessionId }): Promise<boolean> {
    const target = store.value, previous = sessions.value.find(session => session.id === sessionId), token = epoch;
    if (!target || !previous || busy.value || disposed) return false;
    if (runState.value?.run?.sessionId === sessionId && (generation.busy.value || hasPendingSave.value)) {
      failure.value = await ensureStrings.imageGeneration__finish_session_work_before_deleting(); return false;
    }
    mutation.value = true; failure.value = '';
    try {
      // Let accepted writes finish before the tombstone. Deleting another
      // session must not cancel the current draft's pending autosave.
      if (editingSessionId.value !== sessionId) await saveDraft();
      else {
        clearTimeout(timer); await draftWriting;
      }
      await persistence.deleteImageGenerationSession({ store: target, sessionId, expectedRevision: previous.revision });
      if (disposed || token !== epoch) return false;
      drafts.delete(sessionId); attempts.delete(sessionId); sources.delete(sessionId);
      sessions.value = sessions.value.filter(session => session.id !== sessionId);
      if (selectedSessionId.value === sessionId) {
        queryEpoch++; clearTimeout(searchTimer); selectedSessionId.value = undefined; editingSessionId.value = undefined;
        selection.value = []; closeDetails(); tiles.value = []; runs.value = []; runsWithAssets.value = []; nextCursor.value = undefined; total.value = 0;
        pendingDeletions.value = []; deletedAssetIds.value = []; draftStatus.value = 'saved'; draftFailure.value = ''; touchDraft();
        if (!generation.formDisabled.value) generation.resetDraft?.();
      }
      return true;
    } catch (error) {
      if (!disposed && token === epoch) {
        failure.value = errorText({ error });
        try {
          await refreshSessions();
        } catch { /* Keep the original deletion failure and permit retry. */ }
      }
      return false;
    } finally {
      mutation.value = false;
    }
  }
  async function connectChat({ chatId }: { chatId: ChatId | undefined }): Promise<boolean> {
    if (disposed || busy.value) return false;
    const token = epoch;
    const previous = currentSession.value ?? await newSession({ preserveDraft: true }), target = store.value;
    if (!target || !previous || mutation.value || token !== epoch || disposed) return false;
    mutation.value = true; failure.value = '';
    try {
      const session = { ...previous, assistantChatId: chatId, revision: previous.revision + 1, updatedAt: Date.now() };
      await persistence.saveImageGenerationSession({ store: target, session, expectedRevision: previous.revision });
      if (store.value?.storeId !== target.storeId || disposed) return false;
      sessions.value = sessions.value.map(item => item.id === session.id ? session : item);
      return true;
    } catch (error) {
      if (!disposed && token === epoch) failure.value = errorText({ error }); return false;
    } finally {
      mutation.value = false;
    }
  }
  async function runAssets({ runId }: { runId: ImageGenerationRunId }): Promise<ImageGenerationTile[]> {
    const target = store.value, sessionId = selectedSessionId.value;
    if (!target || !sessionId || mutation.value) return [];
    try {
      return await listImageGenerationRunAssets({ store: target, sessionId, runId });
    } catch (error) {
      failure.value = errorText({ error }); return [];
    }
  }
  /** A batch is deliberately not called atomic. Persist each result, report
   * failures, and leave unsuccessful selections available for another attempt. */
  async function curate({ items, action }: { items: ImageGenerationTile[], action: ImageGenerationCurationAction }): Promise<void> {
    const target = store.value, sessionId = selectedSessionId.value, token = epoch;
    if (!target || !sessionId || mutation.value || disposed) return;
    const unique = [...new Map(items.map(tile => [tile.id, tile])).values()];
    if (!unique.length || unique.some(tile => tile.sessionId !== sessionId)) return;
    mutation.value = true; failure.value = '';
    operationProgress.value = { completed: 0, total: unique.length };
    const errors: string[] = [], succeeded = new Set<ImageGenerationAssetId>();
    try {
      for (const tile of unique) {
        if (disposed || token !== epoch) break;
        try {
          if (!tile.annotations) throw new Error('Reload this image before editing unreadable annotations.');
          switch (action.type) {
          case 'delete':
            await storageService.deleteImageGenerationOutput({ store: target, sessionId, assetId: tile.id, expectedRevision: tile.annotations.revision });
            if (!disposed && token === epoch) {
              deletedAssetIds.value = [...deletedAssetIds.value, tile.id];
              if (inspectedTile.value?.id === tile.id) closeDetails();
            }
            break;
          case 'archive':
            await setImageGenerationAssetState({ store: target, sessionId, assetId: tile.id, state: 'archived', expectedRevision: tile.annotations.revision });
            break;
          case 'restore':
            await setImageGenerationAssetState({ store: target, sessionId, assetId: tile.id, state: 'active', expectedRevision: tile.annotations.revision });
            break;
          case 'tag': {
            const key = imageGenerationTagReferenceKey({ tag: action.tag });
            const other = tile.annotations.tags.map(item => item.tag).filter(tag => imageGenerationTagReferenceKey({ tag }) !== key);
            const tags = (() => {
              switch (action.assignment) {
              case 'add': return [...other, action.tag];
              case 'remove': return other;
              default: { const exhaustive: never = action.assignment; throw new Error(String(exhaustive)); }
              }
            })();
            await persistence.setImageGenerationAssetTags({ store: target, sessionId, assetId: tile.id, tags,
              assignedAt: Date.now(), expectedRevision: tile.annotations.revision });
            break;
          }
          default: { const exhaustive: never = action; throw new Error(String(exhaustive)); }
          }
          if (disposed || token !== epoch) return;
          switch (action.type) {
          case 'delete': break;
          case 'archive': case 'restore': case 'tag': {
            const annotations = await persistence.loadImageGenerationAssetAnnotations({ store: target, sessionId, assetId: tile.id });
            if (disposed || token !== epoch) return;
            selection.value = selection.value.map(item => item.id === tile.id ? { ...item, annotations } : item);
            if (inspectedTile.value?.id === tile.id) inspectedTile.value = { ...inspectedTile.value, annotations };
            break;
          }
          default: { const exhaustive: never = action; throw new Error(String(exhaustive)); }
          }
          succeeded.add(tile.id);
        } catch (error) {
          errors.push(`${tile.seed}: ${errorText({ error })}`);
        }
        if (token === epoch) operationProgress.value = { completed: succeeded.size, total: unique.length };
      }
      if (token === epoch && !disposed) {
        switch (action.type) {
        case 'tag': break;
        case 'archive': case 'restore': case 'delete': selection.value = selection.value.filter(tile => !succeeded.has(tile.id)); break;
        default: { const exhaustive: never = action; throw new Error(String(exhaustive)); }
        }
        await refresh({ append: false });
        if (errors.length) {
          const summary = await ensureStrings.imageGeneration__batch_failed({ succeeded: succeeded.size, failed: errors.length });
          if (!disposed && token === epoch) failure.value = summary + '\n' + errors.join('\n');
        }
      }
    } finally {
      mutation.value = false; operationProgress.value = undefined;
    }
  }
  async function retryDeletions(): Promise<void> {
    const target = store.value, pending = [...pendingDeletions.value], token = epoch;
    if (!target || mutation.value || disposed) return;
    mutation.value = true; failure.value = '';
    try {
      for (const item of pending) {
        if (token !== epoch || disposed) break;
        await storageService.deleteImageGenerationOutput({ store: target, ...item, expectedRevision: item.revision });
        if (!disposed && token === epoch) deletedAssetIds.value = [...deletedAssetIds.value, item.assetId];
      }
    } catch (error) {
      if (token === epoch) failure.value = errorText({ error });
    } finally {
      mutation.value = false;
      if (token === epoch && !disposed) await refresh({ append: false });
    }
  }
  async function generate(): Promise<void> {
    if (!available.value) {
      await generation.generate(); return;
    }
    if (busy.value || generation.formDisabled.value || hasPendingSave.value || disposed) return;
    let session = currentSession.value;
    if (!session) session = await newSession({ preserveDraft: true });
    const target = store.value;
    if (!session || !target || !editorReady.value) return;
    const destination = session.id;
    const capture = generation.captureDraft?.();
    const inputs = capture?.request.imageInputs;
    const inputIds = new Set([inputs?.initImage?.binaryObjectId, ...(inputs?.referenceImages.map(image => image.binaryObjectId) ?? [])]);
    const lineage = (sources.get(destination) ?? []).filter(source => source.source.role === 'settings' || source.binaryObjectId && inputIds.has(source.binaryObjectId)).map(source => source.source);
    ownerStore = target;
    owner = createImageGenerationRunSink({ sessionId: destination, count: count.value, sources: lineage,
      persistence: {
        create: ({ run, files }) => storageService.publishImageGeneration({ store: target, publication: { type: 'run', run }, files }),
        commit: async ({ asset, files }) => {
          await storageService.publishImageGeneration({ store: target, publication: { type: 'asset', asset }, files });
          if (!disposed && selectedSessionId.value === destination && store.value?.storeId === target.storeId) void refresh({ append: false });
        },
        update: ({ run, execution }) => persistence.updateImageGenerationRunExecution({ store: target, sessionId: destination, runId: run.id, execution, expectedRevision: run.revision }),
      },
      changed() {
        runRevision.value++;
        if (owner?.snapshot().received) hasGeneratedImages.value = true;
      },
    });
    const acceptedOwner = owner;
    await generation.generate({ submission: acceptedOwner.submission });
    runRevision.value++;
    rememberDraft(); void saveDraft();
    if (!disposed && store.value?.storeId === target.storeId) {
      await refresh({ append: false });
      await restoreActiveDraft();
    }
  }
  async function retrySave(): Promise<void> {
    if (!owner || generation.busy.value || owner.snapshot().saving) return;
    try {
      if (!available.value || store.value?.storeId !== ownerStore?.storeId) throw new Error('Reopen the original Image Generation store before retrying this save.');
      await owner.retry(); failure.value = ''; await refresh({ append: false });
    } catch (error) {
      failure.value = errorText({ error });
    }
  }
  async function editTag({ tagId, name }: { tagId: ImageGenerationTagId | undefined, name: string }): Promise<void> {
    const target = store.value, previous = catalog.value;
    if (!target || !previous || mutation.value) return;
    mutation.value = true; failure.value = '';
    try {
      if (tagId && !previous.tags.some(tag => tag.id === tagId)) throw new Error('The tag no longer exists. Refresh before renaming.');
      const label = imageGenerationTagNameSchema.parse(name), now = Date.now();
      const next = { ...previous, revision: previous.revision + 1, tags: tagId
        ? previous.tags.map(tag => tag.id === tagId ? { ...tag, name: label, updatedAt: now } : tag)
        : [...previous.tags, { id: generateId<ImageGenerationTagId>(), name: label, state: 'active' as const, createdAt: now, updatedAt: now }] };
      await persistence.saveImageGenerationCatalog({ store: target, catalog: next, expectedRevision: previous.revision });
      if (store.value?.storeId === target.storeId) catalog.value = next;
    } catch (error) {
      failure.value = errorText({ error });
    } finally {
      mutation.value = false;
    }
  }
  async function getImage({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | undefined> {
    const target = store.value;
    if (!target || !available.value) return undefined;
    const value = await storageService.getFile({ binaryObjectId });
    return store.value?.storeId === target.storeId && available.value ? value ?? undefined : undefined;
  }
  function hasTag({ tile, tag }: { tile: ImageGenerationTile, tag: ImageGenerationTagReference }): boolean {
    const key = imageGenerationTagReferenceKey({ tag });
    return tile.annotations?.tags.some(assignment => imageGenerationTagReferenceKey({ tag: assignment.tag }) === key) ?? false;
  }
  async function toggleTag({ tile, tag }: { tile: ImageGenerationTile, tag: ImageGenerationTagReference }): Promise<void> {
    const target = store.value;
    if (!target || mutation.value || !tile.annotations) return;
    mutation.value = true; failure.value = '';
    try {
      const key = imageGenerationTagReferenceKey({ tag });
      const tags = tile.annotations?.tags.map(assignment => assignment.tag) ?? [];
      const next = hasTag({ tile, tag }) ? tags.filter(value => imageGenerationTagReferenceKey({ tag: value }) !== key) : [...tags, tag];
      await persistence.setImageGenerationAssetTags({ store: target, sessionId: tile.sessionId, assetId: tile.id, tags: next, assignedAt: Date.now(), expectedRevision: tile.annotations?.revision ?? 0 });
      const updated = await persistence.loadImageGenerationAssetAnnotations({ store: target, sessionId: tile.sessionId, assetId: tile.id });
      if (store.value?.storeId !== target.storeId) return;
      if (inspectedTile.value?.id === tile.id) inspectedTile.value = { ...inspectedTile.value, annotations: updated };
      selection.value = selection.value.map(value => value.id === tile.id ? { ...value, annotations: updated } : value);
      tiles.value = tiles.value.map(value => value.id === tile.id ? { ...value, annotations: updated } : value);
      if (onlyFavorite.value || filterTagId.value) await refresh({ append: false });
    } catch (error) {
      failure.value = errorText({ error });
    } finally {
      mutation.value = false;
    }
  }
  function toggleSelection({ tile }: { tile: ImageGenerationTile }): void {
    const found = selection.value.some(value => value.id === tile.id);
    if (found) selection.value = selection.value.filter(value => value.id !== tile.id);
    else selection.value = [...selection.value, tile];
  }
  async function inspect({ tile }: { tile: ImageGenerationTile }): Promise<void> {
    const target = store.value;
    if (!target || tile.sessionId !== selectedSessionId.value) return;
    const token = ++detailEpoch;
    // Open the viewer immediately. Never show the previous image's parameters
    // while the newly selected image's record is still being loaded.
    inspectedTile.value = tile; details.value = undefined;
    inspectLoading.value = true; inspectFailure.value = '';
    try {
      const value = await promiseAllKeyed({
        asset: persistence.loadImageGenerationAsset({ store: target, sessionId: tile.sessionId, assetId: tile.id }),
        run: persistence.loadImageGenerationRun({ store: target, sessionId: tile.sessionId, runId: tile.runId }),
        annotations: persistence.loadImageGenerationAssetAnnotations({ store: target, sessionId: tile.sessionId, assetId: tile.id }),
      });
      if (token !== detailEpoch || disposed) return;
      if (!value.asset || !value.run || !value.annotations || value.annotations.state === 'deleting' || value.annotations.state === 'deleted') throw new Error('The saved image is unavailable or has been deleted.');
      details.value = { asset: value.asset, run: value.run };
      inspectedTile.value = { ...tile, annotations: value.annotations };
    } catch (error) {
      if (token === detailEpoch) inspectFailure.value = errorText({ error });
    } finally {
      if (token === detailEpoch) inspectLoading.value = false;
    }
  }
  async function reuse({ kind }: { kind: 'settings' | 'prompt' | 'initial' | 'reference' }): Promise<'applied' | 'unavailable'> {
    const selected = details.value, sessionId = selectedSessionId.value, token = epoch;
    if (!selected || !sessionId || !editorReady.value || generation.formDisabled.value || busy.value || disposed) return 'unavailable';
    // Reusing settings can await file/model lookup. Keep the destination bound
    // until it settles; browsing during inference remains a separate operation.
    reusing.value = true; failure.value = ''; generation.historyActions.error.value = '';
    try {
      switch (kind) {
      case 'prompt': generation.parameters.value = { ...generation.parameters.value, prompt: selected.run.request.parameters.prompt }; break;
      case 'settings': {
        const current = generation.captureDraft?.();
        if (!current || !generation.restoreDraft) return 'unavailable';
        await generation.restoreDraft({ draft: { ...current, request: { ...selected.run.request, parameters: { ...selected.run.request.parameters, seed: selected.asset.seed } }, seedMode: 'fixed', files: [], modelSelection: undefined,
          layout: selected.run.request.models.some(model => model.slot === 'model') ? 'checkpoint' : 'components',
          loraStates: selected.run.request.loras.map(lora => ({ enabled: lora.strength !== 0, strength: lora.strength })) } });
        break;
      }
      case 'initial': case 'reference': await generation.useHistoryImage({ binaryObjectId: selected.asset.result.binaryObjectId, role: kind }); break;
      default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
      }
      if (disposed || token !== epoch || selectedSessionId.value !== sessionId || generation.historyActions.error.value) return 'unavailable';
      const role = (() => {
        switch (kind) {
        case 'initial': return 'initial-image' as const;
        case 'reference': return 'reference-image' as const;
        case 'settings': case 'prompt': return 'settings' as const;
        default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
        }
      })();
      const previous = sources.get(sessionId) ?? [];
      sources.set(sessionId, [...previous.filter(entry => entry.source.role !== role || role === 'reference-image'), {
        source: { role, sessionId: selected.asset.sessionId, assetId: selected.asset.id }, binaryObjectId: selected.asset.result.binaryObjectId,
      }]);
      rememberDraft(); void saveDraft();
      return 'applied';
    } finally {
      reusing.value = false;
    }
  }
  function closeDetails(): void {
    detailEpoch++; details.value = undefined; inspectedTile.value = undefined; inspectLoading.value = false; inspectFailure.value = '';
  }
  function setPromptDraft({ field, value }: { field: 'prompt' | 'negativePrompt', value: string }): boolean {
    if (!editorReady.value || generation.draftDisabled.value || busy.value) return false;
    const parameters = generation.parameters.value;
    switch (field) {
    case 'prompt': generation.parameters.value = { ...parameters, prompt: value }; break;
    case 'negativePrompt': generation.parameters.value = { ...parameters, negativePrompt: value }; break;
    default: { const exhaustive: never = field; throw new Error(String(exhaustive)); }
    }
    return true;
  }
  const editor: ImageGenerationView = { ...generation, generate,
    formDisabled: computed(() => generation.formDisabled.value || busy.value || !editorReady.value || hasPendingSave.value),
    draftDisabled: computed(() => generation.draftDisabled.value || busy.value || !editorReady.value),
  };
  watch([text, onlyFavorite, filterTagId, visibility], () => {
    // Coalesce typing; invalidate a pending response immediately so it cannot
    // flash stale matches while the replacement query is being debounced.
    queryEpoch++; clearTimeout(searchTimer);
    nextCursor.value = undefined; tiles.value = []; loading.value = !!store.value && !!selectedSessionId.value;
    searchTimer = setTimeout(() => {
      void refresh({ append: false });
    }, 180);
  }, { flush: 'sync' });
  watch(() => [generation.parameters.value, generation.profile.value, generation.files.value, generation.loras.value, generation.imageInputs.value,
    generation.library.main.value, generation.library.components.value.map(value => value.selected), generation.weightResidency.value,
    generation.gpuBudgetMiB.value, generation.preview.value, generation.seedMode.value, generation.layout.value, generation.debug.value,
    generation.retainModel.value, generation.keepPreviews.value, generation.maxPreviews.value, generation.maxResults.value, count.value], () => {
    touchDraft();
    if (!editorReady.value || generation.draftDisabled.value) return;
    rememberDraft(); clearTimeout(timer); timer = setTimeout(() => {
      void saveDraft();
    }, 500);
  }, { deep: true, flush: 'sync' });
  watch(() => generation.formDisabled.value, value => {
    if (!value) void restoreActiveDraft();
  });
  const unsubscribe = storageService.subscribeToChanges({ listener: ({ event }) => {
    switch (event.type) {
    case 'migration': break;
    case 'chat_meta_and_chat_group': case 'chat_content': case 'chat_content_generation': case 'settings': case 'binary_objects': return;
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
    initialized.value = false;
    epoch++; queryEpoch++; detailEpoch++; storageRevision.value++; touchDraft();
    void queries.dispose(); queries = createImageGenerationQueryClient(); clearTimeout(searchTimer);
    store.value = undefined; catalog.value = undefined; sessions.value = []; selectedSessionId.value = undefined; editingSessionId.value = undefined;
    pendingDeletions.value = []; deletedAssetIds.value = []; operationProgress.value = undefined; visibility.value = 'active';
    hasGeneratedImages.value = false;
    drafts.clear(); attempts.clear(); sources.clear(); tiles.value = []; runs.value = []; runsWithAssets.value = []; selection.value = []; closeDetails();
    clearTimeout(timer); void reload();
  } });
  onMounted(() => {
    void reload();
  });
  onScopeDispose(() => {
    rememberDraft(); void saveDraft(); disposed = true; queryEpoch++; detailEpoch++; clearTimeout(timer); clearTimeout(searchTimer); void queries.dispose(); unsubscribe();
  });
  return { initialized, assistantVisibility, deleteSession, updateSessionTranslation, assistantLayout, experimentalNoticeVisible, updatePreferences, available, catalog, store, sessions, currentSession, selectedSessionId, editorReady, count, loading, switching, starting, mutation, busy,
    failure, warnings, text, visibility, pendingDeletions, deletedAssetIds, operationProgress, curate, retryDeletions, runAssets, connectChat, onlyFavorite, filterTagId, userTags, mode, runs, runsWithAssets, tiles, nextCursor, total, selection, details, draftStatus, draftFailure, draftRevision,
    inspectedTile, inspectLoading, inspectFailure, runState, hasPendingSave, editor, reload, refresh, selectSession, newSession, renameSession, generate, retrySave, editTag, getImage, hasTag, toggleTag, toggleSelection, inspect, closeDetails, setPromptDraft, reuse, saveDraft, flushDraft,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}), };
}
export type ImageGenerationWorkspaceView = ReturnType<typeof useImageGenerationWorkspace>;
export const TEST_ONLY = {
};
