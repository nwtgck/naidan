import ts from 'typescript';

export function executableTokens({ source, file }: { source: string, file: string }): string {
  const output = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, removeComments: true } }).outputText;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, output);
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) tokens.push(`${token}:${scanner.getTokenText()}`);
  return tokens.join('\n');
}
