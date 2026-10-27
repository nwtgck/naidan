import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useImportExportModal } from '@/features/import-export/composables/useImportExportModal';
import type { CspHintMessage } from '@/logic/csp-message-hints/types';
import CspDeploymentGuidance from './CspDeploymentGuidance.vue';

const standard = { id: 'standard' } as const;
const curated = { id: 'curated' } as const;

const mocks = vi.hoisted(() => ({ getExportURL: vi.fn() }));
vi.mock('@/features/import-export/url-logic', () => ({ urlImportExportLogic: { getExportURL: mocks.getExportURL } }));
enableAutoUnmount(afterEach);

beforeEach(async () => {
  mocks.getExportURL.mockReset();
  const modal = useImportExportModal();
  if (modal.request.value !== undefined) {
    modal.close({ requestId: modal.request.value.id });
  }
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  const modal = useImportExportModal();
  if (modal.request.value !== undefined) {
    modal.close({ requestId: modal.request.value.id });
  }
  vi.restoreAllMocks();
});

async function renderGuidance({ deployments }: { deployments: CspHintMessage['suggestedDeployments'] }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/chat/demo?settings=developer&mode=keep#selection');
  await router.isReady();
  return mount(CspDeploymentGuidance, { attachTo: document.body, props: { deployments }, global: { plugins: [router] } });
}

function installClipboard({ writeText }: { writeText: Clipboard['writeText'] | undefined }) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: writeText === undefined ? undefined : { writeText } });
  return {
    [Symbol.dispose]() {
      if (previous === undefined) {
        Reflect.deleteProperty(navigator, 'clipboard');
      } else {
        Object.defineProperty(navigator, 'clipboard', previous);
      }
    },
  };
}

