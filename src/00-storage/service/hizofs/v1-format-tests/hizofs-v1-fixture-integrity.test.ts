import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import fixtureManifestJson from "./fixtures/manifest.json";
import legalVariantFixtureManifestJson from "./legal-variant-fixtures/manifest.json";
import negativeFixtureManifestJson from "./negative-fixtures/manifest.json";
import { validateFrozenPortableContainerFixture } from "./support/portable-container";
import { expect, it } from "vitest";
import { z } from "zod";

const fixtureManifestSchema = z.object({
  fixtures: z.array(z.object({
    file: z.string(),
    origin: z.literal("real_hizofs_writer"),
    scenarioId: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict()).readonly(),
  schema: z.literal("hizofs-v1-historical-fixture-manifest"),
  schemaVersion: z.literal(1),
}).strict();

const legalVariantFixtureManifestSchema = z.object({
  fixtures: z.array(z.discriminatedUnion("kind", [
    z.object({
      caseId: z.string(),
      affectedFileCount: z.number().int().positive(),
      expectedScenarioId: z.string(),
      file: z.string(),
      kind: z.literal("redundant_copy_degradation"),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      sourceFixture: z.string(),
    }).strict(),
    z.object({
      caseId: z.string(),
      corruptedRecordCount: z.number().int().positive(),
      expectedScenarioId: z.string(),
      file: z.string(),
      kind: z.literal("active_commit_fallback_recovery"),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }).strict(),
    z.object({
      affectedFileCount: z.number().int().positive(),
      caseId: z.string(),
      expectedScenarioId: z.string(),
      file: z.string(),
      kind: z.literal("active_commit_segment_missing_fallback"),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      sourceFixture: z.string(),
    }).strict(),
  ])).readonly(),
  schema: z.literal("hizofs-v1-legal-variant-fixture-manifest"),
  schemaVersion: z.literal(1),
}).strict();

const negativeFixtureManifestSchema = z.object({
  fixtures: z.array(z.discriminatedUnion("kind", [
    z.object({
      caseId: z.string(),
      corruptedFileCount: z.number().int().positive(),
      expectedOutcome: z.enum(["reject_open", "reject_open_or_observation"]),
      file: z.string(),
      kind: z.literal("corruption"),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      sourceFixture: z.string(),
    }).strict(),
    z.object({
      caseId: z.string(),
      expectedOutcome: z.literal("unsupported_required_feature"),
      file: z.string(),
      kind: z.literal("authenticated_unsupported_feature"),
      requiredFeatureBits: z.string().regex(/^[1-9][0-9]*$/u),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }).strict(),
    z.object({
      caseId: z.string(),
      expectedOutcome: z.literal("reject_open"),
      file: z.string(),
      kind: z.literal("missing_persisted_object"),
      missingFileCount: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      sourceFixture: z.string(),
    }).strict(),
    z.object({
      caseId: z.string(),
      expectedOutcome: z.enum(["reject_open", "reject_open_or_observation"]),
      file: z.string(),
      kind: z.literal("segment_path_misbinding"),
      misboundFileCount: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      sourceFixture: z.string(),
    }).strict(),
    z.object({
      caseId: z.string(),
      expectedOutcome: z.literal("reject_open"),
      file: z.string(),
      kind: z.literal("truncation"),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      sourceFixture: z.string(),
      truncatedByteLength: z.number().int().nonnegative(),
      truncatedFileCount: z.number().int().positive(),
    }).strict(),
  ])).readonly(),
  schema: z.literal("hizofs-v1-negative-fixture-manifest"),
  schemaVersion: z.literal(1),
}).strict();

it("keeps every historical V1 fixture registered and byte-identical to its reviewed manifest hash", async () => {
  const manifest = fixtureManifestSchema.parse(fixtureManifestJson);
  const { fixtures, schema, schemaVersion, ...unhandledManifest } = manifest;
  unhandledManifest satisfies Record<PropertyKey, never>;
  expect(schema).toBe("hizofs-v1-historical-fixture-manifest");
  expect(schemaVersion).toBe(1);

  const fixtureDirectory = path.join(process.cwd(), "src/00-storage/service/hizofs/v1-format-tests/fixtures");
  const actualFixtureFiles = (await readdir(fixtureDirectory))
    .filter(file => file.endsWith(".json") && file !== "manifest.json")
    .sort();
  expect(actualFixtureFiles).toEqual(fixtures.map(({ file }) => file).sort());

  for (const fixtureEntry of fixtures) {
    const { file, origin, scenarioId, sha256, ...unhandledEntry } = fixtureEntry;
    unhandledEntry satisfies Record<PropertyKey, never>;
    expect(origin).toBe("real_hizofs_writer");
    expect(scenarioId.length).toBeGreaterThan(0);
    const raw = await readFile(path.join(fixtureDirectory, file));
    expect(createHash("sha256").update(raw).digest("hex")).toBe(sha256);
    validateFrozenPortableContainerFixture({ fixture: JSON.parse(raw.toString("utf8")) as unknown });
  }
});

it("keeps every frozen legal-variant V1 fixture registered and byte-identical to its reviewed manifest hash", async () => {
  const manifest = legalVariantFixtureManifestSchema.parse(legalVariantFixtureManifestJson);
  const { fixtures, schema, schemaVersion, ...unhandledManifest } = manifest;
  unhandledManifest satisfies Record<PropertyKey, never>;
  expect(schema).toBe("hizofs-v1-legal-variant-fixture-manifest");
  expect(schemaVersion).toBe(1);

  const fixtureDirectory = path.join(process.cwd(), "src/00-storage/service/hizofs/v1-format-tests/legal-variant-fixtures");
  const actualFixtureFiles = (await readdir(fixtureDirectory))
    .filter(file => file.endsWith(".json") && file !== "manifest.json")
    .sort();
  expect(actualFixtureFiles).toEqual(fixtures.map(({ file }) => file).sort());

  for (const fixtureEntry of fixtures) {
    const { caseId, expectedScenarioId, file, kind, sha256 } = fixtureEntry;
    expect(caseId.length).toBeGreaterThan(0);
    expect(expectedScenarioId.length).toBeGreaterThan(0);

    switch (kind) {
    case "redundant_copy_degradation": {
      const {
        affectedFileCount,
        caseId: _caseId,
        expectedScenarioId: _expectedScenarioId,
        file: _file,
        kind: _kind,
        sha256: _sha256,
        sourceFixture,
        ...unhandledEntry
      } = fixtureEntry;
        unhandledEntry satisfies Record<PropertyKey, never>;
        expect(affectedFileCount).toBeGreaterThan(0);
        await expect(readFile(path.join(process.cwd(), "src/00-storage/service/hizofs/v1-format-tests/fixtures", sourceFixture))).resolves.toBeDefined();
        break;
    }
    case "active_commit_fallback_recovery": {
      const {
        caseId: _caseId,
        corruptedRecordCount,
        expectedScenarioId: _expectedScenarioId,
        file: _file,
        kind: _kind,
        sha256: _sha256,
        ...unhandledEntry
      } = fixtureEntry;
        unhandledEntry satisfies Record<PropertyKey, never>;
        expect(corruptedRecordCount).toBeGreaterThan(0);
        break;
    }
    case "active_commit_segment_missing_fallback": {
      const {
        affectedFileCount,
        caseId: _caseId,
        expectedScenarioId: _expectedScenarioId,
        file: _file,
        kind: _kind,
        sha256: _sha256,
        sourceFixture,
        ...unhandledEntry
      } = fixtureEntry;
      unhandledEntry satisfies Record<PropertyKey, never>;
      expect(affectedFileCount).toBeGreaterThan(0);
      await expect(readFile(path.join(fixtureDirectory, sourceFixture))).resolves.toBeDefined();
      break;
    }
    default:
        kind satisfies never;
    }

    const raw = await readFile(path.join(fixtureDirectory, file));
    expect(createHash("sha256").update(raw).digest("hex")).toBe(sha256);
    validateFrozenPortableContainerFixture({ fixture: JSON.parse(raw.toString("utf8")) as unknown });
  }
});

it("keeps every frozen negative V1 fixture registered and byte-identical to its reviewed manifest hash", async () => {
  const manifest = negativeFixtureManifestSchema.parse(negativeFixtureManifestJson);
  const { fixtures, schema, schemaVersion, ...unhandledManifest } = manifest;
  unhandledManifest satisfies Record<PropertyKey, never>;
  expect(schema).toBe("hizofs-v1-negative-fixture-manifest");
  expect(schemaVersion).toBe(1);

  const fixtureDirectory = path.join(process.cwd(), "src/00-storage/service/hizofs/v1-format-tests/negative-fixtures");
  const actualFixtureFiles = (await readdir(fixtureDirectory))
    .filter(file => file.endsWith(".json") && file !== "manifest.json")
    .sort();
  expect(actualFixtureFiles).toEqual(fixtures.map(({ file }) => file).sort());

  for (const fixtureEntry of fixtures) {
    switch (fixtureEntry.kind) {
    case "corruption": {
      const {
        caseId,
        corruptedFileCount,
        expectedOutcome,
        file,
        kind: _kind,
        sha256,
        sourceFixture,
        ...unhandledEntry
      } = fixtureEntry;
      unhandledEntry satisfies Record<PropertyKey, never>;
      expect(caseId.length).toBeGreaterThan(0);
      expect(corruptedFileCount).toBeGreaterThan(0);
      expect(["reject_open", "reject_open_or_observation"]).toContain(expectedOutcome);
      await expect(readFile(path.join(process.cwd(), "src/00-storage/service/hizofs/v1-format-tests/fixtures", sourceFixture))).resolves.toBeDefined();
      const raw = await readFile(path.join(fixtureDirectory, file));
      expect(createHash("sha256").update(raw).digest("hex")).toBe(sha256);
      validateFrozenPortableContainerFixture({ fixture: JSON.parse(raw.toString("utf8")) as unknown });
      break;
    }
    case "authenticated_unsupported_feature": {
      const {
        caseId,
        expectedOutcome,
        file,
        kind: _kind,
        requiredFeatureBits,
        sha256,
        ...unhandledEntry
      } = fixtureEntry;
      unhandledEntry satisfies Record<PropertyKey, never>;
      expect(caseId.length).toBeGreaterThan(0);
      expect(expectedOutcome).toBe("unsupported_required_feature");
      expect(BigInt(requiredFeatureBits)).toBeGreaterThan(0n);
      const raw = await readFile(path.join(fixtureDirectory, file));
      expect(createHash("sha256").update(raw).digest("hex")).toBe(sha256);
      validateFrozenPortableContainerFixture({ fixture: JSON.parse(raw.toString("utf8")) as unknown });
      break;
    }
    case "missing_persisted_object": {
      const {
        caseId,
        expectedOutcome,
        file,
        kind: _kind,
        missingFileCount,
        sha256,
        sourceFixture,
        ...unhandledEntry
      } = fixtureEntry;
      unhandledEntry satisfies Record<PropertyKey, never>;
      expect(caseId.length).toBeGreaterThan(0);
      expect(expectedOutcome).toBe("reject_open");
      expect(missingFileCount).toBeGreaterThan(0);
      await expect(readFile(path.join(process.cwd(), "src/00-storage/service/hizofs/v1-format-tests/fixtures", sourceFixture))).resolves.toBeDefined();
      const raw = await readFile(path.join(fixtureDirectory, file));
      expect(createHash("sha256").update(raw).digest("hex")).toBe(sha256);
      validateFrozenPortableContainerFixture({ fixture: JSON.parse(raw.toString("utf8")) as unknown });
      break;
    }
    case "segment_path_misbinding": {
      const {
        caseId,
        expectedOutcome,
        file,
        kind: _kind,
        misboundFileCount,
        sha256,
        sourceFixture,
        ...unhandledEntry
      } = fixtureEntry;
      unhandledEntry satisfies Record<PropertyKey, never>;
      expect(caseId.length).toBeGreaterThan(0);
      expect(["reject_open", "reject_open_or_observation"]).toContain(expectedOutcome);
      expect(misboundFileCount).toBeGreaterThan(0);
      await expect(readFile(path.join(process.cwd(), "src/00-storage/service/hizofs/v1-format-tests/fixtures", sourceFixture))).resolves.toBeDefined();
      const raw = await readFile(path.join(fixtureDirectory, file));
      expect(createHash("sha256").update(raw).digest("hex")).toBe(sha256);
      validateFrozenPortableContainerFixture({ fixture: JSON.parse(raw.toString("utf8")) as unknown });
      break;
    }
    case "truncation": {
      const {
        caseId,
        expectedOutcome,
        file,
        kind: _kind,
        sha256,
        sourceFixture,
        truncatedByteLength,
        truncatedFileCount,
        ...unhandledEntry
      } = fixtureEntry;
      unhandledEntry satisfies Record<PropertyKey, never>;
      expect(caseId.length).toBeGreaterThan(0);
      expect(expectedOutcome).toBe("reject_open");
      expect(truncatedByteLength).toBeLessThan(80);
      expect(truncatedFileCount).toBeGreaterThan(0);
      await expect(readFile(path.join(process.cwd(), "src/00-storage/service/hizofs/v1-format-tests/fixtures", sourceFixture))).resolves.toBeDefined();
      const raw = await readFile(path.join(fixtureDirectory, file));
      expect(createHash("sha256").update(raw).digest("hex")).toBe(sha256);
      validateFrozenPortableContainerFixture({ fixture: JSON.parse(raw.toString("utf8")) as unknown });
      break;
    }
    default: fixtureEntry satisfies never;
    }
  }
});
