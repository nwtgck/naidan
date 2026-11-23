package packbuild_test

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"io"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"testing"

	"github.com/klauspost/compress/zstd"
	"naidan-server/internal/packbuild"
	"naidan-server/internal/packedfs"
)

func put(t *testing.T, root, name string, data []byte) {
	t.Helper()
	name = filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertRoundTrip(t *testing.T, source, output string) {
	t.Helper()
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	pack, err := packedfs.New(string(data))
	if err != nil {
		t.Fatal(err)
	}
	err = fs.WalkDir(os.DirFS(source), ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		want, err := os.ReadFile(filepath.Join(source, filepath.FromSlash(name)))
		if err != nil {
			return err
		}
		got, err := fs.ReadFile(pack, name)
		if err != nil {
			return err
		}
		if !bytes.Equal(got, want) {
			t.Errorf("file %q differs from source", name)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestBuildRoundTripAndDeterminism(t *testing.T) {
	source, out := t.TempDir(), t.TempDir()
	put(t, source, "index.html", []byte("<!doctype html><title>Naidan</title>"))
	put(t, source, "assets/code.js", bytes.Repeat([]byte("const answer = 42;\n"), 1000))
	put(t, source, "assets/code-copy.js", bytes.Repeat([]byte("const answer = 42;\n"), 1000))
	put(t, source, "assets/code.js.map", bytes.Repeat([]byte(`{"sources":["code.ts"],"mappings":"AAAA"}`), 80000))
	put(t, source, "assets/second.js.map", []byte(`{"sources":["second.ts"]}`))
	put(t, source, "assets/.hidden", []byte("hidden file"))
	put(t, source, "empty.txt", nil)
	first, second := filepath.Join(out, "first.pack"), filepath.Join(out, "second.pack")
	stats, err := packbuild.Build(source, first)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Files != 7 || stats.ZIPFiles != 0 || stats.SourceBytes <= stats.PackBytes {
		t.Fatalf("unexpected stats: %+v", stats)
	}
	assertRoundTrip(t, source, first)
	if _, err := packbuild.Build(source, second); err != nil {
		t.Fatal(err)
	}
	a, err := os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(second)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("packing unchanged files did not produce identical bytes")
	}
}

func makeZIP(t *testing.T, directory string, method uint16, content []byte, prefix, suffix string) []byte {
	t.Helper()
	var data bytes.Buffer
	data.WriteString(prefix)
	writer := zip.NewWriter(&data)
	writer.SetOffset(int64(len(prefix)))
	if err := writer.SetComment("Original archive comment: " + directory); err != nil {
		t.Fatal(err)
	}
	writer.RegisterCompressor(93, func(output io.Writer) (io.WriteCloser, error) {
		return zstd.NewWriter(output, zstd.WithEncoderConcurrency(1))
	})
	if _, err := writer.CreateHeader(&zip.FileHeader{Name: directory + "/", Method: zip.Store}); err != nil {
		t.Fatal(err)
	}
	file, err := writer.CreateHeader(&zip.FileHeader{Name: directory + "/asset.bin", Method: method, Extra: []byte{0x55, 0x54, 1, 0, 0}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	data.WriteString(suffix)
	return data.Bytes()
}

func TestZIPPayloadSharingAndExactBytes(t *testing.T) {
	source, out := t.TempDir(), t.TempDir()
	content := make([]byte, 2*packedfs.MaxBlockSize+123)
	if _, err := rand.New(rand.NewSource(938)).Read(content); err != nil {
		t.Fatal(err)
	}
	jaZIP := makeZIP(t, "ja-package", zip.Deflate, content, "prefix-ja", "suffix-ja")
	put(t, source, "a-ordinary-alias.bin", jaZIP)
	put(t, source, "standalone-ja.zip", jaZIP)
	put(t, source, "standalone-en.zip", makeZIP(t, "en-package", zip.Deflate, content, "prefix-en", "suffix-en"))
	output := filepath.Join(out, "assets.pack")
	stats, err := packbuild.Build(source, output)
	if err != nil {
		t.Fatal(err)
	}
	if stats.ZIPFiles != 2 || stats.PackBytes >= stats.SourceBytes/2 {
		t.Fatalf("shared compressed members were not deduplicated: %+v", stats)
	}
	assertRoundTrip(t, source, output)
}

func TestZIPStoredZstandardAndOpaqueFallback(t *testing.T) {
	source, out := t.TempDir(), t.TempDir()
	content := bytes.Repeat([]byte("source map and application source\n"), 10000)
	put(t, source, "stored.zip", makeZIP(t, "stored", zip.Store, content, "", ""))
	put(t, source, "method93.zip", makeZIP(t, "zstandard", 93, content, "", ""))
	put(t, source, "invalid.ZIP", append([]byte("PK\x03\x04"), content...))
	badBounds := makeZIP(t, "bad-bounds", zip.Deflate, content, "", "")
	central := bytes.Index(badBounds, []byte("PK\x01\x02"))
	if central < 0 {
		t.Fatal("missing central directory in fixture")
	}
	// The first directory entry now claims bytes beyond the archive. Preserve
	// this malformed ZIP through the opaque fallback, without interpreting it.
	binary.LittleEndian.PutUint32(badBounds[central+20:], 0x7fffffff)
	put(t, source, "bad-bounds.zip", badBounds)
	var emptyZIP bytes.Buffer
	if err := zip.NewWriter(&emptyZIP).Close(); err != nil {
		t.Fatal(err)
	}
	put(t, source, "empty.zip", emptyZIP.Bytes())
	output := filepath.Join(out, "assets.pack")
	if _, err := packbuild.Build(source, output); err != nil {
		t.Fatal(err)
	}
	assertRoundTrip(t, source, output)
}

func TestEmptySource(t *testing.T) {
	source, out := t.TempDir(), t.TempDir()
	output := filepath.Join(out, "empty.pack")
	stats, err := packbuild.Build(source, output)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Files != 0 || stats.SourceBytes != 0 || stats.UniqueBlocks != 0 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
	assertRoundTrip(t, source, output)
}

func TestGzipAssetsUseRawBlocks(t *testing.T) {
	source, out := t.TempDir(), t.TempDir()
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(bytes.Repeat([]byte("WebAssembly gzip asset content\n"), 1000)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	// Repeated complete gzip streams make a valid, easily outer-compressed
	// gzip file. The builder must nevertheless keep all its spans raw.
	content := bytes.Repeat(compressed.Bytes(), packedfs.MaxBlockSize/len(compressed.Bytes())+2)
	// Aliases and a chunk previously compressed under another extension must
	// not defeat the raw requirement for the gzip path.
	put(t, source, "a-before-gzip.data", content)
	put(t, source, "other.bin", content[:packedfs.MaxBlockSize])
	put(t, source, "runtime/core.wasm.GZ", content)
	put(t, source, "code.js", bytes.Repeat([]byte("const answer = 42;\n"), 1000))
	output := filepath.Join(out, "assets.pack")
	if _, err := packbuild.Build(source, output); err != nil {
		t.Fatal(err)
	}
	assertRoundTrip(t, source, output)
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	compressedSize := binary.LittleEndian.Uint32(data[8:12])
	decoder, err := zstd.NewReader(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer decoder.Close()
	manifest, err := decoder.DecodeAll(data[packedfs.HeaderSize:packedfs.HeaderSize+int(compressedSize)], nil)
	if err != nil {
		t.Fatal(err)
	}
	var index packedfs.Index
	if err := json.Unmarshal(manifest, &index); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, file := range index.Files {
		if file.Name != "runtime/core.wasm.GZ" {
			continue
		}
		found = true
		for _, span := range file.Spans {
			if index.Blocks[span.Block].Codec != packedfs.Raw {
				t.Fatal("gzip asset was recompressed")
			}
		}
	}
	if !found {
		t.Fatal("gzip asset missing from manifest")
	}
}

func TestRejectsSourceSymlinksAndKeepsExistingOutput(t *testing.T) {
	source, out := t.TempDir(), t.TempDir()
	put(t, source, "real.txt", []byte("real"))
	output := filepath.Join(out, "assets.pack")
	previous := []byte("previous pack must remain intact")
	if err := os.WriteFile(output, previous, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(source, "real.txt"), filepath.Join(source, "link.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := packbuild.Build(source, output); err == nil {
		t.Fatal("accepted symlink inside source")
	}
	got, err := os.ReadFile(output)
	if err != nil || !bytes.Equal(got, previous) {
		t.Fatalf("existing output changed on failure: %q, %v", got, err)
	}
	alias := filepath.Join(out, "source-alias")
	if err := os.Symlink(source, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := packbuild.Build(alias, output); err == nil {
		t.Fatal("accepted symlink source root")
	}
}

func TestRejectsOutputInsideSourceIncludingDirectoryAliases(t *testing.T) {
	source, out := t.TempDir(), t.TempDir()
	put(t, source, "asset.txt", []byte("asset"))
	if _, err := packbuild.Build(source, filepath.Join(source, "assets.pack")); err == nil {
		t.Fatal("accepted output inside source")
	}
	alias := filepath.Join(out, "source-alias")
	if err := os.Symlink(source, alias); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := packbuild.Build(source, filepath.Join(alias, "assets.pack")); err == nil {
		t.Fatal("accepted aliased output inside source")
	}
}
