package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"server-monitor/internal/collector"
	_ "modernc.org/sqlite"
)

type Store struct { db *sql.DB }

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil { return nil, err }
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS snapshots (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts INTEGER NOT NULL,
			payload TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);
	`)
	if err != nil { db.Close(); return nil, err }
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Save(ctx context.Context, snapshot collector.Snapshot) error {
	payload, err := json.Marshal(snapshot)
	if err != nil { return err }
	_, err = s.db.ExecContext(ctx, `INSERT INTO snapshots(ts,payload) VALUES(?,?)`,
		snapshot.Timestamp.Unix(), string(payload))
	return err
}

func (s *Store) Latest(ctx context.Context) (collector.Snapshot, error) {
	var payload string
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM snapshots ORDER BY ts DESC,id DESC LIMIT 1`).Scan(&payload)
	if err != nil { return collector.Snapshot{}, err }
	var snapshot collector.Snapshot
	if err := json.Unmarshal([]byte(payload), &snapshot); err != nil { return snapshot, err }
	return snapshot, nil
}

func (s *Store) History(ctx context.Context, since time.Time, maxPoints int) ([]collector.Snapshot, error) {
	if maxPoints <= 0 {
		maxPoints = 200
	}
	now := time.Now()
	durationSec := int64(now.Sub(since).Seconds())
	bucket := durationSec / int64(maxPoints)

	var rows *sql.Rows
	var err error
	if bucket > 5 {
		// Downsample by grouping timestamps into buckets and picking the earliest id in each bucket.
		// Uses the index on ts, orders by ts, and fetches only ~maxPoints rows.
		query := `SELECT payload FROM snapshots WHERE id IN (
			SELECT MIN(id) FROM snapshots WHERE ts >= ? GROUP BY (ts / ?)
		) ORDER BY ts ASC`
		rows, err = s.db.QueryContext(ctx, query, since.Unix(), bucket)
	} else {
		rows, err = s.db.QueryContext(ctx, `SELECT payload FROM snapshots WHERE ts >= ? ORDER BY ts ASC`, since.Unix())
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]collector.Snapshot, 0, maxPoints+16)
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		var item collector.Snapshot
		if err := json.Unmarshal([]byte(payload), &item); err != nil {
			return nil, fmt.Errorf("decode snapshot: %w", err)
		}
		// Strip heavy arrays not needed for time-series charts (saves 95% bandwidth and JSON parsing time)
		item.Processes = nil
		item.Disks = nil
		item.Cores = nil
		out = append(out, item)
	}
	return out, rows.Err()
}
