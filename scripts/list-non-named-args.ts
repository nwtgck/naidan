import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { globSync } from 'glob';

type Finding = {
  filePath: string;
  line: number;
  column: number;
  kind: string;
  name: string;
  signature: string;
  reason: string;
};

type ScriptBlock = {
  content: string;
  startOffset: number;
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    json: args.includes('--json'),
    includeTests: args.includes('--include-tests'),
    includeScripts: args.includes('--include-scripts'),
  };
}

function getTargetFiles({ includeTests, includeScripts }: { includeTests: boolean; includeScripts: boolean }) {
  const patterns = [
    'src/**/*.ts',
    'src/**/*.vue',
  ];
  if (includeScripts) {
    patterns.push('scripts/**/*.ts');
  }
  const files = patterns.flatMap(pattern => globSync(pattern, {
    cwd: process.cwd(),
    absolute: true,
    nodir: true,
    ignore: includeTests ? [] : ['**/*.test.ts', '**/*.spec.ts'],
  }));
  return Array.from(new Set(files)).sort();
}

function extractScriptBlocks(filePath: string, content: string): ScriptBlock[] {
  if (!filePath.endsWith('.vue')) {
    return [{ content, startOffset: 0 }];
  }
  const blocks: ScriptBlock[] = [];
  const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const fullMatch = match[0];
    const blockContent = match[1] ?? '';
    const contentStart = match.index + fullMatch.indexOf(blockContent);
    blocks.push({ content: blockContent, startOffset: contentStart });
  }
  return blocks;
}

function getFunctionName(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node))
    && node.name
    && ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      return node.name.text;
    }
  }
  return undefined;
}

function getParameters(node: ts.Node): ts.NodeArray<ts.ParameterDeclaration> | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return node.parameters;
  }
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.initializer.parameters;
  }
  return undefined;
}

function getReturnTypeNode(node: ts.Node): ts.TypeNode | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return node.type;
  }
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.initializer.type;
  }
  return undefined;
}

function getNodeKindLabel(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isMethodDeclaration(node)) return 'method';
  if (ts.isVariableDeclaration(node)) return 'variable';
  if (ts.isFunctionExpression(node)) return 'function-expression';
  if (ts.isArrowFunction(node)) return 'arrow-function';
  return ts.SyntaxKind[node.kind] ?? 'unknown';
}

function isTypePredicate(node: ts.Node): boolean {
  const typeNode = getReturnTypeNode(node);
  return typeNode !== undefined && ts.isTypePredicateNode(typeNode);
}

function isNamedArgsStyle(params: ts.NodeArray<ts.ParameterDeclaration>): boolean {
  if (params.length !== 1) {
    return false;
  }
  const param = params[0]!;
  if (ts.isObjectBindingPattern(param.name)) {
    return true;
  }
  if (param.type !== undefined && ts.isTypeLiteralNode(param.type)) {
    return true;
  }
  return isNamedArgsLikeSingleParam(param);
}

function isNamedArgsLikeSingleParam(param: ts.ParameterDeclaration): boolean {
  if (!ts.isIdentifier(param.name)) {
    return false;
  }
  const paramName = param.name.text;
  if (!isNamedArgsLikeParamName(paramName)) {
    return false;
  }
  if (param.type === undefined) {
    return false;
  }
  return isNamedArgsLikeTypeNode(param.type);
}

function isNamedArgsLikeParamName(name: string): boolean {
  return /^(options?|params?|init|config|settings|state|payload|args|request|context)$/u.test(name);
}

function isNamedArgsLikeTypeNode(typeNode: ts.TypeNode): boolean {
  if (ts.isTypeLiteralNode(typeNode)) {
    return true;
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return isNamedArgsLikeTypeNode(typeNode.type);
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.every(isNamedArgsLikeTypeNode);
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText();
    if (/(\b|\.)(Options?|Params?|Init|Config|Settings|State|Payload|Args|Request|Context)$/u.test(typeName)) {
      return true;
    }
    if (['Partial', 'Pick', 'Omit', 'Readonly', 'Required', 'Record'].includes(typeName)) {
      return true;
    }
    return false;
  }
  return false;
}

