// Naidan HizoFS recovery source.
//
// This standalone implementation uses only the Go standard library. It opens
// an encrypted store from a raw OPFS export and restores the decrypted virtual
// filesystem without depending on Naidan's TypeScript runtime.
//
// Go 1.23 or later:
//
//	go run naidan-recover.go \
//	  -input ./raw-opfs \
//	  -output ./recovered \
//	  -passphrase 'correct horse battery staple'
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	objectEnvelopeVersion  = 1
	objectHeaderByteLength = 32
	recordHeaderByteLength = 16
	aesGCMTagByteLength    = 16
	maxPBKDF2Iterations    = 10_000_000
	maxEncryptionKeySlots  = 32
	objectIDByteLength     = 32
	stableIDByteLength     = 16
	maxSafeInteger         = int64(9_007_199_254_740_991)
)

var objectMagic = []byte{0x48, 0x49, 0x5a, 0x4f, 0x46, 0x53, 0x00, 0x00}

var recordKinds = map[byte]string{
	1: "commit",
	2: "inode_index_page",
	3: "file_inode",
	4: "directory_inode",
	5: "symlink_inode",
	6: "directory_index_page",
	7: "file_extent_page",
	8: "file_chunk",
	9: "superblock",
}

type unsupportedFormatError struct{ message string }

func (value unsupportedFormatError) Error() string { return value.message }

type wrappedKey struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type keyDerivation struct {
	Type       string `json:"type"`
	Salt       string `json:"salt"`
	Iterations int64  `json:"iterations"`
}

type encryptionKeySlot struct {
	ID                      string        `json:"id"`
	KeyDerivation           keyDerivation `json:"keyDerivation"`
	WrappedStorageUnlockKey wrappedKey    `json:"wrappedStorageUnlockKey"`
}

type encryptionOperation struct {
	Type                   string `json:"type"`
	Phase                  string `json:"phase"`
	SourceEncryptedStoreID string `json:"sourceEncryptedStoreId"`
	TargetEncryptedStoreID string `json:"targetEncryptedStoreId"`
}

type encryptionState struct {
	FormatVersion          int64                `json:"formatVersion"`
	Sequence               int64                `json:"sequence"`
	State                  string               `json:"state"`
	KeySlots               []encryptionKeySlot  `json:"keySlots"`
	ActiveEncryptedStoreID string               `json:"activeEncryptedStoreId"`
	Operation              *encryptionOperation `json:"operation"`
}

type storeHeader struct {
	FormatVersion            int64      `json:"formatVersion"`
	EncryptedStoreID         string     `json:"encryptedStoreId"`
	FileSystemID             string     `json:"fileSystemId"`
	WrappedFileSystemRootKey wrappedKey `json:"wrappedFileSystemRootKey"`
}

type descriptor struct {
	Format        string `json:"format"`
	FormatVersion int64  `json:"formatVersion"`
	FileSystemID  string `json:"fileSystemId"`
}

type superblock struct {
	Sequence             int64  `json:"sequence"`
	FileSystemID         string `json:"fileSystemId"`
	ActiveCommitObjectID string `json:"activeCommitObjectId"`
}

type commit struct {
	Revision               int64  `json:"revision"`
	RootDirectoryNodeID    string `json:"rootDirectoryNodeId"`
	InodeIndexRootObjectID string `json:"inodeIndexRootObjectId"`
}

type directoryEntry struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	NodeID string `json:"nodeId"`
}

type inodeIndexLeafEntry struct {
	NodeID        string `json:"nodeId"`
	InodeObjectID string `json:"inodeObjectId"`
}

type inodeIndexBranchChild struct {
	UpperBoundNodeID  string `json:"upperBoundNodeId"`
	ChildPageObjectID string `json:"childPageObjectId"`
}

type inodeIndexPage struct {
	Type     string                  `json:"type"`
	Entries  []inodeIndexLeafEntry   `json:"entries"`
	Children []inodeIndexBranchChild `json:"children"`
}

type directoryIndexBranchChild struct {
	UpperBoundName    string `json:"upperBoundName"`
	ChildPageObjectID string `json:"childPageObjectId"`
}

type directoryIndexPage struct {
	Type     string                      `json:"type"`
	Entries  []directoryEntry            `json:"entries"`
	Children []directoryIndexBranchChild `json:"children"`
}

type extent struct {
	ChunkIndex    int64  `json:"chunkIndex"`
	ChunkObjectID string `json:"chunkObjectId"`
}

type extentBranchChild struct {
	UpperBoundChunkIndex int64  `json:"upperBoundChunkIndex"`
	ChildPageObjectID    string `json:"childPageObjectId"`
}

type extentPage struct {
	Type     string              `json:"type"`
	Extents  []extent            `json:"extents"`
	Children []extentBranchChild `json:"children"`
}

type fileStorage struct {
	Type                    string `json:"type"`
	ChunkSize               int64  `json:"chunkSize"`
	ExtentIndexRootObjectID string `json:"extentIndexRootObjectId"`
}

type fileInode struct {
	NodeID   string      `json:"nodeId"`
	Revision int64       `json:"revision"`
	Size     int64       `json:"size"`
	Storage  fileStorage `json:"storage"`
}

type directoryStorage struct {
	Type                       string           `json:"type"`
	Entries                    []directoryEntry `json:"entries"`
	DirectoryIndexRootObjectID string           `json:"directoryIndexRootObjectId"`
}

type directoryInode struct {
	NodeID   string           `json:"nodeId"`
	Revision int64            `json:"revision"`
	Storage  directoryStorage `json:"storage"`
}