describe('deployment guidance and explicit data transfer', () => {
  it('shows only the supplied destinations and starts with transfer details open without exporting', async () => {
    const wrapper = await renderGuidance({ deployments: [curated] });
    expect(wrapper.get('h4').text()).toBe('How to ease connection restrictions');
    expect(wrapper.text()).toContain('Try connecting on these Naidan sites');
    expect(wrapper.text()).toContain('This guidance is based on the public editions’ connection policies.');
    const publicLink = wrapper.get('[data-testid="csp-deployment-curated"]');
    expect(publicLink.attributes('href')).toBe('https://naidan-curated.pages.dev/');
    expect(publicLink.text()).toBe('https://naidan-curated.pages.dev');
    expect(publicLink.attributes('target')).toBe('_blank');
    expect(publicLink.attributes('rel')).toBe('noopener noreferrer');
    expect(wrapper.find('[data-testid="csp-deployment-standard"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="csp-transfer-toggle"]').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-testid="csp-url-transfer-toggle"]').attributes('aria-expanded')).toBe('true');
    expect(mocks.getExportURL).not.toHaveBeenCalled();

    expect(wrapper.find('[data-testid="csp-transfer-storage"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="csp-transfer-export"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="csp-transfer-saved-development-csp"]').text()).toBe('If you saved a development CSP, it may be applied again when you restore settings on the other site.');
    const importInstructions = wrapper.get('[data-testid="csp-transfer-import-instructions"]');
    expect(importInstructions.findAll('p').map(paragraph => paragraph.text())).toEqual([
      'Each site keeps its own data.',
      'On the other site, import your exported file as follows:',
    ]);
    expect(importInstructions.findAll('li').map(item => item.text())).toEqual([
      'Open Settings → Storage → Import / Export.',
      'Choose Import and select your exported file.',
    ]);
    expect(wrapper.find('[data-testid="csp-transfer-create-curated"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="csp-transfer-destination-curated"]').text()).toBe('https://naidan-curated.pages.dev');
    expect(useImportExportModal().request.value).toBeUndefined();
    await wrapper.get('[data-testid="csp-url-transfer-toggle"]').trigger('click');
    expect(wrapper.get('[data-testid="csp-url-transfer-toggle"]').attributes('aria-expanded')).toBe('false');
    expect(mocks.getExportURL).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="csp-url-transfer-toggle"]').trigger('click');
    expect(wrapper.get('[data-testid="csp-url-transfer-toggle"]').attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('[data-testid="csp-transfer-create-curated"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="csp-transfer-create-standard"]').exists()).toBe(false);
    expect(mocks.getExportURL).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="csp-transfer-toggle"]').trigger('click');
    expect(wrapper.get('[data-testid="csp-transfer-toggle"]').attributes('aria-expanded')).toBe('false');
    expect(mocks.getExportURL).not.toHaveBeenCalled();
  });

  it('shows every supplied destination as a plain URL list without exporting', async () => {
    const wrapper = await renderGuidance({ deployments: [standard, curated] });
    const links = wrapper.findAll('[data-testid^="csp-deployment-"]').filter(element => element.element.tagName === 'A');
    expect(links.map(link => link.text())).toEqual(['https://naidan.pages.dev', 'https://naidan-curated.pages.dev']);
    expect(links.map(link => link.attributes('href'))).toEqual(['https://naidan.pages.dev/', 'https://naidan-curated.pages.dev/']);
    expect(links.map(link => link.element.parentElement?.tagName)).toEqual(['LI', 'LI']);
    expect(links.map(link => link.element.parentElement?.textContent?.trim())).toEqual(['https://naidan.pages.dev', 'https://naidan-curated.pages.dev']);
    expect(mocks.getExportURL).not.toHaveBeenCalled();
    expect(useImportExportModal().request.value).toBeUndefined();
  });

  it('keeps a stable URL order and lists duplicate supplied destinations once', async () => {
    const wrapper = await renderGuidance({ deployments: [curated, standard, curated] });
    const links = wrapper.findAll('[data-testid^="csp-deployment-"]').filter(element => element.element.tagName === 'A');
    expect(links.map(link => link.text())).toEqual(['https://naidan.pages.dev', 'https://naidan-curated.pages.dev']);
    expect(mocks.getExportURL).not.toHaveBeenCalled();
  });

  it('keeps an independently known destination when another candidate cannot be described', async () => {
    const broken: CspHintMessage['suggestedDeployments'][number] = {
      get id(): 'curated' {
        throw new Error('Private optional candidate description failure');
      },
    };
    const wrapper = await renderGuidance({ deployments: [standard, curated] });
    expect(wrapper.find('[data-testid="csp-deployment-curated"]').exists()).toBe(true);
    // Mount inspects nested props before setup; inject this fault only on update.
    await wrapper.setProps({ deployments: [standard, broken] });
    expect(wrapper.get('[data-testid="csp-deployment-standard"]').text()).toBe('https://naidan.pages.dev');
    expect(wrapper.find('[data-testid="csp-deployment-curated"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Private optional candidate description failure');
    expect(mocks.getExportURL).not.toHaveBeenCalled();
  });

  it('updates the candidate list without creating another transfer URL automatically', async () => {
    mocks.getExportURL.mockResolvedValue('https://naidan-curated.pages.dev/#/?data-zip=selected');
    const wrapper = await renderGuidance({ deployments: [standard, curated] });
    await wrapper.get('[data-testid="csp-transfer-create-curated"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="csp-transfer-open-curated"]').attributes('href')).toBe('https://naidan-curated.pages.dev/#/?data-zip=selected');
    await wrapper.setProps({ deployments: [standard] });
    expect(wrapper.find('[data-testid="csp-deployment-curated"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="csp-deployment-standard"]').text()).toBe('https://naidan.pages.dev');
    expect(wrapper.find('[data-testid="csp-transfer-open-curated"]').exists()).toBe(false);
    expect(mocks.getExportURL).toHaveBeenCalledExactlyOnceWith({ exclude: [], baseUrl: 'https://naidan-curated.pages.dev/' });
  });

  it('shows the requested Japanese heading with both plain destination URLs', async () => {
    await ensureAllStringsForTest({ locale: 'ja' });
    const wrapper = await renderGuidance({ deployments: [standard, curated] });
    expect(wrapper.text()).toContain('接続を試せるNaidan');
    expect(wrapper.get('[data-testid="csp-deployment-standard"]').text()).toBe('https://naidan.pages.dev');
    expect(wrapper.get('[data-testid="csp-deployment-curated"]').text()).toBe('https://naidan-curated.pages.dev');
    expect(mocks.getExportURL).not.toHaveBeenCalled();
  });

  it('requests the export screen explicitly before the import instructions and keeps that request after dismissal', async () => {
    const wrapper = await renderGuidance({ deployments: [standard] });
    const modal = useImportExportModal();
    const panel = wrapper.get('[data-testid="csp-data-transfer"]');
    expect(panel.text().indexOf('Export data')).toBeLessThan(panel.text().indexOf('Each site keeps its own data.'));
    expect(wrapper.find('[data-testid="csp-transfer-exclude-chats"]').exists()).toBe(true);
    expect(mocks.getExportURL).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="csp-transfer-export"]').trigger('click');
    expect(modal.request.value).toMatchObject({ initialMode: 'export', status: 'loading' });
    expect(wrapper.get('[data-testid="csp-transfer-export"]').attributes('disabled')).toBeDefined();
    expect(mocks.getExportURL).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(modal.request.value).toMatchObject({ initialMode: 'export', status: 'loading' });
  });

  it('keeps a modal loading failure local and offers Storage settings without exposing the exception', async () => {
    const wrapper = await renderGuidance({ deployments: [standard] });
    const modal = useImportExportModal();
    await wrapper.get('[data-testid="csp-transfer-export"]').trigger('click');
    const request = modal.request.value;
    expect(request).toBeDefined();
    if (request === undefined) {
      throw new Error('Expected an explicit modal request');
    }
    modal.completeLoad({ requestId: request.id, status: 'failed' });
    await flushPromises();
    expect(wrapper.get('[data-testid="csp-transfer-export-error"]').text()).toContain('Storage settings');
    expect(wrapper.find('[data-testid="csp-transfer-storage"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="csp-transfer-export"]').attributes('disabled')).toBeUndefined();
    expect(mocks.getExportURL).not.toHaveBeenCalled();
  });

  it('reuses URL sharing with the selected exclusions and waits for a separate link click', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mocks.getExportURL.mockResolvedValue('https://naidan.pages.dev/#/?storage-type=opfs&data-zip=selected');
    const wrapper = await renderGuidance({ deployments: [standard, curated] });
    expect(wrapper.get('[data-testid="csp-deployment-standard"]').attributes('href')).toBe('https://naidan.pages.dev/');
    expect(wrapper.get('[data-testid="csp-deployment-standard"]').text()).toBe('https://naidan.pages.dev');
    expect(wrapper.get('[data-testid="csp-transfer-destination-standard"]').text()).toBe('https://naidan.pages.dev');
    await wrapper.get('[data-testid="csp-transfer-exclude-chats"]').setValue(true);
    await wrapper.get('[data-testid="csp-transfer-exclude-attachments"]').setValue(true);
    expect(wrapper.get('[data-testid="csp-transfer-exclude-history"]').attributes('disabled')).toBeDefined();
    expect(mocks.getExportURL).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="csp-transfer-create-standard"]').trigger('click');
    await flushPromises();
    expect(mocks.getExportURL).toHaveBeenCalledExactlyOnceWith({ exclude: ['chat', 'binary_object'], baseUrl: 'https://naidan.pages.dev/' });
    expect(wrapper.get('[data-testid="csp-transfer-open-standard"]').attributes('href')).toBe('https://naidan.pages.dev/#/?storage-type=opfs&data-zip=selected');
    expect(wrapper.get('[data-testid="csp-transfer-open-standard"]').attributes('target')).toBe('_blank');
    expect(open).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="csp-transfer-exclude-chats"]').setValue(false);
    await wrapper.get('[data-testid="csp-transfer-exclude-history"]').setValue(true);
    expect(wrapper.find('[data-testid="csp-transfer-open-standard"]').exists()).toBe(false);
    mocks.getExportURL.mockResolvedValue('https://naidan-curated.pages.dev/#/?data-zip=next');
    await wrapper.get('[data-testid="csp-transfer-create-curated"]').trigger('click');
    await flushPromises();
    expect(mocks.getExportURL).toHaveBeenLastCalledWith({ exclude: ['chat_history', 'binary_object'], baseUrl: 'https://naidan-curated.pages.dev/' });
    expect(wrapper.get('[data-testid="csp-deployment-standard"]').attributes('href')).toBe('https://naidan.pages.dev/');
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps an export or size failure local and retains explicit export without exposing the error', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mocks.getExportURL.mockRejectedValue(new Error('private export details'));
    const wrapper = await renderGuidance({ deployments: [standard] });
    await wrapper.get('[data-testid="csp-transfer-create-standard"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="csp-transfer-error"]').text()).toContain('Storage settings');
    expect(wrapper.text()).not.toContain('private export details');
    expect(wrapper.find('[data-testid="csp-transfer-storage"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="csp-transfer-export"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="csp-transfer-open-standard"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="csp-transfer-create-standard"]').attributes('disabled')).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  it('does not publish an old generated link after the available deployment changes', async () => {
    const pending = Promise.withResolvers<string>();
    mocks.getExportURL.mockReturnValue(pending.promise);
    const wrapper = await renderGuidance({ deployments: [standard] });
    await wrapper.get('[data-testid="csp-transfer-create-standard"]').trigger('click');
    await flushPromises();
    expect(mocks.getExportURL).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ deployments: [curated] });
    pending.resolve('https://naidan.pages.dev/#/?data-zip=old');
    await flushPromises();
    expect(wrapper.find('[data-testid="csp-transfer-open-standard"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="csp-transfer-open-curated"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="csp-transfer-create-curated"]').attributes('disabled')).toBeUndefined();
  });

  it('copies only the already prepared URL on request without another export or opening a window', async () => {
    const writeText = vi.fn<Clipboard['writeText']>().mockResolvedValue(undefined);
    using clipboard = installClipboard({ writeText });
    using open = vi.spyOn(window, 'open').mockReturnValue(null);
    const url = 'https://naidan.pages.dev/#/?storage-type=opfs&data-zip=selected';
    mocks.getExportURL.mockResolvedValue(url);
    const wrapper = await renderGuidance({ deployments: [standard] });
    expect(wrapper.find('[data-testid="csp-transfer-copy-standard"]').exists()).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(mocks.getExportURL).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="csp-transfer-create-standard"]').trigger('click');
    await flushPromises();
    expect(writeText).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="csp-transfer-copy-standard"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(url);
    expect(mocks.getExportURL).toHaveBeenCalledExactlyOnceWith({ exclude: [], baseUrl: 'https://naidan.pages.dev/' });
    expect(wrapper.get('[data-testid="csp-transfer-open-standard"]').attributes('href')).toBe(url);
    expect(wrapper.get('[data-testid="csp-transfer-copy-standard"]').text()).toBe('Copied');
    expect(open).not.toHaveBeenCalled();
    void clipboard;
  });

  it('contains clipboard rejection and an unavailable Clipboard API while retaining the prepared open link', async () => {
    const writeText = vi.fn<Clipboard['writeText']>().mockRejectedValue(new Error('private clipboard diagnostic'));
    using clipboard = installClipboard({ writeText });
    const url = 'https://naidan.pages.dev/#/?data-zip=selected';
    mocks.getExportURL.mockResolvedValue(url);
    const wrapper = await renderGuidance({ deployments: [standard] });
    await wrapper.get('[data-testid="csp-transfer-create-standard"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="csp-transfer-copy-standard"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="csp-transfer-copy-error-standard"]').text()).toBe('Could not copy the URL.');
    expect(wrapper.text()).not.toContain('private clipboard diagnostic');
    expect(wrapper.get('[data-testid="csp-transfer-open-standard"]').attributes('href')).toBe(url);
    expect(wrapper.get('[data-testid="csp-transfer-copy-standard"]').attributes('disabled')).toBeUndefined();

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await wrapper.get('[data-testid="csp-transfer-copy-standard"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="csp-transfer-copy-error-standard"]').text()).toBe('Could not copy the URL.');
    expect(wrapper.get('[data-testid="csp-transfer-open-standard"]').attributes('href')).toBe(url);
    expect(mocks.getExportURL).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledOnce();
    void clipboard;
  });

  it('does not attach a late clipboard result to a new URL after exclusion choices change', async () => {
    const pending = Promise.withResolvers<void>();
    const writeText = vi.fn<Clipboard['writeText']>().mockReturnValueOnce(pending.promise);
    using clipboard = installClipboard({ writeText });
    const previousUrl = 'https://naidan.pages.dev/#/?data-zip=previous';
    const currentUrl = 'https://naidan.pages.dev/#/?data-zip=current';
    mocks.getExportURL.mockResolvedValueOnce(previousUrl).mockResolvedValueOnce(currentUrl);
    const wrapper = await renderGuidance({ deployments: [standard] });
    await wrapper.get('[data-testid="csp-transfer-create-standard"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="csp-transfer-copy-standard"]').trigger('click');
    expect(wrapper.get('[data-testid="csp-transfer-copy-standard"]').attributes('aria-busy')).toBe('true');
    await wrapper.get('[data-testid="csp-transfer-exclude-attachments"]').setValue(true);
    expect(wrapper.find('[data-testid="csp-transfer-copy-standard"]').exists()).toBe(false);
    await wrapper.get('[data-testid="csp-transfer-create-standard"]').trigger('click');
    await flushPromises();
    pending.resolve();
    await flushPromises();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(previousUrl);
    expect(mocks.getExportURL).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="csp-transfer-open-standard"]').attributes('href')).toBe(currentUrl);
    expect(wrapper.get('[data-testid="csp-transfer-copy-standard"]').text()).toBe('Copy URL');
    expect(wrapper.get('[data-testid="csp-transfer-copy-standard"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="csp-transfer-copy-error-standard"]').exists()).toBe(false);
    void clipboard;
  });

  it('clears a pending copy state when another destination is generated without losing the original URL', async () => {
    const pending = Promise.withResolvers<void>();
    const writeText = vi.fn<Clipboard['writeText']>().mockReturnValueOnce(pending.promise);
    using clipboard = installClipboard({ writeText });
    const standardUrl = 'https://naidan.pages.dev/#/?data-zip=standard';
    const curatedUrl = 'https://naidan-curated.pages.dev/#/?data-zip=curated';
    mocks.getExportURL.mockResolvedValueOnce(standardUrl).mockResolvedValueOnce(curatedUrl);
    const wrapper = await renderGuidance({ deployments: [standard, curated] });
    await wrapper.get('[data-testid="csp-transfer-create-standard"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="csp-transfer-copy-standard"]').trigger('click');
    expect(wrapper.get('[data-testid="csp-transfer-copy-standard"]').attributes('aria-busy')).toBe('true');
    await wrapper.get('[data-testid="csp-transfer-create-curated"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="csp-transfer-copy-standard"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="csp-transfer-copy-standard"]').text()).toBe('Copy URL');
    expect(wrapper.get('[data-testid="csp-transfer-open-standard"]').attributes('href')).toBe(standardUrl);
    pending.reject(new Error('old clipboard failure'));
    await flushPromises();
    expect(wrapper.find('[data-testid="csp-transfer-copy-error-standard"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="csp-transfer-copy-standard"]').attributes('aria-busy')).toBe('false');
    expect(wrapper.get('[data-testid="csp-transfer-open-curated"]').attributes('href')).toBe(curatedUrl);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(standardUrl);
    expect(mocks.getExportURL).toHaveBeenCalledTimes(2);
    void clipboard;
  });
});
