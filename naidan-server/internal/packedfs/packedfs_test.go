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
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/klauspost/compress/zstd"
)

// The fixture writer encodes the documented wire format independently of the
// production builder, so reader tests do not merely roundtrip its implementation.
func testPack(t *testing.T, index Index, payload []byte) string {
	t.Helper()
	raw, err := json.Marshal(index)
	if err != nil {
		t.Fatal(err)
	}
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1), zstd.WithWindowSize(MaxBlockSize), zstd.WithSingleSegment(false))
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	compressed := encoder.EncodeAll(raw, nil)
	out := make([]byte, HeaderSize, HeaderSize+len(compressed)+len(payload))
	copy(out, Magic)
	binary.LittleEndian.PutUint32(out[8:12], uint32(len(compressed)))
	binary.LittleEndian.PutUint32(out[12:16], uint32(len(raw)))
	out = append(out, compressed...)
	out = append(out, payload...)
	return string(out)
}

func testBlock(t *testing.T, data []byte, codec int) (Block, []byte) {
	t.Helper()
	encoded := data
	if codec == Zstandard {
		encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1), zstd.WithWindowSize(MaxBlockSize))
		if err != nil {
			t.Fatal(err)
		}
		encoded = encoder.EncodeAll(data, nil)
		encoder.Close()
	}
	return Block{CompressedSize: int64(len(encoded)), Size: int64(len(data)), Codec: codec}, encoded
}

func testFiles(t *testing.T) (string, fstest.MapFS) {
	t.Helper()
	files := fstest.MapFS{
		"index.html":               {Data: []byte("<!doctype html><title>root</title>\n")},
		"nested/index.html":        {Data: []byte("<!doctype html><title>nested</title>\n")},
		"nested/file.txt":          {Data: []byte("ordinary nested file\n")},
		"listing/file.txt":         {Data: []byte("directory without index\n")},
		"empty.bin":                {Data: []byte{}},
		".hidden":                  {Data: []byte("dotfiles remain visible")},
		"_private.txt":             {Data: []byte("underscore files remain visible")},
		"日本語 space%#.txt":          {Data: []byte("unicode filename\n")},
		"unknown.somethingelse":    {Data: []byte("<!doctype html><title>sniff me</title>")},
		"assets/app.js.map":        {Data: bytes.Repeat([]byte("{\"source\":\"original code\"}\n"), 4000)},
		"naidan-standalone.zip":    {Data: []byte("PK\x03\x04exact archive representation")},
		"naidan-standalone-ja.zip": {Data: []byte("PK\x03\x04exact localized representation")},
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	var index Index
	var payload []byte
	for _, name := range names {
		data := files[name].Data
		entry := Entry{Name: name, Size: int64(len(data))}
		if len(data) != 0 {
			codec := Raw
			if strings.HasSuffix(name, ".map") {
				codec = Zstandard
			}
			block, encoded := testBlock(t, data, codec)
			block.Offset = int64(len(payload))
			entry.Spans = []Span{{Block: len(index.Blocks), Length: int64(len(data))}}
			index.Blocks = append(index.Blocks, block)
			payload = append(payload, encoded...)
		}
		index.Files = append(index.Files, entry)
	}
	return testPack(t, index, payload), files
}

func TestFileSystemContract(t *testing.T) {
	packed, expected := testFiles(t)
	got, err := newWithSlots(packed, 1)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(expected))
	for name := range expected {
		names = append(names, name)
	}
	if err := fstest.TestFS(got, names...); err != nil {
		t.Fatal(err)
	}
	for name, file := range expected {
		body, err := fs.ReadFile(got, name)
		if err != nil || !bytes.Equal(body, file.Data) {
			t.Fatalf("ReadFile(%q): len=%d err=%v", name, len(body), err)
		}
	}
	for _, path := range []string{"", "/index.html", "../index.html", "nested/../index.html", "nested//file.txt"} {
		if f, err := got.Open(path); err == nil {
			f.Close()
			t.Errorf("accepted invalid path %q", path)
		}
	}
}

type normalizedPart struct{ Range, Type, Body string }

