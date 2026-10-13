import { parse } from '@vue/compiler-sfc';
import { NodeTypes, parse as parseTemplate } from '@vue/compiler-dom';
import type { TemplateChildNode } from '@vue/compiler-dom';

// This is an authoring guard, not an execution sandbox for untrusted Vue code.
// All article/components are reviewed source; interactions belong in islands.
export function validateStaticComponent({ source, filename, mode }: { source: string; filename: string; mode: 'static' | 'island' }): void {
  const { descriptor, errors } = parse(source, { filename });
  if (errors.length) throw new Error(`Invalid Docs component ${filename}: ${errors.map(String).join('; ')}`);
  if (descriptor.template?.src || descriptor.template?.lang) {
    throw new Error(`Docs templates must be inline HTML: ${filename}`);
  }
  const root = parseTemplate(descriptor.template?.content ?? '');
  const visit = ({ node }: { node: TemplateChildNode }): void => {
    if (node.type !== NodeTypes.ELEMENT) return;
    if (['script', 'iframe', 'object', 'embed', 'base'].includes(node.tag.toLowerCase())) {
      throw new Error(`Unsupported active element <${node.tag}> in ${filename}`);
    }
    for (const prop of node.props) {
      if (prop.type === NodeTypes.ATTRIBUTE && prop.name.toLowerCase().startsWith('on')) {
        throw new Error(`Inline event attribute in ${filename}`);
      }
      if (prop.type !== NodeTypes.DIRECTIVE) continue;
      if (prop.name === 'html') throw new Error(`v-html is not supported in Docs: ${filename}`);
      if (mode === 'static' && (prop.name === 'on' || prop.name === 'model')) {
        throw new Error(`Interactive binding on static Docs component; use an island: ${filename}`);
      }
      if (prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic && prop.arg.content.toLowerCase().startsWith('on')) {
        throw new Error(`Event property binding in ${filename}`);
      }
      if (prop.name === 'bind' && (!prop.arg || prop.arg.type !== NodeTypes.SIMPLE_EXPRESSION || !prop.arg.isStatic)) {
        throw new Error(`Docs bindings require an explicit static attribute name: ${filename}`);
      }
    }
    node.children.forEach(child => visit({ node: child }));
  };
  root.children.forEach(node => visit({ node }));
}
