import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DeveloperOpenStateLinks from './DeveloperOpenStateLinks.vue';
import { urlImportExportLogic } from '@/features/import-export/url-logic';
import { useToast } from '@/composables/useToast';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

vi.mock('@/features/import-export/url-logic', () => ({
  urlImportExportLogic: {
    getExportURL: vi.fn(),
  },
}));

vi.mock('@/composables/useToast', () => ({
  useToast: vi.fn(),
}));

vi.mock('lucide-vue-next', () => ({
  CheckIcon: { template: '<span>Check</span>' },
  MinusIcon: { template: '<span>Minus</span>' },
  CopyIcon: { template: '<span>Copy</span>' },
  ExternalLinkIcon: { template: '<span>ExternalLink</span>' },
  Loader2Icon: { template: '<span>Loader2</span>' },
}));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

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
    expect(wrapper.text()).toContain('naidan-local-only.pages.dev');
    expect(wrapper.text()).toContain('naidan-curated.pages.dev');
    expect(wrapper.text()).toContain('develop.naidan.pages.dev');
    expect(wrapper.text()).toContain('develop.naidan-local-only.pages.dev');
    expect(wrapper.text()).toContain('develop.naidan-curated.pages.dev');
    expect(wrapper.text()).not.toContain('naidan-only-local.pages.dev');
    expect(wrapper.text()).not.toContain('develop.naidan-only-local.pages.dev');
    expect(wrapper.text()).not.toContain('Stable');
    expect(wrapper.text()).not.toContain('Development');
  });

  it('gives every deployment separate, labelled copy and open buttons', () => {
    const wrapper = mount(DeveloperOpenStateLinks);
    const rows = wrapper.findAll('[data-testid^="open-current-state-row-"]');
    expect(rows).toHaveLength(6);

    for (const row of rows) {
      const copyButton = row.get('[data-testid^="copy-current-state-"]');
      const openButton = row.get('[data-testid^="open-current-state-"]');
      expect(copyButton.attributes('type')).toBe('button');
      expect(openButton.attributes('type')).toBe('button');
      expect(copyButton.attributes('aria-label')).toBe(copyButton.attributes('title'));
      expect(openButton.attributes('aria-label')).toBe(openButton.attributes('title'));
      expect(copyButton.attributes('aria-label')).toContain('URL');
      expect(openButton.attributes('aria-label')).toContain('Open');
    }
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
