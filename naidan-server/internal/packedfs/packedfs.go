package packedfs

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"path"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/klauspost/compress/zstd"
)

// FS is a read-only filesystem backed by an embedded pack. The manifest and
// directory tree are kept in memory, but file bodies have a fixed-size cache.
// Independent open files may be used concurrently.
type FS struct {
	payload string
	blocks  []Block
	nodes   map[string]*node
	cache   *blockCache
}

type node struct {
	name     string
	size     int64
	dir      bool
	spans    []Span
	ends     []int64
	children []*node
}

// New validates the manifest without decompressing asset bodies. data should
// be an embedded string, which avoids copying the entire pack at startup.
func New(data string) (*FS, error) {
	return newWithSlots(data, 4)
}

func newWithSlots(data string, slots int) (*FS, error) {
	if slots < 1 || slots > 4 {
		return nil, errors.New("packedfs: invalid cache size")
	}
	if len(data) < HeaderSize || data[:len(Magic)] != Magic {
		return nil, errors.New("packedfs: invalid header")
	}
	compressed := int64(binary.LittleEndian.Uint32([]byte(data[8:12])))
	uncompressed := int64(binary.LittleEndian.Uint32([]byte(data[12:16])))
	if compressed <= 0 || compressed > MaxIndexSize || uncompressed <= 0 || uncompressed > MaxIndexSize || compressed > int64(len(data)-HeaderSize) {
		return nil, errors.New("packedfs: invalid index size")
	}
	decoder, err := zstd.NewReader(nil,
		zstd.WithDecoderConcurrency(1), zstd.WithDecoderLowmem(true),
		zstd.WithDecoderMaxWindow(MaxBlockSize), zstd.WithDecoderMaxMemory(MaxIndexSize),
		zstd.WithDecodeAllCapLimit(true))
	if err != nil {
		return nil, fmt.Errorf("packedfs: index decoder: %w", err)
	}
	indexBytes, err := decoder.DecodeAll([]byte(data[HeaderSize:HeaderSize+compressed]), make([]byte, 0, int(uncompressed)))
	decoder.Close()
	if err != nil {
		return nil, fmt.Errorf("packedfs: invalid compressed index: %w", err)
	}
	if int64(len(indexBytes)) != uncompressed {
		return nil, errors.New("packedfs: invalid decoded index size")
	}
	var index Index
	jsonDecoder := json.NewDecoder(bytes.NewReader(indexBytes))
	jsonDecoder.DisallowUnknownFields()
	if err := jsonDecoder.Decode(&index); err != nil {
		return nil, fmt.Errorf("packedfs: invalid index: %w", err)
	}
	if err := jsonDecoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("packedfs: trailing index data")
	}
	f := &FS{
		payload: data[HeaderSize+compressed:], blocks: index.Blocks,
		nodes: map[string]*node{".": {name: ".", dir: true}},
		cache: newBlockCache(slots),
	}
	var end int64
	for i, block := range index.Blocks {
		if block.Offset != end || block.Size <= 0 || block.Size > MaxBlockSize || block.CompressedSize <= 0 || block.CompressedSize > block.Size || block.CompressedSize > int64(len(f.payload))-end {
			return nil, fmt.Errorf("packedfs: invalid block %d", i)
		}
		if block.Codec != Raw && block.Codec != Zstandard || block.Codec == Raw && block.CompressedSize != block.Size {
			return nil, fmt.Errorf("packedfs: invalid codec in block %d", i)
		}
		end += block.CompressedSize
	}
	if end != int64(len(f.payload)) {
		return nil, errors.New("packedfs: unreferenced payload bytes")
	}
	for _, entry := range index.Files {
		if entry.Name == "." || !fs.ValidPath(entry.Name) || strings.ContainsRune(entry.Name, 0) || entry.Size < 0 {
			return nil, errors.New("packedfs: invalid file name or size")
		}
		if _, exists := f.nodes[entry.Name]; exists {
			return nil, fmt.Errorf("packedfs: duplicate file %q", entry.Name)
		}
		n := &node{name: entry.Name, size: entry.Size, spans: entry.Spans, ends: make([]int64, 0, len(entry.Spans))}
		var size int64
		for _, span := range entry.Spans {
			if span.Block < 0 || span.Block >= len(f.blocks) || span.Offset < 0 || span.Length <= 0 {
				return nil, fmt.Errorf("packedfs: invalid span in %q", entry.Name)
			}
			block := f.blocks[span.Block]
			if span.Offset > block.Size || span.Length > block.Size-span.Offset || span.Length > entry.Size-size {
				return nil, fmt.Errorf("packedfs: invalid span bounds in %q", entry.Name)
			}
			size += span.Length
			n.ends = append(n.ends, size)
		}
		if size != entry.Size {
			return nil, fmt.Errorf("packedfs: invalid file length for %q", entry.Name)
		}
		f.nodes[entry.Name] = n
	}
	// Add directories only after files, so all file/directory collisions are
	// rejected independently of manifest ordering.
	for name := range f.nodes {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if existing, ok := f.nodes[parent]; ok {
				if !existing.dir {
					return nil, fmt.Errorf("packedfs: file/directory collision at %q", parent)
				}
				break
			}
			f.nodes[parent] = &node{name: parent, dir: true}
		}
	}
	for name, n := range f.nodes {
		if name != "." {
			parent := f.nodes[path.Dir(name)]
			parent.children = append(parent.children, n)
		}
	}
	for _, n := range f.nodes {
		sort.Slice(n.children, func(i, j int) bool { return n.children[i].Name() < n.children[j].Name() })
	}
	return f, nil
}

