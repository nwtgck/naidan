package main

import (
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
)

const maximumInlineNamespaceDepth = 64

type inlineNamespaceEntrySummary struct {
	ContentHex    string `json:"contentHex,omitempty"`
	InodeNumber   string `json:"inodeNumber"`
	InodeRevision string `json:"inodeRevision"`
	Kind          string `json:"kind"`
	Path          string `json:"path"`
	Size          string `json:"size,omitempty"`
	Target        string `json:"target,omitempty"`
}

type inlineNamespaceSummary struct {
	ActiveCommitSequence     string                        `json:"activeCommitSequence"`
	Entries                  []inlineNamespaceEntrySummary `json:"entries"`
	RootDirectoryInodeNumber string                        `json:"rootDirectoryInodeNumber"`
}

func readInlineNamespace(f portableFixture, rootKey []byte, selected authenticatedSuperblockCopy) (inlineNamespaceSummary, error) {
	commit, _, err := readActiveCommitAuthority(f, rootKey, selected)
	if err != nil {
		return inlineNamespaceSummary{}, err
	}
	plain, _, err := readAuthenticatedHomeRecord(f, rootKey, commit.RootInodeTableRootHomeRef, recordKindInodeTablePage)
	if err != nil {
		return inlineNamespaceSummary{}, err
	}
	inodes, err := decodeRootInodeLeafPage(plain)
	if err != nil {
		return inlineNamespaceSummary{}, err
	}
	byNumber := make(map[uint64]inodeEntry, len(inodes))
	for _, inode := range inodes {
		byNumber[inode.InodeNumber] = inode
	}
	rootDirectory, ok := byNumber[commit.RootDirectoryInodeNumber]
	if !ok || rootDirectory.InodeKind != "directory" {
		return inlineNamespaceSummary{}, errors.New("root directory Inode is missing or has the wrong kind")
	}
	entries := make([]inlineNamespaceEntrySummary, 0, len(inodes)-1)
	visited := make(map[uint64]bool)
	var walk func(inodeEntry, string, int) error
	walk = func(directory inodeEntry, path string, depth int) error {
		if depth > maximumInlineNamespaceDepth {
			return errors.New("inline namespace depth exceeds the reader bound")
		}
		if directory.ContentKind != "inline" {
			return errors.New("tree-backed directory traversal is not implemented")
		}
		if visited[directory.InodeNumber] {
			return errors.New("inline namespace contains a directory cycle")
		}
		visited[directory.InodeNumber] = true
		for _, target := range directory.DirectoryEntries {
			if target.TargetType != "inode" {
				return errors.New("Subvolume traversal is not implemented")
			}
			inode, exists := byNumber[target.InodeNumber]
			if !exists || inode.InodeKind != target.InodeKind {
				return errors.New("directory target disagrees with the root Inode Table")
			}
			targetPath := path + "/" + target.Name
			summary := inlineNamespaceEntrySummary{InodeNumber: fmt.Sprint(inode.InodeNumber), InodeRevision: fmt.Sprint(inode.InodeRevision), Kind: inode.InodeKind, Path: targetPath}
			switch inode.InodeKind {
			case "directory":
				entries = append(entries, summary)
				if err := walk(inode, targetPath, depth+1); err != nil {
					return err
				}
			case "file":
				if inode.ContentKind != "inline" {
					return errors.New("extent-backed file extraction is not implemented")
				}
				summary.ContentHex = hex.EncodeToString(inode.InlineFileBytes)
				summary.Size = fmt.Sprint(inode.FileSize)
				entries = append(entries, summary)
			case "symlink":
				summary.Target = inode.SymlinkTarget
				entries = append(entries, summary)
			default:
				return errors.New("unsupported Inode kind")
			}
		}
		return nil
	}
	if err := walk(rootDirectory, "", 0); err != nil {
		return inlineNamespaceSummary{}, err
	}
	sort.Slice(entries, func(left int, right int) bool { return entries[left].Path < entries[right].Path })
	return inlineNamespaceSummary{ActiveCommitSequence: fmt.Sprint(commit.CommitSequence), Entries: entries, RootDirectoryInodeNumber: fmt.Sprint(rootDirectory.InodeNumber)}, nil
}
