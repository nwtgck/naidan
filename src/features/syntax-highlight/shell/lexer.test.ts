import { describe, expect, it } from 'vitest';
import { createShellHighlighter, TEST_ONLY } from './lexer';
import { createTokenDisplay } from '@/features/syntax-highlight/token-display';

function highlightShell({ code }: { code: string }) {
  const display = createTokenDisplay();
  display.apply({ edit: createShellHighlighter().update({ edit: { offset: 0, text: code } }) });
  return display.tokens;
}

describe('highlightShell', () => {
  it('colors shell structure without changing whitespace or literal arguments', () => {
    const code = `\
# Greeting
if test "$name"; then
  printf '%s\\n' $HOME \${name:-guest} $(whoami) file#suffix
fi
`;
    const tokens = highlightShell({ code });
    expect(tokens.map(token => token.text).join('')).toBe(code);
    expect(tokens).toContainEqual({ kind: 'comment', text: '# Greeting' });
    expect(tokens).toContainEqual({ kind: 'keyword', text: 'if' });
    expect(tokens).toContainEqual({ kind: 'command', text: 'printf' });
    expect(tokens).toContainEqual({ kind: 'string', text: "'%s\\n'" });
    expect(tokens).toContainEqual({ kind: 'variable', text: '$HOME' });
    expect(tokens).toContainEqual({ kind: 'variable', text: '${name:-guest}' });
    expect(tokens).toContainEqual({ kind: 'command', text: 'whoami' });
    expect(tokens.some(token => token.kind === 'comment' && token.text.includes('suffix'))).toBe(false);
  });

  it('preserves every incomplete prefix, escapes, Unicode and malformed input', () => {
    const code = `\
NAME=値 echo "a\\"b" 'c\\d' \${name:-$(echo 日)} $_name \\
  🐈 \u0000 \uD800
cat <<-'EOF'
\t<script>echo $HOME</script>
\tEOF
echo "unfinished\\`;
    for (let end = 0; end <= code.length; end++) {
      const prefix = code.slice(0, end);
      expect(highlightShell({ code: prefix }).map(token => token.text).join('')).toBe(prefix);
    }
    expect(highlightShell({ code: '$_name' })).toEqual([{ kind: 'variable', text: '$_name' }]);
  });

  it('keeps quoted heredoc payloads opaque and resumes highlighting after their delimiter', () => {
    const code = `\
cat > index.html <<'EOF'
<script>if (danger) alert('$HOME')</script>
EOF
echo done`;
    const tokens = highlightShell({ code });
    expect(tokens.map(token => token.text).join('')).toBe(code);
    expect(tokens).toContainEqual({ kind: 'string', text: `\
<script>if (danger) alert('$HOME')</script>
EOF
` });
    expect(tokens).toContainEqual({ kind: 'command', text: 'echo' });
    expect(tokens.filter(token => token.kind === 'variable')).toEqual([]);
  });

  it('handles tab-stripped and multiple heredocs without normalizing their source', () => {
    const code = `\
cat <<-ONE <<"TWO"
\tfirst
\tONE
<div>$second</div>
TWO
printf done`;
    const tokens = highlightShell({ code });
    expect(tokens.map(token => token.text).join('')).toBe(code);
    expect(tokens).toContainEqual({ kind: 'string', text: `\
\tfirst
\tONE
<div>$second</div>
TWO
` });
    expect(tokens).toContainEqual({ kind: 'command', text: 'printf' });
  });

  it('recognizes a single tab-stripped heredoc and resumes after its indented delimiter', () => {
    const code = `\
cat <<-EOF
\t<script>if $name</script>
\tEOF
echo done`;
    const tokens = highlightShell({ code });
    expect(tokens.map(token => token.text).join('')).toBe(code);
    expect(tokens).toContainEqual({ kind: 'operator', text: '<<-' });
    expect(tokens).toContainEqual({ kind: 'string', text: `\
\t<script>if $name</script>
\tEOF
` });
    expect(tokens).toContainEqual({ kind: 'command', text: 'echo' });
    expect(tokens.filter(token => token.kind === 'variable')).toEqual([]);
  });

  it('keeps unfinished heredoc payloads opaque', () => {
    const code = `\
cat <<EOF
<html>if $name`;
    expect(highlightShell({ code }).at(-1)).toEqual({ kind: 'string', text: '<html>if $name' });
  });
});

