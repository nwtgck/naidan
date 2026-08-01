package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf8"
)

const (
	inodeEntryPrefixBytes             = 20
	directoryBodyPrefixBytes          = 3
	directoryEntryPrefixBytes         = 14
	fileBodyPrefixBytes               = 9
	maximumInodeLeafEntries           = 2849
	maximumInlineDirectoryBytes       = 4096
	maximumInlineFileBytes            = 4096
	maximumFilenameBytes              = 255
	maximumSymlinkBytes               = 4096
	timestampMinimum            int64 = -8640000000000000
	timestampMaximum            int64 = 8640000000000000
)

type inodeTimestamps struct {
	CreatedAt  *int64
	ModifiedAt *int64
	NextOffset int
}

type directoryEntry struct {
	InodeKind   string
	InodeNumber uint64
	Name        string
	SubvolumeID uint64
	TargetType  string
}

type inodeEntry struct {
	ContentKind      string
	DirectoryEntries []directoryEntry
	FileSize         uint64
	InlineFileBytes  []byte
	InodeKind        string
	InodeNumber      uint64
	InodeRevision    uint64
	SymlinkTarget    string
	Timestamps       inodeTimestamps
}

type rootInodeSummary struct {
	RootDirectoryContent       string  `json:"rootDirectoryContent"`
	RootDirectoryCreatedAt     *string `json:"rootDirectoryCreatedAt"`
	RootDirectoryEntryCount    *int    `json:"rootDirectoryEntryCount"`
	RootDirectoryInodeNumber   string  `json:"rootDirectoryInodeNumber"`
	RootDirectoryInodeRevision string  `json:"rootDirectoryInodeRevision"`
	RootDirectoryModifiedAt    *string `json:"rootDirectoryModifiedAt"`
	RootInodeTableEntryCount   int     `json:"rootInodeTableEntryCount"`
	RootInodeTableFrameLength  uint32  `json:"rootInodeTableFrameLength"`
	RootInodeTableLevel        int     `json:"rootInodeTableLevel"`
	SegmentBytes               int     `json:"segmentBytes"`
}

func decodeStrictText(value []byte, label string, minimum int, maximum int) (string, error) {
	if len(value) < minimum || len(value) > maximum || !utf8.Valid(value) {
		return "", fmt.Errorf("%s is outside the UTF-8 bound", label)
	}
	return string(value), nil
}

func decodeFilename(value []byte) (string, error) {
	name, err := decodeStrictText(value, "filename component", 1, maximumFilenameBytes)
	if err != nil {
		return "", err
	}
	if name == "." || name == ".." || bytes.ContainsRune(value, '/') || bytes.IndexByte(value, 0) >= 0 {
		return "", errors.New("filename component is invalid")
	}
	return name, nil
}

func decodeTimestamps(value []byte, offset int, presence byte) (inodeTimestamps, error) {
	var result inodeTimestamps
	if presence&^byte(3) != 0 {
		return result, errors.New("inode timestamp presence contains unknown bits")
	}
	result.NextOffset = offset
	readTimestamp := func() (*int64, error) {
		if result.NextOffset+8 > len(value) {
			return nil, errors.New("inode timestamp exceeds entry boundary")
		}
		current := int64(binary.BigEndian.Uint64(value[result.NextOffset : result.NextOffset+8]))
		result.NextOffset += 8
		if current < timestampMinimum || current > timestampMaximum {
			return nil, errors.New("inode timestamp is outside the V1 range")
		}
		copy := current
		return &copy, nil
	}
	var err error
	if presence&1 != 0 {
		result.CreatedAt, err = readTimestamp()
		if err != nil {
			return result, err
		}
	}
	if presence&2 != 0 {
		result.ModifiedAt, err = readTimestamp()
		if err != nil {
			return result, err
		}
	}
	return result, nil
}

func decodeInodeKindTag(value byte) (string, error) {
	switch value {
	case 1:
		return "file", nil
	case 2:
		return "directory", nil
	case 3:
		return "symlink", nil
	default:
		return "", errors.New("inode kind is unknown")
	}
}

