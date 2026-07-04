import path from 'node:path';
import { NodeTypes, compile as compileTemplate, createSimpleExpression, parse as parseTemplate } from '@vue/compiler-dom';
import {
  processExpression,
  type AttributeNode,
  type CompilerError,
  type DirectiveNode,
  type ElementNode,
  type NodeTransform,
  type RootNode,
  type SimpleExpressionNode,
  type SourceLocation,
  type TemplateChildNode,
} from '@vue/compiler-core';
import { parse as parseSfc, type SFCTemplateBlock } from '@vue/compiler-sfc';
import MagicString from 'magic-string';
import {
  parseTypeScriptExpression,
  createTypeScriptSourceFile,
  createTypeScriptTypeChecker,
  nodePosition,
  nodeRange,
  staticStringValue,
  ts,
  unwrapTypeScriptExpression,
  visitTypeScriptAst,
} from './typescript-ast-utils';
import {
  tailwindClassAttributeBySource,
  type TailwindClassAttributeDefinition,
} from './tailwind-class-attributes';

const virtualModuleId = 'virtual:naidan-tailwind';

export type SourcePosition = {
  line: number;
  column: number;
};

export type TailwindCandidateOccurrence = {
  candidate: string;
  column: number;
  filename: string;
  line: number;
  sourceKind: string;
};

export type ParsedTwClassExpression = {
  classes: string[];
  runtimeExpression: string;
  dynamic: boolean;
};

export type TwModuleSourceType = 'javascript' | 'jsx' | 'typescript' | 'tsx';

type DiagnosticLocation = {
  start: {
    line: number;
    column: number;
  };
};

type ClassMacroName = 'customClasses' | 'tw' | 'twClasses' | 'twClassString';
type ClassWrapperName = 'customClasses' | 'twClasses';

type DynamicWrapper = {
  start: number;
  end: number;
  replacement: string;
};

type MacroTransformResult = {
  classes: Set<string>;
  occurrences: TailwindCandidateOccurrence[];
  changed: boolean;
};

function fail({ filename, message, loc }: { filename: string; message: string; loc?: DiagnosticLocation }): never {
  const location = loc === undefined ? '' : `:${loc.start.line}:${loc.start.column}`;
  throw new Error(`[tw-class] ${filename}${location} ${message}`);
}

function absolutePosition({ relative, blockStart, columnIsZeroBased }: { relative: SourcePosition; blockStart: SourcePosition; columnIsZeroBased: boolean }): SourcePosition {
  const relativeColumn = relative.column + (columnIsZeroBased ? 1 : 0);
  return {
    line: blockStart.line + relative.line - 1,
    column: relative.line === 1 ? blockStart.column + relativeColumn - 1 : relativeColumn,
  };
}

function absoluteSourceLocation({ loc, blockStart }: { loc: SourceLocation; blockStart: SourcePosition | undefined }): SourceLocation {
  if (blockStart === undefined) return loc;
  return {
    ...loc,
    start: {
      ...loc.start,
      ...absolutePosition({ relative: loc.start, blockStart, columnIsZeroBased: false }),
    },
    end: {
      ...loc.end,
      ...absolutePosition({ relative: loc.end, blockStart, columnIsZeroBased: false }),
    },
  };
}

function createOccurrence({ candidate, filename, position, sourceKind }: { candidate: string; filename: string; position: SourcePosition; sourceKind: string }): TailwindCandidateOccurrence {
  return { candidate, filename, line: position.line, column: position.column, sourceKind };
}

function parseOptionalTwClassTokens({ value }: { value: string }): string[] {
  return value.trim().split(/\s+/u).filter(Boolean);
}

export function parseTwClassTokens({ value, filename, loc }: { value: string; filename: string; loc?: DiagnosticLocation }): string[] {
  const tokens = parseOptionalTwClassTokens({ value });
  if (tokens.length === 0) fail({ filename, loc, message: 'Tailwind class attribute must contain at least one class literal.' });
  return tokens;
}

function expressionLoc({ sourceFile, node, blockStart = { line: 1, column: 1 } }: { sourceFile: ts.SourceFile; node: ts.Node; blockStart?: SourcePosition }): DiagnosticLocation {
  return { start: nodePosition({ sourceFile, node, blockStart }) };
}

function isIdentifierCall({ node, name }: { node: ts.CallExpression; name: string }): boolean {
  const expression = unwrapTypeScriptExpression({ node: node.expression });
  return ts.isIdentifier(expression) && expression.text === name;
}

