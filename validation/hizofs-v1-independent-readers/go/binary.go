package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	fileSystemCommitBytes          = 112
	commonPageHeaderBytes          = 4
	recordReferenceBytes           = 32
	metadataPlaintextMaximumBytes  = 65_536
	fileDataPlaintextMaximumBytes  = 1_048_576
	recordKindFileSystemCommit     = byte(1)
	recordKindNestedSubvolumeTable = byte(2)
	recordKindInodeTablePage       = byte(16)
	recordKindDirectoryPage        = byte(32)
	recordKindFileExtentPage       = byte(33)
	recordKindFileData             = byte(34)
	recordKindRelocationIndexPage  = byte(48)
)

var knownRecordKinds = map[byte]struct{}{
	1: {}, 2: {}, 16: {}, 32: {}, 33: {}, 34: {}, 48: {},
}

type recordReference struct {
	SegmentID   [16]byte
	ByteOffset  uint64
	FrameLength uint32
	RecordKind  byte
}

type fileSystemCommit struct {
	CommitSequence                  uint64
	MutationID                      [16]byte
	RootDirectoryInodeNumber        uint64
	RootInodeTableRootHomeRef       recordReference
	NestedSubvolumeTableRootHomeRef *recordReference
	NextInodeNumber                 uint64
	NextSubvolumeID                 uint64
}

type inodeBranchEntry struct {
	UpperBound       uint64
	ChildPageHomeRef recordReference
}

type inodeBranchPage struct {
	Level   byte
	Entries []inodeBranchEntry
}

type fileExtentEntry struct {
	FileOffset      uint64
	ByteLength      uint32
	DataOffset      uint32
	FileDataHomeRef recordReference
}

type fileExtentLeafPage struct {
	Entries []fileExtentEntry
}

func allZero(value []byte) bool {
	for _, current := range value {
		if current != 0 {
			return false
		}
	}
	return true
}

func validateRecordReference(reference recordReference) error {
	if allZero(reference.SegmentID[:]) {
		return errors.New("Segment ID must not be all-zero")
	}
	if reference.ByteOffset < 64 || reference.ByteOffset%8 != 0 {
		return errors.New("Record Reference byte offset must be aligned and after the Segment Header")
	}
	if reference.FrameLength < 88 || reference.FrameLength%8 != 0 {
		return errors.New("Record Reference frame length must be aligned and at least 88 bytes")
	}
	if reference.ByteOffset > ^uint64(0)-uint64(reference.FrameLength) {
		return errors.New("Record Reference range exceeds u64")
	}
	if _, exists := knownRecordKinds[reference.RecordKind]; !exists {
		return errors.New("Record Reference kind is unknown")
	}
	return nil
}

func decodeRequiredRecordReference(value []byte) (recordReference, error) {
	if len(value) != recordReferenceBytes {
		return recordReference{}, errors.New("Record Reference must be exactly 32 bytes")
	}
	if allZero(value) {
		return recordReference{}, errors.New("required Record Reference must not be all-zero")
	}
	if value[29] != 0 || value[30] != 0 || value[31] != 0 {
		return recordReference{}, errors.New("Record Reference flags and reserved bytes must be zero")
	}
	var segmentID [16]byte
	copy(segmentID[:], value[:16])
	reference := recordReference{
		SegmentID:   segmentID,
		ByteOffset:  binary.BigEndian.Uint64(value[16:24]),
		FrameLength: binary.BigEndian.Uint32(value[24:28]),
		RecordKind:  value[28],
	}
	if err := validateRecordReference(reference); err != nil {
		return recordReference{}, err
	}
	return reference, nil
}

func decodeOptionalRecordReference(value []byte) (*recordReference, error) {
	if len(value) != recordReferenceBytes {
		return nil, errors.New("Record Reference must be exactly 32 bytes")
	}
	if allZero(value) {
		return nil, nil
	}
	reference, err := decodeRequiredRecordReference(value)
	if err != nil {
		return nil, err
	}
	return &reference, nil
}

func encodeRecordReference(reference recordReference) ([]byte, error) {
	if err := validateRecordReference(reference); err != nil {
		return nil, err
	}
	value := make([]byte, recordReferenceBytes)
	copy(value[:16], reference.SegmentID[:])
	binary.BigEndian.PutUint64(value[16:24], reference.ByteOffset)
	binary.BigEndian.PutUint32(value[24:28], reference.FrameLength)
	value[28] = reference.RecordKind
	return value, nil
}

