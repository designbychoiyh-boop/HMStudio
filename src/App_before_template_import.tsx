import { useState, useRef, useEffect, useCallback } from "react";

// ── Interpolation ─────────────────────────────────────────────────────────────
const lerp = (kfs, time, fallback) => {
  if (!kfs || !kfs.length) return fallback;
  const s = [...kfs].sort((a, b) => a.t - b.t);
  if (time <= s[0].t) return s[0].v;
  if (time >= s[s.length - 1].t) return s[s.length - 1].v;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1];
    if (time >= a.t && time <= b.t) {
      const p = (time - a.t) / Math.max(0.0001, b.t - a.t);
      return a.v + (b.v - a.v) * p;
    }
  }
  return fallback;
};
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
const fmt = s => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), Math.floor(s % 60), Math.floor((s % 1) * 30)]
  .map(n => String(n).padStart(2, "0")).join(":");
const uid = () => Math.random().toString(36).slice(2);
const KEYFRAME_PROPS = ["x", "y", "scale", "rotation", "opacity"];
const hasKeyframeAt = (item, prop, time) => !!(item?.kf?.[prop] || []).find(k => Math.abs(k.t - time) < 0.001);
const upsertKeyframe = (item, prop, time, value) => {
  const next = { ...(item.kf || {}) };
  const arr = [...(next[prop] || [])];
  const idx = arr.findIndex(k => Math.abs(k.t - time) < 0.001);
  const kf = { t: time, v: value };
  if (idx >= 0) arr[idx] = kf; else arr.push(kf);
  arr.sort((a, b) => a.t - b.t);
  next[prop] = arr;
  return next;
};
const removeKeyframe = (item, prop, time) => {
  const next = { ...(item.kf || {}) };
  next[prop] = [...(next[prop] || [])].filter(k => Math.abs(k.t - time) >= 0.001);
  return next;
};
const collectKeyframeTimes = item => {
  const times = new Set();
  KEYFRAME_PROPS.forEach(prop => ((item?.kf?.[prop] || []).forEach(k => times.add(Number(k.t.toFixed(3))))));
  return [...times].sort((a, b) => a - b);
};

// ── AE Template Registry ──────────────────────────────────────────────────────
const AE_TEMPLATES = {
  "TopTitle_F_04_AGL & NAVIADs": {
    w: 1000, h: 170,
    layers: [
      { t: "path", d: "M0 30 H420 Q470 30 510 85 Q470 140 420 140 H0 Z", fill: "#0E8D95", stroke: "#37F5F6", sw: 3 },
      { t: "path", d: "M430 30 H965 L930 62 H555 Q520 62 490 95 Q520 140 560 140 H875 Q930 140 965 95 L1000 62 V30 Z", fill: "#2B353D", stroke: "#37F5F6", sw: 3 },
      { t: "line", x1: 45, y1: 54, x2: 370, y2: 54, stroke: "#7FFDFD", sw: 3, opacity: 0.85 },
      { t: "line", x1: 425, y1: 44, x2: 975, y2: 44, stroke: "#37F5F6", sw: 3, opacity: 0.9 },
      { t: "field", label: "Sub_텍스트", x: 48, y: 34, w: 320, h: 22, fs: 26, fw: "500", fill: "#F3F9FA", align: "left" },
      { t: "field", label: "Main_텍스트 상", x: 48, y: 78, w: 440, h: 42, fs: 48, fw: "700", fill: "#FFFFFF", align: "left" },
      { t: "field", label: "Main_텍스트 하", x: 645, y: 68, w: 300, h: 36, fs: 40, fw: "700", fill: "#FFFFFF", align: "center" },
    ]
  }
};

const DEFAULT_FIELDS = [
  { id: "subText", label: "Sub_텍스트", value: "부산 수영구 망미동" },
  { id: "mainTop", label: "Main_텍스트 상", value: "Reconstruction Project" },
  { id: "mainBottom", label: "Main_텍스트 하", value: "SHUAIBA AIR BASE" },
];

// ── SVG Template Renderer ─────────────────────────────────────────────────────
function AETemplateSVG({ compName, fields = [], fontFamily = "sans-serif" }) {
  const def = AE_TEMPLATES[compName];
  if (!def) return (
    <div style={{ width: "100%", height: "100%", background: "rgba(34,197,94,0.08)", border: "1px dashed rgba(34,197,94,0.4)", display: "flex", alignItems: "center", justifyContent: "center", color: "#22c55e", fontSize: 11 }}>
      AE 템플릿 (웹 정의 미등록)
    </div>
  );
  const fieldMap = new Map(fields.map(f => [f.label, f.value]));
  return (
    <svg viewBox={`0 0 ${def.w} ${def.h}`} style={{ width: "100%", height: "100%", overflow: "visible" }} preserveAspectRatio="xMidYMid meet">
      {def.layers.map((l, i) => {
        if (l.t === "path") return <path key={i} d={l.d} fill={l.fill} stroke={l.stroke} strokeWidth={l.sw} opacity={l.opacity ?? 1} />;
        if (l.t === "line") return <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.stroke} strokeWidth={l.sw} opacity={l.opacity ?? 1} />;
        const text = fieldMap.get(l.label) || l.label;
        const tx = l.align === "left" ? l.x : l.align === "right" ? l.x + l.w : l.x + l.w / 2;
        const anchor = l.align === "left" ? "start" : l.align === "right" ? "end" : "middle";
        return (
          <text key={i} x={tx} y={l.y + l.fs} fill={l.fill} fontSize={l.fs} fontWeight={l.fw} textAnchor={anchor}
            style={{ fontFamily }}>
            {text}
          </text>
        );
      })}
    </svg>
  );
}

// ── Graphic on Canvas ─────────────────────────────────────────────────────────
function GraphicEl({ g, time, selected, editing, onEdit, onEndEdit, onChange }) {
  const visible = time >= g.ts && time < g.ts + g.dur;
  if (!visible) return null;

  const ct = time - g.ts;
  const x = lerp(g.kf?.x, ct, g.x);
  const y = lerp(g.kf?.y, ct, g.y);
  const sc = lerp(g.kf?.scale, ct, g.scale);
  const op = lerp(g.kf?.opacity, ct, g.opacity);
  const rot = lerp(g.kf?.rotation, ct, g.rotation ?? 0);

  const base = {
    position: "absolute",
    left: `${x}%`, top: `${y}%`,
    width: g.width, height: g.height,
    opacity: op,
    transform: `translate(-50%,-50%) scale(${sc / 100}) rotate(${rot}deg)`,
    transformOrigin: "center center",
    pointerEvents: "none",
    outline: "none",
    overflow: "visible",
    zIndex: selected ? 100 : 1,
  };

  if (g.type === "ae_template") {
    return (
      <div style={{ ...base, border: selected ? "2px solid #22c55e" : "none", boxShadow: selected ? "0 0 0 1px rgba(34,197,94,0.35)" : "none" }}>
        <AETemplateSVG compName={g.compName} fields={g.fields} fontFamily={g.fontFamily} />
        {selected && (
          <div style={{ position: "absolute", top: -18, left: 0, background: "rgba(34,197,94,0.85)", color: "#000", fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, whiteSpace: "nowrap" }}>
            AE Template · {g.compName}
          </div>
        )}
      </div>
    );
  }

  if (g.type === "text") {
    if (editing) {
      return (
        <div style={{ ...base, pointerEvents: "auto" }}>
          <div
            contentEditable suppressContentEditableWarning
            style={{ width: "100%", height: "100%", color: g.color, fontSize: g.fontSize, fontFamily: g.fontFamily || "sans-serif", fontWeight: g.fontWeight || "700", textAlign: g.textAlign || "center", display: "flex", alignItems: "center", justifyContent: g.textAlign === "left" ? "flex-start" : g.textAlign === "right" ? "flex-end" : "center", padding: "4px 8px", border: "2px solid #f97316", outline: "none", background: "rgba(0,0,0,0.3)", whiteSpace: "pre-wrap", wordBreak: "break-word", boxSizing: "border-box" }}
            onBlur={e => { onChange(e.currentTarget.textContent || ""); onEndEdit(); }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } }}
            ref={el => { if (el && document.activeElement !== el) { el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); } }}
          >{g.content}</div>
        </div>
      );
    }
    return (
      <div style={{ ...base, color: g.color, fontSize: g.fontSize, fontFamily: g.fontFamily || "sans-serif", fontWeight: g.fontWeight || "700", textAlign: g.textAlign || "center", display: "flex", alignItems: "center", justifyContent: g.textAlign === "left" ? "flex-start" : g.textAlign === "right" ? "flex-end" : "center", padding: "4px 8px", whiteSpace: "pre-wrap", wordBreak: "break-word", border: selected ? "1px solid #f97316" : "none" }}>
        {g.content}
      </div>
    );
  }

  if (g.type === "rectangle") {
    return <div style={{ ...base, background: g.color, borderRadius: 4, border: selected ? "2px solid #f97316" : "none" }} />;
  }
  if (g.type === "circle") {
    return <div style={{ ...base, background: g.color, borderRadius: "9999px", border: selected ? "2px solid #f97316" : "none" }} />;
  }
  return null;
}

