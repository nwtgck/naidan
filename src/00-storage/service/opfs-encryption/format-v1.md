# Naidan OPFS encryption format version 1

This document is the normative interoperability description for encrypted OPFS
stores written with `formatVersion: 1`. The browser implementation and both
recovery sources under `recovery/` must remain byte-for-byte compatible with
this specification.

## Scope and compatibility

Format version 1 defines the complete storage protocol: control state, key
hierarchy, object addressing, object framing, application catalog, virtual
filesystem records, transaction journals, and transition authority rules.
Algorithm fields are not persisted separately when they are fixed by this
format.

Naidan supports upgrading older data into newer releases. Downgrading a store
written by a newer Naidan is best effort and is not a compatibility guarantee.
Readers must never silently reinterpret a newer unsupported format as an older
slot.

## Physical layout

```text
/naidan-storage/
├── encryption-state/
│   ├── state-0.json
│   └── state-1.json
└── encrypted-stores/<store-id>/
    ├── header/
    │   ├── header-0.json
    │   └── header-1.json
    ├── objects/<two-digit-hex-shard>/<object-id>.enc
    └── temporary-objects/<two-digit-hex-shard>/<object-id>.enc
```

The absence of `encryption-state/` means the existing plaintext OPFS layout is
active. Merely inspecting a plaintext store must not create an encryption
folder.

`objects/` is durable. `temporary-objects/` uses the same cryptographic format
but contains disposable filesystems such as `system/tmp`; transition code does
not copy it and a missing temporary filesystem may be recreated empty. Corruption
is not interpreted as absence: authentication or schema failure must fail closed
until an explicit temporary-area reset discards the affected data.

State and header use two JSON slots. First read each slot as a minimal
`formatVersion`/`sequence` envelope. A complete slot with the greatest sequence
is authoritative. If the greatest complete slot has an unsupported format,
reading stops with an unsupported-format error; an older supported slot must
not be selected. Two valid slots with the same sequence are ambiguous and must
be rejected.

## JSON DTO boundary

Persisted structures are defined in
`src/00-storage/00-dto/encryption.dto.ts`. DTO schemas describe JSON structure.
Base64URL decoding, byte lengths, safe-integer ranges, ID/path rules, referential
integrity, and cross-object invariants are validated by service and codec code.

Existing released Naidan DTOs are not changed by this format. Their UTF-8 JSON
representations are encrypted as independent objects.

## Passphrase and key slots

A passphrase is UTF-8 encoded exactly as entered. It is not trimmed and is not
Unicode-normalized. Line breaks are rejected. Boundary whitespace is valid and
significant, although the UI warns about it.

The control state stores between 1 and 32 `keySlots`. The upper bound prevents a
malformed state from forcing an unbounded number of expensive KDF attempts. A
slot has a stable `id`, a key-derivation descriptor, and one wrapped Storage
Unlock Key. Version 1 supports `pbkdf2_sha256`:

```text
keyDerivation.type = "pbkdf2_sha256"
keyDerivation.salt = unpadded Base64URL
keyDerivation.iterations = integer in the inclusive range 1..10,000,000
```

The persisted slot is not intrinsically a “passphrase slot”. The caller supplies
secret bytes; the initial UI supplies exact UTF-8 passphrase bytes. A future
key-file or passkey integration may supply or reference other secret material
without changing the Storage Unlock Key hierarchy.

## Key hierarchy

1. PBKDF2-HMAC-SHA-256 derives a 32-byte key-encryption key from input secret
   bytes, the slot's 32-byte salt, and its iteration count.
2. That key AES-256-GCM unwraps a random 32-byte Storage Unlock Key (SUK).
3. Each encrypted-store header wraps a random 32-byte Store Root Key with the
   SUK.
4. HKDF-SHA-256 derives independent runtime keys from the Store Root Key. The
   UTF-8 encrypted store ID is the HKDF salt. Info strings are:
   - `naidan/opfs-encryption/object-encryption-key/v1`
   - `naidan/opfs-encryption/object-address-key/v1`

Wrapped keys use a random 12-byte nonce and contain 32 ciphertext bytes followed
by the 16-byte AES-GCM tag. AAD binds the wrapped key to its role and identity:

```text
naidan/opfs-encryption/storage-unlock-key/v1/<slot-id>
naidan/opfs-encryption/store-root-key/v1/<store-id>
```

Changing a passphrase replaces only the selected key slot. Re-encryption creates
a new encrypted store and Store Root Key while preserving the current key-slot
set.

## Base64URL

Binary JSON fields use unpadded RFC 4648 Base64URL. Readers reject malformed
input and unexpected decoded lengths before importing or using keys and nonces.

## Canonical locator and object address

A logical locator is `{ namespace, key }`. Its canonical byte sequence is:

```text
uint32_be namespace_utf8_length
namespace UTF-8 bytes
uint32_be key_utf8_length
key UTF-8 bytes
```

The object address is the full HMAC-SHA-256 result over those bytes using the
object-address key.

