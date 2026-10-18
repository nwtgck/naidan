import { parse } from 'postcss';
import { ident, tokenize, tokenTypes } from 'css-tree';

// PostCSS can misclassify escaped custom-property names and directly escaped
// whitespace. Keep those stylesheets opaque instead of rejecting valid CSS.
// Ordinary selector escapes, quoted strings and comments remain formatable.
export function unsafeSyntax({ css }) {
  const tokens = [];
  tokenize(css, (type, start, end) => {
    if (type !== tokenTypes.WhiteSpace && type !== tokenTypes.Comment) {
      tokens.push({ type, start, raw: css.slice(start, end) });
    }
  });
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  for (const [index, token] of tokens.entries()) {
    const { type, start, raw } = token;
    if (type !== tokenTypes.String) {
      // Consume complete escapes so an escaped backslash and a numeric
      // escape's optional whitespace terminator are not false positives.
      for (const escape of raw.matchAll(/\\(?:[\da-f]{1,6}(?:\r\n|[\t\n\f\r ])?|[\s\S])/giu)) {
        if (/^[\\][\t\n\f\r ]/u.test(escape[0])) {
          return { offset: start };
        }
      }
      // CSS-tree does not classify escaped spellings of url() as URL tokens.
      // Protect at that function token before comment-like URL text can hide
      // later declarations. Ordinary URL tokens handle escaped ')' correctly.
      if (type === tokenTypes.Function && raw.includes('\\') && ident.decode(raw.slice(0, -1)).toLowerCase() === 'url') {
        return { offset: start };
      }
      // PostCSS's special handling of /* inside an unquoted URL only covers
      // the lowercase spelling, while CSS treats the function name equally.
      if (type === tokenTypes.Url && raw.includes('/*') && !raw.startsWith('url(')) {
        return { offset: start };
      }
      if (type === tokenTypes.Ident && !raw.startsWith('--') && ident.decode(raw).startsWith('--')
        && braces > 0 && parentheses === 0 && brackets === 0
        && [tokenTypes.LeftCurlyBracket, tokenTypes.RightCurlyBracket, tokenTypes.Semicolon].includes(tokens[index - 1]?.type)
        && tokens[index + 1]?.type === tokenTypes.Colon) {
        return { offset: start };
      }
    }
    switch (type) {
    case tokenTypes.LeftCurlyBracket: braces += 1;
      break;
    case tokenTypes.RightCurlyBracket: braces -= 1;
      break;
    case tokenTypes.Function:
    case tokenTypes.LeftParenthesis: parentheses += 1;
      break;
    case tokenTypes.RightParenthesis: parentheses -= 1;
      break;
    case tokenTypes.LeftSquareBracket: brackets += 1;
      break;
    case tokenTypes.RightSquareBracket: brackets -= 1;
      break;
    default: break;
    }
  }
  return undefined;
}

// PostCSS counts lines using LF. Convert its positions back to source offsets
// before ESLint applies its own line-ending-aware location mapping.
export function syntaxErrorOffset({ css, error }) {
  const prefix = css.startsWith('\uFEFF') ? 1 : 0;
  css = css.slice(prefix);
  let offset = 0;
  for (let line = 1; line < error.line; line += 1) {
    const next = css.indexOf('\n', offset);
    if (next < 0) {
      break;
    }
    offset = next + 1;
  }
  return prefix + Math.min(css.length, offset + Math.max(0, error.column - 1));
}

export function parseStylesheet({ css }) {
  // PostCSS strips a leading BOM internally; keep offsets relative to the
  // original source explicit instead of letting every edit shift by one byte.
  const prefix = css.startsWith('\uFEFF') ? 1 : 0;
  const body = css.slice(prefix);
  const unsafe = unsafeSyntax({ css: body });
  return { root: unsafe ? undefined : parse(body), prefix, unsafe };
}

export default {
  meta: { name: 'naidan-css-layout-parser', version: '1.0.0' },
  // External ESLint parser contract requires positional arguments.
  parseForESLint(code) {
    let stylesheet;
    try {
      stylesheet = parseStylesheet({ css: code });
    } catch (error) {
      if (error.name !== 'CssSyntaxError') {
        throw error;
      }
      const index = syntaxErrorOffset({ css: code, error });
      const before = code.slice(0, index).split(/\r\n|[\n\r\u2028\u2029]/u);
      throw Object.assign(new SyntaxError(error.reason), {
        index, lineNumber: before.length, column: before.at(-1).length + 1,
      });
    }
    const lines = code.split(/\r\n|[\n\r\u2028\u2029]/u);
    return {
      // This adapter exposes CSS through services, not pretend JS statements.
      // JavaScript rules must stay excluded from the dedicated CSS config.
      ast: {
        type: 'Program', body: [], sourceType: 'module', tokens: [], comments: [],
        range: [0, code.length],
        loc: { start: { line: 1, column: 0 }, end: { line: lines.length, column: lines.at(-1).length } },
      },
      services: { cssLayoutStylesheet: stylesheet },
      visitorKeys: { Program: [] },
    };
  },
};
