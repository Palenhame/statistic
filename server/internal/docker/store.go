package docker

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS docker_containers (
	name          TEXT PRIMARY KEY,
	id            TEXT NOT NULL DEFAULT '',
	image         TEXT NOT NULL DEFAULT '',
	state         TEXT NOT NULL DEFAULT '',
	health        TEXT NOT NULL DEFAULT '',
	restart_count INTEGER NOT NULL DEFAULT 0,
	first_seen    INTEGER NOT NULL,
	last_seen     INTEGER NOT NULL,
	removed_at    INTEGER
);
CREATE TABLE IF NOT EXISTS docker_samples (
	ts        INTEGER NOT NULL,
	name      TEXT NOT NULL,
	running   INTEGER NOT NULL,
	cpu       REAL NOT NULL DEFAULT 0,
	mem       INTEGER NOT NULL DEFAULT 0,
	mem_limit INTEGER NOT NULL DEFAULT 0,
	rx_bps    INTEGER NOT NULL DEFAULT 0,
	tx_bps    INTEGER NOT NULL DEFAULT 0,
	rx_delta  INTEGER NOT NULL DEFAULT 0,
	tx_delta  INTEGER NOT NULL DEFAULT 0,
	blk_r     INTEGER NOT NULL DEFAULT 0,
	blk_w     INTEGER NOT NULL DEFAULT 0,
	pids      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_docker_samples_name_ts ON docker_samples(name, ts);
CREATE INDEX IF NOT EXISTS idx_docker_samples_ts ON docker_samples(ts);
CREATE TABLE IF NOT EXISTS docker_hourly (
	hour    INTEGER NOT NULL,
	name    TEXT NOT NULL,
	n       INTEGER NOT NULL DEFAULT 0,
	run_n   INTEGER NOT NULL DEFAULT 0,
	cpu_sum REAL NOT NULL DEFAULT 0,
	cpu_max REAL NOT NULL DEFAULT 0,
	mem_sum REAL NOT NULL DEFAULT 0,
	mem_max INTEGER NOT NULL DEFAULT 0,
	rx      INTEGER NOT NULL DEFAULT 0,
	tx      INTEGER NOT NULL DEFAULT 0,
	blk_r   INTEGER NOT NULL DEFAULT 0,
	blk_w   INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (hour, name)
);
CREATE TABLE IF NOT EXISTS docker_events (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	ts           INTEGER NOT NULL,
	name         TEXT NOT NULL,
	container_id TEXT NOT NULL DEFAULT '',
	kind         TEXT NOT NULL,
	level        TEXT NOT NULL DEFAULT 'info',
	detail       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_docker_events_ts ON docker_events(ts);
CREATE INDEX IF NOT EXISTS idx_docker_events_name_ts ON docker_events(name, ts);
`

func openDB(path string) (*sql.DB, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer; avoids SQLITE_BUSY between poller and API reads
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return db, nil
}

type sample struct {
	name          string
	running       bool
	cpu           float64
	mem, memLimit uint64
	rxBps, txBps  uint64
	rxD, txD      uint64
	blkR, blkW    uint64
	pids          uint64
}

func i64(v uint64) int64 { return int64(v) }

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// persist writes one polling round atomically.
func (m *Monitor) persist(ctx context.Context, now time.Time, items []Container, samples []sample, events []Event, removed []string) error {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	ts := now.Unix()
	hour := ts / 3600 * 3600

	upC, err := tx.PrepareContext(ctx, `
INSERT INTO docker_containers(name,id,image,state,health,restart_count,first_seen,last_seen,removed_at)
VALUES(?,?,?,?,?,?,?,?,NULL)
ON CONFLICT(name) DO UPDATE SET id=excluded.id, image=excluded.image, state=excluded.state,
	health=excluded.health, restart_count=excluded.restart_count, last_seen=excluded.last_seen, removed_at=NULL`)
	if err != nil {
		return err
	}
	defer upC.Close()
	for _, c := range items {
		if _, err := upC.ExecContext(ctx, c.Name, c.ID, c.Image, c.State, c.Health, c.RestartCount, ts, ts); err != nil {
			return err
		}
	}
	for _, name := range removed {
		if _, err := tx.ExecContext(ctx, `UPDATE docker_containers SET state='removed', removed_at=? WHERE name=?`, ts, name); err != nil {
			return err
		}
	}

	insS, err := tx.PrepareContext(ctx, `
INSERT INTO docker_samples(ts,name,running,cpu,mem,mem_limit,rx_bps,tx_bps,rx_delta,tx_delta,blk_r,blk_w,pids)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer insS.Close()
	upH, err := tx.PrepareContext(ctx, `
INSERT INTO docker_hourly(hour,name,n,run_n,cpu_sum,cpu_max,mem_sum,mem_max,rx,tx,blk_r,blk_w)
VALUES(?,?,1,?,?,?,?,?,?,?,?,?)
ON CONFLICT(hour,name) DO UPDATE SET
	n=n+1, run_n=run_n+excluded.run_n,
	cpu_sum=cpu_sum+excluded.cpu_sum, cpu_max=max(cpu_max,excluded.cpu_max),
	mem_sum=mem_sum+excluded.mem_sum, mem_max=max(mem_max,excluded.mem_max),
	rx=rx+excluded.rx, tx=tx+excluded.tx, blk_r=blk_r+excluded.blk_r, blk_w=blk_w+excluded.blk_w`)
	if err != nil {
		return err
	}
	defer upH.Close()
	for _, s := range samples {
		run := b2i(s.running)
		if _, err := insS.ExecContext(ctx, ts, s.name, run, s.cpu, i64(s.mem), i64(s.memLimit),
			i64(s.rxBps), i64(s.txBps), i64(s.rxD), i64(s.txD), i64(s.blkR), i64(s.blkW), i64(s.pids)); err != nil {
			return err
		}
		if _, err := upH.ExecContext(ctx, hour, s.name, run, s.cpu, s.cpu, float64(s.mem), i64(s.mem),
			i64(s.rxD), i64(s.txD), i64(s.blkR), i64(s.blkW)); err != nil {
			return err
		}
	}

	for _, e := range events {
		if _, err := tx.ExecContext(ctx, `INSERT INTO docker_events(ts,name,container_id,kind,level,detail) VALUES(?,?,?,?,?,?)`,
			e.TS.Unix(), e.Name, e.ContainerID, e.Kind, e.Level, e.Detail); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (m *Monitor) loadKnown() error {
	rows, err := m.db.Query(`SELECT name,id,image,state,health,restart_count FROM docker_containers`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var t tracked
		if err := rows.Scan(&name, &t.ID, &t.Image, &t.State, &t.Health, &t.RestartCount); err != nil {
			return err
		}
		m.known[name] = t
	}
	return rows.Err()
}

func (m *Monitor) prune(ctx context.Context, now time.Time) {
	raw := now.AddDate(0, 0, -m.cfg.RetentionDays).Unix()
	hist := now.AddDate(0, 0, -m.cfg.HistoryDays).Unix()
	_, _ = m.db.ExecContext(ctx, `DELETE FROM docker_samples WHERE ts < ?`, raw)
	_, _ = m.db.ExecContext(ctx, `DELETE FROM docker_hourly WHERE hour < ?`, hist)
	_, _ = m.db.ExecContext(ctx, `DELETE FROM docker_events WHERE ts < ?`, hist)
}

// ---- queries for the API ----

type aggRow struct {
	samples, running   int64
	avgCPU, maxCPU     float64
	avgMem, maxMem     float64
	rx, tx, blkR, blkW int64
}

func (m *Monitor) aggregate(ctx context.Context, d time.Duration, now time.Time) (map[string]*aggRow, error) {
	out := map[string]*aggRow{}
	var rows *sql.Rows
	var err error
	if d <= 24*time.Hour {
		rows, err = m.db.QueryContext(ctx, `
SELECT name, COUNT(*), COALESCE(SUM(running),0),
  COALESCE(AVG(CASE WHEN running=1 THEN cpu END),0), COALESCE(MAX(cpu),0),
  COALESCE(AVG(CASE WHEN running=1 THEN mem END),0), COALESCE(MAX(mem),0),
  COALESCE(SUM(rx_delta),0), COALESCE(SUM(tx_delta),0), COALESCE(SUM(blk_r),0), COALESCE(SUM(blk_w),0)
FROM docker_samples WHERE ts >= ? GROUP BY name`, now.Add(-d).Unix())
	} else {
		rows, err = m.db.QueryContext(ctx, `
SELECT name, COALESCE(SUM(n),0), COALESCE(SUM(run_n),0),
  COALESCE(SUM(cpu_sum)/NULLIF(SUM(run_n),0),0), COALESCE(MAX(cpu_max),0),
  COALESCE(SUM(mem_sum)/NULLIF(SUM(run_n),0),0), COALESCE(MAX(mem_max),0),
  COALESCE(SUM(rx),0), COALESCE(SUM(tx),0), COALESCE(SUM(blk_r),0), COALESCE(SUM(blk_w),0)
FROM docker_hourly WHERE hour >= ? GROUP BY name`, now.Add(-d).Unix()/3600*3600)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var a aggRow
		if err := rows.Scan(&name, &a.samples, &a.running, &a.avgCPU, &a.maxCPU, &a.avgMem, &a.maxMem, &a.rx, &a.tx, &a.blkR, &a.blkW); err != nil {
			return nil, err
		}
		out[name] = &a
	}
	return out, rows.Err()
}

// Summary returns every container (live and already removed) with usage statistics for the range.
func (m *Monitor) Summary(ctx context.Context, d time.Duration) ([]Summary, error) {
	now := time.Now()
	agg, err := m.aggregate(ctx, d, now)
	if err != nil {
		return nil, err
	}

	type evCount struct{ restarts, crashes int }
	evs := map[string]*evCount{}
	er, err := m.db.QueryContext(ctx, `
SELECT name,
  COALESCE(SUM(CASE WHEN kind IN ('restarted','restarting') THEN 1 ELSE 0 END),0),
  COALESCE(SUM(CASE WHEN kind IN ('crashed','oom') THEN 1 ELSE 0 END),0)
FROM docker_events WHERE ts >= ? GROUP BY name`, now.Add(-d).Unix())
	if err != nil {
		return nil, err
	}
	for er.Next() {
		var name string
		var ec evCount
		if err := er.Scan(&name, &ec.restarts, &ec.crashes); err != nil {
			er.Close()
			return nil, err
		}
		evs[name] = &ec
	}
	er.Close()

	type meta struct {
		image       string
		first, last int64
	}
	metas := map[string]meta{}
	mr, err := m.db.QueryContext(ctx, `SELECT name,image,first_seen,last_seen FROM docker_containers`)
	if err != nil {
		return nil, err
	}
	for mr.Next() {
		var name string
		var mt meta
		if err := mr.Scan(&name, &mt.image, &mt.first, &mt.last); err != nil {
			mr.Close()
			return nil, err
		}
		metas[name] = mt
	}
	mr.Close()

	live := map[string]Container{}
	for _, c := range m.Containers() {
		live[c.Name] = c
	}

	var out []Summary
	for name, mt := range metas {
		c, isLive := live[name]
		a := agg[name]
		if !isLive && a == nil {
			continue // removed and silent for the whole range
		}
		if !isLive {
			c = Container{Name: name, Image: mt.image, State: "removed"}
		}
		s := Summary{
			Container: c,
			FirstSeen: time.Unix(mt.first, 0).UTC().Format(time.RFC3339),
			LastSeen:  time.Unix(mt.last, 0).UTC().Format(time.RFC3339),
		}
		if a != nil {
			s.Samples = a.samples
			if a.samples > 0 {
				s.UptimePercent = float64(a.running) / float64(a.samples) * 100
			}
			s.AvgCPU, s.MaxCPU = a.avgCPU, a.maxCPU
			s.AvgMem, s.MaxMem = uint64(a.avgMem), uint64(a.maxMem)
			s.RxBytes, s.TxBytes, s.BlkRead, s.BlkWrite = uint64(a.rx), uint64(a.tx), uint64(a.blkR), uint64(a.blkW)
		}
		if ec := evs[name]; ec != nil {
			s.Restarts, s.Crashes = ec.restarts, ec.crashes
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// History returns a time series for one container (by name).
func (m *Monitor) History(ctx context.Context, name string, d time.Duration) ([]Point, error) {
	now := time.Now()
	var rows *sql.Rows
	var err error
	if d <= 24*time.Hour {
		bucket := int64(d.Seconds() / 240)
		if min := int64(m.cfg.Interval.Seconds()); bucket < min {
			bucket = min
		}
		if bucket < 1 {
			bucket = 1
		}
		rows, err = m.db.QueryContext(ctx, `
SELECT (ts/?)*? AS b,
  COALESCE(AVG(CASE WHEN running=1 THEN cpu END),0), COALESCE(MAX(cpu),0),
  COALESCE(AVG(CASE WHEN running=1 THEN mem END),0), COALESCE(MAX(mem),0),
  COALESCE(AVG(rx_bps),0), COALESCE(AVG(tx_bps),0), COALESCE(AVG(running),0)
FROM docker_samples WHERE name=? AND ts>=? GROUP BY b ORDER BY b`, bucket, bucket, name, now.Add(-d).Unix())
	} else {
		rows, err = m.db.QueryContext(ctx, `
SELECT hour,
  COALESCE(cpu_sum/NULLIF(run_n,0),0), cpu_max,
  COALESCE(mem_sum/NULLIF(run_n,0),0), mem_max,
  rx/3600.0, tx/3600.0, run_n*1.0/NULLIF(n,0)
FROM docker_hourly WHERE name=? AND hour>=? ORDER BY hour`, name, now.Add(-d).Unix()/3600*3600)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Point{}
	for rows.Next() {
		var ts int64
		var up sql.NullFloat64
		var p Point
		if err := rows.Scan(&ts, &p.CPU, &p.CPUMax, &p.Mem, &p.MemMax, &p.RxBps, &p.TxBps, &up); err != nil {
			return nil, err
		}
		p.Timestamp = time.Unix(ts, 0).UTC()
		p.Up = up.Float64
		out = append(out, p)
	}
	return out, rows.Err()
}

// Events returns the newest events, optionally for a single container.
func (m *Monitor) Events(ctx context.Context, name string, limit int) ([]Event, error) {
	rows, err := m.db.QueryContext(ctx, `
SELECT id,ts,name,container_id,kind,level,detail FROM docker_events
WHERE (?='' OR name=?) ORDER BY ts DESC, id DESC LIMIT ?`, name, name, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		var ts int64
		if err := rows.Scan(&e.ID, &ts, &e.Name, &e.ContainerID, &e.Kind, &e.Level, &e.Detail); err != nil {
			return nil, err
		}
		e.TS = time.Unix(ts, 0).UTC()
		out = append(out, e)
	}
	return out, rows.Err()
}
