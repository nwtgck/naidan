# HizoFS format version 1

The "Hizo" in HizoFS is derived from the Japanese word "hizo", meaning
"to put something valuable away for safekeeping." The name describes the
format's purpose without tying it to OPFS, a browser, or a specific backing
store implementation.

This document specifies the persistent format owned by `hizofs`.
Credential management, key slots, passphrase derivation, Naidan storage paths,
and encryption-transition state are outside this format.

A directory containing this format is exclusively owned by one HizoFS
file system. One backing directory contains exactly one logical root directory.

`filesystem.hizofs` is the canonical directory name used by Naidan when it
creates a backing directory. The name and `.hizofs` suffix are conventions for
humans and tools, not format-identification inputs. A reader must recognize the
format from its persisted descriptor and records, and the same bytes must remain
openable after the backing directory is renamed, moved, stripped of its suffix,
or given an unrelated suffix. The directory name is not part of key derivation,
AAD, or object addressing.

## Physical layout

```text
<backing-directory>/
├── descriptor.json
├── superblock-0.enc
├── superblock-1.enc          # absent until the second commit
└── objects/
    ├── 00/
    ├── 01/
    └── ...
```

Object shard directories are created lazily. Unknown physical entries are not
part of the format and must not be deleted automatically.

## Descriptor

`descriptor.json` is plaintext UTF-8 JSON terminated by a newline.

```ts
type HizoFSDescriptorDto = {
  readonly format: 'hizofs';
  readonly formatVersion: 1;
  readonly fileSystemId: string;
};
```

`fileSystemId` is canonical unpadded Base64URL encoding of 16 random bytes.
The descriptor is immutable after creation. An unknown `format` or
`formatVersion` must fail closed.

## Identifiers

Stable node and file-system identifiers contain 16 random bytes encoded as
canonical unpadded Base64URL.

Immutable object identifiers contain 32 random bytes encoded the same way.
Their physical path is:

```text
objects/<first-object-id-byte-as-lowercase-hex>/<object-id>.enc
```

Paths and logical names never participate in physical object names.

## Root key and object keys

The caller provides one 32-byte File System Root Key. HizoFS imports it
as HKDF key material. It does not persist or manage credentials or key slots.

For each object, an AES-256-GCM key is derived with HKDF-SHA-256:

```text
salt = UTF-8("HizoFS/v1/filesystem/" + fileSystemId)
info = UTF-8("HizoFS/v1/" + area + "/" + objectIdentity)
```

`area` is either `object` or `superblock`.

AES-GCM uses a fresh random 12-byte nonce and a 128-bit tag. Its additional
authenticated data is:

```text
UTF-8("HizoFS/v1/" + area + "/" + fileSystemId + "/" + objectIdentity)
```

For normal objects, `objectIdentity` is the immutable object ID. For
superblocks it is `superblock-0` or `superblock-1`. Moving ciphertext between
file systems, object IDs, areas, or superblock slots must fail authentication.

## Encrypted object envelope

All normal objects and both superblock slots use the same binary envelope.
Multi-byte integers are unsigned and big-endian.

| Offset | Length | Meaning |
| ---: | ---: | --- |
| 0 | 8 | Magic bytes `48 49 5a 4f 46 53 00 00` (`HIZOFS\0\0`) |
| 8 | 2 | Envelope version, currently `1` |
| 10 | 2 | Header byte length, currently `32` |
| 12 | 12 | AES-GCM nonce |
| 24 | 8 | Ciphertext byte length, including the 16-byte tag |
| 32 | variable | Ciphertext and tag |

The physical file length must equal `32 + ciphertextByteLength`. Unknown
envelope versions or header lengths must fail closed rather than falling back
to an older interpretation.

## Authenticated plaintext record

The decrypted envelope payload starts with a 16-byte record header.

| Offset | Length | Meaning |
| ---: | ---: | --- |
| 0 | 1 | Record kind ID |
| 1 | 1 | Payload encoding, currently `0` (`identity`) |
| 2 | 2 | Record version, currently `1` |
| 4 | 4 | Metadata JSON byte length |
| 8 | 8 | Raw binary payload byte length |
| 16 | variable | Fatal UTF-8 JSON metadata, then raw binary payload |

The complete plaintext length must exactly match both encoded lengths. Metadata
is JSON; binary file contents are not Base64 encoded.

Record kind IDs are fixed:

| ID | Kind |
| ---: | --- |
| 1 | `commit` |
| 2 | `inode_index_page` |
| 3 | `file_inode` |
| 4 | `directory_inode` |
| 5 | `symlink_inode` |
| 6 | `directory_index_page` |
| 7 | `file_extent_page` |
| 8 | `file_chunk` |
| 9 | `superblock` |

