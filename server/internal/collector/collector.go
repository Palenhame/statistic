package collector

import (
	"context"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

type Core struct {
	Index int     `json:"index"`
	Usage float64 `json:"usage"`
}

type Disk struct {
	Device      string  `json:"device"`
	Mountpoint  string  `json:"mountpoint"`
	Fstype      string  `json:"fstype"`
	TotalBytes  uint64  `json:"totalBytes"`
	UsedBytes   uint64  `json:"usedBytes"`
	FreeBytes   uint64  `json:"freeBytes"`
	UsedPercent float64 `json:"usedPercent"`
}

type Proc struct {
	PID        int32   `json:"pid"`
	Name       string  `json:"name"`
	CPUPercent float64 `json:"cpuPercent"`
	MemPercent float32 `json:"memPercent"`
	RSSBytes   uint64  `json:"rssBytes"`
}

type Snapshot struct {
	Timestamp     time.Time `json:"timestamp"`
	Hostname      string    `json:"hostname"`
	OS            string    `json:"os"`
	CPUPercent    float64   `json:"cpuPercent"`
	Cores         []Core    `json:"cores"`
	MemoryTotal   uint64    `json:"memoryTotal"`
	MemoryUsed    uint64    `json:"memoryUsed"`
	MemoryPercent float64   `json:"memoryPercent"`
	SwapTotal     uint64    `json:"swapTotal"`
	SwapUsed      uint64    `json:"swapUsed"`
	SwapPercent   float64   `json:"swapPercent"`
	DiskTotal     uint64    `json:"diskTotal"`
	DiskUsed      uint64    `json:"diskUsed"`
	DiskPercent   float64   `json:"diskPercent"`
	NetInBps      uint64    `json:"netInBps"`
	NetOutBps     uint64    `json:"netOutBps"`
	NetInTotal    uint64    `json:"netInTotal"`
	NetOutTotal   uint64    `json:"netOutTotal"`
	ProcessCount  int       `json:"processCount"`
	Disks         []Disk    `json:"disks"`
	Processes     []Proc    `json:"processes"`
}

type Collector struct {
	interval time.Duration
	mu       sync.Mutex
	lastNet  map[string]net.IOCountersStat
	lastAt   time.Time
}

func New(interval time.Duration) *Collector {
	return &Collector{interval: interval, lastNet: map[string]net.IOCountersStat{}}
}

func (c *Collector) Run(ctx context.Context, onSnapshot func(Snapshot)) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s, err := c.Collect()
			if err != nil {
				continue
			}
			onSnapshot(s)
		}
	}
}

func (c *Collector) Collect() (Snapshot, error) {
	now := time.Now()
	host, _ := hostname()
	cpuTotal, _ := cpu.Percent(250*time.Millisecond, false)
	coreValues, _ := cpu.Percent(250*time.Millisecond, true)
	vm, vmErr := mem.VirtualMemory()
	swap, _ := mem.SwapMemory()
	ioCounters, _ := net.IOCounters(true)
	netAt := time.Now() // timestamp of the counters themselves, not of the start of the slow Collect()
	ioCounters = physicalInterfaces(ioCounters)
	partitions, _ := disk.Partitions(false)
	procs, _ := process.Processes()

	s := Snapshot{
		Timestamp: now, Hostname: host, OS: runtime.GOOS,
		Disks: []Disk{}, Processes: []Proc{}, Cores: []Core{},
		ProcessCount: len(procs),
	}
	if len(cpuTotal) > 0 {
		s.CPUPercent = cpuTotal[0]
	}
	for i, value := range coreValues {
		s.Cores = append(s.Cores, Core{Index: i, Usage: value})
	}
	if vmErr == nil && vm != nil {
		s.MemoryTotal, s.MemoryUsed, s.MemoryPercent = vm.Total, vm.Used, vm.UsedPercent
	}
	if swap != nil {
		s.SwapTotal, s.SwapUsed, s.SwapPercent = swap.Total, swap.Used, swap.UsedPercent
	}

	for _, p := range partitions {
		usage, err := disk.Usage(p.Mountpoint)
		if err != nil || usage == nil || usage.Total == 0 {
			continue
		}
		// Ignore duplicate pseudo mounts where usage cannot be read; gopsutil already filters many.
		s.Disks = append(s.Disks, Disk{
			Device: p.Device, Mountpoint: p.Mountpoint, Fstype: p.Fstype,
			TotalBytes: usage.Total, UsedBytes: usage.Used, FreeBytes: usage.Free,
			UsedPercent: usage.UsedPercent,
		})
	}
	for _, d := range s.Disks {
		s.DiskTotal += d.TotalBytes
		s.DiskUsed += d.UsedBytes
	}
	if s.DiskTotal > 0 {
		s.DiskPercent = float64(s.DiskUsed) / float64(s.DiskTotal) * 100
	}

	c.mu.Lock()
	var inRate, outRate uint64
	if !c.lastAt.IsZero() && netAt.After(c.lastAt) {
		seconds := netAt.Sub(c.lastAt).Seconds()
		for _, item := range ioCounters {
			if old, ok := c.lastNet[item.Name]; ok && seconds > 0 {
				if item.BytesRecv >= old.BytesRecv {
					inRate += uint64(float64(item.BytesRecv-old.BytesRecv) / seconds)
				}
				if item.BytesSent >= old.BytesSent {
					outRate += uint64(float64(item.BytesSent-old.BytesSent) / seconds)
				}
			}
			c.lastNet[item.Name] = item
		}
	} else {
		for _, item := range ioCounters {
			c.lastNet[item.Name] = item
		}
	}
	c.lastAt = netAt
	c.mu.Unlock()
	s.NetInBps, s.NetOutBps = inRate, outRate
	for _, item := range ioCounters {
		s.NetInTotal += item.BytesRecv
		s.NetOutTotal += item.BytesSent
	}

	for _, p := range procs {
		name, err := p.Name()
		if err != nil {
			continue
		}
		cpuP, _ := p.CPUPercent()
		memP, _ := p.MemoryPercent()
		mi, _ := p.MemoryInfo()
		var rss uint64
		if mi != nil {
			rss = mi.RSS
		}
		s.Processes = append(s.Processes, Proc{PID: p.Pid, Name: name, CPUPercent: cpuP, MemPercent: memP, RSSBytes: rss})
	}
	sort.Slice(s.Processes, func(i, j int) bool { return s.Processes[i].CPUPercent > s.Processes[j].CPUPercent })
	if len(s.Processes) > 10 {
		s.Processes = s.Processes[:10]
	}
	return s, nil
}

func hostname() (string, error) {
	// Kept in a helper to make host identification easy to customize.
	return os.Hostname()
}

// physicalInterfaces drops loopback and virtual interfaces. On a Docker host every
// container packet is counted on veth* -> docker0/br-* -> eth0, so summing all
// interfaces inflates traffic 2-3x (and "lo" adds local traffic that never leaves the machine).
func physicalInterfaces(in []net.IOCountersStat) []net.IOCountersStat {
	out := make([]net.IOCountersStat, 0, len(in))
	for _, i := range in {
		n := strings.ToLower(i.Name)
		skip := n == "lo" || strings.Contains(n, "loopback")
		for _, p := range []string{"docker", "br-", "veth", "virbr", "cni", "flannel", "cali", "tun", "tap", "lxc", "vmnet", "vboxnet"} {
			if strings.HasPrefix(n, p) {
				skip = true
			}
		}
		if !skip {
			out = append(out, i)
		}
	}
	return out
}
