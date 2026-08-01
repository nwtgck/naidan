package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

const (
	aesGCMTagBytes      = 16
	contextEncoding     = byte(1)
	passphraseMethod    = "passphrase_pbkdf2_hmac_sha256_aes_256_gcm"
	knownAnswerSchema   = "hizofs-v1-known-answer-vectors"
	knownAnswerSchemaV1 = 1
)

type fixture struct {
	Schema        string          `json:"schema"`
	SchemaVersion int             `json:"schemaVersion"`
	Inputs        fixtureInputs   `json:"inputs"`
	Expected      fixtureExpected `json:"expected"`
}

type fixtureInputs struct {
	FileSystemIDASCII                  string `json:"fileSystemIdAscii"`
	CredentialSlotIDASCII              string `json:"credentialSlotIdAscii"`
	SaltHex                            string `json:"saltHex"`
	Iterations                         int    `json:"iterations"`
	Passphrase                         string `json:"passphrase"`
	RootKeyHex                         string `json:"rootKeyHex"`
	HomeSegmentIDHex                   string `json:"homeSegmentIdHex"`
	RecordFrameHeaderHex               string `json:"recordFrameHeaderHex"`
	RecordNonceHex                     string `json:"recordNonceHex"`
	RecordPlaintextHex                 string `json:"recordPlaintextHex"`
	SuperblockHeaderHex                string `json:"superblockHeaderHex"`
	SegmentFooterHeaderHex             string `json:"segmentFooterHeaderHex"`
	SegmentFooterTrailerHex            string `json:"segmentFooterTrailerHex"`
	CanonicalUnsignedUnlockEnvelopeHex string `json:"canonicalUnsignedUnlockEnvelopeHex"`
	CredentialWrapNonceHex             string `json:"credentialWrapNonceHex"`
	UnlockAuthenticatorNonceHex        string `json:"unlockAuthenticatorNonceHex"`
	UnlockSequence                     int    `json:"unlockSequence"`
	UnlockCopy                         int    `json:"unlockCopy"`
}

type fixtureExpected struct {
	ContextsHex                       map[string]string `json:"contextsHex"`
	RecordDerivedKeyHex               string            `json:"recordDerivedKeyHex"`
	RecordCiphertextAndTagHex         string            `json:"recordCiphertextAndTagHex"`
	CredentialWrappingKeyHex          string            `json:"credentialWrappingKeyHex"`
	FileSystemCommitHex               string            `json:"fileSystemCommitHex"`
	InodeLeafPageHex                  string            `json:"inodeLeafPageHex"`
	InodeBranchPageHex                string            `json:"inodeBranchPageHex"`
	FileExtentLeafPageHex             string            `json:"fileExtentLeafPageHex"`
	WrappedRootKeyCiphertextAndTagHex string            `json:"wrappedRootKeyCiphertextAndTagHex"`
	UnlockAuthenticatorTagHex         string            `json:"unlockAuthenticatorTagHex"`
}

type verificationResult struct {
	BinaryVectorCount  int `json:"binaryVectorCount"`
	ContextVectorCount int `json:"contextVectorCount"`
	CryptoVectorCount  int `json:"cryptoVectorCount"`
	SchemaVersion      int `json:"schemaVersion"`
}

func decodeHex(label string, value string) ([]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("%s is not valid hex: %w", label, err)
	}
	return decoded, nil
}

func encodeU16(value int) ([]byte, error) {
	if value < 0 || value > 0xffff {
		return nil, fmt.Errorf("u16 value is out of range: %d", value)
	}
	encoded := make([]byte, 2)
	binary.BigEndian.PutUint16(encoded, uint16(value))
	return encoded, nil
}

func encodeU32(value int) ([]byte, error) {
	if value < 0 || uint64(value) > uint64(^uint32(0)) {
		return nil, fmt.Errorf("u32 value is out of range: %d", value)
	}
	encoded := make([]byte, 4)
	binary.BigEndian.PutUint32(encoded, uint32(value))
	return encoded, nil
}

func encodeU64(value uint64) []byte {
	encoded := make([]byte, 8)
	binary.BigEndian.PutUint64(encoded, value)
	return encoded
}