func comparableBody(t *testing.T, response *httptest.ResponseRecorder) (string, any) {
	t.Helper()
	contentType := response.Header().Get("Content-Type")
	mediaType, params, _ := mime.ParseMediaType(contentType)
	if mediaType != "multipart/byteranges" {
		return contentType, response.Body.String()
	}
	reader := multipart.NewReader(bytes.NewReader(response.Body.Bytes()), params["boundary"])
	var parts []normalizedPart
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(part)
		if err != nil {
			t.Fatal(err)
		}
		parts = append(parts, normalizedPart{part.Header.Get("Content-Range"), part.Header.Get("Content-Type"), string(body)})
		part.Close()
	}
	return mediaType, parts
}

func TestHTTPParityWithFileServer(t *testing.T) {
	enableMultipartRanges(t)
	packed, expected := testFiles(t)
	got, err := newWithSlots(packed, 1)
	if err != nil {
		t.Fatal(err)
	}
	actualHandler, referenceHandler := got.Handler(), http.FileServer(http.FS(expected))
	tests := []struct{ method, target, rangeValue string }{
		{"GET", "/", ""}, {"GET", "/index.html", ""},
		{"GET", "/nested", ""}, {"GET", "/nested/", ""}, {"GET", "/nested/index.html", ""},
		{"GET", "/listing/", ""}, {"GET", "/nested/file.txt/", ""},
		{"GET", "/missing", ""}, {"GET", "/.hidden", ""}, {"GET", "/_private.txt", ""},
		{"GET", "/" + url.PathEscape("日本語 space%#.txt"), ""},
		{"HEAD", "/unknown.somethingelse", ""}, {"HEAD", "/assets/app.js.map", ""},
		{"GET", "/empty.bin", ""}, {"GET", "/empty.bin", "bytes=0-0"},
		{"GET", "/assets/app.js.map", "bytes=0-30"},
		{"GET", "/assets/app.js.map", "bytes=-25"},
		{"GET", "/assets/app.js.map", "bytes=1000000000-"},
		{"GET", "/assets/app.js.map", "bytes=30-20"},
		{"GET", "/assets/app.js.map", "bytes=0-2,100-110"},
		{"HEAD", "/naidan-standalone.zip", "bytes=4-12"},
		{"POST", "/nested/file.txt", ""},
	}
	for _, test := range tests {
		t.Run(test.method+" "+test.target+" "+test.rangeValue, func(t *testing.T) {
			serve := func(handler http.Handler) *httptest.ResponseRecorder {
				req := httptest.NewRequest(test.method, test.target, nil)
				if test.rangeValue != "" {
					req.Header.Set("Range", test.rangeValue)
				}
				rec := httptest.NewRecorder()
				done := make(chan struct{})
				go func() { defer close(done); handler.ServeHTTP(rec, req) }()
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("handler deadlocked, including with one decode slot")
				}
				return rec
			}
			want, actual := serve(referenceHandler), serve(actualHandler)
			if want.Code != actual.Code {
				t.Fatalf("status=%d, want %d", actual.Code, want.Code)
			}
			wantType, wantBody := comparableBody(t, want)
			actualType, actualBody := comparableBody(t, actual)
			if wantType != actualType || !reflect.DeepEqual(wantBody, actualBody) {
				t.Fatalf("response differs: Content-Type %q vs %q; body equality=%v", actualType, wantType, reflect.DeepEqual(wantBody, actualBody))
			}
			if test.rangeValue == "bytes=0-2,100-110" {
				if actual.Code != http.StatusPartialContent || actualType != "multipart/byteranges" {
					t.Fatalf("multipart response was not exercised: status=%d type=%q", actual.Code, actualType)
				}
				parts := actualBody.([]normalizedPart)
				if len(parts) != 2 {
					t.Fatalf("multipart response has %d parts, want 2", len(parts))
				}
				data := expected["assets/app.js.map"].Data
				for i, bounds := range [][2]int{{0, 2}, {100, 110}} {
					wantRange := fmt.Sprintf("bytes %d-%d/%d", bounds[0], bounds[1], len(data))
					if parts[i].Range != wantRange || parts[i].Body != string(data[bounds[0]:bounds[1]+1]) {
						t.Errorf("multipart part %d differs from the requested source bytes", i)
					}
				}
			}
			for _, name := range []string{"Content-Length", "Content-Range", "Accept-Ranges", "Location", "Content-Encoding", "Last-Modified", "ETag"} {
				if actual.Header().Get(name) != want.Header().Get(name) {
					t.Errorf("%s=%q, want %q", name, actual.Header().Get(name), want.Header().Get(name))
				}
			}
		})
	}
}

