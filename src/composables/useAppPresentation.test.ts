import { defineComponent, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import type { StartupState } from '@/logic/startup/types';
import { TEST_ONLY, isAppInteractionEnabled } from './useAppPresentation';

const MainApp = defineComponent({ template: '<div />' });

describe('app presentation', () => {
  it('blocks the background through dialog closing without blocking the dialog owner', () => {
    const visible = shallowRef(true);
    const presentation = TEST_ONLY.createAppPresentation({ startupState: shallowRef({ kind: 'ready', mainApp: MainApp }), modelSelectionVisible: visible });
    expect(presentation.appInteraction.value).toBe('blocked-by-model-selection');
    expect(isAppInteractionEnabled({ interaction: presentation.appInteraction.value })).toBe(false);
    visible.value = false;
    expect(presentation.appInteraction.value).toBe('enabled');
  });

  it.each<StartupState>([
    { kind: 'initializing-foundation' }, { kind: 'starting-main' },
    { kind: 'rendering-main', mainApp: MainApp },
  ])('blocks interaction during $kind', state => {
    const presentation = TEST_ONLY.createAppPresentation({ startupState: shallowRef(state), modelSelectionVisible: shallowRef(false) });
    expect(presentation.appInteraction.value).toBe('blocked-by-startup');
    expect(isAppInteractionEnabled({ interaction: presentation.appInteraction.value })).toBe(false);
  });

  it.each<StartupState>([
    { kind: 'ready', mainApp: MainApp },
    { kind: 'foundation-failed', error: new Error('storage') },
    { kind: 'main-failed', error: new Error('main') },
  ])('allows the visible main or error view during $kind', state => {
    const presentation = TEST_ONLY.createAppPresentation({ startupState: shallowRef(state), modelSelectionVisible: shallowRef(false) });
    expect(presentation.appInteraction.value).toBe('enabled');
  });

  it('ends home metadata when navigating to a chat', async () => {
    const history = createMemoryHistory();
    history.replace('/');
    const router = createRouter({ history, routes: [{ path: '/', component: MainApp }, { path: '/chat/:id', component: MainApp }] });
    const presentation = TEST_ONLY.createHomeIntroduction({ router });
    expect(presentation.homeIntroduction.value.kind).toBe('active');
    await router.push('/chat/automatic');
    expect(presentation.homeIntroduction.value.kind).toBe('inactive');
    presentation.finishHomeIntroduction();
    expect(presentation.homeIntroduction.value.kind).toBe('inactive');
  });

  it.each(['/chat/existing', '/image-generation', '/audio-generation', '/?q=hello', '/?llama-cpp-browser-model=owner/model'])('does not claim a deep link as the home introduction: %s', path => {
    const history = createMemoryHistory();
    history.replace(path);
    const router = createRouter({ history, routes: [{ path: '/:pathMatch(.*)*', component: MainApp }] });
    expect(TEST_ONLY.createHomeIntroduction({ router }).homeIntroduction.value.kind).toBe('inactive');
  });
});
