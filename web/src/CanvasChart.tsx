import { useEffect, useRef } from "react";

function getNiceMax(flat: number[], minMax = 1): number {
  const rawMax = Math.max(...flat, minMax);
  if (minMax >= 100 && rawMax <= 100) return 100;
  if (rawMax <= 5) return 5;
  if (rawMax <= 10) return 10;
  if (rawMax <= 20) return 20;
  if (rawMax <= 50) return 50;
  if (rawMax <= 100) return 100;
  if (rawMax <= 250) return 250;
  if (rawMax <= 500) return 500;
  if (rawMax <= 1000) return 1000;
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  return Math.ceil((rawMax * 1.05) / mag) * mag;
}

export function CanvasChart({
  series,
  colors,
  names,
  fmt = (v: number) => `${v.toFixed(0)}%`,
  height = 240,
  minMax = 1,
}: {
  series: number[][];
  colors: string[];
  names: string[];
  fmt?: (v: number) => string;
  height?: number;
  minMax?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasAnimatedRef = useRef(false);
  const hoverXRef = useRef(-1);
  const animIdRef = useRef<number>(0);

  // Store latest props so draw functions always access current values
  const propsRef = useRef({ series, colors, names, fmt, height, minMax });
  propsRef.current = { series, colors, names, fmt, height, minMax };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const c = cv.getContext("2d");
    if (!c) return;

    let W = cv.clientWidth || 400;
    const H = height;
    const d = window.devicePixelRatio || 1;

    const setupCanvas = () => {
      W = cv.clientWidth || 400;
      cv.width = W * d;
      cv.height = H * d;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.scale(d, d);
    };

    setupCanvas();

    const draw = (e = 1) => {
      const {
        series: curSeries,
        colors: curColors,
        names: curNames,
        fmt: curFmt,
        minMax: curMinMax,
      } = propsRef.current;

      const validSeries =
        curSeries.length > 0 && curSeries.some((s) => s.length > 0)
          ? curSeries.map((s) => (s.length === 1 ? [s[0], s[0]] : s.length === 0 ? [0, 0] : s))
          : [[0, 0]];

      const flat = validSeries.flat().filter(Number.isFinite);
      const mx = getNiceMax(flat, curMinMax);

      c.clearRect(0, 0, W, H);

      // Grid lines
      c.strokeStyle = "#ffffff10";
      c.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        c.beginPath();
        c.moveTo(0, (H * i) / 5);
        c.lineTo(W, (H * i) / 5);
        c.stroke();
      }

      // Series lines & area gradients
      validSeries.forEach((s, k) => {
        const n = s.length;
        if (n < 2) return;
        c.beginPath();
        s.forEach((v, i) => {
          const val = Number.isFinite(v) ? v : 0;
          const x = (i / (n - 1)) * W;
          const y = Math.max(0, Math.min(H, H - (val / mx) * H * e));
          i ? c.lineTo(x, y) : c.moveTo(x, y);
        });
        const col = curColors[k] || "#c8142e";
        c.strokeStyle = col;
        c.lineWidth = 2;
        c.shadowColor = col;
        c.shadowBlur = 4;
        c.stroke();
        c.shadowBlur = 0;

        c.lineTo(W, H);
        c.lineTo(0, H);
        const g = c.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, `${col}30`);
        g.addColorStop(1, `${col}00`);
        c.fillStyle = g;
        c.fill();
      });

      // Hover tooltip & cursor
      const hx = hoverXRef.current;
      if (hx >= 0 && validSeries[0] && validSeries[0].length > 1) {
        const n = validSeries[0].length;
        const i = Math.min(n - 1, Math.max(0, Math.round((hx / W) * (n - 1))));
        c.strokeStyle = "#ffffff55";
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(hx, 0);
        c.lineTo(hx, H);
        c.stroke();

        c.font = "12px Onest, sans-serif";
        validSeries.forEach((s, k) => {
          const col = curColors[k] || "#c8142e";
          const val = s[i] ?? 0;
          const label = `${curNames[k] || ""} ${curFmt(val)}`.trim();
          const textWidth = c.measureText(label).width;
          const tx = hx > W - 140 ? hx - textWidth - 14 : hx + 10;
          const ty = 20 + k * 22;

          c.fillStyle = "rgba(5, 5, 7, 0.9)";
          c.fillRect(tx - 4, ty - 13, textWidth + 8, 18);
          c.strokeStyle = "#ffffff20";
          c.strokeRect(tx - 4, ty - 13, textWidth + 8, 18);

          c.fillStyle = col;
          c.fillText(label, tx, ty);
        });
      }
    };

    // Initial entrance animation
    const t0 = performance.now();
    const animLoop = (now: number) => {
      const p = Math.min(1, (now - t0) / 700);
      const e = 1 - Math.pow(1 - p, 3);
      draw(e);
      if (p < 1) {
        animIdRef.current = requestAnimationFrame(animLoop);
      } else {
        hasAnimatedRef.current = true;
      }
    };

    if (!hasAnimatedRef.current) {
      animIdRef.current = requestAnimationFrame(animLoop);
    } else {
      draw(1);
    }

    const onMove = (e: MouseEvent) => {
      hoverXRef.current = e.offsetX;
      draw(1);
    };
    const onLeave = () => {
      hoverXRef.current = -1;
      draw(1);
    };

    cv.addEventListener("mousemove", onMove);
    cv.addEventListener("mouseleave", onLeave);

    const ro = new ResizeObserver(() => {
      setupCanvas();
      draw(1);
    });
    ro.observe(cv);

    return () => {
      cancelAnimationFrame(animIdRef.current);
      ro.disconnect();
      cv.removeEventListener("mousemove", onMove);
      cv.removeEventListener("mouseleave", onLeave);
    };
  }, [height]);

  // Live data update effect — immediately renders at full height with e=1
  useEffect(() => {
    if (hasAnimatedRef.current && canvasRef.current) {
      const cv = canvasRef.current;
      const c = cv.getContext("2d");
      if (!c) return;
      const W = cv.clientWidth || 400;
      const H = height;

      const {
        series: curSeries,
        colors: curColors,
        names: curNames,
        fmt: curFmt,
        minMax: curMinMax,
      } = propsRef.current;

      const validSeries =
        curSeries.length > 0 && curSeries.some((s) => s.length > 0)
          ? curSeries.map((s) => (s.length === 1 ? [s[0], s[0]] : s.length === 0 ? [0, 0] : s))
          : [[0, 0]];

      const flat = validSeries.flat().filter(Number.isFinite);
      const mx = getNiceMax(flat, curMinMax);

      c.clearRect(0, 0, W, H);

      // Grid lines
      c.strokeStyle = "#ffffff10";
      c.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        c.beginPath();
        c.moveTo(0, (H * i) / 5);
        c.lineTo(W, (H * i) / 5);
        c.stroke();
      }

      // Series lines & area gradients
      validSeries.forEach((s, k) => {
        const n = s.length;
        if (n < 2) return;
        c.beginPath();
        s.forEach((v, i) => {
          const val = Number.isFinite(v) ? v : 0;
          const x = (i / (n - 1)) * W;
          const y = Math.max(0, Math.min(H, H - (val / mx) * H));
          i ? c.lineTo(x, y) : c.moveTo(x, y);
        });
        const col = curColors[k] || "#c8142e";
        c.strokeStyle = col;
        c.lineWidth = 2;
        c.shadowColor = col;
        c.shadowBlur = 4;
        c.stroke();
        c.shadowBlur = 0;

        c.lineTo(W, H);
        c.lineTo(0, H);
        const g = c.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, `${col}30`);
        g.addColorStop(1, `${col}00`);
        c.fillStyle = g;
        c.fill();
      });

      // Hover tooltip & cursor
      const hx = hoverXRef.current;
      if (hx >= 0 && validSeries[0] && validSeries[0].length > 1) {
        const n = validSeries[0].length;
        const i = Math.min(n - 1, Math.max(0, Math.round((hx / W) * (n - 1))));
        c.strokeStyle = "#ffffff55";
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(hx, 0);
        c.lineTo(hx, H);
        c.stroke();

        c.font = "12px Onest, sans-serif";
        validSeries.forEach((s, k) => {
          const col = curColors[k] || "#c8142e";
          const val = s[i] ?? 0;
          const label = `${curNames[k] || ""} ${curFmt(val)}`.trim();
          const textWidth = c.measureText(label).width;
          const tx = hx > W - 140 ? hx - textWidth - 14 : hx + 10;
          const ty = 20 + k * 22;

          c.fillStyle = "rgba(5, 5, 7, 0.9)";
          c.fillRect(tx - 4, ty - 13, textWidth + 8, 18);
          c.strokeStyle = "#ffffff20";
          c.strokeRect(tx - 4, ty - 13, textWidth + 8, 18);

          c.fillStyle = col;
          c.fillText(label, tx, ty);
        });
      }
    }
  }, [series, colors, names, fmt, minMax, height]);

  return <canvas ref={canvasRef} style={{ width: "100%", height, display: "block" }} />;
}
