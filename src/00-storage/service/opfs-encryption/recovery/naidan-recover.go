// Naidan OPFS encryption format v1 recovery source.
//
// This single-file implementation uses only the Go standard library. It can
// reconstruct the released plaintext layout from a raw OPFS export, export the
// encrypted virtual filesystems, or decrypt one logical object for inspection.
//
// Go 1.23 or later:
//
//	go run naidan-recover.go -input ./raw-opfs -output ./recovered \
//	  -passphrase 'correct horse battery staple'
//
// Low-level object mode:
//
//	go run naidan-recover.go -input ./raw-opfs -output hierarchy.json \
//	  -namespace singleton -key hierarchy -area durable \
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
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var (
	objectMagic              = []byte{0x4e, 0x41, 0x49, 0x4f, 0x42, 0x4a, 0x00, 0x00}
	objectEncryptionHKDFInfo = []byte("naidan/opfs-encryption/object-encryption-key/v1")
	objectAddressHKDFInfo    = []byte("naidan/opfs-encryption/object-address-key/v1")
)

const (
	objectFormatVersion     = 1
	objectHeaderByteLength  = 24
	payloadFrameVersion     = 1
	payloadHeaderByteLength = 10
	maxPBKDF2Iterations     = 10_000_000
	maxEncryptionKeySlots   = 32
)

type wrappedKey struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type keyDerivation struct {
	Type       string `json:"type"`
	Salt       string `json:"salt"`
	Iterations int    `json:"iterations"`
}

type encryptionKeySlot struct {
	ID                      string        `json:"id"`
	KeyDerivation           keyDerivation `json:"keyDerivation"`
	WrappedStorageUnlockKey wrappedKey    `json:"wrappedStorageUnlockKey"`
}

type operation struct {
	Type                   string `json:"type"`
	Phase                  string `json:"phase"`
	SourceEncryptedStoreID string `json:"sourceEncryptedStoreId"`
	TargetEncryptedStoreID string `json:"targetEncryptedStoreId"`
}

type encryptionState struct {
	FormatVersion          int                 `json:"formatVersion"`
	Sequence               int                 `json:"sequence"`
	State                  string              `json:"state"`
	KeySlots               []encryptionKeySlot `json:"keySlots"`
	ActiveEncryptedStoreID string              `json:"activeEncryptedStoreId"`
	Operation              *operation          `json:"operation"`
}

type storeHeader struct {
	FormatVersion       int        `json:"formatVersion"`
	Sequence            int        `json:"sequence"`
	EncryptedStoreID    string     `json:"encryptedStoreId"`
	WrappedStoreRootKey wrappedKey `json:"wrappedStoreRootKey"`
}

type sequencedEnvelope struct {
	FormatVersion int `json:"formatVersion"`
	Sequence      int `json:"sequence"`
}

type encryptedObjectTransactionOperation struct {
	Type               string `json:"type"`
	Namespace          string `json:"namespace"`
	Key                string `json:"key"`
	PlaintextBase64URL string `json:"plaintextBase64Url"`
}

type encryptedObjectTransaction struct {
	ID         string                                `json:"id"`
	ScopeID    string                                `json:"scopeId"`
	Operations []encryptedObjectTransactionOperation `json:"operations"`
}

type encryptedTransactionScope struct {
	Area        string
	ScopeID     string
	Transaction encryptedObjectTransaction
}

type encryptedContext struct {
	StoreDirectory      string
	ObjectEncryptionKey []byte
	ObjectAddressKey    []byte
	TransactionScopes   []encryptedTransactionScope
}

type collectionManifest struct {
	Type     string   `json:"type"`
	ShardIDs []string `json:"shardIds"`
}

type storeManifest struct {
	Collections []collectionManifest `json:"collections"`
}

var storeCollectionTypes = []string{
	"chat_meta",
	"chat_group",
	"binary_object",
	"volume",
}

type fileSystemDescriptor struct {
	ID              string `json:"id"`
	RootDirectoryID string `json:"rootDirectoryId"`
	CreatedAt       int64  `json:"createdAt"`
}

type chatMetaShardIndex struct {
	ChatIDs []string `json:"chatIds"`
}

type chatGroupShardIndex struct {
	ChatGroupIDs []string `json:"chatGroupIds"`
}

type binaryShardEntry struct {
	Metadata json.RawMessage `json:"metadata"`
	FileID   string          `json:"fileId"`
}

type binaryShardIndex struct {
	Objects map[string]binaryShardEntry `json:"objects"`
}

type volumeShardIndex struct {
	Volumes map[string]json.RawMessage `json:"volumes"`
}

type volumeType struct {
	Type string `json:"type"`
}