func assertReferenceKind(reference recordReference, expected byte, label string) error {
	if reference.RecordKind != expected {
		return fmt.Errorf("%s has the wrong record kind", label)
	}
	return nil
}

func decodeFileSystemCommit(value []byte) (fileSystemCommit, error) {
	if len(value) != fileSystemCommitBytes {
		return fileSystemCommit{}, errors.New("File System Commit payload must be exactly 112 bytes")
	}
	rootReference, err := decodeRequiredRecordReference(value[32:64])
	if err != nil {
		return fileSystemCommit{}, err
	}
	nestedReference, err := decodeOptionalRecordReference(value[64:96])
	if err != nil {
		return fileSystemCommit{}, err
	}
	var mutationID [16]byte
	copy(mutationID[:], value[8:24])
	payload := fileSystemCommit{
		CommitSequence:                  binary.BigEndian.Uint64(value[0:8]),
		MutationID:                      mutationID,
		RootDirectoryInodeNumber:        binary.BigEndian.Uint64(value[24:32]),
		RootInodeTableRootHomeRef:       rootReference,
		NestedSubvolumeTableRootHomeRef: nestedReference,
		NextInodeNumber:                 binary.BigEndian.Uint64(value[96:104]),
		NextSubvolumeID:                 binary.BigEndian.Uint64(value[104:112]),
	}
	if payload.CommitSequence < 1 || payload.RootDirectoryInodeNumber < 1 || payload.NextInodeNumber < 2 || payload.NextSubvolumeID < 2 {
		return fileSystemCommit{}, errors.New("File System Commit scalar minimum is violated")
	}
	if allZero(payload.MutationID[:]) {
		return fileSystemCommit{}, errors.New("Mutation ID must not be all-zero")
	}
	if err := assertReferenceKind(payload.RootInodeTableRootHomeRef, recordKindInodeTablePage, "root Inode Table reference"); err != nil {
		return fileSystemCommit{}, err
	}
	if payload.NestedSubvolumeTableRootHomeRef != nil {
		if err := assertReferenceKind(*payload.NestedSubvolumeTableRootHomeRef, recordKindNestedSubvolumeTable, "nested Subvolume Table reference"); err != nil {
			return fileSystemCommit{}, err
		}
	}
	return payload, nil
}

func encodeFileSystemCommit(payload fileSystemCommit) ([]byte, error) {
	value := make([]byte, fileSystemCommitBytes)
	binary.BigEndian.PutUint64(value[0:8], payload.CommitSequence)
	copy(value[8:24], payload.MutationID[:])
	binary.BigEndian.PutUint64(value[24:32], payload.RootDirectoryInodeNumber)
	rootReference, err := encodeRecordReference(payload.RootInodeTableRootHomeRef)
	if err != nil {
		return nil, err
	}
	copy(value[32:64], rootReference)
	if payload.NestedSubvolumeTableRootHomeRef != nil {
		nestedReference, encodeErr := encodeRecordReference(*payload.NestedSubvolumeTableRootHomeRef)
		if encodeErr != nil {
			return nil, encodeErr
		}
		copy(value[64:96], nestedReference)
	}
	binary.BigEndian.PutUint64(value[96:104], payload.NextInodeNumber)
	binary.BigEndian.PutUint64(value[104:112], payload.NextSubvolumeID)
	return value, nil
}

func decodePageHeader(value []byte, entryBytes int, requireBranch bool) (byte, int, error) {
	if len(value) < commonPageHeaderBytes {
		return 0, 0, errors.New("page is shorter than the common header")
	}
	if len(value) > metadataPlaintextMaximumBytes {
		return 0, 0, errors.New("page exceeds the metadata plaintext maximum")
	}
	if value[1] != 0 {
		return 0, 0, errors.New("page flags must be zero")
	}
	level := value[0]
	itemCount := int(binary.BigEndian.Uint16(value[2:4]))
	if requireBranch && level < 1 {
		return 0, 0, errors.New("branch page must have level at least 1")
	}
	if !requireBranch && level != 0 {
		return 0, 0, errors.New("leaf page must have level zero")
	}
	if requireBranch && itemCount == 0 {
		return 0, 0, errors.New("branch page must not be empty")
	}
	if len(value) != commonPageHeaderBytes+itemCount*entryBytes {
		return 0, 0, errors.New("page length does not match item count")
	}
	return level, itemCount, nil
}

