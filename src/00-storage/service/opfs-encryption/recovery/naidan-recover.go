// Naidan OPFS encryption format v1 recovery source.
//
// This single-file implementation uses only the Go standard library. It can
// reconstruct the complete legacy plaintext tree from a raw OPFS export, or
// decrypt one logical object for low-level inspection.
//
// Go 1.23 or later:
//
//	go run naidan-recover.go -input ./raw-opfs -output ./recovered \
//	  -passphrase 'correct horse battery staple'
//
// Low-level object mode:
//
//	go run naidan-recover.go -input ./raw-opfs -output hierarchy.json \
//	  -namespace singleton -key hierarchy \
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
)

var (
	wrappedKeyAAD            = []byte("naidan/opfs-encryption/wrapped-key/v1")
	objectEncryptionHKDFInfo = []byte("naidan/opfs-encryption/object-encryption-key/v1")
	objectAddressHKDFInfo    = []byte("naidan/opfs-encryption/object-address-key/v1")
	magic                    = []byte("NAIDAN01")
	payloadMagic             = []byte("NPAYLD01")
)

type wrappedKey struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type passphraseKeySlot struct {
	PBKDF2 struct {
		Salt       string `json:"salt"`
		Iterations int    `json:"iterations"`
	} `json:"pbkdf2"`
	WrappedStorageUnlockKey wrappedKey `json:"wrappedStorageUnlockKey"`
}

type operation struct {
	Type                   string `json:"type"`
	Phase                  string `json:"phase"`
	SourceEncryptedStoreID string `json:"sourceEncryptedStoreId"`
	TargetEncryptedStoreID string `json:"targetEncryptedStoreId"`
}

type encryptionState struct {
	FormatVersion          int               `json:"formatVersion"`
	Sequence               int               `json:"sequence"`
	State                  string            `json:"state"`
	PassphraseKeySlot      passphraseKeySlot `json:"passphraseKeySlot"`
	ActiveEncryptedStoreID string            `json:"activeEncryptedStoreId"`
	Operation              *operation        `json:"operation"`
}

type storeHeader struct {
	FormatVersion       int        `json:"formatVersion"`
	Sequence            int        `json:"sequence"`
	EncryptedStoreID    string     `json:"encryptedStoreId"`
	EncryptionSuite     string     `json:"encryptionSuite"`
	WrappedStoreRootKey wrappedKey `json:"wrappedStoreRootKey"`
}

type encryptedContext struct {
	StoreDirectory      string
	ObjectEncryptionKey []byte
	ObjectAddressKey    []byte
}

type storeManifest struct {
	ChatMetaShardIDs     []string               `json:"chatMetaShardIds"`
	ChatGroupShardIDs    []string               `json:"chatGroupShardIds"`
	BinaryObjectShardIDs []string               `json:"binaryObjectShardIds"`
	VolumeShardIDs       []string               `json:"volumeShardIds"`
	FileSystems          []fileSystemDescriptor `json:"fileSystems"`
}

type fileSystemDescriptor struct {
	ID              string `json:"id"`
	Type            string `json:"type"`
	SourceID        string `json:"sourceId"`
	RootDirectoryID string `json:"rootDirectoryId"`
}

type chatMetaShardIndex struct {
	ChatIDs []string `json:"chatIds"`
}

type chatGroupShardIndex struct {
	ChatGroupIDs []string `json:"chatGroupIds"`
}

type hierarchyDTO struct {
	Items []hierarchyItem `json:"items"`
}

type hierarchyItem struct {
	Type    string   `json:"type"`
	ID      string   `json:"id"`
	ChatIDs []string `json:"chat_ids"`
}

type binaryShardIndex struct {
	Objects map[string]json.RawMessage `json:"objects"`
}

type binaryObjectMetadata struct {
	ID string `json:"id"`
}

type encryptedFileManifest struct {
	FileID           string    `json:"fileId"`
	LogicalSize      int64     `json:"logicalSize"`
	LogicalChunkSize int64     `json:"logicalChunkSize"`
	ModifiedAt       int64     `json:"modifiedAt"`
	ChunkIDs         []*string `json:"chunkIds"`
}

type encryptedDirectoryManifest struct {
	DirectoryID string   `json:"directoryId"`
	ModifiedAt  int64    `json:"modifiedAt"`
	ShardIDs    []string `json:"shardIds"`
}

type encryptedDirectoryShard struct {
	Entries map[string]encryptedFileSystemEntry `json:"entries"`
}

