package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Importing from archive.org (admins only): the item's metadata lists its
// files; one zip — the one named, or else the largest — is downloaded and
// ingested like an upload. Box pods never reach the internet; the gateway
// does this on their behalf.

var archiveIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

type archiveFile struct {
	Name string `json:"name"`
	Size string `json:"size"` // archive.org sends sizes as strings
}

type archiveMeta struct {
	Files    []archiveFile `json:"files"`
	Metadata struct {
		Title      json.RawMessage `json:"title"` // a string or a list of them
		LicenseURL string          `json:"licenseurl"`
	} `json:"metadata"`
}

var archiveClient = &http.Client{Timeout: 15 * time.Minute}

// pickArchiveZip chooses the file to import: want if given (it must exist
// and be a zip), else the largest zip.
func pickArchiveZip(files []archiveFile, want string) (archiveFile, error) {
	var best archiveFile
	var bestSize int64 = -1
	for _, f := range files {
		if !strings.EqualFold(f.Name, want) && want != "" {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(f.Name), ".zip") {
			if want != "" {
				return best, fmt.Errorf("%s is not a zip", want)
			}
			continue
		}
		size, _ := strconv.ParseInt(f.Size, 10, 64)
		if size > bestSize {
			best, bestSize = f, size
		}
	}
	if bestSize < 0 {
		if want != "" {
			return best, fmt.Errorf("the item has no file %q", want)
		}
		return best, errors.New("the item has no zip file")
	}
	return best, nil
}

// fetchArchiveOrg downloads the chosen zip of an archive.org item into
// file, refusing anything over maxBytes, and returns the file's name and the
// item's license URL.
func fetchArchiveOrg(ctx context.Context, base, id, want, file string, maxBytes int64) (string, string, error) {
	if !archiveIDRe.MatchString(id) {
		return "", "", errors.New("not an archive.org identifier")
	}
	meta, err := getArchiveMeta(ctx, base, id)
	if err != nil {
		return "", "", err
	}
	f, err := pickArchiveZip(meta.Files, want)
	if err != nil {
		return "", "", err
	}
	if size, _ := strconv.ParseInt(f.Size, 10, 64); size > maxBytes {
		return "", "", fmt.Errorf("%s is %d MB, more than the %d MB an item may have", f.Name, size>>20, maxBytes>>20)
	}
	u := fmt.Sprintf("%s/download/%s/%s", base, url.PathEscape(id), escapePath(f.Name))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", "dosbox-platform (catalog import)")
	resp, err := archiveClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("downloading %s: %w", f.Name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("downloading %s: %s", f.Name, resp.Status)
	}
	out, err := os.Create(file)
	if err != nil {
		return "", "", err
	}
	n, err := io.Copy(out, io.LimitReader(resp.Body, maxBytes+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", "", fmt.Errorf("downloading %s: %w", f.Name, err)
	}
	if n > maxBytes {
		return "", "", fmt.Errorf("%s is more than %d MB", f.Name, maxBytes>>20)
	}
	return f.Name, meta.Metadata.LicenseURL, nil
}

func getArchiveMeta(ctx context.Context, base, id string) (*archiveMeta, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/metadata/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "dosbox-platform (catalog import)")
	resp, err := archiveClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("archive.org metadata: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("archive.org metadata: %s", resp.Status)
	}
	var m archiveMeta
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&m); err != nil {
		return nil, fmt.Errorf("archive.org metadata: %w", err)
	}
	if len(m.Files) == 0 {
		return nil, fmt.Errorf("archive.org has no item %q", id) // unknown ids answer {}
	}
	return &m, nil
}

// escapePath escapes each segment of an archive.org file name.
func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}
