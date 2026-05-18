import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import DeveloperOpenStateLinks from './DeveloperOpenStateLinks.vue';
import { urlImportExportLogic } from '@/services/import-export/url-logic';
import { useToast } from '@/composables/useToast';

vi.mock('@/services/import-export/url-logic', () => ({
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

  it('renders deployment domains without environment labels', () => {
    const wrapper = mount(DeveloperOpenStateLinks);

    expect(wrapper.text()).toContain('naidan.pages.dev');
    expect(wrapper.text()).toContain('naidan-only-local.pages.dev');
    expect(wrapper.text()).toContain('develop.naidan.pages.dev');
    expect(wrapper.text()).toContain('develop.naidan-only-local.pages.dev');
    expect(wrapper.text()).not.toContain('Production');
  });

  it('opens the selected deployment with the current state URL', async () => {
    vi.mocked(urlImportExportLogic.getExportURL).mockResolvedValue('https://develop.naidan.pages.dev/#/?storage-type=local&data-zip=abc');
    const wrapper = mount(DeveloperOpenStateLinks);

    await wrapper.find('[data-testid="open-current-state-develop.naidan.pages.dev"]').trigger('click');

    expect(urlImportExportLogic.getExportURL).toHaveBeenCalledWith({
      exclude: [],
      baseUrl: 'https://develop.naidan.pages.dev',
    });
    expect(openSpy).toHaveBeenCalledWith(
      'https://develop.naidan.pages.dev/#/?storage-type=local&data-zip=abc',
      '_blank',
      'noopener,noreferrer'
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

  it('copies the selected deployment URL', async () => {
    vi.mocked(urlImportExportLogic.getExportURL).mockResolvedValue('https://naidan-only-local.pages.dev/#/?storage-type=local&data-zip=abc');
    const wrapper = mount(DeveloperOpenStateLinks);

    await wrapper.find('[data-testid="copy-current-state-naidan-only-local.pages.dev"]').trigger('click');

    expect(writeText).toHaveBeenCalledWith('https://naidan-only-local.pages.dev/#/?storage-type=local&data-zip=abc');
    expect(addToast).toHaveBeenCalledWith({
      message: 'Copied URL for naidan-only-local.pages.dev',
      duration: 3000,
    });
  });

  it('shows a toast when URL generation fails', async () => {
    vi.mocked(urlImportExportLogic.getExportURL).mockRejectedValue(new Error('too large'));
    const wrapper = mount(DeveloperOpenStateLinks);

    await wrapper.find('[data-testid="open-current-state-naidan.pages.dev"]').trigger('click');

    expect(addToast).toHaveBeenCalledWith({
      message: 'Failed to open current state URL: too large',
      duration: 5000,
    });
    expect(openSpy).not.toHaveBeenCalled();
  });
});
