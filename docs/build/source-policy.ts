import { parse } from '@vue/compiler-sfc';
import { NodeTypes, parse as parseTemplate } from '@vue/compiler-dom';
import type { TemplateChildNode } from '@vue/compiler-dom';

const nativeAnchorComponents = new Set([
  'components/DocsLink.vue',
  'components/SkipToContentLink.vue',
  'components/ExternalLink.vue',
  'components/AppEntryLink.vue',
]);

const reservedIslandAttributes = new Set(['data-docs-island', 'data-docs-props', 'data-docs-hydrated']);
const supportedStaticDirectives = new Set([
  'bind', 'cloak', 'else', 'else-if', 'for', 'if', 'memo', 'once', 'pre', 'show', 'slot', 'text',
]);

function staticTemplateError({ source, filename, offset, reason, remedy }: {
  source: string;
  filename: string;
  offset: number;
  reason: string;
  remedy: string;
}): never {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const column = before.length - before.lastIndexOf('\n');
  throw new Error(`${filename}:${line}:${column}: ${reason} ${remedy}`);
}

// This is an authoring guard, not an execution sandbox for untrusted Vue code.
// All article/components are reviewed source; interactions belong in islands.
export function validateStaticComponent({ source, filename, mode }: { source: string; filename: string; mode: 'static' | 'island' }): void {
  const { descriptor, errors } = parse(source, { filename });
  if (mode === 'static' && descriptor.script) {
    const { line, column } = descriptor.script.loc.start;
    throw new Error(`${filename}:${line}:${column}: Static Docs components support only inline <script setup>. Move browser behavior into a registered island.`);
  }
  if (mode === 'static' && descriptor.scriptSetup?.src) {
    const { line, column } = descriptor.scriptSetup.loc.start;
    throw new Error(`${filename}:${line}:${column}: Static Docs <script setup> must be inline so its authoring rules can be checked. Move browser behavior into a registered island.`);
  }
  if (mode === 'static' && descriptor.scriptSetup && ['tsx', 'jsx'].includes(descriptor.scriptSetup.lang ?? '')) {
    const { line, column } = descriptor.scriptSetup.loc.start;
    throw new Error(`${filename}:${line}:${column}: Static Docs JSX is supported only in locale message modules. Write page markup in the template.`);
  }
  if (mode === 'static' && errors.some(error => String(error).includes('<script setup> cannot use the "src" attribute'))) {
    const beforeScript = source.slice(0, Math.max(0, source.search(/<script\b/u)));
    const line = beforeScript.split('\n').length;
    const column = beforeScript.length - beforeScript.lastIndexOf('\n');
    throw new Error(`${filename}:${line}:${column}: Static Docs <script setup> must be inline so its authoring rules can be checked. Move browser behavior into a registered island.`);
  }
  if (errors.length) throw new Error(`Invalid Docs component ${filename}: ${errors.map(String).join('; ')}`);
  if (descriptor.template?.src || descriptor.template?.lang) {
    throw new Error(`Docs templates must be inline HTML: ${filename}`);
  }
  const root = parseTemplate(descriptor.template?.content ?? '');
  const templateStart = descriptor.template?.loc.start.offset ?? 0;
  const visit = ({ node }: { node: TemplateChildNode }): void => {
    if (node.type !== NodeTypes.ELEMENT) return;
    if (mode === 'static' && node.tag.toLowerCase() === 'teleport') {
      staticTemplateError({
        source,
        filename,
        offset: templateStart + node.loc.start.offset,
        reason: 'Teleport content is omitted from the static Docs page.',
        remedy: 'Render the content inline.',
      });
    }
    if (mode === 'static' && (node.tag === 'DocsIsland' || node.tag === 'docs-island') && filename !== 'components/DocsIsland.vue') {
      if (node.children.some(child => child.type !== NodeTypes.TEXT || child.content.trim() !== '')) {
        throw new Error(`DocsIsland does not accept slots in ${filename}`);
      }
      if (node.props.length !== 1 || node.props[0]?.type !== NodeTypes.DIRECTIVE
        || node.props[0].name !== 'bind' || node.props[0].arg?.type !== NodeTypes.SIMPLE_EXPRESSION
        || !node.props[0].arg.isStatic || node.props[0].arg.content !== 'entry') {
        throw new Error(`DocsIsland accepts only a bound entry in ${filename}`);
      }
    }
    if (node.tag.toLowerCase() === 'a' && !nativeAnchorComponents.has(filename)) {
      throw new Error(`Use a typed Docs link component instead of <a> in ${filename}`);
    }
    if (['script', 'iframe', 'object', 'embed', 'base'].includes(node.tag.toLowerCase())) {
      throw new Error(`Unsupported active element <${node.tag}> in ${filename}`);
    }
    for (const prop of node.props) {
      const name = prop.type === NodeTypes.ATTRIBUTE
        ? prop.name.toLowerCase()
        : prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic
          ? prop.arg.content.toLowerCase()
          : undefined;
      if (filename !== 'components/DocsIsland.vue'
        && name !== undefined && reservedIslandAttributes.has(name)) {
        throw new Error(`Reserved Docs island attribute ${name} in ${filename}`);
      }
      if (mode === 'static' && name === 'ref') {
        staticTemplateError({
          source,
          filename,
          offset: templateStart + prop.loc.start.offset,
          reason: 'Template refs are not populated in static Docs pages.',
          remedy: 'Use server-rendered data, or put DOM access in a registered island.',
        });
      }
      if (prop.type === NodeTypes.ATTRIBUTE && prop.name.toLowerCase().startsWith('on')) {
        throw new Error(`Inline event attribute in ${filename}`);
      }
      if (prop.type !== NodeTypes.DIRECTIVE) continue;
      if (prop.name === 'html') throw new Error(`v-html is not supported in Docs: ${filename}`);
      if (mode === 'static' && (prop.name === 'on' || prop.name === 'model')) {
        throw new Error(`Interactive binding on static Docs component; use an island: ${filename}`);
      }
      if (mode === 'static' && !supportedStaticDirectives.has(prop.name)) {
        staticTemplateError({
          source,
          filename,
          offset: templateStart + prop.loc.start.offset,
          reason: `Directive v-${prop.name} is unsupported in static Docs.`,
          remedy: 'Write server-rendered HTML directly, or use a registered island for browser behavior.',
        });
      }
      if (prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic && prop.arg.content.toLowerCase().startsWith('on')) {
        throw new Error(`Event property binding in ${filename}`);
      }
      const hostCanonicalBind = filename === 'components/DocsIsland.vue' && node.tag === 'component'
        && !prop.arg && prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION && prop.exp.content.trim() === 'data.canonical'
        && node.props.some(candidate => candidate.type === NodeTypes.DIRECTIVE && candidate.name === 'bind'
          && candidate.arg?.type === NodeTypes.SIMPLE_EXPRESSION && candidate.arg.isStatic && candidate.arg.content === 'is'
          && candidate.exp?.type === NodeTypes.SIMPLE_EXPRESSION && candidate.exp.content.trim() === 'preparedComponent()');
      if (prop.name === 'bind' && (!prop.arg || prop.arg.type !== NodeTypes.SIMPLE_EXPRESSION || !prop.arg.isStatic) && !hostCanonicalBind) {
        throw new Error(`Docs bindings require an explicit static attribute name: ${filename}`);
      }
    }
    node.children.forEach(child => visit({ node: child }));
  };
  root.children.forEach(node => visit({ node }));
}