func decodeDirectoryEntry(value []byte) (directoryEntry, []byte, error) {
	var result directoryEntry
	if len(value) < directoryEntryPrefixBytes {
		return result, nil, errors.New("directory entry is shorter than its prefix")
	}
	entryLength := int(binary.BigEndian.Uint16(value[:2]))
	nameLength := int(binary.BigEndian.Uint16(value[4:6]))
	if entryLength != len(value) || entryLength != directoryEntryPrefixBytes+nameLength {
		return result, nil, errors.New("directory entry length is invalid")
	}
	targetKind := value[2]
	inodeKindTag := value[3]
	targetID := binary.BigEndian.Uint64(value[6:14])
	nameBytes := value[directoryEntryPrefixBytes:]
	name, err := decodeFilename(nameBytes)
	if err != nil {
		return result, nil, err
	}
	result.Name = name
	switch targetKind {
	case 1:
		if targetID < 1 {
			return result, nil, errors.New("directory inode target is invalid")
		}
		result.InodeKind, err = decodeInodeKindTag(inodeKindTag)
		if err != nil {
			return result, nil, errors.New("directory inode target is invalid")
		}
		result.InodeNumber = targetID
		result.TargetType = "inode"
	case 2:
		if inodeKindTag != 0 || targetID < 2 {
			return result, nil, errors.New("directory Subvolume target is invalid")
		}
		result.SubvolumeID = targetID
		result.TargetType = "subvolume"
	default:
		return result, nil, errors.New("directory target kind is unknown")
	}
	return result, append([]byte(nil), nameBytes...), nil
}

func decodeDirectoryBody(value []byte, offset int) (string, []directoryEntry, error) {
	if offset+directoryBodyPrefixBytes > len(value) {
		return "", nil, errors.New("directory inode body prefix exceeds entry boundary")
	}
	contentKind := value[offset]
	count := int(binary.BigEndian.Uint16(value[offset+1 : offset+3]))
	if contentKind == 2 {
		if count != 0 || offset+directoryBodyPrefixBytes+recordReferenceBytes != len(value) {
			return "", nil, errors.New("tree directory entry length is invalid")
		}
		ref, err := decodeRequiredRecordReference(value[offset+directoryBodyPrefixBytes:])
		if err != nil || ref.RecordKind != recordKindDirectoryPage {
			return "", nil, errors.New("directory tree root reference is invalid")
		}
		return "tree", nil, nil
	}
	if contentKind != 1 {
		return "", nil, errors.New("directory content kind is unknown")
	}
	entryOffset := offset + directoryBodyPrefixBytes
	start := entryOffset
	entries := make([]directoryEntry, 0, count)
	var previous []byte
	for index := 0; index < count; index++ {
		if entryOffset+directoryEntryPrefixBytes > len(value) {
			return "", nil, errors.New("inline directory entry prefix exceeds inode boundary")
		}
		length := int(binary.BigEndian.Uint16(value[entryOffset : entryOffset+2]))
		if length < directoryEntryPrefixBytes || entryOffset+length > len(value) {
			return "", nil, errors.New("inline directory entry length is invalid")
		}
		entry, name, err := decodeDirectoryEntry(value[entryOffset : entryOffset+length])
		if err != nil {
			return "", nil, err
		}
		if previous != nil && bytes.Compare(previous, name) >= 0 {
			return "", nil, errors.New("inline directory names must be strictly ascending")
		}
		entries = append(entries, entry)
		previous = name
		entryOffset += length
	}
	if entryOffset != len(value) || entryOffset-start > maximumInlineDirectoryBytes {
		return "", nil, errors.New("inline directory body is not canonical")
	}
	return "inline", entries, nil
}

func decodeInodeEntry(value []byte) (inodeEntry, error) {
	var result inodeEntry
	if len(value) < inodeEntryPrefixBytes || int(binary.BigEndian.Uint16(value[:2])) != len(value) {
		return result, errors.New("inode entry length is invalid")
	}
	kind := value[2]
	result.InodeNumber = binary.BigEndian.Uint64(value[4:12])
	result.InodeRevision = binary.BigEndian.Uint64(value[12:20])
	if result.InodeNumber < 1 || result.InodeRevision < 1 {
		return result, errors.New("inode number and revision must be at least 1")
	}
	timestamps, err := decodeTimestamps(value, inodeEntryPrefixBytes, value[3])
	if err != nil {
		return result, err
	}
	result.Timestamps = timestamps
	switch kind {
	case 2:
		result.InodeKind = "directory"
		result.ContentKind, result.DirectoryEntries, err = decodeDirectoryBody(value, timestamps.NextOffset)
		return result, err
	case 1:
		offset := timestamps.NextOffset
		if offset+fileBodyPrefixBytes > len(value) {
			return result, errors.New("file inode body prefix exceeds entry boundary")
		}
		fileSize := binary.BigEndian.Uint64(value[offset : offset+8])
		result.FileSize = fileSize
		contentKind := value[offset+8]
		if contentKind == 1 {
			if offset+11 > len(value) {
				return result, errors.New("inline file length exceeds entry boundary")
			}
			length := int(binary.BigEndian.Uint16(value[offset+9 : offset+11]))
			if length > maximumInlineFileBytes || uint64(length) != fileSize || offset+11+length != len(value) {
				return result, errors.New("inline file body is not canonical")
			}
			result.ContentKind = "inline"
			result.InlineFileBytes = append([]byte(nil), value[offset+11:]...)
		} else if contentKind == 2 {
			if offset+fileBodyPrefixBytes+recordReferenceBytes != len(value) {
				return result, errors.New("extent-backed file entry length is invalid")
			}
			ref, refErr := decodeRequiredRecordReference(value[offset+fileBodyPrefixBytes:])
			if refErr != nil || ref.RecordKind != recordKindFileExtentPage {
				return result, errors.New("file extent root reference is invalid")
			}
			result.ContentKind = "tree"
		} else {
			return result, errors.New("file content kind is unknown")
		}
		result.InodeKind = "file"
		return result, nil
	case 3:
		offset := timestamps.NextOffset
		if offset+2 > len(value) {
			return result, errors.New("symlink target length exceeds entry boundary")
		}
		length := int(binary.BigEndian.Uint16(value[offset : offset+2]))
		if offset+2+length != len(value) {
			return result, errors.New("symlink inode entry length is invalid")
		}
		target, decodeErr := decodeStrictText(value[offset+2:], "symlink target", 1, maximumSymlinkBytes)
		if decodeErr != nil || bytes.IndexByte([]byte(target), 0) >= 0 {
			return result, errors.New("symlink target is invalid")
		}
		result.InodeKind = "symlink"
		result.SymlinkTarget = target
		return result, nil
	default:
		return result, errors.New("inode kind is unknown")
	}
}

