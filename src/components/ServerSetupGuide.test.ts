import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ServerSetupGuide from './ServerSetupGuide.vue';

describe('ServerSetupGuide.vue', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders Ollama guide by default with Windows settings', () => {
    const wrapper = mount(ServerSetupGuide);
    expect(wrapper.text()).toContain('Ollama');
    // Step 1: Download
    expect(wrapper.find('a[href="https://ollama.com/download/windows"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('External');
    
    // Step 2: Run command
    expect(wrapper.text()).toContain('ollama serve');
    expect(wrapper.text()).toContain('ollama run gemma3n:e2b');
    expect(wrapper.text()).toContain('Run Gemma 3n');
  });

  it('switches to macOS and shows Homebrew command', async () => {
    const wrapper = mount(ServerSetupGuide);
    const macBtn = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'mac');
    await macBtn?.trigger('click');
    
    expect(wrapper.text()).toContain('brew install ollama');
    expect(wrapper.text()).toContain('ollama run gemma3n:e2b');
  });

  it('switches to Linux and shows curl command', async () => {
    const wrapper = mount(ServerSetupGuide);
    const linuxBtn = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'linux');
    await linuxBtn?.trigger('click');
    
    expect(wrapper.text()).toContain('curl -fsSL https://ollama.com/install.sh | sh');
    expect(wrapper.text()).toContain('ollama run gemma3n:e2b');
  });

  it('switches to llama-server and shows simplified HF command', async () => {
    const wrapper = mount(ServerSetupGuide);
    const llamaBtn = wrapper.findAll('button').find(b => b.text() === 'llama-server');
    await llamaBtn?.trigger('click');
    
    expect(wrapper.text()).toContain('Releases');
    expect(wrapper.text()).toContain('./llama-server -hf ggml-org/gemma-3n-E2B-it-GGUF');
    expect(wrapper.text()).not.toContain('-fa');
    expect(wrapper.text()).not.toContain('-p 8080');
    expect(wrapper.text()).not.toContain('--jinja');
  });

  it('verifies security attributes on external links', () => {
    const wrapper = mount(ServerSetupGuide);
    const links = wrapper.findAll('a');
    links.forEach(link => {
      expect(link.attributes('rel')).toBe('noopener noreferrer');
      expect(link.attributes('target')).toBe('_blank');
    });
  });

  it('ensures code blocks are scrollable and don\'t wrap', () => {
    const wrapper = mount(ServerSetupGuide);
    const preTags = wrapper.findAll('pre');
    preTags.forEach(pre => {
      expect(pre.classes()).toContain('overflow-x-auto');
      expect(pre.classes()).toContain('whitespace-nowrap');
    });
  });

  it('isolates copy state and uses white check icon', async () => {
    // We need to use a platform that has two copy buttons visible, like Linux Ollama
    const wrapper = mount(ServerSetupGuide);
    const linuxBtn = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'linux');
    await linuxBtn?.trigger('click');

    const copyButtons = wrapper.findAll('button').filter(b => b.find('svg').exists() && !b.text());
    expect(copyButtons.length).toBe(3);

    const firstBtn = copyButtons[0];
    const secondBtn = copyButtons[1];
    expect(firstBtn).toBeDefined();
    expect(secondBtn).toBeDefined();

    // Click the first copy button
    await firstBtn!.trigger('click');

    // First button should show check icon, second should still show copy icon
    expect(firstBtn!.find('svg').classes()).toContain('lucide-check');
    expect(firstBtn!.find('svg').classes()).toContain('text-white');
    expect(secondBtn!.find('svg').classes()).toContain('lucide-copy');
  });
});
