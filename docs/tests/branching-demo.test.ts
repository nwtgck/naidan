// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import BranchingDemo from '../islands/branching/BranchingDemo.vue';
import { strings as english } from '../strings/chat/branching/en';
import { strings as japanese } from '../strings/chat/branching/ja';
import { strings as englishCommon } from '../strings/common/en';
import { strings as japaneseCommon } from '../strings/common/ja';
import { visibleGuideText } from './ui-label.test-support';
import type { BranchingCopy, ReplicaChromeCopy } from '../site/messages';

async function createDemo({ copy, chrome }: { copy: BranchingCopy; chrome: ReplicaChromeCopy }) {
  const wrapper = mount(BranchingDemo, { props: { copy, chrome } });
  await nextTick();
  return { wrapper, [Symbol.dispose]: () => wrapper.unmount() };
}

describe('source-derived conversation branching methods', () => {
  it.each([{ copy: english.demo, chrome: englishCommon.chrome }, { copy: japanese.demo, chrome: japaneseCommon.chrome }])('edits in place and switches the whole question and answer continuation', async ({ copy, chrome }) => {
    using demo = await createDemo({ copy, chrome });
    const wrapper = demo.wrapper.get('[data-testid="branch-method-edit"]');
    await wrapper.get('[data-testid="branch-edit"]').trigger('click');
    const editor = wrapper.get<HTMLTextAreaElement>('[data-testid="branch-edit-textarea"]');
    expect(editor.element.value).toBe(copy.prompt);
    await editor.setValue(copy.editedPrompt);
    await wrapper.get('[data-testid="branch-save-edit"]').trigger('click');
    expect(wrapper.get('[data-testid="branch-prompt"]').text()).toBe(copy.editedPrompt);
    expect(wrapper.get('[data-testid="branch-reply"]').text()).toBe(copy.editedReply);
    expect(wrapper.get('[data-testid="branch-user-versions"]').text()).toBe('2 / 2');
    expect(wrapper.find('[data-testid="branch-assistant-versions"]').exists()).toBe(false);
    await wrapper.get('[data-testid="branch-original"]').trigger('click');
    expect(wrapper.get('[data-testid="branch-prompt"]').text()).toBe(copy.prompt);
    expect(wrapper.get('[data-testid="branch-reply"]').text()).toBe(copy.replies[0]);
    await wrapper.get('[data-testid="branch-alternative"]').trigger('click');
    expect(wrapper.get('[data-testid="branch-prompt"]').text()).toBe(copy.editedPrompt);
    expect(wrapper.get('[data-testid="branch-reply"]').text()).toBe(copy.editedReply);
  });

  it('keeps an edited path selected while the separate fork example advances', async () => {
    using demo = await createDemo({ copy: english.demo, chrome: englishCommon.chrome });
    const edit = demo.wrapper.get('[data-testid="branch-method-edit"]');
    const fork = demo.wrapper.get('[data-testid="branch-method-fork"]');
    await edit.get('[data-testid="branch-edit"]').trigger('click');
    await edit.get('[data-testid="branch-edit-textarea"]').setValue(english.demo.editedPrompt);
    await edit.get('[data-testid="branch-save-edit"]').trigger('click');
    await fork.get('[data-testid="branch-more-actions"]').trigger('click');
    await fork.get('[data-testid="branch-fork"]').trigger('click');
    expect(edit.get('[data-testid="branch-prompt"]').text()).toBe(english.demo.editedPrompt);
    expect(edit.get('[data-testid="branch-reply"]').text()).toBe(english.demo.editedReply);
    expect(fork.get('[data-testid="branch-prompt"]').text()).toBe(english.demo.prompt);
    expect(fork.find('[data-testid="branch-reply"]').exists()).toBe(false);
    await fork.get('[data-testid="branch-original-chat"]').trigger('click');
    expect(fork.get('[data-testid="branch-reply"]').text()).toBe(english.demo.replies[0]);
  });

  it('keeps the user-message version for resend and the assistant-message version for regenerate', async () => {
    using demo = await createDemo({ copy: english.demo, chrome: englishCommon.chrome });
    const resend = demo.wrapper.get('[data-testid="branch-method-resend"]');
    const regenerate = demo.wrapper.get('[data-testid="branch-method-regenerate"]');
    await resend.get('[data-testid="branch-resend"]').trigger('click');
    expect(resend.get('[data-testid="branch-prompt"]').text()).toBe(english.demo.prompt);
    expect(resend.get('[data-testid="branch-reply"]').text()).toBe(english.demo.replies[1]);
    expect(resend.find('[data-testid="branch-user-versions"]').exists()).toBe(true);
    expect(resend.find('[data-testid="branch-assistant-versions"]').exists()).toBe(false);
    await regenerate.get('[data-testid="branch-regenerate"]').trigger('click');
    expect(regenerate.get('[data-testid="branch-prompt"]').text()).toBe(english.demo.prompt);
    expect(regenerate.find('[data-testid="branch-user-versions"]').exists()).toBe(false);
    expect(regenerate.get('[data-testid="branch-assistant-versions"]').text()).toBe('2 / 2');
    await regenerate.get('[data-testid="branch-original"]').trigger('click');
    expect(regenerate.get('[data-testid="branch-reply"]').text()).toBe(english.demo.replies[0]);
    expect(resend.get('[data-testid="branch-reply"]').text()).toBe(english.demo.replies[1]);
  });

  it.each([{ copy: english.demo, chrome: englishCommon.chrome }, { copy: japanese.demo, chrome: japaneseCommon.chrome }])('forks directly from the real menu and copies only through the selected user message', async ({ copy, chrome }) => {
    using demo = await createDemo({ copy, chrome });
    const wrapper = demo.wrapper.get('[data-testid="branch-method-fork"]');
    expect(wrapper.find('[data-testid="branch-fork"]').exists()).toBe(false);
    await wrapper.get('[data-testid="branch-more-actions"]').trigger('click');
    expect(wrapper.get('[data-testid="branch-fork"]').text()).toBe(copy.ui.fork);
    expect(wrapper.get('[data-testid="branch-actions-menu"]').text()).toContain(copy.ui.compareVersions);
    await wrapper.get('[data-testid="branch-fork"]').trigger('click');
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="branch-actions-menu"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="branch-prompt"]').text()).toBe(copy.prompt);
    expect(wrapper.find('[data-testid="branch-reply"]').exists()).toBe(false);
    const fork = wrapper.get('[data-testid="branch-forked-chat"]');
    expect(fork.text()).toBe(copy.forkTitle);
    expect(fork.attributes('aria-current')).toBe('page');
    expect(fork.element.closest('[aria-hidden="true"]')).toBeNull();
    await wrapper.get('[data-testid="branch-original-chat"]').trigger('click');
    expect(wrapper.get('[data-testid="branch-reply"]').text()).toBe(copy.replies[0]);
    expect(wrapper.get('[data-testid="branch-original-chat"]').attributes('aria-current')).toBe('page');
    await fork.trigger('click');
    expect(wrapper.find('[data-testid="branch-reply"]').exists()).toBe(false);
  });
});

