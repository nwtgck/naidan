import { ref } from 'vue';

const needRefresh = ref(false);
const updateHandler = ref<(() => Promise<void>) | undefined>(undefined);

export function usePWAUpdate() {
  const setNeedRefresh = ({ refresh, handler }: {
    refresh: boolean,
    handler: (() => Promise<void>) | undefined
  }) => {
    needRefresh.value = refresh;
    updateHandler.value = handler;
  };

  const update = async () => {
    if (updateHandler.value) {
      await updateHandler.value();
    }
  };

  return {
    needRefresh,
    update,
    setNeedRefresh,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
