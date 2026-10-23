import type { LocationQuery } from 'vue-router';
import type { Settings } from '@/01-models/types';
import { isConfiguredEndpoint } from '@/01-models/endpoint';

export const MODEL_ENTRY_QUERY = 'llama-cpp-browser-model';

export function hasModelEntryQuery({ query }: { query: LocationQuery }): boolean {
  return query[MODEL_ENTRY_QUERY] !== undefined;
}

export function hasSelectedGlobalChatModel({ settings }: { settings: Pick<Settings, 'endpoint' | 'defaultModelId'> }): boolean {
  return settings.endpoint.type === 'unsupported_experimental_endpoint'
    || (isConfiguredEndpoint({ endpoint: settings.endpoint }) && !!settings.defaultModelId);
}

export function resolveAppEntryKind({ route, initialized }: {
  route: { path: string, query: LocationQuery },
  initialized: boolean,
}): 'pending' | 'home' | 'model-preview' | 'ordinary' {
  if (hasModelEntryQuery({ query: route.query })) {
    return 'model-preview';
  }
  if (route.path !== '/' || route.query.q !== undefined || route.query.settings !== undefined) {
    return 'ordinary';
  }
  if (!initialized) {
    return 'pending';
  }
  return 'home';
}

export function shouldDeferInitialModelRefresh({ route }: { route: { path: string, query: LocationQuery } }): boolean {
  return hasModelEntryQuery({ query: route.query }) || route.path === '/';
}

export const TEST_ONLY = {
};
