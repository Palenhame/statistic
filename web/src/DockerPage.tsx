import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasChart } from "./CanvasChart";
import { PageHead, bytes, rate, pct } from "./App";

interface DStatus {
  available: boolean;
  error?: string;
  serverVersion?: string;
  containers: number;
  running: number;
  paused: number;
  stopped: number;
  images: number;
  ncpu: number;
  memTotal: number;
  lastUpdate: string;
}

interface Row {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  health: string;
  project: string;
  ports: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  oomKilled: boolean;
  restartCount: number;
  restartPolicy: string;
  cpuPercent: number;
  memBytes: number;
  memLimit: number;
  memPercent: number;
  netRxBps: number;
  netTxBps: number;
  netRxTotal: number;
  netTxTotal: number;
  blkReadBps: number;
  blkWriteBps: number;
  pids: number;
  uptimePercent: number;
  avgCpu: number;
  maxCpu: number;
  avgMem: number;
  maxMem: number;
  rxBytes: number;
  txBytes: number;
  restarts: number;
  crashes: number;
}

interface DPoint {
  timestamp: string;
  cpu: number;
  cpuMax: number;
  mem: number;
  memMax: number;
  rxBps: number;
  txBps: number;
  up: number;
}

interface DEvent {
  id: number;
  timestamp: string;
  name: string;
  containerId: string;
  kind: string;
  level: string;
  detail: string;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `${r.status} ${r.statusText}`);
  }
  return r.json() as Promise<T>;
}

function isProblem(r: Row): boolean {
  if (r.state === "removed") return false;
  if (r.health === "unhealthy" || r.state === "restarting" || r.state === "dead") return true;
  return r.state === "exited" && (r.oomKilled || (r.exitCode !== 0 && r.exitCode !== 137 && r.exitCode !== 143));
}

function containerStateDot(r: Row): "run" | "bad" | "warn" | "off" {
  if (r.state === "running") {
    return r.health === "unhealthy" ? "bad" : "run";
  }
  if (isProblem(r)) return "bad";
  if (r.state === "paused" || r.state === "restarting") return "warn";
  return "off";
}

function stc(state: string, row?: Row): string {
  if (row && isProblem(row)) return "Проблема";
  if (state === "running" || state === "run") return "Работает";
  if (state === "paused" || state === "restarting" || state === "warn") return "Перезапуск / Пауза";
  return "Остановлен";
}