type symlinkInode struct {
	NodeID   string `json:"nodeId"`
	Revision int64  `json:"revision"`
	Target   string `json:"target"`
}

type fileChunkMetadata struct {
	NodeID     string `json:"nodeId"`
	ChunkIndex int64  `json:"chunkIndex"`
}

type record struct {
	Kind          string
	RecordVersion uint16
	Metadata      json.RawMessage
	Binary        []byte
}

type hizoFSReader struct {
	dataDirectory string
	fileSystemID  string
	rootKey       []byte
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func isSafeNonNegative(value int64) bool {
	return value >= 0 && value <= maxSafeInteger
}

func decodeBase64URL(value string, expectedLength int, label string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("%s is not canonical Base64URL: %w", label, err)
	}
	if base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, fmt.Errorf("%s is not canonical Base64URL", label)
	}
	if len(decoded) != expectedLength {
		return nil, fmt.Errorf("%s must contain exactly %d bytes", label, expectedLength)
	}
	return decoded, nil
}

func validateObjectID(value, label string) error {
	_, err := decodeBase64URL(value, objectIDByteLength, label)
	return err
}

func validateStableID(value, label string) error {
	_, err := decodeBase64URL(value, stableIDByteLength, label)
	return err
}

func validateEntryName(value string) error {
	if value == "" || value == "." || value == ".." || strings.Contains(value, "/") || strings.ContainsRune(value, 0) {
		return fmt.Errorf("invalid HizoFS directory entry name: %q", value)
	}
	if !utf8.ValidString(value) {
		return errors.New("directory entry name is not valid UTF-8")
	}
	return nil
}

func pbkdf2SHA256(secret, salt []byte, iterations, keyLength int) ([]byte, error) {
	if iterations <= 0 || iterations > maxPBKDF2Iterations || keyLength <= 0 {
		return nil, fmt.Errorf("PBKDF2 iteration count must be between 1 and %d", maxPBKDF2Iterations)
	}
	blockCount := (keyLength + sha256.Size - 1) / sha256.Size
	if uint64(blockCount) > uint64(^uint32(0)) {
		return nil, errors.New("PBKDF2 output is too large")
	}
	result := make([]byte, 0, blockCount*sha256.Size)
	counter := make([]byte, 4)
	for blockIndex := 1; blockIndex <= blockCount; blockIndex++ {
		binary.BigEndian.PutUint32(counter, uint32(blockIndex))
		mac := hmac.New(sha256.New, secret)
		_, _ = mac.Write(salt)
		_, _ = mac.Write(counter)
		u := mac.Sum(nil)
		block := append([]byte(nil), u...)
		for iteration := 1; iteration < iterations; iteration++ {
			mac = hmac.New(sha256.New, secret)
			_, _ = mac.Write(u)
			u = mac.Sum(nil)
			for index := range block {
				block[index] ^= u[index]
			}
		}
		result = append(result, block...)
	}
	return result[:keyLength], nil
}

func hkdfSHA256(inputKeyMaterial, salt, info []byte, keyLength int) ([]byte, error) {
	if keyLength <= 0 {
		return nil, errors.New("HKDF key length must be positive")
	}
	blockCount := (keyLength + sha256.Size - 1) / sha256.Size
	if blockCount > 255 {
		return nil, errors.New("HKDF output is too large")
	}
	extract := hmac.New(sha256.New, salt)
	_, _ = extract.Write(inputKeyMaterial)
	pseudoRandomKey := extract.Sum(nil)
	defer zero(pseudoRandomKey)
	result := make([]byte, 0, blockCount*sha256.Size)
	var previous []byte
	for blockIndex := 1; blockIndex <= blockCount; blockIndex++ {
		expand := hmac.New(sha256.New, pseudoRandomKey)
		_, _ = expand.Write(previous)
		_, _ = expand.Write(info)
		_, _ = expand.Write([]byte{byte(blockIndex)})
		previous = expand.Sum(nil)
		result = append(result, previous...)
	}
	return result[:keyLength], nil
}

func decryptGCM(key, nonce, ciphertext, aad []byte) ([]byte, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("AES-256-GCM key has %d bytes instead of 32", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, fmt.Errorf("AES-GCM nonce has %d bytes instead of %d", len(nonce), gcm.NonceSize())
	}
	if len(ciphertext) < gcm.Overhead() {
		return nil, errors.New("AES-GCM ciphertext is shorter than its authentication tag")
	}
	return gcm.Open(nil, nonce, ciphertext, aad)
}

func unwrapKey(raw wrappedKey, wrappingKey, aad []byte, label string) ([]byte, error) {
	nonce, err := decodeBase64URL(raw.Nonce, 12, label+" nonce")
	if err != nil {
		return nil, err
	}
	ciphertext, err := decodeBase64URL(raw.Ciphertext, 48, label+" ciphertext")
	if err != nil {
		return nil, err
	}
	plaintext, err := decryptGCM(wrappingKey, nonce, ciphertext, aad)
	if err != nil {
		return nil, err
	}
	if len(plaintext) != 32 {
		zero(plaintext)
		return nil, fmt.Errorf("%s plaintext has %d bytes instead of 32", label, len(plaintext))
	}
	return plaintext, nil
}

func readJSON(path string, destination any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !utf8.Valid(data) {
		return fmt.Errorf("%s is not valid UTF-8 JSON", path)
	}
	if err := json.Unmarshal(data, destination); err != nil {
		return fmt.Errorf("invalid JSON in %s: %w", path, err)
	}
	return nil
}

