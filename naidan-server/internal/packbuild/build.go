// Package packbuild prepares the immutable, independently readable server pack.
// It is used only while building the executable, never while serving requests.
package packbuild

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/klauspost/compress/zstd"
	"naidan-server/internal/packedfs"
)

// Stats describes the files actually included in a completed pack.
type Stats struct {
	Files        int   `json:"files"`
	ZIPFiles     int   `json:"zipFiles"`
	SourceBytes  int64 `json:"sourceBytes"`
	PackBytes    int64 `json:"packBytes"`
	UniqueBlocks int   `json:"uniqueBlocks"`
}

type inputFile struct {
	name      string
	path      string
	size      int64
	digest    [sha256.Size]byte
	canonical *inputFile
	entry     *packedfs.Entry
}

// Build writes a deterministic pack and verifies every reconstructed file before
// replacing dst. The output directory must already exist and lie outside src.
// Source symlinks and special files are rejected rather than dereferenced.
func Build(src, dst string) (Stats, error) {
	var stats Stats
	src, dst, err := checkPaths(src, dst)
	if err != nil {
		return stats, err
	}
	files, err := collectFiles(src)
	if err != nil {
		return stats, err
	}
	for _, file := range files {
		stats.Files++
		if isZIP(file.name) {
			stats.ZIPFiles++
		}
		if file.size > int64(^uint64(0)>>1)-stats.SourceBytes {
			return Stats{}, fmt.Errorf("source size overflows int64")
		}
		stats.SourceBytes += file.size
	}
	if err := identifyDuplicates(files); err != nil {
		return Stats{}, err
	}

	payload, err := os.CreateTemp(filepath.Dir(dst), ".naidan-payload-*")
	if err != nil {
		return Stats{}, err
	}
	defer os.Remove(payload.Name())
	defer payload.Close()
	encoder, err := zstd.NewWriter(nil,
		zstd.WithEncoderConcurrency(1),
		zstd.WithEncoderLevel(zstd.SpeedBestCompression),
		zstd.WithWindowSize(packedfs.MaxBlockSize),
		zstd.WithSingleSegment(false),
	)
	if err != nil {
		return Stats{}, err
	}
	defer encoder.Close()
	decoder, err := zstd.NewReader(nil,
		zstd.WithDecoderConcurrency(1),
		zstd.WithDecoderMaxMemory(packedfs.MaxBlockSize),
		zstd.WithDecoderMaxWindow(packedfs.MaxBlockSize),
		zstd.WithDecodeAllCapLimit(true),
	)
	if err != nil {
		return Stats{}, err
	}
	defer decoder.Close()
	store := &blockStore{file: payload, encoder: encoder, decoder: decoder, byHash: make(map[[sha256.Size]byte][]int)}

	// Small files with the same extension share independently compressed blocks.
	// In particular, source maps remain available and compress together.
	groups := make(map[string][]*inputFile)
	var archives []*inputFile
	for _, file := range files {
		if file.canonical != nil {
			continue
		}
		file.entry = &packedfs.Entry{Name: file.name, Size: file.size}
		if isZIP(file.name) {
			archives = append(archives, file)
		} else {
			ext := strings.ToLower(path.Ext(file.name))
			groups[ext] = append(groups[ext], file)
		}
	}
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		pool := &blockPool{store: store}
		for _, file := range groups[key] {
			group, compress := pool, true
			// WASM gzip assets are already compressed. Keeping them raw also
			// allows large downloads to bypass the runtime decompression cache.
			if isGzip(file.name) {
				group, compress = nil, false
			}
			if err := packFile(file, store, group, compress); err != nil {
				return Stats{}, fmt.Errorf("pack %q: %w", file.name, err)
			}
		}
		if err := pool.flush(); err != nil {
			return Stats{}, err
		}
	}
	// Keep compressed ZIP members exactly as they are. Only archive metadata is
	// compressed together; the virtual file spans retain its original placement.
	metadata := &blockPool{store: store}
	for _, file := range archives {
		if err := packZIP(file, store, metadata); err != nil {
			return Stats{}, fmt.Errorf("pack %q: %w", file.name, err)
		}
	}
	if err := metadata.flush(); err != nil {
		return Stats{}, err
	}
	index := packedfs.Index{Blocks: store.blocks, Files: make([]packedfs.Entry, 0, len(files))}
	for _, file := range files {
		entry := file.entry
		if file.canonical != nil {
			entry = file.canonical.entry
		}
		spans := compactSpans(entry.Spans)
		var size int64
		for _, span := range spans {
			size += span.Length
		}
		if size != file.size {
			return Stats{}, fmt.Errorf("source %q changed size while packing", file.name)
		}
		index.Files = append(index.Files, packedfs.Entry{Name: file.name, Size: file.size, Spans: spans})
	}
	jsonIndex, err := json.Marshal(index)
	if err != nil {
		return Stats{}, err
	}
	if len(jsonIndex) > packedfs.MaxIndexSize {
		return Stats{}, fmt.Errorf("pack index exceeds %d bytes", packedfs.MaxIndexSize)
	}
	compressedIndex := encoder.EncodeAll(jsonIndex, nil)
	if len(compressedIndex) > packedfs.MaxIndexSize {
		return Stats{}, fmt.Errorf("compressed pack index exceeds %d bytes", packedfs.MaxIndexSize)
	}
	output, err := os.CreateTemp(filepath.Dir(dst), ".naidan-pack-*")
	if err != nil {
		return Stats{}, err
	}
	defer os.Remove(output.Name())
	defer output.Close()
	header := make([]byte, packedfs.HeaderSize)
	copy(header, packedfs.Magic)
	binary.LittleEndian.PutUint32(header[8:], uint32(len(compressedIndex)))
	binary.LittleEndian.PutUint32(header[12:], uint32(len(jsonIndex)))
	if err := writeAll(output, header); err != nil {
		return Stats{}, err
	}
	if err := writeAll(output, compressedIndex); err != nil {
		return Stats{}, err
	}
	if _, err := payload.Seek(0, io.SeekStart); err != nil {
		return Stats{}, err
	}
	if written, err := io.Copy(output, payload); err != nil {
		return Stats{}, err
	} else if written != store.size {
		return Stats{}, io.ErrUnexpectedEOF
	}
	if err := output.Chmod(0o644); err != nil {
		return Stats{}, err
	}
	if err := output.Sync(); err != nil {
		return Stats{}, err
	}
	if err := output.Close(); err != nil {
		return Stats{}, err
	}
	if err := verifyPack(output.Name(), files); err != nil {
		return Stats{}, err
	}
	if err := os.Rename(output.Name(), dst); err != nil {
		return Stats{}, err
	}
	stats.PackBytes = int64(packedfs.HeaderSize+len(compressedIndex)) + store.size
	stats.UniqueBlocks = len(store.blocks)
	return stats, nil
}

