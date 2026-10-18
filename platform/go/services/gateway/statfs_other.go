//go:build !linux

package gateway

// volumeFreeBytes is only implemented on Linux (where the gateway runs);
// elsewhere (tests on a workstation) the volume never reports full.
func volumeFreeBytes(string) (int64, bool) { return 0, false }
