import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import AboutPortableEditionHelp from './AboutPortableEditionHelp.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  vi.useRealTimers();
});

function mountHelp() {
  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(AboutPortableEditionHelp, { attachTo: host });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
    },
  };
}

function getExplanation() {
  const explanation = document.querySelector<HTMLElement>('[data-testid="portable-html-help"]');
  if (!explanation) {
    throw new Error('Expected portable HTML instructions to be visible.');
  }
  return explanation;
}

describe('AboutPortableEditionHelp', () => {
  it('opens on keyboard focus and consumes Escape while keeping focus on the help button', async () => {
    using fixture = mountHelp();
    const button = fixture.wrapper.get<HTMLButtonElement>('[data-testid="portable-html-help-button"]');
    expect(button.attributes('type')).toBe('button');
    expect(button.attributes('aria-label')).toBe('How to use the portable HTML edition');
    expect(button.attributes('aria-expanded')).toBe('false');

    button.element.focus();
    await nextTick();
    const explanation = getExplanation();
    expect(explanation.textContent).toContain('Extract the ZIP and open index.html directly in your browser (file://). No HTTP server required.');
    expect(explanation.getAttribute('role')).toBe('tooltip');
    expect(explanation.id).toBe(button.attributes('aria-describedby'));
    expect(explanation.id).toBe(button.attributes('aria-controls'));
    expect(explanation.style.position).toBe('fixed');

    const bubbleListener = vi.fn();
    window.addEventListener('keydown', bubbleListener);
    using _listenerCleanup = {
      [Symbol.dispose]() {
        window.removeEventListener('keydown', bubbleListener);
      },
    };
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    button.element.dispatchEvent(event);
    await nextTick();
    expect(event.defaultPrevented).toBe(true);
    expect(bubbleListener).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="portable-html-help"]')).toBeFalsy();
    expect(button.attributes('aria-expanded')).toBe('false');
    expect(button.attributes('aria-describedby')).toBeUndefined();
    expect(document.activeElement).toBe(button.element);
  });

  it('pins the explanation by click and closes on a second click or an outside click', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    using fixture = mountHelp();
    const button = fixture.wrapper.get('[data-testid="portable-html-help-button"]');
    await button.trigger('mouseenter');
    await button.trigger('click');
    await button.trigger('mouseleave');
    await vi.advanceTimersByTimeAsync(150);
    expect(getExplanation()).toBeTruthy();

    await button.trigger('click');
    expect(document.querySelector('[data-testid="portable-html-help"]')).toBeFalsy();
    await button.trigger('click');
    await vi.advanceTimersByTimeAsync(0);
    document.body.click();
    await nextTick();
    expect(document.querySelector('[data-testid="portable-html-help"]')).toBeFalsy();
  });

  it('keeps hover help open while the pointer crosses into the explanation and closes after leaving', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    using fixture = mountHelp();
    const button = fixture.wrapper.get('[data-testid="portable-html-help-button"]');
    await button.trigger('mouseenter');
    await button.trigger('mouseleave');
    getExplanation().dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(150);
    expect(getExplanation()).toBeTruthy();

    getExplanation().dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(150);
    expect(document.querySelector('[data-testid="portable-html-help"]')).toBeFalsy();
  });
});
