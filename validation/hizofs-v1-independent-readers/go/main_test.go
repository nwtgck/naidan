package main

import (
	"bytes"
	"encoding/binary"
	"path/filepath"
	"testing"
)

func TestVerifyKnownAnswerVectors(t *testing.T) {
	result, err := verifyKnownAnswerVectors(filepath.Join(
		"..", "..", "..", "src", "00-storage", "service", "hizofs", "00-format", "v1", "test-fixtures", "known-answer-vectors-v1.json",
	))
	if err != nil {
		t.Fatalf("verify known-answer vectors: %v", err)
	}
	if result.BinaryVectorCount != 3 || result.ContextVectorCount != 8 || result.CryptoVectorCount != 4 || result.SchemaVersion != 1 {
		t.Fatalf("unexpected verification result: %+v", result)
	}
}

func TestEncodeCryptoContextRejectsInvalidInput(t *testing.T) {
	if _, err := encodeCryptoContext("", nil); err == nil {
		t.Fatal("expected empty domain rejection")
	}
	tooManyFields := make([][]byte, 65_536)
	if _, err := encodeCryptoContext("HizoFS/v1/test", tooManyFields); err == nil {
		t.Fatal("expected field-count rejection")
	}
}

func TestDecodeRecordReferenceRejectsReservedBytes(t *testing.T) {
	value := make([]byte, recordReferenceBytes)
	for index := 0; index < 16; index++ {
		value[index] = 1
	}
	binary.BigEndian.PutUint64(value[16:24], 64)
	binary.BigEndian.PutUint32(value[24:28], 88)
	value[28] = recordKindInodeTablePage
	value[29] = 1
	if _, err := decodeRequiredRecordReference(value); err == nil {
		t.Fatal("expected non-zero reserved byte rejection")
	}
}

