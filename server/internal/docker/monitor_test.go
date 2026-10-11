package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeC struct {
	id, name, state, health string
	exit, restarts          int
	oom                     bool
	rx, tx                  uint64
}

type fakeDocker struct {
	mu sync.Mutex
	cs map[string]*fakeC
}

func (f *fakeDocker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := r.URL.Path
	switch {
	case p == "/info":
		json.NewEncoder(w).Encode(map[string]any{"Containers": len(f.cs), "ContainersRunning": 1, "Images": 3, "ServerVersion": "27.0", "NCPU": 4, "MemTotal": 8 << 30})
	case p == "/containers/json":
		var out []map[string]any
		for _, c := range f.cs {
			out = append(out, map[string]any{"Id": c.id, "Names": []string{"/" + c.name}, "Image": "img-" + c.name, "State": c.state, "Status": c.state,
				"Ports":  []map[string]any{{"PrivatePort": 80, "PublicPort": 8080, "Type": "tcp"}, {"PrivatePort": 80, "PublicPort": 8080, "Type": "tcp"}},
				"Labels": map[string]string{"com.docker.compose.project": "stack"}})
		}
		json.NewEncoder(w).Encode(out)
	case strings.HasSuffix(p, "/json"):
		id := strings.Split(p, "/")[2]
		for _, c := range f.cs {
			if c.id == id {
				st := map[string]any{"ExitCode": c.exit, "OOMKilled": c.oom, "StartedAt": "2026-10-11T08:00:00Z", "FinishedAt": "0001-01-01T00:00:00Z"}
				if c.health != "" {
					st["Health"] = map[string]any{"Status": c.health}
				}
				json.NewEncoder(w).Encode(map[string]any{"RestartCount": c.restarts, "State": st, "HostConfig": map[string]any{"RestartPolicy": map[string]any{"Name": "always"}}})
			}
		}
	case strings.HasSuffix(p, "/stats"):
		id := strings.Split(p, "/")[2]
		for _, c := range f.cs {
			if c.id == id {
				json.NewEncoder(w).Encode(map[string]any{
					"cpu_stats":    map[string]any{"cpu_usage": map[string]any{"total_usage": 2_000_000}, "system_cpu_usage": 100_000_000, "online_cpus": 4},
					"precpu_stats": map[string]any{"cpu_usage": map[string]any{"total_usage": 1_000_000}, "system_cpu_usage": 90_000_000},
					"memory_stats": map[string]any{"usage": 300 << 20, "limit": 1 << 30, "stats": map[string]any{"inactive_file": 100 << 20}},
					"networks":     map[string]any{"eth0": map[string]any{"rx_bytes": c.rx, "tx_bytes": c.tx}, "eth1": map[string]any{"rx_bytes": 5, "tx_bytes": 5}},
					"blkio_stats":  map[string]any{"io_service_bytes_recursive": []map[string]any{{"op": "read", "value": 10}, {"op": "Write", "value": 20}}},
					"pids_stats":   map[string]any{"current": 7},
				})
			}
		}
	default:
		http.NotFound(w, r)
	}
}

func kinds(evs []Event, name string) []string {
	var k []string
	for _, e := range evs {
		if e.Name == name {
			k = append(k, e.Kind)
		}
	}
	return k
}