function classMacroName({ node }: { node: ts.Node }): ClassMacroName | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const expression = unwrapTypeScriptExpression({ node: node.expression });
  if (!ts.isIdentifier(expression)) return undefined;
  switch (expression.text) {
  case 'customClasses':
  case 'tw':
  case 'twClasses':
  case 'twClassString':
    return expression.text;
  default:
    return undefined;
  }
}

function classWrapperName({ node }: { node: ts.Node }): ClassWrapperName | undefined {
  const name = classMacroName({ node });
  return name === 'twClasses' || name === 'customClasses' ? name : undefined;
}

function failUnsupportedTemplateMacro({ macroName, filename, loc }: { macroName: ClassMacroName; filename: string; loc?: DiagnosticLocation }): never {
  fail({
    filename,
    loc,
    message: `${macroName}() is not supported in Vue template expressions; use tw-class / :tw-class syntax.`,
  });
}

function assertNoNestedClassMacros({ node, filename, loc }: { node: ts.Node; filename: string; loc?: DiagnosticLocation }): void {
  visitTypeScriptAst({
    node,
    visitor(candidate) {
      const macroName = classMacroName({ node: candidate });
      if (macroName === undefined) return;
      const wrapperName = classWrapperName({ node: candidate });
      if (wrapperName !== undefined) {
        fail({
          filename,
          loc,
          message: `${wrapperName}() may not be nested inside another class wrapper.`,
        });
      }
      failUnsupportedTemplateMacro({ macroName, filename, loc });
    },
  });
}

function assertNoMisplacedClassMacros({ node, filename, loc }: { node: ts.Node; filename: string; loc?: DiagnosticLocation }): void {
  visitTypeScriptAst({
    node,
    visitor(candidate) {
      const macroName = classMacroName({ node: candidate });
      if (macroName === undefined) return;
      const wrapperName = classWrapperName({ node: candidate });
      if (wrapperName === undefined) {
        failUnsupportedTemplateMacro({ macroName, filename, loc });
      }
      let placement: string;
      switch (wrapperName) {
      case 'customClasses':
        placement = 'the complete value of an ordinary :class binding';
        break;
      case 'twClasses':
        placement = 'a class-value position inside :tw-class';
        break;
      default: {
        const _ex: never = wrapperName;
        throw new Error(`Unhandled class wrapper: ${_ex}`);
      }
      }
      fail({ filename, loc, message: `${wrapperName}() may only be used as ${placement}.` });
    },
  });
}

function unwrapTopLevelClassWrapper({ expression, wrapperName, filename, loc }: { expression: string; wrapperName: ClassWrapperName; filename: string; loc?: DiagnosticLocation }): string | undefined {
  let parsed: ReturnType<typeof parseTypeScriptExpression>;
  try {
    parsed = parseTypeScriptExpression({ expression, filename: `${filename}.template-expression.ts` });
  } catch (error) {
    fail({ filename, loc, message: `Unable to parse class expression: ${String(error)}` });
  }
  const root = unwrapTypeScriptExpression({ node: parsed.root });
  if (!ts.isCallExpression(root) || !isIdentifierCall({ node: root, name: wrapperName })) {
    assertNoMisplacedClassMacros({ node: root, filename, loc });
    return undefined;
  }
  if (root.arguments.length !== 1) fail({ filename, loc, message: `${wrapperName}() requires exactly one class value argument.` });
  assertNoNestedClassMacros({ node: root.arguments[0], filename, loc });
  const range = nodeRange({ sourceFile: parsed.sourceFile, node: root.arguments[0], offset: parsed.offset });
  return expression.slice(range.start, range.end);
}

function objectKeyText({ property, sourceFile }: { property: ts.ObjectLiteralElementLike; sourceFile: ts.SourceFile }): string | undefined {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)) return property.name.text;
  return property.name.getText(sourceFile);
}

