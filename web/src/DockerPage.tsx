import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, Container, Cpu, MemoryStick } from "lucide-react";

interface DStatus {
  available: boolean; error?: string; serverVersion?: string;
  containers: number; running: number; paused: number; stopped: number; images: number;
  ncpu: number; memTotal: number; lastUpdate: string; intervalSec: number; retentionDays: number; historyDays: number;
}
interface Row {
  id: string; name: string; image: string; state: string; status: string; health: string; project: string; ports: string[];
  startedAt: string; finishedAt: string; exitCode: number; oomKilled: boolean; restartCount: number; restartPolicy: string;
  cpuPercent: number; memBytes: number; memLimit: number; memPercent: number;
  netRxBps: number; netTxBps: number; netRxTotal: number; netTxTotal: number;
  blkReadBps: number; blkWriteBps: number; pids: number;
  firstSeen: string; lastSeen: string; samples: number; uptimePercent: number;
  avgCpu: number; maxCpu: number; avgMem: number; maxMem: number;
  rxBytes: number; txBytes: number; blkRead: number; blkWrite: number; restarts: number; crashes: number;
}
interface DPoint { timestamp: string; cpu: number; cpuMax: number; mem: number; memMax: number; rxBps: number; txBps: number; up: number }
interface DEvent { id: number; timestamp: string; name: string; containerId: string; kind: string; level: string; detail: string }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

const RANGES: [string, string][] = [["1h", "1 час"], ["6h", "6 часов"], ["24h", "24 часа"], ["7d", "7 дней"], ["30d", "30 дней"]];
const KIND_LABEL: Record<string, string> = {
  started: "запущен", stopped: "остановлен", crashed: "упал", oom: "OOM", restarting: "перезапускается", restarted: "перезапуск",
  paused: "пауза", unpaused: "снят с паузы", created: "создан", removed: "удалён", recreated: "пересоздан",
  unhealthy: "unhealthy", healthy: "healthy", discovered: "обнаружен",
};

function bytes(v?: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let n = Math.max(0, v), i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : i === 1 ? 0 : 1)} ${u[i]}`;
}
const rate = (v?: number) => `${bytes(v)}/s`;
const pct = (v?: number) => v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
function since(iso: string): string {
  if (!iso) return "—";
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(sec >= 0)) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}д ${h}ч` : h > 0 ? `${h}ч ${m}м` : `${m}м`;
}
const fullTime = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); };

function isProblem(r: Row): boolean {
  if (r.state === "removed") return false;
  if (r.health === "unhealthy" || r.state === "restarting" || r.state === "dead") return true;
  return r.state === "exited" && (r.oomKilled || (r.exitCode !== 0 && r.exitCode !== 137 && r.exitCode !== 143));
}
function badge(r: Row): [string, string] {
  if (r.state === "removed") return ["удалён", "idle"];
  if (r.state === "restarting") return ["перезапуск", "bad"];
  if (r.state === "paused") return ["пауза", "warn"];
  if (r.state === "running") {
    if (r.health === "unhealthy") return ["unhealthy", "bad"];
    if (r.health === "starting") return ["запуск…", "warn"];
    if (r.health === "healthy") return ["healthy", "ok"];
    return ["работает", "ok"];
  }
  if (r.state === "exited" || r.state === "dead") {
    if (r.oomKilled) return ["OOM", "bad"];
    if (isProblem(r)) return [`упал (${r.exitCode})`, "bad"];
    return ["остановлен", "idle"];
  }
  return [r.state || "?", "idle"];
}

function Series({ data, lines, fmt, long }: { data: DPoint[]; lines: { key: keyof DPoint; name: string; color: string }[]; fmt: (v: number) => string; long: boolean }) {
  const tick = (v: string) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    return long ? d.toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit" }) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  return <div className="chart-container"><ResponsiveContainer width="100%" height="100%">
    <AreaChart data={data}>
      <CartesianGrid stroke="#292d3a" strokeDasharray="3 3" />
      <XAxis dataKey="timestamp" tickFormatter={tick} stroke="#777f91" minTickGap={40} />
      <YAxis stroke="#777f91" tickFormatter={(v: number) => fmt(Number(v))} width={78} />
      <Tooltip labelFormatter={(l) => fullTime(String(l))} formatter={(v: any) => fmt(Number(v))} contentStyle={{ background: "#171a24", border: "1px solid #303546", borderRadius: 8 }} />
      {lines.map(l => <Area key={String(l.key)} type="monotone" dataKey={l.key as string} name={l.name} stroke={l.color} fill={l.color} fillOpacity={0.12} isAnimationActive={false} />)}
    </AreaChart>
  </ResponsiveContainer></div>;
}

