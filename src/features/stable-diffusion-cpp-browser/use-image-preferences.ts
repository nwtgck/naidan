import { onScopeDispose, watch, type Ref } from 'vue';
import { DEFAULT_BROWSER_IMAGE_GENERATION_SETTINGS, type BrowserImageGenerationSettings, type BrowserImageModelSelection, type Settings } from '@/01-models/types';
import { idToRaw, toHostModelDirectoryId } from '@/01-models/ids';
import { parametersSchema, previewSettingsSchema } from './types';
import type { createImageForm } from '@/features/image-generation/form';
import type { ImageLibraryView } from './library-view';

/** The editor stores preferences, never a draft prompt, image or temporary File. */
export function useImagePreferences({ settings, initialized, captureStorage, updateForStorage, form, seedMode, historyEnabled, library, localModels, restoring, restored, failed }: {
  settings: Readonly<Ref<Settings>>,
  initialized: Readonly<Ref<boolean>>,
  captureStorage(): () => boolean,
  updateForStorage: ({ isCurrent, updater }: { isCurrent(): boolean, updater: ({ experimental }: { experimental: Settings['experimental'] }) => Settings['experimental'] }) => Promise<'saved' | 'changed'>,
  form: ReturnType<typeof createImageForm>, seedMode: Ref<'random' | 'fixed'>, historyEnabled: Ref<boolean>,
  library: ImageLibraryView, localModels: Readonly<Ref<boolean>>, restoring: Ref<boolean>,
  restored: ({ missing, missingInactive }: { missing: string[], missingInactive: string[] }) => void,
  failed: ({ error }: { error: unknown }) => void,
}) {
  let disposed = false, hydrated = false, writing = false;
  let previous: BrowserImageGenerationSettings = {};
  let pending: BrowserImageGenerationSettings = {};
  let deferredModelSelection: BrowserImageModelSelection | undefined;
  let storageOwner: (() => boolean) | undefined;
  const defaults = DEFAULT_BROWSER_IMAGE_GENERATION_SETTINGS;
  function snapshot(): BrowserImageGenerationSettings {
    const parameters = form.parameters.value;
    const width = parametersSchema.shape.width.safeParse(parameters.width);
    const height = parametersSchema.shape.height.safeParse(parameters.height);
    const seed = parametersSchema.shape.seed.safeParse(parameters.seed);
    const preview = form.preview.value;
    const interval = previewSettingsSchema.shape.interval.safeParse(preview.interval);
    const startStep = previewSettingsSchema.shape.startStep.safeParse(preview.startStep);
    const maxEdge = previewSettingsSchema.shape.maxEdge.safeParse(preview.maxEdge);
    const maxPreviews = form.maxPreviews.value, maxResults = form.maxResults.value;
    const modelSelection = library.captureModelSelection({ loras: form.loras.value });
    const destination = library.hostDirectories.destination.value;
    return {
      ...(width.success ? { width: width.data } : {}), ...(height.success ? { height: height.data } : {}),
      seedMode: seedMode.value, ...(seed.success && seed.data !== '-1' ? { seed: seed.data } : {}),
      debug: form.debug.value,
      historyPersistence: historyEnabled.value ? 'enabled' : 'disabled',
      modelDownloadDestination: destination === 'opfs' ? { kind: 'opfs' } : { kind: 'host', directoryId: toHostModelDirectoryId({ raw: destination }) },
      imageDownload: { ...form.imageDownloadPreferences.value },
      ...(modelSelection ? { modelSelection } : {}),
      preview: { enabled: preview.enabled ? 'enabled' : 'disabled', mode: preview.mode,
        ...(interval.success ? { interval: interval.data } : {}), ...(startStep.success ? { startStep: startStep.data } : {}), ...(maxEdge.success ? { maxEdge: maxEdge.data } : {}) },
      keepPreviews: form.keepPreviews.value ? 'enabled' : 'disabled',
      ...(Number.isInteger(maxPreviews) && maxPreviews >= 1 && maxPreviews <= 100 ? { maxPreviews } : {}),
      ...(Number.isInteger(maxResults) && maxResults >= 1 && maxResults <= 100 ? { maxResults } : {}),
      bf16WeightType: parameters.bf16WeightType,
    };
  }
  function merge({ base, patch }: { base: BrowserImageGenerationSettings | undefined, patch: BrowserImageGenerationSettings }): BrowserImageGenerationSettings {
    return { ...base, ...patch,
      ...(patch.preview ? { preview: { ...base?.preview, ...patch.preview } } : {}),
      ...(patch.imageDownload ? { imageDownload: { ...base?.imageDownload, ...patch.imageDownload } } : {}),
    };
  }
  async function save(): Promise<void> {
    if (writing || !storageOwner || !Object.keys(pending).length) return;
    if (!storageOwner()) {
      pending = {}; return;
    }
    writing = true;
    const patch = pending; pending = {};
    try {
      // The updater executes against the latest settings under the existing
      // storage lock, preserving concurrent locale/host-directory changes.
      const outcome = await updateForStorage({ isCurrent: storageOwner, updater: ({ experimental }) => ({ ...experimental,
        browserImageGeneration: merge({ base: experimental?.browserImageGeneration, patch }),
      }) });
      switch (outcome) {
      case 'saved': if (!storageOwner()) pending = {}; break;
      case 'changed': pending = {}; break;
      default: { const exhaustive: never = outcome; throw new Error(String(exhaustive)); }
      }
    } catch (error) {
      if (!storageOwner()) {
        pending = {}; return;
      }
      pending = merge({ base: patch, patch: pending });
      failed({ error });
      return;
    } finally {
      writing = false;
    }
    // Accepted edits survive leaving the screen while an earlier write waits.
    if (Object.keys(pending).length) void save();
  }
  watch(snapshot, value => {
    if (!hydrated || restoring.value || disposed || !storageOwner?.()) return;
    const patch: BrowserImageGenerationSettings = {};
    // This is a partial patch: absent/invalid draft fields leave their last
    // valid stored values intact rather than resetting the entire group.
    for (const key of Object.keys(value) as (keyof BrowserImageGenerationSettings)[]) {
      if (JSON.stringify(value[key]) !== JSON.stringify(previous[key])) Object.assign(patch, { [key]: value[key] });
    }
    previous = value;
    if (!Object.keys(patch).length) return;
    pending = merge({ base: pending, patch }); void save();
  }, { deep: true });
  watch(initialized, async ready => {
    if (!ready || hydrated || restoring.value || disposed) return;
    storageOwner = captureStorage();
    restoring.value = true;
    try {
      const saved = settings.value.experimental?.browserImageGeneration;
      const { width, height, seedMode: savedSeedMode, seed, debug, historyPersistence, modelDownloadDestination, imageDownload, modelSelection, inferenceLocation: _inferenceLocation, remoteModelEditors: _remoteModelEditors, preview, keepPreviews, maxPreviews, maxResults, bf16WeightType, ...unhandled } = saved ?? {};
      unhandled satisfies Record<PropertyKey, never>;
      form.parameters.value = { ...form.parameters.value, width: width ?? defaults.width, height: height ?? defaults.height,
        seed: seed ?? defaults.seed, bf16WeightType: bf16WeightType ?? defaults.bf16WeightType };
      seedMode.value = savedSeedMode ?? defaults.seedMode;
      form.debug.value = debug ?? defaults.debug;
      historyEnabled.value = (historyPersistence ?? defaults.historyPersistence) === 'enabled';
      form.imageDownloadPreferences.value = { format: imageDownload?.format ?? defaults.imageDownload.format, metadata: imageDownload?.metadata ?? defaults.imageDownload.metadata };
      form.preview.value = { enabled: (preview?.enabled ?? defaults.preview.enabled) === 'enabled', mode: preview?.mode ?? defaults.preview.mode,
        interval: preview?.interval ?? defaults.preview.interval, startStep: preview?.startStep ?? defaults.preview.startStep, maxEdge: preview?.maxEdge ?? defaults.preview.maxEdge };
      form.keepPreviews.value = (keepPreviews ?? defaults.keepPreviews) === 'enabled';
      form.maxPreviews.value = maxPreviews ?? defaults.maxPreviews; form.maxResults.value = maxResults ?? defaults.maxResults;
      const destination = modelDownloadDestination ?? defaults.modelDownloadDestination;
      switch (destination.kind) {
      case 'opfs': library.hostDirectories.destination.value = 'opfs'; break;
      case 'host': library.hostDirectories.destination.value = idToRaw({ id: destination.directoryId }); break;
      default: { const exhaustive: never = destination; throw new Error(String(exhaustive)); }
      }
      deferredModelSelection = modelSelection;
      if (modelSelection && localModels.value) {
        // Suppress first-inventory auto-selection before scanning local files.
        library.useManualFiles(); await library.prepareHistoryFiles();
        if (disposed || !storageOwner()) return;
        const result = library.restoreModelSelection({ selection: modelSelection });
        form.loras.value = result.loras;
        restored({ missing: result.missing, missingInactive: result.missingInactive });
        deferredModelSelection = undefined;
      }
      previous = snapshot(); hydrated = true;
    } catch (error) {
      if (!disposed) failed({ error });
      // Keep the editor usable and permit subsequent explicit preference edits.
      previous = snapshot(); hydrated = true;
    } finally {
      restoring.value = false;
    }
  }, { immediate: true });
  watch(localModels, async local => {
    if (!local || !hydrated || !deferredModelSelection || restoring.value || disposed || !storageOwner?.()) return;
    const selection = deferredModelSelection;
    restoring.value = true;
    try {
      library.useManualFiles(); await library.prepareHistoryFiles();
      if (disposed || !storageOwner()) return;
      const result = library.restoreModelSelection({ selection });
      form.loras.value = result.loras;
      restored({ missing: result.missing, missingInactive: result.missingInactive });
      deferredModelSelection = undefined; previous = snapshot();
    } catch (error) {
      if (!disposed) failed({ error });
    } finally {
      restoring.value = false;
    }
  });
  onScopeDispose(() => {
    disposed = true;
  });
  return {
    discardDeferredModelSelection(): void {
      // A session or history request owns its explicit local configuration.
      deferredModelSelection = undefined;
    },
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}
export const TEST_ONLY = {
};
