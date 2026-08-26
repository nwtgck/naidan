import { JSDOM } from "jsdom";
import type { OutputAsset, OutputChunk, RolldownOutput } from "rolldown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
  FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE,
} from "../../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol.js";
import {
  buildRepresentativeStandaloneArtifactFixture,
  removeRepresentativeStandaloneArtifactFixture,
  REPRESENTATIVE_WORKER_NAMES,
} from "./representative-standalone-artifact-fixture.js";

let fixture: Awaited<ReturnType<typeof buildRepresentativeStandaloneArtifactFixture>> | undefined;

function getFixture(): Awaited<ReturnType<typeof buildRepresentativeStandaloneArtifactFixture>> {
  if (fixture === undefined) throw new Error("Representative standalone artifact fixture has not been built");
  return fixture;
}

function readAssetText({ asset }: Readonly<{asset: OutputAsset}>): string {
  return typeof asset.source === "string"
    ? asset.source
    : Buffer.from(asset.source).toString("utf8");
}

function readOutputText({ item }: Readonly<{item: OutputAsset | OutputChunk}>): string {
  return item.type === "chunk" ? item.code : readAssetText({ asset: item });
}

function requireOutputItem({ output, fileName }: Readonly<{
  output: RolldownOutput;
  fileName: string;
}>): OutputAsset | OutputChunk {
  const item = output.output.find(candidate => candidate.fileName === fileName);
  if (item === undefined) throw new Error(`Expected representative output ${fileName}`);
  return item;
}

function requireAssetText({ output, fileName }: Readonly<{
  output: RolldownOutput;
  fileName: string;
}>): string {
  const item = requireOutputItem({ output, fileName });
  if (item.type !== "asset") throw new Error(`Expected representative output ${fileName} to be an asset`);
  return readAssetText({ asset: item });
}

function requireChunk({ output, predicate, description }: Readonly<{
  output: RolldownOutput;
  predicate: (chunk: OutputChunk) => boolean;
  description: string;
}>): OutputChunk {
  const matches = output.output.filter((item): item is OutputChunk => item.type === "chunk" && predicate(item));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${description}; found ${matches.map(({ fileName }) => fileName).join(", ")}`);
  }
  return matches[0];
}

function findOutputFileContaining({ output, marker, extension }: Readonly<{
  output: RolldownOutput;
  marker: string;
  extension: ".css" | ".js";
}>): string {
  const matches = output.output
    .filter(item => item.fileName.endsWith(extension))
    .filter(item => readOutputText({ item }).includes(marker));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${extension} output containing ${marker}; found ${matches.map(({ fileName }) => fileName).join(", ")}`);
  }
  return matches[0].fileName;
}

function basename({ fileName }: Readonly<{fileName: string}>): string {
  const value = fileName.split("/").at(-1);
  if (value === undefined) throw new Error(`Expected output basename for ${fileName}`);
  return value;
}

function requireUiEntryChunk({ output }: Readonly<{output: RolldownOutput}>): OutputChunk {
  return requireChunk({
    output,
    predicate: chunk => chunk.fileName.startsWith("assets/index-systemjs-"),
    description: "representative UI entry chunk",
  });
}

function requireWorkerChunk({ output, workerName }: Readonly<{
  output: RolldownOutput;
  workerName: typeof REPRESENTATIVE_WORKER_NAMES[number];
}>): OutputChunk {
  return requireChunk({
    output,
    predicate: chunk => chunk.fileName.startsWith(`assets/representative-${workerName}-worker-systemjs-`),
    description: `representative ${workerName} Worker chunk`,
  });
}

