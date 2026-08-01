import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { verifyPortableActiveCommit } from "./read-active-commit.mjs";
const fixturePath=fileURLToPath(new URL("../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json",import.meta.url));
test("independently authenticates the metadata Segment and active Commit",async()=>{assert.deepEqual(await verifyPortableActiveCommit({fixturePath}),{activeCommitSequence:"1",nextInodeNumber:"2",nextSubvolumeId:"2",rootDirectoryInodeNumber:"1",rootInodeTableFrameLength:112,rootInodeTableOffset:"64",rootInodeTableSegmentId:"7f808182838485868788898a8b8c8d8e",segmentBytes:368,segmentHeaderAuthenticated:true});});
