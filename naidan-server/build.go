package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
	dst := "public"

	fmt.Printf("Cleaning up old assets in %s...\n", dst)
	os.RemoveAll(dst)

	fmt.Printf("Copying assets from %s to %s...\n", src, dst)
	if err := copyDir(src, dst); err != nil {
		fmt.Fprintf(os.Stderr, "Error copying assets: %v\n", err)
		os.Exit(1)
	}

	if skipBuild {
		fmt.Println("Asset preparation successful (build skipped)")
		return
	}

	version := getVersion()
	fmt.Printf("Detected version: %s\n", version)

	fmt.Println("Running go build...")
	ldflags := fmt.Sprintf("-X main.version=%s", version)
	cmd := exec.Command("go", "build", "-ldflags", ldflags, "-o", "naidan-server", "main.go")
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

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}

		target := filepath.Join(dst, rel)

		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}

		return copyFile(path, target)
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}

	si, err := os.Stat(src)
	if err != nil {
		return err
	}
	return os.Chmod(dst, si.Mode())
}