func decodeRootInodeLeafPage(value []byte) ([]inodeEntry, error) {
	if len(value) < commonPageHeaderBytes || len(value) > 65536 {
		return nil, errors.New("Inode Table page length is outside the V1 bound")
	}
	level := value[0]
	flags := value[1]
	itemCount := int(binary.BigEndian.Uint16(value[2:4]))
	if level != 0 || flags != 0 || itemCount > maximumInodeLeafEntries {
		return nil, errors.New("root Inode Table leaf header is invalid")
	}
	entries := make([]inodeEntry, 0, itemCount)
	offset := commonPageHeaderBytes
	var previous uint64
	for index := 0; index < itemCount; index++ {
		if offset+inodeEntryPrefixBytes > len(value) {
			return nil, errors.New("inode entry prefix exceeds page boundary")
		}
		length := int(binary.BigEndian.Uint16(value[offset : offset+2]))
		if length < inodeEntryPrefixBytes || offset+length > len(value) {
			return nil, errors.New("inode entry length is invalid")
		}
		entry, err := decodeInodeEntry(value[offset : offset+length])
		if err != nil {
			return nil, err
		}
		if index > 0 && entry.InodeNumber <= previous {
			return nil, errors.New("Inode Numbers must be strictly ascending")
		}
		entries = append(entries, entry)
		previous = entry.InodeNumber
		offset += length
	}
	if offset != len(value) {
		return nil, errors.New("Inode Table page contains trailing bytes")
	}
	return entries, nil
}

func optionalInt64String(value *int64) *string {
	if value == nil {
		return nil
	}
	encoded := fmt.Sprint(*value)
	return &encoded
}

func readRootInode(f portableFixture, root []byte, selected authenticatedSuperblockCopy) (rootInodeSummary, error) {
	commit, _, err := readActiveCommitAuthority(f, root, selected)
	if err != nil {
		return rootInodeSummary{}, err
	}
	ref := commit.RootInodeTableRootHomeRef
	plain, segmentBytes, err := readAuthenticatedHomeRecord(f, root, ref, recordKindInodeTablePage)
	if err != nil {
		return rootInodeSummary{}, err
	}
	entries, err := decodeRootInodeLeafPage(plain)
	if err != nil {
		return rootInodeSummary{}, err
	}
	for _, entry := range entries {
		if entry.InodeNumber != commit.RootDirectoryInodeNumber {
			continue
		}
		if entry.InodeKind != "directory" {
			return rootInodeSummary{}, errors.New("root directory Inode has the wrong kind")
		}
		var entryCount *int
		if entry.ContentKind == "inline" {
			count := len(entry.DirectoryEntries)
			entryCount = &count
		}
		return rootInodeSummary{RootDirectoryContent: entry.ContentKind, RootDirectoryCreatedAt: optionalInt64String(entry.Timestamps.CreatedAt), RootDirectoryEntryCount: entryCount, RootDirectoryInodeNumber: fmt.Sprint(entry.InodeNumber), RootDirectoryInodeRevision: fmt.Sprint(entry.InodeRevision), RootDirectoryModifiedAt: optionalInt64String(entry.Timestamps.ModifiedAt), RootInodeTableEntryCount: len(entries), RootInodeTableFrameLength: ref.FrameLength, RootInodeTableLevel: 0, SegmentBytes: segmentBytes}, nil
	}
	return rootInodeSummary{}, errors.New("root directory Inode is absent from the root Inode Table leaf")
}
