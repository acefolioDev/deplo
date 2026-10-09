package metrics

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

type Snapshot struct {
	CPUPercent  float64 `json:"cpuPercent"`
	MemoryUsed  uint64  `json:"memoryUsed"`
	MemoryTotal uint64  `json:"memoryTotal"`
	DiskUsed    uint64  `json:"diskUsed"`
	DiskTotal   uint64  `json:"diskTotal"`
}

var previous struct {
	sync.Mutex
	total uint64
	idle  uint64
}

func Collect() Snapshot {
	var s Snapshot
	if f, e := os.Open("/proc/stat"); e == nil {
		scanner := bufio.NewScanner(f)
		if scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) >= 5 && fields[0] == "cpu" {
				var total, idle uint64
				for i, v := range fields[1:] {
					n, _ := strconv.ParseUint(v, 10, 64)
					total += n
					if i == 3 || i == 4 {
						idle += n
					}
				}
				previous.Lock()
				if previous.total > 0 && total > previous.total {
					s.CPUPercent = 100 * float64((total-previous.total)-(idle-previous.idle)) / float64(total-previous.total)
				}
				previous.total = total
				previous.idle = idle
				previous.Unlock()
			}
		}
		f.Close()
	}
	if f, e := os.Open("/proc/meminfo"); e == nil {
		scanner := bufio.NewScanner(f)
		var available uint64
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) < 2 {
				continue
			}
			n, _ := strconv.ParseUint(fields[1], 10, 64)
			switch strings.TrimSuffix(fields[0], ":") {
			case "MemTotal":
				s.MemoryTotal = n * 1024
			case "MemAvailable":
				available = n * 1024
			}
		}
		s.MemoryUsed = s.MemoryTotal - available
		f.Close()
	}
	var stat syscall.Statfs_t
	if syscall.Statfs("/", &stat) == nil {
		s.DiskTotal = stat.Blocks * uint64(stat.Bsize)
		s.DiskUsed = (stat.Blocks - stat.Bavail) * uint64(stat.Bsize)
	}
	return s
}