func findStorageRoot(input string) (string, error) {
	cleaned, err := filepath.Abs(input)
	if err != nil {
		return "", err
	}
	if filepath.Base(cleaned) == "naidan-storage" {
		return cleaned, nil
	}
	nested := filepath.Join(cleaned, "naidan-storage")
	if info, statErr := os.Stat(nested); statErr == nil && info.IsDir() {
		return nested, nil
	} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return "", statErr
	}
	return cleaned, nil
}

func readEncryptionState(storageRoot string) (*encryptionState, error) {
	type candidate struct {
		sequence int64
		state    *encryptionState
		parseErr error
	}
	candidates := make([]candidate, 0, 2)
	for _, slot := range []int{0, 1} {
		path := filepath.Join(storageRoot, "encryption-state", fmt.Sprintf("state-%d.json", slot))
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !utf8.Valid(data) {
			continue
		}
		var envelope struct {
			FormatVersion int64 `json:"formatVersion"`
			Sequence      int64 `json:"sequence"`
		}
		if err := json.Unmarshal(data, &envelope); err != nil || envelope.FormatVersion < 1 || !isSafeNonNegative(envelope.Sequence) {
			continue
		}
		var value encryptionState
		parseErr := json.Unmarshal(data, &value)
		if parseErr == nil {
			if value.FormatVersion != 1 {
				parseErr = unsupportedFormatError{message: fmt.Sprintf("encryption state format is unsupported: %d", value.FormatVersion)}
			} else if value.State != "encrypted" && value.State != "transitioning" {
				parseErr = unsupportedFormatError{message: fmt.Sprintf("encryption state is unsupported: %s", value.State)}
			} else if len(value.KeySlots) < 1 || len(value.KeySlots) > maxEncryptionKeySlots {
				parseErr = fmt.Errorf("encryption state must contain between 1 and %d key slots", maxEncryptionKeySlots)
			}
		}
		candidates = append(candidates, candidate{sequence: envelope.Sequence, state: &value, parseErr: parseErr})
	}
	sort.Slice(candidates, func(left, right int) bool { return candidates[left].sequence > candidates[right].sequence })
	if len(candidates) >= 2 && candidates[0].sequence == candidates[1].sequence {
		return nil, errors.New("encryption state slots have the same sequence")
	}
	if len(candidates) == 0 {
		return nil, errors.New("no valid encryption state slot exists")
	}
	if candidates[0].parseErr != nil {
		return nil, fmt.Errorf("newest encryption state is unsupported or structurally invalid: %w", candidates[0].parseErr)
	}
	return candidates[0].state, nil
}

func chooseStoreID(state *encryptionState, explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if state.State == "encrypted" {
		if state.ActiveEncryptedStoreID == "" {
			return "", errors.New("encrypted state has no active store ID")
		}
		return state.ActiveEncryptedStoreID, nil
	}
	if state.Operation == nil {
		return "", errors.New("transitioning state has no operation")
	}
	switch state.Operation.Type {
	case "encrypting":
		if state.Operation.Phase != "cleaning_up_source" {
			return "", errors.New("encrypted target is not authoritative yet; pass -store-id only to inspect an explicitly chosen incomplete store")
		}
		return state.Operation.TargetEncryptedStoreID, nil
	case "decrypting":
		return state.Operation.SourceEncryptedStoreID, nil
	case "reencrypting":
		if state.Operation.Phase == "cleaning_up_source" {
			return state.Operation.TargetEncryptedStoreID, nil
		}
		if state.Operation.Phase == "building_target" {
			return state.Operation.SourceEncryptedStoreID, nil
		}
		return "", unsupportedFormatError{message: fmt.Sprintf("encryption operation phase is unsupported: %s", state.Operation.Phase)}
	default:
		return "", unsupportedFormatError{message: fmt.Sprintf("encryption operation is unsupported: %s", state.Operation.Type)}
	}
}

func readStoreHeader(storageRoot, storeID string) (*storeHeader, error) {
	var header storeHeader
	if err := readJSON(filepath.Join(storageRoot, "encrypted-stores", storeID, "header.json"), &header); err != nil {
		return nil, err
	}
	if header.FormatVersion != 1 {
		return nil, unsupportedFormatError{message: fmt.Sprintf("encrypted store header format is unsupported: %d", header.FormatVersion)}
	}
	if header.EncryptedStoreID != storeID {
		return nil, errors.New("encrypted store header ID does not match its directory")
	}
	if err := validateStableID(header.FileSystemID, "encrypted store fileSystemId"); err != nil {
		return nil, err
	}
	return &header, nil
}

func unlockStorageUnlockKey(state *encryptionState, passphrase string) ([]byte, error) {
	if len(state.KeySlots) < 1 || len(state.KeySlots) > maxEncryptionKeySlots {
		return nil, fmt.Errorf("encryption state must contain between 1 and %d key slots", maxEncryptionKeySlots)
	}
	secret := []byte(passphrase)
	defer zero(secret)
	for _, slot := range state.KeySlots {
		if slot.ID == "" {
			return nil, errors.New("encryption key slot ID is empty")
		}
		if slot.KeyDerivation.Type != "pbkdf2_hmac_sha256" {
			return nil, unsupportedFormatError{message: fmt.Sprintf("key derivation is unsupported: %s", slot.KeyDerivation.Type)}
		}
		if slot.KeyDerivation.Iterations < 1 || slot.KeyDerivation.Iterations > maxPBKDF2Iterations {
			return nil, fmt.Errorf("PBKDF2 iteration count exceeds %d or is not positive", maxPBKDF2Iterations)
		}
		salt, err := decodeBase64URL(slot.KeyDerivation.Salt, 32, "PBKDF2 salt")
		if err != nil {
			return nil, err
		}
		wrappingKey, err := pbkdf2SHA256(secret, salt, int(slot.KeyDerivation.Iterations), 32)
		zero(salt)
		if err != nil {
			return nil, err
		}
		key, unwrapErr := unwrapKey(
			slot.WrappedStorageUnlockKey,
			wrappingKey,
			[]byte("naidan/opfs-encryption/storage-unlock-key/v1/"+slot.ID),
			"wrapped Storage Unlock Key",
		)
		zero(wrappingKey)
		if unwrapErr == nil {
			return key, nil
		}
	}
	return nil, errors.New("passphrase did not unlock any encryption key slot")
}

