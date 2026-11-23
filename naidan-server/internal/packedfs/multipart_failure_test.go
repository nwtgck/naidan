package packedfs

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func enableMultipartRanges(t *testing.T) {
	t.Helper()
	// Newer Go toolchains can default older modules to one range. Explicitly
	// exercise multipart responses instead of silently testing a full response.
	settings := os.Getenv("GODEBUG")
	if settings != "" {
		settings += ","
	}
	t.Setenv("GODEBUG", settings+"httpservecontentmaxranges=200")
}

type failMultipartWriter struct {
	header http.Header
	status int
}

func (w *failMultipartWriter) Header() http.Header  { return w.header }
func (w *failMultipartWriter) WriteHeader(code int) { w.status = code }
func (w *failMultipartWriter) Write([]byte) (int, error) {
	// Give ServeContent's pipe worker an opportunity to continue while its
	// caller exits and closes the file after this simulated client failure.
	runtime.Gosched()
	return 0, io.ErrClosedPipe
}

func TestMultipartFailureCloseRace(t *testing.T) {
	enableMultipartRanges(t)
	packed, _ := testFiles(t)
	assetFS, err := newWithSlots(packed, 1)
	if err != nil {
		t.Fatal(err)
	}
	handler := assetFS.Handler()
	var workers sync.WaitGroup
	for worker := 0; worker < 12; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for repeat := 0; repeat < 200; repeat++ {
				ctx, cancel := context.WithCancel(context.Background())
				request := httptest.NewRequest("GET", "/assets/app.js.map", nil).WithContext(ctx)
				request.Header.Set("Range", "bytes=0-20,64-96")
				writer := &failMultipartWriter{header: make(http.Header)}
				handler.ServeHTTP(writer, request)
				cancel()
				if writer.status != http.StatusPartialContent || !strings.HasPrefix(writer.header.Get("Content-Type"), "multipart/byteranges;") {
					t.Errorf("multipart response was not exercised: status=%d headers=%v", writer.status, writer.header)
					return
				}
				runtime.Gosched()
			}
		}()
	}
	workers.Wait()
}