function Rank({ title, rows, value, max, fmt, sub }: { title: string; rows: Row[]; value: (r: Row) => number; max: (r: Row) => number; fmt: (v: number) => string; sub: (r: Row) => string }) {
  const top = Math.max(1e-9, ...rows.map(value));
  return <section className="panel">
    <h2>{title}</h2>
    {rows.length ? <div className="rank">{rows.map(r => <div className="rank-row" key={r.name}>
      <div className="rank-head"><b>{r.name}</b><span>{fmt(value(r))} <em>макс {fmt(max(r))}</em></span></div>
      <div className="bar"><span style={{ width: `${Math.max(2, value(r) / top * 100)}%` }} /></div>
      <div className="rank-sub">{sub(r)}</div>
    </div>)}</div> : <p className="muted">За выбранный период данных пока нет.</p>}
  </section>;
}

export default function DockerPage() {
  const [range, setRange] = useState("1h");
  const [status, setStatus] = useState<DStatus | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [events, setEvents] = useState<DEvent[]>([]);
  const [selected, setSelected] = useState("");
  const [points, setPoints] = useState<DPoint[]>([]);
  const [selEvents, setSelEvents] = useState<DEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [st, sm, ev] = await Promise.all([
          get<DStatus>("/docker/status"),
          get<Row[]>(`/docker/summary?range=${range}`),
          get<DEvent[]>("/docker/events?limit=80"),
        ]);
        if (!alive) return;
        setStatus(st); setRows(sm); setEvents(ev); setError("");
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "API недоступен"); }
    };
    void load();
    const ms = Math.max(3000, Number(localStorage.getItem("dashboard-refresh-ms") ?? "5000") || 5000);
    const t = window.setInterval(() => void load(), ms);
    return () => { alive = false; window.clearInterval(t); };
  }, [range]);

  useEffect(() => {
    if (!selected) { setPoints([]); setSelEvents([]); return; }
    let alive = true;
    const name = encodeURIComponent(selected);
    const load = async () => {
      try {
        const [p, ev] = await Promise.all([
          get<DPoint[]>(`/docker/containers/${name}/history?range=${range}`),
          get<DEvent[]>(`/docker/events?container=${name}&limit=50`),
        ]);
        if (alive) { setPoints(p); setSelEvents(ev); }
      } catch { /* keep the previous data */ }
    };
    void load();
    const t = window.setInterval(() => void load(), 10000);
    return () => { alive = false; window.clearInterval(t); };
  }, [selected, range]);

  const live = useMemo(() => rows.filter(r => r.state !== "removed"), [rows]);
  const running = useMemo(() => live.filter(r => r.state === "running"), [live]);
  const problems = useMemo(() => live.filter(isProblem), [live]);
  const totalCpu = running.reduce((s, r) => s + r.cpuPercent, 0);
  const totalMem = running.reduce((s, r) => s + r.memBytes, 0);
  const topCpu = useMemo(() => rows.filter(r => r.samples > 0 && r.avgCpu > 0).sort((a, b) => b.avgCpu - a.avgCpu).slice(0, 8), [rows]);
  const topMem = useMemo(() => rows.filter(r => r.samples > 0 && r.avgMem > 0).sort((a, b) => b.avgMem - a.avgMem).slice(0, 8), [rows]);
  const topNet = useMemo(() => rows.filter(r => r.rxBytes + r.txBytes > 0).sort((a, b) => (b.rxBytes + b.txBytes) - (a.rxBytes + a.txBytes)).slice(0, 8), [rows]);
  const sel = rows.find(r => r.name === selected);
  const long = range === "7d" || range === "30d";
  const rangeLabel = RANGES.find(r => r[0] === range)?.[1] ?? range;

  return <>
    <header className="page-heading docker-heading">
      <div><h1>Docker</h1><p>Кто сколько ест, что работает, а что упало. История хранится на сервере{status ? ` (метрики ${status.retentionDays} дн., события и почасовая статистика ${status.historyDays} дн.)` : ""}.</p></div>
      <div className="range-tabs">{RANGES.map(([v, label]) => <button key={v} className={v === range ? "active" : ""} onClick={() => setRange(v)}>{label}</button>)}</div>
    </header>

    {error && <div className="error-banner">Ошибка API: {error}</div>}
    {status && !status.available && <div className="error-banner">
      Docker недоступен: {status.error}. Проверь, что демон запущен и пользователь, от которого работает Go-сервер, имеет доступ к <code>/var/run/docker.sock</code> (группа <code>docker</code>), либо задай <code>DOCKER_HOST</code>.
    </div>}

    <div className="metric-grid">
      <section className="metric-card"><div className="metric-card-heading"><span>Контейнеры</span><span className="metric-icon"><Container size={19} /></span></div>
        <div className="metric-value">{running.length} / {live.length}</div>
        <div className="metric-detail">работают / всего · остановлено {live.filter(r => r.state === "exited" || r.state === "created").length}{status ? ` · образов ${status.images}` : ""}</div></section>
      <section className="metric-card"><div className="metric-card-heading"><span>Требуют внимания</span><span className="metric-icon"><AlertTriangle size={19} /></span></div>
        <div className="metric-value">{problems.length}</div>
        <div className="metric-detail">{problems.length ? problems.map(p => p.name).join(", ") : "Всё в порядке"}</div></section>
      <section className="metric-card"><div className="metric-card-heading"><span>CPU контейнеров</span><span className="metric-icon"><Cpu size={19} /></span></div>
        <div className="metric-value">{pct(totalCpu)}</div>
        <div className="metric-detail">{status?.ncpu ? `${pct(totalCpu / status.ncpu)} от ${status.ncpu} ядер хоста` : "100% = одно ядро"}</div></section>
      <section className="metric-card"><div className="metric-card-heading"><span>Память контейнеров</span><span className="metric-icon"><MemoryStick size={19} /></span></div>
        <div className="metric-value">{bytes(totalMem)}</div>
        <div className="metric-detail">{status?.memTotal ? `${pct(totalMem / status.memTotal * 100)} от ${bytes(status.memTotal)} хоста` : "Сумма по запущенным"}</div></section>
    </div>

    <div className="dashboard-grid">
      <Rank title={`Топ по CPU · среднее за ${rangeLabel}`} rows={topCpu} value={r => r.avgCpu} max={r => r.maxCpu} fmt={pct} sub={r => `сейчас ${r.state === "running" ? pct(r.cpuPercent) : "—"}`} />
      <Rank title={`Топ по памяти · среднее за ${rangeLabel}`} rows={topMem} value={r => r.avgMem} max={r => r.maxMem} fmt={bytes} sub={r => `сейчас ${r.state === "running" ? `${bytes(r.memBytes)} (${pct(r.memPercent)} лимита)` : "—"}`} />
    </div>
    {topNet.length > 0 && <section className="panel"><h2>Сетевой трафик контейнеров за {rangeLabel}</h2>
      <div className="table-wrap"><table><thead><tr><th>Контейнер</th><th>Получено</th><th>Отправлено</th><th>Диск: чтение</th><th>Диск: запись</th></tr></thead><tbody>
        {topNet.map(r => <tr key={r.name}><td>{r.name}</td><td>↓ {bytes(r.rxBytes)}</td><td>↑ {bytes(r.txBytes)}</td><td>{bytes(r.blkRead)}</td><td>{bytes(r.blkWrite)}</td></tr>)}
      </tbody></table></div></section>}

    <section className="panel">
      <h2>Контейнеры <span className="hint">нажми на строку для подробностей и графиков</span></h2>
      {rows.length ? <div className="table-wrap"><table className="docker-table"><thead><tr>
        <th>Статус</th><th>Контейнер</th><th>CPU</th><th>Память</th><th>Сеть сейчас</th><th>Диск сейчас</th><th>PID</th><th>Перезапуски</th><th>Аптайм</th>
      </tr></thead><tbody>
        {rows.map(r => {
          const [text, cls] = badge(r);
          const on = r.state === "running";
          return <tr key={r.name} className={`clickable${r.name === selected ? " selected" : ""}${r.state === "removed" ? " dim" : ""}`} onClick={() => setSelected(r.name === selected ? "" : r.name)}>
            <td><span className={`badge ${cls}`}>{text}</span></td>
            <td><b>{r.name}</b><div className="sub">{r.project ? `${r.project} · ` : ""}{r.image}</div></td>
            <td>{on ? pct(r.cpuPercent) : "—"}<div className="sub">ср. {pct(r.avgCpu)} · макс {pct(r.maxCpu)}</div></td>
            <td>{on ? `${bytes(r.memBytes)} (${pct(r.memPercent)})` : "—"}<div className="sub">ср. {bytes(r.avgMem)} · макс {bytes(r.maxMem)}</div></td>
            <td>{on ? <>↓ {rate(r.netRxBps)} ↑ {rate(r.netTxBps)}</> : "—"}<div className="sub">за период ↓ {bytes(r.rxBytes)} ↑ {bytes(r.txBytes)}</div></td>
            <td>{on ? <>R {rate(r.blkReadBps)} W {rate(r.blkWriteBps)}</> : "—"}<div className="sub">за период R {bytes(r.blkRead)} W {bytes(r.blkWrite)}</div></td>
            <td>{on ? r.pids : "—"}</td>
            <td>{r.restarts}{r.crashes > 0 && <span className="crash"> · падений {r.crashes}</span>}<div className="sub">всего {r.restartCount}</div></td>
            <td>{r.samples ? pct(r.uptimePercent) : "—"}<div className="sub">{on ? `работает ${since(r.startedAt)}` : r.state === "removed" ? `удалён, виден до ${fullTime(r.lastSeen)}` : r.finishedAt ? `остановлен ${since(r.finishedAt)} назад` : ""}</div></td>
          </tr>;
        })}
      </tbody></table></div> : <p className="muted">{status?.available ? "Контейнеров не найдено." : "Нет данных."}</p>}
    </section>

    {sel && <section className="panel detail">
      <h2>{sel.name} <span className="hint">{rangeLabel}</span></h2>
      <div className="detail-meta">
        <span>Образ: <b>{sel.image}</b></span>
        <span>ID: <b>{sel.id.slice(0, 12) || "—"}</b></span>
        <span>Статус Docker: <b>{sel.status || sel.state}</b></span>
        <span>Политика рестарта: <b>{sel.restartPolicy || "no"}</b></span>
        <span>Порты: <b>{sel.ports?.length ? sel.ports.join(", ") : "—"}</b></span>
        <span>Впервые замечен: <b>{fullTime(sel.firstSeen)}</b></span>
        {sel.state !== "running" && sel.state !== "removed" && <span>Код выхода: <b>{sel.exitCode}{sel.oomKilled ? " (OOM)" : ""}</b></span>}
      </div>
      <div className="dashboard-grid">
        <div><h3>CPU (100% = 1 ядро)</h3><Series data={points} long={long} fmt={pct} lines={[{ key: "cpu", name: "Среднее", color: "#9a8cff" }, { key: "cpuMax", name: "Пик", color: "#f29ac7" }]} /></div>
        <div><h3>Память</h3><Series data={points} long={long} fmt={bytes} lines={[{ key: "mem", name: "Среднее", color: "#48c9b0" }, { key: "memMax", name: "Пик", color: "#ffb078" }]} /></div>
      </div>
      <h3>Сеть</h3>
      <Series data={points} long={long} fmt={rate} lines={[{ key: "rxBps", name: "Получение", color: "#80d6ff" }, { key: "txBps", name: "Отправка", color: "#ffb078" }]} />
      <h3>События контейнера</h3>
      <EventTable events={selEvents} hideName />
    </section>}

    <section className="panel">
      <h2>Журнал событий <span className="hint">запуски, остановки, падения, OOM, рестарты, healthcheck</span></h2>
      <EventTable events={events} />
    </section>
  </>;
}

function EventTable({ events, hideName = false }: { events: DEvent[]; hideName?: boolean }) {
  if (!events.length) return <p className="muted">Событий пока нет.</p>;
  return <div className="table-wrap"><table><thead><tr><th>Время</th>{!hideName && <th>Контейнер</th>}<th>Событие</th><th>Детали</th></tr></thead><tbody>
    {events.map(e => <tr key={e.id}><td>{fullTime(e.timestamp)}</td>{!hideName && <td>{e.name}</td>}
      <td><span className={`badge ${e.level === "error" ? "bad" : e.level === "warn" ? "warn" : "ok"}`}>{KIND_LABEL[e.kind] ?? e.kind}</span></td><td>{e.detail}</td></tr>)}
  </tbody></table></div>;
}