func unwrapFileSystemRootKey(storageUnlockKey []byte, header *storeHeader) ([]byte, error) {
	return unwrapKey(
		header.WrappedFileSystemRootKey,
		storageUnlockKey,
		[]byte("naidan/opfs-encryption/store-root-key/v1/"+header.EncryptedStoreID),
		"wrapped file-system root key",
	)
}

func (reader *hizoFSReader) deriveObjectKey(identity, area string) ([]byte, error) {
	return hkdfSHA256(
		reader.rootKey,
		[]byte("HizoFS/v1/filesystem/"+reader.fileSystemID),
		[]byte("HizoFS/v1/"+area+"/"+identity),
		32,
	)
}

func (reader *hizoFSReader) readPhysical(identity, area string) ([]byte, error) {
	var path string
	if area == "object" {
		objectBytes, err := decodeBase64URL(identity, objectIDByteLength, "HizoFS object ID")
		if err != nil {
			return nil, err
		}
		path = filepath.Join(reader.dataDirectory, "objects", fmt.Sprintf("%02x", objectBytes[0]), identity+".enc")
	} else if area == "superblock" {
		if identity != "superblock-0" && identity != "superblock-1" {
			return nil, errors.New("invalid HizoFS superblock identity")
		}
		path = filepath.Join(reader.dataDirectory, identity+".enc")
	} else {
		return nil, unsupportedFormatError{message: fmt.Sprintf("unsupported HizoFS area: %s", area)}
	}
	return os.ReadFile(path)
}

func decodeEnvelope(physical []byte) (nonce, ciphertext []byte, err error) {
	if len(physical) < objectHeaderByteLength+aesGCMTagByteLength {
		return nil, nil, errors.New("HizoFS object is truncated")
	}
	if !bytes.Equal(physical[:len(objectMagic)], objectMagic) {
		return nil, nil, errors.New("HizoFS object magic is invalid")
	}
	version := binary.BigEndian.Uint16(physical[8:10])
	if version != objectEnvelopeVersion {
		return nil, nil, unsupportedFormatError{message: fmt.Sprintf("HizoFS object envelope version is unsupported: %d", version)}
	}
	headerLength := binary.BigEndian.Uint16(physical[10:12])
	if headerLength != objectHeaderByteLength {
		return nil, nil, unsupportedFormatError{message: fmt.Sprintf("HizoFS object header length is unsupported: %d", headerLength)}
	}
	ciphertextLength := binary.BigEndian.Uint64(physical[24:32])
	if ciphertextLength > uint64(maxSafeInteger) || uint64(len(physical)) != uint64(objectHeaderByteLength)+ciphertextLength {
		return nil, nil, errors.New("HizoFS object ciphertext length does not match the envelope")
	}
	return physical[12:24], physical[objectHeaderByteLength:], nil
}

func decodeRecord(plaintext []byte) (*record, error) {
	if len(plaintext) < recordHeaderByteLength {
		return nil, errors.New("HizoFS record is truncated")
	}
	kind, ok := recordKinds[plaintext[0]]
	if !ok {
		return nil, unsupportedFormatError{message: fmt.Sprintf("HizoFS record kind is unsupported: %d", plaintext[0])}
	}
	if plaintext[1] != 0 {
		return nil, unsupportedFormatError{message: fmt.Sprintf("HizoFS record payload encoding is unsupported: %d", plaintext[1])}
	}
	recordVersion := binary.BigEndian.Uint16(plaintext[2:4])
	metadataLength := uint64(binary.BigEndian.Uint32(plaintext[4:8]))
	binaryLength := binary.BigEndian.Uint64(plaintext[8:16])
	if binaryLength > uint64(maxSafeInteger) || uint64(len(plaintext)) != uint64(recordHeaderByteLength)+metadataLength+binaryLength {
		return nil, errors.New("HizoFS record lengths do not match the plaintext")
	}
	metadataStart := recordHeaderByteLength
	metadataEnd := metadataStart + int(metadataLength)
	metadata := append([]byte(nil), plaintext[metadataStart:metadataEnd]...)
	if !utf8.Valid(metadata) || !json.Valid(metadata) {
		return nil, errors.New("HizoFS record metadata is invalid UTF-8 JSON")
	}
	return &record{
		Kind:          kind,
		RecordVersion: recordVersion,
		Metadata:      metadata,
		Binary:        append([]byte(nil), plaintext[metadataEnd:]...),
	}, nil
}

func (reader *hizoFSReader) readRecord(identity, area string) (*record, error) {
	physical, err := reader.readPhysical(identity, area)
	if err != nil {
		return nil, err
	}
	nonce, ciphertext, err := decodeEnvelope(physical)
	if err != nil {
		return nil, err
	}
	key, err := reader.deriveObjectKey(identity, area)
	if err != nil {
		return nil, err
	}
	defer zero(key)
	plaintext, err := decryptGCM(
		key,
		nonce,
		ciphertext,
		[]byte("HizoFS/v1/"+area+"/"+reader.fileSystemID+"/"+identity),
	)
	if err != nil {
		return nil, fmt.Errorf("HizoFS %s authentication failed: %w", area, err)
	}
	defer zero(plaintext)
	return decodeRecord(plaintext)
}

