package gateway

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
)

// Machine is what a box emulates: the CPU model, the memory size and the
// speed. It is stored with the box and becomes DOSBox-X settings (-set
// section key=value, see docker/entrypoint.sh) when the box starts, so
// a change takes effect on the next start. Zero values mean DOSBox-X's
// own defaults (dosbox-x.conf: cputype auto, 16 MB, cycles auto).
type Machine struct {
	// CPU: 8086, 186, 286, 386, 486, pentium or auto/"".
	CPU string `json:"cpu,omitempty"`
	// MemoryMB: 1..64, 0 for the default.
	MemoryMB int `json:"memoryMB,omitempty"`
	// Cycles: DOSBox-X's cycles setting ("auto", "max" or instructions per
	// millisecond, e.g. 300 for a PC/XT); "" for the default.
	Cycles string `json:"cycles,omitempty"`
}

// The CPU names users pick and the DOSBox-X cputype each means.
var cpuTypes = map[string]string{
	"":        "",
	"auto":    "auto",
	"8086":    "8086",
	"186":     "80186",
	"286":     "286",
	"386":     "386",
	"486":     "486",
	"pentium": "pentium",
}

var cyclesRe = regexp.MustCompile(`^(auto|max|[1-9][0-9]{2,6})$`)

// Validate checks a machine a user sent.
func (m Machine) Validate() error {
	if _, ok := cpuTypes[m.CPU]; !ok {
		return fmt.Errorf("cpu: one of auto, 8086, 186, 286, 386, 486, pentium")
	}
	if m.MemoryMB < 0 || m.MemoryMB > 64 {
		return fmt.Errorf("memoryMB: 1-64")
	}
	if m.Cycles != "" && !cyclesRe.MatchString(m.Cycles) {
		return fmt.Errorf("cycles: auto, max, or a number from 100 to 9999999")
	}
	return nil
}

// The machine is a jsonb column.
func (m *Machine) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*m = Machine{}
		return nil
	case []byte:
		return json.Unmarshal(v, m)
	case string:
		return json.Unmarshal([]byte(v), m)
	}
	return fmt.Errorf("machine: cannot scan %T", src)
}

func (m Machine) Value() (driver.Value, error) {
	b, err := json.Marshal(m)
	return string(b), err
}

// DosboxArgs are the command-line settings for this machine.
func (m Machine) DosboxArgs() []string {
	var args []string
	if t := cpuTypes[m.CPU]; t != "" {
		args = append(args, "-set", "cpu cputype="+t)
		// The dynamic core only does 386+; the normal core runs every model.
		if m.CPU == "8086" || m.CPU == "186" || m.CPU == "286" {
			args = append(args, "-set", "cpu core=normal")
		}
	}
	if m.MemoryMB > 0 {
		args = append(args, "-set", "dosbox memsize="+strconv.Itoa(m.MemoryMB))
	}
	if m.Cycles != "" {
		args = append(args, "-set", "cpu cycles="+m.Cycles)
	}
	return args
}
