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
├── head-0.hfs
├── head-1.hfs              # both slots exist from initial creation
├── segments/
│   ├── metadata/<shard>/<segment-id>.seg
│   └── data/<shard>/<segment-id>.seg
├── segment-indexes/
│   ├── metadata/<shard>/<segment-id>.idx
│   └── data/<shard>/<segment-id>.idx
└── maintenance/
    ├── relocation-0.hfs
    ├── relocation-1.hfs
    ├── gc-checkpoint-0.hfs
    └── gc-checkpoint-1.hfs
```

A directory containing this layout is exclusively owned by one HizoFS file
system. Segment shard directories are created lazily from the first eight bits
of the segment ID. Unknown physical entries are not part of the format and must
not be deleted automatically.

Metadata records prepared by one runtime publication are packed into one
append-only metadata segment. File chunks are packed into bounded private data
segments. The current writer policy targets 1 MiB of plaintext metadata and 16
MiB, or 64 default-size chunks, of plaintext file data per segment. These are
rotation policies rather than compatibility constants; every physical record is
self-describing and independently authenticated.


## Authenticated sealed-segment indexes

A sealed metadata or data segment may have a derived authenticated sidecar at
`segment-indexes/<type>/<shard>/<segment-id>.idx`. The index binds the file
system ID, segment type and ID, complete physical segment length, and the
ordered record kind, offset, and stored length of every frame. It is encrypted
and authenticated with a domain-separated key derived from the root key.

The sidecar is an acceleration and integrity aid, not the sole authority for
object existence. A missing index is reconstructed by authenticating the
segment header and scanning bounded frame headers. An invalid, stale, or
truncated index is reported and ignored; the segment is scanned independently.
A reconstructed index may be persisted only for a non-active segment. Segment
removal removes the corresponding sidecar first, and an absent sidecar never
makes a segment unsafe to read or reclaim.

## Descriptor

`descriptor.json` is plaintext UTF-8 JSON terminated by a newline.

```ts
type HizoFSDescriptorDto = {
  readonly format: 'hizofs';
  readonly formatVersion: 1;
};
```

The descriptor is only a non-secret format marker. It is not part of key
derivation and does not contain the file-system identity. After a complete
authenticated generation has been opened with the root key, a missing or
structurally corrupt descriptor may be replaced with this canonical value.
I/O and permission failures while reading or repairing it must still propagate.
An unsupported authenticated generation must never be made readable by
rewriting the descriptor.

## Identifiers and direct object references

Stable node identifiers contain 16 random bytes encoded as canonical unpadded
Base64URL. The file-system identifier is a stable 128-bit value derived from
the File System Root Key as specified below; it is not independently random or
persisted in the descriptor.

Each segment ID contains 16 cryptographically random bytes. A logical object
reference is the canonical unpadded Base64URL encoding of this fixed 32-byte
binary value:

| Offset | Length | Meaning |
| ---: | ---: | --- |
| 0 | 16 | Home segment ID |
| 16 | 8 | Home byte offset, unsigned big-endian |
| 24 | 4 | Complete stored frame length, unsigned big-endian |
| 28 | 1 | Record kind ID |
| 29 | 3 | Zero reserved bytes |

The encoded reference is exactly 43 characters. The stored length permits one
exact range read without first reading a separate header. The frame repeats
and authenticates the segment ID, offset, length, and kind; values in the
reference are never trusted without that comparison.

The home reference is a logical identity. Normal records remain at their home
location and require no relocation lookup beyond the empty-map fast path.
Partial-segment compaction may publish a chain-free relocation mapping for a
moved home reference. Every persisted mapping points directly to the current
canonical frame, preserves the record kind, rejects cycles and self-maps, and
is authenticated in redundant A/B maintenance slots. Physical offsets are
intentionally excluded from record key derivation beyond the authenticated
logical home reference.

## Root key and segmented keys

The caller provides one 32-byte File System Root Key. HizoFS imports it as HKDF
key material. It does not persist or manage credentials or key slots.

The stable `fileSystemId` is canonical unpadded Base64URL encoding of the first
128 bits derived with HKDF-SHA-256:

```text
salt = UTF-8("HizoFS/v1/filesystem-id/salt")
info = UTF-8("HizoFS/v1/filesystem-id")
```

A root key must not be reused for two independent HizoFS instances.

A segment-record AES-256-GCM key is derived once per logical home segment. The
salt is domain-separated and includes the decoded file-system ID; the HKDF info
includes the home segment ID. Every record uses a fresh random 12-byte nonce
and a 128-bit tag. Record AAD includes a format domain, the file-system ID, and
the complete 72-byte record header. Consequently moving a frame to another
logical reference, record kind, file system, or home segment fails
authentication, while a future compactor may copy the authenticated frame and
retain its logical home reference without re-encryption.

Segment headers use a separately derived key scoped to the physical segment ID.
Their authentication is a zero-length AES-GCM plaintext with a deterministic
all-zero nonce. This nonce is used once under each independently derived
segment-header key. Head slots use separate slot-scoped keys and fresh random
nonces.

## Segment header

Every `.seg` file starts with a fixed 64-byte authenticated header:

| Offset | Length | Meaning |
| ---: | ---: | --- |
| 0 | 8 | ASCII magic `HZSEG001` |
| 8 | 2 | Format version, currently `1` |
| 10 | 2 | Header length, currently `64` |
| 12 | 1 | Segment type: metadata, data, or relocation |
| 13 | 3 | Zero reserved bytes |
| 16 | 16 | Decoded file-system ID |
| 32 | 16 | Segment ID |
| 48 | 16 | AES-GCM authentication tag over bytes 0..47 |

The segment ID must match both the physical filename and shard. Segment type
must match the kind of every contained record.

## Authenticated record frame

Each immutable logical object is one independently authenticated aligned frame.
Multi-byte integers are unsigned and big-endian.

| Offset | Length | Meaning |
| ---: | ---: | --- |
| 0 | 8 | ASCII magic `HZREC001` |
| 8 | 2 | Format version, currently `1` |
| 10 | 2 | Header length, currently `72` |
| 12 | 4 | Zero reserved bytes |
| 16 | 8 | Complete aligned frame length |
| 24 | 8 | Plaintext record length |
| 32 | 16 | Logical home segment ID |
| 48 | 8 | Logical home byte offset |
| 56 | 12 | Random AES-GCM nonce |
| 68 | 1 | Record kind ID |
| 69 | 3 | Zero reserved bytes |
| 72 | variable | Ciphertext, 16-byte tag, then zero alignment padding |

Frames are aligned to eight bytes. The physical segment may be scanned using
only fixed frame headers; garbage collection does not need to read file-chunk
ciphertext merely to enumerate logical object references. Record authentication
isolates a corrupt frame from neighbouring frames, so an invalid newest commit
can fall back to the older A/B generation even when both records share one
segment. Losing or replacing an entire segment remains a bounded multi-record
fault and may affect records shared by both retained generations; A/B head
publication is not physical replication of every immutable metadata record.

## Authenticated A/B head envelope

`head-0.hfs` and `head-1.hfs` are fixed-slot mutable publications, not segment
records. Each begins with a 32-byte envelope header:

| Offset | Length | Meaning |
| ---: | ---: | --- |
| 0 | 8 | ASCII magic `HZHED001` |
| 8 | 2 | Format version, currently `1` |
| 10 | 2 | Header length, currently `32` |
| 12 | 12 | Random AES-GCM nonce |
| 24 | 4 | Ciphertext length including the tag |
| 28 | 4 | Zero reserved bytes |

The authenticated plaintext contains the decoded file-system ID, active
metadata segment ID, durable metadata tail, encoded superblock-record length,
and the encoded `superblock` record. A head may reference only records fully
inside its authenticated durable tail. Data segments are flushed before the
metadata segment, and the metadata segment is flushed before the alternate
head slot is replaced and flushed.

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

The two authenticated head slots contain encoded `superblock` records and the durable metadata anchor needed to interpret that generation.

```ts
type HizoFSSuperblockDto = {
  readonly sequence: number;
  readonly fileSystemId: string;
  readonly activeCommitObjectId: string;
};
```

Candidates are ordered by descending non-negative safe-integer `sequence`.
Two valid slots with the same sequence are ambiguous corruption. For each
candidate, the reader authenticates and validates the referenced commit, inode
index root, and root directory inode before selecting it. If the newest
candidate is structurally corrupt but the older generation is complete, the
older generation may be opened only in `fallback_read_only` recovery mode. A
valid generation is also treated as fallback when the other physical slot is
unreadable, because its sequence cannot be proven older. Normal mutations,
bulk construction, and garbage collection are forbidden in that mode so an
uncertain rollback cannot be published or swept. An unsupported record found
in a newer slot must fail closed rather than being treated as an invalid slot
eligible for fallback.

Creation writes the same initial commit to both slots with sequences `0` and
`1`, so a stable filesystem never depends on one initially missing slot. A
later commit writes the next sequence to `sequence % 2`; the alternate slot
remains as the previous recoverable state. A missing slot in an opened
filesystem is therefore an uncertain rollback and forces read-only recovery.

## File-system commit

```ts
type HizoFSCommitDto = {
  readonly revision: number;
  readonly publicationId: string;
  readonly rootDirectoryNodeId: string;
  readonly inodeIndexRootObjectId: string;
};
```

A commit and all objects it references are immutable. `publicationId` is a
fresh stable identifier for one attempted durable publication. If a leader
fails after flushing the head but before replying, its successor can recognize
that publication while it remains the active generation. If later generations
have already replaced it, the coordinator reports an indeterminate publication
outcome rather than silently replaying a potentially non-idempotent operation.

The only persistent visibility switch for normal mutations is the authenticated
superblock slot. Before that switch, the old complete commit is authoritative;
after it, the new complete commit is authoritative.

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

Chunk metadata is the empty JSON object. Ownership and logical position belong
to the authenticated extent leaf that references the object, which allows two
file inodes to share an extent tree for whole-file reflink. The raw binary
payload may be shorter than `chunkSize` when trailing bytes are zero, but must
never be longer.

## Whole-file clone

A whole-file clone always creates a new stable `nodeId` and a new file inode.
An inline file copies its bytes into the new inode. An extent-backed file reuses
the same immutable extent-index root, pages, and chunk objects. Later writes or
truncates create replacement chunks and Copy-on-Write index pages only for the
changed clone; the other file retains its original immutable graph.

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

Names are neither trimmed nor Unicode-normalized. They must be well-formed
Unicode scalar sequences and encode to at most 4 KiB of UTF-8. Invalid path
components, empty names, `.` and `..`, slash-containing names, duplicates, and
unsorted pages are rejected. Renaming or moving an entry does not change its
node ID.

## Symlink inode

A symlink inode stores its stable node identity, revision, timestamps, and the
exact target string. The target must be well-formed Unicode and encode to at
most 64 KiB of UTF-8. HizoFS does not resolve the target while reading metadata.
Export to a backing file system without symlink support requires an explicit
caller policy and must not silently convert the link into a file.

## Mutation and concurrency model

Normal mutations load a base commit and prepare new immutable objects outside
the per-file-system commit lock. Under that lock they reload the active state,
verify that the base commit is still current, write one new commit into the
runtime-owned active metadata segment, flush every referenced data segment and
the metadata durable tail, and switch one head slot. Each runtime creates fresh
random segment IDs and never reopens another runtime's active append tail, so it
may retain its own bounded random-access segment handles across publications
without allowing independent tabs to allocate the same offset. Head files are
still reopened for each publication because those two mutable slots are shared
by every runtime. If another writer published first, preparation is retried
against the new base. Objects prepared by a losing attempt become ordinary GC
candidates.

An open writer batches writes, sparse updates, and truncates and performs at
most one file-system commit on `close()`. A byte-bounded dirty-chunk cache
coalesces repeated writes to the same logical chunk. When the final extent tree
is completely determined by prepared chunks, it is built bottom-up once rather
than publishing intermediate Copy-on-Write pages for every extent. Independent chunk frames are encrypted and appended to bounded data segments with explicit bounded concurrency;
the maintenance lease remains held until every scheduled write has either
completed or failed. These are runtime policies and do not change the persistent
format. A conflicting changed inode causes the writer to fail rather than
silently apply last-writer-wins behavior. Dirty plaintext buffers are overwritten
as they are flushed, discarded by truncation, aborted, or released after close.

Authenticated immutable objects may be retained in byte- and entry-bounded
plaintext LRU caches. Metadata and file chunks have separate budgets so
sequential file data cannot evict the entire metadata working set, while the
entry limits also bound Map overhead for many small records. Superblock slots
are mutable and are never cached; every active-generation selection
authenticates their current physical contents. Evicted plaintext buffers are
overwritten before release.
Closing any session sharing a runtime also clears these caches explicitly; a
remaining session can repopulate them only by authenticating the immutable
physical objects again.

Readers retain immutable inode and extent roots, providing snapshot reads while
a later commit is active. Runtime backing stores retain resolved directory and
bounded active segment handles and deduplicate concurrent resolutions.
Exact-range segment reads also retain a bounded LRU of immutable `File`
snapshots. A cached snapshot is reused only when it already contains the whole
requested range; an append beyond its captured size forces a fresh snapshot,
so previously published frame bytes remain reusable without hiding a later
append. Same-store replacement and removal invalidate the corresponding
snapshot entry. An active metadata or data segment is retained only until
payload rotation, physical failure, explicit handle release, or runtime close;
sealed older segments are read through exact immutable ranges. Multiple
inode-index changes belonging to one mutation traverse and rewrite each affected
Copy-on-Write path once.

## Bulk construction

A newly created, unpublished target may be populated through the HizoFS bulk
builder. It streams file contents into authenticated chunk frames, builds directory,
extent, and inode indexes bottom-up, and publishes the complete imported tree
with one file-system commit. It is used for encryption and re-encryption
transitions so file and directory counts do not multiply superblock commits.
Independent inode and directory-object writes are queued with the same bounded
immutable-write concurrency used by file chunks. Commit and abort both wait for
every scheduled write to settle before releasing the maintenance resource
lease. Failure before publication leaves only unreachable segment records in
a target that the transition coordinator may discard.

## Maintenance and garbage collection

Idle HizoFS sessions do not hold a maintenance lease. A shared resource lease
is held only while an active read operation or traversal, reader, writer, fixed
read snapshot, mutation, or inspector can reference immutable objects. Garbage
collection first serializes collectors with a separate GC job lease, then
obtains the exclusive maintenance lease long enough to drain active resources,
snapshot every valid retained commit, and list the physical object IDs that
exist at the fence. The foreground-blocking lease is released before metadata
marking and chunk authentication. Object IDs are never reused, newly created
objects are absent from the fenced physical listing, and later mutations can
reference only a retained generation or objects created after the fence, so an
object found unreachable from the snapped roots cannot become reachable later.

GC first selects bounded partial-live compaction candidates whose dead bytes
exceed the configured threshold and whose live bytes fit the relocation memory
bound. One candidate is processed under an exclusive maintenance slice: live
records are authenticated and copied to new immutable frames, those frames are
flushed, the complete chain-free relocation map is published to both A/B slots,
and only then is the source segment removed if its physical length is unchanged.
A crash before publication leaves unreachable copies; a crash after publication
leaves either the old segment or the new canonical frames readable. A changed
source segment is retained for a later cycle.

Whole-dead sweep removes only segments for which every enumerated record is
unreachable from both retained generations. Because a runtime may retain and
append to its own active segment after candidate construction, sweep revalidates
the segment byte length while holding the exclusive maintenance lease. One
physical remove may reclaim many logical objects. Compaction and sweep reacquire
the exclusive lease only for bounded slices. Every started copy, publication,
or remove settles before the lease is released, and GC yields between slices so
queued foreground resources can progress.

Progress is authenticated in redundant GC checkpoint slots. A resumed
invocation always performs a fresh authenticated mark and rebuilds candidates;
the checkpoint never substitutes stale reachability data. When the active commit
matches, cumulative completed-candidate and reclaimed-object counters are
retained. A changed root discards stale progress. Successful completion removes
both checkpoint slots; interruption leaves them for diagnosis and resumption.

GC marks from every valid A/B superblock commit. For each generation it
validates the persistent inode, directory, and extent indexes, then traverses
the namespace from the root directory. Every non-root inode must be reachable
from exactly one directory entry, entry kinds must match inode kinds, and the
set of namespace nodes must equal the set stored in the inode index. Cycles,
duplicate parents, dangling entries, and disconnected inode-index entries stop
the mark phase before deletion.

Shared extent pages and chunk objects are authenticated and traversed once by
object ID even when many reflinked inodes reference the same graph. Retaining
both valid generations preserves fallback after corruption of the newest slot.
Only authenticated canonical segment files in their correct type directory and shard are eligible for deletion.
Unknown physical entries are left untouched and reported. Failure during mark
performs no sweep.

Unreachable segment records are expected after successful Copy-on-Write
updates, aborted writers, or crashes before the head switch; their
presence is not itself corruption.

## Versioning

The descriptor format version, segment/header/frame versions, and each record version are independent compatibility boundaries. Released readers remain available;
writers normally emit only the current version. Unknown incompatible encrypted
versions must never be interpreted as empty storage or partially rewritten.
Raw inspection preserves exact persisted metadata even when a DTO parser uses
only its known fields. Repairing the non-secret descriptor does not change or
reinterpret any encrypted generation.

This format has not been released. The former development-only object-per-file
layout is not a compatibility boundary and is intentionally neither opened nor
migrated by the current implementation.