func TestSharedSpansReadSeekAndMaximumBlock(t *testing.T) {
	raw := bytes.Repeat([]byte("maximum block repeat\n"), MaxBlockSize/21+1)[:MaxBlockSize]
	block, compressed := testBlock(t, raw, Zstandard)
	entry := Entry{Name: "joined.bin", Size: 25, Spans: []Span{
		{Block: 0, Offset: MaxBlockSize - 7, Length: 7},
		{Block: 0, Offset: 10, Length: 11},
		{Block: 0, Offset: MaxBlockSize - 7, Length: 7},
	}}
	index := Index{Blocks: []Block{block}, Files: []Entry{entry, {Name: "full.bin", Size: MaxBlockSize, Spans: []Span{{Block: 0, Length: MaxBlockSize}}}}}
	got, err := newWithSlots(testPack(t, index, compressed), 1)
	if err != nil {
		t.Fatal(err)
	}
	want := append(append(append([]byte{}, raw[len(raw)-7:]...), raw[10:21]...), raw[len(raw)-7:]...)
	f, err := got.Open("joined.bin")
	if err != nil {
		t.Fatal(err)
	}
	seeker, ok := f.(io.ReadSeeker)
	if !ok {
		t.Fatal("packed file must support Seek for HTTP Range")
	}
	for offset := int64(0); offset <= int64(len(want)+2); offset++ {
		if _, err := seeker.Seek(offset, io.SeekStart); err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(seeker)
		if err != nil {
			t.Fatal(err)
		}
		start := min(int(offset), len(want))
		if !bytes.Equal(body, want[start:]) {
			t.Fatalf("incorrect data after seek %d", offset)
		}
	}
	if _, err := seeker.Seek(-1, io.SeekStart); err == nil {
		t.Error("negative seek accepted")
	}
	if _, err := seeker.Seek(0, 99); err == nil {
		t.Error("invalid whence accepted")
	}
	if _, err := seeker.Seek(math.MaxInt64, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if _, err := seeker.Seek(1, io.SeekCurrent); err == nil {
		t.Error("overflowing seek accepted")
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Read(make([]byte, 1)); !errors.Is(err, fs.ErrClosed) {
		t.Errorf("read after Close error=%v, want fs.ErrClosed", err)
	}
	f.Close() // idempotence must not return a cache slot twice.
	all, err := fs.ReadFile(got, "full.bin")
	if err != nil || !bytes.Equal(all, raw) {
		t.Fatalf("maximum-size block read failed: len=%d err=%v", len(all), err)
	}
}

func TestMalformedManifestRejected(t *testing.T) {
	valid := func() Index {
		return Index{Blocks: []Block{{CompressedSize: 3, Size: 3, Codec: Raw}}, Files: []Entry{{Name: "a", Size: 3, Spans: []Span{{Length: 3}}}}}
	}
	tests := map[string]func(*Index){
		"duplicate name":          func(i *Index) { i.Files = append(i.Files, i.Files[0]) },
		"directory collision":     func(i *Index) { e := i.Files[0]; e.Name = "a/b"; i.Files = append(i.Files, e) },
		"invalid path":            func(i *Index) { i.Files[0].Name = "../a" },
		"absolute path":           func(i *Index) { i.Files[0].Name = "/a" },
		"zero span":               func(i *Index) { i.Files[0].Spans[0].Length = 0 },
		"negative span":           func(i *Index) { i.Files[0].Spans[0].Length = -1 },
		"negative span offset":    func(i *Index) { i.Files[0].Spans[0].Offset = -1 },
		"unknown block":           func(i *Index) { i.Files[0].Spans[0].Block = 2 },
		"negative block":          func(i *Index) { i.Files[0].Spans[0].Block = -1 },
		"span past block":         func(i *Index) { i.Files[0].Spans[0].Offset = 1 },
		"overflowing span":        func(i *Index) { i.Files[0].Spans[0].Offset = math.MaxInt64 },
		"size mismatch":           func(i *Index) { i.Files[0].Size = 4 },
		"negative file size":      func(i *Index) { i.Files[0].Size = -1 },
		"missing spans":           func(i *Index) { i.Files[0].Spans = nil },
		"unknown codec":           func(i *Index) { i.Blocks[0].Codec = 7 },
		"negative payload offset": func(i *Index) { i.Blocks[0].Offset = -1 },
		"payload past end":        func(i *Index) { i.Blocks[0].Offset = 2 },
		"overflowing payload":     func(i *Index) { i.Blocks[0].Offset = math.MaxInt64 },
		"raw size mismatch":       func(i *Index) { i.Blocks[0].Size = 4 },
		"oversized block":         func(i *Index) { i.Blocks[0].Size = MaxBlockSize + 1 },
		"zero compressed size":    func(i *Index) { i.Blocks[0].CompressedSize = 0 },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			index := valid()
			mutate(&index)
			if _, err := New(testPack(t, index, []byte("abc"))); err == nil {
				t.Fatal("invalid manifest accepted")
			}
		})
	}
	good := testPack(t, valid(), []byte("abc"))
	for _, cut := range []int{0, 1, 8, HeaderSize - 1, len(good) - 1} {
		if _, err := New(good[:cut]); err == nil {
			t.Errorf("truncated pack accepted at %d", cut)
		}
	}
	for _, field := range []int{8, 12} {
		broken := []byte(good)
		binary.LittleEndian.PutUint32(broken[field:field+4], math.MaxUint32)
		if _, err := New(string(broken)); err == nil {
			t.Errorf("oversized header length accepted at %d", field)
		}
	}
	broken := []byte(good)
	broken[0] ^= 0xff
	if _, err := New(string(broken)); err == nil {
		t.Error("unknown magic accepted")
	}
}