func TestMonitorEndToEnd(t *testing.T) {
	f := &fakeDocker{cs: map[string]*fakeC{
		"web": {id: "aaaaaaaaaaaaaaaa", name: "web", state: "running", rx: 1000, tx: 500},
		"db":  {id: "bbbbbbbbbbbbbbbb", name: "db", state: "running", health: "healthy"},
		"old": {id: "cccccccccccccccc", name: "old", state: "running"},
	}}
	srv := httptest.NewServer(f)
	defer srv.Close()
	dbPath := filepath.Join(t.TempDir(), "d.db")
	cfg := Config{Host: "tcp://" + strings.TrimPrefix(srv.URL, "http://"), DBPath: dbPath, Interval: 5 * time.Second}
	m, err := NewMonitor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	m.poll(ctx)
	st := m.Status()
	if !st.Available || st.NCPU != 4 {
		t.Fatalf("status %+v", st)
	}
	cs := m.Containers()
	if len(cs) != 3 {
		t.Fatalf("containers %d", len(cs))
	}
	web := cs[2]
	if web.Name != "web" {
		web = cs[1]
	}
	// cpu = (1e6/1e7)*4*100 = 40 ; mem = 300-100 = 200MB ; ports deduped
	if web.CPUPercent < 39.9 || web.CPUPercent > 40.1 || web.MemBytes != 200<<20 || len(web.Ports) != 1 || web.NetRxTotal != 1005 || web.Pids != 7 || web.BlkWriteTotal != 20 || web.StartedAt == "" || web.FinishedAt != "" || web.Project != "stack" {
		t.Fatalf("web metrics wrong: %+v", web)
	}
	evs, _ := m.Events(ctx, "", 100)
	if len(evs) != 3 {
		t.Fatalf("first poll should discover 3, got %d", len(evs))
	}

	// ---- change state
	time.Sleep(1100 * time.Millisecond)
	f.mu.Lock()
	f.cs["web"].rx, f.cs["web"].tx = 1000+2000, 500+1000
	f.cs["web"].restarts = 2
	f.cs["db"].health = "unhealthy"
	delete(f.cs, "old")
	f.cs["job"] = &fakeC{id: "dddddddddddddddd", name: "job", state: "exited", exit: 1}
	f.mu.Unlock()
	m.poll(ctx)
	evs, _ = m.Events(ctx, "", 100)
	if k := kinds(evs, "web"); !contains(k, "restarted") {
		t.Fatalf("web events %v", k)
	}
	if k := kinds(evs, "db"); !contains(k, "unhealthy") {
		t.Fatalf("db events %v", k)
	}
	if k := kinds(evs, "old"); !contains(k, "removed") {
		t.Fatalf("old events %v", k)
	}
	// rates
	for _, c := range m.Containers() {
		if c.Name == "web" && (c.NetRxBps < 1000 || c.NetRxBps > 2500) {
			t.Fatalf("rx bps %d", c.NetRxBps)
		}
	}

	// job crashes, db stops with 143 (clean), web exits OOM
	f.mu.Lock()
	f.cs["job"].state = "running"
	f.mu.Unlock()
	m.poll(ctx)
	f.mu.Lock()
	f.cs["job"].state, f.cs["job"].exit = "exited", 2
	f.cs["db"].state, f.cs["db"].exit = "exited", 143
	f.cs["web"].state, f.cs["web"].exit, f.cs["web"].oom = "exited", 137, true
	f.mu.Unlock()
	m.poll(ctx)
	evs, _ = m.Events(ctx, "", 100)
	if !contains(kinds(evs, "job"), "crashed") || !contains(kinds(evs, "db"), "stopped") || !contains(kinds(evs, "web"), "oom") {
		t.Fatalf("events: job=%v db=%v web=%v", kinds(evs, "job"), kinds(evs, "db"), kinds(evs, "web"))
	}

	// summary / history (raw + hourly paths)
	for _, d := range []time.Duration{time.Hour, 7 * 24 * time.Hour} {
		sum, err := m.Summary(ctx, d)
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]Summary{}
		for _, s := range sum {
			got[s.Name] = s
		}
		if len(got) != 4 || got["old"].State != "removed" || got["web"].Samples == 0 || got["web"].AvgCPU < 1 || got["web"].RxBytes == 0 || got["web"].UptimePercent <= 0 || got["web"].UptimePercent >= 100 {
			t.Fatalf("summary(%v): %+v", d, got["web"])
		}
		if got["job"].Crashes != 1 || got["web"].Restarts < 1 {
			t.Fatalf("event counts: job=%+v web=%+v", got["job"], got["web"])
		}
		pts, err := m.History(ctx, "web", d)
		if err != nil || len(pts) == 0 || pts[0].Mem == 0 {
			t.Fatalf("history(%v): %v %+v", d, err, pts)
		}
	}

	// persistence: a fresh monitor on the same DB must not re-announce anything
	m.Close()
	before := len(evs)
	m2, err := NewMonitor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer m2.Close()
	m2.poll(ctx)
	evs2, _ := m2.Events(ctx, "", 100)
	if len(evs2) != before {
		t.Fatalf("restart duplicated events: %d -> %d", before, len(evs2))
	}
	// docker down -> unavailable, no panic
	srv.Close()
	m2.poll(ctx)
	if m2.Status().Available {
		t.Fatal("should be unavailable")
	}
	t.Logf("OK: %d events total", len(evs2))
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