func checkPaths(src, dst string) (string, string, error) {
	src, err := filepath.Abs(src)
	if err != nil {
		return "", "", err
	}
	dst, err = filepath.Abs(dst)
	if err != nil {
		return "", "", err
	}
	info, err := os.Lstat(src)
	if err != nil {
		return "", "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", "", fmt.Errorf("source must be a directory, not a symlink: %s", src)
	}
	src, err = filepath.EvalSymlinks(src)
	if err != nil {
		return "", "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(dst))
	if err != nil {
		return "", "", err
	}
	dst = filepath.Join(parent, filepath.Base(dst))
	rel, err := filepath.Rel(src, dst)
	if err != nil {
		return "", "", err
	}
	if rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("output must lie outside the source directory")
	}
	if info, err := os.Lstat(dst); err == nil {
		if !info.Mode().IsRegular() {
			return "", "", fmt.Errorf("output is not a regular file: %s", dst)
		}
	} else if !os.IsNotExist(err) {
		return "", "", err
	}
	return src, dst, nil
}

func collectFiles(src string) ([]*inputFile, error) {
	var files []*inputFile
	err := filepath.WalkDir(src, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("source symlink is not supported: %s", name)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() < 0 {
			return fmt.Errorf("source is not a regular file: %s", name)
		}
		rel, err := filepath.Rel(src, name)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !fs.ValidPath(rel) || !utf8.ValidString(rel) {
			return fmt.Errorf("source path cannot be represented in the pack: %s", name)
		}
		files = append(files, &inputFile{name: rel, path: name, size: info.Size()})
		return nil
	})
	return files, err
}

// openInput checks the leaf again when opening, so replacing an enumerated file
// with a symlink is detected before it is read.
func openInput(name string) (*os.File, error) {
	before, err := os.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, fmt.Errorf("source is not a regular file: %s", name)
	}
	file, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	if !os.SameFile(before, after) {
		file.Close()
		return nil, fmt.Errorf("source changed while opening: %s", name)
	}
	return file, nil
}

func digestFile(name string) ([sha256.Size]byte, int64, error) {
	var digest [sha256.Size]byte
	file, err := openInput(name)
	if err != nil {
		return digest, 0, err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return digest, 0, err
	}
	copy(digest[:], hash.Sum(nil))
	return digest, size, nil
}