// Open implements fs.FS. It does not acquire a decompression buffer.
func (f *FS) Open(name string) (fs.File, error) {
	return f.open(context.Background(), name)
}

func (f *FS) open(ctx context.Context, name string) (fs.File, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	n, ok := f.nodes[name]
	if !ok {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return &file{fs: f, node: n, ctx: ctx}, nil
}

type contextFS struct {
	fs  *FS
	ctx context.Context
}

func (f contextFS) Open(name string) (fs.File, error) { return f.fs.open(f.ctx, name) }

// Handler keeps net/http's FileServer semantics, including directory redirects,
// MIME sniffing, HEAD and byte ranges, while cancellation reaches cache waits.
func (f *FS) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.FileServer(http.FS(contextFS{fs: f, ctx: r.Context()})).ServeHTTP(w, r)
	})
}

func (n *node) Name() string               { return path.Base(n.name) }
func (n *node) Size() int64                { return n.size }
func (n *node) ModTime() time.Time         { return time.Time{} }
func (n *node) IsDir() bool                { return n.dir }
func (n *node) Sys() any                   { return nil }
func (n *node) Type() fs.FileMode          { return n.Mode().Type() }
func (n *node) Info() (fs.FileInfo, error) { return n, nil }
func (n *node) Mode() fs.FileMode {
	if n.dir {
		return fs.ModeDir | 0555
	}
	return 0444
}

type file struct {
	fs     *FS
	node   *node
	ctx    context.Context
	pos    int64
	dirPos int
	// FileServer may close a multipart response while its copy goroutine is
	// still unwinding after a disconnected client. No decoder is held by Close.
	closed atomic.Bool
}

func (f *file) pathError(op string, err error) error {
	return &fs.PathError{Op: op, Path: f.node.name, Err: err}
}

func (f *file) Stat() (fs.FileInfo, error) {
	if f.closed.Load() {
		return nil, f.pathError("stat", fs.ErrClosed)
	}
	return f.node, nil
}

func (f *file) Close() error {
	if f.closed.Swap(true) {
		return f.pathError("close", fs.ErrClosed)
	}
	return nil
}

func (f *file) Read(p []byte) (int, error) {
	n, err := f.ReadAt(p, f.pos)
	f.pos += int64(n)
	return n, err
}

func (f *file) ReadAt(p []byte, off int64) (int, error) {
	if f.closed.Load() {
		return 0, f.pathError("read", fs.ErrClosed)
	}
	if f.node.dir {
		return 0, f.pathError("read", errors.New("is a directory"))
	}
	if off < 0 {
		return 0, f.pathError("read", fs.ErrInvalid)
	}
	if len(p) == 0 {
		return 0, nil
	}
	if off >= f.node.size {
		return 0, io.EOF
	}
	n := 0
	i := sort.Search(len(f.node.ends), func(i int) bool { return f.node.ends[i] > off })
	for n < len(p) && i < len(f.node.spans) {
		if err := f.ctx.Err(); err != nil {
			return n, f.pathError("read", err)
		}
		span := f.node.spans[i]
		start := f.node.ends[i] - span.Length
		within := off - start
		count := min(int64(len(p)-n), span.Length-within)
		if err := f.fs.readBlock(f.ctx, span.Block, span.Offset+within, p[n:n+int(count)]); err != nil {
			return n, f.pathError("read", err)
		}
		n += int(count)
		off += count
		i++
	}
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (f *file) Seek(offset int64, whence int) (int64, error) {
	if f.closed.Load() {
		return 0, f.pathError("seek", fs.ErrClosed)
	}
	if f.node.dir {
		return 0, f.pathError("seek", fs.ErrInvalid)
	}
	var base int64
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		base = f.pos
	case io.SeekEnd:
		base = f.node.size
	default:
		return 0, f.pathError("seek", fs.ErrInvalid)
	}
	if offset < -base || offset > math.MaxInt64-base {
		return 0, f.pathError("seek", fs.ErrInvalid)
	}
	f.pos = base + offset
	return f.pos, nil
}

func (f *file) ReadDir(n int) ([]fs.DirEntry, error) {
	if f.closed.Load() {
		return nil, f.pathError("readdir", fs.ErrClosed)
	}
	if !f.node.dir {
		return nil, f.pathError("readdir", errors.New("not a directory"))
	}
	remaining := len(f.node.children) - f.dirPos
	if n > 0 && remaining == 0 {
		return nil, io.EOF
	}
	if n <= 0 || n > remaining {
		n = remaining
	}
	entries := make([]fs.DirEntry, n)
	for i := range entries {
		entries[i] = f.node.children[f.dirPos+i]
	}
	f.dirPos += n
	return entries, nil
}
