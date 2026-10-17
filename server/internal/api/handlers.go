package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"server-monitor/internal/collector"
	"server-monitor/internal/docker"
	"server-monitor/internal/storage"
)

type Handler struct {
	store *storage.Store
	collector *collector.Collector
	docker *docker.Monitor
}

func New(store *storage.Store, c *collector.Collector) *Handler { return &Handler{store: store, collector: c} }

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "time": time.Now()})
}

func (h *Handler) Current(w http.ResponseWriter, r *http.Request) {
	s, err := h.store.Latest(r.Context())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no metrics collected yet"})
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (h *Handler) History(w http.ResponseWriter, r *http.Request) {
	durations := map[string]time.Duration{
		"1h": time.Hour, "6h": 6 * time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour,
	}
	value := r.URL.Query().Get("range")
	if value == "" {
		value = "1h"
	}
	d, ok := durations[value]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "range must be 1h, 6h, 24h or 7d"})
		return
	}
	items, err := h.store.History(r.Context(), time.Now().Add(-d), 200)
	if err != nil {
		log.Printf("history query: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (h *Handler) Disks(w http.ResponseWriter, r *http.Request) {
	s, err := h.store.Latest(r.Context())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no metrics collected yet"})
		return
	}
	writeJSON(w, http.StatusOK, s.Disks)
}

func (h *Handler) Processes(w http.ResponseWriter, r *http.Request) {
	s, err := h.store.Latest(r.Context())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no metrics collected yet"})
		return
	}
	limit := 10
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 101 {
			limit = n
		}
	}
	if len(s.Processes) > limit {
		s.Processes = s.Processes[:limit]
	}
	writeJSON(w, http.StatusOK, s.Processes)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
