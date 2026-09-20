import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import LlamaCppBrowserDeletionDialog from './LlamaCppBrowserDeletionDialog.vue';
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
describe('model deletion choice', () => {
  it('includes shared files initially, explains their impact, and keeps preview and confirmed plan in sync', async () => {
    const base = { path: 'model-Q4.gguf', size: 128, lastModified: 1 }; const projector = { ...base, path: 'mmproj-Q8_0.gguf' };
    const plan = { id: 'hf.co/owner/repo:model-Q4.gguf', sharedProjector: 'keep' as const, files: [base] };
    const sharedPlan = { ...plan, sharedProjector: 'include' as const, files: [base, projector] };
    const wrapper = mount(LlamaCppBrowserDeletionDialog, { props: { request: { plan, sharedPlan, affectedVariants: 1 } } });
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-delete-shared"]').element.checked).toBe(true);
    expect(wrapper.get('[data-testid="llama-delete-details"]').text()).toContain(projector.path);
    expect(wrapper.get('[data-testid="llama-delete-shared-warning"]').text()).toContain('Other variants');
    await wrapper.get('[data-testid="llama-delete-shared"]').setValue(false);
    expect(wrapper.get('[data-testid="llama-delete-details"]').text()).not.toContain(projector.path);
    await wrapper.get('[data-testid="dialog-confirm-button"]').trigger('click'); expect(wrapper.emitted('confirm')?.[0]).toEqual([plan]);
    await wrapper.setProps({ request: { plan, sharedPlan, affectedVariants: 1 } });
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-delete-shared"]').element.checked).toBe(true);
    await wrapper.get('[data-testid="dialog-confirm-button"]').trigger('click'); expect(wrapper.emitted('confirm')?.[1]).toEqual([sharedPlan]);
    wrapper.unmount();
  });
});
