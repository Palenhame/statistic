package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
)

// maxResponseBytes caps the Docker Engine API response size to prevent OOM
// on unexpectedly large or malformed payloads.
const maxResponseBytes = 32 << 20 // 32 MB

// Client is a tiny Docker Engine API client built on the standard library only,
// so no new dependencies are needed in go.mod.
type Client struct {
	http *http.Client
	base string
}

// NewClient connects to host (unix:///path or tcp://host:port).
// Empty host falls back to $DOCKER_HOST and then to the default Linux socket.
func NewClient(host string) (*Client, error) {
	if host == "" {
		host = os.Getenv("DOCKER_HOST")
	}
	if host == "" {
		host = "unix:///var/run/docker.sock"
	}
	switch {
	case strings.HasPrefix(host, "unix://"):
		sock := strings.TrimPrefix(host, "unix://")
		tr := &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", sock)
			},
			DisableCompression: true,
		}
		return &Client{http: &http.Client{Transport: tr}, base: "http://docker"}, nil
	case strings.HasPrefix(host, "tcp://"):
		return &Client{http: &http.Client{}, base: "http://" + strings.TrimPrefix(host, "tcp://")}, nil
	case strings.HasPrefix(host, "http://"):
		return &Client{http: &http.Client{}, base: strings.TrimRight(host, "/")}, nil
	}
	return nil, fmt.Errorf("unsupported DOCKER_HOST %q (use unix:// or tcp://)", host)
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("docker api %s: %s %s", path, resp.Status, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(out)
}

func (c *Client) post(ctx context.Context, path string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("docker api %s: %s %s", path, resp.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

func (c *Client) rawGet(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("docker api %s: %s %s", path, resp.Status, strings.TrimSpace(string(body)))
	}
	return io.ReadAll(io.LimitReader(resp.Body, 5<<20)) // 5MB logs limit
}

// cleanDockerLogs strips Docker multiplexed 8-byte frame headers (stdout/stderr)
// or returns raw stream if TTY mode was used.
func cleanDockerLogs(raw []byte) string {
	if len(raw) < 8 {
		return string(raw)
	}
	// Check if multiplexed stream (first byte is 1/stdout, 2/stderr, 0/stdin, followed by 3 zeroes)
	isMux := (raw[0] <= 2) && raw[1] == 0 && raw[2] == 0 && raw[3] == 0
	if !isMux {
		return string(raw)
	}

	var sb strings.Builder
	pos := 0
	for pos+8 <= len(raw) {
		streamType := raw[pos]
		if streamType > 2 || raw[pos+1] != 0 || raw[pos+2] != 0 || raw[pos+3] != 0 {
			// Fallback: write remainder as-is
			sb.Write(raw[pos:])
			break
		}
		size := int(raw[pos+4])<<24 | int(raw[pos+5])<<16 | int(raw[pos+6])<<8 | int(raw[pos+7])
		pos += 8
		if size <= 0 || pos+size > len(raw) {
			if pos < len(raw) {
				sb.Write(raw[pos:])
			}
			break
		}
		sb.Write(raw[pos : pos+size])
		pos += size
	}
	res := sb.String()
	if res == "" && len(raw) > 0 {
		return string(raw)
	}
	return res
}

// ---- Docker Engine API payloads (only the fields we use) ----

type apiInfo struct {
	Containers        int
	ContainersRunning int
	ContainersPaused  int
	ContainersStopped int
	Images            int
	ServerVersion     string
	NCPU              int
	MemTotal          uint64
}

type apiPort struct {
	IP          string
	PrivatePort int
	PublicPort  int
	Type        string
}

type apiContainer struct {
	ID      string `json:"Id"`
	Names   []string
	Image   string
	State   string
	Status  string
	Created int64
	Ports   []apiPort
	Labels  map[string]string
}

type apiInspect struct {
	RestartCount int
	State        struct {
		Status     string
		OOMKilled  bool
		ExitCode   int
		StartedAt  string
		FinishedAt string
		Health     *struct{ Status string }
	}
	HostConfig struct {
		RestartPolicy struct{ Name string }
	}
}

type apiCPU struct {
	CPUUsage struct {
		TotalUsage uint64 `json:"total_usage"`
	} `json:"cpu_usage"`
	SystemCPUUsage uint64 `json:"system_cpu_usage"`
	OnlineCPUs     uint32 `json:"online_cpus"`
}

type apiStats struct {
	CPUStats    apiCPU `json:"cpu_stats"`
	PreCPUStats apiCPU `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
	BlkioStats struct {
		IOServiceBytesRecursive []struct {
			Op    string `json:"op"`
			Value uint64 `json:"value"`
		} `json:"io_service_bytes_recursive"`
	} `json:"blkio_stats"`
	PidsStats struct {
		Current uint64 `json:"current"`
	} `json:"pids_stats"`
}
