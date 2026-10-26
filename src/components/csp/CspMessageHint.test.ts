import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, onMounted, onUnmounted, provide, shallowRef, type ShallowRef } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { CspHintMessage } from '@/logic/csp-message-hints/types';
import CspMessageHint from './CspMessageHint.vue';
import CspToolCardFrame from './CspToolCardFrame.vue';

const useHints = vi.hoisted(() => vi.fn());
const stringsState = vi.hoisted(() => ({ failure: 'ready' as 'ready' | 'missing' | 'throw', activityFailure: 'ready' as 'ready' | 'missing' | 'throw', activityRequests: 0 }));
vi.mock('@/composables/useCspMessageHintsOnly', () => ({ useCspMessageHintsOnly: useHints }));
vi.mock('./CspDeploymentGuidance.vue', () => ({
  default: { props: ['deployments'], template: '<div data-testid="deployment-guidance-probe"><a href="https://naidan.pages.dev" data-testid="deployment-link">Public version</a><details><summary data-testid="migration-summary">Transfer data</summary><button type="button" data-testid="hidden-migration-action">Create URL</button></details></div>' },
}));
vi.mock('@/strings', () => ({
  lazyStrings: {
    CspMessageHint__this_connection_may_be_restricted: () => 'This connection may be restricted',
    CspMessageHint__this_url_may_be_unreachable: () => 'This URL may be unreachable',
    CspMessageHint__the_model_list_may_not_load: () => 'The model list may not load',
    CspMessageHint__a_response_may_not_be_generated: () => 'A response may not be generated',
    CspMessageHint__an_image_may_not_be_generated: () => 'An image may not be generated',
    CspMessageHint__a_title_may_not_be_generated: () => 'A title may not be generated',
    CspMessageHint__the_conversation_may_not_be_summarized: () => 'The conversation may not be summarized',
    CspMessageHint__the_prompt_may_not_be_translated: () => 'The prompt may not be translated',
    CspMessageHint__model_search_may_fail: () => 'Model search may fail',
    CspMessageHint__model_information_may_not_load: () => 'Model information may not load',
    CspMessageHint__quantization_options_may_not_load: () => 'Quantization options may not load',
    CspMessageHint__downloads_may_fail: () => {
      stringsState.activityRequests++;
      switch (stringsState.activityFailure) {
      case 'ready': return 'Downloads may fail';
      case 'missing': return undefined;
      case 'throw': throw new Error('Broken optional activity copy');
      default: {
        const exhaustive: never = stringsState.activityFailure;
        return exhaustive;
      }
      }
    },
    CspMessageHint__running_models_may_not_be_checked: () => 'Running models may not be checked',
    CspMessageHint__the_model_may_not_be_unloaded_from_memory: () => 'The model may not be unloaded from memory',
    CspMessageHint__wikipedia_may_not_be_available: () => 'Wikipedia may not be available',
    CspMessageHint__the_relay_server_may_be_unreachable: () => 'The relay server may be unreachable',
    CspMessageHint__this_image_may_not_be_displayed: () => 'This image may not be displayed',
    CspMessageHint__this_media_may_not_play: () => 'This media may not play',
    CspMessageHint__this_form_may_not_be_submitted: () => 'This form may not be submitted',
    CspMessageHint__this_resource_may_not_load: () => 'This resource may not load',
    CspMessageHint__some_content_or_actions_may_be_restricted: () => 'Some content or actions may be restricted',
    CspMessageHint__the_following_destinations_are_allowed: () => 'The following destinations are allowed',
    CspMessageHint__this_destination_is_outside_the_allowed_range: ({ url }: { url: string | undefined }) => `This destination${url === undefined ? '' : ` (${url})`} is outside the allowed range.`,
    CspMessageHint__some_required_connections_or_loads_are_outside_the_allowed_range: () => 'Some required connections or loads are outside the allowed range.',
    CspMessageHint__this_resource_source_is_outside_the_allowed_range: ({ url }: { url: string | undefined }) => `This resource source${url === undefined ? '' : ` (${url})`} is outside the allowed range.`,
    CspMessageHint__this_submission_destination_is_outside_the_allowed_range: ({ url }: { url: string | undefined }) => `This submission destination${url === undefined ? '' : ` (${url})`} is outside the allowed range.`,
    CspMessageHint__technical_details: () => {
      switch (stringsState.failure) {
      case 'ready': return 'Technical information';
      case 'missing': return undefined;
      case 'throw': throw new Error('Broken optional translation');
      default: {
        const exhaustive: never = stringsState.failure;
        return exhaustive;
      }
      }
    },
    CspMessageHint__current_content_security_policy: () => 'Current Content Security Policy',
    CspMessageHint__hints_for_resolving_this_error: () => 'Hints for resolving this error',
    CspMessageHint__current_policy_does_not_identify_the_error_cause: () => 'This describes the current policy, not the cause of this error.',
    CspMessageHint__settings_and_actions_remain_unchanged: () => 'You can keep these settings and try the action.',
    CspMessageHint__this_site: () => 'This site',
    CspMessageHint__local_servers_on_this_pc: () => 'Local servers running on this PC',
    CspMessageHint__no_destinations_are_allowed: () => 'No destinations are allowed',
    CspMessageHint__no_destinations_are_listed: () => 'No destinations are listed',
    CspMessageHint__this_page: () => 'This page',
    CspMessageHint__communication_page: () => 'Communication page',
    CspMessageHint__worker: () => 'Worker',
    CspMessageHint__each_policy_applies_separately: () => 'Each policy applies its own restrictions.',
  },
}));

