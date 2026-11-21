import type { RouteLocationResolved } from 'vue-router';
import type { AppEntryIntent } from '@/composables/useAppEntry';
import { hasModelEntryQuery } from '@/logic/startup/entry-intent';

export type SidebarTarget = 'chat' | 'image_generation' | 'live_conversation' | 'translation' | 'workflow' | 'audio_generation' | 'audio_transcription' | 'developer_tools' | 'settings' | 'model_preview' | 'recovery' | 'pending';

function belongsTo({ path, parent }: { path: string, parent: string }): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

export function resolveSidebarTarget({ route, entryKind }: { route: Pick<RouteLocationResolved, 'path' | 'params' | 'query'> | undefined, entryKind: AppEntryIntent['kind'] }): SidebarTarget {
  if (route === undefined) {
    return 'pending';
  }
  switch (entryKind) {
  case 'model-preview': return 'model_preview';
  case 'home': case 'ordinary': case 'pending': break;
  default: {
    const exhaustive: never = entryKind;
    return exhaustive;
  }
  }
  if (hasModelEntryQuery({ query: route.query })) {
    return 'model_preview';
  }
  // A resolved catch-all can still share a known feature's URL prefix.
  if ('path' in route.params) {
    return 'recovery';
  }
  const path = route.path.replace(/\/+$/, '') || '/';
  if (path === '/' || belongsTo({ path, parent: '/chat' }) || belongsTo({ path, parent: '/chat-group' })) {
    return 'chat';
  }
  if (belongsTo({ path, parent: '/image-generation' })) {
    return 'image_generation';
  }
  if (belongsTo({ path, parent: '/live-conversation' })) {
    return 'live_conversation';
  }
  if (belongsTo({ path, parent: '/translation' })) {
    return 'translation';
  }
  if (belongsTo({ path, parent: '/workflows' })) {
    return 'workflow';
  }
  if (belongsTo({ path, parent: '/audio-generation' })) {
    return 'audio_generation';
  }
  if (belongsTo({ path, parent: '/audio-transcription' })) {
    return 'audio_transcription';
  }
  if (belongsTo({ path, parent: '/debug' }) || belongsTo({ path, parent: '/llama-cpp-browser/diagnostics' })) {
    return 'developer_tools';
  }
  if (belongsTo({ path, parent: '/settings' })) {
    return 'settings';
  }
  return 'recovery';
}

export const TEST_ONLY = {
};
