package main

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	superblockHeaderBytes    = 80
	superblockPlaintextBytes = 144
	superblockFileBytes      = 240
)

type superblockHeader struct {
	ActiveCommitSequence uint64
	Copy                 int
	Flags                byte
	Nonce                []byte
	PublicationSequence  uint64
	ExactBytes           []byte
}
type superblockPlaintext struct {
	ActiveCommitHomeRef            recordReference
	ActiveMutationID               [16]byte
	FallbackCommitHomeRef          *recordReference
	MinimumUnlockSequence          uint64
	PublicationID                  [16]byte
	RelocationIndexRootPhysicalRef *recordReference
	RequiredFeatureBits            uint64
	ExactBytes                     []byte
}
type authenticatedSuperblockCopy struct {
	Header       superblockHeader
	PhysicalCopy int
	Plaintext    superblockPlaintext
}
type superblockSummary struct {
	AuthenticatedSuperblockCopies int    `json:"authenticatedSuperblockCopies"`
	ActiveCommitFrameLength       uint32 `json:"activeCommitFrameLength"`
	ActiveCommitOffset            string `json:"activeCommitOffset"`
	ActiveCommitSegmentID         string `json:"activeCommitSegmentId"`
	ActiveCommitSequence          string `json:"activeCommitSequence"`
	CopyState                     string `json:"copyState"`
	FallbackCommitPresent         bool   `json:"fallbackCommitPresent"`
	MinimumUnlockSequence         string `json:"minimumUnlockSequence"`
	RelocationIndexPresent        bool   `json:"relocationIndexPresent"`
	RequiredFeatureBits           string `json:"requiredFeatureBits"`
	SelectedPublicationSequence   string `json:"selectedPublicationSequence"`
	SelectedSuperblockCopy        int    `json:"selectedSuperblockCopy"`
}