export function parseTwClassExpression({ expression, filename, loc }: { expression: string; filename: string; loc?: DiagnosticLocation }): ParsedTwClassExpression {
  let parsed: ReturnType<typeof parseTypeScriptExpression>;
  try {
    parsed = parseTypeScriptExpression({ expression, filename: `${filename}.template-expression.ts` });
  } catch (error) {
    fail({ filename, loc, message: `Unable to parse :tw-class expression: ${String(error)}` });
  }
  const classes: string[] = [];
  const dynamicWrappers: DynamicWrapper[] = [];
  const acceptedWrapperNodes = new Set<ts.Node>();
  function visit(input: ts.Expression): void {
    const node = unwrapTypeScriptExpression({ node: input });
    if (ts.isCallExpression(node) && isIdentifierCall({ node, name: 'twClasses' })) {
      if (node.arguments.length !== 1) fail({ filename, loc, message: 'twClasses() requires exactly one class value argument.' });
      assertNoNestedClassMacros({ node: node.arguments[0], filename, loc });
      acceptedWrapperNodes.add(node);
      const nodeRangeValue = nodeRange({ sourceFile: parsed.sourceFile, node, offset: parsed.offset });
      const argumentRange = nodeRange({ sourceFile: parsed.sourceFile, node: node.arguments[0], offset: parsed.offset });
      dynamicWrappers.push({
        start: nodeRangeValue.start,
        end: nodeRangeValue.end,
        replacement: expression.slice(argumentRange.start, argumentRange.end),
      });
      return;
    }
    const stringValue = staticStringValue({ node });
    if (stringValue !== undefined) {
      classes.push(...parseOptionalTwClassTokens({ value: stringValue }));
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) fail({ filename, loc, message: ':tw-class does not support spread elements.' });
        visit(element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property) || ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
          fail({ filename, loc, message: ':tw-class does not support object spreads, methods, or accessors.' });
        }
        const key = objectKeyText({ property, sourceFile: parsed.sourceFile });
        if (key === undefined) fail({ filename, loc, message: ':tw-class object keys must be non-computed string literals or identifiers.' });
        classes.push(...parseOptionalTwClassTokens({ value: key }));
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.whenTrue);
      visit(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      visit(node.right);
      return;
    }
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return;
    fail({
      filename,
      loc,
      message: `:tw-class must be statically enumerable or wrapped in twClasses(); unsupported expression ${node.getText(parsed.sourceFile)}.`,
    });
  }
  visit(parsed.root);
  visitTypeScriptAst({
    node: parsed.root,
    visitor(candidate) {
      const macroName = classMacroName({ node: candidate });
      if (macroName === undefined || acceptedWrapperNodes.has(candidate)) return;
      const wrapperName = classWrapperName({ node: candidate });
      if (wrapperName === undefined) {
        failUnsupportedTemplateMacro({ macroName, filename, loc });
      }
      let placement: string;
      switch (wrapperName) {
      case 'customClasses':
        placement = 'an ordinary :class binding';
        break;
      case 'twClasses':
        placement = 'a class-value position inside :tw-class';
        break;
      default: {
        const _ex: never = wrapperName;
        throw new Error(`Unhandled class wrapper: ${_ex}`);
      }
      }
      fail({ filename, loc, message: `${wrapperName}() may not be used as a condition; use it only in ${placement}.` });
    },
  });
  if (classes.length === 0 && dynamicWrappers.length === 0) {
    fail({ filename, loc, message: ':tw-class must contain at least one class literal or twClasses() value.' });
  }
  const runtimeExpression = new MagicString(expression);
  for (const wrapper of dynamicWrappers.sort((left, right) => right.start - left.start)) {
    runtimeExpression.overwrite(wrapper.start, wrapper.end, wrapper.replacement);
  }
  return { classes, runtimeExpression: runtimeExpression.toString(), dynamic: dynamicWrappers.length > 0 };
}

export function parseStaticTwClassExpression({ expression, filename, loc }: { expression: string; filename: string; loc?: DiagnosticLocation }): string[] {
  const result = parseTwClassExpression({ expression, filename, loc });
  if (result.dynamic) fail({ filename, loc, message: 'Expected a statically enumerable :tw-class expression, but received twClasses().' });
  return result.classes;
}

function isStaticArgument({ argument, name }: { argument: DirectiveNode['arg']; name: string }): boolean {
  return argument?.type === NodeTypes.SIMPLE_EXPRESSION && argument.isStatic && argument.content === name;
}

function classAttributeDefinition({ prop }: { prop: AttributeNode | DirectiveNode }): TailwindClassAttributeDefinition | undefined {
  if (prop.type === NodeTypes.ATTRIBUTE) return tailwindClassAttributeBySource.get(prop.name);
  if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic) {
    return tailwindClassAttributeBySource.get(prop.arg.content);
  }
  return undefined;
}

