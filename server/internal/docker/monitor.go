package docker

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Host          string        // empty = $DOCKER_HOST or default socket
	DBPath        string        // separate SQLite file for docker history
	Interval      time.Duration // polling interval (min 5s)
	RetentionDays int           // raw samples
	HistoryDays   int           // hourly rollups and events
}

type Container struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Image         string   `json:"image"`
	State         string   `json:"state"`
	Status        string   `json:"status"`
	Health        string   `json:"health"`
	Project       string   `json:"project"`
	Ports         []string `json:"ports"`
	Created       int64    `json:"created"`
	StartedAt     string   `json:"startedAt"`
	FinishedAt    string   `json:"finishedAt"`
	ExitCode      int      `json:"exitCode"`
	OOMKilled     bool     `json:"oomKilled"`
	RestartCount  int      `json:"restartCount"`
	RestartPolicy string   `json:"restartPolicy"`

	CPUPercent    float64 `json:"cpuPercent"` // 100% = one full core, like `docker stats`
	MemBytes      uint64  `json:"memBytes"`
	MemLimit      uint64  `json:"memLimit"`
	MemPercent    float64 `json:"memPercent"`
	NetRxBps      uint64  `json:"netRxBps"`
	NetTxBps      uint64  `json:"netTxBps"`
	NetRxTotal    uint64  `json:"netRxTotal"`
	NetTxTotal    uint64  `json:"netTxTotal"`
	BlkReadBps    uint64  `json:"blkReadBps"`
	BlkWriteBps   uint64  `json:"blkWriteBps"`
	BlkReadTotal  uint64  `json:"blkReadTotal"`
	BlkWriteTotal uint64  `json:"blkWriteTotal"`
	Pids          uint64  `json:"pids"`
}

type Summary struct {
	Container
	FirstSeen     string  `json:"firstSeen"`
	LastSeen      string  `json:"lastSeen"`
	Samples       int64   `json:"samples"`
	UptimePercent float64 `json:"uptimePercent"`
	AvgCPU        float64 `json:"avgCpu"`
	MaxCPU        float64 `json:"maxCpu"`
	AvgMem        uint64  `json:"avgMem"`
	MaxMem        uint64  `json:"maxMem"`
	RxBytes       uint64  `json:"rxBytes"`
	TxBytes       uint64  `json:"txBytes"`
	BlkRead       uint64  `json:"blkRead"`
	BlkWrite      uint64  `json:"blkWrite"`
	Restarts      int     `json:"restarts"`
	Crashes       int     `json:"crashes"`
}

type Point struct {
	Timestamp time.Time `json:"timestamp"`
	CPU       float64   `json:"cpu"`
	CPUMax    float64   `json:"cpuMax"`
	Mem       float64   `json:"mem"`
	MemMax    float64   `json:"memMax"`
	RxBps     float64   `json:"rxBps"`
	TxBps     float64   `json:"txBps"`
	Up        float64   `json:"up"` // 0..1 share of time the container was running
}

type Event struct {
	ID          int64     `json:"id"`
	TS          time.Time `json:"timestamp"`
	Name        string    `json:"name"`
	ContainerID string    `json:"containerId"`
	Kind        string    `json:"kind"`
	Level       string    `json:"level"` // info | warn | error
	Detail      string    `json:"detail"`
}

type Status struct {
	Available     bool      `json:"available"`
	Error         string    `json:"error,omitempty"`
	ServerVersion string    `json:"serverVersion,omitempty"`
	Containers    int       `json:"containers"`
	Running       int       `json:"running"`
	Paused        int       `json:"paused"`
	Stopped       int       `json:"stopped"`
	Images        int       `json:"images"`
	NCPU          int       `json:"ncpu"`
	MemTotal      uint64    `json:"memTotal"`
	LastUpdate    time.Time `json:"lastUpdate"`
	IntervalSec   int       `json:"intervalSec"`
	RetentionDays int       `json:"retentionDays"`
	HistoryDays   int       `json:"historyDays"`
}

type tracked struct {
	ID, Image, State, Health string
	RestartCount             int
}