func encodePageHeader(level byte, itemCount int) ([]byte, error) {
	if itemCount < 0 || itemCount > 0xffff {
		return nil, errors.New("page item count is outside u16")
	}
	value := make([]byte, commonPageHeaderBytes)
	value[0] = level
	binary.BigEndian.PutUint16(value[2:4], uint16(itemCount))
	return value, nil
}

func decodeInodeBranchPage(value []byte) (inodeBranchPage, error) {
	level, itemCount, err := decodePageHeader(value, 40, true)
	if err != nil {
		return inodeBranchPage{}, err
	}
	entries := make([]inodeBranchEntry, 0, itemCount)
	var previous uint64
	for index := 0; index < itemCount; index++ {
		offset := commonPageHeaderBytes + index*40
		upperBound := binary.BigEndian.Uint64(value[offset : offset+8])
		if upperBound < 1 || (index > 0 && upperBound <= previous) {
			return inodeBranchPage{}, errors.New("Inode branch keys must be positive and strictly ascending")
		}
		reference, decodeErr := decodeRequiredRecordReference(value[offset+8 : offset+40])
		if decodeErr != nil {
			return inodeBranchPage{}, decodeErr
		}
		if kindErr := assertReferenceKind(reference, recordKindInodeTablePage, "branch child reference"); kindErr != nil {
			return inodeBranchPage{}, kindErr
		}
		entries = append(entries, inodeBranchEntry{UpperBound: upperBound, ChildPageHomeRef: reference})
		previous = upperBound
	}
	return inodeBranchPage{Level: level, Entries: entries}, nil
}

func encodeInodeBranchPage(page inodeBranchPage) ([]byte, error) {
	header, err := encodePageHeader(page.Level, len(page.Entries))
	if err != nil {
		return nil, err
	}
	value := make([]byte, commonPageHeaderBytes+len(page.Entries)*40)
	copy(value, header)
	var previous uint64
	for index, entry := range page.Entries {
		if entry.UpperBound < 1 || (index > 0 && entry.UpperBound <= previous) {
			return nil, errors.New("Inode branch keys must be positive and strictly ascending")
		}
		if kindErr := assertReferenceKind(entry.ChildPageHomeRef, recordKindInodeTablePage, "branch child reference"); kindErr != nil {
			return nil, kindErr
		}
		offset := commonPageHeaderBytes + index*40
		binary.BigEndian.PutUint64(value[offset:offset+8], entry.UpperBound)
		reference, encodeErr := encodeRecordReference(entry.ChildPageHomeRef)
		if encodeErr != nil {
			return nil, encodeErr
		}
		copy(value[offset+8:offset+40], reference)
		previous = entry.UpperBound
	}
	return value, nil
}

func decodeFileExtentLeafPage(value []byte) (fileExtentLeafPage, error) {
	_, itemCount, err := decodePageHeader(value, 48, false)
	if err != nil {
		return fileExtentLeafPage{}, err
	}
	entries := make([]fileExtentEntry, 0, itemCount)
	var previousEnd uint64
	for index := 0; index < itemCount; index++ {
		offset := commonPageHeaderBytes + index*48
		fileOffset := binary.BigEndian.Uint64(value[offset : offset+8])
		byteLength := binary.BigEndian.Uint32(value[offset+8 : offset+12])
		dataOffset := binary.BigEndian.Uint32(value[offset+12 : offset+16])
		if byteLength < 1 || byteLength > fileDataPlaintextMaximumBytes {
			return fileExtentLeafPage{}, errors.New("extent byte length is outside the File Data plaintext bound")
		}
		if uint64(dataOffset)+uint64(byteLength) > fileDataPlaintextMaximumBytes {
			return fileExtentLeafPage{}, errors.New("extent data range exceeds the File Data payload maximum")
		}
		if fileOffset > ^uint64(0)-uint64(byteLength) {
			return fileExtentLeafPage{}, errors.New("extent file range exceeds u64")
		}
		if index > 0 && fileOffset < previousEnd {
			return fileExtentLeafPage{}, errors.New("extent entries overlap or are not strictly ordered")
		}
		reference, decodeErr := decodeRequiredRecordReference(value[offset+16 : offset+48])
		if decodeErr != nil {
			return fileExtentLeafPage{}, decodeErr
		}
		if kindErr := assertReferenceKind(reference, recordKindFileData, "extent File Data reference"); kindErr != nil {
			return fileExtentLeafPage{}, kindErr
		}
		entries = append(entries, fileExtentEntry{FileOffset: fileOffset, ByteLength: byteLength, DataOffset: dataOffset, FileDataHomeRef: reference})
		previousEnd = fileOffset + uint64(byteLength)
	}
	return fileExtentLeafPage{Entries: entries}, nil
}