func encodeCryptoContext(domain string, fields [][]byte) ([]byte, error) {
	if len(domain) == 0 {
		return nil, errors.New("crypto domain must be non-empty printable ASCII")
	}
	for index := range domain {
		if domain[index] < 0x20 || domain[index] > 0x7e {
			return nil, errors.New("crypto domain must be non-empty printable ASCII")
		}
	}
	if len(domain) > 0xffff {
		return nil, errors.New("crypto domain is too long")
	}
	if len(fields) > 0xffff {
		return nil, errors.New("crypto context field count is outside u16")
	}
	domainLength, err := encodeU16(len(domain))
	if err != nil {
		return nil, err
	}
	fieldCount, err := encodeU16(len(fields))
	if err != nil {
		return nil, err
	}
	result := []byte{contextEncoding}
	result = append(result, domainLength...)
	result = append(result, []byte(domain)...)
	result = append(result, fieldCount...)
	for _, field := range fields {
		result = append(result, encodeU64(uint64(len(field)))...)
		result = append(result, field...)
	}
	return result, nil
}

func hkdfSHA256(inputKeyMaterial []byte, info []byte, outputLength int) ([]byte, error) {
	if outputLength < 0 || outputLength > 255*sha256.Size {
		return nil, errors.New("HKDF output length is out of range")
	}
	zeroSalt := make([]byte, sha256.Size)
	extract := hmac.New(sha256.New, zeroSalt)
	_, _ = extract.Write(inputKeyMaterial)
	pseudorandomKey := extract.Sum(nil)
	result := make([]byte, 0, outputLength)
	previous := []byte(nil)
	for counter := byte(1); len(result) < outputLength; counter++ {
		expand := hmac.New(sha256.New, pseudorandomKey)
		_, _ = expand.Write(previous)
		_, _ = expand.Write(info)
		_, _ = expand.Write([]byte{counter})
		previous = expand.Sum(nil)
		result = append(result, previous...)
	}
	return result[:outputLength], nil
}

func pbkdf2SHA256(password []byte, salt []byte, iterations int, outputLength int) ([]byte, error) {
	if iterations < 1 {
		return nil, errors.New("PBKDF2 iterations must be positive")
	}
	if outputLength < 0 {
		return nil, errors.New("PBKDF2 output length must be non-negative")
	}
	result := make([]byte, 0, outputLength)
	for blockIndex := uint32(1); len(result) < outputLength; blockIndex++ {
		counter := make([]byte, 4)
		binary.BigEndian.PutUint32(counter, blockIndex)
		mac := hmac.New(sha256.New, password)
		_, _ = mac.Write(salt)
		_, _ = mac.Write(counter)
		current := mac.Sum(nil)
		block := append([]byte(nil), current...)
		for iteration := 1; iteration < iterations; iteration++ {
			mac = hmac.New(sha256.New, password)
			_, _ = mac.Write(current)
			current = mac.Sum(nil)
			for index := range block {
				block[index] ^= current[index]
			}
		}
		result = append(result, block...)
	}
	return result[:outputLength], nil
}

func aesGCMEncrypt(key []byte, nonce []byte, aad []byte, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCMWithTagSize(block, aesGCMTagBytes)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, fmt.Errorf("AES-GCM nonce must be %d bytes", gcm.NonceSize())
	}
	return gcm.Seal(nil, nonce, plaintext, aad), nil
}

func aesGCMDecrypt(key []byte, nonce []byte, aad []byte, ciphertextAndTag []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCMWithTagSize(block, aesGCMTagBytes)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	if len(ciphertextAndTag) < aesGCMTagBytes {
		return nil, errors.New("AES-GCM ciphertext is shorter than its tag")
	}
	return gcm.Open(nil, nonce, ciphertextAndTag, aad)
}