func (reader *hizoFSReader) readObject(objectID string) (*record, error) {
	if err := validateObjectID(objectID, "HizoFS object ID"); err != nil {
		return nil, err
	}
	return reader.readRecord(objectID, "object")
}

func (reader *hizoFSReader) readActiveSuperblock() (*superblock, error) {
	type candidate struct {
		value *superblock
	}
	candidates := make([]candidate, 0, 2)
	corruptions := make([]error, 0, 2)
	for _, slot := range []int{0, 1} {
		identity := fmt.Sprintf("superblock-%d", slot)
		record, err := reader.readRecord(identity, "superblock")
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			var unsupported unsupportedFormatError
			if errors.As(err, &unsupported) {
				return nil, err
			}
			corruptions = append(corruptions, err)
			continue
		}
		if record.Kind != "superblock" {
			return nil, unsupportedFormatError{message: fmt.Sprintf("HizoFS superblock slot %d has an unsupported record kind", slot)}
		}
		if record.RecordVersion != 1 {
			return nil, unsupportedFormatError{message: fmt.Sprintf("HizoFS superblock record version is unsupported: %d", record.RecordVersion)}
		}
		if len(record.Binary) != 0 {
			return nil, errors.New("HizoFS superblock contains an unexpected binary payload")
		}
		var value superblock
		if err := json.Unmarshal(record.Metadata, &value); err != nil {
			corruptions = append(corruptions, err)
			continue
		}
		if value.FileSystemID != reader.fileSystemID || !isSafeNonNegative(value.Sequence) {
			corruptions = append(corruptions, errors.New("HizoFS superblock metadata is invalid"))
			continue
		}
		if err := validateObjectID(value.ActiveCommitObjectID, "active commit object ID"); err != nil {
			corruptions = append(corruptions, err)
			continue
		}
		candidates = append(candidates, candidate{value: &value})
	}
	sort.Slice(candidates, func(left, right int) bool { return candidates[left].value.Sequence > candidates[right].value.Sequence })
	if len(candidates) >= 2 && candidates[0].value.Sequence == candidates[1].value.Sequence {
		return nil, errors.New("HizoFS superblock slots have the same sequence")
	}
	if len(candidates) == 0 {
		if len(corruptions) > 0 {
			return nil, fmt.Errorf("no valid HizoFS superblock slot remains: %w", errors.Join(corruptions...))
		}
		return nil, errors.New("HizoFS superblock is missing")
	}
	return candidates[0].value, nil
}

func loadInodeIndex(reader *hizoFSReader, rootObjectID string) (map[string]string, error) {
	result := make(map[string]string)
	visiting := make(map[string]bool)
	visited := make(map[string]bool)
	var visit func(string) error
	visit = func(objectID string) error {
		if visiting[objectID] {
			return errors.New("inode index contains a cycle")
		}
		if visited[objectID] {
			return errors.New("inode index page is referenced more than once")
		}
		visiting[objectID] = true
		defer delete(visiting, objectID)
		visited[objectID] = true
		record, err := reader.readObject(objectID)
		if err != nil {
			return err
		}
		if record.Kind != "inode_index_page" || record.RecordVersion != 1 || len(record.Binary) != 0 {
			return errors.New("inode index page has an invalid record kind, version, or binary payload")
		}
		var page inodeIndexPage
		if err := json.Unmarshal(record.Metadata, &page); err != nil {
			return err
		}
		switch page.Type {
		case "leaf":
			previous := ""
			for index, entry := range page.Entries {
				if err := validateStableID(entry.NodeID, "inode index node ID"); err != nil {
					return err
				}
				if err := validateObjectID(entry.InodeObjectID, "inode object ID"); err != nil {
					return err
				}
				if index > 0 && previous >= entry.NodeID {
					return errors.New("inode index leaf entries are not strictly sorted")
				}
				if _, exists := result[entry.NodeID]; exists {
					return errors.New("inode index contains a duplicate node ID")
				}
				result[entry.NodeID] = entry.InodeObjectID
				previous = entry.NodeID
			}
		case "branch":
			previous := ""
			for index, child := range page.Children {
				if err := validateStableID(child.UpperBoundNodeID, "inode index upper bound"); err != nil {
					return err
				}
				if err := validateObjectID(child.ChildPageObjectID, "inode index child object ID"); err != nil {
					return err
				}
				if index > 0 && previous >= child.UpperBoundNodeID {
					return errors.New("inode index branch bounds are not strictly sorted")
				}
				if err := visit(child.ChildPageObjectID); err != nil {
					return err
				}
				previous = child.UpperBoundNodeID
			}
		default:
			return unsupportedFormatError{message: fmt.Sprintf("inode index page type is unsupported: %s", page.Type)}
		}
		return nil
	}
	if err := visit(rootObjectID); err != nil {
		return nil, err
	}
	return result, nil
}

