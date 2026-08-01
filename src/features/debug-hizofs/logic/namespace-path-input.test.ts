import { describe, expect, it } from "vitest";
import {
  formatHizoFSInspectorNamespacePath,
  parseHizoFSInspectorNamespacePath,
} from "@/features/debug-hizofs/logic/namespace-path-input";

describe("HizoFS Inspector namespace path input", () => {
  it("round-trips root, Unicode, and non-BMP components", () => {
    expect(parseHizoFSInspectorNamespacePath({ path: "/" })).toEqual([]);
    const pathComponents = ["日本語", "emoji-😀"];
    expect(parseHizoFSInspectorNamespacePath({
      path: formatHizoFSInspectorNamespacePath({ pathComponents }),
    })).toEqual(pathComponents);
  });

  it.each([
    "relative/path",
    "/trailing/",
    "/repeated//separator",
    "/./child",
    "/../child",
    "/nul\0child",
    `/unpaired-${String.fromCharCode(0xd800)}`,
  ])("rejects ambiguous or invalid input %j before inspection", path => {
    expect(() => parseHizoFSInspectorNamespacePath({ path })).toThrow();
  });

  it("rejects invalid components during formatting", () => {
    expect(() => formatHizoFSInspectorNamespacePath({ pathComponents: ["a/b"] }))
      .toThrow("slash");
  });
});