export function collectTwCandidateOccurrencesFromTemplateAst({ ast, filename, blockStart }: { ast: RootNode; filename: string; blockStart: SourcePosition }): TailwindCandidateOccurrence[] {
  const occurrences: TailwindCandidateOccurrence[] = [];
  const visited = new Set<RootNode | TemplateChildNode>();
  function visit(node: RootNode | TemplateChildNode): void {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.type === NodeTypes.ELEMENT) {
      for (const prop of node.props) {
        const definition = classAttributeDefinition({ prop });
        if (definition === undefined) continue;
        const reportLoc = absoluteSourceLocation({ loc: prop.loc, blockStart });
        if (prop.type === NodeTypes.DIRECTIVE && prop.modifiers.length > 0) {
          fail({ filename, loc: reportLoc, message: `:${definition.source} does not support v-bind modifiers.` });
        }
        const position = absolutePosition({ relative: prop.loc.start, blockStart, columnIsZeroBased: false });
        if (prop.type === NodeTypes.ATTRIBUTE) {
          if (prop.value === undefined) fail({ filename, loc: reportLoc, message: `${definition.source} requires a static string value.` });
          for (const token of parseTwClassTokens({ value: prop.value.content, filename, loc: reportLoc })) {
            occurrences.push(createOccurrence({ candidate: token, filename, position, sourceKind: definition.source }));
          }
          continue;
        }
        if (definition.target !== 'class') {
          fail({ filename, loc: reportLoc, message: `Dynamic :${definition.source} is not supported. Use a static ${definition.source} value.` });
        }
        if (prop.exp === undefined) fail({ filename, loc: reportLoc, message: ':tw-class requires an expression.' });
        const expression = prop.exp.type === NodeTypes.SIMPLE_EXPRESSION
          ? prop.exp.content
          : prop.exp.loc.source;
        for (const token of parseTwClassExpression({ expression, filename, loc: reportLoc }).classes) {
          occurrences.push(createOccurrence({ candidate: token, filename, position, sourceKind: ':tw-class' }));
        }
      }
    }
    if (
      node.type === NodeTypes.ROOT
      || node.type === NodeTypes.ELEMENT
      || node.type === NodeTypes.IF_BRANCH
      || node.type === NodeTypes.FOR
    ) node.children.forEach(visit);
    if (node.type === NodeTypes.IF) node.branches.forEach(visit);
  }
  visit(ast);
  return occurrences;
}

function assertSupportedVueTemplateBlock({ template, filename }: { template: SFCTemplateBlock | null; filename: string }): void {
  if (template === null) return;
  if (template.src !== undefined) {
    fail({ filename, message: 'External Vue template src files are not supported by static Tailwind analysis.' });
  }
  if (template.lang !== undefined && template.lang !== 'html') {
    fail({ filename, message: `Unsupported Vue template language ${JSON.stringify(template.lang)} for static Tailwind analysis.` });
  }
}

export function collectTwCandidateOccurrencesFromVueSource({ source, filename }: { source: string; filename: string }): TailwindCandidateOccurrence[] {
  const { descriptor, errors } = parseSfc(source, { filename });
  if (errors.length > 0) fail({ filename, message: `Unable to parse Vue SFC: ${errors.map(String).join('; ')}` });
  assertSupportedVueTemplateBlock({ template: descriptor.template, filename });
  const occurrences: TailwindCandidateOccurrence[] = [];
  if (descriptor.template !== null) {
    const blockStart = descriptor.template.loc.start;
    const reportCompilerError = (error: CompilerError): never => {
      fail({
        filename,
        loc: error.loc === undefined
          ? undefined
          : absoluteSourceLocation({ loc: error.loc, blockStart }),
        message: error.message,
      });
    };
    const templateAst = parseTemplate(descriptor.template.content, {
      comments: true,
      expressionPlugins: ['typescript'],
      onError: reportCompilerError,
    });
    compileTemplate(descriptor.template.content, {
      comments: true,
      expressionPlugins: ['typescript'],
      onError: reportCompilerError,
      nodeTransforms: [createTwClassNodeTransform({ filename, blockStart })],
    });
    occurrences.push(...collectTwCandidateOccurrencesFromTemplateAst({ ast: templateAst, filename, blockStart }));
  }
  for (const scriptBlock of [descriptor.script, descriptor.scriptSetup]) {
    if (scriptBlock === null) continue;
    const result = transformTwCallsInModule({
      source: scriptBlock.content,
      filename,
      sourceType: sourceTypeForVueScriptBlock({ lang: scriptBlock.lang, filename }),
      blockStart: scriptBlock.loc.start,
      additionalImports: [],
    });
    occurrences.push(...result.occurrences);
  }
  return occurrences;
}

type StaticBindDirectiveNode = DirectiveNode & {
  arg: SimpleExpressionNode;
};

function staticPropsByName({ node, name }: { node: ElementNode; name: string }): AttributeNode[] {
  return node.props.filter((prop): prop is AttributeNode => (
    prop.type === NodeTypes.ATTRIBUTE && prop.name === name
  ));
}

function dynamicPropsByName({ node, name }: { node: ElementNode; name: string }): StaticBindDirectiveNode[] {
  return node.props.filter((prop): prop is StaticBindDirectiveNode => (
    prop.type === NodeTypes.DIRECTIVE
    && prop.name === 'bind'
    && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
    && prop.arg.isStatic
    && prop.arg.content === name
  ));
}

