// Package packedfs serves immutable, independently compressed embedded blocks.
// Asset bodies are decoded only while servicing a bounded read operation.
package packedfs

const (
	Magic        = "NAIDANP1"
	HeaderSize   = 16
	MaxBlockSize = 1 << 20
	MaxIndexSize = 16 << 20
	Raw          = 0
	Zstandard    = 1
)

// Index is the versioned build-time manifest. Offsets are relative to payload.
// JSON names deliberately stay short; the complete index is compressed too.
type Index struct {
	Blocks []Block `json:"b"`
	Files  []Entry `json:"f"`
}

type Block struct {
	Offset         int64 `json:"o"`
	CompressedSize int64 `json:"c"`
	Size           int64 `json:"s"`
	Codec          int   `json:"t"`
}

type Entry struct {
	Name  string `json:"n"`
	Size  int64  `json:"s"`
	Spans []Span `json:"p"`
}

type Span struct {
	Block  int   `json:"b"`
	Offset int64 `json:"o"`
	Length int64 `json:"n"`
}