func TestCorruptBlockDoesNotPoisonOtherReaders(t *testing.T) {
	raw := bytes.Repeat([]byte("verify checksum "), 4000)
	a, pa := testBlock(t, raw, Zstandard)
	b, pb := testBlock(t, raw, Zstandard)
	b.Offset = int64(len(pa))
	pa[len(pa)-1] ^= 0xff
	index := Index{Blocks: []Block{a, b}, Files: []Entry{
		{Name: "broken", Size: int64(len(raw)), Spans: []Span{{Block: 0, Length: int64(len(raw))}}},
		{Name: "good", Size: int64(len(raw)), Spans: []Span{{Block: 1, Length: int64(len(raw))}}},
	}}
	got, err := newWithSlots(testPack(t, index, append(pa, pb...)), 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fs.ReadFile(got, "broken"); err == nil {
		t.Error("corrupt compressed block read successfully")
	}
	actual, err := fs.ReadFile(got, "good")
	if err != nil || !bytes.Equal(actual, raw) {
		t.Fatalf("slot was not usable after corrupt read: bytes=%d err=%v", len(actual), err)
	}
}

func TestConcurrentReadsAndRequestCancellation(t *testing.T) {
	packed, expected := testFiles(t)
	got, err := newWithSlots(packed, 1)
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	problems := make(chan error, 16)
	for i := 0; i < 16; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for j := 0; j < 30; j++ {
				body, err := fs.ReadFile(got, "assets/app.js.map")
				if err != nil || !bytes.Equal(body, expected["assets/app.js.map"].Data) {
					problems <- fmt.Errorf("concurrent read len=%d err=%v", len(body), err)
					return
				}
			}
		}()
	}
	workers.Wait()
	close(problems)
	for err := range problems {
		t.Error(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest("GET", "/assets/app.js.map", nil).WithContext(ctx)
	done := make(chan struct{})
	go func() { defer close(done); got.Handler().ServeHTTP(httptest.NewRecorder(), req) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("already-canceled request did not terminate")
	}
	if _, err := fs.ReadFile(got, "assets/app.js.map"); err != nil {
		t.Fatalf("canceled request leaked a cache slot: %v", err)
	}
}

func TestCanceledCacheWaitDoesNotBlockRawFiles(t *testing.T) {
	packed, expected := testFiles(t)
	got, err := newWithSlots(packed, 1)
	if err != nil {
		t.Fatal(err)
	}
	busy, err := got.cache.acquire(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer got.cache.release(busy)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f, err := got.open(ctx, "assets/app.js.map")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	result := make(chan error, 1)
	go func() {
		_, err := f.Read(make([]byte, 10))
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("compressed read bypassed occupied cache: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	// Directory metadata and stored data must remain usable while the one
	// decompressor is occupied by another request.
	if _, err := fs.ReadDir(got, "nested"); err != nil {
		t.Fatal(err)
	}
	raw, err := fs.ReadFile(got, "nested/file.txt")
	if err != nil || !bytes.Equal(raw, expected["nested/file.txt"].Data) {
		t.Fatalf("raw read unexpectedly needs a cache slot: %v", err)
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("waiting read error=%v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canceled cache waiter did not return")
	}
}

func TestLargeManifestDoesNotUseAssetDecoderLimits(t *testing.T) {
	index := Index{Blocks: []Block{{CompressedSize: 1, Size: 1, Codec: Raw}}}
	for i := 0; i < 9000; i++ {
		name := fmt.Sprintf("files/%05d-%s.txt", i, strings.Repeat("source-name-", 10))
		index.Files = append(index.Files, Entry{Name: name, Size: 1, Spans: []Span{{Length: 1}}})
	}
	raw, err := json.Marshal(index)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) <= MaxBlockSize || len(raw) >= MaxIndexSize {
		t.Fatalf("fixture must exercise a manifest between block/index bounds, got %d", len(raw))
	}
	got, err := New(testPack(t, index, []byte("x")))
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range []int{0, 4500, 8999} {
		body, err := fs.ReadFile(got, index.Files[i].Name)
		if err != nil || string(body) != "x" {
			t.Fatalf("large manifest lookup %d failed: %q %v", i, body, err)
		}
	}
}

func TestDecodedBodyCannotExceedBlockCapacity(t *testing.T) {
	// The wire manifest lies about the output length; the actual zstd frame
	// would expand past the entire permitted block buffer.
	raw := bytes.Repeat([]byte("x"), MaxBlockSize+1)
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1), zstd.WithWindowSize(MaxBlockSize), zstd.WithSingleSegment(false))
	if err != nil {
		t.Fatal(err)
	}
	compressed := encoder.EncodeAll(raw, nil)
	encoder.Close()
	index := Index{
		Blocks: []Block{{CompressedSize: int64(len(compressed)), Size: MaxBlockSize, Codec: Zstandard}},
		Files:  []Entry{{Name: "oversized", Size: MaxBlockSize, Spans: []Span{{Length: MaxBlockSize}}}},
	}
	got, err := newWithSlots(testPack(t, index, compressed), 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fs.ReadFile(got, "oversized"); err == nil {
		t.Fatal("oversized frame decoded successfully")
	}
	got.cache.mu.Lock()
	defer got.cache.mu.Unlock()
	for _, slot := range got.cache.slots {
		if slot.busy || slot.blockID != -1 || cap(slot.output) > MaxBlockSize || cap(slot.input) > MaxBlockSize {
			t.Fatalf("failed oversized decode left invalid cache state: busy=%v id=%d input=%d output=%d", slot.busy, slot.blockID, cap(slot.input), cap(slot.output))
		}
	}
}

type blockedResponseWriter struct {
	header  http.Header
	entered chan struct{}
	allow   chan struct{}
	once    sync.Once
}

func (w *blockedResponseWriter) Header() http.Header { return w.header }
func (w *blockedResponseWriter) WriteHeader(int)     {}
func (w *blockedResponseWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	<-w.allow
	return len(p), nil
}

func TestSlowHTTPWriterDoesNotKeepDecoderLeased(t *testing.T) {
	packed, expected := testFiles(t)
	got, err := newWithSlots(packed, 1)
	if err != nil {
		t.Fatal(err)
	}
	w := &blockedResponseWriter{header: make(http.Header), entered: make(chan struct{}), allow: make(chan struct{})}
	done := make(chan struct{})
	defer func() {
		close(w.allow)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("HTTP response did not finish after writer unblocked")
		}
	}()
	go func() {
		defer close(done)
		got.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/assets/app.js.map", nil))
	}()
	select {
	case <-w.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP response never reached writer")
	}
	readDone := make(chan error, 1)
	go func() {
		body, err := fs.ReadFile(got, "assets/app.js.map")
		if err == nil && !bytes.Equal(body, expected["assets/app.js.map"].Data) {
			err = errors.New("parallel body mismatch")
		}
		readDone <- err
	}()
	select {
	case err := <-readDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("slow HTTP writer monopolized the only decode slot")
	}
}
