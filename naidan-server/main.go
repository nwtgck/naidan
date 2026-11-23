package main

import (
	_ "embed"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"

	"naidan-server/internal/packedfs"
)

//go:embed packed/assets.pack
var embeddedPack string

var version = "dev"

func main() {
	// Setup logger to stderr
	logger := log.New(os.Stderr, "", log.LstdFlags)

	// Define flags
	var port int
	// flag package supports both -name and --name automatically
	flag.IntVar(&port, "port", 5536, "Port to listen on")
	flag.IntVar(&port, "p", 5536, "Port to listen on (shorthand)")
	showVersion := flag.Bool("version", false, "Show version information")

	// Customize help message
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Naidan Server - Static hosting for naidan\n\n")
		fmt.Fprintf(os.Stderr, "Usage:\n")
		fmt.Fprintf(os.Stderr, "  naidan-server [options]\n\n")
		fmt.Fprintf(os.Stderr, "Options:\n")
		fmt.Fprintf(os.Stderr, "  -p, --port int    Port to listen on (default 5536)\n")
		fmt.Fprintf(os.Stderr, "      --version     Show version information\n")
		fmt.Fprintf(os.Stderr, "  -h, --help        Show this help message\n")
	}

	flag.Parse()

	if *showVersion {
		fmt.Printf("naidan-server version %s\n", version)
		return
	}

	publicFS, err := packedfs.New(embeddedPack)
	if err != nil {
		logger.Fatalf("Critical error: Could not open embedded assets: %v", err)
	}

	// Handle all requests with the static file server
	http.Handle("/", publicFS.Handler())

	addr := fmt.Sprintf("localhost:%d", port)
	logger.Printf("Server starting at http://%s\n", addr)

	if err := http.ListenAndServe(addr, nil); err != nil {
		logger.Fatalf("Failed to start server: %v\n", err)
	}
}