export function createTwClassNodeTransform({ filename, blockStart }: { filename: string; blockStart: SourcePosition | undefined }): NodeTransform {
  const reportLocation = ({ loc }: { loc: SourceLocation }): SourceLocation => absoluteSourceLocation({ loc, blockStart });
  return (node, context) => {
    if (node.type !== NodeTypes.ELEMENT) return;
    for (const prop of node.props) {
      const sourceName = prop.type === NodeTypes.ATTRIBUTE
        ? prop.name
        : prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic
          ? prop.arg.content
          : undefined;
      if (sourceName?.startsWith('tw-') && !tailwindClassAttributeBySource.has(sourceName)) {
        fail({ filename, loc: reportLocation({ loc: prop.loc }), message: `Unknown Tailwind class attribute ${sourceName}.` });
      }
      if (
        sourceName !== undefined
        && tailwindClassAttributeBySource.has(sourceName)
        && prop.type === NodeTypes.DIRECTIVE
        && prop.modifiers.length > 0
      ) {
        fail({ filename, loc: reportLocation({ loc: prop.loc }), message: `:${sourceName} does not support v-bind modifiers.` });
      }
    }

    for (const classProp of dynamicPropsByName({ node, name: 'class' })) {
      if (classProp.exp === undefined) continue;
      const expression = classProp.exp.loc.source;
      const unwrapped = unwrapTopLevelClassWrapper({ expression, wrapperName: 'customClasses', filename, loc: reportLocation({ loc: classProp.loc }) });
      if (unwrapped === undefined) continue;
      classProp.exp = processExpression(createSimpleExpression(unwrapped, false, classProp.exp.loc), context);
    }

    for (const definition of tailwindClassAttributeBySource.values()) {
      const staticTwProps = staticPropsByName({ node, name: definition.source });
      const dynamicTwProps = dynamicPropsByName({ node, name: definition.source });
      if (staticTwProps.length > 1) fail({ filename, loc: reportLocation({ loc: staticTwProps[1].loc }), message: `Only one ${definition.source} attribute is allowed per element.` });
      if (dynamicTwProps.length > 1) fail({ filename, loc: reportLocation({ loc: dynamicTwProps[1].loc }), message: `Only one :${definition.source} binding is allowed per element.` });
      if (staticTwProps.length === 1 && dynamicTwProps.length === 1) {
        fail({ filename, loc: reportLocation({ loc: dynamicTwProps[0].loc }), message: `Do not combine ${definition.source} and :${definition.source} on one element because vue-tsc treats them as duplicate attributes.` });
      }
      if (staticTwProps.length === 1) {
        const twProp = staticTwProps[0];
        if (twProp.value === undefined) fail({ filename, loc: reportLocation({ loc: twProp.loc }), message: `${definition.source} requires a static string value.` });
        parseTwClassTokens({ value: twProp.value.content, filename, loc: reportLocation({ loc: twProp.loc }) });
        const targetStaticProps = staticPropsByName({ node, name: definition.target }).filter((prop) => prop !== twProp);
        const targetDynamicProps = dynamicPropsByName({ node, name: definition.target });
        if (targetStaticProps.length > 1 || targetDynamicProps.length > 1) {
          fail({ filename, loc: reportLocation({ loc: twProp.loc }), message: `Multiple ${definition.target} attributes cannot be merged safely.` });
        }
        if (definition.target !== 'class' && targetDynamicProps.length > 0) {
          fail({ filename, loc: reportLocation({ loc: twProp.loc }), message: `${definition.source} cannot be combined with :${definition.target}.` });
        }
        const targetStatic = targetStaticProps[0];
        if (targetStatic?.type === NodeTypes.ATTRIBUTE) {
          if (targetStatic.value === undefined) targetStatic.value = twProp.value;
          else targetStatic.value.content = `${targetStatic.value.content} ${twProp.value.content}`;
          node.props.splice(node.props.indexOf(twProp), 1);
        } else twProp.name = definition.target;
      }
      if (dynamicTwProps.length === 1) {
        const twProp = dynamicTwProps[0];
        if (definition.target !== 'class') {
          fail({ filename, loc: reportLocation({ loc: twProp.loc }), message: `Dynamic :${definition.source} is not supported. Use a static ${definition.source} value.` });
        }
        if (twProp.exp === undefined) fail({ filename, loc: reportLocation({ loc: twProp.loc }), message: ':tw-class requires an expression.' });
        const parsed = parseTwClassExpression({ expression: twProp.exp.loc.source, filename, loc: reportLocation({ loc: twProp.loc }) });
        twProp.exp = processExpression(createSimpleExpression(parsed.runtimeExpression, false, twProp.exp.loc), context);
        const targetDynamic = dynamicPropsByName({ node, name: 'class' }).find((prop) => prop !== twProp);
        if (targetDynamic?.type === NodeTypes.DIRECTIVE) {
          if (targetDynamic.exp === undefined) fail({ filename, loc: reportLocation({ loc: targetDynamic.loc }), message: ':class requires an expression.' });
          const original = targetDynamic.exp.loc.source;
          const custom = unwrapTopLevelClassWrapper({ expression: original, wrapperName: 'customClasses', filename, loc: reportLocation({ loc: targetDynamic.loc }) }) ?? original;
          targetDynamic.exp = processExpression(createSimpleExpression(`[${custom}, ${parsed.runtimeExpression}]`, false, targetDynamic.exp.loc), context);
          node.props.splice(node.props.indexOf(twProp), 1);
        } else twProp.arg.content = 'class';
      }
    }
  };
}

