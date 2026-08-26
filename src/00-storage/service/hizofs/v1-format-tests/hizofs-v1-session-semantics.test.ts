import representativeFixtureJson from "./fixtures/representative-filesystem-v1.json";
import { expectedObservableState } from "./model/reference-filesystem-model";
import { historicalRepresentativeFilesystemScenario } from "./scenarios/representative-filesystem";
import { applyScenario, createWritableScenarioSession, openFreshReadOnlySession, observeObservableState } from "./support/hizofs-test-environment";
import { restoreFrozenPortableContainer, validateFrozenPortableContainerFixture } from "./support/portable-container";
import type { HizoFSV1FormatScenario } from "./scenarios/scenario-types";
import { expect, it } from "vitest";

it("keeps a frozen V1 container unchanged when a read-only session rejects namespace and file mutations", async () => {
  const fixture = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  const session = await openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
  });
  try {
    const docs = await session.root.getDirectoryHandle({ create: false, name: "docs" });
    const hello = await session.root.getFileHandle({ create: false, name: "hello.txt" });
    const mutationAttempts = Object.freeze([
      async () => await session.root.getFileHandle({ create: true, name: "new-file.txt" }),
      async () => await session.root.getDirectoryHandle({ create: true, name: "new-directory" }),
      async () => await session.root.createSymlink({ name: "new-link", target: "hello.txt" }),
      async () => await session.root.removeEntry({ name: "hello.txt", recursive: false }),
      async () => await session.root.moveEntry({
        destination: docs,
        name: "hello.txt",
        newName: "moved.txt",
        replace: false,
      }),
      async () => await session.root.cloneFile({
        destination: docs,
        name: "hello.txt",
        newName: "clone.txt",
        replace: false,
      }),
      async () => await hello.createWritable({ keepExistingData: true }),
    ]);
    for (const attempt of mutationAttempts) await expect(attempt()).rejects.toThrow();

    expect(await observeObservableState({ session })).toEqual(
      expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario }),
    );
  } finally {
    await session.close();
  }

  const reopened = await openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
  });
  try {
    expect(await observeObservableState({ session: reopened })).toEqual(
      expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario }),
    );
  } finally {
    await reopened.close();
  }
});

it("keeps one directory iterator on a stable generation across a later published mutation", async () => {
  const writable = await createWritableScenarioSession();
  const directory = await writable.session.root.getDirectoryHandle({ create: true, name: "paged" });
  const originalNames = Array.from({ length: 130 }, (_, index) => `entry-${index.toString().padStart(3, "0")}`);
  try {
    for (const name of originalNames) await directory.getFileHandle({ create: true, name });
    await writable.session.sync();

    const iterator = directory.entries()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);

    const addedAfterIteratorStarted = "zz-added-after-iterator-started";
    await directory.getFileHandle({ create: true, name: addedAfterIteratorStarted });
    await writable.session.sync();

    const iteratedNames: string[] = [];
    if (!first.done) iteratedNames.push(first.value[0]);
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      iteratedNames.push(next.value[0]);
    }
    expect(iteratedNames).toEqual(originalNames);

    const nextGenerationNames: string[] = [];
    for await (const [name] of directory.entries()) nextGenerationNames.push(name);
    expect(nextGenerationNames).toEqual([...originalNames, addedAfterIteratorStarted]);
  } finally {
    await writable.session.close();
  }

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: writable.fileSystemId,
    passphrase: writable.passphrase,
  });
  try {
    const reopened = await fresh.root.getDirectoryHandle({ create: false, name: "paged" });
    const names: string[] = [];
    for await (const [name] of reopened.entries()) names.push(name);
    expect(names).toEqual([...originalNames, "zz-added-after-iterator-started"]);
  } finally {
    await fresh.close();
  }
});

it("invalidates handles when a historical V1 session closes without affecting a later fresh reopen", async () => {
  const fixture = validateFrozenPortableContainerFixture({ fixture: representativeFixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  const session = await openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
  });
  const file = await session.root.getFileHandle({ create: false, name: "hello.txt" });
  const docs = await session.root.getDirectoryHandle({ create: false, name: "docs" });
  await session.close();

  await expect(file.stat()).rejects.toThrow();
  await expect(docs.getFileHandle({ create: false, name: "nested.txt" })).rejects.toThrow();
  await expect(session.root.getEntryHandle({ name: "hello.txt" })).rejects.toThrow();

  const reopened = await openFreshReadOnlySession({
    backend,
    expectedFileSystemId: fixture.fileSystemId,
    passphrase: fixture.passphrase,
  });
  try {
    expect(await observeObservableState({ session: reopened })).toEqual(
      expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario }),
    );
  } finally {
    await reopened.close();
  }
});