type encryptedFileManifest struct {
	FileID           string   `json:"fileId"`
	Revision         int64    `json:"revision"`
	Size             int64    `json:"size"`
	ChunkSize        int64    `json:"chunkSize"`
	ChunkMapPageSize int64    `json:"chunkMapPageSize"`
	ChunkMapPageIDs  []string `json:"chunkMapPageIds"`
	CreatedAt        *int64   `json:"createdAt"`
	ModifiedAt       int64    `json:"modifiedAt"`
}

type encryptedFileChunkMapPage struct {
	PageID    string    `json:"pageId"`
	FileID    string    `json:"fileId"`
	PageIndex int64     `json:"pageIndex"`
	ChunkIDs  []*string `json:"chunkIds"`
}

type encryptedDirectoryShardReference struct {
	ShardID  string `json:"shardId"`
	ObjectID string `json:"objectId"`
}

type encryptedDirectoryManifest struct {
	DirectoryID string                             `json:"directoryId"`
	Revision    int64                              `json:"revision"`
	CreatedAt   *int64                             `json:"createdAt"`
	ModifiedAt  int64                              `json:"modifiedAt"`
	Shards      []encryptedDirectoryShardReference `json:"shards"`
}

type encryptedDirectoryShard struct {
	ObjectID    string                              `json:"objectId"`
	DirectoryID string                              `json:"directoryId"`
	ShardID     string                              `json:"shardId"`
	Entries     map[string]encryptedFileSystemEntry `json:"entries"`
}

type encryptedFileSystemEntry struct {
	Type        string `json:"type"`
	Name        string `json:"name"`
	FileID      string `json:"fileId"`
	DirectoryID string `json:"directoryId"`
	TargetPath  string `json:"targetPath"`
	CreatedAt   *int64 `json:"createdAt"`
	ModifiedAt  int64  `json:"modifiedAt"`
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func decodeBase64URL(value string, expectedLength int) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("invalid unpadded Base64URL value: %w", err)
	}
	if base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, errors.New("non-canonical Base64URL value")
	}
	if expectedLength >= 0 && len(decoded) != expectedLength {
		return nil, fmt.Errorf("decoded value has %d bytes instead of %d", len(decoded), expectedLength)
	}
	return decoded, nil
}