```text
object-id = unpadded Base64URL(HMAC-SHA-256(...))
shard-id  = lowercase two-digit hex of HMAC byte 0
```

The shard is not derived from logical IDs or Base64URL text, so it remains
uniform for arbitrary imported identifiers.

## Encrypted object framing

Every durable and temporary object has this outer framing:

```text
8 bytes   fixed magic: 4e 41 49 4f 42 4a 00 00 (`NAIOBJ\0\0`)
2 bytes   unsigned big-endian object format version (`1`)
2 bytes   unsigned big-endian header byte length (`24`)
12 bytes  random AES-GCM nonce
remaining AES-256-GCM ciphertext followed by its 16-byte tag
```

AAD is:

```text
naidan/opfs-encryption/object/v1/<area>/<object-id>
```

where `<area>` is `durable` or `temporary`. Moving ciphertext between an area or
object address therefore fails authentication.

The authenticated plaintext frame is:

```text
1 byte    payload-frame version (`1`)
1 byte    payload encoding (`0` = identity)
8 bytes   unsigned big-endian decoded byte length
remaining encoded payload bytes
```

Identity payload length must equal the declared decoded length. Future payload
encodings require a new format decision; readers never infer compression from
object kind or filename.

An object replacement is committed when its OPFS writable stream closes
successfully. If `close()` rejects after OPFS has already installed the requested
replacement, an implementation may treat the write as committed only after an
exact byte-for-byte read-back proves that the complete requested physical object
is durable. Unrelated logical records are never packed together.

## Naidan application catalog

The encrypted singleton `singleton/store_manifest` contains a list of typed
collections:

```text
chat_meta
chat_group
binary_object
volume
```

Each collection records only its non-empty two-digit shard IDs. Collection
members remain independent encrypted objects. This catalog is Naidan-specific;
the lower object and virtual-filesystem layers are not.

The manifest contains each version-1 collection exactly once. Collection types,
shard IDs, and shard membership are validated before use. A shard ID referenced
by the manifest makes its corresponding collection index mandatory; readers and
independent recovery tools must not reinterpret a missing or malformed index as
an empty shard.

Membership shard selection uses the first byte of:

```text
HMAC(address-key, locator("collection_member/<type>", logical-id))
```

Chat and Chat Group indices contain logical IDs. Binary indices map each binary
object ID to its released `BinaryObjectDto` metadata and an immutable encrypted
file generation ID. Volume indices retain the released volume DTO.

## Generic encrypted virtual filesystems

A filesystem is opened by an arbitrary logical `fileSystemId`. Its descriptor is
stored at:

```text
file_system_descriptor / <filesystem-id>
```

and contains the logical filesystem ID, a stable root directory ID, and its
creation time. It has no independent format version: the active encrypted-store
format defines all objects reachable from that store. The encryption layer does
not persist Naidan-specific variants such as `chat_wesh` or `opfs_volume`.
Naidan chooses IDs at the application boundary, currently including:

```text
system/chat-wesh
durable

system/debug-wesh
durable

system/tmp
temporary

volume/<volume-id>
durable
```

Additional encrypted filesystems can be issued without changing the persisted
DTO union.

Stable file and directory IDs are inode-like identities. Renaming or moving an
entry changes directory records but does not rewrite its file content.

### Directory records

A directory manifest contains its stable ID, monotonic revision, nullable
creation time, modification time, and references to immutable shard generations:

```text
directory_manifest / <directory-id>
directory_shard    / <opaque-shard-generation-id>
```

Each manifest shard reference has a two-digit logical shard ID and an opaque
object ID. A shard object repeats those identities and stores a JSON record of
file, directory, and symlink entries. Original names and symlink targets exist
only inside encrypted objects.

The entry record key is the HMAC-derived object ID for the non-persisted locator:

```text
directory_entry / <directory-id> NUL <entry-name>
```

New shard generations are written before the directory manifest switches its
references. Unreferenced generations are cleanup candidates and cannot later
become visible merely because the same logical shard is edited again.

### File records and random access

A file manifest contains:

- stable file ID
- monotonic revision
- byte size exposed by reads and `stat`
- plaintext bytes represented by one chunk
- chunk references represented by one chunk-map page
- ordered opaque chunk-map page IDs
- nullable creation time and modification time

Locators are:

```text
file_manifest        / <file-id>
file_chunk_map_page  / <opaque-page-id>
file_chunk           / <opaque-chunk-id>
```

A chunk-map page records its file ID, page index, and nullable chunk IDs. `null`
represents a sparse all-zero chunk. Version 1 defaults to 1 MiB chunks and 1024
chunk references per page. Random reads authenticate only the required map pages
and chunks. Compression, if later introduced, remains per chunk so random access
is preserved.