func encodeFileExtentLeafPage(page fileExtentLeafPage) ([]byte, error) {
	header, err := encodePageHeader(0, len(page.Entries))
	if err != nil {
		return nil, err
	}
	value := make([]byte, commonPageHeaderBytes+len(page.Entries)*48)
	copy(value, header)
	var previousEnd uint64
	for index, entry := range page.Entries {
		if entry.ByteLength < 1 || entry.ByteLength > fileDataPlaintextMaximumBytes {
			return nil, errors.New("extent byte length is outside the File Data plaintext bound")
		}
		if uint64(entry.DataOffset)+uint64(entry.ByteLength) > fileDataPlaintextMaximumBytes {
			return nil, errors.New("extent data range exceeds the File Data payload maximum")
		}
		if entry.FileOffset > ^uint64(0)-uint64(entry.ByteLength) {
			return nil, errors.New("extent file range exceeds u64")
		}
		if index > 0 && entry.FileOffset < previousEnd {
			return nil, errors.New("extent entries overlap or are not strictly ordered")
		}
		if kindErr := assertReferenceKind(entry.FileDataHomeRef, recordKindFileData, "extent File Data reference"); kindErr != nil {
			return nil, kindErr
		}
		offset := commonPageHeaderBytes + index*48
		binary.BigEndian.PutUint64(value[offset:offset+8], entry.FileOffset)
		binary.BigEndian.PutUint32(value[offset+8:offset+12], entry.ByteLength)
		binary.BigEndian.PutUint32(value[offset+12:offset+16], entry.DataOffset)
		reference, encodeErr := encodeRecordReference(entry.FileDataHomeRef)
		if encodeErr != nil {
			return nil, encodeErr
		}
		copy(value[offset+16:offset+48], reference)
		previousEnd = entry.FileOffset + uint64(entry.ByteLength)
	}
	return value, nil
}

func verifyBinaryFixtureRoundTrips(expected fixtureExpected) (int, error) {
	commitBytes, err := decodeHex("File System Commit", expected.FileSystemCommitHex)
	if err != nil {
		return 0, err
	}
	commit, err := decodeFileSystemCommit(commitBytes)
	if err != nil {
		return 0, err
	}
	encodedCommit, err := encodeFileSystemCommit(commit)
	if err != nil || !bytes.Equal(encodedCommit, commitBytes) {
		return 0, errors.New("File System Commit roundtrip mismatch")
	}

	inodePageBytes, err := decodeHex("Inode branch page", expected.InodeBranchPageHex)
	if err != nil {
		return 0, err
	}
	inodePage, err := decodeInodeBranchPage(inodePageBytes)
	if err != nil {
		return 0, err
	}
	encodedInodePage, err := encodeInodeBranchPage(inodePage)
	if err != nil || !bytes.Equal(encodedInodePage, inodePageBytes) {
		return 0, errors.New("Inode branch page roundtrip mismatch")
	}

	extentPageBytes, err := decodeHex("File Extent leaf page", expected.FileExtentLeafPageHex)
	if err != nil {
		return 0, err
	}
	extentPage, err := decodeFileExtentLeafPage(extentPageBytes)
	if err != nil {
		return 0, err
	}
	encodedExtentPage, err := encodeFileExtentLeafPage(extentPage)
	if err != nil || !bytes.Equal(encodedExtentPage, extentPageBytes) {
		return 0, errors.New("File Extent leaf page roundtrip mismatch")
	}
	return 3, nil
}
