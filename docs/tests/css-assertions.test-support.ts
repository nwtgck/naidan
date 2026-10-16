import { parse } from 'postcss';

// Assertions describe declarations and their order, not their source layout.
// Remove only AST-owned layout whitespace; keep selector/value spelling,
// comments, custom-property token streams, and significant internal spaces.
export function cssForAssertions({ css }: { css: string }): string {
  const root = parse(css);
  root.raws.after = '';
  root.walk(node => {
    node.raws.before = '';
    if ('nodes' in node) node.raws.after = '';
    switch (node.type) {
    case 'decl':
      if (!node.prop.startsWith('--') && /^[\t\n\f\r ]*:[\t\n\f\r ]*$/u.test(node.raws.between ?? '')) node.raws.between = ':';
      break;
    case 'rule':
    case 'atrule':
      if (/^[\t\n\f\r ]*$/u.test(node.raws.between ?? '')) node.raws.between = '';
      break;
    case 'comment': break;
    default: {
      const _ex: never = node;
      throw new Error(`Unexpected CSS node ${String(_ex)}`);
    }
    }
  });
  return root.toString();
}
