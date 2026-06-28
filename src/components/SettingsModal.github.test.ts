import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import AboutTab from './AboutTab.vue';

// Global constant mock
(global as any).__BUILD_MODE_IS_STANDALONE__ = false;
(global as any).__APP_VERSION__ = '0.5.1-test';

describe('AboutTab GitHub Link', () => {
  it('should contain GitHub link with correct structure', async () => {
    const wrapper = mount(AboutTab, {
      global: {
        stubs: {
          'router-link': true,
          'Logo': true,
          // Icons
          GithubIcon: true,
          ExternalLinkIcon: true,
          InfoIcon: true,
          ShieldCheckIcon: true,
          DownloadIcon: true,
          Loader2Icon: true,
        },
      },
    });

    const githubLink = wrapper.find('a[href*="github.com/nwtgck/naidan"]');
    expect(githubLink.exists()).toBe(true);

    // Check translated copy after the lazy string boundary is registered.
    await vi.waitFor(() => {
      expect(githubLink.text()).toContain('GitHub Repository');
      expect(githubLink.text()).toContain('View source code & contribute');
    });
  });
});