func loadDirectoryEntries(reader *hizoFSReader, inode *directoryInode) ([]directoryEntry, error) {
	var entries []directoryEntry
	if inode.Storage.Type == "inline" {
		entries = append(entries, inode.Storage.Entries...)
	} else if inode.Storage.Type == "indexed" {
		if err := validateObjectID(inode.Storage.DirectoryIndexRootObjectID, "directory index root object ID"); err != nil {
			return nil, err
		}
		visiting := make(map[string]bool)
		visited := make(map[string]bool)
		var visit func(string) error
		visit = func(objectID string) error {
			if visiting[objectID] {
				return errors.New("directory index contains a cycle")
			}
			if visited[objectID] {
				return errors.New("directory index page is referenced more than once")
			}
			visiting[objectID] = true
			defer delete(visiting, objectID)
			visited[objectID] = true
			record, err := reader.readObject(objectID)
			if err != nil {
				return err
			}
			if record.Kind != "directory_index_page" || record.RecordVersion != 1 || len(record.Binary) != 0 {
				return errors.New("directory index page has an invalid record kind, version, or binary payload")
			}
			var page directoryIndexPage
			if err := json.Unmarshal(record.Metadata, &page); err != nil {
				return err
			}
			switch page.Type {
			case "leaf":
				entries = append(entries, page.Entries...)
			case "branch":
				previous := ""
				for index, child := range page.Children {
					if err := validateEntryName(child.UpperBoundName); err != nil {
						return err
					}
					if err := validateObjectID(child.ChildPageObjectID, "directory index child object ID"); err != nil {
						return err
					}
					if index > 0 && previous >= child.UpperBoundName {
						return errors.New("directory index branch bounds are not strictly sorted")
					}
					if err := visit(child.ChildPageObjectID); err != nil {
						return err
					}
					previous = child.UpperBoundName
				}
			default:
				return unsupportedFormatError{message: fmt.Sprintf("directory index page type is unsupported: %s", page.Type)}
			}
			return nil
		}
		if err := visit(inode.Storage.DirectoryIndexRootObjectID); err != nil {
			return nil, err
		}
	} else {
		return nil, unsupportedFormatError{message: fmt.Sprintf("directory storage is unsupported: %s", inode.Storage.Type)}
	}
	for index, entry := range entries {
		if err := validateEntryName(entry.Name); err != nil {
			return nil, err
		}
		if err := validateStableID(entry.NodeID, "directory entry node ID"); err != nil {
			return nil, err
		}
		if entry.Kind != "file" && entry.Kind != "directory" && entry.Kind != "symlink" {
			return nil, unsupportedFormatError{message: fmt.Sprintf("directory entry kind is unsupported: %s", entry.Kind)}
		}
		if index > 0 && entries[index-1].Name >= entry.Name {
			return nil, errors.New("directory entries are not strictly sorted and unique")
		}
	}
	return entries, nil
}

func loadExtents(reader *hizoFSReader, rootObjectID string) ([]extent, error) {
	if err := validateObjectID(rootObjectID, "extent index root object ID"); err != nil {
		return nil, err
	}
	result := make([]extent, 0)
	visiting := make(map[string]bool)
	visited := make(map[string]bool)
	var visit func(string) error
	visit = func(objectID string) error {
		if visiting[objectID] {
			return errors.New("extent index contains a cycle")
		}
		if visited[objectID] {
			return errors.New("extent index page is referenced more than once")
		}
		visiting[objectID] = true
		defer delete(visiting, objectID)
		visited[objectID] = true
		record, err := reader.readObject(objectID)
		if err != nil {
			return err
		}
		if record.Kind != "file_extent_page" || record.RecordVersion != 1 || len(record.Binary) != 0 {
			return errors.New("file extent page has an invalid record kind, version, or binary payload")
		}
		var page extentPage
		if err := json.Unmarshal(record.Metadata, &page); err != nil {
			return err
		}
		switch page.Type {
		case "leaf":
			for _, item := range page.Extents {
				if !isSafeNonNegative(item.ChunkIndex) {
					return errors.New("file extent chunk index is invalid")
				}
				if err := validateObjectID(item.ChunkObjectID, "file chunk object ID"); err != nil {
					return err
				}
				result = append(result, item)
			}
		case "branch":
			var previous int64 = -1
			for _, child := range page.Children {
				if !isSafeNonNegative(child.UpperBoundChunkIndex) || child.UpperBoundChunkIndex <= previous {
					return errors.New("extent index bounds are not strictly sorted")
				}
				if err := validateObjectID(child.ChildPageObjectID, "extent child object ID"); err != nil {
					return err
				}
				if err := visit(child.ChildPageObjectID); err != nil {
					return err
				}
				previous = child.UpperBoundChunkIndex
			}
		default:
			return unsupportedFormatError{message: fmt.Sprintf("extent page type is unsupported: %s", page.Type)}
		}
		return nil
	}
	if err := visit(rootObjectID); err != nil {
		return nil, err
	}
	for index := 1; index < len(result); index++ {
		if result[index-1].ChunkIndex >= result[index].ChunkIndex {
			return nil, errors.New("file extents are not strictly sorted and unique")
		}
	}
	return result, nil
}

func ensurePathInside(root, candidate string) (string, error) {
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	cleanCandidate, err := filepath.Abs(candidate)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(cleanRoot, cleanCandidate)
	if err != nil {
		return "", err
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("recovered path escapes the output directory: %s", candidate)
	}
	return cleanCandidate, nil
}

func safeSymlinkTarget(outputRoot, linkPath, target string) (string, error) {
	if strings.ContainsRune(target, 0) {
		return "", errors.New("symlink target contains a null character")
	}
	virtualParent, err := filepath.Rel(outputRoot, filepath.Dir(linkPath))
	if err != nil {
		return "", err
	}
	resolvedParts := make([]string, 0)
	if !strings.HasPrefix(strings.ReplaceAll(target, "\\", "/"), "/") && virtualParent != "." {
		resolvedParts = append(resolvedParts, strings.Split(filepath.ToSlash(virtualParent), "/")...)
	}
	for _, part := range strings.Split(strings.ReplaceAll(target, "\\", "/"), "/") {
		switch part {
		case "", ".":
			continue
		case "..":
			if len(resolvedParts) == 0 {
				return "", fmt.Errorf("symlink target escapes the recovered root: %s", target)
			}
			resolvedParts = resolvedParts[:len(resolvedParts)-1]
		default:
			resolvedParts = append(resolvedParts, part)
		}
	}
	targetPath, err := ensurePathInside(outputRoot, filepath.Join(append([]string{outputRoot}, resolvedParts...)...))
	if err != nil {
		return "", err
	}
	relativeTarget, err := filepath.Rel(filepath.Dir(linkPath), targetPath)
	if err != nil {
		return "", err
	}
	if relativeTarget == "" {
		return ".", nil
	}
	return relativeTarget, nil
}