function since(iso: string): string {
  if (!iso) return "—";
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(sec >= 0)) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}д ${h}ч` : h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

type SortField = "name" | "image" | "cpu" | "mem" | "restarts" | "uptime";

export default function DockerPage({
  onToast,
}: {
  onToast: (msg: string, error?: boolean) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [, setStatus] = useState<DStatus | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [inspectorTab, setInspectorTab] = useState<"g" | "l" | "c" | "i">("g");
  const [points, setPoints] = useState<DPoint[]>([]);
  const [selEvents, setSelEvents] = useState<DEvent[]>([]);

  // Filter & Search
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "run" | "bad" | "off">("all");
  const [groupByStack, setGroupByStack] = useState(true);
  const [openStacks, setOpenStacks] = useState<Record<string, boolean>>({});
  const [sortField, setSortField] = useState<SortField>("cpu");
  const [sortAsc, setSortAsc] = useState(false);

  // Restart Modal & Loading
  const [confirmContainer, setConfirmContainer] = useState<string>("");
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});

  // Logs state
  const [logs, setLogs] = useState("");
  const [logsTail, setLogsTail] = useState("300");
  const [autoScroll, setAutoScroll] = useState(true);
  const termRef = useRef<HTMLDivElement>(null);
  const insRef = useRef<HTMLElement>(null);

  // Close inspector on Escape or click outside
  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected("");
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (insRef.current && !insRef.current.contains(e.target as Node)) {
        const isModal = (e.target as HTMLElement)?.closest?.("#md");
        if (!isModal) {
          setSelected("");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown);
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [selected]);

  // Load Docker summary & status
  const loadData = useCallback(async () => {
    try {
      const [st, sm] = await Promise.all([
        get<DStatus>("/docker/status"),
        get<Row[]>("/docker/summary?range=1h"),
      ]);
      setStatus(st);
      setRows(sm);
    } catch {
      // keep stale
    }
  }, []);

  useEffect(() => {
    void loadData();
    const interval = Math.max(3000, Number(localStorage.getItem("dashboard-refresh-ms") ?? "3000") || 3000);
    const t = setInterval(() => void loadData(), interval);
    return () => clearInterval(t);
  }, [loadData]);

  // Load inspector data (metrics, events) when container selected
  useEffect(() => {
    if (!selected) {
      setPoints([]);
      setSelEvents([]);
      return;
    }
    let alive = true;
    const name = encodeURIComponent(selected);
    const load = async () => {
      try {
        const [p, ev] = await Promise.all([
          get<DPoint[]>(`/docker/containers/${name}/history?range=1h`),
          get<DEvent[]>(`/docker/events?container=${name}&limit=50`),
        ]);
        if (alive) {
          setPoints(p);
          setSelEvents(ev);
        }
      } catch {
        // keep
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selected]);

  // Load container logs
  const fetchLogs = useCallback(async (containerName: string, tail: string) => {
    if (!containerName) return;
    try {
      const res = await get<{ logs: string }>(`/docker/containers/${encodeURIComponent(containerName)}/logs?tail=${tail}`);
      setLogs(res.logs || "");
    } catch (e) {
      setLogs(`Ошибка загрузки логов: ${e instanceof Error ? e.message : "Неизвестная ошибка"}`);
    }
  }, []);

  useEffect(() => {
    if (inspectorTab !== "l" || !selected) return;
    void fetchLogs(selected, logsTail);
    const timer = setInterval(() => {
      void fetchLogs(selected, logsTail);
    }, 4000);
    return () => clearInterval(timer);
  }, [inspectorTab, selected, logsTail, fetchLogs]);

  // Autoscroll terminal
  useEffect(() => {
    if (autoScroll && termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Restart executor
  const executeRestart = async () => {
    const target = confirmContainer;
    if (!target) return;
    setRestarting((prev) => ({ ...prev, [target]: true }));
    setConfirmContainer("");

    try {
      const res = await fetch(`/api/docker/containers/${encodeURIComponent(target)}/restart`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Ошибка перезапуска");
      onToast(`Контейнер ${target} перезапущен`);
      void loadData();
    } catch (err) {
      onToast(`Ошибка перезапуска ${target}: ${err instanceof Error ? err.message : "Сбой"}`, true);
    } finally {
      setRestarting((prev) => ({ ...prev, [target]: false }));
    }
  };

  // Copy logs & download
  const copyLogs = () => {
    if (!logs) return;
    navigator.clipboard?.writeText(logs);
    onToast("Логи скопированы");
  };

  const downloadLogs = () => {
    if (!logs || !selected) return;
    const blob = new Blob([logs], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selected}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
    onToast(`Файл ${selected}-logs.txt подготовлен`);
  };

  // Categorize containers
  const badContainers = useMemo(() => rows.filter(isProblem), [rows]);
  const runningContainers = useMemo(() => rows.filter((r) => r.state === "running" && !isProblem(r)), [rows]);
  const stoppedContainers = useMemo(() => rows.filter((r) => r.state !== "running" && !isProblem(r)), [rows]);

  // Top consumers
  const topCpuContainer = useMemo(() => {
    const list = [...rows].sort((a, b) => (b.cpuPercent || b.avgCpu) - (a.cpuPercent || a.avgCpu));
    return list[0];
  }, [rows]);

  const topMemContainer = useMemo(() => {
    const list = [...rows].sort((a, b) => (b.memPercent || b.avgMem) - (a.memPercent || a.avgMem));
    return list[0];
  }, [rows]);

  // Filtered rows
  const filteredRows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "run" && r.state !== "running") return false;
      if (filter === "bad" && !isProblem(r)) return false;
      if (filter === "off" && (r.state === "running" || isProblem(r))) return false;
      if (query) {
        const text = `${r.name} ${r.image} ${r.project} ${(r.ports || []).join(" ")}`.toLowerCase();
        if (!text.includes(query)) return false;
      }
      return true;
    });
  }, [rows, filter, q]);

  // Sorted rows
  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    list.sort((a, b) => {
      let diff = 0;
      switch (sortField) {
        case "name":
          diff = a.name.localeCompare(b.name);
          break;
        case "image":
          diff = a.image.localeCompare(b.image);
          break;
        case "cpu":
          diff = (a.cpuPercent || a.avgCpu) - (b.cpuPercent || b.avgCpu);
          break;
        case "mem":
          diff = (a.memPercent || a.avgMem) - (b.memPercent || b.avgMem);
          break;
        case "restarts":
          diff = a.restartCount - b.restartCount;
          break;
        case "uptime":
          diff = a.uptimePercent - b.uptimePercent;
          break;
      }
      return sortAsc ? diff : -diff;
    });
    return list;
  }, [filteredRows, sortField, sortAsc]);

  // Group by project stacks
  const projectStacks = useMemo(() => {
    if (!groupByStack) return null;
    const groups: Record<string, Row[]> = {};
    for (const r of sortedRows) {
      const p = r.project || "Прочие";
      if (!groups[p]) groups[p] = [];
      groups[p].push(r);
    }
    return groups;
  }, [sortedRows, groupByStack]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const toggleStack = (stack: string) => {
    setOpenStacks((prev) => ({ ...prev, [stack]: !prev[stack] }));
  };

  const selRow = rows.find((r) => r.name === selected);

  // Table render helper
  const renderTable = (list: Row[]) => (
    <div className="sc">
      <table>
        <thead>
          <tr>
            <th onClick={() => handleSort("name")}>Имя</th>
            <th onClick={() => handleSort("image")}>Образ</th>
            <th onClick={() => handleSort("cpu")}>CPU</th>
            <th onClick={() => handleSort("mem")}>Память</th>
            <th onClick={() => handleSort("restarts")}>Рестарты</th>
            <th onClick={() => handleSort("uptime")}>Аптайм</th>
            <th style={{ textAlign: "right" }}>Действия</th>
          </tr>
        </thead>
        <tbody>
          {list.map((c) => {
            const dot = containerStateDot(c);
            const cpuVal = Math.round(c.cpuPercent || c.avgCpu || 0);
            const memVal = Math.round(c.memPercent || c.avgMem || 0);
            const isSelected = selected === c.name;
            return (
              <tr
                key={c.name}
                onClick={() => setSelected(c.name)}
                style={{ cursor: "pointer", background: isSelected ? "rgba(255, 31, 61, 0.12)" : undefined }}
              >
                <td>
                  <i className={`dot ${dot}`} />
                  <b>{c.name}</b>
                </td>
                <td className="lb">{c.image}</td>
                <td>
                  <span className="mini">
                    <b style={{ width: `${Math.min(100, cpuVal)}%` }} />
                  </span>
                  {cpuVal}%
                </td>
                <td>
                  <span className="mini">
                    <b style={{ width: `${Math.min(100, memVal)}%` }} />
                  </span>
                  {memVal}%
                </td>
                <td>{c.restartCount}</td>
                <td>{c.startedAt ? since(c.startedAt) : "—"}</td>
                <td style={{ textAlign: "right" }}>
                  <button
                    className="btn o"
                    disabled={restarting[c.name]}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmContainer(c.name);
                    }}
                  >
                    {restarting[c.name] ? (
                      <>
                        <i className="sp" />
                        Перезапуск
                      </>
                    ) : (
                      "Перезапустить"
                    )}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHead title="Docker" sub="Контейнеры и стеки. Нажмите на строку, чтобы открыть инспектор." />

      {/* Alert banner if problems exist */}
      {badContainers.length > 0 && (
        <div className="alert rv">
          <span>Проблемы: {badContainers.map((c) => c.name).join(", ")}</span>
          <button className="btn" onClick={() => setFilter("bad")}>
            Показать
          </button>
        </div>
      )}

      {/* Top CPU / Top Memory cards */}
      <div className="grid">
        <div className="card rv" style={{ "--a": "#d04058" } as any}>
          <div className="lb">Топ по CPU</div>
          <div className="k" style={{ fontSize: "1.3rem" }}>
            {topCpuContainer?.name || "—"}
          </div>
          <div className="bar">
            <b style={{ width: `${Math.min(100, Math.round(topCpuContainer?.cpuPercent || topCpuContainer?.avgCpu || 0))}%` }} />
          </div>
        </div>

        <div className="card rv" style={{ "--a": "#d9962a" } as any}>
          <div className="lb">Топ по памяти</div>
          <div className="k" style={{ fontSize: "1.3rem" }}>
            {topMemContainer?.name || "—"}
          </div>
          <div className="bar">
            <b style={{ width: `${Math.min(100, Math.round(topMemContainer?.memPercent || topMemContainer?.avgMem || 0))}%` }} />
          </div>
        </div>
      </div>

      {/* Quick Tiles Grid */}
      <div className="tiles rv">
        {rows.map((c) => {
          const dot = containerStateDot(c);
          return (
            <div
              key={c.name}
              className={`tile ${dot}`}
              onClick={() => setSelected(c.name)}
              title={`${c.name} · ${stc(dot, c)}`}
            >
              {c.name.slice(0, 3)}
            </div>
          );
        })}
      </div>

      {/* Toolbar: search input, chips, project toggle */}
      <div className="tb rv">
        <input
          id="q"
          placeholder="Поиск по имени, образу, порту, проекту"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className={`chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
            Все ({rows.length})
          </button>
          <button className={`chip ${filter === "run" ? "on" : ""}`} onClick={() => setFilter("run")}>
            Работают ({runningContainers.length})
          </button>
          <button className={`chip ${filter === "bad" ? "on" : ""}`} onClick={() => setFilter("bad")}>
            Проблемы ({badContainers.length})
          </button>
          <button className={`chip ${filter === "off" ? "on" : ""}`} onClick={() => setFilter("off")}>
            Остановлены ({stoppedContainers.length})
          </button>
        </div>
        <button className="chip" onClick={() => setGroupByStack(!groupByStack)}>
          {groupByStack ? "По проектам" : "Плоский список"}
        </button>
      </div>

      {/* Stacks or Flat Table */}
      {projectStacks ? (
        Object.keys(projectStacks).map((p) => {
          const group = projectStacks[p];
          const isCollapsed = openStacks[p];
          const totalCpu = Math.round(group.reduce((acc, c) => acc + (c.cpuPercent || c.avgCpu || 0), 0));
          const avgRam = Math.round(group.reduce((acc, c) => acc + (c.memPercent || c.avgMem || 0), 0) / Math.max(1, group.length));

          return (
            <div key={p} className={`acc ${isCollapsed ? "c" : ""}`}>
              <div className="hd" onClick={() => toggleStack(p)}>
                <b>{p}</b>
                <span className="badge">{group.length} конт.</span>
                <span className="lb" style={{ marginLeft: "auto" }}>
                  CPU {totalCpu}% · RAM {avgRam}%
                </span>
              </div>
              <div className="bd">
                <div className="card" style={{ padding: "6px 12px", marginTop: 8 }}>
                  {renderTable(group)}
                </div>
              </div>
            </div>
          );
        })
      ) : (
        <div className="card">{renderTable(sortedRows)}</div>
      )}

      {/* Backdrop for closing inspector on click outside */}
      <div
        className={`ins-backdrop ${selected ? "o" : ""}`}
        onClick={() => setSelected("")}
        aria-hidden="true"
      />

      {/* Slide-out Inspector Drawer matching Server Monitor.html */}
      <aside id="ins" ref={insRef} className={selected ? "o" : ""}>
        {selRow && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <i className={`dot ${containerStateDot(selRow)}`} />
                <b style={{ font: "700 18px Unbounded, sans-serif" }}>{selRow.name}</b>
              </div>
              <div>
                <button
                  className="btn"
                  disabled={restarting[selRow.name]}
                  onClick={() => setConfirmContainer(selRow.name)}
                >
                  {restarting[selRow.name] ? (
                    <>
                      <i className="sp" />
                      Перезапуск
                    </>
                  ) : (
                    "Перезапустить"
                  )}
                </button>{" "}
                <button className="btn o" onClick={() => setSelected("")}>
                  Закрыть
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="tabs">
              {[
                ["g", "Графики"],
                ["l", "Логи"],
                ["c", "Конфигурация"],
                ["i", "Инциденты"],
              ].map(([k, l]) => (
                <button
                  key={k}
                  className={`chip ${inspectorTab === k ? "on" : ""}`}
                  onClick={() => setInspectorTab(k as any)}
                >
                  {l}
                </button>
              ))}
            </div>

            {/* Tab: Graphs */}
            {inspectorTab === "g" && (
              <>
                <h2>CPU</h2>
                <CanvasChart
                  key={`${selRow.name}-cpu`}
                  series={
                    points.length > 1
                      ? [points.map((p) => p.cpuMax), points.map((p) => p.cpu)]
                      : [[selRow.cpuPercent + 4, selRow.cpuPercent + 4], [selRow.cpuPercent, selRow.cpuPercent]]
                  }
                  colors={["#ff5a70", "#ff1f3d"]}
                  names={["пик", "сред"]}
                  height={130}
                  minMax={100}
                />

                <h2 style={{ marginTop: 16 }}>Память</h2>
                <CanvasChart
                  key={`${selRow.name}-mem`}
                  series={
                    points.length > 1
                      ? [points.map((p) => p.memMax / (1024 * 1024)), points.map((p) => p.mem / (1024 * 1024))]
                      : [[selRow.memPercent + 3, selRow.memPercent + 3], [selRow.memPercent, selRow.memPercent]]
                  }
                  colors={["#ffb020", "#ff1f3d"]}
                  names={["пик", "сред"]}
                  height={130}
                  fmt={(v) => `${v.toFixed(0)} МБ`}
                  minMax={10}
                />

                <h2 style={{ marginTop: 16 }}>Сеть RX/TX</h2>
                <CanvasChart
                  key={`${selRow.name}-net`}
                  series={
                    points.length > 1
                      ? [points.map((p) => p.rxBps / 1024), points.map((p) => p.txBps / 1024)]
                      : [[40, 40], [20, 20]]
                  }
                  colors={["#4dc3ff", "#ff9a3d"]}
                  names={["RX", "TX"]}
                  height={130}
                  fmt={(v) => `${v.toFixed(0)} КБ/с`}
                  minMax={10}
                />
              </>
            )}

            {/* Tab: Logs */}
            {inspectorTab === "l" && (
              <>
                <div className="tb">
                  <span className="lb">Строк:</span>
                  {["50", "150", "300", "1000"].map((x) => (
                    <button
                      key={x}
                      className={`chip ${logsTail === x ? "on" : ""}`}
                      onClick={() => setLogsTail(x)}
                    >
                      {x}
                    </button>
                  ))}
                  <button
                    className={`chip ${autoScroll ? "on" : ""}`}
                    onClick={() => setAutoScroll(!autoScroll)}
                  >
                    Автоскролл
                  </button>
                </div>

                <div className="term" ref={termRef}>
                  {logs ? (
                    logs.split("\n").map((line, i) => {
                      const lower = line.toLowerCase();
                      const isErr = lower.includes("error") || lower.includes("fatal") || lower.includes("panic");
                      const isWarn = !isErr && (lower.includes("warn") || lower.includes("warning"));
                      const isInfo = !isErr && !isWarn && lower.includes("info");

                      const tsMatch = line.match(/^(\[?\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?)\s*(.*)$/);
                      if (tsMatch) {
                        const [, ts, rest] = tsMatch;
                        return (
                          <div key={i} className={isErr ? "e" : isWarn ? "w" : isInfo ? "i" : ""}>
                            <span className="dim">{ts}</span> {rest}
                          </div>
                        );
                      }
                      return (
                        <div key={i} className={isErr ? "e" : isWarn ? "w" : isInfo ? "i" : ""}>
                          {line}
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ color: "#85767b", fontStyle: "italic" }}>Ожидание логов контейнера...</div>
                  )}
                </div>

                <div className="tb" style={{ marginTop: 10 }}>
                  <button className="btn o" onClick={copyLogs}>
                    Копировать
                  </button>
                  <button className="btn o" onClick={downloadLogs}>
                    Скачать {selRow.name}-logs.txt
                  </button>
                </div>
              </>
            )}

            {/* Tab: Configuration */}
            {inspectorTab === "c" && (
              <>
                <h2>Порты</h2>
                <p style={{ marginBottom: 14 }}>
                  {selRow.ports && selRow.ports.length ? (
                    selRow.ports.map((p) => {
                      const portNum = p.split("→")[0].trim();
                      const isNum = /^\d+$/.test(portNum);
                      return isNum ? (
                        <a
                          key={p}
                          className="badge"
                          style={{ textDecoration: "none", marginRight: 8 }}
                          href={`http://localhost:${portNum}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          localhost:{portNum}
                        </a>
                      ) : (
                        <span key={p} className="badge" style={{ marginRight: 8 }}>
                          {p}
                        </span>
                      );
                    })
                  ) : (
                    <span className="lb">Порты не опубликованы</span>
                  )}
                </p>

                <h2>Быстрые команды</h2>
                {[
                  `docker logs -f ${selRow.name}`,
                  `docker restart ${selRow.name}`,
                  `docker exec -it ${selRow.name} sh`,
                ].map((cmd) => (
                  <pre key={cmd}>
                    <span>{cmd}</span>
                    <button
                      className="btn o"
                      style={{ padding: "2px 10px" }}
                      onClick={() => {
                        navigator.clipboard?.writeText(cmd);
                        onToast("Команда скопирована");
                      }}
                    >
                      Копировать
                    </button>
                  </pre>
                ))}

                <h2 style={{ marginTop: 20 }}>Метаданные</h2>
                <p className="lb" style={{ lineHeight: 1.8 }}>
                  Образ: {selRow.image}
                  <br />
                  Статус: {stc(selRow.state, selRow)}
                  <br />
                  Политика перезапуска: {selRow.restartPolicy || "unless-stopped"}
                  <br />
                  Проект: {selRow.project || "—"}
                  <br />
                  Аптайм: {selRow.startedAt ? since(selRow.startedAt) : "—"}
                </p>
              </>
            )}

            {/* Tab: Incidents */}
            {inspectorTab === "i" && (
              <>
                {selEvents && selEvents.length > 0 ? (
                  selEvents.map((ev, i) => (
                    <div key={ev.id ?? i} className="card" style={{ marginBottom: 10, padding: 14 }}>
                      <i className={`dot ${ev.level === "bad" ? "bad" : "warn"}`} />
                      <b>{ev.kind}: </b>
                      {ev.detail}
                      <div className="lb" style={{ marginTop: 4 }}>
                        {new Date(ev.timestamp).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                  ))
                ) : selRow.restartCount > 0 ? (
                  [...Array(Math.min(selRow.restartCount, 5))].map((_, i) => (
                    <div key={i} className="card" style={{ marginBottom: 10, padding: 14 }}>
                      <i className="dot bad" />
                      {["Аварийное завершение (код 137)", "Healthcheck не пройден", "Перезапуск контейнера", "OOM kill", "Остановка контейнера"][i % 5]}
                      <div className="lb" style={{ marginTop: 4 }}>
                        {i + 1} ч назад
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="lb">Инцидентов не было.</p>
                )}
              </>
            )}
          </>
        )}
      </aside>

      {/* Modal Confirmation matching Server Monitor.html */}
      <div id="md" className={confirmContainer ? "o" : ""}>
        <div>
          <h2 style={{ color: "var(--t)", fontSize: 16 }}>Перезапустить {confirmContainer}?</h2>
          <p className="lb" style={{ marginBottom: 20 }}>
            Контейнер будет недоступен несколько секунд.
          </p>
          <button className="btn" disabled={Boolean(restarting[confirmContainer])} onClick={executeRestart}>
            {restarting[confirmContainer] ? (
              <>
                <i className="sp" />
                Перезапуск
              </>
            ) : (
              "Перезапустить"
            )}
          </button>{" "}
          <button className="btn o" onClick={() => setConfirmContainer("")}>
            Отмена
          </button>
        </div>
      </div>
    </>
  );
}
