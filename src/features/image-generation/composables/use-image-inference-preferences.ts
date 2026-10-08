import { areImageInferenceLocationsEqual, isAvailableRemoteImageEditor } from '@/01-models/image-generation-preferences';
import { onScopeDispose, watch, type Ref } from 'vue';
import { idToRaw } from '@/01-models/ids';
import type { Settings } from '@/01-models/types';
import type { ImageInferenceLocationPreference, RemoteImageModelEditorPreference } from '@/01-models/image-generation-preferences';
import type { ImageInferenceLocationView } from './use-image-inference-location';

/** Uses the normal Settings provider. Accepted edits can drain after leaving
 * the view, but can never cross a provider replacement or restore boundary. */
export function useImageInferencePreferences({ settings, initialized, inferenceLocation, captureStorage, updateForStorage, failed }: {
  settings: Readonly<Ref<Settings>>, initialized: Readonly<Ref<boolean>>, inferenceLocation: ImageInferenceLocationView,
  captureStorage(): () => boolean,
  updateForStorage({ isCurrent, updater }: {
    isCurrent(): boolean, updater({ experimental }: { experimental: Settings['experimental'] }): Settings['experimental'],
  }): Promise<'saved' | 'changed'>,
  failed({ error }: { error: unknown }): void,
}): void {
  let hydrated = false, disposed = false, writing = false;
  let isCurrent: (() => boolean) | undefined;
  let previous: ReturnType<ImageInferenceLocationView['capturePreferences']> | undefined;
  let pendingLocation: ImageInferenceLocationPreference | undefined;
  let pendingEditors = new Map<string, RemoteImageModelEditorPreference>();
  const key = ({ preference }: { preference: RemoteImageModelEditorPreference }) => `${idToRaw({ id: preference.registrationId })}:${idToRaw({ id: preference.peerPublicKey })}`;
  function invalidate({ owner }: { owner: (() => boolean) | undefined }): void {
    if (owner !== isCurrent) return;
    hydrated = false; isCurrent = undefined; previous = undefined;
    pendingLocation = undefined; pendingEditors.clear();
  }
  async function save(): Promise<void> {
    if (writing || !isCurrent || (!pendingLocation && !pendingEditors.size)) return;
    const owner = isCurrent;
    if (!owner()) {
      invalidate({ owner }); return;
    }
    const changedLocation = pendingLocation, changedEditors = pendingEditors;
    pendingLocation = undefined; pendingEditors = new Map(); writing = true;
    try {
      const outcome = await updateForStorage({
        isCurrent: owner,
        updater: ({ experimental }) => {
          const base = experimental?.browserImageGeneration;
          const editors = new Map((base?.remoteModelEditors ?? []).filter(isAvailableRemoteImageEditor).map(preference => [key({ preference }), preference]));
          for (const [id, preference] of changedEditors) editors.set(id, preference);
          const merged = (base?.remoteModelEditors ?? []).map(preference => {
            if (!isAvailableRemoteImageEditor(preference)) return preference;
            const id = key({ preference }), next = editors.get(id)!; editors.delete(id); return next;
          });
          merged.push(...editors.values());
          return {
            ...experimental,
            browserImageGeneration: {
              ...base,
              ...(changedLocation ? { inferenceLocation: changedLocation } : {}),
              ...(changedEditors.size ? { remoteModelEditors: merged } : {}),
            },
          };
        },
      });
      switch (outcome) {
      case 'saved': if (!owner()) invalidate({ owner }); break;
      case 'changed': invalidate({ owner }); break;
      default: { const exhaustive: never = outcome; throw new Error(String(exhaustive)); }
      }
    } catch (error) {
      if (!owner()) {
        invalidate({ owner });
      } else {
        pendingLocation ??= changedLocation;
        for (const [id, preference] of changedEditors) if (!pendingEditors.has(id)) pendingEditors.set(id, preference);
        failed({ error }); return;
      }
    } finally {
      writing = false;
    }
    if (pendingLocation || pendingEditors.size) void save();
  }
  watch([initialized, settings], ([ready]) => {
    if (disposed) return;
    if (!ready) {
      invalidate({ owner: isCurrent }); return;
    }
    if (hydrated && isCurrent?.()) return;
    invalidate({ owner: isCurrent });
    isCurrent = captureStorage();
    const saved = settings.value.experimental?.browserImageGeneration;
    inferenceLocation.restorePreferences({ inferenceLocation: saved?.inferenceLocation, remoteModelEditors: saved?.remoteModelEditors });
    previous = inferenceLocation.capturePreferences(); hydrated = true;
  }, { immediate: true, deep: true, flush: 'sync' });
  watch(inferenceLocation.capturePreferences, value => {
    if (!hydrated || disposed || !previous || !isCurrent) return;
    if (!isCurrent()) {
      invalidate({ owner: isCurrent }); return;
    }
    if (!areImageInferenceLocationsEqual({ left: value.inferenceLocation, right: previous.inferenceLocation })) pendingLocation = value.inferenceLocation;
    const oldEditors = new Map(previous.remoteModelEditors.filter(isAvailableRemoteImageEditor).map(preference => [key({ preference }), preference]));
    for (const preference of value.remoteModelEditors.filter(isAvailableRemoteImageEditor)) {
      const id = key({ preference });
      if (JSON.stringify(preference) !== JSON.stringify(oldEditors.get(id))) pendingEditors.set(id, preference);
    }
    previous = value;
    void save();
  }, { deep: true });
  onScopeDispose(() => {
    disposed = true;
  });
}

export const TEST_ONLY = {
};
