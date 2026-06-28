import { watch } from 'vue';
import type { LocationQuery, LocationQueryValue, Router } from 'vue-router';
import { z } from 'zod';
import type { useSettings } from '@/composables/useSettings';
import type { Settings } from '@/models/types';

const EndpointTypeQuerySchema = z.enum(['openai', 'ollama']);

function readOptionalSingleQueryValue({ value }: {
  value: LocationQueryValue | LocationQueryValue[] | undefined,
}): string | undefined {
  const firstValue = Array.isArray(value) ? value[0] : value;
  const parsed = z.string().safeParse(firstValue);
  return parsed.success ? parsed.data : undefined;
}

type SettingsStore = ReturnType<typeof useSettings>;

type ParsedGlobalSettingsQuery =
  | {
    kind: 'no-settings',
    fingerprint: string,
  }
  | {
    kind: 'settings',
    fingerprint: string,
    patch: Pick<Partial<Settings>, 'endpoint' | 'defaultModelId'>,
  };

function parseGlobalSettingsQuery({ query }: {
  query: LocationQuery,
}): ParsedGlobalSettingsQuery {
  const endpointTypeValue = readOptionalSingleQueryValue({
    value: query['global-endpoint-type'],
  });
  const endpointTypeResult = EndpointTypeQuerySchema.safeParse(endpointTypeValue);
  const endpointUrl = readOptionalSingleQueryValue({
    value: query['global-endpoint-url'],
  });
  const modelId = readOptionalSingleQueryValue({
    value: query['global-model'],
  });

  const patch: Pick<Partial<Settings>, 'endpoint' | 'defaultModelId'> = {};
  if (endpointTypeResult.success && endpointUrl !== undefined) {
    patch.endpoint = {
      type: endpointTypeResult.data,
      url: endpointUrl,
    };
  }
  if (modelId !== undefined) {
    patch.defaultModelId = modelId;
  }

  const fingerprint = JSON.stringify({
    endpointType: endpointTypeResult.success ? endpointTypeResult.data : undefined,
    endpointUrl,
    modelId,
  });
  if (Object.keys(patch).length === 0) {
    return {
      kind: 'no-settings',
      fingerprint,
    };
  }

  return {
    kind: 'settings',
    fingerprint,
    patch,
  };
}

async function applyParsedGlobalSettingsQuery({ parsed, settingsStore }: {
  parsed: ParsedGlobalSettingsQuery,
  settingsStore: SettingsStore,
}): Promise<void> {
  switch (parsed.kind) {
  case 'no-settings':
    return;
  case 'settings':
    await settingsStore.save({
      patch: parsed.patch,
      modelRefresh: 'background',
    });
    return;
  default: {
    const _ex: never = parsed;
    return _ex;
  }
  }
}

export async function applyInitialGlobalSettingsQuery({ query, settingsStore }: {
  query: LocationQuery,
  settingsStore: SettingsStore,
}): Promise<string> {
  const parsed = parseGlobalSettingsQuery({ query });
  await applyParsedGlobalSettingsQuery({ parsed, settingsStore });
  return parsed.fingerprint;
}

export function installGlobalSettingsQuerySync({ router, settingsStore, initialFingerprint }: {
  router: Router,
  settingsStore: SettingsStore,
  initialFingerprint: string,
}): () => void {
  let lastFingerprint = initialFingerprint;
  let updateQueue = Promise.resolve();

  return watch(
    () => router.currentRoute.value.query,
    (query) => {
      const parsed = parseGlobalSettingsQuery({ query });
      if (parsed.fingerprint === lastFingerprint) return;
      lastFingerprint = parsed.fingerprint;

      updateQueue = updateQueue
        .catch(() => {
          // A failed URL-driven update must not permanently block later navigations.
        })
        .then(async () => {
          await applyParsedGlobalSettingsQuery({ parsed, settingsStore });
        })
        .catch((error: unknown) => {
          console.error('[naidan] Failed to apply global settings from the URL:', error);
        });
    },
    { immediate: true },
  );
}
