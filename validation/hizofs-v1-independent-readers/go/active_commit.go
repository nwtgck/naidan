package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
)

type activeCommitSummary struct {
	ActiveCommitSequence       string `json:"activeCommitSequence"`
	NextInodeNumber            string `json:"nextInodeNumber"`
	NextSubvolumeID            string `json:"nextSubvolumeId"`
	RootDirectoryInodeNumber   string `json:"rootDirectoryInodeNumber"`
	RootInodeTableFrameLength  uint32 `json:"rootInodeTableFrameLength"`
	RootInodeTableOffset       string `json:"rootInodeTableOffset"`
	RootInodeTableSegmentID    string `json:"rootInodeTableSegmentId"`
	SegmentBytes               int    `json:"segmentBytes"`
	SegmentHeaderAuthenticated bool   `json:"segmentHeaderAuthenticated"`
}
type recordFrameHeader struct {
	ExactBytes      []byte
	Flags           byte
	FrameLength     uint32
	HomeOffset      uint64
	HomeSegmentID   [16]byte
	Nonce           []byte
	PlaintextLength uint32
	RecordKind      byte
	SealedLength    uint32
}

func authenticateMetadataSegmentHeader(value []byte, fileSystemID string, segmentID [16]byte, root []byte) error {
	if len(value) != 64 || string(value[:8]) != "HZSEGMNT" || binary.BigEndian.Uint16(value[8:10]) != 1 || binary.BigEndian.Uint16(value[10:12]) != 64 || value[12] != 1 || value[13] != 0 || value[14] != 0 || value[15] != 0 || !bytes.Equal(value[16:32], segmentID[:]) || !allZero(value[32:48]) {
		return errors.New("invalid metadata Segment Header")
	}
	context, err := encodeCryptoContext("HizoFS/v1/segment-header-key", [][]byte{[]byte(fileSystemID), segmentID[:], {1}})
	if err != nil {
		return err
	}
	key, err := hkdfSHA256(root, context, 32)
	if err != nil {
		return err
	}
	defer clear(key)
	aad, err := encodeCryptoContext("HizoFS/v1/segment-header-aad", [][]byte{[]byte(fileSystemID), value[:48]})
	if err != nil {
		return err
	}
	plain, err := aesGCMDecrypt(key, make([]byte, 12), aad, value[48:64])
	if err != nil || len(plain) != 0 {
		return errors.New("metadata Segment Header authentication failed")
	}
	return nil
}
func decodeRecordFrameHeader(value []byte) (recordFrameHeader, error) {
	var h recordFrameHeader
	if len(value) != 64 || string(value[:8]) != "HZRECORD" || binary.BigEndian.Uint16(value[8:10]) != 1 || binary.BigEndian.Uint16(value[10:12]) != 64 {
		return h, errors.New("invalid Record Frame framing")
	}
	kind := value[12]
	flags := value[13]
	if _, ok := knownRecordKinds[kind]; !ok || flags&^byte(1) != 0 || binary.BigEndian.Uint16(value[14:16]) != 1 || (kind == 48) != (flags&1 != 0) {
		return h, errors.New("invalid Record Frame kind, flags, or codec")
	}
	copy(h.HomeSegmentID[:], value[16:32])
	h.HomeOffset = binary.BigEndian.Uint64(value[32:40])
	h.PlaintextLength = binary.BigEndian.Uint32(value[40:44])
	h.SealedLength = binary.BigEndian.Uint32(value[44:48])
	h.FrameLength = binary.BigEndian.Uint32(value[48:52])
	expectedSealedLength := uint64(h.PlaintextLength) + 16
	expectedFrameLength := (64 + expectedSealedLength + 7) / 8 * 8
	if h.HomeOffset < 64 || h.HomeOffset%8 != 0 || uint64(h.SealedLength) != expectedSealedLength || uint64(h.FrameLength) != expectedFrameLength {
		return h, errors.New("invalid Record Frame length or home offset")
	}
	h.RecordKind = kind
	h.Flags = flags
	h.Nonce = append([]byte(nil), value[52:64]...)
	h.ExactBytes = append([]byte(nil), value...)
	return h, nil
}
func readAuthenticatedHomeRecord(f portableFixture, root []byte, ref recordReference, expectedKind byte) ([]byte, int, error) {
	segmentID := fmt.Sprintf("%x", ref.SegmentID)
	path := fmt.Sprintf("segments/metadata/%s/%s.enc", segmentID[len(segmentID)-2:], segmentID)
	segment, err := fixtureBytes(f, path)
	if err != nil {
		return nil, 0, err
	}
	if len(segment) < 64 {
		return nil, 0, errors.New("metadata Segment is shorter than its header")
	}
	if err = authenticateMetadataSegmentHeader(segment[:64], f.FileSystemID, ref.SegmentID, root); err != nil {
		return nil, 0, err
	}
	if ref.ByteOffset > uint64(len(segment)) {
		return nil, 0, errors.New("record offset is outside Segment")
	}
	start := int(ref.ByteOffset)
	if uint64(ref.FrameLength) > uint64(len(segment)-start) {
		return nil, 0, errors.New("record reference is outside Segment")
	}
	end := start + int(ref.FrameLength)
	frame := segment[start:end]
	if len(frame) < 64 {
		return nil, 0, errors.New("Record Frame is shorter than its header")
	}
	header, err := decodeRecordFrameHeader(frame[:64])
	if err != nil {
		return nil, 0, err
	}
	sealedEnd := uint64(64) + uint64(header.SealedLength)
	if uint64(header.FrameLength) != uint64(len(frame)) || sealedEnd > uint64(len(frame)) {
		return nil, 0, errors.New("Record Frame declared length exceeds its reference")
	}
	if !allZero(frame[int(sealedEnd):]) {
		return nil, 0, errors.New("Record Frame padding must be canonical zero")
	}
	if header.RecordKind != expectedKind || header.Flags != 0 || header.FrameLength != ref.FrameLength || header.HomeOffset != ref.ByteOffset || header.HomeSegmentID != ref.SegmentID {
		return nil, 0, errors.New("Record Frame does not match its Home Record Reference")
	}
	context, err := encodeCryptoContext("HizoFS/v1/record-key", [][]byte{[]byte(f.FileSystemID), header.HomeSegmentID[:]})
	if err != nil {
		return nil, 0, err
	}
	key, err := hkdfSHA256(root, context, 32)
	if err != nil {
		return nil, 0, err
	}
	defer clear(key)
	aad, err := encodeCryptoContext("HizoFS/v1/record-aad", [][]byte{[]byte(f.FileSystemID), header.ExactBytes})
	if err != nil {
		return nil, 0, err
	}
	plain, err := aesGCMDecrypt(key, header.Nonce, aad, frame[64:64+header.SealedLength])
	if err != nil || len(plain) != int(header.PlaintextLength) {
		return nil, 0, errors.New("Record Frame authentication failed")
	}
	return plain, len(segment), nil
}