func identifyDuplicates(files []*inputFile) error {
	byHash := make(map[[sha256.Size]byte][]*inputFile)
	// Preserve the representation of downloads even when another extension
	// names the same bytes: gzip stays raw and ZIPs retain member boundaries.
	ordered := append([]*inputFile(nil), files...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return representationPriority(ordered[i].name) < representationPriority(ordered[j].name)
	})
	for _, file := range ordered {
		digest, size, err := digestFile(file.path)
		if err != nil {
			return err
		}
		if size != file.size {
			return fmt.Errorf("source %q changed size", file.name)
		}
		file.digest = digest
		for _, candidate := range byHash[digest] {
			if candidate.size != file.size {
				continue
			}
			equal, err := equalFiles(file.path, candidate.path)
			if err != nil {
				return err
			}
			if equal {
				file.canonical = candidate
				break
			}
		}
		if file.canonical == nil {
			byHash[digest] = append(byHash[digest], file)
		}
	}
	return nil
}

func equalFiles(left, right string) (bool, error) {
	a, err := openInput(left)
	if err != nil {
		return false, err
	}
	defer a.Close()
	b, err := openInput(right)
	if err != nil {
		return false, err
	}
	defer b.Close()
	bufA, bufB := make([]byte, 32<<10), make([]byte, 32<<10)
	for {
		nA, errA := io.ReadFull(a, bufA)
		nB, errB := io.ReadFull(b, bufB)
		if errA != nil && errA != io.EOF && errA != io.ErrUnexpectedEOF {
			return false, errA
		}
		if errB != nil && errB != io.EOF && errB != io.ErrUnexpectedEOF {
			return false, errB
		}
		if nA != nB || !bytes.Equal(bufA[:nA], bufB[:nB]) {
			return false, nil
		}
		if errA != nil || errB != nil {
			return errA == errB, nil
		}
	}
}

type blockStore struct {
	file    *os.File
	encoder *zstd.Encoder
	decoder *zstd.Decoder
	blocks  []packedfs.Block
	byHash  map[[sha256.Size]byte][]int
	size    int64
}

func (store *blockStore) add(data []byte, compress bool) (int, error) {
	if len(data) == 0 || len(data) > packedfs.MaxBlockSize {
		return 0, fmt.Errorf("invalid block size %d", len(data))
	}
	digest := sha256.Sum256(data)
	for _, id := range store.byHash[digest] {
		if !compress && store.blocks[id].Codec != packedfs.Raw {
			continue
		}
		old, err := store.read(id)
		if err != nil {
			return 0, err
		}
		if bytes.Equal(old, data) {
			return id, nil
		}
	}
	encoded, codec := data, packedfs.Raw
	if compress {
		compressed := store.encoder.EncodeAll(data, nil)
		if len(compressed) < len(data) {
			encoded, codec = compressed, packedfs.Zstandard
		}
	}
	block := packedfs.Block{Offset: store.size, CompressedSize: int64(len(encoded)), Size: int64(len(data)), Codec: codec}
	if err := writeAll(store.file, encoded); err != nil {
		return 0, err
	}
	id := len(store.blocks)
	store.blocks = append(store.blocks, block)
	store.byHash[digest] = append(store.byHash[digest], id)
	store.size += int64(len(encoded))
	return id, nil
}

func (store *blockStore) read(id int) ([]byte, error) {
	block := store.blocks[id]
	compressed := make([]byte, int(block.CompressedSize))
	if _, err := store.file.ReadAt(compressed, block.Offset); err != nil {
		return nil, err
	}
	if block.Codec == packedfs.Raw {
		return compressed, nil
	}
	return store.decoder.DecodeAll(compressed, make([]byte, 0, int(block.Size)))
}

type pendingSpan struct {
	entry *packedfs.Entry
	index int
}

type blockPool struct {
	store   *blockStore
	data    []byte
	pending []pendingSpan
}

func (pool *blockPool) add(entry *packedfs.Entry, data []byte) error {
	for len(data) > 0 {
		size := min(len(data), packedfs.MaxBlockSize-len(pool.data))
		span := packedfs.Span{Block: -1, Offset: int64(len(pool.data)), Length: int64(size)}
		pool.pending = append(pool.pending, pendingSpan{entry: entry, index: len(entry.Spans)})
		entry.Spans = append(entry.Spans, span)
		pool.data = append(pool.data, data[:size]...)
		data = data[size:]
		if len(pool.data) == packedfs.MaxBlockSize {
			if err := pool.flush(); err != nil {
				return err
			}
		}
	}
	return nil
}

func (pool *blockPool) flush() error {
	if len(pool.data) == 0 {
		return nil
	}
	id, err := pool.store.add(pool.data, true)
	if err != nil {
		return err
	}
	for _, pending := range pool.pending {
		pending.entry.Spans[pending.index].Block = id
	}
	pool.data = pool.data[:0]
	pool.pending = pool.pending[:0]
	return nil
}

