import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import * as vue from '@vue/language-core';
import * as volar from '@volar/typescript';
import MagicString from 'magic-string';
import { globSync } from 'glob';

async function main() {
  const args = process.argv.slice(2);
  const [inputFilePath, targetFunction] = args.filter(a => !a.startsWith('-'));
  const isDryRun = args.includes('--dry-run');
  const tsConfigPath = path.resolve('tsconfig.app.json');
  const targetFile = path.resolve(inputFilePath);

  console.log(`🚀 Refactoring ${targetFunction} in ${inputFilePath}...`);

  // --- 1. Setup LS ---
  const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsConfigPath));
  const vueOptions = vue.createParsedCommandLine(ts, ts.sys, tsConfigPath.replace(/\\/g, '/')).vueOptions;
  const vueLanguagePlugin = vue.createVueLanguagePlugin(ts, parsedConfig.options, vueOptions, id => id);
  const sourceFileSnapshots = new Map<string, ts.IScriptSnapshot>();
  const scriptRegistry = new (vue as any).FileMap(ts.sys.useCaseSensitiveFileNames);

  const language = vue.createLanguage(
    [vueLanguagePlugin, { getLanguageId: (id) => (volar as any).resolveFileLanguageId(id) }],
    scriptRegistry,
    (fileName) => {
        if (!sourceFileSnapshots.has(fileName)) {
            const content = ts.sys.readFile(fileName);
            if (content !== undefined) sourceFileSnapshots.set(fileName, ts.ScriptSnapshot.fromString(content));
        }
        const snapshot = sourceFileSnapshots.get(fileName);
        if (snapshot) language.scripts.set(fileName, snapshot);
        else language.scripts.delete(fileName);
    }
  );

  for (const fileName of parsedConfig.fileNames) {
      const content = ts.sys.readFile(fileName);
      if (content !== undefined) {
          sourceFileSnapshots.set(fileName, ts.ScriptSnapshot.fromString(content));
          language.scripts.set(fileName, ts.ScriptSnapshot.fromString(content));
      }
  }

  const { languageServiceHost } = (volar as any).createLanguageServiceHost(ts, ts.sys, language, id => id, {
    getScriptFileNames: () => parsedConfig.fileNames,
    getProjectVersion: () => '0',
    getCompilationSettings: () => parsedConfig.options,
    getCurrentDirectory: () => process.cwd(),
    getProjectReferences: () => parsedConfig.projectReferences,
  });
  const baseLs = ts.createLanguageService(languageServiceHost);
  const { proxy: ls } = (volar as any).createProxyLanguageService(baseLs);
  const program = ls.getProgram()!;
  const sourceFile = program.getSourceFile(targetFile)!;

  // --- 2. Find Def and Params ---
  let primaryDefNode: ts.Identifier | undefined;
  function findPrimaryDef(node: ts.Node) {
      if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && 
          node.name && ts.isIdentifier(node.name) && node.name.getText(sourceFile!) === targetFunction) {
          primaryDefNode = node;
      }
      ts.forEachChild(node, findPrimaryDef);
  }
  findPrimaryDef(sourceFile);
  const primaryDefStart = primaryDefNode!.getStart(sourceFile);

  let params: ts.NodeArray<ts.ParameterDeclaration> | undefined;
  let currNode: ts.Node = primaryDefNode!;
  while (currNode && !params) {
      if (ts.isVariableDeclaration(currNode) && currNode.initializer && ts.isFunctionLike(currNode.initializer)) params = currNode.initializer.parameters;
      else if (ts.isFunctionDeclaration(currNode) || ts.isMethodDeclaration(currNode) || ts.isArrowFunction(currNode)) params = currNode.parameters;
      currNode = currNode.parent;
  }
  const paramNames = params!.map(p => p.name.getText(sourceFile!));
  console.log(`Parameters identified: [${paramNames.join(', ')}]`);

  // --- 3. Reference Search ---
  const allEntries = new Map<string, { fileName: string, start: number }>();
  const queue: { fileName: string, pos: number }[] = [];
  function collectSearchPositions(node: ts.Node) {
      if (ts.isIdentifier(node) && node.getText(sourceFile!) === targetFunction) {
          queue.push({ fileName: targetFile, pos: node.getStart(sourceFile!) });
      }
      ts.forEachChild(node, collectSearchPositions);
  }
  collectSearchPositions(sourceFile);

  const seen = new Set<string>();
  while (queue.length > 0) {
      const { fileName, pos } = queue.shift()!;
      if (seen.has(`${fileName}:${pos}`)) continue;
      seen.add(`${fileName}:${pos}`);

      const refs = ls.findReferences(fileName, pos);
      if (refs) {
          for (const group of refs) {
              for (const entry of group.references) {
                  const entryId = `${entry.fileName}:${entry.textSpan.start}`;
                  if (!allEntries.has(entryId)) {
                      let start = entry.textSpan.start;
                      const script = language.scripts.get(entry.fileName);
                      if (script?.generated && !entry.fileName.endsWith('.vue')) {
                          for (const code of vue.forEachEmbeddedCode(script.generated.root)) {
                              const m = code.mappings.find(m => start >= m.generatedOffsets[0] && start < m.generatedOffsets[0] + m.lengths[0]);
                              if (m) { start = m.sourceOffsets[0] + (start - m.generatedOffsets[0]); break; }
                          }
                      }
                      allEntries.set(entryId, { fileName: entry.fileName, start });
                      if (!entry.fileName.endsWith('.vue')) queue.push({ fileName: entry.fileName, pos: entry.textSpan.start });
                  }
              }
          }
      }
  }

  // --- 4. Heuristic Backup for .vue files ---
  console.log('Performing heuristic check for .vue files...');
  const vueFiles = globSync('src/**/*.vue');
  const targetFileBase = path.basename(inputFilePath, path.extname(inputFilePath));

  for (const vf of vueFiles) {
      const absVf = path.resolve(vf);
      const content = fs.readFileSync(absVf, 'utf-8');
      
      // Only check files that import the target composable
      if (!content.includes(targetFileBase)) continue;

      let index = content.indexOf(targetFunction);
      while (index !== -1) {
          const entryId = `${absVf}:${index}`;
          if (!allEntries.has(entryId)) {
              // Check if it looks like a call and is NOT in a comment
              if (isCallInSource(content, index, targetFunction)) {
                  console.log(`[HEURISTIC] Found call site in ${vf} at ${index}`);
                  allEntries.set(entryId, { fileName: absVf, start: index });
              }
          }
          index = content.indexOf(targetFunction, index + 1);
      }
  }

  console.log(`Total sites to refactor: ${allEntries.size}`);

  // --- 5. Refactor ---
  const fileChanges = new Map<string, MagicString>();
  const getMS = (f: string) => {
      if (!fileChanges.has(f)) fileChanges.set(f, new MagicString(fs.readFileSync(f, 'utf-8')));
      return fileChanges.get(f)!;
  };

  for (const entry of allEntries.values()) {
      if (entry.fileName === targetFile && entry.start === primaryDefStart) continue;

      const ms = getMS(entry.fileName);
      const code = ms.original;
      const rest = code.substring(entry.start + targetFunction.length);
      const match = rest.match(/^\s*\(([\s\S]*?)\)/);
      if (match) {
          const argsText = match[1]!;
          if (argsText.trim().startsWith('{') && argsText.trim().endsWith('}')) continue;

          const argsList = splitArguments(argsText);
          if (argsList.length === 0 && paramNames.length > 0) continue; 

          const named = argsList.map((a, i) => `${paramNames[i] || `arg${i}`}: ${a.trim()}`).join(', ');
          ms.overwrite(entry.start + targetFunction.length, entry.start + targetFunction.length + match[0].length, `({ ${named} })`);
          console.log(`[CALL] Updated ${path.relative(process.cwd(), entry.fileName)} at pos ${entry.start}`);
      }
  }

  // Definition
  const defMS = getMS(targetFile);
  const destructuring = params!.map(p => p.initializer ? `${p.name.getText(sourceFile!)} = ${p.initializer.getText(sourceFile!)}` : p.name.getText(sourceFile!));
  const types = params!.map(p => `${p.name.getText(sourceFile!)}${p.questionToken || p.initializer ? '?' : ''}: ${p.type ? p.type.getText(sourceFile!) : 'any'}`);
  defMS.overwrite(params![0].getStart(sourceFile!), params![params!.length - 1].getEnd(), `{ ${destructuring.join(', ')} }: { ${types.join(', ')} }`);
  console.log(`[DEF] Updated definition in ${path.relative(process.cwd(), targetFile)}`);

  if (isDryRun) {
      console.log('\n--- DRY RUN ---');
      for (const [f, ms] of fileChanges) if (ms.hasChanged()) console.log(`Modified: ${path.relative(process.cwd(), f)}`);
  } else {
      for (const [f, ms] of fileChanges) if (ms.hasChanged()) fs.writeFileSync(f, ms.toString());
      console.log('\n✨ Refactoring complete.');
  }
}

function isCallInSource(content: string, index: number, fnName: string): boolean {
    const before = content.substring(0, index);
    const after = content.substring(index + fnName.length);
    
    // Must be followed by '('
    if (!after.trim().startsWith('(')) return false;

    // Must NOT be in a line comment
    const lastNewline = before.lastIndexOf('\n');
    const lineBefore = before.substring(lastNewline + 1);
    if (lineBefore.includes('//')) return false;

    // Must NOT be in a block comment
    const lastBlockStart = before.lastIndexOf('/*');
    const lastBlockEnd = before.lastIndexOf('*/');
    if (lastBlockStart > lastBlockEnd) return false;

    return true;
}

function splitArguments(text: string): string[] {
    const res: string[] = [];
    let cur = '', d = 0;
    for (const c of text) {
        if (['(', '{', '['].includes(c)) d++;
        if ([')', '}', ']'].includes(c)) d--;
        if (c === ',' && d === 0) { res.push(cur); cur = ''; }
        else cur += c;
    }
    if (cur.trim()) res.push(cur);
    return res;
}

main().catch(console.error);