describe("file-protocol standalone representative artifact contract", () => {
  beforeAll(async () => {
    fixture = await buildRepresentativeStandaloneArtifactFixture();
  });

  afterAll(() => {
    if (fixture === undefined) return;
    removeRepresentativeStandaloneArtifactFixture({ root: fixture.root });
    fixture = undefined;
  });

  it("keeps conditional public styles and only static UI CSS in the initial HTML", () => {
    const { output } = getFixture();
    const html = requireAssetText({ output, fileName: "index.html" });
    const initialCss = findOutputFileContaining({ output, marker: "representative-initial", extension: ".css" });
    const staticCss = findOutputFileContaining({ output, marker: "width: 41px", extension: ".css" });
    const staticSharedUiWorkerCss = findOutputFileContaining({ output, marker: "--representative-static-shared: applied", extension: ".css" });
    const lazyCss = findOutputFileContaining({ output, marker: "--representative-lazy: applied", extension: ".css" });
    const nestedLazyCss = findOutputFileContaining({ output, marker: "representative-nested-lazy", extension: ".css" });
    const lazySharedUiWorkerCss = findOutputFileContaining({ output, marker: "--representative-lazy-shared: applied", extension: ".css" });

    expect(html).toMatch(/<link rel="stylesheet" media="print" href="\.\/public-print\.css">/u);
    expect(html).toContain(initialCss);
    expect(html).toContain(staticCss);
    expect(html).toContain(staticSharedUiWorkerCss);
    expect(html.indexOf(staticSharedUiWorkerCss)).toBeLessThan(html.indexOf(initialCss));
    expect(html).not.toContain(lazyCss);
    expect(html).not.toContain(nestedLazyCss);
    expect(html).not.toContain(lazySharedUiWorkerCss);
    expect(html).not.toContain("crossorigin");
    expect(html).not.toContain("modulepreload");
  });

  it("preserves pre-runtime scripts and emits the ordered classic runtime bootstrap expected by Standalone Verification", () => {
    const { output } = getFixture();
    const html = requireAssetText({ output, fileName: "index.html" });
    const document = new JSDOM(html).window.document;
    const scripts = Array.from(document.scripts);
    const executableScripts = scripts.filter(script => script.getAttribute("type") !== "application/ld+json");
    const structuredDataScript = scripts.find(script => script.getAttribute("type") === "application/ld+json");
    const runtimeSources = [
      "./file-protocol-standalone/system.min.js",
      "./file-protocol-standalone/systemjs-file-protocol-patch.js",
      "./file-protocol-standalone/systemjs-physical-load-retry.js",
    ] as const;

    expect(structuredDataScript?.textContent).toContain("representative-standalone-artifact");
    expect(executableScripts.map(({ id }) => id)).toEqual([
      "representative-pre-runtime",
      ...FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS,
    ]);
    expect(executableScripts[0]?.getAttribute(FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE))
      .toBe(FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE);
    expect(scripts.every(script => script.getAttribute("type") !== "module")).toBe(true);
    expect(executableScripts.every(script => !script.hasAttribute("crossorigin"))).toBe(true);

    for (const [index, source] of runtimeSources.entries()) {
      const script = executableScripts[index + 1];
      expect(script?.getAttribute("src")).toBe(source);
      requireOutputItem({ output, fileName: source.slice(2) });
    }

    const entryBootstrap = executableScripts.at(-1);
    const entryChunk = requireUiEntryChunk({ output });
    expect(entryBootstrap?.hasAttribute("src")).toBe(false);
    expect(entryBootstrap?.textContent).toContain(`System.import("./${entryChunk.fileName}")`);
  });

  it("preserves lazy UI CSS as dependencies of the Dynamic Import that first needs it", () => {
    const { output } = getFixture();
    const entryChunk = requireUiEntryChunk({ output });
    const lazyChunk = requireChunk({
      output,
      predicate: chunk => chunk.fileName.startsWith("assets/lazy-feature-systemjs-"),
      description: "representative lazy UI chunk",
    });
    const nestedLazyChunk = requireChunk({
      output,
      predicate: chunk => chunk.fileName.startsWith("assets/nested-lazy-systemjs-"),
      description: "representative nested lazy UI chunk",
    });
    const lazyCss = findOutputFileContaining({ output, marker: "--representative-lazy: applied", extension: ".css" });
    const lazySharedUiWorkerCss = findOutputFileContaining({ output, marker: "--representative-lazy-shared: applied", extension: ".css" });
    const nestedLazyCss = findOutputFileContaining({ output, marker: "representative-nested-lazy", extension: ".css" });

    expect(entryChunk.dynamicImports).toContain(lazyChunk.fileName);
    expect(entryChunk.code).toContain(basename({ fileName: lazyCss }));
    expect(entryChunk.code).toContain(basename({ fileName: lazySharedUiWorkerCss }));
    expect(entryChunk.code).not.toMatch(/__vitePreload\([^;]+,void 0,/u);
    expect(lazyChunk.dynamicImports).toContain(nestedLazyChunk.fileName);
    expect(lazyChunk.code).toContain(basename({ fileName: nestedLazyCss }));
  });

  it("composes all configured virtual Worker clients and the shared bootstrap runtime into the UI graph", () => {
    const { output } = getFixture();
    const entryChunk = requireUiEntryChunk({ output });
    const moduleIds = Object.keys(entryChunk.modules);

    expect(moduleIds).toContain("\0naidan:standalone-worker-runtime");
    for (const workerName of REPRESENTATIVE_WORKER_NAMES) {
      const workerSourceSuffix = `/src/${workerName}-worker.js`;
      const workerChunk = requireWorkerChunk({ output, workerName });
      expect(moduleIds).toContain(`\0naidan:standalone-worker-client:representative-${workerName}-worker`);
      expect(moduleIds.some(moduleId => moduleId.endsWith(workerSourceSuffix))).toBe(false);
      expect(Object.keys(workerChunk.modules).some(moduleId => moduleId.endsWith(workerSourceSuffix))).toBe(true);
      expect(entryChunk.code).toContain(basename({ fileName: workerChunk.fileName }));
    }
    expect(entryChunk.code).toContain("file-protocol-standalone/system.min.js");
    expect(entryChunk.code).toContain("URL.createObjectURL");
    expect(entryChunk.code).toContain("new Worker");
    expect(entryChunk.code).toContain("__representativeWorkerFactories");
  });

  it("shares one physical static module chunk across the UI and all Worker entry graphs", () => {
    const { output } = getFixture();
    const uiWorkerShared = findOutputFileContaining({
      output,
      marker: "representative-ui-worker-shared",
      extension: ".js",
    });
    const workerShared = findOutputFileContaining({
      output,
      marker: "representative-worker-shared",
      extension: ".js",
    });

    expect(requireUiEntryChunk({ output }).imports).toContain(uiWorkerShared);
    for (const workerName of REPRESENTATIVE_WORKER_NAMES) {
      expect(requireWorkerChunk({ output, workerName }).imports).toEqual(expect.arrayContaining([
        uiWorkerShared,
        workerShared,
      ]));
    }
  });

  it("shares one CSS-owning lazy module across UI and Worker Dynamic Imports without making its CSS eager", () => {
    const { output } = getFixture();
    const html = requireAssetText({ output, fileName: "index.html" });
    const lazyFeatureChunk = requireChunk({
      output,
      predicate: chunk => chunk.fileName.startsWith("assets/lazy-feature-systemjs-"),
      description: "representative lazy UI chunk",
    });
    const lazySharedUiWorker = findOutputFileContaining({
      output,
      marker: "representative-lazy-ui-worker-shared",
      extension: ".js",
    });
    const lazySharedUiWorkerCss = findOutputFileContaining({
      output,
      marker: "--representative-lazy-shared: applied",
      extension: ".css",
    });

    expect(html).not.toContain(lazySharedUiWorkerCss);
    expect(lazyFeatureChunk.imports).toContain(lazySharedUiWorker);
    for (const workerName of REPRESENTATIVE_WORKER_NAMES) {
      const workerChunk = requireWorkerChunk({ output, workerName });
      expect(workerChunk.dynamicImports).toContain(lazySharedUiWorker);
      expect(workerChunk.code).toContain(basename({ fileName: lazySharedUiWorkerCss }));
    }
  });

  it("shares static and lazy chunks only across the Worker subset that reaches them", () => {
    const { output } = getFixture();
    const uiEntry = requireUiEntryChunk({ output });
    const subsetShared = findOutputFileContaining({
      output,
      marker: "representative-worker-subset-shared",
      extension: ".js",
    });
    const subsetLazy = requireChunk({
      output,
      predicate: chunk => chunk.fileName.startsWith("assets/worker-subset-lazy-systemjs-"),
      description: "representative Worker-subset lazy chunk",
    });
    const subsetWorkerNames = new Set<typeof REPRESENTATIVE_WORKER_NAMES[number]>(["wesh", "explorer"]);

    expect(uiEntry.imports).not.toContain(subsetShared);
    expect(uiEntry.dynamicImports).not.toContain(subsetLazy.fileName);
    for (const workerName of REPRESENTATIVE_WORKER_NAMES) {
      const workerChunk = requireWorkerChunk({ output, workerName });
      if (subsetWorkerNames.has(workerName)) {
        expect(workerChunk.imports).toContain(subsetShared);
        expect(workerChunk.dynamicImports).toContain(subsetLazy.fileName);
      } else {
        expect(workerChunk.imports).not.toContain(subsetShared);
        expect(workerChunk.dynamicImports).not.toContain(subsetLazy.fileName);
      }
    }
    expect(subsetLazy.code).toContain("representative-worker-subset-lazy");
  });

  it("keeps a Worker-side Dynamic Import lazy and scoped to the Worker that owns it", () => {
    const { output } = getFixture();
    const workerLazyChunk = requireChunk({
      output,
      predicate: chunk => chunk.fileName.startsWith("assets/worker-lazy-systemjs-"),
      description: "representative Worker lazy chunk",
    });

    expect(requireWorkerChunk({ output, workerName: "editor" }).dynamicImports).toContain(workerLazyChunk.fileName);
    for (const workerName of REPRESENTATIVE_WORKER_NAMES) {
      if (workerName === "editor") continue;
      expect(requireWorkerChunk({ output, workerName }).dynamicImports).not.toContain(workerLazyChunk.fileName);
    }
    expect(workerLazyChunk.code).toContain("representative-worker-lazy");
  });

  it("prunes effect-free stylesheet output but retains the same empty bytes when they are observable through ?url", () => {
    const { output } = getFixture();
    const html = requireAssetText({ output, fileName: "index.html" });
    const entryChunk = requireUiEntryChunk({ output });
    const mixedEmptyCss = output.output.find(item => (
      item.type === "asset"
      && item.fileName.endsWith(".css")
      && item.fileName.includes("mixed-empty")
    ));
    if (mixedEmptyCss === undefined || mixedEmptyCss.type !== "asset") {
      throw new Error("Expected representative mixed empty CSS ?url asset output");
    }

    expect(readAssetText({ asset: mixedEmptyCss })).toBe("");
    expect(entryChunk.code).toContain(basename({ fileName: mixedEmptyCss.fileName }));
    expect(html).not.toContain(mixedEmptyCss.fileName);
    expect(output.output.some(({ fileName }) => fileName.includes("effect-free") && fileName.endsWith(".css"))).toBe(false);
  });

  it("retains an ordinary non-CSS ?url data asset and references it from the UI entry", () => {
    const { output } = getFixture();
    const entryChunk = requireUiEntryChunk({ output });
    const payload = output.output.find(item => item.type === "asset" && item.fileName.endsWith(".txt"));
    if (payload === undefined) throw new Error("Expected representative ?url payload output");

    expect(entryChunk.code).toContain(basename({ fileName: payload.fileName }));
  });

  it("emits every Rollup JavaScript chunk as System.register without leaking build-host paths", () => {
    const { root, output } = getFixture();
    const chunks = output.output.filter((item): item is OutputChunk => item.type === "chunk");

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.code).toContain("System.register(");
      expect(chunk.code).not.toContain(root);
    }
  });
});
