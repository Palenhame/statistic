package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"server-monitor/internal/api"
	"server-monitor/internal/collector"
	"server-monitor/internal/docker"
	"server-monitor/internal/storage"
)

func main() {
	port := env("PORT", "8080")
	dbPath := env("DB_PATH", "server-monitor.db")
	interval, err := time.ParseDuration(env("SAMPLE_INTERVAL", "5s"))
	if err != nil || interval < time.Second {
		log.Fatal("SAMPLE_INTERVAL must be a duration of at least 1s, e.g. 5s")
	}

	store, err := storage.Open(dbPath)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer store.Close()

	c := collector.New(interval)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Collect immediately so the dashboard does not start empty.
	if snapshot, err := c.Collect(); err == nil {
		if err := store.Save(ctx, snapshot); err != nil {
			log.Printf("save initial snapshot: %v", err)
		}
	} else {
		log.Printf("initial collection: %v", err)
	}
	go c.Run(ctx, func(s collector.Snapshot) {
		if err := store.Save(ctx, s); err != nil {
			log.Printf("save snapshot: %v", err)
		}
	})

	// Docker monitoring: own SQLite file, never blocks the rest of the API if Docker is unavailable.
	var dockerMon *docker.Monitor
	dockerDone := make(chan struct{})
	if strings.ToLower(env("DOCKER_ENABLED", "true")) != "false" {
		dockerInterval, derr := time.ParseDuration(env("DOCKER_INTERVAL", "15s"))
		if derr != nil || dockerInterval < 5*time.Second {
			log.Fatal("DOCKER_INTERVAL must be a duration of at least 5s, e.g. 15s")
		}
		mon, merr := docker.NewMonitor(docker.Config{
			Host:          os.Getenv("DOCKER_HOST"),
			DBPath:        env("DOCKER_DB_PATH", "server-monitor-docker.db"),
			Interval:      dockerInterval,
			RetentionDays: envInt("DOCKER_RETENTION_DAYS", 7),
			HistoryDays:   envInt("DOCKER_HISTORY_DAYS", 365),
		})
		if merr != nil {
			log.Printf("docker monitoring disabled: %v", merr)
		} else {
			dockerMon = mon
			go func() {
				defer close(dockerDone)
				mon.Run(ctx)
			}()
		}
	}
	if dockerMon == nil {
		close(dockerDone)
	}

	h := api.New(store, c).WithDocker(dockerMon)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", h.Health)
	mux.HandleFunc("/api/current", h.Current)
	mux.HandleFunc("/api/history", h.History)
	mux.HandleFunc("/api/disks", h.Disks)
	mux.HandleFunc("/api/processes", h.Processes)
	mux.HandleFunc("/api/docker/status", h.DockerStatus)
	mux.HandleFunc("/api/docker/summary", h.DockerSummary)
	mux.HandleFunc("/api/docker/events", h.DockerEvents)
	mux.HandleFunc("/api/docker/containers/{name}/history", h.DockerHistory)

	// Раздача статики React (папка dist)
	fs := http.FileServer(http.Dir("./dist"))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			mux.ServeHTTP(w, r)
			return
		}

		path := "./dist" + r.URL.Path
		if _, err := os.Stat(path); err == nil {
			fs.ServeHTTP(w, r)
			return
		}

		http.ServeFile(w, r, "./dist/index.html")
	}))

	origin := env("CORS_ORIGIN", "http://localhost:5173")
	handler := cors(mux, origin)
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Printf("Server Monitor API listening on http://localhost:%s", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server: %v", err)
		}
	}()
	<-ctx.Done()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = server.Shutdown(shutdownCtx)
	<-dockerDone
	if dockerMon != nil {
		_ = dockerMon.Close()
	}
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if n, err := strconv.Atoi(env(key, "")); err == nil && n > 0 {
		return n
	}
	return fallback
}

func cors(next http.Handler, origin string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestOrigin := r.Header.Get("Origin")
		if requestOrigin == origin || requestOrigin == "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		next.ServeHTTP(w, r)
	})
}

var _ = strconv.IntSize
