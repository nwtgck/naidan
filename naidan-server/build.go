//go:build ignore

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"naidan-server/internal/packbuild"
)

type PackageJSON struct {
	Version string `json:"version"`
}

func main() {
	skipBuild := false
	for _, arg := range os.Args {
		if arg == "--skip-build" {
			skipBuild = true
		}
	}

	src := filepath.Join("..", "dist", "hosted")
	dst := filepath.Join("packed", "assets.pack")

	fmt.Printf("Packing assets from %s into %s...\n", src, dst)
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Error creating asset directory: %v\n", err)
		os.Exit(1)
	}
	stats, err := packbuild.Build(src, dst)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error packing assets: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Packed %d files (%d ZIPs): %d source bytes -> %d pack bytes (%d unique blocks)\n",
		stats.Files, stats.ZIPFiles, stats.SourceBytes, stats.PackBytes, stats.UniqueBlocks)

	if skipBuild {
		fmt.Println("Asset preparation successful (build skipped)")
		return
	}

	version := getVersion()
	fmt.Printf("Detected version: %s\n", version)

	fmt.Println("Running go build...")
	ldflags := fmt.Sprintf("-s -w -X main.version=%s", version)
	cmd := exec.Command("go", "build", "-trimpath", "-ldflags", ldflags, "-o", "naidan-server", "main.go")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error building server: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Build successful: naidan-server")
}

func getVersion() string {
	data, err := os.ReadFile(filepath.Join("..", "package.json"))
	if err != nil {
		return "unknown"
	}
	var pkg PackageJSON
	if err := json.Unmarshal(data, &pkg); err != nil {
		return "unknown"
	}
	return pkg.Version
}