Each file update prepares immutable chunks and chunk-map pages, then uses the
file-scoped encrypted WAL to replace the single manifest pointer. The manifest
replacement is the visible commit. File mutations for the same manifest address
are serialized across tabs. Every open reader acquires a shared file-history
lease before the file mutation lock is released. Post-commit cleanup makes a
non-blocking attempt to acquire that history lease exclusively; it never queues
behind open readers and therefore never delays a later open or write. A failed
attempt leaves unreachable encrypted objects for a later handle close, mutation,
or integrity-repair pass to collect. Cleanup excludes chunks and map pages still
referenced by the current manifest, while all older open readers retain their
snapshot until `close()`.

Binary objects write a new immutable file generation, then atomically switch the
binary index entry. Failure after generation preparation leaves an unreachable
object; it never changes the visible old binary payload.

### Filesystem metadata and capabilities

Version 1 persists file and directory creation/modification timestamps and file
size. `createdAt` is `null` when a source such as native OPFS exposes no reliable
creation time; an implementation must not substitute modification time and
pretend it is creation time. Stable IDs supply identity. Runtime adapters may
synthesize platform-only fields such as Unix mode, UID, GID, or numeric inode
until a persisted semantic is intentionally defined. The virtual filesystem
supports directory enumeration, random read/write, append, truncate, sparse zero
ranges, symlinks, rename, and cross-directory move even where native OPFS lacks
equivalent convenience APIs.

Absolute symlink targets are resolved from the encrypted filesystem root;
relative targets are resolved from the directory containing the link.
Intermediate directory symlinks are followed for path operations, while APIs
such as `lstat`, `readlink`, unlink, and rename can operate on the final symlink
entry itself. Implementations reject resolution after 40 followed links. A
directory move also compares stable directory identities, rather than relying
only on textual path prefixes, so a symlink alias cannot move a directory into
its own descendant.

An opened Wesh file handle binds to the stable file ID resolved at open time.
Renaming or moving the directory entry therefore does not invalidate the open
handle or redirect it to a later entry which reuses the old path.

## Atomic multi-object mutation

A single encrypted object replacement uses OPFS stream close as its commit
boundary, with the exact-read-back rule above for an ambiguous close result. A
logical operation that updates multiple objects uses an encrypted roll-forward
write-ahead log (WAL):

```text
object_transaction_journal / <scope-id>
```

The journal stores an operation ID, scope ID, and an ordered list of complete
write/delete operations. A write operation names its encoded bytes explicitly
as `plaintextBase64Url`. The WAL needs no separate phase or sequence: the
presence of the authenticated journal is the durable logical commit, and its
removal marks completion of materialization. The mutation protocol is:

1. acquire the scope's exclusive Web Lock;
2. recover and remove any existing journal;
3. prepare immutable target generations;
4. persist the complete encrypted journal, which commits the logical mutation;
5. replay all idempotent writes/deletes in order;
6. remove the journal, which marks completion of materialization;
7. best-effort cleanup unreachable old generations only after materialization;
8. release the lock.

Readers take a shared lock and check for a pending WAL under that same lease. If
a journal exists, they release the shared lease, recover it under the exclusive
lock, and retry the combined check-and-read. Therefore no API observer sees a
half-applied `mkdir`, rename/move, index update, or directory generation switch.
A crash after journal persistence rolls forward on next access. Once an exact,
authenticated journal is known to be durable, a later materialization error must
not be reported as an uncommitted mutation that callers should retry; the WAL is
left pending and subsequent access completes it. A crash before journal
persistence leaves only unreachable prepared objects.

Filesystem WAL scope is the root directory ID. File content/metadata updates use
`file/<file-id>` scopes whose lock names are derived from the store-specific
manifest object address. The Naidan application catalog uses its encrypted store
ID scope. The local in-process shared/exclusive lock fallback is for test or
unavailable-Web-Locks environments; normal OPFS multi-tab correctness uses Web
Locks.

## Transition state

Transition operation types are `encrypting`, `decrypting`, and `reencrypting`.
Persisted phases are:

- `building_target`: source is authoritative; copy and complete verification
  happen before leaving this phase. A failed normal execution discards the
  target and restores stable source state.
- `cleaning_up_source`: the target has been committed and is authoritative;
  only source cleanup may resume.

All Naidan features are blocked during a transition. Durable data is verified
before authority changes. Temporary filesystems are recreated rather than copied.

## Recovery and inspection

`recovery/naidan-recover.mjs` and `recovery/naidan-recover.go` use a known
passphrase to reconstruct released plaintext Naidan DTOs and export encrypted
virtual filesystems without importing Naidan application code. Large files are
written page/chunk at a time. Recovery validates the same mandatory collection
and index relationships as the browser implementation, and rejects persisted
logical IDs or filesystem names that could escape the selected output directory.
It must fail rather than silently emit a partial store when a referenced index,
manifest, page, or chunk is missing or malformed.

The in-app Encrypted Storage Inspector receives only short-lived non-extractable
runtime CryptoKeys and OPFS handles. Its Worker can navigate logical locators,
physical addresses, framing, decrypted DTOs, filesystem relations, WAL state,
and reachability without blocking the UI thread. It never persists or displays
raw wrapping/root key bytes.