type encryptedFileSystemEntry struct {
	Type        string `json:"type"`
	Name        string `json:"name"`
	FileID      string `json:"fileId"`
	DirectoryID string `json:"directoryId"`
	TargetPath  string `json:"targetPath"`
	ModifiedAt  int64  `json:"modifiedAt"`
}

func decodeBase64URL(value string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(value)
}

func pbkdf2SHA256(passphrase string, salt []byte, iterations, keyLength int) ([]byte, error) {
	if iterations <= 0 {
		return nil, errors.New("PBKDF2 iterations must be positive")
	}
	if keyLength <= 0 {
		return nil, errors.New("PBKDF2 key length must be positive")
	}

	const digestLength = sha256.Size
	blockCount := (keyLength + digestLength - 1) / digestLength
	if uint64(blockCount) > uint64(^uint32(0)) {
		return nil, errors.New("PBKDF2 output is too large")
	}

	password := []byte(passphrase)
	result := make([]byte, 0, blockCount*digestLength)
	blockIndexBytes := make([]byte, 4)
	for blockIndex := 1; blockIndex <= blockCount; blockIndex++ {
		binary.BigEndian.PutUint32(blockIndexBytes, uint32(blockIndex))
		mac := hmac.New(sha256.New, password)
		_, _ = mac.Write(salt)
		_, _ = mac.Write(blockIndexBytes)
		u := mac.Sum(nil)
		block := append([]byte(nil), u...)

		for iteration := 1; iteration < iterations; iteration++ {
			mac = hmac.New(sha256.New, password)
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

func decodePayloadFrame(frame []byte) ([]byte, error) {
	const headerLength = 17
	if len(frame) < headerLength || !bytes.Equal(frame[:8], payloadMagic) {
		return nil, errors.New("unsupported or truncated encrypted object payload frame")
	}
	if frame[8] != 0 {
		return nil, fmt.Errorf("unsupported encrypted object payload encoding: %d", frame[8])
	}
	plaintextSize := binary.BigEndian.Uint64(frame[9:17])
	payload := frame[headerLength:]
	if plaintextSize != uint64(len(payload)) {
		return nil, fmt.Errorf(
			"encrypted object identity payload size mismatch: expected %d, received %d",
			plaintextSize,
			len(payload),
		)
	}
	return payload, nil
}

func unwrap(raw wrappedKey, wrappingKey []byte) ([]byte, error) {
	nonce, err := decodeBase64URL(raw.Nonce)
	if err != nil {
		return nil, err
	}
	ciphertext, err := decodeBase64URL(raw.Ciphertext)
	if err != nil {
		return nil, err
	}
	plaintext, err := decryptGCM(wrappingKey, nonce, ciphertext, wrappedKeyAAD)
	if err != nil {
		return nil, err
	}
	if len(plaintext) != 32 {
		return nil, fmt.Errorf("unwrapped key has %d bytes instead of 32", len(plaintext))
	}
	return plaintext, nil
}

func readLatestSlot[T interface{ getSequence() int }](directory, prefix string, factory func() T) (T, error) {
	var zero T
	values := make([]T, 0, 2)
	for _, slot := range []int{0, 1} {
		data, err := os.ReadFile(filepath.Join(directory, fmt.Sprintf("%s-%d.json", prefix, slot)))
		if err != nil {
			continue
		}
		value := factory()
		if err := json.Unmarshal(data, value); err == nil && value.getSequence() >= 0 {
			values = append(values, value)
		}
	}
	if len(values) == 0 {
		return zero, fmt.Errorf("no valid %s slot in %s", prefix, directory)
	}
	sort.Slice(values, func(i, j int) bool { return values[i].getSequence() > values[j].getSequence() })
	if len(values) == 2 && values[0].getSequence() == values[1].getSequence() {
		return zero, fmt.Errorf("the %s slots have the same sequence in %s", prefix, directory)
	}
	return values[0], nil
}

func (state *encryptionState) getSequence() int { return state.Sequence }
func (header *storeHeader) getSequence() int    { return header.Sequence }

func selectStoreID(state *encryptionState, explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if state.State == "encrypted" {
		return state.ActiveEncryptedStoreID, nil
	}
	if state.State != "transitioning" || state.Operation == nil {
		return "", fmt.Errorf("unsupported encryption state: %s", state.State)
	}
	switch state.Operation.Type {
	case "decrypting":
		return state.Operation.SourceEncryptedStoreID, nil
	case "reencrypting":
		if state.Operation.Phase == "cleaning_up_source" {
			return state.Operation.TargetEncryptedStoreID, nil
		}
		return state.Operation.SourceEncryptedStoreID, nil
	case "encrypting":
		if state.Operation.Phase != "cleaning_up_source" {
			return "", errors.New("encrypted target is not authoritative; pass -store-id only to inspect a partial target")
		}
		return state.Operation.TargetEncryptedStoreID, nil
	default:
		return "", fmt.Errorf("unsupported operation type: %s", state.Operation.Type)
	}
}

func deriveStorageUnlockKey(state *encryptionState, passphrase string) ([]byte, error) {
	slot := state.PassphraseKeySlot
	salt, err := decodeBase64URL(slot.PBKDF2.Salt)
	if err != nil {
		return nil, fmt.Errorf("invalid passphrase PBKDF2 salt: %w", err)
	}
	wrappingKey, err := pbkdf2SHA256(passphrase, salt, slot.PBKDF2.Iterations, 32)
	if err != nil {
		return nil, err
	}
	key, unwrapErr := unwrap(slot.WrappedStorageUnlockKey, wrappingKey)
	for index := range wrappingKey {
		wrappingKey[index] = 0
	}
	if unwrapErr != nil {
		return nil, fmt.Errorf("passphrase did not unlock storage: %w", unwrapErr)
	}
	return key, nil
}

func canonicalLocator(namespace, key string) []byte {
	namespaceBytes := []byte(namespace)
	keyBytes := []byte(key)
	result := make([]byte, 8+len(namespaceBytes)+len(keyBytes))
	binary.BigEndian.PutUint32(result[0:4], uint32(len(namespaceBytes)))
	copy(result[4:], namespaceBytes)
	offset := 4 + len(namespaceBytes)
	binary.BigEndian.PutUint32(result[offset:offset+4], uint32(len(keyBytes)))
	copy(result[offset+4:], keyBytes)
	return result
}

func deriveKey(rootKey []byte, storeID string, info []byte) ([]byte, error) {
	return hkdfSHA256(rootKey, []byte(storeID), info, 32)
}

func objectIDFor(addressKey []byte, namespace, key string) string {
	hash := hmac.New(sha256.New, addressKey)
	_, _ = hash.Write(canonicalLocator(namespace, key))
	return base64.RawURLEncoding.EncodeToString(hash.Sum(nil))
}

func readObjectIfPresent(context encryptedContext, namespace, key string) ([]byte, bool, error) {
	objectID := objectIDFor(context.ObjectAddressKey, namespace, key)
	physical, err := os.ReadFile(filepath.Join(
		context.StoreDirectory,
		"objects",
		objectID[:2],
		objectID+".bin",
	))
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(physical) < 36 || !bytes.Equal(physical[:8], magic) {
		return nil, false, fmt.Errorf("unsupported or truncated encrypted object: %s", objectID)
	}
	aad := []byte("naidan/opfs-encryption/object/v1/" + objectID)
	frame, err := decryptGCM(
		context.ObjectEncryptionKey,
		physical[8:20],
		physical[20:],
		aad,
	)
	if err != nil {
		return nil, false, err
	}
	plaintext, err := decodePayloadFrame(frame)
	if err != nil {
		return nil, false, err
	}
	return plaintext, true, nil
}

func readObject(context encryptedContext, namespace, key string) ([]byte, error) {
	value, found, err := readObjectIfPresent(context, namespace, key)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("encrypted object is missing: %s/%s", namespace, key)
	}
	return value, nil
}

func readJSONValue[T any](context encryptedContext, namespace, key string) (T, bool, error) {
	var zero T
	data, found, err := readObjectIfPresent(context, namespace, key)
	if err != nil || !found {
		return zero, found, err
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return zero, false, fmt.Errorf("invalid JSON in %s/%s: %w", namespace, key, err)
	}
	return value, true, nil
}

func resolveStorageRoot(input string) (string, error) {
	if filepath.Base(input) == "naidan-storage" {
		return input, nil
	}
	candidate := filepath.Join(input, "naidan-storage")
	info, err := os.Stat(candidate)
	if err == nil && info.IsDir() {
		return candidate, nil
	}
	return "", fmt.Errorf("input does not contain naidan-storage: %s", input)
}

func ensureParent(path string) error {
	return os.MkdirAll(filepath.Dir(path), 0o755)
}

func writeBytes(path string, value []byte) error {
	if err := ensureParent(path); err != nil {
		return err
	}
	return os.WriteFile(path, value, 0o600)
}

func writeObjectIfPresent(context encryptedContext, namespace, key, outputPath string) error {
	value, found, err := readObjectIfPresent(context, namespace, key)
	if err != nil || !found {
		return err
	}
	return writeBytes(outputPath, value)
}

func safeEntryPath(outputDirectory, name string) (string, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return "", fmt.Errorf("encrypted filesystem entry has an unsafe name: %q", name)
	}
	return filepath.Join(outputDirectory, name), nil
}

func sortedSetValues(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func recoverEncryptedFile(context encryptedContext, fileID, outputPath string) (returnErr error) {
	manifest, found, err := readJSONValue[encryptedFileManifest](context, "file_manifest", fileID)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("encrypted file manifest is missing: %s", fileID)
	}
	if manifest.LogicalSize < 0 || manifest.LogicalChunkSize <= 0 {
		return fmt.Errorf("encrypted file manifest has invalid sizes: %s", fileID)
	}
	if err := ensureParent(outputPath); err != nil {
		return err
	}
	output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	completed := false
	defer func() {
		closeErr := output.Close()
		if returnErr == nil && closeErr != nil {
			returnErr = closeErr
		}
		if !completed {
			_ = os.Remove(outputPath)
		}
	}()

	remaining := manifest.LogicalSize
	for _, chunkID := range manifest.ChunkIDs {
		if remaining <= 0 {
			return fmt.Errorf("encrypted file manifest has extra chunks: %s", fileID)
		}
		expected := manifest.LogicalChunkSize
		if remaining < expected {
			expected = remaining
		}
		if expected > int64(^uint(0)>>1) {
			return fmt.Errorf("encrypted file chunk is too large for this platform: %s", fileID)
		}
		var chunk []byte
		if chunkID == nil {
			chunk = make([]byte, int(expected))
		} else {
			chunk, err = readObject(context, "file_chunk", *chunkID)
			if err != nil {
				return err
			}
			if int64(len(chunk)) != expected {
				return fmt.Errorf("encrypted file chunk has an unexpected size: %s", *chunkID)
			}
		}
		if _, err := output.Write(chunk); err != nil {
			return err
		}
		remaining -= expected
	}
	if remaining != 0 {
		return fmt.Errorf("encrypted file manifest does not cover its logical size: %s", fileID)
	}
	completed = true
	return nil
}

func recoverDirectory(
	context encryptedContext,
	directoryID,
	outputDirectory string,
	ancestors map[string]struct{},
) error {
	if _, exists := ancestors[directoryID]; exists {
		return fmt.Errorf("encrypted directory cycle detected: %s", directoryID)
	}
	ancestors[directoryID] = struct{}{}
	defer delete(ancestors, directoryID)

	if err := os.MkdirAll(outputDirectory, 0o755); err != nil {
		return err
	}
	manifest, found, err := readJSONValue[encryptedDirectoryManifest](
		context,
		"directory_manifest",
		directoryID,
	)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("encrypted directory manifest is missing: %s", directoryID)
	}
	for _, shardID := range manifest.ShardIDs {
		shard, found, err := readJSONValue[encryptedDirectoryShard](
			context,
			"directory_shard",
			directoryID+"/"+shardID,
		)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("encrypted directory shard is missing: %s/%s", directoryID, shardID)
		}
		entryIDs := make([]string, 0, len(shard.Entries))
		for entryID := range shard.Entries {
			entryIDs = append(entryIDs, entryID)
		}
		sort.Strings(entryIDs)
		for _, entryID := range entryIDs {
			entry := shard.Entries[entryID]
			outputPath, err := safeEntryPath(outputDirectory, entry.Name)
			if err != nil {
				return err
			}
			switch entry.Type {
			case "file":
				if err := recoverEncryptedFile(context, entry.FileID, outputPath); err != nil {
					return err
				}
			case "directory":
				if err := recoverDirectory(context, entry.DirectoryID, outputPath, ancestors); err != nil {
					return err
				}
			case "symlink":
				value, err := json.Marshal(map[string]string{"targetPath": entry.TargetPath})
				if err != nil {
					return err
				}
				if err := writeBytes(outputPath+".naidan-symlink.json", value); err != nil {
					return err
				}
			default:
				return fmt.Errorf("unsupported encrypted filesystem entry: %s", entry.Type)
			}
		}
	}
	return nil
}