func buildContexts(inputs fixtureInputs) (map[string][]byte, error) {
	fileSystemID := []byte(inputs.FileSystemIDASCII)
	slotID := []byte(inputs.CredentialSlotIDASCII)
	salt, err := decodeHex("salt", inputs.SaltHex)
	if err != nil {
		return nil, err
	}
	wrapNonce, err := decodeHex("Credential Slot nonce", inputs.CredentialWrapNonceHex)
	if err != nil {
		return nil, err
	}
	iterations, err := encodeU32(inputs.Iterations)
	if err != nil {
		return nil, err
	}
	methodParameters := append(append(append([]byte(nil), salt...), iterations...), wrapNonce...)
	formatVersion, err := encodeU16(1)
	if err != nil {
		return nil, err
	}
	methodVersion, err := encodeU32(1)
	if err != nil {
		return nil, err
	}
	homeSegmentID, err := decodeHex("Home Segment ID", inputs.HomeSegmentIDHex)
	if err != nil {
		return nil, err
	}
	recordFrameHeader, err := decodeHex("Record Frame Header", inputs.RecordFrameHeaderHex)
	if err != nil {
		return nil, err
	}
	superblockHeader, err := decodeHex("Superblock Header", inputs.SuperblockHeaderHex)
	if err != nil {
		return nil, err
	}
	footerHeader, err := decodeHex("Segment Footer Header", inputs.SegmentFooterHeaderHex)
	if err != nil {
		return nil, err
	}
	footerTrailer, err := decodeHex("Segment Footer Trailer", inputs.SegmentFooterTrailerHex)
	if err != nil {
		return nil, err
	}
	unsignedEnvelope, err := decodeHex("unsigned Unlock Envelope", inputs.CanonicalUnsignedUnlockEnvelopeHex)
	if err != nil {
		return nil, err
	}
	if inputs.UnlockCopy != 0 && inputs.UnlockCopy != 1 {
		return nil, errors.New("Unlock copy must be 0 or 1")
	}
	specs := map[string]struct {
		domain string
		fields [][]byte
	}{
		"recordKey": {
			domain: "HizoFS/v1/record-key",
			fields: [][]byte{fileSystemID, homeSegmentID},
		},
		"recordAad": {
			domain: "HizoFS/v1/record-aad",
			fields: [][]byte{fileSystemID, recordFrameHeader},
		},
		"passphraseSlotKdf": {
			domain: "HizoFS/v1/passphrase-slot-kdf",
			fields: [][]byte{fileSystemID, slotID, salt},
		},
		"passphraseSlotAad": {
			domain: "HizoFS/v1/passphrase-slot-aad",
			fields: [][]byte{formatVersion, fileSystemID, slotID, []byte(passphraseMethod), methodVersion, methodParameters},
		},
		"superblockAad": {
			domain: "HizoFS/v1/superblock-aad",
			fields: [][]byte{superblockHeader},
		},
		"segmentFooterAad": {
			domain: "HizoFS/v1/segment-footer-aad",
			fields: [][]byte{fileSystemID, footerHeader, footerTrailer},
		},
		"unlockAuthenticatorAad": {
			domain: "HizoFS/v1/unlock-authenticator-aad",
			fields: [][]byte{unsignedEnvelope},
		},
		"unlockAuthenticatorKey": {
			domain: "HizoFS/v1/unlock-authenticator-key",
			fields: [][]byte{fileSystemID, {byte(inputs.UnlockCopy)}, encodeU64(uint64(inputs.UnlockSequence))},
		},
	}
	contexts := make(map[string][]byte, len(specs))
	for name, spec := range specs {
		encoded, encodeErr := encodeCryptoContext(spec.domain, spec.fields)
		if encodeErr != nil {
			return nil, fmt.Errorf("encode %s context: %w", name, encodeErr)
		}
		contexts[name] = encoded
	}
	return contexts, nil
}

func expectHex(label string, actual []byte, expected string) error {
	if hex.EncodeToString(actual) != expected {
		return fmt.Errorf("%s mismatch", label)
	}
	return nil
}

func loadFixture(path string) (fixture, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return fixture{}, fmt.Errorf("read fixture: %w", err)
	}
	var parsed fixture
	if err := json.Unmarshal(bytes, &parsed); err != nil {
		return fixture{}, fmt.Errorf("decode fixture: %w", err)
	}
	if parsed.Schema != knownAnswerSchema || parsed.SchemaVersion != knownAnswerSchemaV1 {
		return fixture{}, errors.New("unsupported HizoFS known-answer fixture")
	}
	return parsed, nil
}