type counter struct {
	rx, tx, br, bw uint64
	at             time.Time
}

type Monitor struct {
	cfg    Config
	client *Client
	db     *sql.DB

	mu      sync.RWMutex
	status  Status
	current []Container

	// touched only by the poll goroutine
	known     map[string]tracked
	counters  map[string]counter
	lastPrune time.Time
}

func NewMonitor(cfg Config) (*Monitor, error) {
	if cfg.Interval < 5*time.Second {
		cfg.Interval = 5 * time.Second
	}
	if cfg.RetentionDays <= 0 {
		cfg.RetentionDays = 7
	}
	if cfg.HistoryDays <= 0 {
		cfg.HistoryDays = 365
	}
	client, err := NewClient(cfg.Host)
	if err != nil {
		return nil, err
	}
	db, err := openDB(cfg.DBPath)
	if err != nil {
		return nil, err
	}
	m := &Monitor{
		cfg: cfg, client: client, db: db,
		known: map[string]tracked{}, counters: map[string]counter{},
		status: Status{
			Error: "первый опрос Docker ещё не выполнен", IntervalSec: int(cfg.Interval.Seconds()),
			RetentionDays: cfg.RetentionDays, HistoryDays: cfg.HistoryDays,
		},
	}
	if err := m.loadKnown(); err != nil {
		db.Close()
		return nil, err
	}
	return m, nil
}

func (m *Monitor) Close() error { return m.db.Close() }

func (m *Monitor) Run(ctx context.Context) {
	m.poll(ctx)
	t := time.NewTicker(m.cfg.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.poll(ctx)
		}
	}
}

func (m *Monitor) Status() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *Monitor) Containers() []Container {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Container, len(m.current))
	copy(out, m.current)
	return out
}

func (m *Monitor) setUnavailable(err error) {
	m.mu.Lock()
	m.status.Available = false
	m.status.Error = err.Error()
	m.mu.Unlock()
}

func (m *Monitor) poll(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 40*time.Second)
	defer cancel()
	now := time.Now()

	var info apiInfo
	if err := m.client.get(ctx, "/info", &info); err != nil {
		if parent.Err() == nil {
			m.setUnavailable(err)
		}
		return
	}
	var list []apiContainer
	if err := m.client.get(ctx, "/containers/json?all=1", &list); err != nil {
		if parent.Err() == nil {
			m.setUnavailable(err)
		}
		return
	}

	items := make([]Container, len(list))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i := range list {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			items[i] = m.collectOne(ctx, list[i])
		}(i)
	}
	wg.Wait()
	if parent.Err() != nil {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })

	// rates and per-interval deltas from cumulative counters
	samples := make([]sample, 0, len(items))
	for i := range items {
		c := &items[i]
		s := sample{name: c.Name, running: c.State == "running"}
		if s.running {
			s.cpu, s.mem, s.memLimit, s.pids = c.CPUPercent, c.MemBytes, c.MemLimit, c.Pids
			if prev, ok := m.counters[c.Name]; ok {
				if secs := now.Sub(prev.at).Seconds(); secs > 0 {
					s.rxD, s.txD = delta(c.NetRxTotal, prev.rx), delta(c.NetTxTotal, prev.tx)
					s.blkR, s.blkW = delta(c.BlkReadTotal, prev.br), delta(c.BlkWriteTotal, prev.bw)
					s.rxBps, s.txBps = uint64(float64(s.rxD)/secs), uint64(float64(s.txD)/secs)
					c.NetRxBps, c.NetTxBps = s.rxBps, s.txBps
					c.BlkReadBps, c.BlkWriteBps = uint64(float64(s.blkR)/secs), uint64(float64(s.blkW)/secs)
				}
			}
			m.counters[c.Name] = counter{rx: c.NetRxTotal, tx: c.NetTxTotal, br: c.BlkReadTotal, bw: c.BlkWriteTotal, at: now}
		} else {
			delete(m.counters, c.Name)
		}
		samples = append(samples, s)
	}

	events, removed := m.detect(now, items)
	if err := m.persist(ctx, now, items, samples, events, removed); err != nil {
		log.Printf("docker: save: %v", err)
	} else {
		for _, c := range items {
			m.known[c.Name] = tracked{ID: c.ID, Image: c.Image, State: c.State, Health: c.Health, RestartCount: c.RestartCount}
		}
		for _, name := range removed {
			t := m.known[name]
			t.State = "removed"
			m.known[name] = t
		}
	}

	m.mu.Lock()
	m.current = items
	m.status = Status{
		Available: true, ServerVersion: info.ServerVersion,
		Containers: info.Containers, Running: info.ContainersRunning, Paused: info.ContainersPaused,
		Stopped: info.ContainersStopped, Images: info.Images, NCPU: info.NCPU, MemTotal: info.MemTotal,
		LastUpdate: now, IntervalSec: int(m.cfg.Interval.Seconds()),
		RetentionDays: m.cfg.RetentionDays, HistoryDays: m.cfg.HistoryDays,
	}
	m.mu.Unlock()

	if now.Sub(m.lastPrune) > time.Hour {
		m.lastPrune = now
		m.prune(ctx, now)
	}
}

