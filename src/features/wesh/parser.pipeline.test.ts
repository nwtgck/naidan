import { describe, expect, it } from 'vitest';
import { parseCommandLine, parseNextShellUnit } from './parser';

describe('Shell pipeline grammar', () => {
  it.each([
    { source: 'printf %s 7 >&2 | cat', args: ['%s', '7'], descriptors: [1] },
    { source: 'printf %s 7&>combined | cat', args: ['%s', '7'], descriptors: [1, 2] },
    { source: 'printf %s 7&>>combined | cat', args: ['%s', '7'], descriptors: [1, 2] },
    { source: 'printf %s x 2>error | cat', args: ['%s', 'x'], descriptors: [2] },
    { source: 'printf %s x 2\\\n>error | cat', args: ['%s', 'x'], descriptors: [2] },
    { source: 'printf %s x \\\n2>error | cat', args: ['%s', 'x'], descriptors: [2] },
    { source: 'printf %s x 1\\\n2\\\n>error | cat', args: ['%s', 'x'], descriptors: [12] },
    { source: 'printf %s x 2\\\n >error | cat', args: ['%s', 'x', '2\\\n'], descriptors: [1] },
  ])('reads numeric words and redirections in $source', ({ source, args, descriptors }) => {
    expect(parseCommandLine({ commandLine: source })).toMatchObject({
      kind: 'pipeline',
      commands: [{ args, redirections: descriptors.map(fd => ({ fd })) }, { name: 'cat' }],
    });
  });

  it('allows a line continuation before a compound stage redirection', () => {
    expect(parseCommandLine({ commandLine: '(printf x) \\\n 2>error | cat' })).toMatchObject({
      kind: 'pipeline',
      commands: [{ kind: 'redirected', redirections: [{ fd: 2, target: 'error' }] }, { name: 'cat' }],
    });
    expect(parseNextShellUnit({
      commandLine: '(printf x) \\\n',
      sourceCompletion: 'may-continue',
    })).toEqual({ kind: 'needs-more-source' });
  });

  it.each(['(printf x) 2', '(printf x) \\\n 2'])('waits for a redirection operator after a partial source ending in %s', commandLine => {
    expect(parseNextShellUnit({ commandLine, sourceCompletion: 'may-continue' })).toEqual({ kind: 'needs-more-source' });
    expect(parseNextShellUnit({ commandLine: commandLine + '>error\n', sourceCompletion: 'may-continue' })).toMatchObject({
      kind: 'parsed',
      node: { kind: 'redirected', redirections: [{ fd: 2, target: 'error' }] },
    });
  });

  it.each([
    { script: 'for item in a b; do printf "$item"; done | cat', kind: 'for' },
    { script: 'while false; do printf unused; done | cat', kind: 'while' },
    { script: 'until true; do printf unused; done | cat', kind: 'until' },
    { script: 'if true; then printf yes; fi | cat', kind: 'if' },
    { script: 'case x in x) printf yes;; esac | cat', kind: 'case' },
    { script: '{ printf yes; } | cat', kind: 'list' },
    { script: '(printf yes) | cat', kind: 'subshell' },
    { script: '((1)) | cat', kind: 'arithmeticCommand' },
    { script: 'value=child | cat', kind: 'assignment' },
    { script: 'function sample { printf yes; } | cat', kind: 'functionDefinition' },
    { script: '{ printf yes; } >saved | cat', kind: 'redirected' },
  ])('accepts a $kind as the first stage', ({ script, kind }) => {
    expect(parseCommandLine({ commandLine: script })).toMatchObject({
      kind: 'pipeline',
      commands: [{ kind }, { kind: 'command', name: 'cat' }],
    });
  });

  it('keeps a compound middle stage and appends implicit stderr duplication after its redirections', () => {
    const node = parseCommandLine({
      commandLine: 'printf input | { cat; printf error >&2; } 2>errors |& cat',
    });
    expect(node).toMatchObject({
      kind: 'pipeline',
      commands: [
        { kind: 'command', name: 'printf' },
        {
          kind: 'redirected',
          node: { kind: 'list' },
          redirections: [
            { fd: 2, type: 'write', target: 'errors' },
            { fd: 2, type: 'dup_output', targetFd: 1 },
          ],
        },
        { kind: 'command', name: 'cat' },
      ],
    });
  });

  it('waits for the next stage when a compound pipeline source is incomplete', () => {
    expect(parseNextShellUnit({
      commandLine: 'for item in a b; do printf "$item"; done |',
      sourceCompletion: 'may-continue',
    })).toEqual({ kind: 'needs-more-source' });
  });

  it('applies the background operator to the complete brace group', () => {
    expect(parseNextShellUnit({
      commandLine: '{ printf before; printf after; } &\n',
      sourceCompletion: 'may-continue',
    })).toMatchObject({
      kind: 'parsed',
      node: {
        kind: 'list',
        parts: [{
          operator: '&',
          node: {
            kind: 'list',
            parts: [
              { node: { name: 'printf', args: ['before'] }, operator: ';' },
              { node: { name: 'printf', args: ['after'] }, operator: ';' },
            ],
          },
        }],
      },
    });
  });

  it.each(['printf left |', '(printf left |)', 'for item in a; do printf left | done'])('rejects a missing stage in %s', (script) => {
    expect(() => parseCommandLine({ commandLine: script })).toThrow('Expected command after pipe');
  });
});