// ── Transform Handles ─────────────────────────────────────────────────────────
function TransformHandles({ g, time, stageRef, onBeginInteract }) {
  if (!g) return null;
  const ct = time - g.ts;
  const x = lerp(g.kf?.x, ct, g.x);
  const y = lerp(g.kf?.y, ct, g.y);
  const sc = lerp(g.kf?.scale, ct, g.scale);
  const rot = lerp(g.kf?.rotation, ct, g.rotation ?? 0);
  const corners = [
    { key: "nw", cx: -1, cy: -1, cursor: "nwse-resize" },
    { key: "ne", cx: 1, cy: -1, cursor: "nesw-resize" },
    { key: "sw", cx: -1, cy: 1, cursor: "nesw-resize" },
    { key: "se", cx: 1, cy: 1, cursor: "nwse-resize" },
  ];
  return (
    <div style={{ position: "absolute", left: `${x}%`, top: `${y}%`, width: g.width, height: g.height, transform: `translate(-50%,-50%) scale(${sc / 100}) rotate(${rot}deg)`, transformOrigin: "center center", pointerEvents: "none", zIndex: 200 }}>
      {/* border */}
      <div onMouseDown={e => onBeginInteract(e, g, "move")} style={{ position: "absolute", inset: 0, border: "2px solid #f97316", boxShadow: "0 0 0 1px rgba(249,115,22,0.2)", cursor: "move", pointerEvents: "auto" }} />
      {/* corner handles */}
      {corners.map(({ key, cx, cy, cursor }) => (
        <div key={key}
          onMouseDown={e => onBeginInteract(e, g, "scale")}
          style={{ position: "absolute", width: 14, height: 14, background: "#f97316", border: "2px solid #000", borderRadius: "50%", cursor, pointerEvents: "auto", left: cx > 0 ? "100%" : 0, top: cy > 0 ? "100%" : 0, transform: `translate(${cx > 0 ? "-50%" : "-50%"}, ${cy > 0 ? "-50%" : "-50%"})` }} />
      ))}
      {/* rotate handle */}
      <div style={{ position: "absolute", left: "50%", top: 0, width: 1, height: 24, background: "rgba(249,115,22,0.7)", transform: "translate(-50%, -100%)", pointerEvents: "none" }} />
      <div
        onMouseDown={e => onBeginInteract(e, g, "rotate")}
        style={{ position: "absolute", left: "50%", top: -34, width: 18, height: 18, background: "#38bdf8", border: "2px solid #000", borderRadius: "50%", cursor: "grab", pointerEvents: "auto", transform: "translateX(-50%)" }} />
    </div>
  );
}

// ── Slider ────────────────────────────────────────────────────────────────────
function Slider({ value, min, max, step, onChange, onCommit, style }) {
  return (
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(Number(e.target.value))}
      onMouseUp={onCommit} onTouchEnd={onCommit}
      style={{ width: "100%", accentColor: "#f97316", cursor: "pointer", ...style }} />
  );
}

// ── Color Swatch ──────────────────────────────────────────────────────────────
function ColorPicker({ value, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input type="color" value={value || "#ffffff"} onChange={e => onChange(e.target.value)}
        style={{ width: 32, height: 28, border: "1px solid #3f3f46", borderRadius: 4, cursor: "pointer", padding: 2, background: "#18181b" }} />
      <input type="text" value={value || "#ffffff"} onChange={e => onChange(e.target.value)}
        style={{ flex: 1, background: "#18181b", border: "1px solid #3f3f46", borderRadius: 4, color: "#fff", fontSize: 11, padding: "3px 6px", outline: "none", fontFamily: "monospace" }} />
    </div>
  );
}

// ── PropRow ───────────────────────────────────────────────────────────────────
function PropRow({ label, value, min, max, step, unit = "", onChange, onCommit }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: "#71717a", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
        <span style={{ fontSize: 10, color: "#a1a1aa", fontFamily: "monospace" }}>{typeof value === "number" ? value.toFixed(step < 1 ? 1 : 0) : value}{unit}</span>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} onCommit={onCommit} />
    </div>
  );
}