func decodeSuperblockHeader(value []byte, physicalCopy int, fileSystemID string) (superblockHeader, error) {
	var h superblockHeader
	if len(value) != superblockHeaderBytes {
		return h, errors.New("Superblock Header must be exactly 80 bytes")
	}
	if string(value[:8]) != "HZSBLOCK" || binary.BigEndian.Uint16(value[8:10]) != 1 || binary.BigEndian.Uint16(value[10:12]) != 80 {
		return h, errors.New("invalid Superblock framing")
	}
	if int(value[12]) != physicalCopy || (physicalCopy != 0 && physicalCopy != 1) || value[13]&^byte(3) != 0 || value[14] != 0 || value[15] != 0 {
		return h, errors.New("invalid Superblock copy, flags, or reserved bytes")
	}
	publication := binary.BigEndian.Uint64(value[16:24])
	active := binary.BigEndian.Uint64(value[24:32])
	if publication < 1 || active < 1 {
		return h, errors.New("Superblock sequence must be nonzero")
	}
	if binary.BigEndian.Uint32(value[32:36]) != 144 || value[36] != 21 || string(value[37:58]) != fileSystemID || !allZero(value[70:80]) {
		return h, errors.New("invalid Superblock length, identity, or reserved bytes")
	}
	return superblockHeader{
		ActiveCommitSequence: active,
		Copy:                 physicalCopy,
		Flags:                value[13],
		Nonce:                append([]byte(nil), value[58:70]...),
		PublicationSequence:  publication,
		ExactBytes:           append([]byte(nil), value...),
	}, nil
}
func decodeSuperblockPlaintext(value []byte, flags byte) (superblockPlaintext, error) {
	var p superblockPlaintext
	if len(value) != superblockPlaintextBytes {
		return p, errors.New("Superblock plaintext must be exactly 144 bytes")
	}
	active, err := decodeRequiredRecordReference(value[0:32])
	if err != nil || active.RecordKind != recordKindFileSystemCommit {
		return p, errors.New("invalid active Commit reference")
	}
	fallback, err := decodeOptionalRecordReference(value[32:64])
	if err != nil || (fallback != nil && fallback.RecordKind != recordKindFileSystemCommit) {
		return p, errors.New("invalid fallback Commit reference")
	}
	relocation, err := decodeOptionalRecordReference(value[64:96])
	if err != nil || (relocation != nil && relocation.RecordKind != recordKindRelocationIndexPage) {
		return p, errors.New("invalid relocation reference")
	}
	if (fallback != nil) != (flags&2 != 0) || (relocation != nil) != (flags&1 != 0) {
		return p, errors.New("Superblock optional-reference flag mismatch")
	}
	copy(p.ActiveMutationID[:], value[96:112])
	copy(p.PublicationID[:], value[112:128])
	if allZero(p.ActiveMutationID[:]) || allZero(p.PublicationID[:]) {
		return p, errors.New("Superblock identity must not be all-zero")
	}
	minimum := binary.BigEndian.Uint64(value[128:136])
	if minimum < 1 {
		return p, errors.New("minimum Unlock Sequence must be nonzero")
	}
	p.ActiveCommitHomeRef = active
	p.FallbackCommitHomeRef = fallback
	p.RelocationIndexRootPhysicalRef = relocation
	p.MinimumUnlockSequence = minimum
	p.RequiredFeatureBits = binary.BigEndian.Uint64(value[136:144])
	p.ExactBytes = append([]byte(nil), value...)
	return p, nil
}
func decryptSuperblockCopy(value []byte, physicalCopy int, fileSystemID string, root []byte) (authenticatedSuperblockCopy, error) {
	var c authenticatedSuperblockCopy
	if len(value) != superblockFileBytes {
		return c, errors.New("Superblock file must be exactly 240 bytes")
	}
	header, err := decodeSuperblockHeader(value[:80], physicalCopy, fileSystemID)
	if err != nil {
		return c, err
	}
	context, err := encodeCryptoContext("HizoFS/v1/superblock-key", [][]byte{[]byte(fileSystemID), {byte(physicalCopy)}, encodeU64(header.PublicationSequence)})
	if err != nil {
		return c, err
	}
	key, err := hkdfSHA256(root, context, 32)
	if err != nil {
		return c, err
	}
	defer clear(key)
	aad, err := encodeCryptoContext("HizoFS/v1/superblock-aad", [][]byte{header.ExactBytes})
	if err != nil {
		return c, err
	}
	plaintext, err := aesGCMDecrypt(key, header.Nonce, aad, value[80:])
	if err != nil {
		return c, err
	}
	decoded, err := decodeSuperblockPlaintext(plaintext, header.Flags)
	if err != nil {
		return c, err
	}
	return authenticatedSuperblockCopy{
		Header:       header,
		PhysicalCopy: physicalCopy,
		Plaintext:    decoded,
	}, nil
}
func superblockLogicalKey(c authenticatedSuperblockCopy) string {
	return fmt.Sprintf("%d:%x:%x", c.Header.ActiveCommitSequence, c.Plaintext.ExactBytes[:112], c.Plaintext.ExactBytes[128:])
}
func openPortableSuperblocks(f portableFixture, root []byte, unlockSequence int) (superblockSummary, authenticatedSuperblockCopy, error) {
	copies := make([]authenticatedSuperblockCopy, 0, 2)
	for physical := 0; physical < 2; physical++ {
		value, err := fixtureBytes(f, fmt.Sprintf("superblock-%d.enc", physical))
		if err != nil {
			return superblockSummary{}, authenticatedSuperblockCopy{}, err
		}
		c, err := decryptSuperblockCopy(value, physical, f.FileSystemID, root)
		if err != nil {
			return superblockSummary{}, authenticatedSuperblockCopy{}, err
		}
		copies = append(copies, c)
	}
	if copies[0].Header.PublicationSequence < copies[1].Header.PublicationSequence {
		copies[0], copies[1] = copies[1], copies[0]
	}
	if copies[0].Header.PublicationSequence == copies[1].Header.PublicationSequence {
		return superblockSummary{}, authenticatedSuperblockCopy{}, errors.New("two authenticated Superblock copies reuse one Publication Sequence")
	}
	selected := copies[0]
	if selected.Plaintext.RequiredFeatureBits != 0 {
		return superblockSummary{}, authenticatedSuperblockCopy{}, errors.New("selected Superblock requires unsupported feature semantics")
	}
	if uint64(unlockSequence) < selected.Plaintext.MinimumUnlockSequence {
		return superblockSummary{}, authenticatedSuperblockCopy{}, errors.New("Unlock authority is older than the Superblock minimum")
	}
	state := "superblock_redundancy_degraded"
	if superblockLogicalKey(copies[0]) == superblockLogicalKey(copies[1]) {
		state = "normal"
	}
	ref := selected.Plaintext.ActiveCommitHomeRef
	summary := superblockSummary{
		AuthenticatedSuperblockCopies: 2,
		ActiveCommitFrameLength:       ref.FrameLength,
		ActiveCommitOffset:            fmt.Sprint(ref.ByteOffset),
		ActiveCommitSegmentID:         fmt.Sprintf("%x", ref.SegmentID),
		ActiveCommitSequence:          fmt.Sprint(selected.Header.ActiveCommitSequence),
		CopyState:                     state,
		FallbackCommitPresent:         selected.Plaintext.FallbackCommitHomeRef != nil,
		MinimumUnlockSequence:         fmt.Sprint(selected.Plaintext.MinimumUnlockSequence),
		RelocationIndexPresent:        selected.Plaintext.RelocationIndexRootPhysicalRef != nil,
		RequiredFeatureBits:           fmt.Sprint(selected.Plaintext.RequiredFeatureBits),
		SelectedPublicationSequence:   fmt.Sprint(selected.Header.PublicationSequence),
		SelectedSuperblockCopy:        selected.PhysicalCopy,
	}
	return summary, selected, nil
}

func readPortableSuperblocks(f portableFixture, root []byte, unlockSequence int) (superblockSummary, error) {
	summary, _, err := openPortableSuperblocks(f, root, unlockSequence)
	return summary, err
}
