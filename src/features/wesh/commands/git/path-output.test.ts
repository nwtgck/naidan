import { describe, expect, it } from "vitest";
import { formatGitPatchPath, quoteGitPath, quoteNonAsciiFromConfig } from "./path-output";

describe("Git pathname output", () => {
  it("uses Git-compatible C-style quoting for unsafe pathname bytes", () => {
    expect(quoteGitPath({ path: "safe.txt", quoteNonAscii: true, quoteSpaces: false })).toBe("safe.txt");
    expect(quoteGitPath({ path: "space name.txt", quoteNonAscii: true, quoteSpaces: false })).toBe("space name.txt");
    expect(quoteGitPath({ path: "space name.txt", quoteNonAscii: true, quoteSpaces: true })).toBe("\"space name.txt\"");
    expect(quoteGitPath({ path: "tab\tline\nquote\"back\\bell\x07esc\x1b", quoteNonAscii: true, quoteSpaces: false }))
      .toBe("\"tab\\tline\\nquote\\\"back\\\\bell\\aesc\\033\"");
  });

  it("quotes non-ASCII UTF-8 bytes by default and preserves them when core.quotePath is disabled", () => {
    expect(quoteGitPath({ path: "日本語😀.txt", quoteNonAscii: true, quoteSpaces: false }))
      .toBe("\"\\346\\227\\245\\346\\234\\254\\350\\252\\236\\360\\237\\230\\200.txt\"");
    expect(quoteGitPath({ path: "日本語😀.txt", quoteNonAscii: false, quoteSpaces: false })).toBe("日本語😀.txt");
  });

  it("formats patch paths without quoting ordinary spaces", () => {
    expect(formatGitPatchPath({ path: "space name.txt", prefix: "a", quoteNonAscii: true, headerLabel: false }))
      .toBe("a/space name.txt");
    expect(formatGitPatchPath({ path: "space name.txt", prefix: "a", quoteNonAscii: true, headerLabel: true }))
      .toBe("a/space name.txt\t");
    expect(formatGitPatchPath({ path: "日本語.txt", prefix: "b", quoteNonAscii: true, headerLabel: true }))
      .toBe(String.raw`"b/\346\227\245\346\234\254\350\252\236.txt"`);
    expect(formatGitPatchPath({ path: "日本語.txt", prefix: "b", quoteNonAscii: false, headerLabel: true }))
      .toBe("b/日本語.txt");
  });

  it("reads the common Git boolean forms for core.quotePath", () => {
    expect(quoteNonAsciiFromConfig({ config: new Map() })).toBe(true);
    expect(quoteNonAsciiFromConfig({ config: new Map([["core.quotepath", { kind: 'implicit-boolean' }]]) })).toBe(true);
    expect(quoteNonAsciiFromConfig({ config: new Map([["core.quotepath", { kind: 'explicit', value: '' }]]) })).toBe(false);
    expect(quoteNonAsciiFromConfig({ config: new Map([["core.quotepath", { kind: 'explicit', value: "false" }]]) })).toBe(false);
    expect(quoteNonAsciiFromConfig({ config: new Map([["core.quotepath", { kind: 'explicit', value: "off" }]]) })).toBe(false);
    expect(quoteNonAsciiFromConfig({ config: new Map([["core.quotepath", { kind: 'explicit', value: "yes" }]]) })).toBe(true);
    expect(() => quoteNonAsciiFromConfig({ config: new Map([["core.quotepath", { kind: 'explicit', value: "maybe" }]]) }))
      .toThrow("bad boolean config value 'maybe' for 'core.quotepath'");
  });
});