describe('walkthrough motion and user selection', () => {
  it.each([{ copy: english.demo, chrome: englishCommon.chrome }, { copy: japanese.demo, chrome: japaneseCommon.chrome }])('keeps intrinsic conversation and caption reserves mounted as stages change', async ({ copy, chrome }) => {
    using demo = await createDemo({ copy, chrome });
    const methods = ['edit', 'resend', 'regenerate', 'fork'] as const;
    expect(demo.wrapper.findAll('[data-testid^="branch-method-"]')).toHaveLength(4);
    for (const [index, method] of methods.entries()) {
      const section = demo.wrapper.get(`[data-testid="branch-method-${method}"]`);
      const reserve = section.get('[data-testid="branch-conversation-reserve"]');
      const element = reserve.element;
      expect(reserve.attributes('aria-hidden')).toBe('true');
      expect(reserve.text()).toContain(copy.prompt);
      expect(reserve.text()).toContain(copy.replies[0]);
      if (index === 0) {
        expect(reserve.text()).toContain(copy.editedPrompt);
        expect(reserve.text()).toContain(copy.editedReply);
      }
      if (index === 1 || index === 2) expect(reserve.text()).toContain(copy.replies[1]);
      expect(section.findAll('.caption-reserve')).toHaveLength(4);
      expect(section.find('aside').exists()).toBe(index === 3);
      await section.get('[data-testid="branch-step-1"]').trigger('click');
      if (index === 0) expect(section.get('[data-testid="branch-stage-caption"] .ui-label').text()).toBe(copy.ui.sendAndBranch);
      if (index === 3) expect(section.get('[data-testid="branch-stage-caption"] .ui-label').text()).toBe(copy.ui.fork);
      await section.get('[data-testid="branch-step-2"]').trigger('click');
      await section.get('[data-testid="branch-step-3"]').trigger('click');
      expect(section.get('[data-testid="branch-conversation-reserve"]').element).toBe(element);
      const captions = copy.stages[index];
      if (!captions) throw new Error(`Missing captions for ${method}`);
      expect(section.get('[data-testid="branch-stage-caption"]').text()).toBe(visibleGuideText({ text: captions[3] }));
    }
  });

  it('automatically explains the chosen method, then holds a manually chosen branch until replay', async () => {
    using demo = await createDemo({ copy: english.demo, chrome: englishCommon.chrome });
    const wrapper = demo.wrapper.get('[data-testid="branch-method-edit"]');
    expect(wrapper.attributes('data-playback')).toBe('automatic');
    expect(wrapper.attributes('data-stage')).toBe('0');
    await wrapper.get('[data-testid="branch-clock"]').trigger('animationiteration');
    expect(wrapper.find('[data-testid="branch-editor"]').exists()).toBe(true);
    await wrapper.get('[data-testid="branch-clock"]').trigger('animationiteration');
    expect(wrapper.get('[data-testid="branch-reply"]').text()).toBe(english.demo.editedReply);
    await wrapper.get('[data-testid="branch-original"]').trigger('click');
    expect(wrapper.attributes('data-playback')).toBe('manual');
    await wrapper.get('[data-testid="branch-clock"]').trigger('animationiteration');
    expect(wrapper.get('[data-testid="branch-reply"]').text()).toBe(english.demo.replies[0]);
    await wrapper.get('[data-testid="branch-replay"]').trigger('click');
    expect(wrapper.attributes('data-playback')).toBe('automatic');
    expect(wrapper.attributes('data-stage')).toBe('0');
    const fork = demo.wrapper.get('[data-testid="branch-method-fork"]');
    for (let step = 0; step < 4; step += 1) await fork.get('[data-testid="branch-clock"]').trigger('animationiteration');
    expect(fork.attributes('data-method')).toBe('fork');
    expect(fork.attributes('data-stage')).toBe('0');
  });

  it('honors the page pause control and reduced motion, while keeping steps usable', async () => {
    using demo = await createDemo({ copy: english.demo, chrome: englishCommon.chrome });
    const wrapper = demo.wrapper.get('[data-testid="branch-method-edit"]');
    const pause = document.createElement('input');
    pause.type = 'checkbox';
    pause.id = 'docs-pause-motion';
    pause.checked = true;
    document.body.append(pause);
    using _cleanup = {
      [Symbol.dispose]() {
        pause.remove(); vi.unstubAllGlobals();
      },
    };
    await wrapper.get('[data-testid="branch-clock"]').trigger('animationiteration');
    expect(wrapper.attributes('data-stage')).toBe('2');
    expect(wrapper.get('[data-testid="branch-reply"]').text()).toBe(english.demo.editedReply);
    pause.checked = false;
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    await wrapper.get('[data-testid="branch-replay"]').trigger('click');
    expect(wrapper.attributes('data-stage')).toBe('2');
    expect(wrapper.attributes('data-playback')).toBe('manual');
    await wrapper.get('[data-testid="branch-step-2"]').trigger('click');
    expect(wrapper.get('[data-testid="branch-reply"]').text()).toBe(english.demo.editedReply);
    expect(wrapper.attributes('data-playback')).toBe('manual');
  });

  it('settles an already mounted automatic walkthrough when the shared pause control changes', async () => {
    const pause = document.createElement('input');
    pause.type = 'checkbox';
    pause.id = 'docs-pause-motion';
    document.body.append(pause);
    using _cleanup = { [Symbol.dispose]: () => pause.remove() };
    using demo = await createDemo({ copy: english.demo, chrome: englishCommon.chrome });
    const wrapper = demo.wrapper.get('[data-testid="branch-method-edit"]');
    expect(wrapper.attributes('data-stage')).toBe('0');
    expect(wrapper.attributes('data-playback')).toBe('automatic');

    pause.checked = true;
    pause.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();
    expect(wrapper.attributes('data-stage')).toBe('2');
    expect(wrapper.attributes('data-playback')).toBe('manual');
    expect(wrapper.get('[data-testid="branch-reply"]').text()).toBe(english.demo.editedReply);
  });
});
