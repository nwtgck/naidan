import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import ShellExecuteToolCall from './ShellExecuteToolCall.vue';
import type { ToolExecutionResult } from '@/services/tools/types';

vi.mock('lucide-vue-next', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    ChevronDown: { render: () => h('span') },
    ChevronRight: { render: () => h('span') },
    WrapText: { render: () => h('span') },
  };
});

const makeResult = (text = 'output text'): ToolExecutionResult => ({
  toolCallId: 'call-1',
  status: 'success',
  content: { type: 'text', text },
});

const validArgs = JSON.stringify({
  shell_script: 'echo hello',
  stdout_limit: 4096,
  stderr_limit: 4096,
});

const invalidArgs = '{"not_shell": true}';

describe('ShellExecuteToolCall', () => {
  it('renders terminal block with $ prefix for valid args', () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: validArgs, result: makeResult() },
    });

    const pre = wrapper.find('pre');
    expect(pre.exists()).toBe(true);
    expect(pre.text()).toContain('$ ');
    expect(pre.text()).toContain('echo hello');
  });

  it('falls back to generic Arguments display for invalid args', () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: invalidArgs, result: makeResult() },
    });

    expect(wrapper.text()).toContain('Arguments');
    expect(wrapper.find('[data-testid="shell-execute-raw-toggle"]').exists()).toBe(false);
  });

  it('shows result text', () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: validArgs, result: makeResult('hello world') },
    });

    expect(wrapper.text()).toContain('hello world');
  });

  it('does not show result while executing', () => {
    const result: ToolExecutionResult = { toolCallId: 'call-1', status: 'executing' };
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: validArgs, result },
    });

    expect(wrapper.text()).not.toContain('hello world');
  });

  it('raw JSON is hidden by default', () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: validArgs, result: makeResult() },
    });

    expect(wrapper.find('[data-testid="shell-execute-raw-json"]').exists()).toBe(false);
  });

  it('raw JSON is shown after toggle click', async () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: validArgs, result: makeResult() },
    });

    await wrapper.find('[data-testid="shell-execute-raw-toggle"]').trigger('click');

    const raw = wrapper.find('[data-testid="shell-execute-raw-json"]');
    expect(raw.exists()).toBe(true);
    expect(raw.text()).toContain('echo hello');
  });

  it('raw JSON toggle click hides it again', async () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: validArgs, result: makeResult() },
    });

    await wrapper.find('[data-testid="shell-execute-raw-toggle"]').trigger('click');
    await wrapper.find('[data-testid="shell-execute-raw-toggle"]').trigger('click');

    expect(wrapper.find('[data-testid="shell-execute-raw-json"]').exists()).toBe(false);
  });

  it('command wraps by default (whitespace-pre-wrap)', () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: validArgs, result: makeResult() },
    });

    expect(wrapper.find('pre').classes()).toContain('whitespace-pre-wrap');
  });

  it('wrap toggle switches to no-wrap', async () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: validArgs, result: makeResult() },
    });

    await wrapper.find('[data-testid="shell-execute-wrap-toggle"]').trigger('click');

    expect(wrapper.find('pre').classes()).not.toContain('whitespace-pre-wrap');
    expect(wrapper.find('pre').classes()).toContain('whitespace-pre');
  });

  it('wrap toggle click twice restores wrap', async () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: validArgs, result: makeResult() },
    });

    await wrapper.find('[data-testid="shell-execute-wrap-toggle"]').trigger('click');
    await wrapper.find('[data-testid="shell-execute-wrap-toggle"]').trigger('click');

    expect(wrapper.find('pre').classes()).toContain('whitespace-pre-wrap');
  });

  it('shows error code and message for error result', () => {
    const result: ToolExecutionResult = {
      toolCallId: 'call-1',
      status: 'error',
      error: { code: 'execution_failed', message: { type: 'text', text: 'exit code 1' } },
    };
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: validArgs, result },
    });

    expect(wrapper.text()).toContain('execution_failed');
    expect(wrapper.text()).toContain('exit code 1');
  });
});