func recoverStore(context encryptedContext, output string) error {
	if err := os.MkdirAll(output, 0o755); err != nil {
		return err
	}
	if err := writeObjectIfPresent(context, "singleton", "settings", filepath.Join(output, "settings.json")); err != nil {
		return err
	}

	hierarchyBytes, hierarchyFound, err := readObjectIfPresent(context, "singleton", "hierarchy")
	if err != nil {
		return err
	}
	if !hierarchyFound {
		hierarchyBytes = []byte(`{"items":[]}`)
	}
	if err := writeBytes(filepath.Join(output, "hierarchy.json"), hierarchyBytes); err != nil {
		return err
	}
	var hierarchy hierarchyDTO
	if err := json.Unmarshal(hierarchyBytes, &hierarchy); err != nil {
		return fmt.Errorf("invalid hierarchy JSON: %w", err)
	}

	manifest, manifestFound, err := readJSONValue[storeManifest](context, "singleton", "store_manifest")
	if err != nil {
		return err
	}
	if !manifestFound {
		manifest = storeManifest{}
	}

	chatIDs := make(map[string]struct{})
	groupIDs := make(map[string]struct{})
	for _, shardID := range manifest.ChatMetaShardIDs {
		index, found, err := readJSONValue[chatMetaShardIndex](context, "chat_meta_shard_index", shardID)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("chat metadata shard index is missing: %s", shardID)
		}
		for _, chatID := range index.ChatIDs {
			chatIDs[chatID] = struct{}{}
		}
	}
	for _, shardID := range manifest.ChatGroupShardIDs {
		index, found, err := readJSONValue[chatGroupShardIndex](context, "chat_group_shard_index", shardID)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("chat group shard index is missing: %s", shardID)
		}
		for _, groupID := range index.ChatGroupIDs {
			groupIDs[groupID] = struct{}{}
		}
	}
	for _, item := range hierarchy.Items {
		switch item.Type {
		case "chat":
			chatIDs[item.ID] = struct{}{}
		case "chat_group":
			groupIDs[item.ID] = struct{}{}
			for _, chatID := range item.ChatIDs {
				chatIDs[chatID] = struct{}{}
			}
		default:
			return fmt.Errorf("unsupported hierarchy item: %s", item.Type)
		}
	}

	for _, chatID := range sortedSetValues(chatIDs) {
		if err := writeObjectIfPresent(
			context,
			"chat_meta",
			chatID,
			filepath.Join(output, "chat-metas", chatID+".json"),
		); err != nil {
			return err
		}
		if err := writeObjectIfPresent(
			context,
			"chat_content",
			chatID,
			filepath.Join(output, "chat-contents", chatID+".json"),
		); err != nil {
			return err
		}
	}
	for _, groupID := range sortedSetValues(groupIDs) {
		if err := writeObjectIfPresent(
			context,
			"chat_group",
			groupID,
			filepath.Join(output, "chat-groups", groupID+".json"),
		); err != nil {
			return err
		}
	}

	for _, shardID := range manifest.BinaryObjectShardIDs {
		indexBytes, found, err := readObjectIfPresent(context, "binary_shard_index", shardID)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("binary-object shard index is missing: %s", shardID)
		}
		var index binaryShardIndex
		if err := json.Unmarshal(indexBytes, &index); err != nil {
			return fmt.Errorf("invalid binary-object shard index %s: %w", shardID, err)
		}
		if err := writeBytes(filepath.Join(output, "binary-objects", shardID, "index.json"), indexBytes); err != nil {
			return err
		}
		objectIDs := make([]string, 0, len(index.Objects))
		for objectID := range index.Objects {
			objectIDs = append(objectIDs, objectID)
		}
		sort.Strings(objectIDs)
		for _, objectID := range objectIDs {
			metadata := binaryObjectMetadata{}
			if err := json.Unmarshal(index.Objects[objectID], &metadata); err != nil {
				return fmt.Errorf("invalid binary-object metadata %s: %w", objectID, err)
			}
			if metadata.ID != "" {
				objectID = metadata.ID
			}
			if err := recoverEncryptedFile(
				context,
				"binary/"+objectID,
				filepath.Join(output, "binary-objects", shardID, objectID+".bin"),
			); err != nil {
				return err
			}
		}
	}

	for _, shardID := range manifest.VolumeShardIDs {
		indexBytes, found, err := readObjectIfPresent(context, "volume_index", shardID)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("volume shard index is missing: %s", shardID)
		}
		if err := writeBytes(filepath.Join(output, "volumes", shardID, "index.json"), indexBytes); err != nil {
			return err
		}
	}

	for _, fileSystem := range manifest.FileSystems {
		var outputDirectory string
		switch fileSystem.Type {
		case "opfs_volume":
			sourcePath, err := safeEntryPath(filepath.Join(output, "recovered-filesystems", "opfs-volumes"), fileSystem.SourceID)
			if err != nil {
				return err
			}
			outputDirectory = sourcePath
		case "chat_wesh", "debug_wesh", "tmp":
			outputDirectory = filepath.Join(output, "recovered-filesystems", fileSystem.Type)
		default:
			return fmt.Errorf("unsupported encrypted filesystem type: %s", fileSystem.Type)
		}
		if err := recoverDirectory(
			context,
			fileSystem.RootDirectoryID,
			outputDirectory,
			make(map[string]struct{}),
		); err != nil {
			return err
		}
	}
	return nil
}

