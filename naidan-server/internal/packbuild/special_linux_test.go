package packbuild_test

import (
	"path/filepath"
	"syscall"
	"testing"

	"naidan-server/internal/packbuild"
)

func TestRejectsSpecialSourceFile(t *testing.T) {
	source, out := t.TempDir(), t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(source, "pipe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := packbuild.Build(source, filepath.Join(out, "assets.pack")); err == nil {
		t.Fatal("accepted a named pipe as an asset")
	}
}