function importBindingName({ specifier }: { specifier: ts.ImportSpecifier }): { imported: string; local: string; typeOnly: boolean } {
  return { imported: (specifier.propertyName ?? specifier.name).text, local: specifier.name.text, typeOnly: specifier.isTypeOnly };
}

function isImportIdentifier({ node }: { node: ts.Identifier }): boolean {
  return ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isNamespaceImport(node.parent) || ts.isImportEqualsDeclaration(node.parent);
}

function isVirtualModuleStringLiteral({ node }: { node: ts.Node | undefined }): boolean {
  return node !== undefined && ts.isStringLiteralLike(node) && node.text === virtualModuleId;
}

function containsVirtualModuleString({ node }: { node: ts.Node }): boolean {
  let found = false;
  visitTypeScriptAst({
    node,
    visitor(candidate) {
      if (isVirtualModuleStringLiteral({ node: candidate })) found = true;
    },
  });
  return found;
}

function assertSupportedVirtualModuleReference({ node, filename, sourceFile, blockStart }: { node: ts.Node; filename: string; sourceFile: ts.SourceFile; blockStart: SourcePosition }): void {
  if (ts.isExportDeclaration(node) && isVirtualModuleStringLiteral({ node: node.moduleSpecifier })) {
    fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: 'virtual:naidan-tailwind may not be re-exported.' });
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
    && isVirtualModuleStringLiteral({ node: node.moduleReference.expression })) {
    fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: 'virtual:naidan-tailwind only supports named ES module imports.' });
  }
  if (!ts.isCallExpression(node)) return;
  const referencesVirtualModule = node.arguments.some((argument) => containsVirtualModuleString({ node: argument }));
  if (!referencesVirtualModule) return;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: 'virtual:naidan-tailwind may not be dynamically imported.' });
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
    fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: 'virtual:naidan-tailwind may not be loaded with require().' });
  }
}

function isDirectCallTarget({ node }: { node: ts.Identifier }): boolean {
  let current: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isNonNullExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent)
    || ts.isPartiallyEmittedExpression(current.parent)
  ) current = current.parent;
  return ts.isCallExpression(current.parent)
    && unwrapTypeScriptExpression({ node: current.parent.expression }) === node;
}

function parserFilenameForSourceType({ filename, sourceType }: { filename: string; sourceType: TwModuleSourceType }): string {
  const extensionBySourceType = {
    javascript: '.js',
    jsx: '.jsx',
    typescript: '.ts',
    tsx: '.tsx',
  };
  const compatibleExtensions = {
    javascript: new Set(['.js', '.mjs', '.cjs']),
    jsx: new Set(['.jsx']),
    typescript: new Set(['.ts', '.mts', '.cts']),
    tsx: new Set(['.tsx']),
  };
  const extension = path.extname(filename).toLowerCase();
  return compatibleExtensions[sourceType].has(extension)
    ? filename
    : `${filename}${extensionBySourceType[sourceType]}`;
}

export function sourceTypeForVueScriptBlock({ lang, filename }: { lang: string | undefined; filename: string }): TwModuleSourceType {
  if (lang === undefined || lang === 'js') return 'javascript';
  if (lang === 'jsx') return 'jsx';
  if (lang === 'ts') return 'typescript';
  if (lang === 'tsx') return 'tsx';
  throw new Error(`[tw-class] ${filename} Unsupported Vue script language ${JSON.stringify(lang)}.`);
}