func readTypedInode(reader *hizoFSReader, inodeIndex map[string]string, nodeID, expectedKind string, destination any) (string, *record, error) {
	objectID, exists := inodeIndex[nodeID]
	if !exists {
		return "", nil, fmt.Errorf("node is missing from inode index: %s", nodeID)
	}
	record, err := reader.readObject(objectID)
	if err != nil {
		return "", nil, err
	}
	if record.Kind != expectedKind+"_inode" || record.RecordVersion != 1 {
		return "", nil, fmt.Errorf("node kind or record version mismatch for %s", nodeID)
	}
	if err := json.Unmarshal(record.Metadata, destination); err != nil {
		return "", nil, err
	}
	return objectID, record, nil
}

func restoreFile(reader *hizoFSReader, inode *fileInode, inodeRecord *record, outputPath string) (returnErr error) {
	if err := validateStableID(inode.NodeID, "file inode node ID"); err != nil {
		return err
	}
	if !isSafeNonNegative(inode.Revision) || !isSafeNonNegative(inode.Size) {
		return errors.New("file inode revision or size is invalid")
	}
	switch inode.Storage.Type {
	case "inline":
		if int64(len(inodeRecord.Binary)) != inode.Size {
			return errors.New("inline file payload length does not match file size")
		}
		return os.WriteFile(outputPath, inodeRecord.Binary, 0o600)
	case "extents":
		if inode.Storage.ChunkSize < 1 || inode.Storage.ChunkSize > maxSafeInteger {
			return errors.New("file chunk size is invalid")
		}
		extents, err := loadExtents(reader, inode.Storage.ExtentIndexRootObjectID)
		if err != nil {
			return err
		}
		file, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		defer func() {
			if closeErr := file.Close(); returnErr == nil && closeErr != nil {
				returnErr = closeErr
			}
		}()
		for _, item := range extents {
			offset := item.ChunkIndex * inode.Storage.ChunkSize
			if offset < 0 || offset >= inode.Size || offset > maxSafeInteger {
				return errors.New("file extent lies outside file size")
			}
			chunkRecord, err := reader.readObject(item.ChunkObjectID)
			if err != nil {
				return err
			}
			if chunkRecord.Kind != "file_chunk" || chunkRecord.RecordVersion != 1 {
				return errors.New("file chunk has an invalid kind or record version")
			}
			var metadata fileChunkMetadata
			if err := json.Unmarshal(chunkRecord.Metadata, &metadata); err != nil {
				return err
			}
			if metadata.NodeID != inode.NodeID || metadata.ChunkIndex != item.ChunkIndex {
				return errors.New("file chunk identity does not match its extent")
			}
			if len(chunkRecord.Binary) < 1 || int64(len(chunkRecord.Binary)) > inode.Storage.ChunkSize || offset+int64(len(chunkRecord.Binary)) > inode.Size {
				return errors.New("file chunk payload length is invalid")
			}
			if _, err := file.WriteAt(chunkRecord.Binary, offset); err != nil {
				return err
			}
		}
		return file.Truncate(inode.Size)
	default:
		return unsupportedFormatError{message: fmt.Sprintf("file storage is unsupported: %s", inode.Storage.Type)}
	}
}

