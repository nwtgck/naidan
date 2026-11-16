import { defineComponent, h, ref } from 'vue';
import { useLayout } from '@/composables/useLayout';
import ChatSidebarActions from './ChatSidebarActions.vue';
import ChatSidebarContent from './ChatSidebar.vue';
import ChatSidebarModelControls from './ChatSidebarModelControls.vue';

// Exercise the Chat-specific connection without duplicating the global sidebar shell.
export const ChatSidebarTestHost = defineComponent({
  name: 'ChatSidebarTestHost',
  setup() {
    const { isSidebarOpen } = useLayout();
    const chatGroupCreation = ref<'open' | 'closed'>('closed');
    return () => h('div', [
      h(ChatSidebarActions, {
        expanded: isSidebarOpen.value,
        contentReady: true,
        onCreateChatGroup: () => {
          chatGroupCreation.value = 'open';
        },
      }),
      h(ChatSidebarContent, {
        chatGroupCreation: chatGroupCreation.value,
        // Vue v-model listeners receive the emitted scalar value.
        // eslint-disable-next-line local-rules-named-args/require-named-args
        'onUpdate:chatGroupCreation': (value: 'open' | 'closed') => {
          chatGroupCreation.value = value;
        },
      }),
      h(ChatSidebarModelControls, { expanded: isSidebarOpen.value }),
    ]);
  },
});

export const TEST_ONLY = {
};
