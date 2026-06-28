import { toChatId } from '@/models/ids';
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import ChatApprovalPanel from './ChatApprovalPanel.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { APPROVAL_ACTIONS } from '@/services/approval';

function mountPanel({
  preview,
}: {
  preview: {
    type: 'wikipedia_search',
    keyword: string,
  } | {
    type: 'wikipedia_get_page',
    title: string | undefined,
    pageId: string,
  },
}) {
  return mount(ChatApprovalPanel, {
    props: {
      request: {
        requestId: 'approval-test-request',
        chatId: toChatId({ raw: 'chat-test' }),
        action: preview.type === 'wikipedia_search'
          ? APPROVAL_ACTIONS.toolWikipediaSearch
          : APPROVAL_ACTIONS.toolWikipediaGetPage,
        preview,
      },
    },
  });
}

describe('ChatApprovalPanel', () => {
  beforeAll(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  it('renders compact Wikipedia search approval details', () => {
    const wrapper = mountPanel({
      preview: {
        type: 'wikipedia_search',
        keyword: 'Apollo 11',
      },
    });

    expect(wrapper.text()).toContain('Allow Search Wikipedia?');
    expect(wrapper.text()).toContain('Keyword:');
    expect(wrapper.text()).toContain('Apollo 11');
  });

  it('renders Wikipedia page title as the primary get page approval detail', () => {
    const wrapper = mountPanel({
      preview: {
        type: 'wikipedia_get_page',
        title: 'Apollo 11',
        pageId: '12345',
      },
    });

    expect(wrapper.text()).toContain('Allow Get Wikipedia page?');
    expect(wrapper.text()).toContain('Apollo 11');
    expect(wrapper.text()).toContain('Page ID: 12345');
  });

  it('shows the action label on durable approval decisions', () => {
    const wrapper = mountPanel({
      preview: {
        type: 'wikipedia_search',
        keyword: 'Apollo 11',
      },
    });

    expect(wrapper.get('[data-testid="approval-allow-once"]').text()).toBe('Allow once');
    expect(wrapper.get('[data-testid="approval-allow-for-chat"]').text()).toContain('Allow for this chat');
    expect(wrapper.get('[data-testid="approval-allow-for-chat"]').text()).toContain('Search Wikipedia');
    expect(wrapper.get('[data-testid="approval-allow-globally"]').text()).toContain('Allow globally');
    expect(wrapper.get('[data-testid="approval-allow-globally"]').text()).toContain('Search Wikipedia');
  });
});
