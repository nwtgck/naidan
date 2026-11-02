import { describe, expect, it } from 'vitest';
import { liveShellArgsSchema, readLiveShellCall } from './wesh-policy';

describe('live Wesh approval boundary', () => {
  it('validates arguments without executing anything', () => {
    expect(readLiveShellCall({ call: { id: 'call-1', type: 'function', function: { name: 'shell_execute', arguments: '{"shell_script":"ls /workspace"}' } } })).toEqual({ shell_script: 'ls /workspace' });
  });

  it.each([
    { shell_script: '' }, { shell_script: 'x'.repeat(8193) }, { shell_script: 'ls', timeout_ms: 0 },
    { shell_script: 'ls', timeout_ms: 15001 }, { shell_script: 'ls', stdout_limit: 16385 },
    { shell_script: 'ls', stderr_limit: -1 }, { shell_script: 'ls', extra: true },
  ])('rejects unbounded or unknown tool inputs %j', args => {
    expect(liveShellArgsSchema.safeParse(args).success).toBe(false);
  });

  it.each(['calculator', 'exec', 'shell_execute2'])('rejects an unoffered tool %s', name => {
    expect(() => readLiveShellCall({ call: { id: 'call', type: 'function', function: { name, arguments: '{}' } } })).toThrow();
  });
});