func packFile(input *inputFile, store *blockStore, pool *blockPool, compress bool) error {
	file, err := openInput(input.path)
	if err != nil {
		return err
	}
	defer file.Close()
	return appendRange(input.entry, file, 0, input.size, store, pool, compress)
}

func appendRange(entry *packedfs.Entry, file *os.File, offset, length int64, store *blockStore, pool *blockPool, compress bool) error {
	reader := io.NewSectionReader(file, offset, length)
	buffer := make([]byte, min(int64(packedfs.MaxBlockSize), length))
	for length > 0 {
		n := int(min(length, int64(len(buffer))))
		if _, err := io.ReadFull(reader, buffer[:n]); err != nil {
			return err
		}
		if pool != nil && n < packedfs.MaxBlockSize {
			if err := pool.add(entry, buffer[:n]); err != nil {
				return err
			}
		} else {
			id, err := store.add(buffer[:n], compress)
			if err != nil {
				return err
			}
			entry.Spans = append(entry.Spans, packedfs.Span{Block: id, Length: int64(n)})
		}
		length -= int64(n)
	}
	return nil
}

func isZIP(name string) bool  { return strings.EqualFold(path.Ext(name), ".zip") }
func isGzip(name string) bool { return strings.EqualFold(path.Ext(name), ".gz") }

func representationPriority(name string) int {
	if isGzip(name) {
		return 0
	}
	if isZIP(name) {
		return 1
	}
	return 2
}

type zipRange struct{ start, end int64 }

func zipRanges(file *os.File, size int64) ([]zipRange, bool) {
	reader, err := zip.NewReader(file, size)
	if err != nil {
		return nil, false
	}
	var ranges []zipRange
	for _, member := range reader.File {
		if member.CompressedSize64 == 0 {
			continue
		}
		offset, err := member.DataOffset()
		if err != nil || offset < 0 || offset > size || member.CompressedSize64 > uint64(size-offset) {
			return nil, false
		}
		ranges = append(ranges, zipRange{start: offset, end: offset + int64(member.CompressedSize64)})
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	var end int64
	for _, span := range ranges {
		if span.start < end {
			return nil, false
		}
		end = span.end
	}
	return ranges, true
}

func packZIP(input *inputFile, store *blockStore, metadata *blockPool) error {
	file, err := openInput(input.path)
	if err != nil {
		return err
	}
	defer file.Close()
	ranges, valid := zipRanges(file, input.size)
	if !valid {
		// Opaque fallback preserves even archives we cannot interpret. No archive
		// recompression or extraction is necessary for serving exact ZIP bytes.
		return appendRange(input.entry, file, 0, input.size, store, nil, false)
	}
	var cursor int64
	for _, span := range ranges {
		if err := appendRange(input.entry, file, cursor, span.start-cursor, store, metadata, true); err != nil {
			return err
		}
		if err := appendRange(input.entry, file, span.start, span.end-span.start, store, nil, false); err != nil {
			return err
		}
		cursor = span.end
	}
	return appendRange(input.entry, file, cursor, input.size-cursor, store, metadata, true)
}

func compactSpans(spans []packedfs.Span) []packedfs.Span {
	var result []packedfs.Span
	for _, span := range spans {
		if len(result) > 0 {
			last := &result[len(result)-1]
			if last.Block == span.Block && last.Offset+last.Length == span.Offset {
				last.Length += span.Length
				continue
			}
		}
		result = append(result, span)
	}
	return result
}

func verifyPack(name string, inputs []*inputFile) error {
	data, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	pack, err := packedfs.New(string(data))
	if err != nil {
		return fmt.Errorf("verify pack: %w", err)
	}
	for _, input := range inputs {
		file, err := pack.Open(input.name)
		if err != nil {
			return fmt.Errorf("verify %q: %w", input.name, err)
		}
		hash := sha256.New()
		size, readErr := io.Copy(hash, file)
		closeErr := file.Close()
		if readErr != nil {
			return fmt.Errorf("verify %q: %w", input.name, readErr)
		}
		if closeErr != nil {
			return closeErr
		}
		if size != input.size || !bytes.Equal(hash.Sum(nil), input.digest[:]) {
			return fmt.Errorf("reconstructed content differs from source %q", input.name)
		}
		current, currentSize, err := digestFile(input.path)
		if err != nil {
			return err
		}
		if currentSize != input.size || current != input.digest {
			return fmt.Errorf("source %q changed while packing", input.name)
		}
	}
	return nil
}

func writeAll(writer io.Writer, data []byte) error {
	n, err := writer.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	return err
}