func readActiveCommitAuthority(f portableFixture, root []byte, selected authenticatedSuperblockCopy) (fileSystemCommit, int, error) {
	plain, segmentBytes, err := readAuthenticatedHomeRecord(f, root, selected.Plaintext.ActiveCommitHomeRef, recordKindFileSystemCommit)
	if err != nil {
		return fileSystemCommit{}, 0, err
	}
	commit, err := decodeFileSystemCommit(plain)
	if err != nil {
		return fileSystemCommit{}, 0, err
	}
	if commit.CommitSequence != selected.Header.ActiveCommitSequence || commit.MutationID != selected.Plaintext.ActiveMutationID {
		return fileSystemCommit{}, 0, errors.New("active Commit identity mismatch")
	}
	return commit, segmentBytes, nil
}

func readActiveCommit(f portableFixture, root []byte, selected authenticatedSuperblockCopy) (activeCommitSummary, error) {
	commit, segmentBytes, err := readActiveCommitAuthority(f, root, selected)
	if err != nil {
		return activeCommitSummary{}, err
	}
	rootRef := commit.RootInodeTableRootHomeRef
	return activeCommitSummary{
		ActiveCommitSequence:       fmt.Sprint(commit.CommitSequence),
		NextInodeNumber:            fmt.Sprint(commit.NextInodeNumber),
		NextSubvolumeID:            fmt.Sprint(commit.NextSubvolumeID),
		RootDirectoryInodeNumber:   fmt.Sprint(commit.RootDirectoryInodeNumber),
		RootInodeTableFrameLength:  rootRef.FrameLength,
		RootInodeTableOffset:       fmt.Sprint(rootRef.ByteOffset),
		RootInodeTableSegmentID:    fmt.Sprintf("%x", rootRef.SegmentID),
		SegmentBytes:               segmentBytes,
		SegmentHeaderAuthenticated: true,
	}, nil
}