function transformTwCallsIntoMagicString({
  source,
  filename,
  sourceType,
  blockStart,
  additionalImports,
  magicString,
  sourceOffset,
}: {
  source: string;
  filename: string;
  sourceType: TwModuleSourceType;
  blockStart: SourcePosition;
  additionalImports: string[];
  magicString: MagicString;
  sourceOffset: number;
}): MacroTransformResult {
  const parseFilename = parserFilenameForSourceType({ filename, sourceType });
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = createTypeScriptSourceFile({ source, filename: parseFilename });
  } catch (error) {
    fail({ filename, message: `Unable to parse module: ${String(error)}` });
  }
  const classes = new Set<string>();
  const occurrences: TailwindCandidateOccurrence[] = [];
  const macroImports: ts.ImportDeclaration[] = [];
  const typeChecker = source.includes(virtualModuleId)
    ? createTypeScriptTypeChecker({ sourceFile })
    : undefined;
  const twSymbols = new Set<ts.Symbol>();
  const twClassStringSymbols = new Set<ts.Symbol>();
  const templateOnlySymbols = new Map<ts.Symbol, ClassWrapperName>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== virtualModuleId) continue;
    macroImports.push(statement);
    const clause = statement.importClause;
    if (clause === undefined || clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) {
      fail({ filename, loc: expressionLoc({ sourceFile, node: statement, blockStart }), message: 'virtual:naidan-tailwind only supports named imports.' });
    }
    for (const specifier of clause.namedBindings.elements) {
      const binding = importBindingName({ specifier });
      const isTypeOnly = clause.isTypeOnly || binding.typeOnly;
      if (isTypeOnly) {
        if (binding.imported !== 'TailwindClass' && binding.imported !== 'TailwindClassValue') {
          fail({ filename, loc: expressionLoc({ sourceFile, node: specifier, blockStart }), message: `Unsupported virtual:naidan-tailwind type ${binding.imported}.` });
        }
        continue;
      }
      const symbol = typeChecker?.getSymbolAtLocation(specifier.name);
      if (symbol === undefined) {
        fail({ filename, loc: expressionLoc({ sourceFile, node: specifier, blockStart }), message: `Unable to resolve virtual:naidan-tailwind import ${binding.imported}.` });
      }
      if (binding.imported === 'tw') twSymbols.add(symbol);
      else if (binding.imported === 'twClassString') {
        if (binding.local !== binding.imported) fail({ filename, loc: expressionLoc({ sourceFile, node: specifier, blockStart }), message: 'twClassString may not be aliased.' });
        twClassStringSymbols.add(symbol);
      } else if (binding.imported === 'twClasses' || binding.imported === 'customClasses') {
        if (binding.local !== binding.imported) fail({ filename, loc: expressionLoc({ sourceFile, node: specifier, blockStart }), message: `${binding.imported} may not be aliased because Vue template analysis uses its canonical name.` });
        templateOnlySymbols.set(symbol, binding.imported);
      } else fail({ filename, loc: expressionLoc({ sourceFile, node: specifier, blockStart }), message: `Unsupported virtual:naidan-tailwind macro ${binding.imported}.` });
    }
  }
  if (source.includes(virtualModuleId)) {
    visitTypeScriptAst({
      node: sourceFile,
      visitor(node) {
        assertSupportedVirtualModuleReference({ node, filename, sourceFile, blockStart });
      },
    });
  }
  if (macroImports.length === 0 && additionalImports.length === 0) {
    return { classes, occurrences, changed: false };
  }

  if (macroImports.length > 0) {
    visitTypeScriptAst({
      node: sourceFile,
      visitor(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(unwrapTypeScriptExpression({ node: node.expression }))) {
          const callee = unwrapTypeScriptExpression({ node: node.expression });
          const symbol = typeChecker?.getSymbolAtLocation(callee);
          if (symbol !== undefined && twSymbols.has(symbol)) {
            if (node.arguments.length !== 1) fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: "tw() requires exactly one string literal, for example tw('opacity-50')." });
            const className = staticStringValue({ node: node.arguments[0] });
            if (className === undefined) fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: "tw() requires exactly one string literal, for example tw('opacity-50')." });
            const tokens = parseTwClassTokens({ value: className, filename, loc: expressionLoc({ sourceFile, node, blockStart }) });
            if (tokens.length !== 1) fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: 'tw() accepts exactly one Tailwind class token.' });
            classes.add(className);
            occurrences.push(createOccurrence({ candidate: className, filename, position: nodePosition({ sourceFile, node, blockStart }), sourceKind: 'tw()' }));
            const range = nodeRange({ sourceFile, node, offset: 0 });
            magicString.overwrite(sourceOffset + range.start, sourceOffset + range.end, JSON.stringify(className));
            return;
          }
          if (symbol !== undefined && twClassStringSymbols.has(symbol)) {
            if (node.arguments.length === 0) fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: 'twClassString() requires one or more string literals.' });
            const classNames: string[] = [];
            for (const argument of node.arguments) {
              const className = staticStringValue({ node: argument });
              if (className === undefined) {
                fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: 'twClassString() requires one or more string literals, each containing exactly one Tailwind class token.' });
              }
              classNames.push(className);
            }
            for (const className of classNames) {
              const tokens = parseTwClassTokens({ value: className, filename, loc: expressionLoc({ sourceFile, node, blockStart }) });
              if (tokens.length !== 1) fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: 'Each twClassString() argument must contain exactly one Tailwind class token.' });
              classes.add(className);
              occurrences.push(createOccurrence({ candidate: className, filename, position: nodePosition({ sourceFile, node, blockStart }), sourceKind: 'twClassString()' }));
            }
            const range = nodeRange({ sourceFile, node, offset: 0 });
            magicString.overwrite(sourceOffset + range.start, sourceOffset + range.end, JSON.stringify(classNames.join(' ')));
          }
        }
        if (!ts.isIdentifier(node) || isImportIdentifier({ node })) return;
        const symbol = typeChecker?.getSymbolAtLocation(node);
        if (symbol === undefined) return;
        const isDirectCall = isDirectCallTarget({ node });
        if (twSymbols.has(symbol) && !isDirectCall) fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: 'tw may only be used as a direct function call.' });
        if (twClassStringSymbols.has(symbol) && !isDirectCall) fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: 'twClassString may only be used as a direct function call.' });
        const templateOnlyName = templateOnlySymbols.get(symbol);
        if (templateOnlyName !== undefined) fail({ filename, loc: expressionLoc({ sourceFile, node, blockStart }), message: `${templateOnlyName} may only be used directly in a Vue template class binding.` });
      },
    });
  }

  for (const declaration of macroImports) {
    magicString.remove(sourceOffset + declaration.getStart(sourceFile), sourceOffset + declaration.getEnd());
  }
  if (additionalImports.length > 0) {
    const imports = additionalImports.map((id) => `import ${JSON.stringify(id)};`).join('\n');
    magicString.appendLeft(sourceOffset + source.length, `\n${imports}\n`);
  }
  return { classes, occurrences, changed: true };
}

