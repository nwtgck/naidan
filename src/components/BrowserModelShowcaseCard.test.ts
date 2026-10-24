import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelSuggestions, preferredQuantizationHint } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api/constants';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { BrowserModelShowcaseItem, BrowserModelShowcasePosition } from './browser-model-presentation';
import BrowserModelShowcaseCard from './BrowserModelShowcaseCard.vue';

enableAutoUnmount(afterEach);

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => vi.restoreAllMocks());

function ggufCard({ position, offset }: { position: BrowserModelShowcasePosition, offset: number }): BrowserModelShowcaseItem {
  const model = modelSuggestions.find(candidate => candidate.id === 'gemma-4-e2b');
  if (model === undefined) {
    throw new Error('Expected bundled Gemma suggestion');
  }
  return { kind: 'gguf', model, hint: preferredQuantizationHint({ suggestion: model }), position, offset };
}

describe('browser model showcase card', () => {
  it('keeps the button, primary contents and focus when moving between center and edges', async () => {
    const wrapper = mount(BrowserModelShowcaseCard, { props: { card: ggufCard({ position: 'selected', offset: 0 }), interaction: 'ready', startStatus: 'idle' }, attachTo: document.body });
    const button = wrapper.get('button').element;
    const primary = wrapper.get('[data-model-face="primary"]').element;
    const previous = wrapper.get('[data-model-face="preview-previous"]').element;
    const next = wrapper.get('[data-model-face="preview-next"]').element;
    button.focus();
    for (const { position, offset } of [{ position: 'previous', offset: -1 }, { position: 'next', offset: 1 }, { position: 'selected', offset: 0 }] as const) {
      await wrapper.setProps({ card: ggufCard({ position, offset }) });
      expect(wrapper.get('button').element).toBe(button);
      expect(wrapper.get('[data-model-face="primary"]').element).toBe(primary);
      expect(wrapper.get('[data-model-face="preview-previous"]').element).toBe(previous);
      expect(wrapper.get('[data-model-face="preview-next"]').element).toBe(next);
      expect(document.activeElement).toBe(button);
      expect(primary.textContent).toContain('Gemma 4 E2B it');
    }
  });

  it.each([
    { position: 'selected', offset: 0, label: 'Run in your browser' },
    { position: 'previous', offset: -1, label: 'Select' },
    { position: 'next', offset: 1, label: 'Select' },
  ] as const)('activates the current $position role without starting any model itself', async ({ position, offset, label }) => {
    using fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
    const wrapper = mount(BrowserModelShowcaseCard, { props: { card: ggufCard({ position, offset }), interaction: 'ready', startStatus: 'idle' } });
    expect(wrapper.get('button').attributes('aria-label')).toContain(label);
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('activate')).toEqual([[{ position }]]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('starts accepting the center action immediately when selection returns during an outward handoff', async () => {
    const wrapper = mount(BrowserModelShowcaseCard, { props: { card: ggufCard({ position: 'selected', offset: 0 }), interaction: 'ready', startStatus: 'idle' } });
    await wrapper.setProps({ card: ggufCard({ position: 'previous', offset: -1 }) });
    await wrapper.setProps({ card: ggufCard({ position: 'selected', offset: 0 }) });
    expect(wrapper.get('button').attributes('aria-label')).toContain('Run in your browser');
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('activate')).toEqual([[{ position: 'selected' }]]);
  });

  it('keeps hidden and blocked cards inert to activation, then permits a visible ready card', async () => {
    const wrapper = mount(BrowserModelShowcaseCard, { props: { card: ggufCard({ position: 'hidden', offset: -2 }), interaction: 'ready', startStatus: 'idle' } });
    expect(wrapper.get('button').attributes('aria-hidden')).toBe('true');
    expect(wrapper.get('button').attributes('tabindex')).toBe('-1');
    expect(wrapper.get<HTMLButtonElement>('button').element.disabled).toBe(true);
    await wrapper.get('button').trigger('click');
    await wrapper.setProps({ card: ggufCard({ position: 'selected', offset: 0 }), interaction: 'blocked', startStatus: 'starting' });
    expect(wrapper.get('button').attributes('aria-busy')).toBe('true');
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('activate')).toBeUndefined();
    await wrapper.setProps({ interaction: 'ready', startStatus: 'idle' });
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('activate')).toEqual([[{ position: 'selected' }]]);
  });

  it('renders browser preparation status without GGUF size or memory metadata', async () => {
    const card: BrowserModelShowcaseItem = { kind: 'browser-provided', model: { id: BROWSER_PROVIDED_LM_MODEL_ID, name: 'Browser-provided model', developer: 'This browser' }, availability: 'downloadable', position: 'selected', offset: 0 };
    const wrapper = mount(BrowserModelShowcaseCard, { props: { card, interaction: 'ready', startStatus: 'idle' } });
    const button = wrapper.get('button').element;
    const primary = wrapper.get('[data-model-face="primary"]');
    expect(primary.text()).toContain('Browser-provided model');
    expect(primary.text()).toContain('preparation');
    expect(primary.text()).not.toContain('GiB');
    expect(primary.text()).not.toContain(' GB');
    await wrapper.setProps({ card: { ...card, availability: 'available' } });
    expect(wrapper.get('button').element).toBe(button);
    expect(primary.text()).not.toContain('preparation');
    expect(primary.attributes('aria-hidden')).toBe('true');
  });
});