func verifyKnownAnswerVectors(path string) (verificationResult, error) {
	vector, err := loadFixture(path)
	if err != nil {
		return verificationResult{}, err
	}
	binaryVectorCount, err := verifyBinaryFixtureRoundTrips(vector.Expected)
	if err != nil {
		return verificationResult{}, err
	}
	contexts, err := buildContexts(vector.Inputs)
	if err != nil {
		return verificationResult{}, err
	}
	for name, actual := range contexts {
		if err := expectHex(name+" context", actual, vector.Expected.ContextsHex[name]); err != nil {
			return verificationResult{}, err
		}
	}
	rootKey, err := decodeHex("Root Key", vector.Inputs.RootKeyHex)
	if err != nil {
		return verificationResult{}, err
	}
	recordKey, err := hkdfSHA256(rootKey, contexts["recordKey"], 32)
	if err != nil {
		return verificationResult{}, err
	}
	if err := expectHex("record HKDF key", recordKey, vector.Expected.RecordDerivedKeyHex); err != nil {
		return verificationResult{}, err
	}
	recordNonce, err := decodeHex("Record nonce", vector.Inputs.RecordNonceHex)
	if err != nil {
		return verificationResult{}, err
	}
	recordPlaintext, err := decodeHex("Record plaintext", vector.Inputs.RecordPlaintextHex)
	if err != nil {
		return verificationResult{}, err
	}
	recordCiphertext, err := aesGCMEncrypt(recordKey, recordNonce, contexts["recordAad"], recordPlaintext)
	if err != nil {
		return verificationResult{}, err
	}
	if err := expectHex("record ciphertext and tag", recordCiphertext, vector.Expected.RecordCiphertextAndTagHex); err != nil {
		return verificationResult{}, err
	}
	decryptedRecord, err := aesGCMDecrypt(recordKey, recordNonce, contexts["recordAad"], recordCiphertext)
	if err != nil || !bytes.Equal(decryptedRecord, recordPlaintext) {
		return verificationResult{}, errors.New("record decrypt mismatch")
	}
	wrongAAD := append([]byte(nil), contexts["recordAad"]...)
	wrongAAD[len(wrongAAD)-1] ^= 1
	if _, err := aesGCMDecrypt(recordKey, recordNonce, wrongAAD, recordCiphertext); err == nil {
		return verificationResult{}, errors.New("record authentication accepted changed AAD")
	}

	credentialKey, err := pbkdf2SHA256(
		[]byte(vector.Inputs.Passphrase),
		contexts["passphraseSlotKdf"],
		vector.Inputs.Iterations,
		32,
	)
	if err != nil {
		return verificationResult{}, err
	}
	if err := expectHex("credential wrapping key", credentialKey, vector.Expected.CredentialWrappingKeyHex); err != nil {
		return verificationResult{}, err
	}
	wrapNonce, err := decodeHex("Credential Slot nonce", vector.Inputs.CredentialWrapNonceHex)
	if err != nil {
		return verificationResult{}, err
	}
	wrappedRootKey, err := aesGCMEncrypt(credentialKey, wrapNonce, contexts["passphraseSlotAad"], rootKey)
	if err != nil {
		return verificationResult{}, err
	}
	if err := expectHex("wrapped Root Key", wrappedRootKey, vector.Expected.WrappedRootKeyCiphertextAndTagHex); err != nil {
		return verificationResult{}, err
	}
	unwrappedRootKey, err := aesGCMDecrypt(credentialKey, wrapNonce, contexts["passphraseSlotAad"], wrappedRootKey)
	if err != nil || !bytes.Equal(unwrappedRootKey, rootKey) {
		return verificationResult{}, errors.New("Credential Slot unwrap mismatch")
	}

	unlockKey, err := hkdfSHA256(rootKey, contexts["unlockAuthenticatorKey"], 32)
	if err != nil {
		return verificationResult{}, err
	}
	unlockNonce, err := decodeHex("Unlock Authenticator nonce", vector.Inputs.UnlockAuthenticatorNonceHex)
	if err != nil {
		return verificationResult{}, err
	}
	unlockTag, err := aesGCMEncrypt(unlockKey, unlockNonce, contexts["unlockAuthenticatorAad"], nil)
	if err != nil {
		return verificationResult{}, err
	}
	if err := expectHex("Unlock Authenticator tag", unlockTag, vector.Expected.UnlockAuthenticatorTagHex); err != nil {
		return verificationResult{}, err
	}
	unlockPlaintext, err := aesGCMDecrypt(unlockKey, unlockNonce, contexts["unlockAuthenticatorAad"], unlockTag)
	if err != nil || len(unlockPlaintext) != 0 {
		return verificationResult{}, errors.New("Unlock Authenticator decrypt mismatch")
	}

	return verificationResult{
		BinaryVectorCount:  binaryVectorCount,
		ContextVectorCount: len(contexts),
		CryptoVectorCount:  4,
		SchemaVersion:      vector.SchemaVersion,
	}, nil
}