func delta(cur, prev uint64) uint64 {
	if cur >= prev {
		return cur - prev
	}
	return cur // counter reset (container restarted)
}

func zeroTime(s string) string {
	if s == "" || strings.HasPrefix(s, "0001-01-01") {
		return ""
	}
	return s
}

func (m *Monitor) collectOne(ctx context.Context, ac apiContainer) Container {
	name := ""
	if len(ac.Names) > 0 {
		name = strings.TrimPrefix(ac.Names[0], "/")
	}
	if name == "" && len(ac.ID) >= 12 {
		name = ac.ID[:12]
	}
	c := Container{
		ID: ac.ID, Name: name, Image: ac.Image, State: ac.State, Status: ac.Status, Created: ac.Created,
		Project: ac.Labels["com.docker.compose.project"], Ports: []string{},
	}
	seen := map[string]bool{}
	for _, p := range ac.Ports {
		var s string
		if p.PublicPort != 0 {
			s = fmt.Sprintf("%d→%d/%s", p.PublicPort, p.PrivatePort, p.Type)
		} else {
			s = fmt.Sprintf("%d/%s", p.PrivatePort, p.Type)
		}
		if !seen[s] { // IPv4 and IPv6 bindings are listed separately
			seen[s] = true
			c.Ports = append(c.Ports, s)
		}
	}

	var in apiInspect
	if err := m.client.get(ctx, "/containers/"+ac.ID+"/json", &in); err == nil {
		c.RestartCount = in.RestartCount
		c.ExitCode = in.State.ExitCode
		c.OOMKilled = in.State.OOMKilled
		c.StartedAt = zeroTime(in.State.StartedAt)
		c.FinishedAt = zeroTime(in.State.FinishedAt)
		c.RestartPolicy = in.HostConfig.RestartPolicy.Name
		if in.State.Health != nil {
			c.Health = in.State.Health.Status
		}
	}

	if ac.State == "running" {
		var st apiStats
		if err := m.client.get(ctx, "/containers/"+ac.ID+"/stats?stream=false", &st); err == nil {
			cpuDelta := float64(st.CPUStats.CPUUsage.TotalUsage) - float64(st.PreCPUStats.CPUUsage.TotalUsage)
			sysDelta := float64(st.CPUStats.SystemCPUUsage) - float64(st.PreCPUStats.SystemCPUUsage)
			cpus := float64(st.CPUStats.OnlineCPUs)
			if cpus == 0 {
				cpus = float64(runtime.NumCPU())
			}
			if cpuDelta > 0 && sysDelta > 0 {
				c.CPUPercent = cpuDelta / sysDelta * cpus * 100
			}

			mem := st.MemoryStats.Usage
			// subtract page cache the same way `docker stats` does (cgroup v2 / v1)
			if v, ok := st.MemoryStats.Stats["inactive_file"]; ok && v < mem {
				mem -= v
			} else if v, ok := st.MemoryStats.Stats["total_inactive_file"]; ok && v < mem {
				mem -= v
			}
			c.MemBytes, c.MemLimit = mem, st.MemoryStats.Limit
			if c.MemLimit > 0 {
				c.MemPercent = float64(mem) / float64(c.MemLimit) * 100
			}

			for _, n := range st.Networks {
				c.NetRxTotal += n.RxBytes
				c.NetTxTotal += n.TxBytes
			}
			for _, b := range st.BlkioStats.IOServiceBytesRecursive {
				switch strings.ToLower(b.Op) {
				case "read":
					c.BlkReadTotal += b.Value
				case "write":
					c.BlkWriteTotal += b.Value
				}
			}
			c.Pids = st.PidsStats.Current
		}
	}
	return c
}

