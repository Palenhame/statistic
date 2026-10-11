package api

import (
	"net/http"
	"strconv"
	"time"

	"server-monitor/internal/docker"
)

// WithDocker enables the /api/docker/* endpoints. A nil monitor keeps them in "disabled" mode.
func (h *Handler) WithDocker(m *docker.Monitor) *Handler {
	h.docker = m
	return h
}

var dockerRanges = map[string]time.Duration{
	"1h": time.Hour, "6h": 6 * time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour,
}

func dockerRange(w http.ResponseWriter, r *http.Request) (time.Duration, bool) {
	v := r.URL.Query().Get("range")
	if v == "" {
		v = "1h"
	}
	d, ok := dockerRanges[v]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "range must be 1h, 6h, 24h, 7d or 30d"})
	}
	return d, ok
}

func (h *Handler) DockerStatus(w http.ResponseWriter, r *http.Request) {
	if h.docker == nil {
		writeJSON(w, http.StatusOK, docker.Status{Available: false, Error: "мониторинг Docker отключён (DOCKER_ENABLED=false)"})
		return
	}
	writeJSON(w, http.StatusOK, h.docker.Status())
}

func (h *Handler) DockerSummary(w http.ResponseWriter, r *http.Request) {
	if h.docker == nil {
		writeJSON(w, http.StatusOK, []docker.Summary{})
		return
	}
	d, ok := dockerRange(w, r)
	if !ok {
		return
	}
	items, err := h.docker.Summary(r.Context(), d)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if items == nil {
		items = []docker.Summary{}
	}
	writeJSON(w, http.StatusOK, items)
}

func (h *Handler) DockerHistory(w http.ResponseWriter, r *http.Request) {
	if h.docker == nil {
		writeJSON(w, http.StatusOK, []docker.Point{})
		return
	}
	d, ok := dockerRange(w, r)
	if !ok {
		return
	}
	items, err := h.docker.History(r.Context(), r.PathValue("name"), d)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (h *Handler) DockerEvents(w http.ResponseWriter, r *http.Request) {
	if h.docker == nil {
		writeJSON(w, http.StatusOK, []docker.Event{})
		return
	}
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	items, err := h.docker.Events(r.Context(), r.URL.Query().Get("container"), limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, items)
}
