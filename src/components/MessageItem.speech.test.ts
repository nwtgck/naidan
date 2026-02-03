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
    // Mock support
    vi.spyOn(webSpeechService, 'isSupported').mockReturnValue(true);
  });

  it('renders speech buttons if supported', () => {
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });
    
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
    
    expect(speakSpy).toHaveBeenCalledWith({ text: 'Hello', messageId: message.id });
  });

  it('shows control group when speech is active in footer', async () => {
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });
    
    // Simulate active state
    webSpeechService.state.activeMessageId = message.id;
    webSpeechService.state.status = 'playing';
    await nextTick();
    
    // Header remains mini
    expect(wrapper.findAll('[data-testid="speech-toggle-mini"]').length).toBe(1);
    
    // Footer shows full panel
    expect(wrapper.find('[data-testid="speech-toggle-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="speech-stop-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="speech-restart-button"]').exists()).toBe(true);
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
    
    // Click pause on full panel
    await wrapper.find('[data-testid="speech-toggle-button"]').trigger('click');
    expect(pauseSpy).toHaveBeenCalled();
    
    // Simulate paused state
    webSpeechService.state.status = 'paused';
    await nextTick();
    
    // Click resume on full panel
    await wrapper.find('[data-testid="speech-toggle-button"]').trigger('click');
    expect(speakSpy).toHaveBeenCalledWith({ text: 'Hello', messageId: message.id });
  });

  it('stops speech when stop button is clicked', async () => {
    const stopSpy = vi.spyOn(webSpeechService, 'stop');
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });
    
    // Simulate active state
    webSpeechService.state.activeMessageId = message.id;
    webSpeechService.state.status = 'playing';
    await nextTick();
    
    await wrapper.find('[data-testid="speech-stop-button"]').trigger('click');
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
    
    await wrapper.find('[data-testid="speech-restart-button"]').trigger('click');
    expect(speakSpy).toHaveBeenCalledWith({ text: 'Hello', messageId: message.id });
  });
});