function isLikelyObjectLikeSingleParam(param: ts.ParameterDeclaration): boolean {
  if (!ts.isIdentifier(param.name) || param.type === undefined) {
    return false;
  }
  const paramName = param.name.text;
  const typeText = param.type.getText();

  // TODO: This script is intentionally biased toward suppressing noise, even if that
  // means some real positional single-arg functions are missed.
  if (/^_[a-zA-Z0-9_]+$/u.test(paramName)) {
    return true;
  }
  if (/^(options?|params?|init|config|settings|state|payload|args|request|context|listener|updater|controller|snapshot|schema|meta|event|items|nodes|messages|toolCalls|processes|mounts|blobOrParams)$/u.test(paramName)) {
    return true;
  }
  if (/(^|[<.(])(?:Array|Map|Set|Promise|ReadonlyArray|Uint8Array|Blob|File|ReadableStream|AbortSignal|HTMLElement|Element|Node|MouseEvent|KeyboardEvent|PointerEvent|WheelEvent|DragEvent|ClipboardEvent|ProgressInfo|StorageSnapshot|Hierarchy|Chat(?:Meta|Content|Group|FlowItem|Message)?|MessageNode|BinaryObject|MediaItem|Mount|Vitest|UserConsoleLog|TestCase|JSZip|ImportConfig|Settings|LmParameters|ToolCall|RegistryEntry|FileSystem[A-Za-z]+Handle|Wesh[A-Za-z]+|TransformersJs[A-Za-z]+|ScanOptions|ChangeListener|StorageChangeEvent)\b/u.test(typeText)) {
    return true;
  }
  if (/[A-Z][A-Za-z0-9_]+(?:\[\])?$/.test(typeText) && !/^(string|number|boolean|unknown|any|never|void)$/u.test(typeText)) {
    return true;
  }
  return false;
}

function isDomListenerAdapter(name: string, params: ts.NodeArray<ts.ParameterDeclaration>): boolean {
  if (params.length !== 1) {
    return false;
  }
  const [param] = params;
  if (!param || !ts.isIdentifier(param.name) || param.type === undefined) {
    return false;
  }
  const typeText = param.type.getText();
  return /Event$/.test(typeText) && /(Listener|handleWindow|handleDocument|handle.*Mouse|handle.*Key|handle.*Drag)/u.test(name);
}

function isLowSignalCallback(name: string, params: ts.NodeArray<ts.ParameterDeclaration>): boolean {
  if (params.length !== 1) {
    return false;
  }
  const [param] = params;
  if (!param || !ts.isIdentifier(param.name)) {
    return false;
  }
  const paramName = param.name.text;
  const typeText = param.type?.getText() ?? '';
  if (/^(start|pull|write|transform|scan|emit|notify|subscribe|onInit|onFinished|onTestRunEnd|reportEnd)$/u.test(name)) {
    return true;
  }
  if (/^(controller|chunk|event|listener|log|testCase|vitest)$/u.test(paramName)) {
    return true;
  }
  if (/^(UserConsoleLog|TestCase|Vitest)$/u.test(typeText)) {
    return true;
  }
  return false;
}

function shouldReport(node: ts.Node, params: ts.NodeArray<ts.ParameterDeclaration>): { report: boolean; reason: string } {
  if (params.length === 0) {
    return { report: false, reason: 'zero-args' };
  }
  if (isTypePredicate(node)) {
    return { report: false, reason: 'type-predicate-exception' };
  }
  if (isNamedArgsStyle(params)) {
    return { report: false, reason: 'already-named-args' };
  }
  if (params.length === 1 && isLikelyObjectLikeSingleParam(params[0]!)) {
    return { report: false, reason: 'object-like-single-param-noise' };
  }
  const name = getFunctionName(node);
  if (name !== undefined && isDomListenerAdapter(name, params)) {
    return { report: false, reason: 'dom-listener-adapter-noise' };
  }
  if (name !== undefined && isLowSignalCallback(name, params)) {
    return { report: false, reason: 'callback-noise' };
  }
  return {
    report: true,
    reason: params.length === 1 ? 'single-positional-param' : 'multiple-positional-params',
  };
}

function collectFindingsForSourceFile({
  filePath,
  content,
  scriptBlock,
}: {
  filePath: string;
  content: string;
  scriptBlock: ScriptBlock;
}): Finding[] {
  const sourceFile = ts.createSourceFile(filePath, scriptBlock.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: Finding[] = [];

  function visit(node: ts.Node) {
    const name = getFunctionName(node);
    const params = getParameters(node);
    if (name !== undefined && params !== undefined) {
      const evaluation = shouldReport(node, params);
      if (evaluation.report) {
        const absoluteStart = scriptBlock.startOffset + node.getStart(sourceFile);
        const position = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
        const line = content.slice(0, absoluteStart).split('\n').length;
        const lastNewlineIndex = content.lastIndexOf('\n', absoluteStart - 1);
        const column = absoluteStart - lastNewlineIndex;
        findings.push({
          filePath,
          line,
          column,
          kind: getNodeKindLabel(node),
          name,
          signature: `${name}(${params.map(param => param.getText(sourceFile)).join(', ')})`,
          reason: evaluation.reason,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function main() {
  const options = parseArgs();
  const files = getTargetFiles(options);
  const findings: Finding[] = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const scriptBlock of extractScriptBlocks(filePath, content)) {
      findings.push(...collectFindingsForSourceFile({ filePath, content, scriptBlock }));
    }
  }

  findings.sort((left, right) => {
    if (left.filePath !== right.filePath) return left.filePath.localeCompare(right.filePath);
    if (left.line !== right.line) return left.line - right.line;
    return left.column - right.column;
  });

  if (options.json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  for (const finding of findings) {
    const relativePath = path.relative(process.cwd(), finding.filePath);
    console.log(`${relativePath}:${finding.line}:${finding.column} [${finding.reason}] ${finding.signature}`);
  }

  console.log(`\nTotal non-named-args definitions: ${findings.length}`);
}

main();