it("aborts an uncommitted writable when the session closes so staged bytes never reach persisted V1 state", async () => {
  const writable = await createWritableScenarioSession();
  await applyScenario({ scenario: historicalRepresentativeFilesystemScenario, session: writable.session });
  const file = await writable.session.root.getFileHandle({ create: false, name: "hello.txt" });
  const prepared = await file.createWritable({ keepExistingData: true });
  await prepared.write({ data: new TextEncoder().encode("must-not-survive-session-close"), position: 0 });
  await prepared.truncate({ size: 3 });

  await writable.session.close();
  await expect(prepared.write({ data: new Uint8Array([1]), position: 0 })).rejects.toThrow();

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: writable.fileSystemId,
    passphrase: writable.passphrase,
  });
  try {
    expect(await observeObservableState({ session: fresh })).toEqual(
      expectedObservableState({ scenario: historicalRepresentativeFilesystemScenario }),
    );
  } finally {
    await fresh.close();
  }
});

it("keeps an opened readable file on one stable generation while the writable session advances", async () => {
  const writable = await createWritableScenarioSession();
  const before = new TextEncoder().encode("before-readable-generation\n");
  const after = new TextEncoder().encode("after-readable-generation-with-a-different-size\n");
  let readable: Awaited<ReturnType<Awaited<ReturnType<typeof writable.session.root.getFileHandle>>["openReadable"]>> | undefined;
  try {
    await applyScenario({
      scenario: {
        id: "stable-readable-before-v1",
        operations: Object.freeze([
          { bytes: before, path: Object.freeze(["versioned.txt"]), type: "write_file" },
        ]),
      },
      session: writable.session,
    });
    await writable.session.sync();

    const file = await writable.session.root.getFileHandle({ create: false, name: "versioned.txt" });
    readable = await file.openReadable({ mimeType: "application/octet-stream" });

    const currentWriter = await file.createWritable({ keepExistingData: false });
    await currentWriter.write({ data: after, position: 0 });
    await currentWriter.close();
    await writable.session.sync();

    expect([...new Uint8Array(await new Response(readable.stream({ start: 0, end: undefined, signal: undefined })).arrayBuffer())])
      .toEqual([...before]);

    const nextReadable = await file.openReadable({ mimeType: "application/octet-stream" });
    try {
      expect([...new Uint8Array(await new Response(nextReadable.stream({ start: 0, end: undefined, signal: undefined })).arrayBuffer())])
        .toEqual([...after]);
    } finally {
      await nextReadable.close();
    }
  } finally {
    await readable?.close();
    await writable.session.close();
  }

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: writable.fileSystemId,
    passphrase: writable.passphrase,
  });
  try {
    const file = await fresh.root.getFileHandle({ create: false, name: "versioned.txt" });
    const reopened = await file.openReadable({ mimeType: "application/octet-stream" });
    try {
      expect([...new Uint8Array(await new Response(reopened.stream({ start: 0, end: undefined, signal: undefined })).arrayBuffer())])
        .toEqual([...after]);
    } finally {
      await reopened.close();
    }
  } finally {
    await fresh.close();
  }
});

it("pins a real application read snapshot to one published generation while the writable session advances", async () => {
  const initialScenario = {
    id: "application-read-snapshot-initial-v1",
    operations: Object.freeze([
      { bytes: new TextEncoder().encode("before"), path: Object.freeze(["version.txt"]), type: "write_file" },
    ]),
  } satisfies HizoFSV1FormatScenario;
  const advancedScenario = {
    id: "application-read-snapshot-advanced-v1",
    operations: Object.freeze([
      ...initialScenario.operations,
      { bytes: new TextEncoder().encode("after"), path: Object.freeze(["version.txt"]), type: "write_file" },
      { bytes: new TextEncoder().encode("new"), path: Object.freeze(["later.txt"]), type: "write_file" },
    ]),
  } satisfies HizoFSV1FormatScenario;

  const writable = await createWritableScenarioSession();
  let snapshot: Awaited<ReturnType<NonNullable<typeof writable.session.createReadSnapshot>>> | undefined;
  try {
    await applyScenario({ scenario: initialScenario, session: writable.session });
    await writable.session.sync();

    const createReadSnapshot = writable.session.createReadSnapshot;
    if (createReadSnapshot === undefined) throw new TypeError("expected HizoFS application read-snapshot support");
    snapshot = await createReadSnapshot.call(writable.session);

    await applyScenario({
      scenario: {
        id: "application-read-snapshot-later-mutations-v1",
        operations: advancedScenario.operations.slice(initialScenario.operations.length),
      },
      session: writable.session,
    });
    await writable.session.sync();

    expect(await observeObservableState({ session: snapshot })).toEqual(
      expectedObservableState({ scenario: initialScenario }),
    );
    expect(await observeObservableState({ session: writable.session })).toEqual(
      expectedObservableState({ scenario: advancedScenario }),
    );
    await expect(snapshot.root.getFileHandle({ create: true, name: "blocked.txt" })).rejects.toThrow();
  } finally {
    await snapshot?.close();
    await writable.session.close();
  }

  if (snapshot === undefined) throw new TypeError("expected HizoFS application read snapshot");
  await expect(snapshot.root.getEntryHandle({ name: "version.txt" })).rejects.toThrow();

  const fresh = await openFreshReadOnlySession({
    backend: writable.backend,
    expectedFileSystemId: writable.fileSystemId,
    passphrase: writable.passphrase,
  });
  try {
    expect(await observeObservableState({ session: fresh })).toEqual(
      expectedObservableState({ scenario: advancedScenario }),
    );
  } finally {
    await fresh.close();
  }
});