func defaultFixturePath() string {
	rootPath := "src/00-storage/service/hizofs/00-format/v1/test-fixtures/known-answer-vectors-v1.json"
	if _, err := os.Stat(rootPath); err == nil {
		return rootPath
	}
	return "../../../src/00-storage/service/hizofs/00-format/v1/test-fixtures/known-answer-vectors-v1.json"
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--read-inline-namespace" {
		fixturePath := "../../../src/00-storage/service/hizofs/worker/tests/test-fixtures/nonempty-container-portable-v1.json"
		if len(os.Args) > 2 {
			fixturePath = os.Args[2]
		}
		fixture, err := loadPortableFixture(fixturePath)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		passphrase := fixture.Passphrase
		if len(os.Args) > 3 {
			passphrase = os.Args[3]
		}
		unlock, root, err := unlockPortableFixture(fixture, passphrase)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		_, selected, err := openPortableSuperblocks(fixture, root, unlock.UnlockSequence)
		var result inlineNamespaceSummary
		if err == nil {
			result, err = readInlineNamespace(fixture, root, selected)
		}
		clear(root)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		encoded, _ := json.Marshal(result)
		fmt.Println(string(encoded))
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--read-root-inode" {
		fixturePath := "../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json"
		if len(os.Args) > 2 {
			fixturePath = os.Args[2]
		}
		fixture, err := loadPortableFixture(fixturePath)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		passphrase := fixture.Passphrase
		if len(os.Args) > 3 {
			passphrase = os.Args[3]
		}
		unlock, root, err := unlockPortableFixture(fixture, passphrase)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		_, selected, err := openPortableSuperblocks(fixture, root, unlock.UnlockSequence)
		var result rootInodeSummary
		if err == nil {
			result, err = readRootInode(fixture, root, selected)
		}
		clear(root)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		encoded, _ := json.Marshal(result)
		fmt.Println(string(encoded))
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--read-active-commit" {
		fixturePath := "../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json"
		if len(os.Args) > 2 {
			fixturePath = os.Args[2]
		}
		fixture, err := loadPortableFixture(fixturePath)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		passphrase := fixture.Passphrase
		if len(os.Args) > 3 {
			passphrase = os.Args[3]
		}
		unlock, root, err := unlockPortableFixture(fixture, passphrase)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		_, selected, err := openPortableSuperblocks(fixture, root, unlock.UnlockSequence)
		var result activeCommitSummary
		if err == nil {
			result, err = readActiveCommit(fixture, root, selected)
		}
		clear(root)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		encoded, _ := json.Marshal(result)
		fmt.Println(string(encoded))
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--read-superblocks" {
		fixturePath := "../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json"
		if len(os.Args) > 2 {
			fixturePath = os.Args[2]
		}
		fixture, err := loadPortableFixture(fixturePath)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		passphrase := fixture.Passphrase
		if len(os.Args) > 3 {
			passphrase = os.Args[3]
		}
		unlock, root, err := unlockPortableFixture(fixture, passphrase)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		result, err := readPortableSuperblocks(fixture, root, unlock.UnlockSequence)
		clear(root)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		encoded, _ := json.Marshal(result)
		fmt.Println(string(encoded))
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--read-empty" {
		fixturePath := "../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json"
		if len(os.Args) > 2 {
			fixturePath = os.Args[2]
		}
		fixture, err := loadPortableFixture(fixturePath)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		passphrase := fixture.Passphrase
		if len(os.Args) > 3 {
			passphrase = os.Args[3]
		}
		result, root, err := unlockPortableFixture(fixture, passphrase)
		if root != nil {
			clear(root)
		}
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		encoded, _ := json.Marshal(result)
		fmt.Println(string(encoded))
		return
	}
	fixturePath := defaultFixturePath()
	if len(os.Args) > 1 {
		fixturePath = os.Args[1]
	}
	result, err := verifyKnownAnswerVectors(fixturePath)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(string(encoded))
}