func pbkdf2SHA256(secret, salt []byte, iterations, keyLength int) ([]byte, error) {
	if iterations <= 0 || iterations > maxPBKDF2Iterations || keyLength <= 0 {
		return nil, fmt.Errorf(
			"PBKDF2 iterations must be between 1 and %d and key length must be positive",
			maxPBKDF2Iterations,
		)
	}
	const digestLength = sha256.Size
	blockCount := (keyLength + digestLength - 1) / digestLength
	if uint64(blockCount) > uint64(^uint32(0)) {
		return nil, errors.New("PBKDF2 output is too large")
	}
	result := make([]byte, 0, blockCount*digestLength)
	blockIndexBytes := make([]byte, 4)
	for blockIndex := 1; blockIndex <= blockCount; blockIndex++ {
		binary.BigEndian.PutUint32(blockIndexBytes, uint32(blockIndex))
		mac := hmac.New(sha256.New, secret)
		_, _ = mac.Write(salt)
		_, _ = mac.Write(blockIndexBytes)
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

func decodePayloadFrame(frame []byte) ([]byte, error) {
	if len(frame) < payloadHeaderByteLength {
		return nil, errors.New("encrypted object payload frame is truncated")
	}
	if frame[0] != payloadFrameVersion {
		return nil, fmt.Errorf("unsupported encrypted object payload frame version: %d", frame[0])
	}
	if frame[1] != 0 {
		return nil, fmt.Errorf("unsupported encrypted object payload encoding: %d", frame[1])
	}
	decodedSize := binary.BigEndian.Uint64(frame[2:10])
	payload := frame[payloadHeaderByteLength:]
	if decodedSize != uint64(len(payload)) {
		return nil, fmt.Errorf("encrypted object payload size mismatch: expected %d, received %d", decodedSize, len(payload))
	}
	// Return an owned copy because the authenticated frame is zeroed immediately
	// after decoding. Returning a subslice would zero the recovered payload too.
	return append([]byte(nil), payload...), nil
}

func unwrap(raw wrappedKey, wrappingKey, aad []byte) ([]byte, error) {
	nonce, err := decodeBase64URL(raw.Nonce, 12)
	if err != nil {
		return nil, err
	}
	ciphertext, err := decodeBase64URL(raw.Ciphertext, 48)
	if err != nil {
		return nil, err
	}
	plaintext, err := decryptGCM(wrappingKey, nonce, ciphertext, aad)
	if err != nil {
		return nil, err
	}
	if len(plaintext) != 32 {
		zero(plaintext)
		return nil, fmt.Errorf("unwrapped key has %d bytes instead of 32", len(plaintext))
	}
	return plaintext, nil
}

func readLatestSlot[T interface{ getSequence() int }](directory, prefix string, factory func() T) (T, error) {
	var zeroValue T
	type candidate struct {
		value    T
		envelope sequencedEnvelope
	}
	values := make([]candidate, 0, 2)
	for _, slot := range []int{0, 1} {
		data, err := os.ReadFile(filepath.Join(directory, fmt.Sprintf("%s-%d.json", prefix, slot)))
		if err != nil {
			continue
		}
		var envelope sequencedEnvelope
		if err := json.Unmarshal(data, &envelope); err != nil || envelope.Sequence < 0 || envelope.FormatVersion < 1 {
			continue
		}
		value := factory()
		if err := json.Unmarshal(data, value); err != nil || value.getSequence() != envelope.Sequence {
			continue
		}
		values = append(values, candidate{value: value, envelope: envelope})
	}
	if len(values) == 0 {
		return zeroValue, fmt.Errorf("no complete %s slot exists in %s", prefix, directory)
	}
	sort.Slice(values, func(i, j int) bool { return values[i].envelope.Sequence > values[j].envelope.Sequence })
	if len(values) == 2 && values[0].envelope.Sequence == values[1].envelope.Sequence {
		return zeroValue, fmt.Errorf("the %s slots have the same sequence in %s", prefix, directory)
	}
	if values[0].envelope.FormatVersion != 1 {
		return zeroValue, fmt.Errorf("unsupported newest %s format version: %d", prefix, values[0].envelope.FormatVersion)
	}
	return values[0].value, nil
}

func (state *encryptionState) getSequence() int { return state.Sequence }
func (header *storeHeader) getSequence() int    { return header.Sequence }

func selectStoreID(state *encryptionState, explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if state.State == "encrypted" {
		if state.ActiveEncryptedStoreID == "" {
			return "", errors.New("encrypted state has no active store ID")
		}
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
			return "", errors.New("encrypted target is not authoritative; use the plaintext source or pass -store-id to inspect it explicitly")
		}
		return state.Operation.TargetEncryptedStoreID, nil
	default:
		return "", fmt.Errorf("unsupported operation type: %s", state.Operation.Type)
	}
}

func deriveStorageUnlockKey(state *encryptionState, passphrase string) ([]byte, error) {
	if len(state.KeySlots) == 0 || len(state.KeySlots) > maxEncryptionKeySlots {
		return nil, fmt.Errorf(
			"encryption state must contain between 1 and %d key slots",
			maxEncryptionKeySlots,
		)
	}
	secret := []byte(passphrase)
	defer zero(secret)
	for _, slot := range state.KeySlots {
		if slot.ID == "" || slot.KeyDerivation.Type != "pbkdf2_sha256" {
			continue
		}
		salt, err := decodeBase64URL(slot.KeyDerivation.Salt, 32)
		if err != nil {
			continue
		}
		wrappingKey, err := pbkdf2SHA256(secret, salt, slot.KeyDerivation.Iterations, 32)
		zero(salt)
		if err != nil {
			continue
		}
		key, unwrapErr := unwrap(
			slot.WrappedStorageUnlockKey,
			wrappingKey,
			[]byte("naidan/opfs-encryption/storage-unlock-key/v1/"+slot.ID),
		)
		zero(wrappingKey)
		if unwrapErr == nil {
			return key, nil
		}
	}
	return nil, errors.New("passphrase did not unlock any encryption key slot")
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

type objectAddress struct {
	ObjectID string
	ShardID  string
	Area     string
	Path     string
}

func objectAddressFor(addressKey []byte, namespace, key, area string) (objectAddress, error) {
	if area != "durable" && area != "temporary" {
		return objectAddress{}, fmt.Errorf("unsupported encrypted object area: %s", area)
	}
	hash := hmac.New(sha256.New, addressKey)
	_, _ = hash.Write(canonicalLocator(namespace, key))
	signature := hash.Sum(nil)
	if len(signature) == 0 {
		return objectAddress{}, errors.New("encrypted object address HMAC was empty")
	}
	objectID := base64.RawURLEncoding.EncodeToString(signature)
	shardID := fmt.Sprintf("%02x", signature[0])
	areaDirectory := "objects"
	if area == "temporary" {
		areaDirectory = "temporary-objects"
	}
	return objectAddress{
		ObjectID: objectID,
		ShardID:  shardID,
		Area:     area,
		Path:     filepath.Join(areaDirectory, shardID, objectID+".enc"),
	}, nil
}

func readPhysicalObjectIfPresent(context encryptedContext, namespace, key, area string) ([]byte, bool, error) {
	address, err := objectAddressFor(context.ObjectAddressKey, namespace, key, area)
	if err != nil {
		return nil, false, err
	}
	physical, err := os.ReadFile(filepath.Join(context.StoreDirectory, address.Path))
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(physical) < objectHeaderByteLength+16 || !bytes.Equal(physical[:8], objectMagic) {
		return nil, false, fmt.Errorf("unsupported or truncated encrypted object: %s", address.ObjectID)
	}
	formatVersion := binary.BigEndian.Uint16(physical[8:10])
	headerLength := binary.BigEndian.Uint16(physical[10:12])
	if formatVersion != objectFormatVersion || headerLength != objectHeaderByteLength {
		return nil, false, fmt.Errorf("unsupported encrypted object header: version=%d length=%d", formatVersion, headerLength)
	}
	frame, err := decryptGCM(
		context.ObjectEncryptionKey,
		physical[12:24],
		physical[24:],
		[]byte("naidan/opfs-encryption/object/v1/"+area+"/"+address.ObjectID),
	)
	if err != nil {
		return nil, false, err
	}
	plaintext, err := decodePayloadFrame(frame)
	zero(frame)
	if err != nil {
		return nil, false, err
	}
	return plaintext, true, nil
}

func parseTransaction(data []byte, scopeID string) (encryptedObjectTransaction, error) {
	var transaction encryptedObjectTransaction
	if err := json.Unmarshal(data, &transaction); err != nil {
		return transaction, fmt.Errorf("invalid encrypted object transaction %s: %w", scopeID, err)
	}
	if transaction.ID == "" || transaction.ScopeID != scopeID || transaction.Operations == nil {
		return transaction, fmt.Errorf("encrypted object transaction is invalid: %s", scopeID)
	}
	for _, operation := range transaction.Operations {
		if (operation.Type != "write" && operation.Type != "delete") || operation.Namespace == "" || operation.Key == "" {
			return transaction, fmt.Errorf("encrypted object transaction operation is invalid: %s", scopeID)
		}
		if operation.Type == "write" && operation.PlaintextBase64URL == "" {
			return transaction, fmt.Errorf("encrypted object transaction write is missing plaintext: %s", scopeID)
		}
	}
	return transaction, nil
}

func withTransactionScope(context encryptedContext, scopeID, area string) (encryptedContext, error) {
	for _, scope := range context.TransactionScopes {
		if scope.Area == area && scope.ScopeID == scopeID {
			return context, nil
		}
	}
	data, found, err := readPhysicalObjectIfPresent(context, "object_transaction_journal", scopeID, area)
	if err != nil || !found {
		return context, err
	}
	transaction, err := parseTransaction(data, scopeID)
	if err != nil {
		return context, err
	}
	next := context
	next.TransactionScopes = append(
		append([]encryptedTransactionScope(nil), context.TransactionScopes...),
		encryptedTransactionScope{Area: area, ScopeID: scopeID, Transaction: transaction},
	)
	return next, nil
}

func readTransactionOverlay(context encryptedContext, namespace, key, area string) ([]byte, bool, bool, error) {
	for scopeIndex := len(context.TransactionScopes) - 1; scopeIndex >= 0; scopeIndex-- {
		scope := context.TransactionScopes[scopeIndex]
		if scope.Area != area {
			continue
		}
		for operationIndex := len(scope.Transaction.Operations) - 1; operationIndex >= 0; operationIndex-- {
			operation := scope.Transaction.Operations[operationIndex]
			if operation.Namespace != namespace || operation.Key != key {
				continue
			}
			if operation.Type == "delete" {
				return nil, true, false, nil
			}
			value, err := decodeBase64URL(operation.PlaintextBase64URL, -1)
			return value, true, err == nil, err
		}
	}
	return nil, false, false, nil
}

func readObjectIfPresent(context encryptedContext, namespace, key, area string) ([]byte, bool, error) {
	if namespace != "object_transaction_journal" {
		value, matched, found, err := readTransactionOverlay(context, namespace, key, area)
		if err != nil || matched {
			return value, found, err
		}
	}
	return readPhysicalObjectIfPresent(context, namespace, key, area)
}

func readObject(context encryptedContext, namespace, key, area string) ([]byte, error) {
	value, found, err := readObjectIfPresent(context, namespace, key, area)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("encrypted object is missing: %s/%s", namespace, key)
	}
	return value, nil
}

func readJSONValue[T any](context encryptedContext, namespace, key, area string) (T, bool, error) {
	var zeroValue T
	data, found, err := readObjectIfPresent(context, namespace, key, area)
	if err != nil || !found {
		return zeroValue, found, err
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return zeroValue, false, fmt.Errorf("invalid JSON in %s/%s: %w", namespace, key, err)
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

func writeJSON(path string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeBytes(path, encoded)
}

func writeObjectIfPresent(context encryptedContext, namespace, key, outputPath string) error {
	value, found, err := readObjectIfPresent(context, namespace, key, "durable")
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

func setRecoveredMtime(path string, modifiedAt int64) error {
	if modifiedAt < 0 {
		return fmt.Errorf("negative recovered modification time for %s", path)
	}
	value := time.UnixMilli(modifiedAt)
	return os.Chtimes(path, value, value)
}

func recoverEncryptedFile(context encryptedContext, fileID, outputPath, area string) (returnErr error) {
	fileContext, err := withTransactionScope(context, "file/"+fileID, area)
	if err != nil {
		return err
	}
	manifest, found, err := readJSONValue[encryptedFileManifest](fileContext, "file_manifest", fileID, area)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("encrypted file manifest is missing: %s", fileID)
	}
	if manifest.FileID != fileID || manifest.Revision < 0 || manifest.Size < 0 || manifest.ChunkSize <= 0 || manifest.ChunkMapPageSize <= 0 {
		return fmt.Errorf("encrypted file manifest is invalid: %s", fileID)
	}
	expectedChunks := int64(0)
	if manifest.Size > 0 {
		expectedChunks = (manifest.Size + manifest.ChunkSize - 1) / manifest.ChunkSize
	}
	expectedPages := int64(0)
	if expectedChunks > 0 {
		expectedPages = (expectedChunks + manifest.ChunkMapPageSize - 1) / manifest.ChunkMapPageSize
	}
	if int64(len(manifest.ChunkMapPageIDs)) != expectedPages {
		return fmt.Errorf("encrypted file manifest has an invalid chunk-map page count: %s", fileID)
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

	remaining := manifest.Size
	seenChunks := make(map[string]struct{})
	for pageIndex, pageID := range manifest.ChunkMapPageIDs {
		page, pageFound, err := readJSONValue[encryptedFileChunkMapPage](fileContext, "file_chunk_map_page", pageID, area)
		if err != nil {
			return err
		}
		if !pageFound || page.PageID != pageID || page.FileID != fileID || page.PageIndex != int64(pageIndex) {
			return fmt.Errorf("encrypted file chunk-map page is missing or invalid: %s", pageID)
		}
		expectedLength := manifest.ChunkMapPageSize
		remainingChunks := expectedChunks - int64(pageIndex)*manifest.ChunkMapPageSize
		if remainingChunks < expectedLength {
			expectedLength = remainingChunks
		}
		if int64(len(page.ChunkIDs)) != expectedLength {
			return fmt.Errorf("encrypted file chunk-map page has an invalid length: %s", pageID)
		}
		for _, chunkID := range page.ChunkIDs {
			if remaining <= 0 {
				return fmt.Errorf("encrypted file manifest has extra chunks: %s", fileID)
			}
			expected := manifest.ChunkSize
			if remaining < expected {
				expected = remaining
			}
			if expected > int64(^uint(0)>>1) {
				return fmt.Errorf("encrypted file chunk is too large for this platform: %s", fileID)
			}
			if chunkID == nil {
				if _, err := output.Write(make([]byte, int(expected))); err != nil {
					return err
				}
			} else {
				if _, exists := seenChunks[*chunkID]; exists {
					return fmt.Errorf("encrypted file chunk-map aliases a chunk: %s", *chunkID)
				}
				seenChunks[*chunkID] = struct{}{}
				chunk, err := readObject(fileContext, "file_chunk", *chunkID, area)
				if err != nil {
					return err
				}
				if int64(len(chunk)) != expected {
					return fmt.Errorf("encrypted file chunk has an unexpected size: %s", *chunkID)
				}
				if _, err := output.Write(chunk); err != nil {
					return err
				}
			}
			remaining -= expected
		}
	}
	if remaining != 0 {
		return fmt.Errorf("encrypted file manifest does not cover its size: %s", fileID)
	}
	if err := output.Sync(); err != nil {
		return err
	}
	completed = true
	if err := setRecoveredMtime(outputPath, manifest.ModifiedAt); err != nil {
		return err
	}
	return nil
}

func recoverDirectory(context encryptedContext, directoryID, outputDirectory, area string, ancestors map[string]struct{}) error {
	if _, exists := ancestors[directoryID]; exists {
		return fmt.Errorf("encrypted directory cycle detected: %s", directoryID)
	}
	ancestors[directoryID] = struct{}{}
	defer delete(ancestors, directoryID)
	if err := os.MkdirAll(outputDirectory, 0o755); err != nil {
		return err
	}
	manifest, found, err := readJSONValue[encryptedDirectoryManifest](context, "directory_manifest", directoryID, area)
	if err != nil {
		return err
	}
	if !found || manifest.DirectoryID != directoryID || manifest.Revision < 0 {
		return fmt.Errorf("encrypted directory manifest is missing or invalid: %s", directoryID)
	}
	seenNames := make(map[string]struct{})
	for _, reference := range manifest.Shards {
		shard, shardFound, err := readJSONValue[encryptedDirectoryShard](context, "directory_shard", reference.ObjectID, area)
		if err != nil {
			return err
		}
		if !shardFound || shard.ObjectID != reference.ObjectID || shard.DirectoryID != directoryID || shard.ShardID != reference.ShardID {
			return fmt.Errorf("encrypted directory shard is missing or invalid: %s/%s", directoryID, reference.ShardID)
		}
		entryIDs := make([]string, 0, len(shard.Entries))
		for entryID := range shard.Entries {
			entryIDs = append(entryIDs, entryID)
		}
		sort.Strings(entryIDs)
		for _, entryID := range entryIDs {
			entry := shard.Entries[entryID]
			if _, exists := seenNames[entry.Name]; exists {
				return fmt.Errorf("duplicate encrypted directory entry: %s", entry.Name)
			}
			seenNames[entry.Name] = struct{}{}
			outputPath, err := safeEntryPath(outputDirectory, entry.Name)
			if err != nil {
				return err
			}
			switch entry.Type {
			case "file":
				if err := recoverEncryptedFile(context, entry.FileID, outputPath, area); err != nil {
					return err
				}
			case "directory":
				if err := recoverDirectory(context, entry.DirectoryID, outputPath, area, ancestors); err != nil {
					return err
				}
			case "symlink":
				if err := writeJSON(outputPath+".naidan-symlink.json", map[string]any{
					"targetPath": entry.TargetPath,
					"createdAt":  entry.CreatedAt,
					"modifiedAt": entry.ModifiedAt,
				}); err != nil {
					return err
				}
			default:
				return fmt.Errorf("unsupported encrypted filesystem entry: %s", entry.Type)
			}
		}
	}
	return setRecoveredMtime(outputDirectory, manifest.ModifiedAt)
}

func recoverFileSystem(context encryptedContext, fileSystemID, outputDirectory, area string) (bool, error) {
	descriptorContext, err := withTransactionScope(context, "file-system-descriptor/"+fileSystemID, area)
	if err != nil {
		return false, err
	}
	descriptor, found, err := readJSONValue[fileSystemDescriptor](descriptorContext, "file_system_descriptor", fileSystemID, area)
	if err != nil || !found {
		return found, err
	}
	if descriptor.ID != fileSystemID || descriptor.RootDirectoryID == "" {
		return false, fmt.Errorf("encrypted filesystem descriptor is invalid: %s", fileSystemID)
	}
	fileSystemContext, err := withTransactionScope(descriptorContext, "file-system/"+descriptor.RootDirectoryID, area)
	if err != nil {
		return false, err
	}
	if err := recoverDirectory(fileSystemContext, descriptor.RootDirectoryID, outputDirectory, area, make(map[string]struct{})); err != nil {
		return false, err
	}
	return true, nil
}

func validateStoreManifest(manifest storeManifest) (map[string]collectionManifest, error) {
	collections := make(map[string]collectionManifest, len(storeCollectionTypes))
	expectedTypes := make(map[string]struct{}, len(storeCollectionTypes))
	for _, collectionType := range storeCollectionTypes {
		expectedTypes[collectionType] = struct{}{}
	}
	for _, value := range manifest.Collections {
		if _, ok := expectedTypes[value.Type]; !ok {
			return nil, fmt.Errorf("encrypted store manifest contains an invalid collection: %s", value.Type)
		}
		if _, exists := collections[value.Type]; exists {
			return nil, fmt.Errorf("encrypted store manifest contains a duplicate collection: %s", value.Type)
		}
		shardIDs := make(map[string]struct{}, len(value.ShardIDs))
		for _, shardID := range value.ShardIDs {
			if len(shardID) != 2 || strings.ToLower(shardID) != shardID {
				return nil, fmt.Errorf("encrypted %s collection contains an invalid shard ID: %s", value.Type, shardID)
			}
			if _, err := hex.DecodeString(shardID); err != nil {
				return nil, fmt.Errorf("encrypted %s collection contains an invalid shard ID: %s", value.Type, shardID)
			}
			if _, exists := shardIDs[shardID]; exists {
				return nil, fmt.Errorf("encrypted %s collection contains a duplicate shard ID: %s", value.Type, shardID)
			}
			shardIDs[shardID] = struct{}{}
		}
		collections[value.Type] = value
	}
	for _, collectionType := range storeCollectionTypes {
		if _, ok := collections[collectionType]; !ok {
			return nil, fmt.Errorf("encrypted store manifest is missing collection: %s", collectionType)
		}
	}
	return collections, nil
}

func legacyShard(id string) string {
	if len(id) < 2 {
		return strings.ToLower(id)
	}
	return strings.ToLower(id[len(id)-2:])
}

func validateOutputIdentifier(value string, fieldName string) error {
	if value == "" || value == "." || value == ".." || strings.ContainsAny(value, "/\\\x00") {
		return fmt.Errorf("%s is unsafe for recovery output: %q", fieldName, value)
	}
	return nil
}

func recoverStore(context encryptedContext, output string) error {
	storeContext, err := withTransactionScope(context, "naidan-store", "durable")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(output, 0o755); err != nil {
		return err
	}
	settings, settingsFound, err := readObjectIfPresent(storeContext, "singleton", "settings", "durable")
	if err != nil {
		return err
	}
	if settingsFound {
		if err := writeBytes(filepath.Join(output, "settings.json"), settings); err != nil {
			return err
		}
	}
	hierarchy, hierarchyFound, err := readObjectIfPresent(storeContext, "singleton", "hierarchy", "durable")
	if err != nil {
		return err
	}
	if !hierarchyFound {
		hierarchy = []byte(`{"items":[]}`)
	}
	if err := writeBytes(filepath.Join(output, "hierarchy.json"), hierarchy); err != nil {
		return err
	}
	manifest, found, err := readJSONValue[storeManifest](storeContext, "singleton", "store_manifest", "durable")
	if err != nil {
		return err
	}
	if !found {
		return errors.New("encrypted store manifest is missing")
	}
	collections, err := validateStoreManifest(manifest)
	if err != nil {
		return err
	}

	chatCollection := collections["chat_meta"]
	chatIDs := make(map[string]struct{})
	for _, shardID := range chatCollection.ShardIDs {
		index, indexFound, err := readJSONValue[chatMetaShardIndex](storeContext, "chat_meta_shard_index", shardID, "durable")
		if err != nil {
			return err
		}
		if !indexFound {
			return fmt.Errorf("chat metadata shard index is missing: %s", shardID)
		}
		for _, chatID := range index.ChatIDs {
			if err := validateOutputIdentifier(chatID, "chat ID"); err != nil {
				return err
			}
			chatIDs[chatID] = struct{}{}
		}
	}
	groupCollection := collections["chat_group"]
	groupIDs := make(map[string]struct{})
	for _, shardID := range groupCollection.ShardIDs {
		index, indexFound, err := readJSONValue[chatGroupShardIndex](storeContext, "chat_group_shard_index", shardID, "durable")
		if err != nil {
			return err
		}
		if !indexFound {
			return fmt.Errorf("chat group shard index is missing: %s", shardID)
		}
		for _, groupID := range index.ChatGroupIDs {
			if err := validateOutputIdentifier(groupID, "chat group ID"); err != nil {
				return err
			}
			groupIDs[groupID] = struct{}{}
		}
	}
	for _, chatID := range sortedSetValues(chatIDs) {
		if err := writeObjectIfPresent(storeContext, "chat_meta", chatID, filepath.Join(output, "chat-metas", chatID+".json")); err != nil {
			return err
		}
		if err := writeObjectIfPresent(storeContext, "chat_content", chatID, filepath.Join(output, "chat-contents", chatID+".json")); err != nil {
			return err
		}
	}
	for _, groupID := range sortedSetValues(groupIDs) {
		if err := writeObjectIfPresent(storeContext, "chat_group", groupID, filepath.Join(output, "chat-groups", groupID+".json")); err != nil {
			return err
		}
	}

	binaryCollection := collections["binary_object"]
	plainBinaryIndices := make(map[string]map[string]json.RawMessage)
	for _, encryptedShardID := range binaryCollection.ShardIDs {
		index, indexFound, err := readJSONValue[binaryShardIndex](storeContext, "binary_shard_index", encryptedShardID, "durable")
		if err != nil {
			return err
		}
		if !indexFound {
			return fmt.Errorf("binary-object shard index is missing: %s", encryptedShardID)
		}
		ids := make([]string, 0, len(index.Objects))
		for id := range index.Objects {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			if err := validateOutputIdentifier(id, "binary object ID"); err != nil {
				return err
			}
			entry := index.Objects[id]
			shard := legacyShard(id)
			if plainBinaryIndices[shard] == nil {
				plainBinaryIndices[shard] = make(map[string]json.RawMessage)
			}
			plainBinaryIndices[shard][id] = entry.Metadata
			if err := recoverEncryptedFile(storeContext, entry.FileID, filepath.Join(output, "binary-objects", shard, id+".bin"), "durable"); err != nil {
				return err
			}
			if err := writeBytes(filepath.Join(output, "binary-objects", shard, "."+id+".bin.complete"), nil); err != nil {
				return err
			}
		}
	}
	for shard, objects := range plainBinaryIndices {
		if err := writeJSON(filepath.Join(output, "binary-objects", shard, "index.json"), map[string]any{"objects": objects}); err != nil {
			return err
		}
	}

	volumeCollection := collections["volume"]
	plainVolumeIndices := make(map[string]map[string]json.RawMessage)
	for _, encryptedShardID := range volumeCollection.ShardIDs {
		index, indexFound, err := readJSONValue[volumeShardIndex](storeContext, "volume_index", encryptedShardID, "durable")
		if err != nil {
			return err
		}
		if !indexFound {
			return fmt.Errorf("volume shard index is missing: %s", encryptedShardID)
		}
		ids := make([]string, 0, len(index.Volumes))
		for id := range index.Volumes {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			if err := validateOutputIdentifier(id, "volume ID"); err != nil {
				return err
			}
			value := index.Volumes[id]
			shard := legacyShard(id)
			if plainVolumeIndices[shard] == nil {
				plainVolumeIndices[shard] = make(map[string]json.RawMessage)
			}
			plainVolumeIndices[shard][id] = value
			var kind volumeType
			if err := json.Unmarshal(value, &kind); err != nil {
				return fmt.Errorf("invalid volume metadata %s: %w", id, err)
			}
			if kind.Type == "opfs" {
				if _, err := recoverFileSystem(storeContext, "volume/"+id, filepath.Join(output, "volumes", shard, id), "durable"); err != nil {
					return err
				}
			}
		}
	}
	for shard, volumes := range plainVolumeIndices {
		if err := writeJSON(filepath.Join(output, "volumes", shard, "index.json"), map[string]any{"volumes": volumes}); err != nil {
			return err
		}
	}

	recoveredFileSystems := filepath.Join(output, "recovered-filesystems")
	for _, descriptor := range []struct {
		id   string
		name string
		area string
	}{
		{id: "system/chat-wesh", name: "chat-wesh", area: "durable"},
		{id: "system/debug-wesh", name: "debug-wesh", area: "durable"},
		{id: "system/tmp", name: "tmp", area: "temporary"},
	} {
		_, err := recoverFileSystem(storeContext, descriptor.id, filepath.Join(recoveredFileSystems, descriptor.name), descriptor.area)
		if err != nil {
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
	area := flag.String("area", "durable", "logical object area: durable or temporary")
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
	if *area != "durable" && *area != "temporary" {
		return fmt.Errorf("unsupported object area: %s", *area)
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
	if header.EncryptedStoreID != storeID {
		return fmt.Errorf("encrypted-store header ID does not match directory: %s", storeID)
	}
	storageUnlockKey, err := deriveStorageUnlockKey(state, *passphrase)
	if err != nil {
		return err
	}
	defer zero(storageUnlockKey)
	storeRootKey, err := unwrap(
		header.WrappedStoreRootKey,
		storageUnlockKey,
		[]byte("naidan/opfs-encryption/store-root-key/v1/"+storeID),
	)
	if err != nil {
		return err
	}
	defer zero(storeRootKey)
	objectEncryptionKey, err := deriveKey(storeRootKey, storeID, objectEncryptionHKDFInfo)
	if err != nil {
		return err
	}
	defer zero(objectEncryptionKey)
	objectAddressKey, err := deriveKey(storeRootKey, storeID, objectAddressHKDFInfo)
	if err != nil {
		return err
	}
	defer zero(objectAddressKey)
	context := encryptedContext{
		StoreDirectory:      storeDirectory,
		ObjectEncryptionKey: objectEncryptionKey,
		ObjectAddressKey:    objectAddressKey,
	}
	if *namespace != "" {
		plaintext, err := readObject(context, *namespace, *key, *area)
		if err != nil {
			return err
		}
		if err := writeBytes(*output, plaintext); err != nil {
			return err
		}
		fmt.Printf("Recovered %s object %s:%s to %s\n", *area, *namespace, *key, *output)
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