func run() error {
	input := flag.String("input", "", "raw OPFS root or naidan-storage directory")
	output := flag.String("output", "", "output directory, or output file in object mode")
	namespace := flag.String("namespace", "", "optional logical object namespace")
	key := flag.String("key", "", "optional logical object key")
	passphrase := flag.String("passphrase", "", "exact passphrase; boundary spaces are significant")
	storeIDFlag := flag.String("store-id", "", "override encrypted store ID")
	flag.Parse()
	if *input == "" || *output == "" || *passphrase == "" {
		flag.Usage()
		return errors.New("input, output, and passphrase are required")
	}
	if (*namespace == "") != (*key == "") {
		return errors.New("-namespace and -key must be specified together")
	}
	storageRoot, err := resolveStorageRoot(*input)
	if err != nil {
		return err
	}
	state, err := readLatestSlot(
		filepath.Join(storageRoot, "encryption-state"),
		"state",
		func() *encryptionState { return &encryptionState{} },
	)
	if err != nil {
		return err
	}
	if state.FormatVersion != 1 {
		return fmt.Errorf("unsupported encryption-state format version: %d", state.FormatVersion)
	}
	storeID, err := selectStoreID(state, *storeIDFlag)
	if err != nil {
		return err
	}
	storeDirectory := filepath.Join(storageRoot, "encrypted-stores", storeID)
	header, err := readLatestSlot(
		filepath.Join(storeDirectory, "header"),
		"header",
		func() *storeHeader { return &storeHeader{} },
	)
	if err != nil {
		return err
	}
	if header.FormatVersion != 1 || header.EncryptionSuite != "aes_256_gcm_chunked_v1" {
		return fmt.Errorf("unsupported encrypted-store header: version=%d suite=%s", header.FormatVersion, header.EncryptionSuite)
	}
	if header.EncryptedStoreID != storeID {
		return fmt.Errorf("encrypted-store header ID does not match directory: %s", storeID)
	}
	storageUnlockKey, err := deriveStorageUnlockKey(state, *passphrase)
	if err != nil {
		return err
	}
	defer func() {
		for index := range storageUnlockKey {
			storageUnlockKey[index] = 0
		}
	}()
	storeRootKey, err := unwrap(header.WrappedStoreRootKey, storageUnlockKey)
	if err != nil {
		return err
	}
	defer func() {
		for index := range storeRootKey {
			storeRootKey[index] = 0
		}
	}()
	objectEncryptionKey, err := deriveKey(storeRootKey, storeID, objectEncryptionHKDFInfo)
	if err != nil {
		return err
	}
	defer func() {
		for index := range objectEncryptionKey {
			objectEncryptionKey[index] = 0
		}
	}()
	objectAddressKey, err := deriveKey(storeRootKey, storeID, objectAddressHKDFInfo)
	if err != nil {
		return err
	}
	defer func() {
		for index := range objectAddressKey {
			objectAddressKey[index] = 0
		}
	}()
	context := encryptedContext{
		StoreDirectory:      storeDirectory,
		ObjectEncryptionKey: objectEncryptionKey,
		ObjectAddressKey:    objectAddressKey,
	}
	if *namespace != "" {
		plaintext, err := readObject(context, *namespace, *key)
		if err != nil {
			return err
		}
		if err := writeBytes(*output, plaintext); err != nil {
			return err
		}
		fmt.Printf("Recovered %s/%s to %s\n", *namespace, *key, *output)
		return nil
	}
	if err := recoverStore(context, *output); err != nil {
		return err
	}
	fmt.Printf("Recovered encrypted store %s to %s\n", storeID, *output)
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "naidan-recover:", err)
		os.Exit(1)
	}
}
