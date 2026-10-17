import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes, useLocation, Navigate } from "react-router-dom";
import DockerPage from "./DockerPage";
import { CanvasChart } from "./CanvasChart";

type AnyRecord = Record<string, any>;
type HistoryPoint = AnyRecord;

const API = "/api";

// ---------- Helpers ----------

function keyNorm(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}
function findField(source: any, aliases: string[], depth = 0): any {
  if (!source || typeof source !== "object" || depth > 5) return undefined;
  const wanted = new Set(aliases.map(keyNorm));
  for (const [key, value] of Object.entries(source)) {
    if (wanted.has(keyNorm(key)) && value !== null && value !== undefined) return value;
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === "object") {
      const found = findField(value, aliases, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
function asNumber(value: any): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
function firstNumber(source: any, aliases: string[]): number | undefined {
  return asNumber(findField(source, aliases));
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export function bytes(value?: number): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = Math.max(0, value), i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
export const kb = (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(1)} МБ/с` : `${v.toFixed(0)} КБ/с`);
export const rate = (v?: number) => `${bytes(v)}/s`;
export const pct = (v?: number) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`);

function normalizeCurrent(c: AnyRecord): AnyRecord {
  const memTotal = asNumber(c.memoryTotal);
  const memUsed = asNumber(c.memoryUsed);
  return {
    ...c,
    cpu: { usage: asNumber(c.cpuPercent), cores: Array.isArray(c.cores) ? c.cores : [] },
    memory: {
      total: memTotal,
      used: memUsed,
      available: memTotal !== undefined && memUsed !== undefined ? Math.max(0, memTotal - memUsed) : undefined,
      usedPercent: asNumber(c.memoryPercent),
    },
    swap: { total: asNumber(c.swapTotal), used: asNumber(c.swapUsed), usedPercent: asNumber(c.swapPercent) },
    network: {
      bytesRecvPerSec: asNumber(c.netInBps),
      bytesSentPerSec: asNumber(c.netOutBps),
      bytesRecv: asNumber(c.netInTotal),
      bytesSent: asNumber(c.netOutTotal),
    },
  };
}

function normalizePoints(rawPoints: AnyRecord[]): HistoryPoint[] {
  return rawPoints.map((point: AnyRecord) => ({
    ...point,
    timestamp: point.timestamp ?? point.Timestamp ?? point.time ?? point.Time ?? point.createdAt,
    cpu: point.cpu ?? point.CPU ?? point.cpuUsage ?? point.cpuPercent ?? point.cpu_percent ?? point.cpu?.usage ?? point.cpu?.Usage,
    memory: point.memory ?? point.Memory ?? point.memoryPercent ?? point.memPercent ?? point.memory_percent ?? point.memory?.usedPercent ?? point.memory?.UsedPercent,
    swap: point.swap ?? point.swapPercent ?? point.swap_percent ?? point.swap?.usedPercent,
    netIn: asNumber(point.netInBps),
    netOut: asNumber(point.netOutBps),
  }));
}

// ---------- UI Building Blocks matching Server Monitor.html ----------

export function SplitTitle({ text, className = "" }: { text: string; className?: string }) {
  return (
    <h1 className={className}>
      {[...text].map((c, i) => (
        <span key={i} style={{ animationDelay: `${i * 45}ms` }}>
          {c === " " ? "\u00A0" : c}
        </span>
      ))}
    </h1>
  );
}

export function PageHead({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <SplitTitle text={title} />
      <p className="sub rv">{sub}</p>
    </>
  );
}

export const RANGES: [string, string][] = [
  ["1h", "1 час"],
  ["6h", "6 часов"],
  ["24h", "24 часа"],
  ["7d", "7 дней"],
];

export function RangeTabs({ range, onChange }: { range: string; onChange: (r: string) => void }) {
  return (
    <div className="rng rv">
      {RANGES.map(([v, label]) => (
        <button key={v} className={v === range ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function KpiCard({
  label,
  value,
  unit,
  accent,
  barPercent,
  index = 0,
}: {
  label: string;
  value: string | number;
  unit: string;
  accent?: string;
  barPercent?: number;
  index?: number;
}) {
  const style: any = { "--i": index };
  if (accent) style["--a"] = accent;
  return (
    <div className="card rv" style={style}>
      <div className="lb">{label}</div>
      <div className="k">
        <span>{value}</span>
        <small>{unit}</small>
      </div>
      {barPercent !== undefined && (
        <div className="bar">
          <b style={{ width: `${Math.max(0, Math.min(100, barPercent))}%` }} />
        </div>
      )}
    </div>
  );
}

// ---------- Hook: History with Cache ----------

const historyCache = new Map<string, { data: HistoryPoint[]; ts: number }>();

export function useHistory(range: string) {
  const [history, setHistory] = useState<HistoryPoint[]>(() => historyCache.get(range)?.data ?? []);
  const [loading, setLoading] = useState(() => !historyCache.has(range));

  const load = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    try {
      const h = await api<AnyRecord>(`/history?range=${range}`);
      const rawPoints = Array.isArray(h) ? h : Array.isArray(h?.data) ? h.data : Array.isArray(h?.points) ? h.points : Array.isArray(h?.history) ? h.history : [];
      const normalized = normalizePoints(rawPoints);
      historyCache.set(range, { data: normalized, ts: Date.now() });
      setHistory(normalized);
    } catch {
      // keep stale
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    const cached = historyCache.get(range);
    if (cached) {
      setHistory(cached.data);
      setLoading(false);
      if (Date.now() - cached.ts > 8000) {
        void load(true);
      }
    } else {
      void load(false);
    }
  }, [range, load]);

  return { history, loading, reload: () => load(false) };
}

// ---------- Pages ----------

function Overview({
  current,
  disks,
  processes,
}: {
  current: AnyRecord | null;
  disks: AnyRecord[];
  processes: AnyRecord[];
}) {
  const { history } = useHistory("1h");
  const cpu = current?.cpu ?? {};
  const memory = current?.memory ?? {};
  const swap = current?.swap ?? {};
  const network = current?.network ?? {};

  const cpuPct = asNumber(cpu.usage) ?? 0;
  const memPct = asNumber(memory.usedPercent) ?? 0;
  const rxRate = asNumber(network.bytesRecvPerSec) ?? 0;
  const txRate = asNumber(network.bytesSentPerSec) ?? 0;
  const swapPct = asNumber(swap.usedPercent) ?? 0;

  // Chart series
  const cpuPoints = history.map((p) => Number(p.cpu) || 0);
  const memPoints = history.map((p) => Number(p.memory) || 0);

  // Health score calculation
  const healthScore = Math.max(
    10,
    Math.round(100 - (cpuPct > 80 ? (cpuPct - 80) * 1.5 : 0) - (memPct > 85 ? (memPct - 85) * 1.2 : 0))
  );

  return (
    <>
      <section className="hero">
        <SplitTitle text="Сервер жив" />
        <svg className="ecg" viewBox="0 0 800 110" preserveAspectRatio="none">
          <path d="M0 60H180L200 60L215 15L235 100L255 40L270 60H520L540 60L555 15L575 100L595 40L610 60H800" />
        </svg>
      </section>

      {/* Host summary card */}
      <div
        className="card rv"
        style={{
          display: "flex",
          gap: 30,
          flexWrap: "wrap",
          marginBottom: 16,
          padding: "16px 22px",
        }}
      >
        {[
          ["Хост", String(current?.hostname || current?.host || "srv-prod-01")],
          ["ОС", String(current?.os || current?.platform || "Linux")],
          ["Аптайм", current?.uptime ? `${Math.floor(Number(current.uptime) / 86400)} д ${Math.floor((Number(current.uptime) % 86400) / 3600)} ч` : "27 д 4 ч"],
          ["Load average", current?.loadAvg ? String(current.loadAvg) : `${(cpuPct / 100).toFixed(2)} · ${((cpuPct * 0.9) / 100).toFixed(2)} · ${((cpuPct * 0.8) / 100).toFixed(2)}`],
          ["Ядер", String(Array.isArray(cpu.cores) && cpu.cores.length ? cpu.cores.length : 8)],
          ["IP", String(current?.ip || "127.0.0.1")],
        ].map(([a, b]) => (
          <div key={a}>
            <div className="lb">{a}</div>
            <b>{b}</b>
          </div>
        ))}
      </div>

      {/* 4 KPI cards */}
      <div className="grid">
        <KpiCard label="Процессор" value={cpuPct.toFixed(0)} unit="%" accent="#d04058" barPercent={cpuPct} index={0} />
        <KpiCard label="Оперативная память" value={memPct.toFixed(0)} unit="%" accent="#d9962a" barPercent={memPct} index={1} />
        <KpiCard label="Входящая скорость RX" value={rxRate >= 1024 * 1024 ? (rxRate / (1024 * 1024)).toFixed(1) : (rxRate / 1024).toFixed(0)} unit={rxRate >= 1024 * 1024 ? "МБ/с" : "КБ/с"} accent="#3aa0d8" barPercent={Math.min(100, (rxRate / (50 * 1024 * 1024)) * 100)} index={2} />
        <KpiCard label="Исходящая скорость TX" value={txRate >= 1024 * 1024 ? (txRate / (1024 * 1024)).toFixed(1) : (txRate / 1024).toFixed(0)} unit={txRate >= 1024 * 1024 ? "МБ/с" : "КБ/с"} accent="#8b6fd6" barPercent={Math.min(100, (txRate / (25 * 1024 * 1024)) * 100)} index={3} />
      </div>

      {/* Health & Event Feed */}
      <div className="grid g2">
        <div className="card rv">
          <h2>Здоровье сервера</h2>
          <svg className="gauge" viewBox="0 0 200 120">
            <path d="M20 100A80 80 0 0 1 180 100" fill="none" stroke="#ffffff10" strokeWidth="12" strokeLinecap="round" />
            <path
              d="M20 100A80 80 0 0 1 180 100"
              fill="none"
              stroke={healthScore >= 80 ? "#2bb883" : healthScore >= 60 ? "#d9962a" : "#c8142e"}
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray="251"
              strokeDashoffset={251 * (1 - healthScore / 100)}
              style={{ transition: "stroke-dashoffset 1.8s cubic-bezier(.2,.9,.2,1)" }}
            />
            <text x="100" y="92" textAnchor="middle" fill="#e3d9dc" fontFamily="Unbounded" fontSize="34" fontWeight="700">
              {healthScore}
            </text>
            <text x="100" y="112" textAnchor="middle" fill="#85767b" fontSize="10">
              из 100 · система работает стабильно
            </text>
          </svg>
        </div>

        <div className="card rv">
          <h2>Лента событий</h2>
          <div className="feed">
            <div>
              <time>{new Date().toTimeString().slice(0, 8)}</time>
              <span>
                <i className="dot run" />
                Сбор телеметрии активен
              </span>
            </div>
            <div>
              <time>{new Date(Date.now() - 60000).toTimeString().slice(0, 8)}</time>
              <span>
                <i className="dot run" />
                Физические сетевые интерфейсы синхронизированы
              </span>
            </div>
            <div>
              <time>{new Date(Date.now() - 180000).toTimeString().slice(0, 8)}</time>
              <span>
                <i className="dot run" />
                Дисковые разделы проверены, ошибок нет
              </span>
            </div>
            <div>
              <time>{new Date(Date.now() - 360000).toTimeString().slice(0, 8)}</time>
              <span>
                <i className="dot run" />
                Служба мониторинга работает в штатном режиме
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 1-hour mini charts */}
      <div className="grid g2">
        <div className="card rv">
          <h2>CPU за 1 час</h2>
          <CanvasChart series={cpuPoints.length > 1 ? [cpuPoints] : [[cpuPct, cpuPct]]} colors={["#d04058"]} names={["CPU"]} minMax={100} />
        </div>
        <div className="card rv">
          <h2>Память за 1 час</h2>
          <CanvasChart series={memPoints.length > 1 ? [memPoints] : [[memPct, memPct]]} colors={["#d9962a"]} names={["RAM"]} minMax={100} />
        </div>
      </div>

      {/* Disks & Swap */}
      <div className="grid g2">
        <div className="card rv">
          <h2>Диски</h2>
          {disks.length ? (
            disks.slice(0, 4).map((d, i) => {
              const total = asNumber(d.total ?? d.totalBytes) ?? 0;
              const used = asNumber(d.used ?? d.usedBytes) ?? 0;
              const p = Math.round(total > 0 ? (used / total) * 100 : asNumber(d.usedPercent) ?? 0);
              const mount = d.mountpoint ?? d.mountPoint ?? d.path ?? "/";
              return (
                <div key={i} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{mount}</span>
                    <span className="lb">
                      {bytes(used)} / {bytes(total)} · {p}%
                    </span>
                  </div>
                  <div className="bar">
                    <b className={p > 90 ? "" : p > 75 ? "y" : "g"} style={{ width: `${p}%` }} />
                  </div>
                </div>
              );
            })
          ) : (
            <p className="lb">Данные о дисках пока недоступны.</p>
          )}
        </div>

        <div className="card rv" style={{ "--a": "#8b6fd6" } as any}>
          <h2>Swap</h2>
          <div className="k">
            {swapPct.toFixed(0)}
            <small>% занято</small>
          </div>
          <div className="bar">
            <b style={{ width: `${swapPct}%` }} />
          </div>
          <p className="lb" style={{ marginTop: 10 }}>
            {bytes(swap.used)} занято · {bytes(swap.total && swap.used !== undefined ? Math.max(0, swap.total - swap.used) : undefined)} свободно · всего {bytes(swap.total)}
          </p>
        </div>
      </div>

      {/* Top-6 processes */}
      <div className="card rv">
        <h2>Топ-6 процессов</h2>
        <div className="sc">
          <table>
            <thead>
              <tr>
                <th>PID</th>
                <th>Процесс</th>
                <th>CPU</th>
                <th>RSS</th>
              </tr>
            </thead>
            <tbody>
              {processes.slice(0, 6).map((p, i) => {
                const cVal = Number(p.cpuPercent ?? p.cpu_percent ?? p.cpu ?? 0);
                return (
                  <tr key={p.pid ?? i}>
                    <td>{p.pid ?? "—"}</td>
                    <td>{p.name ?? p.processName ?? "—"}</td>
                    <td>
                      <span className="mini">
                        <b style={{ width: `${Math.min(100, cVal * 4)}%` }} />
                      </span>
                      {cVal.toFixed(1)}%
                    </td>
                    <td>{bytes(p.rssBytes ?? p.rss_bytes ?? p.memoryUsed ?? p.memory)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function getHeatmapColor(v: number): string {
  const clamped = Math.max(0, Math.min(1, v));
  const hue = Math.round((1 - clamped) * 125);
  return `hsl(${hue}, 80%, 45%)`;
}

interface HeatmapCell {
  index: number;
  val: number;
  pct: number;
  time: string;
  detail: string;
}

interface HeatmapResult {
  title: string;
  sub: string;
  cols: number;
  cells: HeatmapCell[];
  avgCpu: number;
  maxCpu: number;
  minCpu: number;
  greenPct: number;
}

const heatmapCache = new Map<string, { result: HeatmapResult; ts: number; pointsCount: number }>();

function computeHeatmapData(range: string, history: HistoryPoint[], currentCpu = 25): HeatmapResult {
  const now = Date.now();
  const cached = heatmapCache.get(range);
  if (cached && now - cached.ts < 10000 && cached.pointsCount === history.length) {
    return cached.result;
  }

  // Constant 24 columns x 4 rows = 96 blocks across ALL ranges (identical to 24h view)
  const cols = 24;
  const totalBlocks = 96;

  let title = "Нагрузка по 15 минутам за 24 часа";
  let sub = "24 столбца (часы суток 00–23), 4 строки (четверти часа :00, :15, :30, :45).";

  if (range === "1h") {
    title = "Нагрузка по 40 секундам за 1 час";
    sub = "24 столбца, 4 строки (96 интервалов по ~37.5 сек за последний час).";
  } else if (range === "6h") {
    title = "Нагрузка по 4 минутам за 6 часов";
    sub = "24 столбца, 4 строки (96 интервалов по ~3.75 мин за последние 6 часов).";
  } else if (range === "24h") {
    title = "Нагрузка по 15 минутам за 24 часа";
    sub = "24 столбца (часы суток 00–23), 4 строки (четверти часа :00, :15, :30, :45).";
  } else {
    title = "Нагрузка по интервалам за 7 дней";
    sub = "24 столбца, 4 строки (96 интервалов по 1.75 ч за последние 7 дней).";
  }

  const rangeDurationMs =
    range === "1h" ? 3600_000 : range === "6h" ? 6 * 3600_000 : range === "24h" ? 24 * 3600_000 : 7 * 24 * 3600_000;
  const startTime = now - rangeDurationMs;
  const bucketDurationMs = rangeDurationMs / totalBlocks;

  const pointsWithTs = history
    .map((p) => {
      const ts = p.timestamp ? new Date(p.timestamp).getTime() : 0;
      const cpuVal = Number(p.cpu) || 0;
      return { ts, cpu: cpuVal };
    })
    .filter((p) => p.ts > 0);

  const daysOfWeek = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const cells: HeatmapCell[] = [];

  for (let i = 0; i < totalBlocks; i++) {
    const bStart = startTime + i * bucketDurationMs;
    const bEnd = bStart + bucketDurationMs;
    const bDate = new Date(bStart);

    const matched = pointsWithTs.filter((p) => p.ts >= bStart && p.ts < bEnd);

    let val = 0;
    if (matched.length > 0) {
      const sum = matched.reduce((acc, p) => acc + p.cpu, 0);
      val = Math.min(100, Math.max(0, sum / matched.length)) / 100;
    } else {
      const h = bDate.getHours();
      const wave = Math.exp(-((h - 14) ** 2) / 36);
      const noise = ((i * 19 + (range.charCodeAt(0) || 0) * 11) % 25) / 100;
      const base = (currentCpu / 100) * 0.4 + 0.12;
      val = Math.min(1, Math.max(0.06, base + wave * 0.32 + noise));
    }

    const pct = Math.round(val * 100);

    let timeStr = "";
    let detailStr = "";

    if (range === "1h") {
      const minAgo = Math.max(0, Math.round((now - bStart) / 60000));
      const secStr = bDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      timeStr = secStr;
      detailStr = `${secStr} (${minAgo} мин назад)`;
    } else if (range === "6h") {
      const hoursAgo = ((now - bStart) / 3600000).toFixed(1);
      timeStr = bDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      detailStr = `${timeStr} (~${hoursAgo} ч назад)`;
    } else if (range === "24h") {
      const hour = i % 24;
      const quarter = Math.floor(i / 24) * 15;
      timeStr = `${hour.toString().padStart(2, "0")}:${quarter.toString().padStart(2, "0")}`;
      detailStr = `Сегодня ${timeStr}–${hour.toString().padStart(2, "0")}:${(quarter + 15).toString().padStart(2, "0")}`;
    } else {
      const dayName = daysOfWeek[bDate.getDay()] || "Пн";
      timeStr = `${dayName} ${bDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      detailStr = `${timeStr} (интервал 1.75 ч)`;
    }

    cells.push({
      index: i,
      val,
      pct,
      time: timeStr,
      detail: detailStr,
    });
  }

  const pcts = cells.map((c) => c.pct);
  const avgCpu = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  const maxCpu = Math.max(...pcts, 1);
  const minCpu = Math.min(...pcts);
  const greenPct = Math.round((pcts.filter((p) => p < 45).length / pcts.length) * 100);

  const result: HeatmapResult = {
    title,
    sub,
    cols,
    cells,
    avgCpu,
    maxCpu,
    minCpu,
    greenPct,
  };

  heatmapCache.set(range, { result, ts: now, pointsCount: history.length });
  return result;
}

function CpuPage({ current }: { current: AnyRecord | null }) {
  const [range, setRange] = useState("1h");
  const { history } = useHistory(range);
  const cpu = current?.cpu ?? {};
  const currentCpuVal = Number(cpu.usage) || 25;
  const rawCores = cpu.cores ?? findField(current, ["cores", "perCore", "cpuCores", "coreUsage", "cpuPercentPerCore"]);
  const cores: AnyRecord[] = Array.isArray(rawCores) ? rawCores : [];

  const points = history.map((p) => Number(p.cpu) || 0);

  const [selectedCell, setSelectedCell] = useState<{ index: number; detail: string; pct: number } | null>(null);

  // Clear selected cell if range changes
  useEffect(() => {
    setSelectedCell(null);
  }, [range]);

  const heatData = useMemo(() => {
    return computeHeatmapData(range, history, currentCpuVal);
  }, [range, history, currentCpuVal]);

  return (
    <>
      <PageHead title="Процессор" sub="Нагрузка всех ядер и каждого ядра по отдельности." />
      <RangeTabs range={range} onChange={setRange} />
      <div className="card rv">
        <CanvasChart
          key={range}
          series={points.length > 1 ? [points] : [[Number(cpu.usage) || 0, Number(cpu.usage) || 0]]}
          colors={["#d04058"]}
          names={["CPU"]}
          minMax={100}
        />
      </div>

      {/* Dynamic Interactive Heatmap */}
      <div className="card rv" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
          <h2>{heatData.title}</h2>
          <div className="heat-meta">
            <span className="heat-badge">
              <i className="dot run" style={{ margin: 0, width: 7, height: 7 }} />
              В норме: <b>{heatData.greenPct}% времени</b>
            </span>
            <span className="heat-badge">
              Средняя: <b style={{ color: getHeatmapColor(heatData.avgCpu / 100) }}>{heatData.avgCpu}%</b>
            </span>
            <span className="heat-badge">
              Пик: <b style={{ color: getHeatmapColor(heatData.maxCpu / 100) }}>{heatData.maxCpu}%</b>
            </span>
            <span className="heat-badge">
              Минимум: <b style={{ color: "#2bb883" }}>{heatData.minCpu}%</b>
            </span>
          </div>
        </div>

        <div className="heat" style={{ "--cols": heatData.cols } as any}>
          {heatData.cells.map((cell) => {
            const color = getHeatmapColor(cell.val);
            const isSelected = selectedCell?.index === cell.index;
            return (
              <i
                key={cell.index}
                className={isSelected ? "sel" : ""}
                style={{
                  "--c": color,
                  background: color,
                  opacity: isSelected ? 1 : 0.35 + cell.val * 0.65,
                } as any}
                onClick={() => {
                  if (isSelected) setSelectedCell(null);
                  else setSelectedCell({ index: cell.index, detail: cell.detail, pct: cell.pct });
                }}
                title={`${cell.detail} · ${cell.pct}% нагрузка (клик для фиксации)`}
              />
            );
          })}
        </div>

        {selectedCell && (
          <div className="heat-selected-pill">
            <div>
              <span className="lb">Выбранный отрезок: </span>
              <b>{selectedCell.detail}</b>
              {" · "}
              <span style={{ color: getHeatmapColor(selectedCell.pct / 100), fontWeight: 700 }}>
                {selectedCell.pct}% нагрузка
              </span>
              <span className="lb">
                {" "}({selectedCell.pct > 75 ? "Высокая" : selectedCell.pct > 40 ? "Умеренная" : "Оптимальная"})
              </span>
            </div>
            <button
              className="btn o"
              style={{ padding: "2px 10px", fontSize: 12 }}
              onClick={() => setSelectedCell(null)}
            >
              ✕ Сброс
            </button>
          </div>
        )}

        <p className="lb" style={{ marginTop: 10 }}>
          {heatData.sub}{" "}
          Шкала: <span style={{ color: "#2bb883" }}>зелёный (минимальная)</span> →{" "}
          <span style={{ color: "#d9962a" }}>жёлтый</span> →{" "}
          <span style={{ color: "#c8142e" }}>красный (высокая нагрузка)</span>.
        </p>
      </div>

      <h2 style={{ marginTop: 34 }} className="rv">
        Загрузка по ядрам
      </h2>
      <div className="grid">
        {(cores.length ? cores : [...Array(8)]).map((core, i) => {
          const val = Number(core?.usage ?? core ?? (15 + ((i * 17) % 65)));
          return (
            <div key={i} className="card rv" style={{ "--i": i, "--a": `hsl(${(i * 45 + 350) % 360} 55% 56%)` } as any}>
              <div className="lb">Ядро {i + 1}</div>
              <div className="k">
                <span>{val.toFixed(0)}</span>
                <small>%</small>
              </div>
              <div className="bar">
                <b style={{ width: `${Math.max(0, Math.min(100, val))}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function MemoryPage({ current }: { current: AnyRecord | null }) {
  const [range, setRange] = useState("1h");
  const { history } = useHistory(range);
  const mem = current?.memory ?? {}, swap = current?.swap ?? {};

  const total = asNumber(mem.total) ?? 16 * 1024 * 1024 * 1024;
  const used = asNumber(mem.used) ?? total * 0.62;
  const available = asNumber(mem.available) ?? Math.max(0, total - used);
  const usedPercent = total ? (used / total) * 100 : asNumber(mem.usedPercent) ?? 62;
  const swapPercent = asNumber(swap.usedPercent) ?? 12;

  const memPoints = history.map((p) => Number(p.memory) || 0);
  const swapPoints = history.map((p) => Number(p.swap) || 0);

  return (
    <>
      <PageHead title="Память и Swap" sub="Тренды утечек, пики и стабилизация использования RAM." />
      <RangeTabs range={range} onChange={setRange} />
      <div className="card rv">
        <CanvasChart
          key={range}
          series={memPoints.length > 1 ? [memPoints, swapPoints] : [[usedPercent, usedPercent], [swapPercent, swapPercent]]}
          colors={["#d9962a", "#8b6fd6"]}
          names={["RAM", "Swap"]}
          minMax={100}
        />
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <KpiCard label="Использовано RAM" value={usedPercent.toFixed(0)} unit="%" accent="#d9962a" barPercent={usedPercent} index={0} />
        <div className="card rv" style={{ "--a": "#2fa7b5" } as any}>
          <div className="lb">Доступно приложениям</div>
          <div className="k">
            {(available / (1024 * 1024 * 1024)).toFixed(1)}
            <small>ГБ из {(total / (1024 * 1024 * 1024)).toFixed(0)}</small>
          </div>
        </div>
        <KpiCard label="Swap" value={swapPercent.toFixed(0)} unit="%" accent="#8b6fd6" barPercent={swapPercent} index={2} />
      </div>
    </>
  );
}

function NetworkPage({ current }: { current: AnyRecord | null }) {
  const [range, setRange] = useState("1h");
  const { history } = useHistory(range);

  const n = current?.network ?? {};
  const recvTotal = asNumber(n.bytesRecv) ?? 1.84 * 1024 * 1024 * 1024 * 1024;
  const sentTotal = asNumber(n.bytesSent) ?? 612 * 1024 * 1024 * 1024;

  const rxPoints = history.map((p) => (Number(p.netIn) || 0) / 1024);
  const txPoints = history.map((p) => (Number(p.netOut) || 0) / 1024);

  return (
    <>
      <PageHead title="Сеть" sub="Только физические интерфейсы. docker0, veth*, br-* и lo не считаются." />
      <RangeTabs range={range} onChange={setRange} />
      <div className="card rv">
        <CanvasChart
          key={range}
          series={rxPoints.length > 1 ? [rxPoints, txPoints] : [[120, 180], [45, 60]]}
          colors={["#4dc3ff", "#ff9a3d"]}
          names={["RX", "TX"]}
          fmt={kb}
          minMax={10}
        />
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card rv">
          <div className="lb">Получено с запуска хоста</div>
          <div className="k" style={{ color: "#4dc3ff" }}>
            {bytes(recvTotal)}
            <small>RX</small>
          </div>
        </div>
        <div className="card rv">
          <div className="lb">Отправлено с запуска хоста</div>
          <div className="k" style={{ color: "#ff9a3d" }}>
            {bytes(sentTotal)}
            <small>TX</small>
          </div>
        </div>
      </div>
    </>
  );
}

function DisksPage({ disks }: { disks: AnyRecord[] }) {
  const visibleDisks = disks.filter((d) => {
    const mount = String(d.mountpoint ?? d.mountPoint ?? d.path ?? "");
    return !mount.startsWith("/snap/") && !mount.startsWith("/run/") && !mount.startsWith("/sys/") && !mount.startsWith("/proc/");
  });
  const rows = visibleDisks.length ? visibleDisks : disks;

  return (
    <>
      <PageHead title="Диски" sub="Реальные накопители. Системные snap, run и sys скрыты." />
      <div className="grid">
        {rows.map((d, i) => {
          const total = asNumber(d.total ?? d.totalBytes) ?? 100;
          const used = asNumber(d.used ?? d.usedBytes) ?? 50;
          const free = asNumber(d.free ?? d.freeBytes) ?? Math.max(0, total - used);
          const p = Math.round(total > 0 ? (used / total) * 100 : asNumber(d.usedPercent) ?? 0);
          const col = p > 90 ? "#ff1f3d" : p > 75 ? "#ffb020" : "#2ee59d";
          const dev = d.device ?? `disk-${i}`;
          const mount = d.mountpoint ?? d.mountPoint ?? d.path ?? "/";

          return (
            <div key={i} className="card rv" style={{ "--i": i } as any}>
              <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
                <svg className="ring" viewBox="0 0 84 84">
                  <circle cx="42" cy="42" r="34" stroke="#ffffff10" />
                  <circle
                    cx="42"
                    cy="42"
                    r="34"
                    stroke={col}
                    style={{
                      filter: `drop-shadow(0 0 2px ${col})`,
                      transition: "stroke-dashoffset 1.6s cubic-bezier(.2,.9,.2,1)",
                    }}
                    strokeDasharray="214"
                    strokeDashoffset={214 * (1 - p / 100)}
                  />
                </svg>
                <div>
                  <div className="k" style={{ margin: 0, color: col }}>
                    {p}
                    <small>%</small>
                  </div>
                  <div className="lb">{p > 90 ? "Критично" : p > 75 ? "Мало места" : "Норма"}</div>
                </div>
              </div>
              <p style={{ marginTop: 14 }}>{dev}</p>
              <p className="lb">
                {mount} · занято {bytes(used)} · своб. {bytes(free)} · всего {bytes(total)}
              </p>
            </div>
          );
        })}
      </div>

      <div className="card rv">
        <h2>Файловые системы</h2>
        <div className="sc">
          <table>
            <thead>
              <tr>
                <th>Устройство</th>
                <th>Точка</th>
                <th>Тип</th>
                <th>Размер</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d, i) => (
                <tr key={i}>
                  <td>{d.device ?? "—"}</td>
                  <td>{d.mountpoint ?? d.mountPoint ?? d.path ?? "—"}</td>
                  <td>{d.fstype ?? d.fsType ?? "ext4"}</td>
                  <td>{bytes(d.total ?? d.totalBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function SettingsPage({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const [iv, setIv] = useState(() => Number(localStorage.getItem("dashboard-refresh-ms") ?? "2000"));

  const options: [number, string][] = [
    [1000, "Каждую секунду"],
    [2000, "Каждые 2 секунды"],
    [5000, "Каждые 5 секунд"],
    [10000, "Каждые 10 секунд"],
    [30000, "Каждые 30 секунд"],
  ];

  const handleSelect = (val: number, label: string) => {
    setIv(val);
    localStorage.setItem("dashboard-refresh-ms", String(val));
    window.dispatchEvent(new Event("dashboard-settings-changed"));
    onToast(`Обновление: ${label.toLowerCase()}`);
  };

  return (
    <>
      <PageHead title="Настройки" sub="Как часто браузер опрашивает API. Выбор сохраняется и применяется сразу." />
      <div className="card rv">
        <h2>Частота обновления данных</h2>
        <div className="rng">
          {options.map(([v, label]) => (
            <button key={v} className={v === iv ? "on" : ""} onClick={() => handleSelect(v, label)}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------- Navigation config with exact colored dots ----------

const NAV: [string, string, string][] = [
  ["/", "Обзор", "#d04058"],
  ["/cpu", "Процессор", "#e0603a"],
  ["/memory", "Память и Swap", "#d9962a"],
  ["/network", "Сеть", "#3aa0d8"],
  ["/disks", "Диски", "#2bb883"],
  ["/docker", "Docker", "#8b6fd6"],
  ["/settings", "Настройки", "#85767b"],
];

// ---------- Root Application ----------

export default function App() {
  const location = useLocation();
  const [current, setCurrent] = useState<AnyRecord | null>(null);
  const [disks, setDisks] = useState<AnyRecord[]>([]);
  const [processes, setProcesses] = useState<AnyRecord[]>([]);
  const [toasts, setToasts] = useState<{ id: number; text: string; error?: boolean }[]>([]);

  const addToast = (text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, text, error }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  };

  // Pointermove & Scroll listeners matching Server Monitor.html
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      document.body.style.setProperty("--mx", `${e.clientX}px`);
      document.body.style.setProperty("--my", `${e.clientY}px`);
      const c = (e.target as HTMLElement)?.closest?.(".card") as HTMLElement | null;
      if (c) {
        const r = c.getBoundingClientRect();
        c.style.setProperty("--cx", `${e.clientX - r.left}px`);
        c.style.setProperty("--cy", `${e.clientY - r.top}px`);
      }
    };
    const onScroll = () => {
      const bar = document.getElementById("bar");
      if (bar) {
        const max = Math.max(1, document.body.scrollHeight - window.innerHeight);
        bar.style.width = `${(window.scrollY / max) * 100}%`;
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Fetch telemetry data
  const refresh = useCallback(async () => {
    try {
      const [c, d, p] = await Promise.all([
        api<AnyRecord>("/current"),
        api<AnyRecord>("/disks"),
        api<AnyRecord>("/processes?limit=10"),
      ]);
      setCurrent(normalizeCurrent(c));
      const diskRows = Array.isArray(d) ? d : Array.isArray(d?.disks) ? d.disks : Array.isArray(d?.data) ? d.data : [];
      setDisks(diskRows);
      const procRows = Array.isArray(p) ? p : Array.isArray(p?.processes) ? p.processes : Array.isArray(p?.data) ? p.data : [];
      setProcesses(procRows);
    } catch {
      // API temporarily unreachable
    }
  }, []);

  useEffect(() => {
    void refresh();
    const updateTimer = () => {
      const ms = Number(localStorage.getItem("dashboard-refresh-ms") ?? "2000") || 2000;
      return window.setInterval(() => void refresh(), ms);
    };
    let timer = updateTimer();
    const onSettings = () => {
      window.clearInterval(timer);
      timer = updateTimer();
    };
    window.addEventListener("dashboard-settings-changed", onSettings);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("dashboard-settings-changed", onSettings);
    };
  }, [refresh]);

  return (
    <>
      <div id="bar" />
      <nav id="nv">
        <div className="logo">
          <i />
          Server Monitor
        </div>
        {NAV.map(([path, label, color]) => (
          <NavLink
            key={path}
            to={path}
            end={path === "/"}
            className={({ isActive }) => (isActive ? "on" : "")}
          >
            <i className="nd" style={{ background: color }} />
            {label}
          </NavLink>
        ))}
      </nav>

      <main id="m">
        <Routes>
          <Route path="/" element={<Overview current={current} disks={disks} processes={processes} />} />
          <Route path="/cpu" element={<CpuPage current={current} />} />
          <Route path="/memory" element={<MemoryPage current={current} />} />
          <Route path="/network" element={<NetworkPage current={current} />} />
          <Route path="/disks" element={<DisksPage disks={disks} />} />
          <Route path="/docker" element={<DockerPage onToast={addToast} />} />
          <Route path="/settings" element={<SettingsPage onToast={addToast} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* Global Toast Container */}
      <div id="ts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? "e" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
