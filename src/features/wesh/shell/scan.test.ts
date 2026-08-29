import { describe, expect, it } from 'vitest';
import {
  findBalancedArithmeticExpression,
  findBalancedParenthesizedExpression,
  findBracedParameterEnd,
} from './scan';

describe('shell balanced scanning', () => {
  it('keeps nested command-substitution quotes scoped inside an outer double quote', () => {
    const text = `$(printf '%s' "$(printf '%s' "a)b")")tail`;

    const expression = findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    });

    expect(expression).toEqual({
      content: `printf '%s' "$(printf '%s' "a)b")"`,
      endIndex: text.indexOf('tail') - 1,
    });
  });

  it('keeps escaped single quotes inside ANSI-C quoted command-substitution words', () => {
    const text = String.raw`$(printf '%s' $'a\')b')tail`;

    expect(findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('keeps closing braces inside ANSI-C quoted parameter operands', () => {
    const text = "${value:-$'a\\'}b'}tail";

    expect(findBracedParameterEnd({ text, startIndex: 0 })).toBe(text.indexOf('tail') - 1);
  });

  it('keeps arithmetic terminators inside ANSI-C quoted arithmetic words', () => {
    const text = String.raw`$(( $'1\'x))2' + 3 ))tail`;

    expect(findBalancedArithmeticExpression({
      text,
      startIndex: 0,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('keeps heredoc data inside nested arithmetic command substitutions opaque', () => {
    const text = `\
$(( $(cat <<'END'
)))
END
printf 1
) + 2 ))tail`;

    expect(findBalancedArithmeticExpression({
      text,
      startIndex: 0,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('ignores closing parentheses inside command-substitution comments', () => {
    const text = `$(printf x # ) is a comment
)tail`;

    const expression = findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    });

    expect(expression).toEqual({
      content: `printf x # ) is a comment
`,
      endIndex: text.indexOf('tail') - 1,
    });
  });

  it('does not treat a hash after escaped whitespace as a comment start', () => {
    const text = `$(printf \\ #)tail`;

    const expression = findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    });

    expect(expression).toEqual({
      content: `printf \\ #`,
      endIndex: text.indexOf('tail') - 1,
    });
  });


  it('keeps comment eligibility across a removed backslash-newline', () => {
    const text = `$(printf x; \\
# )) continued comment
printf y)tail`;

    const expression = findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    });

    expect(expression).toEqual({
      content: `printf x; \\
# )) continued comment
printf y`,
      endIndex: text.indexOf('tail') - 1,
    });
  });


  it('does not treat a hash after a bare carriage return as a comment start', () => {
    const text = `$(: x\r# )tail`;

    expect(findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('keeps a bare carriage return inside a command-substitution comment', () => {
    const text = `$(printf x # comment\r )
printf y)tail`;

    expect(findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('does not remove a backslash-carriage-return-newline as a line continuation', () => {
    const text = `$(printf x\\\r\n# ) comment
printf y)tail`;

    expect(findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('does not treat arithmetic-expansion shift operators as heredocs', () => {
    const text = `\
$(printf '%s' $((1 << 2
)))tail`;

    expect(findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('does not treat arithmetic-command shift operators as heredocs', () => {
    const text = `\
$((( value = 1 << 2
)); printf '%s' "$value")tail`;

    expect(findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('ignores closing parentheses inside command-substitution heredoc bodies', () => {
    const text = `\
$(cat <<'END'
)
END
printf y
)tail`;

    const expression = findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    });

    expect(expression).toEqual({
      content: `\
cat <<'END'
)
END
printf y
`,
      endIndex: text.indexOf('tail') - 1,
    });
  });

  it('skips multiple and tab-stripped heredoc bodies before closing a substitution', () => {
    const text = `\
$(cat <<A <<-B
)
A
	))
	B
printf z
)tail`;

    const expression = findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    });

    expect(expression).toEqual({
      content: `\
cat <<A <<-B
)
A
	))
	B
printf z
`,
      endIndex: text.indexOf('tail') - 1,
    });
  });

  it('quote-removes locale-quoted heredoc delimiter parts', () => {
    const cases = [
      { word: '$"END"', delimiter: 'END' },
      { word: 'A$"BC"D', delimiter: 'ABCD' },
      { word: '$"E\\Q"', delimiter: 'E\\Q' },
    ] as const;

    for (const { word, delimiter } of cases) {
      const text = `\
$(cat <<${word}
+)
+${delimiter}
+printf y
+)tail`.replace(/^\+/gmu, '');

      expect(findBalancedParenthesizedExpression({
        text,
        startIndex: 1,
      })?.endIndex).toBe(text.indexOf('tail') - 1);
    }
  });

  it('preserves carriage returns in CRLF heredoc delimiters', () => {
    const text = `$(cat <<EOF\r\n)\r\nEOF\r\nprintf y\r\n)tail`;

    expect(findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('preserves carriage returns after quoted CRLF heredoc delimiters', () => {
    const text = `$(cat <<'EOF'\r\n)\r\nEOF\r\nprintf y\r\n)tail`;

    expect(findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('does not treat here-strings as pending heredocs', () => {
    const text = `$(cat <<<')')tail`;

    expect(findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    })?.endIndex).toBe(text.indexOf('tail') - 1);
  });

  it('keeps a substitution incomplete when a pending heredoc has no delimiter line', () => {
    const text = `\
$(cat <<END
)
`;

    expect(findBalancedParenthesizedExpression({
      text,
      startIndex: 1,
    })).toBeUndefined();
  });

  it('keeps unexpanded shell constructs intact in heredoc delimiters', () => {
    const cases = [
      `\
$(cat <<$(printf 'END')
)
$(printf 'END')
printf a
)tail`,
      `\
$(cat <<${'${name:-END}'}
)
${'${name:-END}'}
printf b
)tail`,
      `\
$(cat <<$((1 + 2))
)
$((1 + 2))
printf c
)tail`,
      `\
$(cat <<\`printf END\`
)
\`printf END\`
printf d
)tail`,
      `\
$(cat <<"E\\Q"
)
E\\Q
printf e
)tail`,
      `\
$(cat <<$'E\\x4eD'
)
END
printf f
)tail`,
    ];

    for (const text of cases) {
      expect(findBalancedParenthesizedExpression({
        text,
        startIndex: 1,
      })?.endIndex).toBe(text.indexOf('tail') - 1);
    }
  });

  it('ignores closing braces inside double-quoted parameter operands', () => {
    const text = `${'${value:-"}"}'}tail`;

    expect(findBracedParameterEnd({ text, startIndex: 0 })).toBe(text.indexOf('tail') - 1);
  });

  it('keeps process-substitution braces inside parameter operands', () => {
    for (const text of [
      `${'${value:-<(printf %s a}b)}'}tail`,
      `${'${value:->(printf %s a}b)}'}tail`,
      `\
\${value:-<(printf a; # }
printf b)}tail`,
      `\
\${value:-<(cat <<'END'
}
END
printf b)}tail`,
    ]) {
      expect(findBracedParameterEnd({ text, startIndex: 0 })).toBe(text.indexOf('tail') - 1);
    }
  });

});
