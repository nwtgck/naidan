import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import ShellExecuteToolCall from './ShellExecuteToolCall.vue';
import type { ToolExecutionResult } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

vi.mock('lucide-vue-next', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    ChevronDownIcon: { render: () => h('span') },
    ChevronRightIcon: { render: () => h('span') },
    WrapTextIcon: { render: () => h('span') },
  };
});

const makeResult = (text = 'output text'): ToolExecutionResult => ({
  toolCallId: toToolCallId({ raw: 'call-1' }),
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
  it('decodes partial shell escapes only when each escape is complete', async () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: '{"shell_script":"echo \\', result: undefined, argumentState: 'partial' },
    });
    expect(wrapper.find('pre').text()).toBe('$ echo');
    await wrapper.setProps({ args: '{"shell_script":"echo \\"hello\\"\\n\\u65' });
    expect(wrapper.find('pre').text()).toBe('$ echo "hello"');
    await wrapper.setProps({ args: '{"shell_script":"echo \\"hello\\"\\n\\u65e5' });
    expect(wrapper.find('pre').text()).toBe(`\
$ echo "hello"
日`);
  });

  it('resets a partial preview when a native parser replaces its earlier snapshot', async () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: '{"shell_script":"echo previous', result: undefined, argumentState: 'partial' },
    });
    await wrapper.setProps({ args: '{"shell_script":"printf corrected' });
    expect(wrapper.find('pre').text()).toBe('$ printf corrected');
    await wrapper.setProps({ args: '{"shell_script":"printf corrected\\q' });
    expect(wrapper.find('pre').text()).toBe('{"shell_script":"printf corrected\\q');
    await wrapper.setProps({ args: '{"shell_script":"echo recovered"}' });
    expect(wrapper.find('pre').text()).toBe('$ echo recovered');
  });

  it('keeps a closed script visible while the remaining numeric arguments arrive', async () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: '{"shell_script":"echo hi', result: undefined, argumentState: 'partial' },
    });
    for (const args of [
      '{"shell_script":"echo hi"',
      '{"shell_script":"echo hi", "std',
      '{"shell_script":"echo hi", "stdout_limit":',
      '{"shell_script":"echo hi", "stdout_limit":4096, "stderr_limit":',
      '{"shell_script":"echo hi", "stdout_limit":4096, "stderr_limit":4096}',
    ]) {
      await wrapper.setProps({ args });
      expect(wrapper.find('pre').text()).toBe('$ echo hi');
    }
    // Draft display does not validate the trailing fields or imply executability.
    await wrapper.setProps({ args: '{"shell_script":"echo hi", "stdout_limit":"bad"}' });
    expect(wrapper.find('pre').text()).toBe('$ echo hi');
    await wrapper.setProps({ argumentState: 'complete' });
    expect(JSON.parse(wrapper.find('pre').text())).toEqual({ shell_script: 'echo hi', stdout_limit: 'bad' });
  });

  it('does not use an incomplete or malformed script for a completed call', () => {
    const wrapper = mount(ShellExecuteToolCall, {
      props: { args: '{"shell_script":"echo incomplete', result: makeResult() },
    });
    expect(wrapper.find('pre').text()).toBe('{"shell_script":"echo incomplete');
  });

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
    const result: ToolExecutionResult = { toolCallId: toToolCallId({ raw: 'call-1' }), status: 'executing' };
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
      toolCallId: toToolCallId({ raw: 'call-1' }),
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
