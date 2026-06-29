import { mount, RouterLinkStub } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

import DebugIndexPage from './index.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH } from '@/features/file-protocol-standalone/debug/verification/report';

describe('DebugIndexPage', () => {
  beforeAll(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

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
