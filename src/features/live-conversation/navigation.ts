import { shallowRef, type Ref } from 'vue';

export type LiveConversationPanel = 'conversation' | 'diagnostics';
export type LiveInvestigationTask = 'response' | 'transcription';
export type LiveConversationNavigation = {
  panel: Readonly<Ref<LiveConversationPanel>>,
  modelName: Readonly<Ref<string>>,
  fileName: Readonly<Ref<string | undefined>>,
  busy: Readonly<Ref<boolean>>,
  canReset: Readonly<Ref<boolean>>,
  openConversation: () => void,
  openDiagnostics: () => void,
  newConversation: () => Promise<void>,
  openSettings: () => void,
};
const active = shallowRef<LiveConversationNavigation>();

export function useLiveConversationNavigation() {
  return { active, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export function registerLiveConversationNavigation({ navigation }: { navigation: LiveConversationNavigation }): () => void {
  if (active.value) {
    throw new Error('A Live Conversation navigation owner is already mounted.');
  }
  active.value = navigation;
  return () => {
    if (active.value === navigation) {
      active.value = undefined;
    }
  };
}

export const TEST_ONLY = {
};