func restoreFileSystem(reader *hizoFSReader, activeCommit *commit, outputRoot string) error {
	if !isSafeNonNegative(activeCommit.Revision) {
		return errors.New("HizoFS commit revision is invalid")
	}
	if err := validateStableID(activeCommit.RootDirectoryNodeID, "root directory node ID"); err != nil {
		return err
	}
	if err := validateObjectID(activeCommit.InodeIndexRootObjectID, "inode index root object ID"); err != nil {
		return err
	}
	inodeIndex, err := loadInodeIndex(reader, activeCommit.InodeIndexRootObjectID)
	if err != nil {
		return err
	}
	activeStack := make(map[string]bool)
	restoredNodes := make(map[string]bool)

	var restoreDirectory func(string, string) error
	restoreDirectory = func(nodeID, outputPath string) error {
		if activeStack[nodeID] {
			return errors.New("directory graph contains a cycle")
		}
		if restoredNodes[nodeID] {
			return errors.New("multiple directory entries reference the same node")
		}
		activeStack[nodeID] = true
		defer delete(activeStack, nodeID)
		restoredNodes[nodeID] = true
		var inode directoryInode
		_, inodeRecord, err := readTypedInode(reader, inodeIndex, nodeID, "directory", &inode)
		if err != nil {
			return err
		}
		if len(inodeRecord.Binary) != 0 || inode.NodeID != nodeID || !isSafeNonNegative(inode.Revision) {
			return errors.New("directory inode metadata is invalid")
		}
		if err := os.Mkdir(outputPath, 0o700); err != nil {
			return err
		}
		entries, err := loadDirectoryEntries(reader, &inode)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			childPath, err := ensurePathInside(outputRoot, filepath.Join(outputPath, entry.Name))
			if err != nil {
				return err
			}
			switch entry.Kind {
			case "directory":
				if err := restoreDirectory(entry.NodeID, childPath); err != nil {
					return err
				}
			case "file":
				if restoredNodes[entry.NodeID] {
					return errors.New("multiple directory entries reference the same node")
				}
				restoredNodes[entry.NodeID] = true
				var fileNode fileInode
				_, fileRecord, err := readTypedInode(reader, inodeIndex, entry.NodeID, "file", &fileNode)
				if err != nil {
					return err
				}
				if fileNode.NodeID != entry.NodeID {
					return errors.New("file inode node ID does not match its index key")
				}
				if err := restoreFile(reader, &fileNode, fileRecord, childPath); err != nil {
					return err
				}
			case "symlink":
				if restoredNodes[entry.NodeID] {
					return errors.New("multiple directory entries reference the same node")
				}
				restoredNodes[entry.NodeID] = true
				var linkNode symlinkInode
				_, linkRecord, err := readTypedInode(reader, inodeIndex, entry.NodeID, "symlink", &linkNode)
				if err != nil {
					return err
				}
				if len(linkRecord.Binary) != 0 || linkNode.NodeID != entry.NodeID || !isSafeNonNegative(linkNode.Revision) {
					return errors.New("symlink inode metadata is invalid")
				}
				target, err := safeSymlinkTarget(outputRoot, childPath, linkNode.Target)
				if err != nil {
					return err
				}
				if err := os.Symlink(target, childPath); err != nil {
					return err
				}
			default:
				return unsupportedFormatError{message: fmt.Sprintf("directory entry kind is unsupported: %s", entry.Kind)}
			}
		}
		return nil
	}

	if err := restoreDirectory(activeCommit.RootDirectoryNodeID, outputRoot); err != nil {
		return err
	}
	if len(restoredNodes) != len(inodeIndex) {
		return errors.New("inode index contains unreachable nodes")
	}
	return nil
}

func run(input, output, passphrase, explicitStoreID string) error {
	storageRoot, err := findStorageRoot(input)
	if err != nil {
		return err
	}
	state, err := readEncryptionState(storageRoot)
	if err != nil {
		return err
	}
	storeID, err := chooseStoreID(state, explicitStoreID)
	if err != nil {
		return err
	}
	header, err := readStoreHeader(storageRoot, storeID)
	if err != nil {
		return err
	}
	storageUnlockKey, err := unlockStorageUnlockKey(state, passphrase)
	if err != nil {
		return err
	}
	fileSystemRootKey, err := unwrapFileSystemRootKey(storageUnlockKey, header)
	zero(storageUnlockKey)
	if err != nil {
		return err
	}
	defer zero(fileSystemRootKey)

	dataDirectory := filepath.Join(storageRoot, "encrypted-stores", storeID, "filesystem.hizofs")
	var descriptorValue descriptor
	if err := readJSON(filepath.Join(dataDirectory, "descriptor.json"), &descriptorValue); err != nil {
		return err
	}
	if descriptorValue.Format != "hizofs" {
		return unsupportedFormatError{message: fmt.Sprintf("HizoFS descriptor identifier is unsupported: %s", descriptorValue.Format)}
	}
	if descriptorValue.FormatVersion != 1 {
		return unsupportedFormatError{message: fmt.Sprintf("HizoFS descriptor format is unsupported: %d", descriptorValue.FormatVersion)}
	}
	if err := validateStableID(descriptorValue.FileSystemID, "HizoFS fileSystemId"); err != nil {
		return err
	}
	if descriptorValue.FileSystemID != header.FileSystemID {
		return errors.New("encrypted store header and descriptor fileSystemId disagree")
	}
	reader := &hizoFSReader{
		dataDirectory: dataDirectory,
		fileSystemID:  descriptorValue.FileSystemID,
		rootKey:       fileSystemRootKey,
	}
	activeSuperblock, err := reader.readActiveSuperblock()
	if err != nil {
		return err
	}
	commitRecord, err := reader.readObject(activeSuperblock.ActiveCommitObjectID)
	if err != nil {
		return err
	}
	if commitRecord.Kind != "commit" || commitRecord.RecordVersion != 1 || len(commitRecord.Binary) != 0 {
		return errors.New("active commit object has an invalid kind, version, or binary payload")
	}
	var activeCommit commit
	if err := json.Unmarshal(commitRecord.Metadata, &activeCommit); err != nil {
		return err
	}
	if _, err := os.Lstat(output); err == nil {
		return fmt.Errorf("output path already exists: %s", output)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporaryOutput := fmt.Sprintf("%s.partial-%d", output, os.Getpid())
	if err := os.RemoveAll(temporaryOutput); err != nil {
		return err
	}
	if err := restoreFileSystem(reader, &activeCommit, temporaryOutput); err != nil {
		_ = os.RemoveAll(temporaryOutput)
		return err
	}
	if err := os.Rename(temporaryOutput, output); err != nil {
		_ = os.RemoveAll(temporaryOutput)
		return err
	}
	return nil
}

func main() {
	input := flag.String("input", "", "raw OPFS export root or naidan-storage directory")
	output := flag.String("output", "", "output directory, which must not exist")
	passphrase := flag.String("passphrase", "", "exact encryption passphrase")
	storeID := flag.String("store-id", "", "explicit encrypted store ID")
	flag.Parse()
	if *input == "" || *output == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(*input, *output, *passphrase, *storeID); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "naidan-recover: %v\n", err)
		os.Exit(1)
	}
	_, _ = fmt.Fprintf(os.Stdout, "Recovered HizoFS to %s\n", *output)
}
