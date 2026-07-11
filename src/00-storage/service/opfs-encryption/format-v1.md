# Naidan OPFS encryption format version 1

This document is the normative interoperability description for encrypted OPFS
stores written with `formatVersion: 1`. The TypeScript implementation and the
Node.js and Go recovery sources in `recovery/` must remain consistent with this
file.

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
    └── objects/<first-two-object-id-characters>/<object-id>.bin
```

The absence of `encryption-state/` means the existing plaintext OPFS layout is
active. Reading that absence must not create an encryption-related directory.

Both state and header use two JSON slots. The valid value with the largest
`sequence` is authoritative. Two valid slots with the same `sequence` are an
ambiguous control state and must be rejected. A transitioning state embeds its
complete operation journal in `state.operation`; there is no separate operation
file.

## JSON DTOs

The persisted JSON structures are defined by
`src/00-storage/00-dto/encryption.dto.ts`. They contain only JSON-compatible
values and describe structure rather than proving cryptographic usability.
Base64URL decoding, byte-length validation, key import, ID/path checks, and
cross-field semantic validation belong to mapper, codec, or service layers.

Existing Naidan DTOs remain unchanged. Their UTF-8 JSON bytes are encrypted as
independent objects.

## Passphrases

A passphrase is UTF-8 encoded exactly as entered. It is not trimmed and is not
Unicode-normalized. Line breaks are rejected. Leading and trailing whitespace
are valid and significant, but the UI warns the user before encryption begins.

## Key hierarchy

1. PBKDF2-HMAC-SHA-256 derives a 32-byte key-encryption key from a passphrase,
   its persisted 32-byte salt, and the persisted iteration count.
2. The passphrase key slot AES-256-GCM encrypts a random 32-byte Storage Unlock
   Key.
3. Every encrypted-store header AES-256-GCM encrypts that store's random
   32-byte root key with the Storage Unlock Key.
4. The store root key derives separate AES-GCM object-encryption and
   HMAC-SHA-256 object-address keys through HKDF-SHA-256. The UTF-8 store ID is
   the HKDF salt. Info strings are:
   - `naidan/opfs-encryption/object-encryption-key/v1`
   - `naidan/opfs-encryption/object-address-key/v1`

Wrapped keys use a random 12-byte nonce. Their persisted ciphertext is the
32 ciphertext bytes followed by the 16-byte AES-GCM authentication tag. AAD is
UTF-8 `naidan/opfs-encryption/wrapped-key/v1`.

## Base64URL

Binary values stored in JSON use unpadded RFC 4648 Base64URL. Decoders must
reject malformed encodings and unexpected decoded lengths before importing or
using keys and nonces.

## Object addressing

A locator consists of two strings: `namespace` and `key`. Each UTF-8 byte string
is prefixed by its unsigned 32-bit big-endian byte length:

```text
uint32_be namespace_length
namespace UTF-8 bytes
uint32_be key_length
key UTF-8 bytes
```

The physical object ID is unpadded Base64URL of the complete HMAC-SHA-256 output
over that canonical locator. The full 256-bit output is retained. The object is
stored at:

```text
objects/<object-id[0:2]>/<object-id>.bin
```

Format version 1 fixes this addressing algorithm. It is not represented as a
separately selectable DTO suite.

## Encrypted object file

```text
8 bytes   ASCII `NAIDAN01`
12 bytes  random AES-GCM nonce
remaining AES-256-GCM ciphertext followed by its 16-byte tag
```

AAD is UTF-8 `naidan/opfs-encryption/object/v1/<object-id>`.

The authenticated plaintext encrypted inside every object is framed as:

```text
8 bytes   ASCII `NPAYLD01`
1 byte    payload encoding (`0` = identity)
8 bytes   unsigned big-endian decoded plaintext byte length
remaining encoded payload bytes
```

Format version 1 writes encoding `0`. For identity payloads, the remaining byte
length must exactly equal the persisted decoded plaintext length. The framing
keeps payload transformation explicit so a later format can add an independently
selected compression encoding without inferring it from object type or filename.
A reader must reject unknown encodings and size mismatches after authentication.

The object file is replaced only after its writable stream closes successfully.
Every logical JSON object is encrypted independently. Objects from unrelated
logical records are never packed together.

## Logical locators

```text
singleton / settings
singleton / hierarchy
singleton / store_manifest
chat_meta / <chat-id>
chat_content / <chat-id>
chat_group / <chat-group-id>
chat_meta_shard_index / <two-character-shard-id>
chat_group_shard_index / <two-character-shard-id>
binary_shard_index / <two-character-shard-id>
volume_index / <two-character-shard-id>
file_manifest / <file-id>
file_chunk / <opaque-chunk-id>
directory_manifest / <directory-id>
directory_shard / <directory-id>/<shard-id>
```

`directory_entry / <directory-id>\0<entry-name>` is used only to derive the
opaque entry key and shard. It is not itself persisted as a separate object.

The encrypted store manifest records the existing chat metadata, chat group,
binary object, and volume shard IDs. Chat metadata and chat group shard objects
contain only logical IDs. They preserve DTOs that are not currently referenced
by the hierarchy without packing the DTO bodies together.

## Random-access files

A file manifest contains:

- logical file ID
- exact logical byte size
- logical chunk size
- modification time
- one nullable opaque chunk ID per logical chunk

A null chunk ID represents a sparse all-zero logical chunk. Non-null chunks are
independent `file_chunk` objects. A reader must authenticate and decrypt the
complete involved chunk before returning any requested subrange. Chunks from
different logical files are never mixed.

Version 1 stores chunk payloads with the object-frame `identity` encoding. A
future format may add another explicit encoding that compresses each logical
chunk before encryption; chunks remain independently authenticated and decoded.

## Encrypted filesystems

The store manifest identifies OPFS volumes and the `chat_wesh`, `debug_wesh`,
and `tmp` logical filesystems. Each has an opaque root directory ID.

A directory manifest lists `shardIds`. Each referenced encrypted directory
shard stores a JSON record whose values are file, directory, or symlink entries.
Original entry names exist only inside encrypted shard values. The record keys
are HMAC-derived opaque IDs based on the containing directory and original
entry name.

## Transitions

The operation type is one of `encrypting`, `decrypting`, or `reencrypting`.
Its phase is one of:

- `building_target`: source is authoritative; target may be rebuilt.
- `verifying_target`: source remains authoritative; target is complete and is
  being compared with the source.
- `cleaning_up_source`: target is authoritative; source cleanup may resume.

All application functionality is blocked while a transitioning state exists.
The source is not removed before complete target verification.

## Recovery

`recovery/naidan-recover.mjs` and `recovery/naidan-recover.go` reconstruct
the legacy plaintext storage layout and export encrypted virtual filesystems
from a raw OPFS copy. Both implementations stream encrypted file chunks to the
output instead of materializing complete files. The Go source also retains an
optional low-level object mode using `-namespace` and `-key` for independent
format inspection without Naidan.
