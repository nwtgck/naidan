package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
)

const passphraseCredentialMethod = "passphrase_pbkdf2_hmac_sha256_aes_256_gcm"

func isNanoID21(value string) bool {
	if len(value) != 21 {
		return false
	}
	for _, character := range value {
		if !((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '_' || character == '-') {
			return false
		}
	}
	return true
}

type portableFixture struct {
	Schema        string                `json:"schema"`
	SchemaVersion int                   `json:"schemaVersion"`
	Passphrase    string                `json:"passphrase"`
	FileSystemID  string                `json:"fileSystemId"`
	Files         []portableFixtureFile `json:"files"`
}
type portableFixtureFile struct {
	ByteLength int    `json:"byteLength"`
	Path       string `json:"path"`
	SHA256     string `json:"sha256"`
	Hex        string `json:"hex"`
}
type credentialSlot struct {
	Type             string `json:"type"`
	SlotID           string `json:"slotId"`
	Method           string `json:"method"`
	MethodVersion    int    `json:"methodVersion"`
	MethodParameters string `json:"methodParameters"`
	WrappedRootKey   string `json:"wrappedFileSystemRootKey"`
	parameters       []byte
	wrapped          []byte
	iterations       int
}
type unlockEnvelope struct {
	Format             string           `json:"format"`
	FormatVersion      int              `json:"formatVersion"`
	Copy               int              `json:"copy"`
	Sequence           int              `json:"sequence"`
	FileSystemID       string           `json:"fileSystemId"`
	CredentialSlots    []credentialSlot `json:"credentialSlots"`
	AuthenticatorNonce string           `json:"authenticatorNonce"`
	AuthenticatorTag   string           `json:"authenticatorTag"`
	nonce              []byte
	tag                []byte
}
type unlockSummary struct {
	AuthenticatedUnlockCopies int    `json:"authenticatedUnlockCopies"`
	CredentialSlotCount       int    `json:"credentialSlotCount"`
	FileSystemID              string `json:"fileSystemId"`
	RootKeyBytes              int    `json:"rootKeyBytes"`
	SchemaVersion             int    `json:"schemaVersion"`
	SelectedUnlockCopy        int    `json:"selectedUnlockCopy"`
	UnlockSequence            int    `json:"unlockSequence"`
}

func decodeBase64URLCanonical(value string, maximum int) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(b) > maximum || base64.RawURLEncoding.EncodeToString(b) != value {
		return nil, errors.New("value must be canonical unpadded Base64URL")
	}
	return b, nil
}
func quoteASCII(value string) (string, error) {
	for _, r := range value {
		if r < 0x20 || r > 0x7e {
			return "", errors.New("canonical control string must be printable ASCII")
		}
	}
	b, _ := json.Marshal(value)
	return string(b), nil
}
func encodeCredentialSlot(slot credentialSlot) ([]byte, error) {
	vals := []string{slot.Type, slot.SlotID, slot.Method, slot.MethodParameters, slot.WrappedRootKey}
	q := make([]string, len(vals))
	for i, v := range vals {
		var err error
		q[i], err = quoteASCII(v)
		if err != nil {
			return nil, err
		}
	}
	return []byte(fmt.Sprintf(`{"type":%s,"slotId":%s,"method":%s,"methodVersion":%d,"methodParameters":%s,"wrappedFileSystemRootKey":%s}`, q[0], q[1], q[2], slot.MethodVersion, q[3], q[4])), nil
}
func encodeUnlockEnvelope(envelope unlockEnvelope, includeTag bool) ([]byte, error) {
	slots := make([]string, len(envelope.CredentialSlots))
	for i, s := range envelope.CredentialSlots {
		b, err := encodeCredentialSlot(s)
		if err != nil {
			return nil, err
		}
		slots[i] = string(b)
	}
	format, _ := quoteASCII(envelope.Format)
	fs, _ := quoteASCII(envelope.FileSystemID)
	nonce, _ := quoteASCII(envelope.AuthenticatorNonce)
	value := fmt.Sprintf(`{"format":%s,"formatVersion":%d,"copy":%d,"sequence":%d,"fileSystemId":%s,"credentialSlots":[%s],"authenticatorNonce":%s`, format, envelope.FormatVersion, envelope.Copy, envelope.Sequence, fs, strings.Join(slots, ","), nonce)
	if includeTag {
		tag, _ := quoteASCII(envelope.AuthenticatorTag)
		value += `,"authenticatorTag":` + tag
	}
	return []byte(value + "}\n"), nil
}
func decodeUnlockEnvelope(value []byte, physicalCopy int) (unlockEnvelope, error) {
	var e unlockEnvelope
	dec := json.NewDecoder(bytes.NewReader(value))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&e); err != nil {
		return e, err
	}
	if e.Format != "hizofs-unlock" || e.FormatVersion != 1 || e.Copy != physicalCopy || e.Sequence < 1 || !isNanoID21(e.FileSystemID) {
		return e, errors.New("invalid Unlock Envelope")
	}
	if len(e.CredentialSlots) < 1 || len(e.CredentialSlots) > 32 {
		return e, errors.New("invalid Credential Slot count")
	}
	total := 0
	previous := ""
	for i := range e.CredentialSlots {
		s := &e.CredentialSlots[i]
		if s.Type != "credential" || !isNanoID21(s.SlotID) || s.Method != passphraseCredentialMethod || s.MethodVersion != 1 || (previous != "" && previous >= s.SlotID) {
			return e, errors.New("invalid Credential Slot")
		}
		previous = s.SlotID
		var err error
		s.parameters, err = decodeBase64URLCanonical(s.MethodParameters, 32)
		if err != nil || len(s.parameters) != 32 {
			return e, errors.New("invalid Credential Slot parameters")
		}
		s.wrapped, err = decodeBase64URLCanonical(s.WrappedRootKey, 48)
		if err != nil || len(s.wrapped) != 48 {
			return e, errors.New("invalid wrapped Root Key")
		}
		s.iterations = int(uint32(s.parameters[16])<<24 | uint32(s.parameters[17])<<16 | uint32(s.parameters[18])<<8 | uint32(s.parameters[19]))
		if s.iterations < 600000 || s.iterations > 10000000 {
			return e, errors.New("PBKDF2 iterations outside V1 bounds")
		}
		total += s.iterations
		if total > 20000000 {
			return e, errors.New("Credential Slot work exceeds V1 bound")
		}
	}
	var err error
	e.nonce, err = decodeBase64URLCanonical(e.AuthenticatorNonce, 12)
	if err != nil || len(e.nonce) != 12 {
		return e, errors.New("invalid authenticator nonce")
	}
	e.tag, err = decodeBase64URLCanonical(e.AuthenticatorTag, 16)
	if err != nil || len(e.tag) != 16 {
		return e, errors.New("invalid authenticator tag")
	}
	canonical, err := encodeUnlockEnvelope(e, true)
	if err != nil || !bytes.Equal(canonical, value) {
		return e, errors.New("Unlock Envelope bytes are not canonical")
	}
	return e, nil
}
func unwrapCredentialSlot(e unlockEnvelope, s credentialSlot, passphrase string) ([]byte, error) {
	salt := s.parameters[:16]
	nonce := s.parameters[20:32]
	kdfContext, err := encodeCryptoContext("HizoFS/v1/passphrase-slot-kdf", [][]byte{[]byte(e.FileSystemID), []byte(s.SlotID), salt})
	if err != nil {
		return nil, err
	}
	passphraseBytes := []byte(passphrase)
	key, err := pbkdf2SHA256(passphraseBytes, kdfContext, s.iterations, 32)
	clear(passphraseBytes)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	aad, err := encodeCryptoContext("HizoFS/v1/passphrase-slot-aad", [][]byte{{0, 1}, []byte(e.FileSystemID), []byte(s.SlotID), []byte(passphraseCredentialMethod), {0, 0, 0, 1}, s.parameters})
	if err != nil {
		return nil, err
	}
	root, err := aesGCMDecrypt(key, nonce, aad, s.wrapped)
	if err != nil || len(root) != 32 {
		return nil, errors.New("Credential Slot authentication failed")
	}
	return root, nil
}
func verifyUnlockEnvelope(e unlockEnvelope, root []byte) bool {
	sequence := encodeU64(uint64(e.Sequence))
	keyContext, err := encodeCryptoContext("HizoFS/v1/unlock-authenticator-key", [][]byte{[]byte(e.FileSystemID), {byte(e.Copy)}, sequence})
	if err != nil {
		return false
	}
	key, err := hkdfSHA256(root, keyContext, 32)
	if err != nil {
		return false
	}
	defer clear(key)
	unsigned, err := encodeUnlockEnvelope(e, false)
	if err != nil {
		return false
	}
	aad, err := encodeCryptoContext("HizoFS/v1/unlock-authenticator-aad", [][]byte{unsigned})
	if err != nil {
		return false
	}
	plaintext, err := aesGCMDecrypt(key, e.nonce, aad, e.tag)
	return err == nil && len(plaintext) == 0
}
func semanticKey(e unlockEnvelope) string {
	parts := []string{e.Format, fmt.Sprint(e.FormatVersion), fmt.Sprint(e.Sequence), e.FileSystemID}
	for _, s := range e.CredentialSlots {
		parts = append(parts, s.Type, s.SlotID, s.Method, fmt.Sprint(s.MethodVersion), s.MethodParameters, s.WrappedRootKey)
	}
	return strings.Join(parts, "\x00")
}
func fixtureBytes(f portableFixture, path string) ([]byte, error) {
	for _, e := range f.Files {
		if e.Path == path {
			b, err := decodeHex(path, e.Hex)
			if err != nil || len(b) != e.ByteLength {
				return nil, errors.New("fixture byte length mismatch")
			}
			digest := fmt.Sprintf("%x", sha256.Sum256(b))
			if digest != e.SHA256 {
				return nil, errors.New("fixture SHA-256 mismatch")
			}
			return b, nil
		}
	}
	return nil, errors.New("fixture file missing")
}
func loadPortableFixture(path string) (portableFixture, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return portableFixture{}, err
	}
	var f portableFixture
	if err = json.Unmarshal(b, &f); err != nil {
		return f, err
	}
	if (f.Schema != "hizofs-v1-empty-container-fixture" && f.Schema != "hizofs-v1-nonempty-container-fixture") || f.SchemaVersion != 1 {
		return f, errors.New("unsupported portable fixture")
	}
	return f, nil
}
func unlockPortableFixture(f portableFixture, passphrase string) (unlockSummary, []byte, error) {
	copies := make([]unlockEnvelope, 0, 2)
	for copy := 0; copy < 2; copy++ {
		b, err := fixtureBytes(f, fmt.Sprintf("unlock-%d.json", copy))
		if err != nil {
			return unlockSummary{}, nil, err
		}
		e, err := decodeUnlockEnvelope(b, copy)
		if err != nil {
			return unlockSummary{}, nil, err
		}
		copies = append(copies, e)
	}
	ordered := append([]unlockEnvelope(nil), copies...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Sequence > ordered[j].Sequence })
	seen := map[string]bool{}
	var root []byte
	for _, e := range ordered {
		for _, s := range e.CredentialSlots {
			key := strings.Join([]string{e.FileSystemID, s.SlotID, s.Method, fmt.Sprint(s.MethodVersion), s.MethodParameters, s.WrappedRootKey}, "\x00")
			if seen[key] {
				continue
			}
			seen[key] = true
			candidate, err := unwrapCredentialSlot(e, s, passphrase)
			if err == nil && verifyUnlockEnvelope(e, candidate) {
				root = candidate
				break
			}
			if candidate != nil {
				clear(candidate)
			}
		}
		if root != nil {
			break
		}
	}
	if root == nil {
		return unlockSummary{}, nil, errors.New("passphrase did not authenticate an Unlock Envelope")
	}
	authenticated := []unlockEnvelope{}
	for _, e := range copies {
		if verifyUnlockEnvelope(e, root) {
			authenticated = append(authenticated, e)
		}
	}
	max := 0
	for _, e := range authenticated {
		if e.Sequence > max {
			max = e.Sequence
		}
	}
	group := []unlockEnvelope{}
	for _, e := range authenticated {
		if e.Sequence == max {
			group = append(group, e)
		}
	}
	if len(group) == 0 {
		clear(root)
		return unlockSummary{}, nil, errors.New("no authenticated Unlock authority")
	}
	semantic := semanticKey(group[0])
	for _, e := range group {
		if semanticKey(e) != semantic {
			clear(root)
			return unlockSummary{}, nil, errors.New("ambiguous Unlock authority")
		}
	}
	selected := group[0]
	return unlockSummary{len(authenticated), len(selected.CredentialSlots), selected.FileSystemID, len(root), f.SchemaVersion, selected.Copy, selected.Sequence}, root, nil
}
