import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DeveloperOpenStateLinks from './DeveloperOpenStateLinks.vue';
import { urlImportExportLogic } from '@/features/import-export/url-logic';
import { useToast } from '@/composables/useToast';

vi.mock('@/features/import-export/url-logic', () => ({
  urlImportExportLogic: {
    getExportURL: vi.fn(),
  },
}));

vi.mock('@/composables/useToast', () => ({
  useToast: vi.fn(),
}));

vi.mock('lucide-vue-next', () => ({
  CopyIcon: { template: '<span>Copy</span>' },
  ExternalLinkIcon: { template: '<span>ExternalLink</span>' },
  Loader2Icon: { template: '<span>Loader2</span>' },
}));

describe('DeveloperOpenStateLinks', () => {
  const addToast = vi.fn();
  const openSpy = vi.fn();
  const writeText = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useToast as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ addToast });
    vi.stubGlobal('open', openSpy);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  it('groups all deployment domains into Production and develop branch', async () => {
    const wrapper = mount(DeveloperOpenStateLinks);

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="open-current-state-group-production"]').text()).toContain('Production');
      expect(wrapper.find('[data-testid="open-current-state-group-develop"]').text()).toContain('develop branch');
    });
    expect(wrapper.text()).toContain('naidan.pages.dev');
    expect(wrapper.text()).toContain('naidan-only-local.pages.dev');
    expect(wrapper.text()).toContain('naidan-curated.pages.dev');
    expect(wrapper.text()).toContain('develop.naidan.pages.dev');
    expect(wrapper.text()).toContain('develop.naidan-only-local.pages.dev');
    expect(wrapper.text()).toContain('develop.naidan-curated.pages.dev');
    expect(wrapper.text()).not.toContain('Stable');
    expect(wrapper.text()).not.toContain('Development');
  });

  it('uses a compact responsive layout with neutral action buttons', () => {
    const wrapper = mount(DeveloperOpenStateLinks);
    const groups = wrapper.find('[data-testid="open-current-state-groups"]');
    const row = wrapper.find('[data-testid="open-current-state-row-naidan.pages.dev"]');
    const openButton = wrapper.find('[data-testid="open-current-state-naidan.pages.dev"]');

    expect(groups.classes()).toEqual(expect.arrayContaining(['grid-cols-1', 'sm:grid-cols-2']));
    expect(row.classes()).toEqual(expect.arrayContaining(['min-h-12', 'py-1.5', 'pl-2.5', 'pr-1.5']));
    expect(openButton.classes()).toEqual(expect.arrayContaining(['h-7', 'w-7', 'rounded-lg']));
    expect(openButton.classes().some(className => className.includes('blue'))).toBe(false);
  });

  it('opens the curated develop deployment with the current state URL', async () => {
    vi.mocked(urlImportExportLogic.getExportURL).mockResolvedValue(
      'https://develop.naidan-curated.pages.dev/#/?storage-type=local&data-zip=abc',
    );
    const wrapper = mount(DeveloperOpenStateLinks);

    await wrapper.find('[data-testid="open-current-state-develop.naidan-curated.pages.dev"]').trigger('click');

    expect(urlImportExportLogic.getExportURL).toHaveBeenCalledWith({
      exclude: [],
      baseUrl: 'https://develop.naidan-curated.pages.dev',
    });
    expect(openSpy).toHaveBeenCalledWith(
      'https://develop.naidan-curated.pages.dev/#/?storage-type=local&data-zip=abc',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('passes selected exclude options when opening a deployment', async () => {
    vi.mocked(urlImportExportLogic.getExportURL).mockResolvedValue('https://naidan.pages.dev/#/?storage-type=local&data-zip=abc');
    const wrapper = mount(DeveloperOpenStateLinks);

    await wrapper.find('[data-testid="open-current-state-exclude-chats"]').setValue(true);
    await wrapper.find('[data-testid="open-current-state-exclude-attachments"]').setValue(true);
    await wrapper.find('[data-testid="open-current-state-naidan.pages.dev"]').trigger('click');

    expect(urlImportExportLogic.getExportURL).toHaveBeenCalledWith({
      exclude: ['chat', 'binary_object'],
      baseUrl: 'https://naidan.pages.dev',
    });
  });

  it('passes chat history exclusion and disables it after excluding chats', async () => {
    vi.mocked(urlImportExportLogic.getExportURL).mockResolvedValue('https://naidan.pages.dev/#/?storage-type=local&data-zip=abc');
    const wrapper = mount(DeveloperOpenStateLinks);
    const history = wrapper.find('[data-testid="open-current-state-exclude-chat-history"]');

    await history.setValue(true);
    await wrapper.find('[data-testid="open-current-state-naidan.pages.dev"]').trigger('click');

    expect(urlImportExportLogic.getExportURL).toHaveBeenCalledWith({
      exclude: ['chat_history'],
      baseUrl: 'https://naidan.pages.dev',
    });

    await wrapper.find('[data-testid="open-current-state-exclude-chats"]').setValue(true);
    await nextTick();
    expect((history.element as HTMLInputElement).checked).toBe(false);
    expect(history.attributes('disabled')).toBeDefined();
  });

  it('copies the curated production deployment URL', async () => {
    vi.mocked(urlImportExportLogic.getExportURL).mockResolvedValue(
      'https://naidan-curated.pages.dev/#/?storage-type=local&data-zip=abc',
    );
    const wrapper = mount(DeveloperOpenStateLinks);

    await wrapper.find('[data-testid="copy-current-state-naidan-curated.pages.dev"]').trigger('click');

    expect(writeText).toHaveBeenCalledWith('https://naidan-curated.pages.dev/#/?storage-type=local&data-zip=abc');
    await vi.waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        message: 'Copied URL for naidan-curated.pages.dev',
        duration: 3000,
      });
    });
  });

  it('shows a toast when URL generation fails', async () => {
    vi.mocked(urlImportExportLogic.getExportURL).mockRejectedValue(new Error('too large'));
    const wrapper = mount(DeveloperOpenStateLinks);

    await wrapper.find('[data-testid="open-current-state-naidan.pages.dev"]').trigger('click');

    await vi.waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        message: 'Failed to open current state URL: too large',
        duration: 5000,
      });
    });
    expect(openSpy).not.toHaveBeenCalled();
  });
});