func levelOf(kind string) string {
	switch kind {
	case "crashed", "oom", "unhealthy":
		return "error"
	case "restarted", "restarting", "stopped", "removed", "paused", "recreated":
		return "warn"
	}
	return "info"
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// detect compares the current state with what was remembered (including state
// persisted before the monitor was restarted) and returns the events plus names that disappeared.
func (m *Monitor) detect(now time.Time, items []Container) ([]Event, []string) {
	var evs []Event
	add := func(c Container, kind, detail string) {
		evs = append(evs, Event{TS: now, Name: c.Name, ContainerID: shortID(c.ID), Kind: kind, Level: levelOf(kind), Detail: detail})
	}
	seen := map[string]bool{}
	for _, c := range items {
		seen[c.Name] = true
		p, ok := m.known[c.Name]
		switch {
		case !ok:
			add(c, "discovered", fmt.Sprintf("%s · %s", c.Image, c.Status))
			continue
		case p.State == "removed":
			add(c, "created", fmt.Sprintf("контейнер появился снова · %s", c.Image))
			continue
		case p.ID != "" && p.ID != c.ID:
			d := "контейнер пересоздан (новый ID)"
			if p.Image != c.Image {
				d = fmt.Sprintf("контейнер пересоздан · образ: %s → %s", p.Image, c.Image)
			}
			add(c, "recreated", d)
			continue
		}

		restarted := c.RestartCount > p.RestartCount
		if p.State != c.State {
			switch c.State {
			case "running":
				switch {
				case restarted:
				case p.State == "paused":
					add(c, "unpaused", "снят с паузы")
				default:
					add(c, "started", "контейнер запущен")
				}
			case "exited", "dead":
				switch {
				case c.OOMKilled:
					add(c, "oom", fmt.Sprintf("убит из-за нехватки памяти (OOM), код %d", c.ExitCode))
				case c.ExitCode != 0 && c.ExitCode != 137 && c.ExitCode != 143:
					add(c, "crashed", fmt.Sprintf("завершился с ошибкой, код выхода %d", c.ExitCode))
				default:
					// 0 = clean exit, 143 = SIGTERM, 137 = SIGKILL (docker stop/kill) - not a crash
					add(c, "stopped", fmt.Sprintf("остановлен (код %d)", c.ExitCode))
				}
			case "paused":
				add(c, "paused", "поставлен на паузу")
			case "restarting":
				add(c, "restarting", fmt.Sprintf("перезапускается после падения (код %d)", c.ExitCode))
			}
		}
		if restarted {
			add(c, "restarted", fmt.Sprintf("перезапуск, всего перезапусков: %d", c.RestartCount))
		}
		if p.Health != c.Health {
			switch c.Health {
			case "unhealthy":
				add(c, "unhealthy", "healthcheck не проходит")
			case "healthy":
				add(c, "healthy", "healthcheck снова в норме")
			}
		}
	}

	var removed []string
	for name, p := range m.known {
		if !seen[name] && p.State != "removed" {
			evs = append(evs, Event{TS: now, Name: name, ContainerID: shortID(p.ID), Kind: "removed", Level: levelOf("removed"), Detail: "контейнер удалён"})
			removed = append(removed, name)
		}
	}
	sort.Strings(removed)
	return evs, removed
}
