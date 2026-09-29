import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import LlamaCppBrowserDownloadProgress from './LlamaCppBrowserDownloadProgress.vue';
import type { DownloadProgress } from '@/features/llama-cpp-browser/hugging-face/types';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
describe('download progress appearance', () => {
  const progress: DownloadProgress = { phase: 'transferring', completed: 25, total: 100, processed: 25 };
  it('uses blue only when the welcome appearance is explicitly requested', () => {
    const welcome = mount(LlamaCppBrowserDownloadProgress, { props: { progress, appearance: 'welcome' } });
    const manager = mount(LlamaCppBrowserDownloadProgress, { props: { progress, appearance: 'manager' } });
    expect(welcome.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('25');
    expect(welcome.get('[role="progressbar"] > div').classes()).toContain('bg-blue-600');
    expect(manager.get('[role="progressbar"] > div').classes()).toContain('bg-purple-500');
    expect(welcome.get('[role="progressbar"] > div').classes()).toContain('motion-reduce:transition-none');
    welcome.unmount(); manager.unmount();
  });
  it('does not render NaN or an invalid aria value for an unknown total', () => {
    const wrapper = mount(LlamaCppBrowserDownloadProgress, { props: { progress: { ...progress, completed: 0, total: 0 }, appearance: 'welcome' } });
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('NaN');
    wrapper.unmount();
  });
});