export function transformTwCallsInModule({ source, filename, sourceType, blockStart, additionalImports }: { source: string; filename: string; sourceType: TwModuleSourceType; blockStart: SourcePosition; additionalImports: string[] }) {
  const magicString = new MagicString(source);
  const result = transformTwCallsIntoMagicString({
    source,
    filename,
    sourceType,
    blockStart,
    additionalImports,
    magicString,
    sourceOffset: 0,
  });
  return {
    code: result.changed ? magicString.toString() : source,
    map: result.changed ? magicString.generateMap({ hires: true, source: filename, includeContent: true }) : null,
    classes: result.classes,
    occurrences: result.occurrences,
    changed: result.changed,
  };
}

export function transformTwCallsInVueSource({ source, filename, additionalImports }: { source: string; filename: string; additionalImports: string[] }) {
  const { descriptor, errors } = parseSfc(source, { filename });
  if (errors.length > 0) fail({ filename, message: `Unable to parse Vue SFC: ${errors.map(String).join('; ')}` });
  assertSupportedVueTemplateBlock({ template: descriptor.template, filename });
  const magicString = new MagicString(source);
  const importBlock = descriptor.scriptSetup ?? descriptor.script;
  if (additionalImports.length > 0 && importBlock?.src !== undefined) {
    fail({
      filename,
      message: 'Cannot inject static Tailwind CSS registration imports into an external Vue script src block.',
    });
  }
  let changed = false;
  for (const scriptBlock of [descriptor.script, descriptor.scriptSetup]) {
    if (scriptBlock === null) continue;
    const result = transformTwCallsIntoMagicString({
      source: scriptBlock.content,
      filename,
      sourceType: sourceTypeForVueScriptBlock({ lang: scriptBlock.lang, filename }),
      blockStart: scriptBlock.loc.start,
      additionalImports: scriptBlock === importBlock ? additionalImports : [],
      magicString,
      sourceOffset: scriptBlock.loc.start.offset,
    });
    changed ||= result.changed;
  }
  if (importBlock === null && additionalImports.length > 0) {
    const imports = additionalImports.map((id) => `import ${JSON.stringify(id)};`).join('\n');
    magicString.prepend(`<script>\n${imports}\n</script>\n`);
    changed = true;
  }
  return {
    code: changed ? magicString.toString() : source,
    map: changed ? magicString.generateMap({ hires: true, source: filename, includeContent: true }) : null,
    changed,
  };
}
