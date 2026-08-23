import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = [
  "src/00-storage/service/hizofs",
  "src/00-storage/service/naidan-opfs",
  "src/00-storage/service/naidan-persistence-control",
  "src/features/debug-hizofs",
  "src/features/debug-opfs-encryption",
] as const;

const SOURCE_FILES = ["eslint.config.js", "vite.config.ts"] as const;
const SCANNED_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".ts", ".tsx", ".vue"]);

function joinedPattern({ parts }: { parts: readonly string[] }): RegExp {
  return new RegExp(parts.join(""), "i");
}

const FORBIDDEN_PROVENANCE = [
  { label: "external implementation identifier", pattern: joinedPattern({ parts: ["\\b(?:", "C", "\\d{3,4}[A-Z]?|", "D", "\\d{4})\\b"] }) },
  { label: "historical patch identifier", pattern: joinedPattern({ parts: ["\\b", "patch", "[ _-]*\\d+\\b"] }) },
  { label: "private development-method name", pattern: joinedPattern({ parts: ["\\b", "clean", "[ _-]?", "room", "\\b"] }) },
  { label: "external candidate-process reference", pattern: joinedPattern({ parts: ["\\b", "formal", " candidate\\b"] }) },
  { label: "external architecture-workspace reference", pattern: joinedPattern({ parts: ["\\b", "de", "sign", " workspace\\b"] }) },
  { label: "external architecture-authority reference", pattern: joinedPattern({ parts: ["\\b", "Des", "ign", "\\b"] }) },
  { label: "external implementation-step reference", pattern: joinedPattern({ parts: ["\\b", "implementation", " slice\\b"] }) },
  { label: "external tracking reference", pattern: joinedPattern({ parts: ["\\b", "tracking", " (?:commit|repository)\\b"] }) },
  { label: "external workspace revision", pattern: joinedPattern({ parts: ["\\b", "private", " workspace revision\\b"] }) },
  { label: "external isolation-phase reference", pattern: joinedPattern({ parts: ["\\b", "quaran", "tine", " phase\\b"] }) },
  { label: "external source revision", pattern: joinedPattern({ parts: ["\\b", "historical", " source revision\\b"] }) },
  {
    label: "implementation-history phrasing",
    pattern: joinedPattern({
      parts: [
        "\\b(?:", "for", "mer|", "hist", "orical|", "leg", "acy)",
        "\\b.{0,64}\\b(?:approach|budget|cap|implementation|path|schedule|series)\\b",
      ],
    }),
  },
] as const;

function isNumberedTodoComment({ line }: { line: string }): boolean {
  // WHY: Numbered TODO comments are temporary cross-references to tracked work.
  // Keeping their identifiers searchable is more useful than forcing a detached
  // explanation that will disappear when the TODO itself is resolved.
  return /^\s*(?:\/\/|\/\*+|\*|<!--)\s*TODO(?:\(|:|\b)/.test(line);
}

function collectFiles({ path }: { path: string }): string[] {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) return collectFiles({ path: entryPath });
    return SCANNED_EXTENSIONS.has(extname(entry.name)) ? [entryPath] : [];
  });
}

describe("HizoFS source provenance", () => {
  it("allows searchable identifiers only on actual TODO comment lines", () => {
    const todoId = ["I", "0042"].join("");
    expect(isNumberedTodoComment({ line: `// TODO(hizofs-v1:${todoId}): finish the bounded reader` })).toBe(true);
    expect(isNumberedTodoComment({ line: `const message = "TODO(hizofs-v1:${todoId}): not a comment";` })).toBe(false);
  });

  it("keeps external implementation history out of repository-owned source and tests", () => {
    const repositoryRoot = process.cwd();
    const files = [
      ...SOURCE_ROOTS.flatMap((sourceRoot) => collectFiles({ path: join(repositoryRoot, sourceRoot) })),
      ...SOURCE_FILES.map((sourceFile) => join(repositoryRoot, sourceFile)).filter(existsSync),
    ];
    const findings: string[] = [];

    for (const file of files) {
      const relativePath = relative(repositoryRoot, file);
      for (const { label, pattern } of FORBIDDEN_PROVENANCE) {
        if (pattern.test(relativePath)) findings.push(`${relativePath}: ${label} in path`);
      }
      const lines = readFileSync(file, "utf8").split(/\r?\n/u);
      for (const [lineIndex, line] of lines.entries()) {
        if (isNumberedTodoComment({ line })) continue;
        for (const { label, pattern } of FORBIDDEN_PROVENANCE) {
          if (!pattern.test(line)) continue;
          findings.push(`${relativePath}:${lineIndex + 1}: ${label}: ${line.trim()}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });
});
