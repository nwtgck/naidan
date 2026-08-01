# HizoFS V1 independent fixture verifiers

These programs validate HizoFS V1 known-answer vectors without importing the
Naidan TypeScript implementation. They are release-validation foundations for
independent read-only readers, not a claim that full container traversal is
complete.

Both implementations use only their language standard library and verify:

- canonical crypto-context framing;
- HKDF-SHA-256 Root Key derivation;
- PBKDF2-HMAC-SHA-256 credential derivation;
- AES-256-GCM record encryption and authentication;
- Credential Slot Root Key wrapping;
- Unlock Authenticator generation;
- rejection when authenticated context bytes are changed;
- File System Commit decode and exact re-encode;
- Inode branch page decode and exact re-encode;
- File Extent leaf page decode and exact re-encode;
- Record Reference kind, alignment, range, and reserved-byte validation;
- canonical Unlock Envelope parsing and duplicate-copy authentication;
- passphrase Credential Slot Root Key unwrap and wrong-passphrase rejection;
- authenticated A/B Superblock decryption and newest-authority selection;
- metadata Segment Header authentication and active File System Commit decryption;
- root Inode Table leaf decoding and root directory Inode validation;
- a production-generated non-empty inline namespace leaf with file bytes, timestamps, directory targets, and a symlink;
- a fully encrypted production container with inline root and nested file extraction.

Run the targeted checks from the repository root:

```bash
node --test validation/hizofs-v1-independent-readers/node/verify-vectors.test.mjs
node --test validation/hizofs-v1-independent-readers/node/read-empty-container.test.mjs
node --test validation/hizofs-v1-independent-readers/node/read-root-inode.test.mjs
(cd validation/hizofs-v1-independent-readers/go && go test ./...)
```

The verifier fixture is the committed owner fixture at
`src/00-storage/service/hizofs/00-format/v1/test-fixtures/known-answer-vectors-v1.json`.
