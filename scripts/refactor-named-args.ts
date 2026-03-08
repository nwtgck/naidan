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
  const targetFile = path.resolve(inputFilePath);

  console.log(`🚀 Refactoring ${targetFunction} in ${inputFilePath}...`);

  // --- 1. Setup LS ---
  const tsConfigPath = path.resolve('tsconfig.app.json');
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
  const ls = ts.createLanguageService(languageServiceHost);
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
  
  if (!primaryDefNode) {
      console.error(`Could not find primary definition of ${targetFunction}`);
      process.exit(1);
  }
  const primaryDefStart = primaryDefNode.getStart(sourceFile);

  let params: ts.NodeArray<ts.ParameterDeclaration> | undefined;
  let curr: ts.Node = primaryDefNode;
  while (curr && !params) {
      if (ts.isVariableDeclaration(curr) && curr.initializer && ts.isFunctionLike(curr.initializer)) {
          params = curr.initializer.parameters;
      } else if (ts.isFunctionDeclaration(curr) || ts.isMethodDeclaration(curr) || ts.isArrowFunction(curr)) {
          params = curr.parameters;
      }
      curr = curr.parent;
  }

  if (!params) {
      console.error(`Could not extract parameters for ${targetFunction}`);
      process.exit(1);
  }
  const paramNames = params.map(p => p.name.getText(sourceFile!));
  console.log(`Parameters identified: [${paramNames.join(', ')}]`);

  // --- 3. Robust Search ---
  const allEntries = new Map<string, { fileName: string, start: number }>();
  
  // Method A: Recursive LS Search
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

  // Method B: Heuristic String Scan (for .vue and tricky spots)
  console.log('Performing heuristic scan for additional sites...');
  const allProjectFiles = globSync('src/**/*.{ts,vue}');
  const targetFileBaseName = path.basename(inputFilePath, path.extname(inputFilePath));

  for (const f of allProjectFiles) {
      const absF = path.resolve(f);
      const content = fs.readFileSync(absF, 'utf-8');
      
      // If the file doesn't even mention our target file or function, skip
      if (!content.includes(targetFunction)) continue;
      if (!content.includes(targetFileBaseName) && !f.endsWith(inputFilePath)) {
          // Check if it might be imported via another way or used globally (unlikely for sendMessage but possible)
      }

      let index = content.indexOf(targetFunction);
      while (index !== -1) {
          const entryId = `${absF}:${index}`;
          if (!allEntries.has(entryId)) {
              // Heuristic: Check if it's followed by '('
              const rest = content.substring(index + targetFunction.length);
              if (rest.trim().startsWith('(')) {
                  console.log(`[HEURISTIC] Found potential site in ${f} at ${index}`);
                  allEntries.set(entryId, { fileName: absF, start: index });
              }
          }
          index = content.indexOf(targetFunction, index + 1);
      }
  }

  console.log(`Total sites to refactor: ${allEntries.size}`);

  // --- 4. Refactor ---
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

          const named = argsList.map((a, i) => {
              const name = paramNames[i] || `arg${i}`;
              return `${name}: ${a.trim()}`;
          }).join(', ');

          ms.overwrite(entry.start + targetFunction.length, entry.start + targetFunction.length + match[0].length, `({ ${named} })`);
          console.log(`[CALL] Updated ${path.relative(process.cwd(), entry.fileName)} at pos ${entry.start}`);
      }
  }

  // Update Definition
  const defMS = getMS(targetFile);
  const newParams = `{ ${paramNames.join(', ')} }: { ${params.map(p => p.getText(sourceFile!)).join(', ')} }`;
  defMS.overwrite(params[0]!.getStart(sourceFile!), params[params.length - 1]!.getEnd(), newParams);
  console.log(`[DEF] Updated definition in ${path.relative(process.cwd(), targetFile)}`);

  // Save
  if (isDryRun) {
      console.log('\n--- DRY RUN ---');
      for (const [f, ms] of fileChanges) if (ms.hasChanged()) console.log(`Modified: ${path.relative(process.cwd(), f)}`);
  } else {
      for (const [f, ms] of fileChanges) if (ms.hasChanged()) fs.writeFileSync(f, ms.toString());
      console.log('\n✨ Refactoring complete.');
  }
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
