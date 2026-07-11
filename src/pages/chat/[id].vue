<script setup lang="ts">
import { watch, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import CurrentChatPane from '@/components/CurrentChatPane.vue';
import { toChatId, toMessageId } from '@/01-models/ids';
import {
  useInitialRouteRenderReadinessClaim,
} from '@/logic/startup/initial-route-render-readiness';

const router = useRouter();
const currentRoute = computed(() => router?.currentRoute?.value);
const chatNavigation = useChatNavigation();
const initialRouteRenderReadiness = useInitialRouteRenderReadinessClaim();

const chatId = computed(() => {
  const params = currentRoute.value?.params;
  // Use a type guard or check property existence to satisfy TS
  if (params && 'id' in params) {
    return params.id as string;
  }
  return undefined;
});

const leafId = computed(() => currentRoute.value?.query?.leaf?.toString());
const messageId = computed(() => {
  const raw = currentRoute.value?.query?.['message-id']?.toString();
  return raw === undefined ? undefined : toMessageId({ raw });
});

async function syncChat() {
  const id = chatId.value;
  if (id) {
    if (messageId.value) {
      await chatNavigation.openChatAtMessage({
        chatId: toChatId({ raw: id }),
        messageId: messageId.value,
      });
    } else {
      await chatNavigation.openChat({
        chatId: toChatId({ raw: id }),
        leafId: leafId.value === undefined ? undefined : toMessageId({ raw: leafId.value }),
      });
    }
  }
}

function handleAutoSent() {
  const query = { ...currentRoute.value?.query };
  delete query.q;
  router.replace({ query });
}

onMounted(async () => {
  try {
    await syncChat();
    // openChat updates CurrentChatPane reactively. Wait for that DOM update so
    // encrypted startup removes its lock only after the real ChatPane exists,
    // not when this route wrapper happened to mount.
    await nextTick();
    initialRouteRenderReadiness.reportReady();
  } catch (error) {
    initialRouteRenderReadiness.reportFailure({ error });
    throw error;
  }
});
onUnmounted(() => {
  initialRouteRenderReadiness.cancel();
});
watch([chatId, leafId, messageId], syncChat);


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <CurrentChatPane
    v-if="chatId"
    :auto-send-prompt="currentRoute?.query?.q?.toString()"
    :target-message-id="messageId"
    @auto-sent="handleAutoSent"
  />
</template>

<style scoped>
.fade-enter-active {
  transition: opacity 0.15s ease-out, transform 0.15s ease-out;
}

.fade-enter-from {
  opacity: 0;
  transform: translateY(2px);
}

/* We don't use leave-active to keep navigation instant */
</style>
