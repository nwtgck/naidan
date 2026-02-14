import { describe, it, expect } from 'vitest';
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
          Github: true,
          ExternalLink: true,
          Info: true,
          ShieldCheck: true,
          Download: true,
          Loader2: true,
        }
      }
    });

    const githubLink = wrapper.find('a[href*="github.com/nwtgck/naidan"]');
    expect(githubLink.exists()).toBe(true);

    // Check for "GitHub Repository" text
    expect(githubLink.text()).toContain('GitHub Repository');

    // Check for the description text
    expect(githubLink.text()).toContain('View source code & contribute');
  });
});
