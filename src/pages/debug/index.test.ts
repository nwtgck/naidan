import { mount, RouterLinkStub } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import DebugIndexPage from './index.vue';
import { DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH } from '@/services/debug-file-protocol-standalone/verification/report';

describe('DebugIndexPage', () => {
  it('links to the standalone verification page', () => {
    const wrapper = mount(DebugIndexPage, {
      global: {
        stubs: {
          RouterLink: RouterLinkStub,
        },
      },
    });

    const link = wrapper.get('[data-testid="standalone-verification-link"]');
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe(DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH);
    expect(link.text()).toContain('File-protocol standalone verification');
  });
});