func TestUnlockPortableFixture(t *testing.T) {
	fixture, err := loadPortableFixture(filepath.Join("..", "..", "..", "src", "00-storage", "service", "hizofs", "authenticated-store", "tests", "test-fixtures", "empty-container-portable-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	summary, root, err := unlockPortableFixture(fixture, fixture.Passphrase)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(root)
	if summary.AuthenticatedUnlockCopies != 2 || summary.SelectedUnlockCopy != 0 || summary.RootKeyBytes != 32 || summary.FileSystemID != "57XP043891T62-modnaes" {
		t.Fatalf("unexpected unlock summary: %+v", summary)
	}
	if _, _, err := unlockPortableFixture(fixture, "wrong passphrase"); err == nil {
		t.Fatal("expected wrong passphrase rejection")
	}
}

func TestReadPortableSuperblocks(t *testing.T) {
	fixture, err := loadPortableFixture(filepath.Join("..", "..", "..", "src", "00-storage", "service", "hizofs", "authenticated-store", "tests", "test-fixtures", "empty-container-portable-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	unlock, root, err := unlockPortableFixture(fixture, fixture.Passphrase)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(root)
	summary, err := readPortableSuperblocks(fixture, root, unlock.UnlockSequence)
	if err != nil {
		t.Fatal(err)
	}
	if summary.AuthenticatedSuperblockCopies != 2 || summary.CopyState != "normal" || summary.ActiveCommitSequence != "1" || summary.MinimumUnlockSequence != "1" || summary.RequiredFeatureBits != "0" || summary.SelectedPublicationSequence != "2" || summary.SelectedSuperblockCopy != 1 || summary.ActiveCommitOffset != "176" || summary.ActiveCommitFrameLength != 192 {
		t.Fatalf("unexpected Superblock summary: %+v", summary)
	}
}

func TestReadPortableActiveCommit(t *testing.T) {
	fixture, err := loadPortableFixture(filepath.Join("..", "..", "..", "src", "00-storage", "service", "hizofs", "authenticated-store", "tests", "test-fixtures", "empty-container-portable-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	unlock, root, err := unlockPortableFixture(fixture, fixture.Passphrase)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(root)
	_, selected, err := openPortableSuperblocks(fixture, root, unlock.UnlockSequence)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := readActiveCommit(fixture, root, selected)
	if err != nil {
		t.Fatal(err)
	}
	if summary.ActiveCommitSequence != "1" || summary.RootInodeTableOffset != "64" || summary.RootInodeTableFrameLength != 112 || !summary.SegmentHeaderAuthenticated {
		t.Fatalf("unexpected active Commit summary: %+v", summary)
	}
}

func TestReadPortableRootInode(t *testing.T) {
	fixture, err := loadPortableFixture(filepath.Join("..", "..", "..", "src", "00-storage", "service", "hizofs", "authenticated-store", "tests", "test-fixtures", "empty-container-portable-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	unlock, root, err := unlockPortableFixture(fixture, fixture.Passphrase)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(root)
	_, selected, err := openPortableSuperblocks(fixture, root, unlock.UnlockSequence)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := readRootInode(fixture, root, selected)
	if err != nil {
		t.Fatal(err)
	}
	if summary.RootDirectoryContent != "inline" || summary.RootDirectoryEntryCount == nil || *summary.RootDirectoryEntryCount != 0 || summary.RootDirectoryInodeNumber != "1" || summary.RootDirectoryInodeRevision != "1" || summary.RootInodeTableEntryCount != 1 || summary.RootInodeTableFrameLength != 112 || summary.RootInodeTableLevel != 0 || summary.SegmentBytes != 368 || summary.RootDirectoryCreatedAt != nil || summary.RootDirectoryModifiedAt != nil {
		t.Fatalf("unexpected root Inode summary: %+v", summary)
	}
}

func TestReadPortableInlineNamespace(t *testing.T) {
	fixture, err := loadPortableFixture(filepath.Join("..", "..", "..", "src", "00-storage", "service", "hizofs", "worker", "tests", "test-fixtures", "nonempty-container-portable-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	unlock, root, err := unlockPortableFixture(fixture, fixture.Passphrase)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(root)
	_, selected, err := openPortableSuperblocks(fixture, root, unlock.UnlockSequence)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := readInlineNamespace(fixture, root, selected)
	if err != nil {
		t.Fatal(err)
	}
	if summary.ActiveCommitSequence != "6" || summary.RootDirectoryInodeNumber != "1" || len(summary.Entries) != 3 {
		t.Fatalf("unexpected inline namespace summary: %+v", summary)
	}
	if summary.Entries[0].Path != "/docs" || summary.Entries[0].Kind != "directory" || summary.Entries[1].Path != "/docs/nested.txt" || summary.Entries[1].ContentHex != "6e65737465640a" || summary.Entries[2].Path != "/hello.txt" || summary.Entries[2].ContentHex != "68656c6c6f0a" {
		t.Fatalf("unexpected inline namespace entries: %+v", summary.Entries)
	}
}

func TestDecodeRootInodeLeafRejectsFlags(t *testing.T) {
	if _, err := decodeRootInodeLeafPage([]byte{0, 1, 0, 0}); err == nil {
		t.Fatal("expected root Inode Table flag rejection")
	}
}

func TestDecodeRootInodeLeafRejectsTrailingBytes(t *testing.T) {
	if _, err := decodeRootInodeLeafPage([]byte{0, 0, 0, 0, 0}); err == nil {
		t.Fatal("expected root Inode Table trailing-byte rejection")
	}
}

func TestDecodeRootInodeLeafRejectsExcessiveItemCount(t *testing.T) {
	if _, err := decodeRootInodeLeafPage([]byte{0, 0, 0x0b, 0x22}); err == nil {
		t.Fatal("expected root Inode Table item-count rejection")
	}
}

func TestDecodeKnownAnswerInodeLeafNamespace(t *testing.T) {
	vector, err := loadFixture(filepath.Join(
		"..", "..", "..", "src", "00-storage", "service", "hizofs", "00-format", "v1", "test-fixtures", "known-answer-vectors-v1.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	pageBytes, err := decodeHex("inode leaf page", vector.Expected.InodeLeafPageHex)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := decodeRootInodeLeafPage(pageBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("unexpected Inode leaf entry count: %d", len(entries))
	}
	root, file, child, symlink := entries[0], entries[1], entries[2], entries[3]
	if root.InodeKind != "directory" || root.InodeNumber != 1 || root.InodeRevision != 1 || root.ContentKind != "inline" || len(root.DirectoryEntries) != 3 {
		t.Fatalf("unexpected root directory entry: %+v", root)
	}
	expectedDirectoryEntries := []directoryEntry{
		{InodeKind: "file", InodeNumber: 2, Name: "hello.txt", TargetType: "inode"},
		{InodeKind: "directory", InodeNumber: 3, Name: "sub", TargetType: "inode"},
		{InodeKind: "symlink", InodeNumber: 4, Name: "sym", TargetType: "inode"},
	}
	for index, expected := range expectedDirectoryEntries {
		if root.DirectoryEntries[index] != expected {
			t.Fatalf("unexpected root directory target at %d: %+v", index, root.DirectoryEntries[index])
		}
	}
	if file.InodeKind != "file" || file.InodeNumber != 2 || file.InodeRevision != 3 || file.ContentKind != "inline" || file.FileSize != 6 || !bytes.Equal(file.InlineFileBytes, []byte("hello\n")) {
		t.Fatalf("unexpected inline file entry: %+v", file)
	}
	if file.Timestamps.CreatedAt == nil || *file.Timestamps.CreatedAt != -10 || file.Timestamps.ModifiedAt == nil || *file.Timestamps.ModifiedAt != 20 {
		t.Fatalf("unexpected inline file timestamps: %+v", file.Timestamps)
	}
	if child.InodeKind != "directory" || child.InodeNumber != 3 || child.ContentKind != "inline" || len(child.DirectoryEntries) != 0 {
		t.Fatalf("unexpected child directory entry: %+v", child)
	}
	if symlink.InodeKind != "symlink" || symlink.InodeNumber != 4 || symlink.InodeRevision != 2 || symlink.SymlinkTarget != "../hello.txt" || symlink.Timestamps.ModifiedAt == nil || *symlink.Timestamps.ModifiedAt != 30 {
		t.Fatalf("unexpected symlink entry: %+v", symlink)
	}
}