Unknown kinds, payload encodings, and record versions must fail closed.

## Superblocks

The two superblock slots contain encrypted `superblock` records.

```ts
type HizoFSSuperblockDto = {
  readonly sequence: number;
  readonly fileSystemId: string;
  readonly activeCommitObjectId: string;
};
```

The active slot is the valid slot with the greater non-negative safe-integer
`sequence`. Two valid slots with the same sequence are ambiguous corruption.
An unsupported record found in either slot must not be treated as an invalid
slot eligible for fallback.

A commit writes the next sequence to `sequence % 2`. The alternate slot remains
as the previous recoverable state.

## File-system commit

```ts
type HizoFSCommitDto = {
  readonly revision: number;
  readonly rootDirectoryNodeId: string;
  readonly inodeIndexRootObjectId: string;
};
```

A commit and all objects it references are immutable. The only persistent
visibility switch for normal mutations is the authenticated superblock slot.
Before that switch, the old complete commit is authoritative; after it, the
new complete commit is authoritative.

## Inode index

The inode index is a persistent Copy-on-Write B+tree mapping each stable
`nodeId` to the current immutable inode object ID. Leaf entries and branch
upper bounds are strictly ordered by UTF-8 byte lexicographic comparison of
the canonical identifier strings.

A valid active index contains the root directory node. Every inode referenced
by the index must have the same `nodeId` in its authenticated metadata.

## File inode

A file inode contains identity, revision, timestamps, logical `size`, and one
of two storage representations.

`inline` stores all file bytes as the raw binary payload of the same inode
record. `extents` stores `chunkSize` and a root object ID for a persistent
extent index. The implementation policy decides when to use either
representation; the selected representation is explicit and self-describing.

`size` is the user-visible file length, including sparse zero ranges.

## File extent index and chunks

The extent index is a persistent Copy-on-Write B+tree keyed by non-negative
integer `chunkIndex`. Missing indices represent sparse zero-filled ranges.
Each leaf extent references one immutable `file_chunk` object.

Chunk metadata contains the owning `nodeId` and `chunkIndex`; both must match
the extent and file inode. The raw binary payload may be shorter than
`chunkSize` when trailing bytes are zero, but must never be longer.

## Directory inode and index

A small directory stores its sorted entries inline in the inode metadata. A
larger directory references a persistent Copy-on-Write directory index.

Each entry contains exactly:

```ts
type HizoFSDirectoryEntryDto = {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly nodeId: string;
};
```

Names are neither trimmed nor Unicode-normalized. Invalid path components,
empty names, `.` and `..`, slash-containing names, duplicates, and unsorted
pages are rejected. Renaming or moving an entry does not change its node ID.

## Symlink inode

A symlink inode stores its stable node identity, revision, timestamps, and the
exact target string. HizoFS does not resolve the target while reading
metadata. Export to a backing file system without symlink support requires an
explicit caller policy and must not silently convert the link into a file.

## Mutation and concurrency model

Normal mutations prepare new immutable objects and then acquire the per-file-
system commit lock. Under that lock they reload the active state, verify the
base inode revision where required, write one new commit, and switch one
superblock slot.

An open writer batches writes, sparse updates, and truncates and performs at
most one file-system commit on `close()`. A conflicting changed inode causes
the writer to fail rather than silently apply last-writer-wins behavior.

Readers retain immutable inode and extent roots, providing snapshot reads while
a later commit is active.

## Maintenance and garbage collection

Every open HizoFS session holds a shared maintenance lease. Session
closure closes or aborts its child readers and writers before releasing that
lease. Garbage collection obtains the exclusive maintenance lease and thus
cannot run concurrently with any session snapshot.

GC marks from every valid A/B superblock commit through all inode-index pages,
inode objects, directory-index pages, extent pages, and chunks. Retaining both
valid generations preserves fallback after corruption of the newest slot. It
authenticates and validates all referenced objects before deleting anything. Only canonical object files
in their correct shard are eligible for deletion. Unknown physical entries are
left untouched and reported. Failure during mark performs no sweep.

Unreachable immutable objects are expected after successful Copy-on-Write
updates, aborted writers, or crashes before the superblock switch; their
presence is not itself corruption.

## Versioning

The descriptor format version, object envelope version, and each record version
are independent compatibility boundaries. Released readers remain available;
writers normally emit only the current version. Unknown incompatible versions
must never be interpreted as empty storage, partially rewritten, or silently
reduced to known fields.

Major format migration is performed by opening the old logical file system,
copying it to a new backing directory using a new writer, validating the target,
and switching authority outside HizoFS.
