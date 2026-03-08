import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import { webSpeechService } from '../services/web-speech';
import { nextTick } from 'vue';

describe('MessageItem Speech Controls', () => {
  const createMessage = (content: string, id: string = 'msg-1') => ({
    id,
    role: 'assistant' as const,
    content,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset service state manually
    webSpeechService.stop();
    webSpeechService.state.activeMessageId = null;
    webSpeechService.state.status = 'inactive';
    webSpeechService.state.detectedLang = null;
    webSpeechService.state.preferredLang = 'auto';

    // Mock support
    vi.spyOn(webSpeechService, 'isSupported').mockReturnValue(true);
  });

  it('renders speech buttons if supported', () => {
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, {
      props: { message, isFirstInTurn: true }
    });

    // Header and footer toggle buttons
    const toggles = wrapper.findAll('[data-testid="speech-toggle-mini"]');
    expect(toggles.length).toBe(2);
  });

  it('does not render speech buttons if not supported', () => {
    vi.spyOn(webSpeechService, 'isSupported').mockReturnValue(false);
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });

    expect(wrapper.find('[data-testid="speech-toggle-mini"]').exists()).toBe(false);
  });

  it('starts speaking when toggle button is clicked', async () => {
    const speakSpy = vi.spyOn(webSpeechService, 'speak');
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });

    // Click header toggle
    await wrapper.findAll('[data-testid="speech-toggle-mini"]')[0]!.trigger('click');

    expect(speakSpy).toHaveBeenCalledWith({ text: 'Hello', messageId: message.id, isFinal: true, lang: 'auto' });
  });

  it('shows control group when speech is active in footer', async () => {
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });

    // Simulate active state
    webSpeechService.state.activeMessageId = message.id;
    webSpeechService.state.status = 'playing';
    await nextTick();

    // Footer shows full panel (search globally in wrapper as it's in a subcomponent)
    expect(wrapper.find('button[title="Stop"]').exists()).toBe(true);
    expect(wrapper.find('button[title="Restart"]').exists()).toBe(true);
  });

  it('toggles between pause and resume', async () => {
    const pauseSpy = vi.spyOn(webSpeechService, 'pause');
    const speakSpy = vi.spyOn(webSpeechService, 'speak');
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });

    // Start playing
    webSpeechService.state.activeMessageId = message.id;
    webSpeechService.state.status = 'playing';
    await nextTick();

    // Click pause on full panel (Search by title as it's more stable)
    await wrapper.find('button[title="Pause"]').trigger('click');
    expect(pauseSpy).toHaveBeenCalled();

    // Simulate paused state
    webSpeechService.state.status = 'paused';
    await nextTick();

    // Click resume on full panel
    await wrapper.find('button[title="Resume"]').trigger('click');
    expect(speakSpy).toHaveBeenCalledWith({ text: 'Hello', messageId: message.id, isFinal: true, lang: 'auto' });
  });

  it('stops speech when stop button is clicked', async () => {
    const stopSpy = vi.spyOn(webSpeechService, 'stop');
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });

    // Simulate active state
    webSpeechService.state.activeMessageId = message.id;
    webSpeechService.state.status = 'playing';
    await nextTick();

    await wrapper.find('button[title="Stop"]').trigger('click');
    expect(stopSpy).toHaveBeenCalled();
  });

  it('restarts speech when restart button is clicked', async () => {
    const speakSpy = vi.spyOn(webSpeechService, 'speak');
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });

    // Simulate active state
    webSpeechService.state.activeMessageId = message.id;
    webSpeechService.state.status = 'playing';
    await nextTick();

    await wrapper.find('button[title="Restart"]').trigger('click');
    expect(speakSpy).toHaveBeenCalledWith({ text: 'Hello', messageId: message.id, isFinal: true, lang: 'auto' });
  });

  it('does NOT call speech service when content updates if not playing', async () => {
    const speakSpy = vi.spyOn(webSpeechService, 'speak');
    const message = createMessage('Initial content');
    const wrapper = mount(MessageItem, { props: { message } });

    // Ensure we start from zero calls
    speakSpy.mockClear();

    // Update message content (streaming simulation)
    await wrapper.setProps({
      message: createMessage('Initial content. More content coming...')
    });

    // Should NOT have been called (by any instance)
    expect(speakSpy).not.toHaveBeenCalled();

    // Now start playing - only this message becomes active
    webSpeechService.state.activeMessageId = message.id;
    webSpeechService.state.status = 'playing';
    await nextTick();

    // Reset spy to check only the next update
    speakSpy.mockClear();

    // Update again
    await wrapper.setProps({
      message: createMessage('Final content.')
    });

    // NOW it should be called (at least once, by the active instance)
    expect(speakSpy).toHaveBeenCalled();
  });
});