function AnimPropRow({ label, value, min, max, step, unit = "", onChange, onCommit, keyframed, onToggleKeyframe }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: "#71717a", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={onToggleKeyframe} style={{ background: keyframed ? "#f97316" : "#18181b", color: keyframed ? "#000" : "#a1a1aa", border: `1px solid ${keyframed ? "#f97316" : "#3f3f46"}`, borderRadius: 4, padding: "1px 6px", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>◆</button>
          <input type="number" value={typeof value === "number" ? value : 0} min={min} max={max} step={step}
            onChange={e => onChange(clamp(Number(e.target.value), min, max))}
            onBlur={onCommit}
            style={{ width: 68, background: "#18181b", border: "1px solid #3f3f46", borderRadius: 4, color: "#fff", fontSize: 10, padding: "2px 6px", outline: "none", fontFamily: "monospace" }} />
          <span style={{ fontSize: 10, color: "#a1a1aa", fontFamily: "monospace" }}>{unit}</span>
        </div>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} onCommit={onCommit} />
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function VibeEdit() {
  // ── State ──────────────────────────────────────────────────────────────
  const [clips, setClips] = useState([]);
  const [graphics, setGraphics] = useState([]);
  const [time, setTime] = useState(0);
  const [totalDur, setTotalDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selClipId, setSelClipId] = useState(null);
  const [selGfxId, setSelGfxId] = useState(null);
  const [editingGfxId, setEditingGfxId] = useState(null);
  const [tool, setTool] = useState("select"); // select | razor | text | rect | circle | ae
  const [zoom, setZoom] = useState(1);
  const [comp, setComp] = useState({ w: 1920, h: 1080, fps: 30, bg: "#000000" });
  const [showCompSettings, setShowCompSettings] = useState(false);
  const [showAEPanel, setShowAEPanel] = useState(false);
  const [importedAE, setImportedAE] = useState([]);
  const [history, setHistory] = useState([]);
  const [redo, setRedo] = useState([]);
  const [interact, setInteract] = useState(null);
  const [timelineDrag, setTimelineDrag] = useState(null);
  const [timelineResize, setTimelineResize] = useState(null);
  const [dragStart, setDragStart] = useState({ x: 0, ts: 0, dur: 0 });
  const [renderStatus, setRenderStatus] = useState("idle"); // idle | queued | rendering | done
  const [renderQueue, setRenderQueue] = useState([]);

  const videoRefs = useRef({});
  const stageRef = useRef(null);
  const fileRef = useRef(null);
  const aeFileRef = useRef(null);
  const rafRef = useRef(null);
  const playStartRef = useRef({ wallTime: 0, editTime: 0 });

  // ── History ────────────────────────────────────────────────────────────
  const snap = useCallback(() => {
    setHistory(h => [...h, { clips, graphics }].slice(-40));
    setRedo([]);
  }, [clips, graphics]);

  const undoFn = () => setHistory(h => {
    if (!h.length) return h;
    const prev = h[h.length - 1];
    setRedo(r => [...r, { clips, graphics }]);
    setClips(prev.clips); setGraphics(prev.graphics);
    return h.slice(0, -1);
  });

  const redoFn = () => setRedo(r => {
    if (!r.length) return r;
    const next = r[r.length - 1];
    setHistory(h => [...h, { clips, graphics }]);
    setClips(next.clips); setGraphics(next.graphics);
    return r.slice(0, -1);
  });

  // ── Video Sync ─────────────────────────────────────────────────────────
  useEffect(() => {
    const visibleClips = clips.filter(c => time >= c.ts && time < c.ts + c.dur);
    Object.entries(videoRefs.current || {}).forEach(([id, vid]) => {
      if (!vid) return;
      const clip = visibleClips.find(c => c.id === id);
      if (!clip) {
        try { vid.pause(); } catch {}
        return;
      }
      const ct = Math.max(0, time - clip.ts + clip.startT);
      vid.muted = true;
      vid.playsInline = true;
      if (vid.getAttribute("data-cid") !== clip.id) {
        vid.src = clip.url;
        vid.setAttribute("data-cid", clip.id);
        vid.load();
        const applyTime = () => {
          try { vid.currentTime = ct; } catch {}
          if (playing) vid.play().catch(() => {});
        };
        if (vid.readyState >= 1) applyTime();
        else vid.onloadedmetadata = applyTime;
      } else if (Math.abs((vid.currentTime || 0) - ct) > 0.15) {
        try { vid.currentTime = ct; } catch {}
      }
      if (playing && vid.paused) vid.play().catch(() => {});
      else if (!playing && !vid.paused) vid.pause();
    });
  }, [time, clips, playing]);

  // ── Playback RAF ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) { cancelAnimationFrame(rafRef.current); return; }
    playStartRef.current = { wallTime: performance.now(), editTime: time };
    const tick = () => {
      const elapsed = (performance.now() - playStartRef.current.wallTime) / 1000;
      const t = Math.min(totalDur, playStartRef.current.editTime + elapsed);
      setTime(t);
      if (t >= totalDur) { setPlaying(false); return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  // ── Keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = e => {
      const tag = (e.target && e.target.tagName) ? String(e.target.tagName).toUpperCase() : "";
      if (["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(tag) || e.target?.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redoFn() : undoFn(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); return; }
      if (e.key === " ") { e.preventDefault(); setPlaying(p => !p); }
      if (e.key === "v" || e.key === "V") setTool("select");
      if (e.key === "c" || e.key === "C") setTool("razor");
      if (e.key === "t" || e.key === "T") setTool("text");
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [selGfxId, selClipId, clips, graphics]);

  // ── Canvas Interaction Mouse ────────────────────────────────────────────
  useEffect(() => {
    if (!interact) return;
    const onMove = e => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const item = interact.kind === "clip" ? clips.find(c => c.id === interact.gid) : graphics.find(g => g.id === interact.gid);
      if (!item) return;
      if (interact.mode === "move") {
        const dx = ((e.clientX - interact.px) / rect.width) * 100;
        const dy = ((e.clientY - interact.py) / rect.height) * 100;
        if (interact.kind === "clip") setClips(cs => cs.map(c => c.id === interact.gid ? { ...c, x: clamp(interact.sx + dx, 0, 100), y: clamp(interact.sy + dy, 0, 100) } : c));
        else setGraphics(gs => gs.map(gg => gg.id === interact.gid ? { ...gg, x: clamp(interact.sx + dx, 0, 100), y: clamp(interact.sy + dy, 0, 100) } : gg));
      } else if (interact.mode === "scale") {
        const cx = rect.left + rect.width * (interact.sx / 100);
        const cy = rect.top + rect.height * (interact.sy / 100);
        const d = Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy));
        const ns = clamp(interact.ss * (d / interact.sd), 10, 500);
        if (interact.kind === "clip") setClips(cs => cs.map(c => c.id === interact.gid ? { ...c, scale: ns } : c));
        else setGraphics(gs => gs.map(gg => gg.id === interact.gid ? { ...gg, scale: ns } : gg));
      } else if (interact.mode === "rotate") {
        const cx = rect.left + rect.width * (interact.sx / 100);
        const cy = rect.top + rect.height * (interact.sy / 100);
        const ang = Math.atan2(e.clientY - cy, e.clientX - cx);
        let delta = (ang - interact.sa) * 180 / Math.PI;
        let next = interact.sr + delta;
        while (next > 180) next -= 360;
        while (next < -180) next += 360;
        if (interact.kind === "clip") setClips(cs => cs.map(c => c.id === interact.gid ? { ...c, rotation: next } : c));
        else setGraphics(gs => gs.map(gg => gg.id === interact.gid ? { ...gg, rotation: next } : gg));
      }
    };
    const onUp = () => { snap(); setInteract(null); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [interact, graphics, clips]);

  // ── Timeline Drag/Resize Mouse ──────────────────────────────────────────
  useEffect(() => {
    if (!timelineDrag && !timelineResize) return;
    const onMove = e => {
      const dx = (e.clientX - dragStart.x) / (20 * zoom);
      if (timelineDrag) {
        const ns = Math.max(0, dragStart.ts + dx);
        setClips(cs => cs.map(c => c.id === timelineDrag ? { ...c, ts: ns } : c));
        setGraphics(gs => gs.map(g => g.id === timelineDrag ? { ...g, ts: ns } : g));
      } else if (timelineResize) {
        const { id, side } = timelineResize;
        setClips(cs => cs.map(c => {
          if (c.id !== id) return c;
          if (side === "right") return { ...c, dur: Math.max(0.1, dragStart.dur + dx) };
          const ns = Math.max(0, dragStart.ts + dx);
          return { ...c, ts: ns, dur: Math.max(0.1, dragStart.dur - (ns - dragStart.ts)) };
        }));
        setGraphics(gs => gs.map(g => {
          if (g.id !== id) return g;
          if (side === "right") return { ...g, dur: Math.max(0.1, dragStart.dur + dx) };
          const ns = Math.max(0, dragStart.ts + dx);
          return { ...g, ts: ns, dur: Math.max(0.1, dragStart.dur - (ns - dragStart.ts)) };
        }));
      }
    };
    const onUp = () => {
      snap();
      setTimelineDrag(null); setTimelineResize(null);
      const allItems = [...clips, ...graphics];
      const newTotal = Math.max(0, ...allItems.map(i => i.ts + i.dur));
      setTotalDur(newTotal);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [timelineDrag, timelineResize, dragStart, zoom, clips, graphics]);

  // ── Helpers ────────────────────────────────────────────────────────────
  const beginInteract = useCallback((e, g, mode, kind = "graphic") => {
    e.stopPropagation();
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ct = time - g.ts;
    const sx = lerp(g.kf?.x, ct, g.x);
    const sy = lerp(g.kf?.y, ct, g.y);
    const ss = lerp(g.kf?.scale, ct, g.scale);
    const sr = lerp(g.kf?.rotation, ct, g.rotation ?? 0);
    const cx = rect.left + rect.width * (sx / 100);
    const cy = rect.top + rect.height * (sy / 100);
    const sd = Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy));
    const sa = Math.atan2(e.clientY - cy, e.clientX - cx);
    if (kind === "clip") { setSelClipId(g.id); setSelGfxId(null); }
    else { setSelGfxId(g.id); setSelClipId(null); }
    setInteract({ mode, kind, gid: g.id, px: e.clientX, py: e.clientY, sx, sy, ss, sr, sd, sa });
  }, [time]);

  const handleCanvasDown = e => {
    if (editingGfxId) return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const xp = ((e.clientX - rect.left) / rect.width) * 100;
    const yp = ((e.clientY - rect.top) / rect.height) * 100;

    // hit-test graphics in reverse order
    const hit = [...graphics].reverse().find(g => {
      if (time < g.ts || time >= g.ts + g.dur) return false;
      const ct = time - g.ts;
      const gx = lerp(g.kf?.x, ct, g.x);
      const gy = lerp(g.kf?.y, ct, g.y);
      const gs = lerp(g.kf?.scale, ct, g.scale) / 100;
      const hw = (g.width * gs / rect.width) * 100 / 2;
      const hh = (g.height * gs / rect.height) * 100 / 2;
      return xp >= gx - hw && xp <= gx + hw && yp >= gy - hh && yp <= gy + hh;
    });

    if (hit) {
      setSelGfxId(hit.id); setSelClipId(null);
      if ((hit.type === "text") && e.detail >= 2) { setEditingGfxId(hit.id); return; }
      if (tool === "select") beginInteract(e, hit, "move");
      return;
    }

    if (tool === "text" || tool === "rect" || tool === "circle") {
      if (tool === "text") {
        snap();
        const g = { id: uid(), type: "text", content: "텍스트", ts: time, dur: 5, x: xp, y: yp, width: 280, height: 72, opacity: 1, scale: 100, rotation: 0, color: "#ffffff", fontSize: 36, fontFamily: "Pretendard, 'Noto Sans KR', sans-serif", fontWeight: "700", textAlign: "center", track: 2 };
        setGraphics(gs => [...gs, g]); setSelGfxId(g.id); setTool("select");
      } else if (tool === "rect") {
        snap();
        const g = { id: uid(), type: "rectangle", content: "", ts: time, dur: 5, x: xp, y: yp, width: 200, height: 100, opacity: 1, scale: 100, rotation: 0, color: "#3b82f6", track: 2 };
        setGraphics(gs => [...gs, g]); setSelGfxId(g.id); setTool("select");
      } else if (tool === "circle") {
        snap();
        const g = { id: uid(), type: "circle", content: "", ts: time, dur: 5, x: xp, y: yp, width: 120, height: 120, opacity: 1, scale: 100, rotation: 0, color: "#ec4899", track: 2 };
        setGraphics(gs => [...gs, g]); setSelGfxId(g.id); setTool("select");
      }
      return;
    }

    const clipHit = [...visibleClips].sort((a, b) => b.track - a.track).find(c => {
      const cx = lerp(c.kf?.x, time - c.ts, c.x);
      const cy = lerp(c.kf?.y, time - c.ts, c.y);
      const cs = lerp(c.kf?.scale, time - c.ts, c.scale) / 100;
      const hw = (((c.sourceW || comp.w) / comp.w) * 100 / 2) * cs;
      const hh = (((c.sourceH || comp.h) / comp.h) * 100 / 2) * cs;
      return xp >= cx - hw && xp <= cx + hw && yp >= cy - hh && yp <= cy + hh;
    });
    if (clipHit) {
      setSelClipId(clipHit.id); setSelGfxId(null);
      if (tool === "select") beginInteract(e, clipHit, "move", "clip");
      return;
    }

    setSelGfxId(null); setSelClipId(null);
  };

  const handleFileUpload = async e => {
    const files = Array.from(e.target.files ?? []); if (!files.length) return;
    if (fileRef.current) fileRef.current.value = "";
    const startAt = time;
    const newClips = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = URL.createObjectURL(file);
      const meta = await new Promise(res => {
        const v = document.createElement("video"); v.src = url; v.preload = "metadata";
        v.onloadedmetadata = () => res({ dur: v.duration || 5, w: v.videoWidth || 1920, h: v.videoHeight || 1080 });
        v.onerror = () => res({ dur: 5, w: 1920, h: 1080 });
      });
      const dur = meta.dur;
      if (newClips.length === 0 && clips.length === 0) {
        setComp(c => ({ ...c, w: meta.w, h: meta.h }));
      }
      const occupied = new Set([...clips, ...newClips].filter(c => startAt >= c.ts && startAt < c.ts + c.dur).map(c => c.track));
      let track = 1;
      while (occupied.has(track) && track < 3) track += 1;
      const clip = { id: uid(), file, url, name: file.name, dur, ts: startAt, startT: 0, endT: dur, opacity: 1, scale: 100, x: 50, y: 50, rotation: 0, track, sourceW: meta.w, sourceH: meta.h };
      newClips.push(clip);
    }
    snap();
    setClips(cs => [...cs, ...newClips]);
    const nextTotal = Math.max(totalDur, ...newClips.map(c => c.ts + c.dur));
    setTotalDur(nextTotal);
  };

  const handleAEImport = e => {
    const files = Array.from(e.target.files ?? []); if (!files.length) return;
    if (aeFileRef.current) aeFileRef.current.value = "";
    const newTemplates = files.map(f => ({
      id: uid(), name: f.name, file: f,
      compName: "TopTitle_F_04_AGL & NAVIADs",
      fields: DEFAULT_FIELDS.map(f => ({ ...f }))
    }));
    setImportedAE(ae => [...ae, ...newTemplates]);
  };

  const addAETemplate = (template) => {
    snap();
    const g = {
      id: uid(), type: "ae_template", content: "",
      compName: template.compName, fields: template.fields.map(f => ({ ...f })),
      templateId: template.id, sourceName: template.name,
      ts: time, dur: 5, x: 50, y: 74, width: 800, height: 170,
      opacity: 1, scale: 100, rotation: 0, track: 2,
      fontFamily: "Pretendard, 'Noto Sans KR', sans-serif",
    };
    setGraphics(gs => [...gs, g]);
    setSelGfxId(g.id); setShowAEPanel(false); setTool("select");
  };

  const selGfx = graphics.find(g => g.id === selGfxId);
  const selClip = clips.find(c => c.id === selClipId);
  const visibleClips = clips.filter(c => time >= c.ts && time < c.ts + c.dur).sort((a, b) => a.track - b.track);
  const previewClip = visibleClips[0] ?? (time === 0 ? clips[0] : null);

  const updateGfx = (id, updates) => setGraphics(gs => gs.map(g => g.id === id ? { ...g, ...updates } : g));
  const updateClip = (id, updates) => setClips(cs => cs.map(c => c.id === id ? { ...c, ...updates } : c));
  const updateField = (gid, fid, val) => setGraphics(gs => gs.map(g => g.id === gid ? { ...g, fields: (g.fields || []).map(f => f.id === fid ? { ...f, value: val } : f) } : g));
  const toggleGraphicKeyframe = (graphic, prop) => {
    const localTime = clamp(time - graphic.ts, 0, graphic.dur);
    const currentValue = prop === "opacity" ? graphic.opacity : prop === "rotation" ? (graphic.rotation || 0) : graphic[prop];
    const nextKf = hasKeyframeAt(graphic, prop, localTime) ? removeKeyframe(graphic, prop, localTime) : upsertKeyframe(graphic, prop, localTime, currentValue);
    setGraphics(gs => gs.map(g => g.id === graphic.id ? { ...g, kf: nextKf } : g));
    snap();
  };
  const toggleClipKeyframe = (clip, prop) => {
    const localTime = clamp(time - clip.ts, 0, clip.dur);
    const currentValue = prop === "opacity" ? clip.opacity : prop === "rotation" ? (clip.rotation || 0) : clip[prop];
    const nextKf = hasKeyframeAt(clip, prop, localTime) ? removeKeyframe(clip, prop, localTime) : upsertKeyframe(clip, prop, localTime, currentValue);
    setClips(cs => cs.map(c => c.id === clip.id ? { ...c, kf: nextKf } : c));
    snap();
  };
  const deleteSelected = () => { if (selGfxId) { snap(); setGraphics(gs => gs.filter(g => g.id !== selGfxId)); setSelGfxId(null); } if (selClipId) { snap(); setClips(cs => { const nc = cs.filter(c => c.id !== selClipId); const nd = nc.reduce((m, c) => Math.max(m, c.ts + c.dur), 0); setTotalDur(nd); return nc; }); setSelClipId(null); } };

  const handleRender = () => {
    if (!clips.length) return;
    const job = { id: uid(), name: `render_${Date.now()}.mp4`, status: "queued", progress: 0 };
    setRenderQueue(q => [job, ...q]);
    setRenderStatus("queued");
    // Simulate server render polling
    let prog = 0;
    const iv = setInterval(() => {
      prog += Math.random() * 12 + 3;
      if (prog >= 100) { prog = 100; clearInterval(iv); setRenderQueue(q => q.map(r => r.id === job.id ? { ...r, status: "완료", progress: 100, downloadUrl: "#" } : r)); setRenderStatus("done"); }
      else setRenderQueue(q => q.map(r => r.id === job.id ? { ...r, status: "렌더링 중", progress: Math.floor(prog) } : r));
    }, 600);
  };

  // ── Timeline click ─────────────────────────────────────────────────────
  const handleTimelineClick = e => {
    if (timelineDrag || timelineResize) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = (e.clientX - rect.left) / (20 * zoom);
    setTime(clamp(t, 0, totalDur || 1));
  };

  // ── Split ──────────────────────────────────────────────────────────────
  const handleSplit = (clipId) => {
    const idx = clips.findIndex(c => c.id === clipId); if (idx === -1) return;
    const clip = clips[idx];
    const sp = time - clip.ts;
    if (sp <= 0 || sp >= clip.dur) return;
    snap();
    const a = { ...clip, id: uid(), dur: sp, endT: clip.startT + sp };
    const b = { ...clip, id: uid(), dur: clip.dur - sp, ts: time, startT: clip.startT + sp };
    setClips(cs => { const nc = [...cs]; nc.splice(idx, 1, a, b); return nc; });
  };

  // ── Colors ─────────────────────────────────────────────────────────────
  const BG = "#0a0a0a", PANEL = "#111111", BORDER = "#27272a", ACCENT = "#f97316", ACCENT2 = "#22c55e";
  const txt = c => ({ color: c || "#a1a1aa" });
  const panel = (extra = {}) => ({ background: PANEL, border: `1px solid ${BORDER}`, ...extra });
  const btn = (active, color = ACCENT) => ({
    background: active ? `${color}18` : "transparent", color: active ? color : "#71717a",
    border: `1px solid ${active ? color + "55" : BORDER}`, borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer", fontWeight: 600, transition: "all 0.15s"
  });

  // ── RENDER ─────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw", background: BG, color: "#e4e4e7", fontFamily: "'Inter', 'Noto Sans KR', sans-serif", fontSize: 12, overflow: "hidden", userSelect: "none" }}>

      {/* ── HEADER ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 40, padding: "0 16px", borderBottom: `1px solid ${BORDER}`, background: "#0f0f0f", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <span style={{ fontWeight: 900, fontSize: 14, color: ACCENT, letterSpacing: "-0.04em" }}>VibeEdit</span>
          {["파일", "편집", "시퀀스", "클립", "그래픽"].map(l => (
            <button key={l} style={{ background: "none", border: "none", color: "#71717a", fontSize: 11, cursor: "pointer", padding: "2px 0" }}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setShowCompSettings(true)} style={{ ...btn(false), fontSize: 11 }}>컴포지션 설정</button>
          <button onClick={handleRender} style={{ background: ACCENT, color: "#000", border: "none", borderRadius: 6, padding: "5px 16px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            ▶ Render
          </button>
        </div>
      </div>

      {/* ── MAIN ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── LEFT TOOLBAR ── */}
        <div style={{ width: 44, display: "flex", flexDirection: "column", alignItems: "center", borderRight: `1px solid ${BORDER}`, background: "#0f0f0f", padding: "10px 0", gap: 6, flexShrink: 0 }}>
          {[
            { t: "select", label: "↖", tip: "선택 (V)" },
            { t: "razor", label: "✂", tip: "자르기 (C)" },
            { t: "text", label: "T", tip: "텍스트 (T)" },
            { t: "rect", label: "▬", tip: "사각형" },
            { t: "circle", label: "●", tip: "원" },
          ].map(({ t, label, tip }) => (
            <button key={t} title={tip} onClick={() => setTool(t)}
              style={{ width: 34, height: 34, borderRadius: 6, border: `1px solid ${tool === t ? ACCENT + "88" : BORDER}`, background: tool === t ? ACCENT + "18" : "transparent", color: tool === t ? ACCENT : "#71717a", fontSize: t === "text" ? 14 : 16, cursor: "pointer", fontWeight: 700 }}>
              {label}
            </button>
          ))}
          <div style={{ height: 1, width: 28, background: BORDER, margin: "4px 0" }} />
          <button title="AE 템플릿" onClick={() => setShowAEPanel(v => !v)}
            style={{ width: 34, height: 34, borderRadius: 6, border: `1px solid ${showAEPanel ? ACCENT2 + "88" : BORDER}`, background: showAEPanel ? ACCENT2 + "18" : "transparent", color: showAEPanel ? ACCENT2 : "#71717a", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>
            AE
          </button>
          <button title="삭제 (선택된 항목)" onClick={deleteSelected}
            style={{ width: 34, height: 34, borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: "#71717a", fontSize: 14, cursor: "pointer" }}>
            🗑
          </button>
        </div>

        {/* ── ASSET PANEL ── */}
        <div style={{ width: 220, borderRight: `1px solid ${BORDER}`, background: "#0d0d0d", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
          <div style={{ padding: "10px 12px 6px", borderBottom: `1px solid ${BORDER}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#52525b", textTransform: "uppercase", letterSpacing: "0.1em" }}>프로젝트</div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>

            {/* Video Assets */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: ACCENT, fontWeight: 700, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                <span>📁 원본 푸티지</span>
                <button onClick={() => fileRef.current?.click()} style={{ background: "none", border: "none", color: "#71717a", fontSize: 11, cursor: "pointer" }}>+</button>
              </div>
              {clips.map(c => (
                <div key={c.id} onClick={() => { setSelClipId(c.id); setSelGfxId(null); }}
                  style={{ padding: "4px 8px", borderRadius: 4, marginBottom: 2, background: selClipId === c.id ? ACCENT + "18" : "transparent", color: selClipId === c.id ? ACCENT : "#a1a1aa", cursor: "pointer", fontSize: 11, display: "flex", gap: 6, alignItems: "center" }}>
                  <span>🎬</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{c.name}</span>
                </div>
              ))}
              <button onClick={() => fileRef.current?.click()}
                style={{ width: "100%", padding: "4px 8px", borderRadius: 4, background: "transparent", border: `1px dashed ${BORDER}`, color: "#52525b", fontSize: 11, cursor: "pointer", marginTop: 2 }}>
                + 영상 추가
              </button>
              <input ref={fileRef} type="file" accept="video/*" multiple className="hidden" style={{ display: "none" }} onChange={handleFileUpload} />
            </div>

            <div style={{ height: 1, background: BORDER, margin: "8px 0" }} />

            {/* AE Templates */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: ACCENT2, fontWeight: 700, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                <span>🎨 자막 템플릿</span>
                <button onClick={() => aeFileRef.current?.click()} style={{ background: "none", border: "none", color: "#71717a", fontSize: 11, cursor: "pointer" }}>AEP+</button>
              </div>
              {/* Built-in template */}
              <div onClick={() => { snap(); addAETemplate({ id: "builtin", name: "TopTitle_F_04", compName: "TopTitle_F_04_AGL & NAVIADs", fields: DEFAULT_FIELDS.map(f => ({ ...f })) }); }}
                style={{ padding: "6px 8px", borderRadius: 4, background: "#0a1a0a", border: `1px dashed ${ACCENT2}44`, cursor: "pointer", marginBottom: 4 }}>
                <div style={{ fontSize: 10, color: ACCENT2, fontWeight: 700 }}>TopTitle_F_04</div>
                <div style={{ fontSize: 9, color: "#52525b" }}>AGL &amp; NAVIADs</div>
              </div>
              {importedAE.map(t => (
                <div key={t.id} onClick={() => addAETemplate(t)}
                  style={{ padding: "6px 8px", borderRadius: 4, background: "#0a1a0a", border: `1px dashed ${ACCENT2}44`, cursor: "pointer", marginBottom: 4 }}>
                  <div style={{ fontSize: 10, color: ACCENT2 }}>{t.name}</div>
                  <div style={{ fontSize: 9, color: "#52525b" }}>imported</div>
                </div>
              ))}
              <button onClick={() => aeFileRef.current?.click()}
                style={{ width: "100%", padding: "4px 8px", borderRadius: 4, background: "transparent", border: `1px dashed ${BORDER}`, color: "#52525b", fontSize: 11, cursor: "pointer" }}>
                + AEP 불러오기
              </button>
              <input ref={aeFileRef} type="file" accept=".aep" multiple style={{ display: "none" }} onChange={handleAEImport} />
            </div>

            <div style={{ height: 1, background: BORDER, margin: "8px 0" }} />

            {/* Render Queue */}
            <div>
              <div style={{ fontSize: 10, color: "#38bdf8", fontWeight: 700, marginBottom: 6 }}>🖥 렌더 큐 ({renderQueue.length})</div>
              {renderQueue.length === 0 ? (
                <div style={{ fontSize: 10, color: "#3f3f46", padding: "4px 0" }}>렌더 작업 없음</div>
              ) : renderQueue.slice(0, 4).map(r => (
                <div key={r.id} style={{ marginBottom: 6, padding: "6px 8px", background: "#0a1218", borderRadius: 4, border: `1px solid ${BORDER}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontSize: 10, color: "#e4e4e7", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{r.name}</span>
                    <span style={{ fontSize: 9, color: r.status === "완료" ? ACCENT2 : "#38bdf8", marginLeft: 4 }}>{r.progress}%</span>
                  </div>
                  <div style={{ height: 3, background: "#27272a", borderRadius: 2 }}>
                    <div style={{ height: "100%", width: `${r.progress}%`, background: r.status === "완료" ? ACCENT2 : "#38bdf8", borderRadius: 2, transition: "width 0.3s" }} />
                  </div>
                  {r.downloadUrl && r.status === "완료" && (
                    <a href={r.downloadUrl} style={{ display: "block", marginTop: 4, textAlign: "center", padding: "3px", background: ACCENT2, color: "#000", fontSize: 10, fontWeight: 700, borderRadius: 3, textDecoration: "none" }}>다운로드</a>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── CENTER: PREVIEW + TIMELINE ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

          {/* Preview */}
          <div style={{ flex: "0 0 auto", position: "relative", background: "#050505", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minHeight: 0 }}
            onMouseDown={handleCanvasDown}>
            <div ref={stageRef} style={{ position: "relative", aspectRatio: `${comp.w}/${comp.h}`, background: comp.bg, maxWidth: "100%", maxHeight: "56vh", width: "100%" }}>
              {previewClip ? (
                <>
                  {visibleClips.map(clip => (
                    <video
                      key={clip.id}
                      ref={el => { if (el) videoRefs.current[clip.id] = el; else delete videoRefs.current[clip.id]; }}
                      playsInline
                      muted
                      style={{
                        position: "absolute",
                        left: `${lerp(clip.kf?.x, time - clip.ts, clip.x)}%`,
                        top: `${lerp(clip.kf?.y, time - clip.ts, clip.y)}%`,
                        width: `${((clip.sourceW || comp.w) / comp.w) * 100}%`,
                        height: `${((clip.sourceH || comp.h) / comp.h) * 100}%`,
                        objectFit: "contain",
                        opacity: lerp(clip.kf?.opacity, time - clip.ts, clip.opacity),
                        transform: `translate(-50%,-50%) scale(${lerp(clip.kf?.scale, time - clip.ts, clip.scale) / 100}) rotate(${lerp(clip.kf?.rotation, time - clip.ts, clip.rotation ?? 0)}deg)`,
                        transformOrigin: "center center",
                        pointerEvents: "none",
                        zIndex: clip.track,
                      }}
                    />
                  ))}
                  {selClip && visibleClips.some(c => c.id === selClip.id) && (
                    <div style={{ position: "absolute", left: `${lerp(selClip.kf?.x, time - selClip.ts, selClip.x)}%`, top: `${lerp(selClip.kf?.y, time - selClip.ts, selClip.y)}%`, width: `${((selClip.sourceW || comp.w) / comp.w) * 100 * (lerp(selClip.kf?.scale, time - selClip.ts, selClip.scale) / 100)}%`, height: `${((selClip.sourceH || comp.h) / comp.h) * 100 * (lerp(selClip.kf?.scale, time - selClip.ts, selClip.scale) / 100)}%`, transform: `translate(-50%,-50%) rotate(${lerp(selClip.kf?.rotation, time - selClip.ts, selClip.rotation ?? 0)}deg)`, transformOrigin: "center center", pointerEvents: "none", zIndex: 90, boxSizing: "border-box", border: `1px solid ${ACCENT}`, boxShadow: `0 0 0 1px ${ACCENT}66 inset` }}>
                      <div style={{ position: "absolute", top: 8, left: 8, background: "rgba(249,115,22,0.85)", color: "#000", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4 }}>{selClip.name}</div>
                    </div>
                  )}
                  <div style={{ position: "absolute", inset: 0 }}>
                    {graphics.map(g => (
                      <GraphicEl key={g.id} g={g} time={time}
                        selected={selGfxId === g.id}
                        editing={editingGfxId === g.id}
                        onEdit={() => setEditingGfxId(g.id)}
                        onEndEdit={() => setEditingGfxId(null)}
                        onChange={content => { updateGfx(g.id, { content }); snap(); }}
                      />
                    ))}
                    {selGfx && !editingGfxId && <TransformHandles g={selGfx} time={time} stageRef={stageRef} onBeginInteract={beginInteract} />}
                  </div>
                </>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#27272a" }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>🎬</div>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em" }}>영상을 드래그하거나 추가하세요</div>
                </div>
              )}
              {/* Graphics on empty canvas too */}
              {!previewClip && (
                <div style={{ position: "absolute", inset: 0 }}>
                  {graphics.map(g => (
                    <GraphicEl key={g.id} g={g} time={time}
                      selected={selGfxId === g.id}
                      editing={editingGfxId === g.id}
                      onEdit={() => setEditingGfxId(g.id)}
                      onEndEdit={() => setEditingGfxId(null)}
                      onChange={content => { updateGfx(g.id, { content }); snap(); }}
                    />
                  ))}
                  {selGfx && !editingGfxId && <TransformHandles g={selGfx} time={time} stageRef={stageRef} onBeginInteract={beginInteract} />}
                </div>
              )}
              <div style={{ position: "absolute", inset: 0, border: "2px solid rgba(56,189,248,0.7)", boxSizing: "border-box", pointerEvents: "none" }} />
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(56,189,248,0.22)", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "rgba(56,189,248,0.22)", pointerEvents: "none" }} />
              {/* Overlay info */}
              <div style={{ position: "absolute", top: 8, left: 8, display: "flex", gap: 6, pointerEvents: "none" }}>
                <div style={{ background: "rgba(0,0,0,0.7)", padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 700, color: ACCENT, border: `1px solid ${ACCENT}44` }}>PRV</div>
                <div style={{ background: "rgba(0,0,0,0.7)", padding: "2px 8px", borderRadius: 3, fontSize: 10, color: "#a1a1aa", fontFamily: "monospace" }}>{fmt(time)}</div>
              </div>
              <div style={{ position: "absolute", right: 8, bottom: 8, background: "rgba(0,0,0,0.7)", padding: "2px 8px", borderRadius: 3, fontSize: 10, color: "#7dd3fc", fontFamily: "monospace", pointerEvents: "none" }}>{comp.w} × {comp.h}</div>
            </div>
          </div>

          {/* Playback Controls */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: "8px 0", background: "#080808", borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
            <button onClick={() => { setTime(0); setPlaying(false); }} style={{ background: "none", border: "none", color: "#71717a", fontSize: 16, cursor: "pointer" }}>⏮</button>
            <button onClick={() => setTime(t => Math.max(0, t - 5))} style={{ background: "none", border: "none", color: "#71717a", fontSize: 14, cursor: "pointer" }}>◁◁</button>
            <button onClick={() => setPlaying(p => !p)}
              style={{ width: 40, height: 40, borderRadius: 10, background: ACCENT, border: "none", color: "#000", fontSize: 18, cursor: "pointer", fontWeight: 700 }}>
              {playing ? "⏸" : "▶"}
            </button>
            <button onClick={() => setTime(t => Math.min(totalDur, t + 5))} style={{ background: "none", border: "none", color: "#71717a", fontSize: 14, cursor: "pointer" }}>▷▷</button>
            <button onClick={() => { setTime(totalDur); setPlaying(false); }} style={{ background: "none", border: "none", color: "#71717a", fontSize: 16, cursor: "pointer" }}>⏭</button>
            <div style={{ marginLeft: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "#52525b" }}>Zoom:</span>
              <input type="range" min={0.3} max={5} step={0.1} value={zoom} onChange={e => setZoom(Number(e.target.value))}
                style={{ width: 80, accentColor: ACCENT }} />
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={undoFn} title="Undo (Ctrl+Z)" style={{ background: "none", border: `1px solid ${BORDER}`, color: "#71717a", fontSize: 12, cursor: "pointer", borderRadius: 4, padding: "2px 8px" }}>↩</button>
              <button onClick={redoFn} title="Redo (Ctrl+Shift+Z)" style={{ background: "none", border: `1px solid ${BORDER}`, color: "#71717a", fontSize: 12, cursor: "pointer", borderRadius: 4, padding: "2px 8px" }}>↪</button>
            </div>
          </div>

          {/* Timeline */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
            {/* Track labels */}
            <div style={{ width: 56, background: "#0a0a0a", borderRight: `1px solid ${BORDER}`, flexShrink: 0, paddingTop: 24 }}>
              {["V3", "V2", "V1", "GFX", "A1"].map((l, i) => (
                <div key={l} style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#52525b", fontWeight: 700, borderBottom: l === "V1" || l === "GFX" ? `1px solid ${BORDER}` : "none" }}>
                  {l}
                </div>
              ))}
            </div>

            {/* Timeline scroll area */}
            <div style={{ flex: 1, overflowX: "auto", overflowY: "auto", position: "relative" }}>
              <div
                style={{ position: "relative", minWidth: "100%", width: `${Math.max(600, totalDur * 20 * zoom + 200)}px`, cursor: tool === "razor" ? "crosshair" : "default" }}
                onClick={handleTimelineClick}>
                {/* Ruler */}
                <div style={{ height: 24, background: "#0a0a0a", borderBottom: `1px solid ${BORDER}`, position: "sticky", top: 0, zIndex: 10, display: "flex", alignItems: "flex-end" }}>
                  {Array.from({ length: Math.ceil(totalDur / 1) + 5 }).map((_, i) => (
                    <div key={i} style={{ position: "absolute", left: i * 20 * zoom, fontSize: 9, color: "#3f3f46", paddingBottom: 2, pointerEvents: "none", whiteSpace: "nowrap" }}>
                      {i % Math.max(1, Math.round(5 / zoom)) === 0 ? fmt(i) : ""}
                      <div style={{ width: 1, height: i % Math.max(1, Math.round(5 / zoom)) === 0 ? 8 : 4, background: "#3f3f46", position: "absolute", bottom: 0, left: 0 }} />
                    </div>
                  ))}
                </div>

                {/* Playhead */}
                <div style={{ position: "absolute", top: 0, bottom: 0, left: time * 20 * zoom, width: 2, background: ACCENT, zIndex: 50, pointerEvents: "none" }}>
                  <div style={{ width: 10, height: 10, background: ACCENT, position: "absolute", top: 24, left: -4, transform: "rotate(45deg)" }} />
                </div>

                {/* Tracks */}
                {[3, 2, 1].map(tn => (
                  <div key={tn} style={{ height: 44, background: tn % 2 ? "#080808" : "#0a0a0a", borderBottom: tn === 1 ? `1px solid ${BORDER}` : "none", position: "relative" }}>
                    {clips.filter(c => c.track === tn).map(c => (
                      <div key={c.id}
                        style={{ position: "absolute", top: 4, height: 36, left: c.ts * 20 * zoom, width: Math.max(4, c.dur * 20 * zoom), borderRadius: 4, background: selClipId === c.id ? "#1a1010" : "#181818", border: `2px solid ${selClipId === c.id ? ACCENT : "#3f3f46"}`, cursor: tool === "razor" ? "crosshair" : "move", overflow: "hidden", boxSizing: "border-box" }}
                        onMouseDown={e => {
                          e.stopPropagation();
                          if (tool === "razor") { handleSplit(c.id); return; }
                          snap(); setSelClipId(c.id); setSelGfxId(null);
                          const rect = e.currentTarget.parentElement?.getBoundingClientRect();
                          if (rect) { setTimelineDrag(c.id); setDragStart({ x: e.clientX, ts: c.ts, dur: c.dur }); }
                        }}>
                        {/* resize handles */}
                        <div onMouseDown={e => { e.stopPropagation(); snap(); const rect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect(); if (rect) { setTimelineResize({ id: c.id, side: "left" }); setDragStart({ x: e.clientX, ts: c.ts, dur: c.dur }); } }}
                          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", background: "rgba(249,115,22,0)", zIndex: 5 }} />
                        <div onMouseDown={e => { e.stopPropagation(); snap(); const rect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect(); if (rect) { setTimelineResize({ id: c.id, side: "right" }); setDragStart({ x: e.clientX, ts: c.ts, dur: c.dur }); } }}
                          style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", background: "rgba(249,115,22,0)", zIndex: 5 }} />
                        <div style={{ padding: "2px 8px", fontSize: 10, color: "#a1a1aa", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: "32px" }}>{c.name}</div>
                        {collectKeyframeTimes(c).map((kt, i) => (
                          <div key={i} style={{ position: "absolute", left: Math.max(6, Math.min(c.dur * 20 * zoom - 10, kt * 20 * zoom)), top: 13, width: 8, height: 8, background: ACCENT, transform: "rotate(45deg)", borderRadius: 1, boxShadow: "0 0 0 1px rgba(0,0,0,0.4)" }} />
                        ))}
                      </div>
                    ))}
                  </div>
                ))}

                {/* GFX Track */}
                <div style={{ height: 44, background: "#08100a", borderBottom: `1px solid ${BORDER}`, position: "relative" }}>
                  {graphics.map(g => (
                    <div key={g.id}
                      style={{ position: "absolute", top: 4, height: 36, left: g.ts * 20 * zoom, width: Math.max(4, g.dur * 20 * zoom), borderRadius: 4, background: selGfxId === g.id ? "#0f1a10" : "#0a1208", border: `2px solid ${selGfxId === g.id ? ACCENT2 : ACCENT2 + "44"}`, cursor: "move", overflow: "hidden", boxSizing: "border-box" }}
                      onMouseDown={e => {
                        e.stopPropagation();
                        snap(); setSelGfxId(g.id); setSelClipId(null);
                        const rect = e.currentTarget.parentElement?.getBoundingClientRect();
                        if (rect) { setTimelineDrag(g.id); setDragStart({ x: e.clientX, ts: g.ts, dur: g.dur }); }
                      }}>
                      <div onMouseDown={e => { e.stopPropagation(); snap(); const rect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect(); if (rect) { setTimelineResize({ id: g.id, side: "right" }); setDragStart({ x: e.clientX, ts: g.ts, dur: g.dur }); } }}
                        style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", zIndex: 5 }} />
                      <div style={{ padding: "2px 8px", fontSize: 10, color: ACCENT2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: "32px", display: "flex", alignItems: "center", gap: 4, height: "100%" }}>
                        <span style={{ fontSize: 9 }}>{g.type === "ae_template" ? "🎨" : g.type === "text" ? "T" : "■"}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{g.type === "ae_template" ? g.compName : g.content}</span>
                      </div>
                      {collectKeyframeTimes(g).map((kt, i) => (
                        <div key={i} style={{ position: "absolute", left: Math.max(6, Math.min(g.dur * 20 * zoom - 10, kt * 20 * zoom)), top: 13, width: 8, height: 8, background: ACCENT2, transform: "rotate(45deg)", borderRadius: 1, boxShadow: "0 0 0 1px rgba(0,0,0,0.4)" }} />
                      ))}
                    </div>
                  ))}
                </div>

                {/* Audio track */}
                <div style={{ height: 44, background: "#080a10", position: "relative" }}>
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", paddingLeft: 12, fontSize: 10, color: "#3f3f46" }}>오디오 트랙 (준비 중)</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── RIGHT: EFFECT CONTROLS ── */}
        <div style={{ width: 260, borderLeft: `1px solid ${BORDER}`, background: "#0d0d0d", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
          <div style={{ padding: "10px 12px 6px", borderBottom: `1px solid ${BORDER}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#52525b", textTransform: "uppercase", letterSpacing: "0.1em" }}>효과 컨트롤</div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
            {selGfx ? (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: selGfx.type === "ae_template" ? ACCENT2 : ACCENT, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                  <span>{selGfx.type === "ae_template" ? "🎨" : selGfx.type === "text" ? "T" : "■"}</span>
                  <span>{selGfx.type === "ae_template" ? "AE 템플릿" : selGfx.type === "text" ? "텍스트" : "도형"}</span>
                </div>

                {/* AE Template fields */}
                {selGfx.type === "ae_template" && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>템플릿 입력 필드</div>
                    <div style={{ fontSize: 10, color: "#52525b", marginBottom: 8, padding: "6px 8px", background: "#0a1a0a", borderRadius: 4, border: `1px solid ${ACCENT2}22` }}>
                      {selGfx.compName}
                    </div>
                    {(selGfx.fields || []).map(f => (
                      <div key={f.id} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, color: "#71717a", marginBottom: 3 }}>{f.label}</div>
                        <input
                          type="text" value={f.value}
                          onChange={e => updateField(selGfx.id, f.id, e.target.value)}
                          onBlur={snap}
                          style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#e4e4e7", fontSize: 11, padding: "5px 8px", outline: "none", boxSizing: "border-box" }}
                        />
                      </div>
                    ))}
                    <div style={{ fontSize: 10, color: ACCENT2, fontWeight: 700, marginBottom: 4, marginTop: 8 }}>폰트</div>
                    <select value={selGfx.fontFamily || "sans-serif"} onChange={e => { updateGfx(selGfx.id, { fontFamily: e.target.value }); snap(); }}
                      style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 11, padding: "4px 6px", borderRadius: 4, outline: "none" }}>
                      <option value="Pretendard, 'Noto Sans KR', sans-serif">Pretendard</option>
                      <option value="'Noto Sans KR', 'Malgun Gothic', sans-serif">Noto Sans KR</option>
                      <option value="'Malgun Gothic', sans-serif">맑은 고딕</option>
                      <option value="Arial, sans-serif">Arial</option>
                      <option value="Georgia, serif">Georgia</option>
                    </select>
                    <div style={{ marginTop: 10, padding: "8px", background: "#0a1410", border: `1px solid ${ACCENT2}33`, borderRadius: 6 }}>
                      <div style={{ fontSize: 10, color: ACCENT2, fontWeight: 700, marginBottom: 4 }}>🖥 사내 렌더 요청</div>
                      <button onClick={() => alert("렌더 JSON이 생성되었습니다.\n렌더 서버로 전달하거나 API를 통해 AE 2025가 자동 실행됩니다.")}
                        style={{ width: "100%", padding: "6px", background: ACCENT2, color: "#000", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer", marginBottom: 4 }}>
                        프리뷰 요청
                      </button>
                      <button onClick={() => alert("최종 렌더가 AE 렌더 서버에 큐잉되었습니다.\n완료 후 다운로드 링크가 생성됩니다.")}
                        style={{ width: "100%", padding: "6px", background: "#0a1a0a", color: ACCENT2, border: `1px solid ${ACCENT2}`, borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                        최종 렌더 요청
                      </button>
                    </div>
                  </div>
                )}

                {/* Text content */}
                {selGfx.type === "text" && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>텍스트 내용</div>
                    <input type="text" value={selGfx.content}
                      onChange={e => updateGfx(selGfx.id, { content: e.target.value })}
                      onBlur={snap}
                      style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#e4e4e7", fontSize: 11, padding: "5px 8px", outline: "none", boxSizing: "border-box", marginBottom: 6 }}
                    />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
                      <div>
                        <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>폰트</div>
                        <select value={selGfx.fontFamily || "sans-serif"} onChange={e => { updateGfx(selGfx.id, { fontFamily: e.target.value }); snap(); }}
                          style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 10, padding: "3px 4px", borderRadius: 4, outline: "none" }}>
                          <option value="Pretendard, 'Noto Sans KR', sans-serif">Pretendard</option>
                          <option value="'Noto Sans KR', sans-serif">Noto Sans KR</option>
                          <option value="'Malgun Gothic', sans-serif">맑은 고딕</option>
                          <option value="Arial, sans-serif">Arial</option>
                          <option value="Georgia, serif">Georgia</option>
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>굵기</div>
                        <select value={selGfx.fontWeight || "700"} onChange={e => { updateGfx(selGfx.id, { fontWeight: e.target.value }); snap(); }}
                          style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 10, padding: "3px 4px", borderRadius: 4, outline: "none" }}>
                          <option value="300">Light</option>
                          <option value="400">Regular</option>
                          <option value="500">Medium</option>
                          <option value="600">SemiBold</option>
                          <option value="700">Bold</option>
                          <option value="800">ExtraBold</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                      {["left", "center", "right"].map(a => (
                        <button key={a} onClick={() => { updateGfx(selGfx.id, { textAlign: a }); snap(); }}
                          style={{ flex: 1, padding: "3px", background: (selGfx.textAlign || "center") === a ? ACCENT + "20" : "#18181b", border: `1px solid ${(selGfx.textAlign || "center") === a ? ACCENT : BORDER}`, borderRadius: 4, color: (selGfx.textAlign || "center") === a ? ACCENT : "#71717a", cursor: "pointer", fontSize: 11 }}>
                          {a === "left" ? "⬅" : a === "center" ? "↔" : "➡"}
                        </button>
                      ))}
                    </div>
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>색상</div>
                      <ColorPicker value={selGfx.color} onChange={v => updateGfx(selGfx.id, { color: v })} />
                    </div>
                    <PropRow label="글자 크기" value={selGfx.fontSize || 36} min={8} max={200} step={1} unit="px"
                      onChange={v => updateGfx(selGfx.id, { fontSize: v })} onCommit={snap} />
                    <input type="number" value={selGfx.fontSize || 36} min={8} max={200} step={1}
                      onChange={e => updateGfx(selGfx.id, { fontSize: Math.max(8, Number(e.target.value) || 36) })}
                      onBlur={snap}
                      style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#e4e4e7", fontSize: 11, padding: "5px 8px", outline: "none", boxSizing: "border-box", marginTop: -2, marginBottom: 6 }} />
                  </div>
                )}

                {/* Shape color */}
                {(selGfx.type === "rectangle" || selGfx.type === "circle") && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>도형 설정</div>
                    <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>색상</div>
                    <ColorPicker value={selGfx.color} onChange={v => { updateGfx(selGfx.id, { color: v }); snap(); }} />
                  </div>
                )}

                {/* Transform */}
                <div>
                  <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6, marginTop: 4 }}>변형 (TRANSFORM)</div>
                  <AnimPropRow label="위치 X" value={Math.round(selGfx.x * 10) / 10} min={0} max={100} step={0.1} unit="%"
                    keyframed={hasKeyframeAt(selGfx, "x", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "x")}
                    onChange={v => updateGfx(selGfx.id, { x: v })} onCommit={snap} />
                  <AnimPropRow label="위치 Y" value={Math.round(selGfx.y * 10) / 10} min={0} max={100} step={0.1} unit="%"
                    keyframed={hasKeyframeAt(selGfx, "y", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "y")}
                    onChange={v => updateGfx(selGfx.id, { y: v })} onCommit={snap} />
                  <AnimPropRow label="비율 (Scale)" value={Math.round(selGfx.scale)} min={10} max={500} step={1} unit="%"
                    keyframed={hasKeyframeAt(selGfx, "scale", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "scale")}
                    onChange={v => updateGfx(selGfx.id, { scale: v })} onCommit={snap} />
                  <AnimPropRow label="회전" value={Math.round((selGfx.rotation || 0) * 10) / 10} min={-180} max={180} step={0.1} unit="°"
                    keyframed={hasKeyframeAt(selGfx, "rotation", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "rotation")}
                    onChange={v => updateGfx(selGfx.id, { rotation: v })} onCommit={snap} />
                  <AnimPropRow label="불투명도" value={Math.round(selGfx.opacity * 100)} min={0} max={100} step={1} unit="%"
                    keyframed={hasKeyframeAt(selGfx, "opacity", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "opacity")}
                    onChange={v => updateGfx(selGfx.id, { opacity: v / 100 })} onCommit={snap} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>시작 (초)</div>
                      <input type="number" value={selGfx.ts.toFixed(1)} min={0} step={0.1}
                        onChange={e => updateGfx(selGfx.id, { ts: Math.max(0, Number(e.target.value)) })}
                        onBlur={snap}
                        style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 11, padding: "3px 6px", borderRadius: 4, outline: "none", boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>길이 (초)</div>
                      <input type="number" value={selGfx.dur.toFixed(1)} min={0.1} step={0.1}
                        onChange={e => updateGfx(selGfx.id, { dur: Math.max(0.1, Number(e.target.value)) })}
                        onBlur={snap}
                        style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 11, padding: "3px 6px", borderRadius: 4, outline: "none", boxSizing: "border-box" }} />
                    </div>
                  </div>
                </div>
              </>
            ) : selClip ? (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: ACCENT, marginBottom: 12 }}>🎬 {selClip.name}</div>
                <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>변형 (TRANSFORM)</div>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "#71717a", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>트랙</div>
                  <select value={selClip.track} onChange={e => { updateClip(selClip.id, { track: Number(e.target.value) }); snap(); }} style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 11, padding: "4px 6px", borderRadius: 4, outline: "none" }}>
                    <option value={1}>V1</option><option value={2}>V2</option><option value={3}>V3</option>
                  </select>
                </div>
                <AnimPropRow label="위치 X" value={Math.round(selClip.x * 10) / 10} min={0} max={100} step={0.1} unit="%"
                  keyframed={hasKeyframeAt(selClip, "x", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "x")}
                  onChange={v => updateClip(selClip.id, { x: v })} onCommit={snap} />
                <AnimPropRow label="위치 Y" value={Math.round(selClip.y * 10) / 10} min={0} max={100} step={0.1} unit="%"
                  keyframed={hasKeyframeAt(selClip, "y", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "y")}
                  onChange={v => updateClip(selClip.id, { y: v })} onCommit={snap} />
                <AnimPropRow label="비율 (Scale)" value={Math.round(selClip.scale)} min={10} max={500} step={1} unit="%"
                  keyframed={hasKeyframeAt(selClip, "scale", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "scale")}
                  onChange={v => updateClip(selClip.id, { scale: v })} onCommit={snap} />
                <AnimPropRow label="회전" value={Math.round((selClip.rotation || 0) * 10) / 10} min={-180} max={180} step={0.1} unit="°"
                  keyframed={hasKeyframeAt(selClip, "rotation", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "rotation")}
                  onChange={v => updateClip(selClip.id, { rotation: v })} onCommit={snap} />
                <AnimPropRow label="불투명도" value={Math.round(selClip.opacity * 100)} min={0} max={100} step={1} unit="%"
                  keyframed={hasKeyframeAt(selClip, "opacity", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "opacity")}
                  onChange={v => updateClip(selClip.id, { opacity: v / 100 })} onCommit={snap} />
              </>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 200, opacity: 0.25 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>⚙️</div>
                <div style={{ fontSize: 11, textAlign: "center", lineHeight: 1.5 }}>클립이나 그래픽을<br />선택하세요</div>
              </div>
            )}
          </div>

          {/* Audio Meter */}
          <div style={{ height: 100, borderTop: `1px solid ${BORDER}`, padding: "10px 12px", background: "#080808" }}>
            <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>오디오 미터</div>
            <div style={{ display: "flex", gap: 8, height: 56 }}>
              {[playing ? Math.random() * 60 + 20 : 0, playing ? Math.random() * 50 + 15 : 0].map((h, i) => (
                <div key={i} style={{ flex: 1, background: "#18181b", borderRadius: 2, position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "linear-gradient(to top, #22c55e, #eab308, #ef4444)", height: `${h}%`, transition: "height 0.1s" }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── STATUS BAR ── */}
      <div style={{ height: 24, borderTop: `1px solid ${BORDER}`, background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 12, fontSize: 10, color: "#52525b" }}>
          <span style={{ color: ACCENT, fontWeight: 700 }}>VibeEdit Pro</span>
          <span>컴포지션 {comp.w}×{comp.h} @ {comp.fps}fps</span>
          <span>클립: {clips.length}개</span>
          <span>그래픽: {graphics.length}개</span>
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 10, color: "#52525b" }}>
          <span>{fmt(time)} / {fmt(totalDur)}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: renderStatus === "done" ? ACCENT2 : renderStatus === "rendering" ? "#38bdf8" : renderStatus === "queued" ? ACCENT : "#52525b", display: "inline-block" }} />
            렌더 서버: {renderStatus === "idle" ? "대기" : renderStatus === "queued" ? "큐잉" : renderStatus === "rendering" ? "렌더 중" : "완료"}
          </span>
        </div>
      </div>

      {/* ── COMPOSITION SETTINGS MODAL ── */}
      {showCompSettings && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
          onClick={e => e.target === e.currentTarget && setShowCompSettings(false)}>
          <div style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 12, padding: 24, width: 400, boxShadow: "0 24px 48px rgba(0,0,0,0.5)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>컴포지션 설정</div>
            <div style={{ fontSize: 12, color: "#71717a", marginBottom: 20 }}>작업 화면 해상도와 기본값을 설정합니다</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
              {[["너비", "w", 16, 7680], ["높이", "h", 16, 4320], ["FPS", "fps", 1, 60]].map(([l, k, mn, mx]) => (
                <label key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, color: "#71717a" }}>{l}</span>
                  <input type="number" value={comp[k]} min={mn} max={mx}
                    onChange={e => setComp(c => ({ ...c, [k]: Math.max(mn, Math.min(mx, Number(e.target.value) || c[k])) }))}
                    style={{ background: "#0a0a0a", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 13, padding: "6px 10px", borderRadius: 6, outline: "none" }} />
                </label>
              ))}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "#71717a" }}>배경색</span>
                <input type="color" value={comp.bg} onChange={e => setComp(c => ({ ...c, bg: e.target.value }))}
                  style={{ height: 38, background: "#0a0a0a", border: `1px solid ${BORDER}`, borderRadius: 6, cursor: "pointer", padding: 2 }} />
              </label>
            </div>
            <div style={{ background: "#0a0a0a", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: "#71717a" }}>
              현재: <b style={{ color: "#e4e4e7" }}>{comp.w} × {comp.h}</b> / {comp.fps} FPS · 배경 <b style={{ color: comp.bg }}>{comp.bg}</b>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setShowCompSettings(false)}
                style={{ padding: "8px 16px", background: "transparent", border: `1px solid ${BORDER}`, color: "#a1a1aa", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>
                취소
              </button>
              <button onClick={() => setShowCompSettings(false)}
                style={{ padding: "8px 16px", background: ACCENT, border: "none", color: "#000", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                적용
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── AE TEMPLATE PANEL (float) ── */}
      {showAEPanel && (
        <div style={{ position: "fixed", top: 50, left: 55, width: 320, background: "#111", border: `1px solid ${ACCENT2}55`, borderRadius: 10, padding: 16, zIndex: 150, boxShadow: "0 16px 32px rgba(0,0,0,0.5)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: ACCENT2 }}>🎨 자막 템플릿 라이브러리</div>
            <button onClick={() => setShowAEPanel(false)} style={{ background: "none", border: "none", color: "#71717a", cursor: "pointer", fontSize: 16 }}>✕</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "#52525b", marginBottom: 6 }}>내장 템플릿</div>
            <div
              onClick={() => addAETemplate({ id: "builtin", name: "TopTitle_F_04", compName: "TopTitle_F_04_AGL & NAVIADs", fields: DEFAULT_FIELDS.map(f => ({ ...f })) })}
              style={{ padding: 10, background: "#0a1a0a", border: `1px solid ${ACCENT2}33`, borderRadius: 6, cursor: "pointer", marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: ACCENT2, marginBottom: 4 }}>TopTitle_F_04_AGL &amp; NAVIADs</div>
              {/* Mini SVG preview */}
              <div style={{ width: "100%", height: 60, background: "#000" }}>
                <AETemplateSVG compName="TopTitle_F_04_AGL & NAVIADs" fields={DEFAULT_FIELDS} />
              </div>
              <div style={{ fontSize: 9, color: "#52525b", marginTop: 4 }}>필드: Sub_텍스트 / Main_텍스트 상 / Main_텍스트 하</div>
            </div>
          </div>
          {importedAE.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "#52525b", marginBottom: 6 }}>불러온 템플릿</div>
              {importedAE.map(t => (
                <div key={t.id} onClick={() => addAETemplate(t)}
                  style={{ padding: 10, background: "#0a1a0a", border: `1px solid ${ACCENT2}33`, borderRadius: 6, cursor: "pointer", marginBottom: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: ACCENT2 }}>{t.name}</div>
                  <div style={{ fontSize: 9, color: "#52525b" }}>AE 템플릿 (웹 정의 등록 필요)</div>
                </div>
              ))}
            </div>
          )}
          <button onClick={() => aeFileRef.current?.click()}
            style={{ width: "100%", padding: 8, background: "transparent", border: `1px dashed ${ACCENT2}55`, color: ACCENT2, borderRadius: 6, cursor: "pointer", fontSize: 11, marginTop: 4 }}>
            + AEP 파일 불러오기
          </button>
        </div>
      )}
    </div>
  );
}