describe('incremental shell highlighting', () => {
  const scripts = [
    'ps1=$(cat /proc/version 2>/dev/null | head -1)',
    'if echo "$HOME $(printf \'%s\' "$(whoami)")"; then NAME=value echo done; fi',
    'echo \\#literal # comment\n',
    'echo "partial\\',
    'echo ${name:-value} $_NAME $1 $? $$',
    `\
cat <<-EOF <<"SECOND"
\t<html>$ignored 🐈</html>
\tEOF
echo still payload
SECOND
printf done`,
    `\
cat <<< "$HOME"
echo following`,
  ];

  it.each(scripts)('matches one-shot colors at every possible two-chunk boundary: %s', code => {
    const expected = highlightShell({ code });
    for (let split = 0; split <= code.length; split++) {
      const highlighter = createShellHighlighter();
      const display = createTokenDisplay();
      display.apply({ edit: highlighter.update({ edit: { offset: 0, text: code.slice(0, split) } }) });
      expect(display.tokens.map(token => token.text).join('')).toBe(code.slice(0, split));
      display.apply({ edit: highlighter.update({ edit: { offset: split, text: code.slice(split) } }) });
      expect(display.tokens).toEqual(expected);
      expect(display.tokens.map(token => token.text).join('')).toBe(code);
    }
  });

  it('colors command substitution commands and paths separately from the assignment', () => {
    const code = 'ps1=$(cat /proc/version 2>/dev/null | head -1)';
    const tokens = highlightShell({ code });
    expect(tokens).toContainEqual({ kind: 'variable', text: 'ps1=' });
    expect(tokens).toContainEqual({ kind: 'command', text: 'cat' });
    expect(tokens).toContainEqual({ kind: 'command', text: 'head' });
    expect(tokens.filter(token => token.kind === 'plain').map(token => token.text).join('')).toContain('/proc/version');
    expect(tokens.filter(token => token.kind === 'plain').map(token => token.text).join('')).toContain('/dev/null');
  });

  it('scans long quotes and heredocs linearly without retransmitting their prefix', () => {
    for (const code of ['echo "' + 'x'.repeat(8000) + '"', "cat <<'EOF'\n" + 'x'.repeat(8000) + '\nEOF\n']) {
      const highlighter = createShellHighlighter();
      const display = createTokenDisplay();
      let emittedCharacters = 0;
      for (let offset = 0; offset < code.length; offset++) {
        const edit = highlighter.update({ edit: { offset, text: code[offset]! } });
        emittedCharacters += edit.tokens.reduce((total, token) => total + token.text.length, 0);
        display.apply({ edit });
      }
      expect(TEST_ONLY.examinedCharacters({ highlighter })).toBeLessThanOrEqual(code.length * 2);
      expect(emittedCharacters).toBeLessThan(code.length + 30);
      expect(display.tokens).toEqual(highlightShell({ code }));
    }
  });

  it('rebuilds on suffix corrections and truncations using the same source contract', () => {
    const highlighter = createShellHighlighter();
    const display = createTokenDisplay();
    display.apply({ edit: highlighter.update({ edit: { offset: 0, text: 'echo "old' } }) });
    display.apply({ edit: highlighter.update({ edit: { offset: 6, text: 'new"; printf done' } }) });
    expect(display.tokens).toEqual(highlightShell({ code: 'echo "new"; printf done' }));
    display.apply({ edit: highlighter.update({ edit: { offset: 2, text: '' } }) });
    expect(display.tokens).toEqual(highlightShell({ code: 'ec' }));
    display.apply({ edit: highlighter.update({ edit: { offset: 0, text: '' } }) });
    expect(display.tokens).toEqual([]);
  });
});