const caution: CspHintMessage = {
  tone: 'caution',
  subject: 'wikipedia',
  suggestedDeployments: [],
  details: [{
    directive: 'connect-src',
    context: 'privacy-broker',
    sources: ["'self'", 'http://localhost:*', 'http://127.0.0.1:*'],
    sourceDescriptions: [{ kind: 'self' }, { kind: 'loopback' }, { kind: 'loopback' }],
  }],
};

let message: ShallowRef<CspHintMessage | undefined>;

async function settleDiagnostics(): Promise<void> {
  await vi.dynamicImportSettled();
  await flushPromises();
  await nextTick();
}

describe('optional CSP display', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    stringsState.failure = 'ready';
    stringsState.activityFailure = 'ready';
    stringsState.activityRequests = 0;
    message = shallowRef<CspHintMessage>();
    useHints.mockClear();
    useHints.mockImplementation(() => message);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('leaves no hint element, styling, or description reference without a message', async () => {
    using mounted = {
      wrapper: mount(CspMessageHint, { props: { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation: 'compact' } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    expect(mounted.wrapper.find('[data-testid="csp-message-hint"]').exists()).toBe(false);
    expect(mounted.wrapper.find('aside, details, [aria-describedby]').exists()).toBe(false);
  });

  it('keeps the compact summary nontechnical and explains sources in details', async () => {
    message.value = caution;
    using mounted = {
      wrapper: mount(CspMessageHint, { props: { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation: 'compact' } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    const trigger = mounted.wrapper.get('[data-testid="csp-hint-trigger"]');
    expect(trigger.text()).toBe('Wikipedia may not be available');
    expect(trigger.text()).not.toContain('CSP');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(mounted.wrapper.findAll('li')).toHaveLength(0);
    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(mounted.wrapper.findAll('li').map(item => item.text())).toEqual(['This site', 'Local servers running on this PC']);
    expect(mounted.wrapper.get('[data-testid="csp-hint-inline-details"]').text()).toContain('outside the allowed range');
    expect(mounted.wrapper.find('code').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="csp-technical-trigger"]').trigger('click');
    expect(mounted.wrapper.get('[data-testid="csp-hint-inline-details"]').text()).toContain('connect-src');
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(mounted.wrapper.get('.settings-collapse').attributes('inert')).toBeDefined();
    expect(mounted.wrapper.emitted()).toEqual({});
  });

  it('reactively forwards action wording through the optional shell without changing the observed target', async () => {
    message.value = { ...caution, subject: 'huggingface' };
    using mounted = {
      wrapper: mount(CspMessageHint, { props: { target: { kind: 'huggingface-metadata' }, presentation: 'compact', activityForDisplayOnly: 'model-search' } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    expect(mounted.wrapper.get('[data-testid="csp-hint-trigger"]').text()).toBe('Model search may fail');
    await mounted.wrapper.setProps({ activityForDisplayOnly: 'quantization-options' });
    expect(mounted.wrapper.get('[data-testid="csp-hint-trigger"]').text()).toBe('Quantization options may not load');
    await mounted.wrapper.setProps({ presentation: 'error' });
    expect(mounted.wrapper.get('[data-testid="csp-hint-trigger"]').text()).toBe('Hints for resolving this error');
    expect(useHints).toHaveBeenCalledOnce();
    expect(useHints.mock.calls[0]?.[0].target.value).toEqual({ kind: 'huggingface-metadata' });
    expect(mounted.wrapper.emitted()).toEqual({});
  });

  it('shows error details without another hint trigger and does not request compact activity copy', async () => {
    stringsState.activityFailure = 'throw';
    message.value = { ...caution, subject: 'huggingface' };
    using mounted = {
      wrapper: mount(CspMessageHint, { props: { target: { kind: 'huggingface-download' }, presentation: 'error-details', activityForDisplayOnly: 'download' } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    expect(mounted.wrapper.find('[data-testid="csp-hint-trigger"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="csp-hint-inline-details"]').exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="csp-warning-zone"]').text()).toContain('outside the allowed range');
    expect(mounted.wrapper.get('[data-testid="csp-error-note"]').text()).toBe('This describes the current policy, not the cause of this error.');
    expect(mounted.wrapper.get('.settings-collapse').attributes('inert')).toBeUndefined();
    expect(mounted.wrapper.find('code').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="csp-technical-trigger"]').trigger('click');
    expect(mounted.wrapper.find('code').exists()).toBe(true);
    expect(stringsState.activityRequests).toBe(0);
    message.value = undefined;
    await nextTick();
    expect(mounted.wrapper.find('[data-testid="csp-message-hint"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[aria-controls], [aria-describedby]').exists()).toBe(false);
  });

  it.each(['missing', 'throw'] as const)('removes an optional activity notice when its copy is %s while keeping the original error and controls', async failure => {
    message.value = { ...caution, subject: 'huggingface' };
    const clicked = vi.fn();
    const applicationError = vi.fn();
    using mounted = {
      wrapper: mount(defineComponent({
        render: () => h('div', [
          h('p', { 'data-testid': 'activity-original-error' }, 'Original failure'),
          h(CspMessageHint, { target: { kind: 'huggingface-download' }, presentation: 'compact', activityForDisplayOnly: 'download' }),
          h('button', { 'data-testid': 'activity-existing-control', onClick: clicked }, 'Try again'),
        ]),
      }), { global: { config: { errorHandler: applicationError } } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const control = mounted.wrapper.get('[data-testid="activity-existing-control"]').element;
    stringsState.activityFailure = failure;
    await settleDiagnostics();
    expect(mounted.wrapper.find('aside, [aria-controls], [aria-describedby]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="activity-original-error"]').text()).toBe('Original failure');
    expect(mounted.wrapper.get('[data-testid="activity-existing-control"]').element).toBe(control);
    await mounted.wrapper.get('[data-testid="activity-existing-control"]').trigger('click');
    expect(clicked).toHaveBeenCalledOnce();
    expect(applicationError).not.toHaveBeenCalled();
  });

  it.each(['missing', 'throw'] as const)('retains error guidance without requesting hidden activity copy that would %s', async failure => {
    stringsState.activityFailure = failure;
    message.value = { ...caution, subject: 'huggingface' };
    const clicked = vi.fn();
    const applicationError = vi.fn();
    using mounted = {
      wrapper: mount(defineComponent({
        render: () => h('div', [
          h('p', { 'data-testid': 'error-original' }, 'Original failure'),
          h(CspMessageHint, { target: { kind: 'huggingface-download' }, presentation: 'error', activityForDisplayOnly: 'download' }),
          h('button', { 'data-testid': 'error-existing-control', onClick: clicked }, 'Try again'),
        ]),
      }), { global: { config: { errorHandler: applicationError } } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const control = mounted.wrapper.get('[data-testid="error-existing-control"]').element;
    await settleDiagnostics();
    const trigger = mounted.wrapper.get('[data-testid="csp-hint-trigger"]');
    expect(trigger.text()).toBe('Hints for resolving this error');
    await trigger.trigger('click');
    expect(mounted.wrapper.get('[data-testid="csp-error-note"]').text()).toBe('This describes the current policy, not the cause of this error.');
    expect(mounted.wrapper.get('[data-testid="error-original"]').text()).toBe('Original failure');
    expect(mounted.wrapper.get('[data-testid="error-existing-control"]').element).toBe(control);
    await mounted.wrapper.get('[data-testid="error-existing-control"]').trigger('click');
    expect(clicked).toHaveBeenCalledOnce();
    expect(stringsState.activityRequests).toBe(0);
    expect(applicationError).not.toHaveBeenCalled();
  });

  it('expands endpoint details below the URL inside the form and preserves existing control instances', async () => {
    const clicked = vi.fn();
    message.value = caution;
    using mounted = {
      wrapper: mount(defineComponent({
        render: () => h('form', { onSubmit: (event: Event) => event.preventDefault() }, [
          h('div', { 'data-testid': 'endpoint-field' }, [
            h('label', { for: 'existing-endpoint' }, 'URL'),
            h('input', { id: 'existing-endpoint', 'data-testid': 'endpoint-input', value: 'https://remote.invalid' }),
            h(CspMessageHint, { activityForDisplayOnly: undefined, target: { kind: 'connection', endpoint: 'https://remote.invalid', apiPath: '/models' }, presentation: 'compact' }),
          ]),
          h('button', { type: 'button', 'data-testid': 'existing-fetch', onClick: clicked }, 'Fetch'),
        ]),
      }), { attachTo: document.body }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    const input = mounted.wrapper.get<HTMLInputElement>('[data-testid="endpoint-input"]').element;
    const fetch = mounted.wrapper.get('[data-testid="existing-fetch"]').element;
    input.value = 'Keep this draft';
    const trigger = mounted.wrapper.get<HTMLButtonElement>('[data-testid="csp-hint-trigger"]');
    expect(trigger.element.closest('label')).toBeNull();
    expect(input.compareDocumentPosition(trigger.element) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(mounted.wrapper.find('[data-testid="csp-hint-inline-details"]').exists()).toBe(false);
    input.focus();
    await trigger.trigger('click');
    const details = mounted.wrapper.get('[data-testid="csp-hint-inline-details"]');
    expect(mounted.wrapper.get('[data-testid="endpoint-field"]').element.contains(details.element)).toBe(true);
    expect(document.querySelector('[data-testid="csp-hint-popup"]')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(mounted.wrapper.get('[data-testid="endpoint-input"]').element).toBe(input);
    expect(mounted.wrapper.get('[data-testid="existing-fetch"]').element).toBe(fetch);
    expect(input.value).toBe('Keep this draft');
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
    await mounted.wrapper.get('[data-testid="existing-fetch"]').trigger('click');
    expect(clicked).toHaveBeenCalledOnce();
    message.value = undefined;
    await nextTick();
    expect(mounted.wrapper.find('[data-testid="csp-message-hint"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[aria-describedby], [aria-controls]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="endpoint-input"]').element).toBe(input);
  });

  it('keeps embedded details open during unrelated focus and scrolling but closes them with the parent disclosure', async () => {
    message.value = caution;
    const parentOpen = shallowRef(true);
    using mounted = {
      wrapper: mount(defineComponent({
        setup() {
          provide('settings-disclosure-open', parentOpen);
          return () => h('div', [h('input', { 'data-testid': 'outside-input' }), h(CspMessageHint, { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation: 'compact' })]);
        },
      }), { attachTo: document.body }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    const trigger = mounted.wrapper.get('[data-testid="csp-hint-trigger"]');
    await trigger.trigger('click');
    mounted.wrapper.get<HTMLInputElement>('[data-testid="outside-input"]').element.focus();
    mounted.wrapper.get('[data-testid="outside-input"]').element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    mounted.wrapper.element.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(trigger.attributes('aria-expanded')).toBe('true');
    parentOpen.value = false;
    await nextTick();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(mounted.wrapper.get('.settings-collapse').attributes('inert')).toBeDefined();
  });

  it.each(['compact', 'error'] as const)('does not observe or measure geometry for a closed %s hint', async presentation => {
    message.value = caution;
    const measurement = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    const observer = vi.fn().mockImplementation(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });
    vi.stubGlobal('ResizeObserver', observer);
    const documentListeners = vi.spyOn(document, 'addEventListener');
    using mounted = {
      wrapper: mount(CspMessageHint, { props: { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    expect(mounted.wrapper.get('[data-testid="csp-hint-trigger"]').attributes('aria-expanded')).toBe('false');
    window.dispatchEvent(new Event('resize'));
    document.dispatchEvent(new Event('scroll'));
    expect(measurement).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(documentListeners.mock.calls.filter(([name]) => ['pointerdown', 'focusin', 'scroll', 'transitionend'].includes(name))).toHaveLength(0);
  });

  it('keeps inline expansion, closing, and reopening free of geometry observers and global listeners', async () => {
    message.value = caution;
    const measurement = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    const observer = vi.fn().mockImplementation(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });
    vi.stubGlobal('ResizeObserver', observer);
    const documentListeners = vi.spyOn(document, 'addEventListener');
    using mounted = {
      wrapper: mount(CspMessageHint, { attachTo: document.body, props: { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation: 'compact' } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    const trigger = mounted.wrapper.get('[data-testid="csp-hint-trigger"]');
    await trigger.trigger('click');
    window.dispatchEvent(new Event('resize'));
    await trigger.trigger('keydown', { key: 'Escape' });
    await trigger.trigger('click');
    document.dispatchEvent(new Event('scroll'));
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(observer).not.toHaveBeenCalled();
    expect(measurement).not.toHaveBeenCalled();
    expect(documentListeners.mock.calls.filter(([name]) => ['pointerdown', 'focusin', 'scroll', 'transitionend'].includes(name))).toHaveLength(0);
  });

  it('makes retained embedded details inert and hidden to accessibility immediately while collapsing', async () => {
    message.value = { ...caution, suggestedDeployments: [{ id: 'standard' }] };
    using mounted = {
      wrapper: mount(CspMessageHint, {
        attachTo: document.body,
        props: { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation: 'compact' },
        global: { stubs: { transition: false } },
      }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    const trigger = mounted.wrapper.get('[data-testid="csp-hint-trigger"]');
    await trigger.trigger('click');
    const details = mounted.wrapper.get('[data-testid="csp-hint-inline-details"]').element;
    const collapse = mounted.wrapper.get('.settings-collapse');
    expect(collapse.attributes('inert')).toBeUndefined();
    expect(collapse.attributes('aria-hidden')).toBe('false');
    const link = mounted.wrapper.get<HTMLAnchorElement>('[data-testid="deployment-link"]');
    link.element.focus();
    await link.trigger('keydown', { key: 'Escape' });
    expect(mounted.wrapper.get('[data-testid="csp-hint-inline-details"]').element).toBe(details);
    expect(collapse.attributes('inert')).toBeDefined();
    expect(collapse.attributes('aria-hidden')).toBe('true');
    expect(trigger.attributes('aria-controls')).toBeUndefined();
    expect(document.activeElement).toBe(trigger.element);
    message.value = undefined;
    await nextTick();
    expect(mounted.wrapper.find('[data-testid="csp-hint-inline-details"]').exists()).toBe(false);
  });

  it('isolates an optional disclosure focus event failure and leaves the original controls usable', async () => {
    message.value = caution;
    const applicationError = vi.fn();
    const clicked = vi.fn();
    using mounted = {
      wrapper: mount(defineComponent({ render: () => h('div', [h(CspMessageHint, { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation: 'compact' }), h('button', { 'data-testid': 'existing-control', onClick: clicked }, 'Continue')]) }), { global: { config: { errorHandler: applicationError } } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    const trigger = mounted.wrapper.get<HTMLButtonElement>('[data-testid="csp-hint-trigger"]');
    await trigger.trigger('click');
    const focus = vi.spyOn(trigger.element, 'focus').mockImplementation(() => {
      throw new Error('Optional focus return failed');
    });
    await trigger.trigger('keydown', { key: 'Escape' });
    focus.mockRestore();
    expect(mounted.wrapper.find('[data-testid="csp-message-hint"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="existing-control"]').trigger('click');
    expect(clicked).toHaveBeenCalledOnce();
    expect(applicationError).not.toHaveBeenCalled();
  });

  it('does not touch throwing geometry APIs during native resize or scrolling after inline expansion', async () => {
    message.value = caution;
    const applicationError = vi.fn();
    const nativeError = vi.fn();
    const clicked = vi.fn();
    window.addEventListener('error', nativeError);
    using errorListener = {
      [Symbol.dispose]() {
        window.removeEventListener('error', nativeError);
      },
    };
    using mounted = {
      wrapper: mount(defineComponent({ render: () => h('div', [h(CspMessageHint, { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation: 'compact' }), h('button', { 'data-testid': 'existing-control', onClick: clicked }, 'Continue')]) }), { attachTo: document.body, global: { config: { errorHandler: applicationError } } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    const original = mounted.wrapper.get('[data-testid="existing-control"]').element;
    await mounted.wrapper.get('[data-testid="csp-hint-trigger"]').trigger('click');
    const measurement = vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('Geometry is unavailable');
    });
    window.dispatchEvent(new Event('resize'));
    document.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(mounted.wrapper.get('[data-testid="csp-hint-trigger"]').attributes('aria-expanded')).toBe('true');
    expect(measurement).not.toHaveBeenCalled();
    measurement.mockRestore();
    expect(mounted.wrapper.get('[data-testid="existing-control"]').element).toBe(original);
    await mounted.wrapper.get('[data-testid="existing-control"]').trigger('click');
    expect(clicked).toHaveBeenCalledOnce();
    expect(applicationError).not.toHaveBeenCalled();
    expect(nativeError).not.toHaveBeenCalled();
    void errorListener;
  });

  it('keeps technical information in the warning zone and deployment controls after it in natural Tab order', async () => {
    message.value = { ...caution, suggestedDeployments: [{ id: 'standard' }] };
    using mounted = {
      wrapper: mount(CspMessageHint, { attachTo: document.body, props: { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation: 'compact' } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    const trigger = mounted.wrapper.get<HTMLButtonElement>('[data-testid="csp-hint-trigger"]');
    await trigger.trigger('click');
    const details = mounted.wrapper.get('[data-testid="csp-hint-inline-details"]');
    const warningZone = details.get('[data-testid="csp-warning-zone"]');
    const technicalTrigger = details.get('[data-testid="csp-technical-trigger"]');
    const guide = details.get('[data-testid="deployment-guidance-probe"]');
    expect(warningZone.element.contains(technicalTrigger.element)).toBe(true);
    expect(warningZone.element.contains(guide.element)).toBe(false);
    expect(warningZone.element.compareDocumentPosition(guide.element) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(details.find('[data-testid="csp-technical-details"]').exists()).toBe(false);
    const firstLink = details.get<HTMLAnchorElement>('[data-testid="deployment-link"]');
    firstLink.element.focus();
    const backwards = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    firstLink.element.dispatchEvent(backwards);
    expect(backwards.defaultPrevented).toBe(false);
    expect(trigger.attributes('aria-expanded')).toBe('true');
    const lastControl = details.get<HTMLElement>('[data-testid="migration-summary"]');
    lastControl.element.focus();
    const forwards = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    lastControl.element.dispatchEvent(forwards);
    expect(forwards.defaultPrevented).toBe(false);
    expect(trigger.attributes('aria-expanded')).toBe('true');
  });

  it('shows current restrictions without changing the original error or claiming a cause', async () => {
    message.value = { ...caution, subject: 'connection' };
    const originalError = 'The original request failed.';
    using mounted = {
      wrapper: mount(defineComponent({ render: () => h('div', [h('p', { 'data-testid': 'original-error' }, originalError), h(CspMessageHint, { activityForDisplayOnly: undefined, target: { kind: 'connection', endpoint: 'https://user:secret@api.example/v1?api_key=private#fragment', apiPath: '/models' }, presentation: 'error' })]) })),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    expect(mounted.wrapper.get('[data-testid="original-error"]').text()).toBe(originalError);
    expect(mounted.wrapper.get('[data-testid="csp-hint-trigger"]').text()).toBe('Hints for resolving this error');
    expect(mounted.wrapper.find('[data-testid="csp-error-note"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="csp-destination-explanation"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="csp-hint-trigger"]').trigger('click');
    const warningZone = mounted.wrapper.get('[data-testid="csp-warning-zone"]');
    expect(warningZone.get('[data-testid="csp-error-note"]').text()).toContain('not the cause of this error');
    expect(warningZone.get('[data-testid="csp-error-note"]').element.previousElementSibling?.textContent).toBe('This destination (https://api.example/v1) is outside the allowed range.');
    expect(warningZone.get('[data-testid="csp-destination-explanation"]').text()).toBe('This destination (https://api.example/v1) is outside the allowed range.');
    expect(warningZone.find('[data-testid="csp-destination-url"]').exists()).toBe(false);
    expect(warningZone.text().match(/https:\/\/api\.example\/v1/g)).toHaveLength(1);
    expect(warningZone.text()).not.toContain('secret');
    expect(warningZone.text()).not.toContain('private');
    message.value = undefined;
    await nextTick();
    expect(mounted.wrapper.find('[data-testid="csp-message-hint"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="original-error"]').text()).toBe(originalError);
  });

  it.each(['missing', 'throw'] as const)('removes the entire notice when message formatting is %s', async failure => {
    stringsState.failure = failure;
    message.value = caution;
    const applicationError = vi.fn();
    using mounted = {
      wrapper: mount(CspMessageHint, {
        props: { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation: 'compact' },
        global: { config: { errorHandler: applicationError } },
      }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await settleDiagnostics();
    expect(mounted.wrapper.find('aside, details').exists()).toBe(false);
    expect(applicationError).not.toHaveBeenCalled();
  });

  it('retains the same focused controls when a card notice loads and disappears', async () => {
    let mounts = 0, unmounts = 0;
    const clicked = vi.fn();
    const controls = defineComponent({
      setup() {
        onMounted(() => {
          mounts++;
        });
        onUnmounted(() => {
          unmounts++;
        });
        return () => h('div', [h('input', { 'data-testid': 'original-input' }), h('button', { 'data-testid': 'original-toggle', onClick: clicked }, 'ON')]);
      },
    });
    using mounted = {
      wrapper: mount(CspToolCardFrame, {
        attachTo: document.body,
        props: { toolKey: 'builtin.wikipedia', enabled: true },
        slots: { default: () => h(controls) },
      }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const input = mounted.wrapper.get<HTMLInputElement>('[data-testid="original-input"]').element;
    const toggle = mounted.wrapper.get('[data-testid="original-toggle"]').element;
    input.value = 'Keep this edit';
    input.focus();
    await settleDiagnostics();
    message.value = caution;
    await nextTick();
    expect(mounted.wrapper.find('[data-csp-tool-notice]').exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="original-input"]').element).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Keep this edit');
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    message.value = undefined;
    await nextTick();
    expect(mounted.wrapper.find('[data-csp-tool-notice]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="original-toggle"]').element).toBe(toggle);
    expect(document.activeElement).toBe(input);
    await mounted.wrapper.get('[data-testid="original-toggle"]').trigger('click');
    expect(clicked).toHaveBeenCalledOnce();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it('isolates a diagnostic setup exception while retaining existing card controls', async () => {
    useHints.mockImplementation(() => {
      throw new Error('Optional diagnostic setup failed');
    });
    const applicationError = vi.fn();
    using mounted = {
      wrapper: mount(CspToolCardFrame, {
        props: { toolKey: 'builtin.wikipedia', enabled: true },
        slots: { default: '<button data-testid="existing-control">ON</button>' },
        global: { config: { errorHandler: applicationError } },
      }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const control = mounted.wrapper.get('[data-testid="existing-control"]').element;
    await settleDiagnostics();
    expect(mounted.wrapper.find('[data-csp-tool-notice]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="existing-control"]').element).toBe(control);
    expect(applicationError).not.toHaveBeenCalled();
  });
});
