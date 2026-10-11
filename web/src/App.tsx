import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes, useLocation, Navigate } from "react-router-dom";
import {
  Activity, Cpu, HardDrive, LayoutDashboard, Network, Settings, Server,
  RefreshCw, MemoryStick, Gauge, ArrowDownToLine, ArrowUpFromLine, Container,
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import DockerPage from "./DockerPage";

type AnyRecord = Record<string, any>;
type HistoryPoint = AnyRecord;


const API = "/api";

// Finds fields independent of Go/JSON casing and underscores (e.g. UsedPercent,
// used_percent, MemoryUsedPercent). Searches nested objects as well.
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

function bytes(value?: number): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = Math.max(0, value), i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}
function rate(value?: number): string { return `${bytes(value)}/s`; }
function pct(value?: number): string { return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`; }
function timeLabel(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// The Go collector returns a flat Snapshot (cpuPercent, memoryUsed, netInBps, ...).
// Map it explicitly to the nested shape the pages use instead of guessing field names.
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

function NetChart({ data }: { data: HistoryPoint[] }) {
  return <div className="chart-container"><ResponsiveContainer width="100%" height="100%">
    <AreaChart data={data}>
      <CartesianGrid stroke="#292d3a" strokeDasharray="3 3" />
      <XAxis dataKey="timestamp" tickFormatter={timeLabel} stroke="#777f91" minTickGap={40} />
      <YAxis stroke="#777f91" tickFormatter={(v: number) => bytes(Number(v))} width={84} />
      <Tooltip labelFormatter={(label) => timeLabel(String(label))} formatter={(v: any) => rate(Number(v))} contentStyle={{ background: "#171a24", border: "1px solid #303546", borderRadius: 8 }} />
      <Area type="monotone" dataKey="netIn" name="Входящий" stroke="#80d6ff" fill="#80d6ff" fillOpacity={0.14} isAnimationActive={false} />
      <Area type="monotone" dataKey="netOut" name="Исходящий" stroke="#ffb078" fill="#ffb078" fillOpacity={0.14} isAnimationActive={false} />
    </AreaChart>
  </ResponsiveContainer></div>;
}

function MetricCard({ title, value, detail, icon }: { title: string; value: string; detail: string; icon: React.ReactNode }) {
  return <section className="metric-card">
    <div className="metric-card-heading"><span>{title}</span><span className="metric-icon">{icon}</span></div>
    <div className="metric-value">{value}</div><div className="metric-detail">{detail}</div>
  </section>;
}
function Panel({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><h2>{title}</h2>{children}</section>;
}
function PageHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return <header className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div></header>;
}
function Chart({ data, dataKey, color, unit = "", area = false }: { data: HistoryPoint[]; dataKey: string; color: string; unit?: string; area?: boolean }) {
  const Common = <>
    <CartesianGrid stroke="#292d3a" strokeDasharray="3 3" />
    <XAxis dataKey="timestamp" tickFormatter={timeLabel} stroke="#777f91" minTickGap={40} />
    <YAxis stroke="#777f91" unit={unit} />
    <Tooltip labelFormatter={(label) => timeLabel(String(label))} contentStyle={{ background: "#171a24", border: "1px solid #303546", borderRadius: 8 }} />
  </>;
  return <div className="chart-container"><ResponsiveContainer width="100%" height="100%">
    {area ? <AreaChart data={data}>{Common}<Area type="monotone" dataKey={dataKey} name={dataKey} stroke={color} fill={color} fillOpacity={0.14} isAnimationActive={false} /> </AreaChart>
      : <LineChart data={data}>{Common}<Line type="monotone" dataKey={dataKey} name={dataKey} stroke={color} dot={false} strokeWidth={2} isAnimationActive={false} /></LineChart>}
  </ResponsiveContainer></div>;
}

function Overview({ current, history, disks, processes }: { current: AnyRecord | null; history: HistoryPoint[]; disks: AnyRecord[]; processes: AnyRecord[] }) {
  const cpu = current?.cpu ?? {};
  const memory = current?.memory ?? {};
  const swap = current?.swap ?? {};
  const network = current?.network ?? {};
  return <>
    <PageHeading title="Обзор сервера" subtitle="Сводка системы — подробные графики доступны в разделах меню." />
    <div className="metric-grid">
      <MetricCard title="Процессор" value={pct(cpu.usage)} detail="Общая загрузка CPU" icon={<Cpu size={19} />} />
      <MetricCard title="Оперативная память" value={pct(asNumber(memory.usedPercent) ?? firstNumber(current, ["memoryUsedPercent", "usedPercent", "memPercent", "ramPercent"]))} detail={`${bytes(asNumber(memory.used) ?? firstNumber(current, ["memoryUsed", "usedBytes", "usedMemory", "ramUsed"]))} из ${bytes(asNumber(memory.total) ?? firstNumber(current, ["memoryTotal", "totalBytes", "totalMemory", "ramTotal"]))}`} icon={<MemoryStick size={19} />} />
      <MetricCard title="Входящая скорость" value={rate(asNumber(network.bytesRecvPerSec) ?? firstNumber(current, ["bytesRecvPerSec", "recvBytesPerSec", "rxBytesPerSec", "downloadBytesPerSec", "receiveRate"]))} detail="Текущая скорость получения" icon={<ArrowDownToLine size={19} />} />
      <MetricCard title="Исходящая скорость" value={rate(asNumber(network.bytesSentPerSec) ?? firstNumber(current, ["bytesSentPerSec", "sentBytesPerSec", "txBytesPerSec", "uploadBytesPerSec", "sendRate"]))} detail="Текущая скорость отправки" icon={<ArrowUpFromLine size={19} />} />
    </div>
    <div className="dashboard-grid">
      <Panel title="Загрузка процессора"><Chart data={history} dataKey="cpu" color="#9a8cff" unit="%" area /></Panel>
      <Panel title="Использование памяти"><Chart data={history} dataKey="memory" color="#48c9b0" unit="%" area /></Panel>
    </div>
    <div className="dashboard-grid">
      <Panel title="Диски">
        {disks.length ? <div className="table-wrap"><table><thead><tr><th>Точка монтирования</th><th>Файловая система</th><th>Использовано</th><th>Свободно</th></tr></thead><tbody>
          {disks.slice(0, 6).map((d, i) => <tr key={d.mountpoint ?? i}><td>{d.mountpoint ?? d.mountPoint ?? d.path ?? "—"}</td><td>{d.fstype ?? d.fsType ?? "—"}</td><td>{bytes(d.used ?? d.usedBytes)} ({pct(d.usedPercent ?? d.usedPercent)})</td><td>{bytes(d.free ?? d.freeBytes)}</td></tr>)}
        </tbody></table></div> : <p className="muted">Данные о дисках пока недоступны.</p>}
      </Panel>
      <Panel title="Процессы с наибольшей нагрузкой">
        {processes.length ? <div className="table-wrap"><table><thead><tr><th>Процесс</th><th>PID</th><th>CPU</th><th>Память</th></tr></thead><tbody>
          {processes.slice(0, 6).map((p, i) => <tr key={p.pid ?? i}><td>{p.name ?? p.processName ?? "—"}</td><td>{p.pid ?? "—"}</td><td>{pct(p.cpuPercent ?? p.cpu_percent ?? p.cpu)}</td><td>{bytes(p.rssBytes ?? p.rss_bytes ?? p.memoryUsed ?? p.memoryBytes ?? p.memory)}</td></tr>)}
        </tbody></table></div> : <p className="muted">Данные о процессах пока недоступны.</p>}
      </Panel>
    </div>
    <Panel title="Swap / файл подкачки">
      <div className="inline-stats"><span>Использовано: <b>{bytes(swap.used)}</b></span><span>Всего: <b>{bytes(swap.total)}</b></span><span>Загрузка: <b>{pct(swap.usedPercent)}</b></span></div>
    </Panel>
  </>;
}

function CpuPage({ current, history }: { current: AnyRecord | null; history: HistoryPoint[] }) {
  const cpu = current?.cpu ?? {};
  const rawCores = cpu.cores ?? findField(current, ["cores", "perCore", "cpuCores", "coreUsage", "cpuPercentPerCore"]);
  const cores: AnyRecord[] = Array.isArray(rawCores) ? rawCores : [];
  return <>
    <PageHeading title="Процессор" subtitle="Текущая загрузка и история CPU." />
    <div className="metric-grid"><MetricCard title="Общая загрузка" value={pct(asNumber(cpu.usage) ?? firstNumber(current, ["cpuPercent", "cpuUsage", "usagePercent", "totalCpuPercent"]))} detail="Все логические ядра" icon={<Cpu size={19} />} />
      <MetricCard title="Логических ядер" value={String(cores.length || firstNumber(current, ["logicalCores", "coreCount", "cpuCount"]) || "—")} detail="Обнаружено системой" icon={<Gauge size={19} />} /></div>
    <Panel title="История загрузки CPU"><Chart data={history} dataKey="cpu" color="#9a8cff" unit="%" area /></Panel>
    <Panel title="Ядра процессора"><div className="core-grid">{cores.map((core, i) => <div className="core-card" key={i}><div><b>Ядро {i + 1}</b><span>{pct(core.usage ?? core)}</span></div><div className="progress"><span style={{ width: `${Math.max(0, Math.min(100, Number(core.usage ?? core) || 0))}%` }} /></div></div>)}</div></Panel>
  </>;
}

function MemoryPage({ current, history }: { current: AnyRecord | null; history: HistoryPoint[] }) {
  const mem = current?.memory ?? {}, swap = current?.swap ?? {};
  const total = asNumber(mem.total) ?? firstNumber(current, ["memoryTotal", "totalPhysical", "totalMemory", "ramTotal", "totalBytes"]);
  const used = asNumber(mem.used) ?? firstNumber(current, ["memoryUsed", "usedPhysical", "usedMemory", "ramUsed", "usedBytes"]);
  const available = asNumber(mem.available) ?? firstNumber(current, ["memoryAvailable", "availableBytes", "availableMemory", "freeMemory", "memoryFree"]);
  // Derive the percentage from byte counts when possible; avoids a mismatched nested usedPercent.
  const usedPercent = total && used !== undefined ? used / total * 100 : asNumber(mem.usedPercent);
  const freeBytes = available ?? (total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined);
  const swapTotal = asNumber(swap.total) ?? firstNumber(current, ["swapTotal", "swapTotalBytes"]);
  const swapUsed = asNumber(swap.used) ?? firstNumber(current, ["swapUsed", "swapUsedBytes"]);
  const swapPercent = swapTotal && swapUsed !== undefined ? swapUsed / swapTotal * 100 : asNumber(swap.usedPercent);
  return <>
    <PageHeading title="Память" subtitle="Оперативная память и swap." />
    <div className="metric-grid">
      <MetricCard title="RAM использовано" value={pct(usedPercent)} detail={`${bytes(used)} из ${bytes(total)}`} icon={<MemoryStick size={19} />} />
      <MetricCard title="RAM свободно / доступно" value={bytes(freeBytes)} detail="Доступная системе память" icon={<Activity size={19} />} />
      <MetricCard title="Swap использовано" value={pct(swapPercent)} detail={`${bytes(swapUsed)} из ${bytes(swapTotal)}`} icon={<HardDrive size={19} />} />
    </div>
    <Panel title="История использования памяти"><Chart data={history} dataKey="memory" color="#48c9b0" unit="%" area /></Panel>
  </>;
}

function NetworkPage({ current, series }: { current: AnyRecord | null; series: HistoryPoint[] }) {
  const n = current?.network ?? {};
  const recvRate = asNumber(n.bytesRecvPerSec);
  const sentRate = asNumber(n.bytesSentPerSec);
  const recvTotal = asNumber(n.bytesRecv);
  const sentTotal = asNumber(n.bytesSent);
  const waiting = current === null;
  return <>
    <PageHeading title="Сеть" subtitle="Текущая скорость и счётчики трафика физических сетевых интерфейсов." />
    <div className="metric-grid">
      <MetricCard title="Входящая скорость" value={waiting ? "Загрузка…" : rate(recvRate)} detail="Получение данных сейчас" icon={<ArrowDownToLine size={19} />} />
      <MetricCard title="Исходящая скорость" value={waiting ? "Загрузка…" : rate(sentRate)} detail="Отправка данных сейчас" icon={<ArrowUpFromLine size={19} />} />
      <MetricCard title="Получено всего" value={bytes(recvTotal)} detail="С момента загрузки системы" icon={<Network size={19} />} />
      <MetricCard title="Отправлено всего" value={bytes(sentTotal)} detail="С момента загрузки системы" icon={<Activity size={19} />} />
    </div>
    <Panel title="Скорость сети">
      {series.length > 1 ? <NetChart data={series} /> : <p className="muted">Копим данные для графика…</p>}
    </Panel>
    <Panel title="Объём трафика">
      <div className="network-totals">
        <div><span>Загрузка (получено)</span><strong>{bytes(recvTotal)}</strong><small>RX · входящий трафик</small></div>
        <div><span>Выгрузка (отправлено)</span><strong>{bytes(sentTotal)}</strong><small>TX · исходящий трафик</small></div>
      </div>
      <p className="muted">Скорость считает Go-сервер по разнице счётчиков между замерами. Loopback и виртуальные интерфейсы (docker0, br-*, veth*) не учитываются, чтобы трафик контейнеров не считался дважды. Трафик по каждому контейнеру — на вкладке Docker.</p>
    </Panel>
  </>;
}

function DisksPage({ disks }: { disks: AnyRecord[] }) {
  const totalBytes = disks.reduce((sum, d) => sum + (asNumber(d.total ?? d.totalBytes) ?? 0), 0);
  const usedBytes = disks.reduce((sum, d) => sum + (asNumber(d.used ?? d.usedBytes) ?? 0), 0);
  const freeBytes = disks.reduce((sum, d) => sum + (asNumber(d.free ?? d.freeBytes) ?? 0), 0);
  const visibleDisks = disks.filter(d => {
    const mount = String(d.mountpoint ?? d.mountPoint ?? d.path ?? "");
    return !mount.startsWith("/snap/") && !mount.startsWith("/run/") && !mount.startsWith("/sys/") && !mount.startsWith("/proc/");
  });
  const rows = visibleDisks.length ? visibleDisks : disks;
  return <>
    <PageHeading title="Диски" subtitle="Объём хранилища, заполненность разделов и точки монтирования." />
    <div className="metric-grid">
      <MetricCard title="Общий объём" value={bytes(totalBytes)} detail={`${disks.length} файловых систем обнаружено`} icon={<HardDrive size={19} />} />
      <MetricCard title="Занято" value={bytes(usedBytes)} detail={totalBytes ? `${(usedBytes / totalBytes * 100).toFixed(1)}% от суммы разделов` : "Нет данных"} icon={<Activity size={19} />} />
      <MetricCard title="Свободно" value={bytes(freeBytes)} detail="Суммарно по обнаруженным разделам" icon={<Gauge size={19} />} />
      <MetricCard title="Разделы для обзора" value={String(rows.length)} detail="Скрытые snap/run разделы убраны, если есть основные" icon={<Server size={19} />} />
    </div>
    <Panel title="Использование места по разделам" className="disk-panel">
      {rows.length ? <div className="disk-cards">{rows.map((d, i) => {
        const mount = d.mountpoint ?? d.mountPoint ?? d.path ?? "—";
        const total = asNumber(d.total ?? d.totalBytes) ?? 0;
        const used = asNumber(d.used ?? d.usedBytes) ?? 0;
        const free = asNumber(d.free ?? d.freeBytes) ?? Math.max(0, total - used);
        const percent = asNumber(d.usedPercent ?? d.used_percent) ?? (total > 0 ? used / total * 100 : 0);
        const level = percent >= 90 ? "danger" : percent >= 75 ? "warning" : "normal";
        return <article className={`disk-card ${level}`} key={`${mount}-${d.device ?? i}`}>
          <div className="disk-card-top"><div><span className="disk-device">{d.device ?? "Устройство"}</span><h3>{mount}</h3></div><span className="disk-percent">{pct(percent)}</span></div>
          <div className="disk-progress"><span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>
          <div className="disk-card-stats"><div><span>Занято</span><b>{bytes(used)}</b></div><div><span>Свободно</span><b>{bytes(free)}</b></div><div><span>Всего</span><b>{bytes(total)}</b></div></div>
          <div className="disk-card-footer"><span>{d.fstype ?? d.fsType ?? "Файловая система не указана"}</span><span>{percent >= 90 ? "Почти заполнен" : percent >= 75 ? "Мало места" : "Норма"}</span></div>
        </article>;
      })}</div> : <p className="muted">Сервер не вернул данные о дисках.</p>}
    </Panel>
    <Panel title="Таблица файловых систем">
      <div className="table-wrap"><table><thead><tr><th>Устройство</th><th>Точка монтирования</th><th>Тип</th><th>Всего</th><th>Занято</th><th>Свободно</th><th>Использование</th></tr></thead><tbody>
        {rows.map((d, i) => {
          const total = asNumber(d.total ?? d.totalBytes) ?? 0;
          const used = asNumber(d.used ?? d.usedBytes) ?? 0;
          const free = asNumber(d.free ?? d.freeBytes) ?? Math.max(0, total - used);
          const percent = asNumber(d.usedPercent ?? d.used_percent) ?? (total > 0 ? used / total * 100 : undefined);
          return <tr key={`${d.device ?? ""}-${d.mountpoint ?? i}`}><td>{d.device ?? "—"}</td><td>{d.mountpoint ?? d.mountPoint ?? d.path ?? "—"}</td><td>{d.fstype ?? d.fsType ?? "—"}</td><td>{bytes(total)}</td><td>{bytes(used)}</td><td>{bytes(free)}</td><td><span className={`table-percent ${(percent ?? 0) >= 90 ? "danger-text" : (percent ?? 0) >= 75 ? "warning-text" : ""}`}>{pct(percent)}</span></td></tr>;
        })}
      </tbody></table></div>
    </Panel>
  </>;
}

function SettingsPage() {
  const [interval, setIntervalValue] = useState(() => localStorage.getItem("dashboard-refresh-ms") ?? "1000");
  const [saved, setSaved] = useState(false);
  function save(e: React.FormEvent) { e.preventDefault(); localStorage.setItem("dashboard-refresh-ms", interval); setSaved(true); window.dispatchEvent(new Event("dashboard-settings-changed")); }
  return <><PageHeading title="Настройки" subtitle="Настройки отображения панели." /><Panel title="Обновление интерфейса">
    <form className="settings-form" onSubmit={save}><label htmlFor="refresh">Частота обновления данных на странице</label>
      <select id="refresh" value={interval} onChange={e => { setIntervalValue(e.target.value); setSaved(false); }}>
        <option value="1000">Каждую секунду</option><option value="2000">Каждые 2 секунды</option><option value="5000">Каждые 5 секунд</option><option value="10000">Каждые 10 секунд</option><option value="30000">Каждые 30 секунд</option>
      </select><p className="muted">Это частота обновления браузера. Частоту серверного сбора метрик нужно настраивать отдельно на Go-сервере.</p>
      <button type="submit">Сохранить</button>{saved && <span className="success-message">Сохранено</span>}
    </form></Panel></>;
}

const nav = [
  { to: "/", label: "Обзор", icon: <LayoutDashboard size={18} />, end: true },
  { to: "/cpu", label: "Процессор", icon: <Cpu size={18} /> },
  { to: "/memory", label: "Память", icon: <MemoryStick size={18} /> },
  { to: "/network", label: "Сеть", icon: <Network size={18} /> },
  { to: "/disks", label: "Диски", icon: <HardDrive size={18} /> },
  { to: "/docker", label: "Docker", icon: <Container size={18} /> },
  { to: "/settings", label: "Настройки", icon: <Settings size={18} /> },
];

export default function App() {
  const location = useLocation();
  const [current, setCurrent] = useState<AnyRecord | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [disks, setDisks] = useState<AnyRecord[]>([]);
  const [processes, setProcesses] = useState<AnyRecord[]>([]);
  const [error, setError] = useState("");
  const [netLive, setNetLive] = useState<HistoryPoint[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [c, h, d, p] = await Promise.all([
        api<AnyRecord>("/current"),
        api<AnyRecord>("/history?range=1h"),
        api<AnyRecord>("/disks"),
        api<AnyRecord>("/processes?limit=10"),
      ]);
      const normalized = normalizeCurrent(c);
      setCurrent(normalized);
      // Live buffer for the network chart; used when the stored history has no network columns.
      setNetLive(prev => [...prev, {
        timestamp: c?.timestamp ?? new Date().toISOString(),
        netIn: normalized.network.bytesRecvPerSec,
        netOut: normalized.network.bytesSentPerSec,
      }].slice(-300));

      const rawPoints = Array.isArray(h) ? h : Array.isArray(h?.data) ? h.data : Array.isArray(h?.points) ? h.points : Array.isArray(h?.history) ? h.history : [];
      const points = rawPoints.map((point: AnyRecord) => ({
        ...point,
        timestamp: point.timestamp ?? point.Timestamp ?? point.time ?? point.Time ?? point.createdAt,
        cpu: point.cpu ?? point.CPU ?? point.cpuUsage ?? point.cpuPercent ?? point.cpu_percent ?? point.cpu?.usage ?? point.cpu?.Usage,
        memory: point.memory ?? point.Memory ?? point.memoryPercent ?? point.memPercent ?? point.memory_percent ?? point.memory?.usedPercent ?? point.memory?.UsedPercent,
        netIn: asNumber(point.netInBps),
        netOut: asNumber(point.netOutBps),
      }));
      setHistory(points);
      const diskRows = Array.isArray(d) ? d : Array.isArray(d?.disks) ? d.disks : Array.isArray(d?.data) ? d.data : [];
      setDisks(diskRows.map((disk: AnyRecord) => ({
        ...disk,
        total: disk.total ?? disk.Total ?? disk.totalBytes ?? disk.total_bytes,
        used: disk.used ?? disk.Used ?? disk.usedBytes ?? disk.used_bytes,
        free: disk.free ?? disk.Free ?? disk.freeBytes ?? disk.free_bytes,
        usedPercent: disk.usedPercent ?? disk.UsedPercent ?? disk.used_percent,
      })));
      const processRows = Array.isArray(p) ? p : Array.isArray(p?.processes) ? p.processes : Array.isArray(p?.data) ? p.data : [];
      setProcesses(processRows);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "API недоступен"); }
  }, []);

  useEffect(() => {
    void refresh();
    const updateTimer = () => {
      const ms = Number(localStorage.getItem("dashboard-refresh-ms") ?? "1000");
      return window.setInterval(() => void refresh(), ms);
    };
    let timer = updateTimer();
    const onSettings = () => { window.clearInterval(timer); timer = updateTimer(); };
    window.addEventListener("dashboard-settings-changed", onSettings);
    return () => { window.clearInterval(timer); window.removeEventListener("dashboard-settings-changed", onSettings); };
  }, [refresh, location.pathname]);

  const netSeries = useMemo(
    () => history.some(p => p.netIn !== undefined || p.netOut !== undefined) ? history : netLive,
    [history, netLive],
  );

  const pageLabel = useMemo(() => nav.find(n => n.to === location.pathname)?.label ?? "Обзор", [location.pathname]);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Server size={21} /></div><div><strong>Server Monitor</strong><span>System dashboard</span></div></div>
      <div className="sidebar-section-label">МОНИТОРИНГ</div>
      <nav className="sidebar-nav">{nav.map(n => <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>{n.icon}<span>{n.label}</span></NavLink>)}</nav>
      <div className="sidebar-footer"><span className={`status-dot${error ? " offline" : ""}`} />{error ? "Нет соединения" : "Мониторинг активен"}</div>
    </aside>
    <main className="main-content">
      <div className="topbar"><div className="breadcrumb"><span>Сервер</span><span>/</span><strong>{pageLabel}</strong></div><button className="icon-button" onClick={() => void refresh()}><RefreshCw size={16} />Обновить</button></div>
      {error && <div className="error-banner">Ошибка API: {error}. Убедись, что Go-сервер запущен на порту 8080.</div>}
      <Routes>
        <Route path="/" element={<Overview current={current} history={history} disks={disks} processes={processes} />} />
        <Route path="/cpu" element={<CpuPage current={current} history={history} />} />
        <Route path="/memory" element={<MemoryPage current={current} history={history} />} />
        <Route path="/network" element={<NetworkPage current={current} series={netSeries} />} />
        <Route path="/disks" element={<DisksPage disks={disks} />} />
        <Route path="/docker" element={<DockerPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </main>
  </div>;
}
