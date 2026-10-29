//go:build !windows

package resolver

import (
	"os/exec"
)

func setSysProcAttr(cmd *exec.Cmd) {
	// No-op on Linux and Unix
}
