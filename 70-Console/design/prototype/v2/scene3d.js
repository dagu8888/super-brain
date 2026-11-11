/* Super-Brain 协作中枢 v2 · 3D 协作网（three.js r150 本地包，window.THREE）
   中台居中（金），指挥入口内环（洋红），执行者外环（薄荷）；离线=灰暗无光晕。
   连线：粗金管=24h 有消息往来，细青线=仅任务委派/无消息。
   粒子：只在 app.js 收到真实消息/事件时由 pulse() 触发；没有消息画面里就没有光点。 */
(function () {
  "use strict";
  const T = window.THREE;
  if (!T) return;
  const HUB = "__hub__";
  const C = { hub: 0xf5c451, chief: 0xff5fa2, worker: 0x3ee6c1, off: 0x5a6880, cyan: 0x4cc9ff, red: 0xff4d5e, white: 0xffffff };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const big = (n) => (n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 1 : 2) + "万" : String(n));
  const LIVE = { working: "执行中", idle: "在线", offline: "离线", unused: "未接入" };

  let GLOW = null;
  function glowTex() {
    if (GLOW) return GLOW;
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.18, "rgba(255,255,255,.7)");
    r.addColorStop(0.45, "rgba(255,255,255,.18)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    GLOW = new T.CanvasTexture(c);
    return GLOW;
  }
  function sprite(color, scale, opacity) {
    const m = new T.SpriteMaterial({ map: glowTex(), color, transparent: true, opacity, blending: T.AdditiveBlending, depthWrite: false });
    const s = new T.Sprite(m); s.scale.setScalar(scale); return s;
  }
  function labelTex(name, sub, on, font) {
    const c = document.createElement("canvas"); c.width = 512; c.height = 140;
    const g = c.getContext("2d");
    g.textAlign = "center"; g.textBaseline = "middle";
    g.shadowColor = "rgba(0,0,0,.9)"; g.shadowBlur = 12;
    g.font = `600 46px ${font}`; g.fillStyle = on ? "#eef3fb" : "#8794aa"; g.fillText(name, 256, 46);
    g.font = `400 30px ${font}`; g.fillStyle = on ? "#9fb0c8" : "#66738a"; g.fillText(sub, 256, 104);
    const t = new T.CanvasTexture(c); t.anisotropy = 2; return t;
  }
  function badgeTex(text) {
    const c = document.createElement("canvas"); c.width = 192; c.height = 80;
    const g = c.getContext("2d");
    g.font = "700 44px sans-serif"; const w = Math.min(184, g.measureText(text).width + 40);
    g.fillStyle = "#ff4d5e"; g.shadowColor = "rgba(255,77,94,.8)"; g.shadowBlur = 14;
    const x = (192 - w) / 2; g.beginPath(); g.moveTo(x + 30, 10); g.arcTo(x + w, 10, x + w, 70, 30); g.arcTo(x + w, 70, x, 70, 30); g.arcTo(x, 70, x, 10, 30); g.arcTo(x, 10, x + w, 10, 30); g.fill();
    g.shadowBlur = 0; g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 96, 42);
    return new T.CanvasTexture(c);
  }

  function create(box, opts) {
    const font = getComputedStyle(document.body).fontFamily || "sans-serif";
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x000000, 0);
    box.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-label", "3D 协作网拓扑，可拖拽旋转，点节点看详情");
    renderer.domElement.tabIndex = 0;
    const tip = document.createElement("div"); tip.className = "tip3d"; tip.hidden = true; box.appendChild(tip);

    const scene = new T.Scene();
    scene.fog = new T.FogExp2(0x05080e, 0.012);
    const camera = new T.PerspectiveCamera(46, 1, 0.1, 600);
    const cam = { theta: 0.55, phi: 1.12, r: 33, tr: 33, target: new T.Vector3(), tt: new T.Vector3() };
    let lastInteract = 0, sel = null, raf = 0, visible = true;

    /* 环境：星尘（静止）+ 极坐标地网 + 两条轨道环 */
    const world = new T.Group(); scene.add(world);
    {
      const n = 900, pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = 55 + Math.random() * 90, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.cos(ph) * 0.6; pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      }
      const g = new T.BufferGeometry(); g.setAttribute("position", new T.BufferAttribute(pos, 3));
      world.add(new T.Points(g, new T.PointsMaterial({ color: 0x7fa6d9, size: 0.35, transparent: true, opacity: 0.55, depthWrite: false })));
      const gridM = new T.LineBasicMaterial({ color: 0x24406a, transparent: true, opacity: 0.35 });
      for (let r = 4; r <= 24; r += 4) {
        const pts = []; for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; pts.push(new T.Vector3(Math.cos(a) * r, -6, Math.sin(a) * r)); }
        world.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), gridM));
      }
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        world.add(new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(Math.cos(a) * 4, -6, Math.sin(a) * 4), new T.Vector3(Math.cos(a) * 24, -6, Math.sin(a) * 24)]), gridM));
      }
    }
    const orbitM = (c, o) => new T.LineBasicMaterial({ color: c, transparent: true, opacity: o });
    const ringLine = (r, y, m) => { const pts = []; for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new T.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)); } return new T.Line(new T.BufferGeometry().setFromPoints(pts), m); };
    world.add(ringLine(9, 0, orbitM(C.chief, 0.12)));
    world.add(ringLine(15, -1.5, orbitM(C.worker, 0.1)));

    /* 中台 */
    const hub = new T.Group(); world.add(hub);
    const hubCore = new T.Mesh(new T.SphereGeometry(1.5, 48, 32), new T.MeshBasicMaterial({ color: C.hub }));
    const hubShell = new T.Mesh(new T.SphereGeometry(1.95, 32, 24), new T.MeshBasicMaterial({ color: C.hub, wireframe: true, transparent: true, opacity: 0.18 }));
    const hubHalo = sprite(C.hub, 10, 0.55), hubHalo2 = sprite(0xffe7a8, 4.2, 0.9);
    const hubRing = new T.Mesh(new T.TorusGeometry(2.8, 0.03, 8, 96), new T.MeshBasicMaterial({ color: C.hub, transparent: true, opacity: 0.55 }));
    hubRing.rotation.x = Math.PI / 2.3;
    const hubRing2 = new T.Mesh(new T.TorusGeometry(3.4, 0.015, 8, 96), new T.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.35 }));
    hubRing2.rotation.x = Math.PI / 1.8; hubRing2.rotation.y = 0.4;
    hub.add(hubCore, hubShell, hubHalo, hubHalo2, hubRing, hubRing2);
    hubCore.userData.id = HUB;
    const hubLabel = new T.Sprite(new T.SpriteMaterial({ map: labelTex("中台", "消息总线 · 香港", true, font), transparent: true, depthWrite: false }));
    hubLabel.scale.set(6.4, 1.75, 1); hubLabel.position.set(0, 3.6, 0); hub.add(hubLabel);

    const nodesG = new T.Group(); world.add(nodesG);
    const edgesG = new T.Group(); world.add(edgesG);
    const partsG = new T.Group(); world.add(partsG);
    const selRing = sprite(C.hub, 1, 0); world.add(selRing);
    let N = {};            // id -> {group, mesh, halo, hit, curve, edge, data, flash}
    let sig = "";
    const hits = [hubCore];
    let parts = [];

    function disposeObj(o) {
      o.traverse((x) => {
        if (x.geometry) x.geometry.dispose();
        if (x.material) { if (x.material.map && x.material.map !== GLOW) x.material.map.dispose(); x.material.dispose(); }
      });
    }
    function setData(g) {
      const list = g.nodes.filter((n) => n.id !== HUB);
      const s = JSON.stringify(list.map((n) => [n.id, n.label, n.kind, n.live, n.working, n.msgs, n.tasks, n.anomalies && n.anomalies.total]));
      if (s === sig) return; sig = s;
      [nodesG, edgesG].forEach((grp) => { grp.children.slice().forEach((c) => { grp.remove(c); disposeObj(c); }); });
      N = {}; hits.length = 1;
      const chiefs = list.filter((n) => n.kind === "chief"), workers = list.filter((n) => n.kind !== "chief");
      const place = (arr, R, y0, off) => arr.forEach((n, i) => {
        const a = off + (i / Math.max(1, arr.length)) * Math.PI * 2;
        n._p = new T.Vector3(Math.cos(a) * R, y0 + (i % 2 ? 0.9 : -0.9), Math.sin(a) * R);
      });
      place(chiefs, 9, 0, -Math.PI / 2);
      place(workers, 15, -1.5, -Math.PI / 2 + Math.PI / Math.max(1, workers.length));
      list.forEach((n) => {
        const on = n.live === "idle" || n.live === "working";
        const base = n.kind === "chief" ? C.chief : C.worker;
        const col = on ? base : C.off;
        const r = clamp((n.kind === "chief" ? 0.55 : 0.4) + 0.11 * Math.log2(1 + (n.weight || 0)), 0.4, n.kind === "chief" ? 1.25 : 0.95);
        const grp = new T.Group(); grp.position.copy(n._p);
        const mesh = new T.Mesh(new T.SphereGeometry(r, 32, 20), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: on ? 1 : n.live === "unused" ? 0.35 : 0.6, wireframe: n.live === "unused" }));
        grp.add(mesh);
        let halo = null;
        if (on) { halo = sprite(base, r * 6.5, 0.5); grp.add(halo); const core = sprite(0xffffff, r * 1.6, 0.35); grp.add(core); }
        if (n.working) { const ring = new T.Mesh(new T.TorusGeometry(r * 1.9, 0.04, 8, 64), new T.MeshBasicMaterial({ color: C.hub, transparent: true, opacity: 0.9 })); ring.userData.spin = true; grp.add(ring); }
        const lab = new T.Sprite(new T.SpriteMaterial({ map: labelTex(n.label, LIVE[n.live] || n.live, on, font), transparent: true, depthWrite: false, opacity: on ? 1 : 0.75 }));
        lab.scale.set(5.2, 1.42, 1); lab.position.set(0, -r - 1.15, 0); grp.add(lab);
        const an = n.anomalies && n.anomalies.total;
        if (an) { const b = new T.Sprite(new T.SpriteMaterial({ map: badgeTex(big(an)), transparent: true, depthWrite: false, depthTest: false })); b.scale.set(1.6, 0.67, 1); b.position.set(r * 0.9, r + 0.55, 0); b.renderOrder = 5; grp.add(b); }
        const hit = new T.Mesh(new T.SphereGeometry(Math.max(1.1, r * 1.6), 12, 8), new T.MeshBasicMaterial({ visible: false }));
        hit.userData.id = n.id; grp.add(hit); hits.push(hit);
        nodesG.add(grp);
        // 连线：中台 → 节点，向上拱起的二次曲线
        const mid = n._p.clone().multiplyScalar(0.5); mid.y += 2.2 + n._p.length() * 0.08;
        const curve = new T.QuadraticBezierCurve3(new T.Vector3(0, 0, 0), mid, n._p.clone());
        let edge;
        if ((n.msgs || 0) > 0) {
          const rad = clamp(0.035 + 0.02 * Math.log2(1 + n.msgs), 0.04, 0.16);
          edge = new T.Mesh(new T.TubeGeometry(curve, 48, rad, 6, false), new T.MeshBasicMaterial({ color: C.hub, transparent: true, opacity: on ? 0.5 : 0.18, blending: T.AdditiveBlending, depthWrite: false }));
        } else {
          edge = new T.Line(new T.BufferGeometry().setFromPoints(curve.getPoints(48)), new T.LineBasicMaterial({ color: C.cyan, transparent: true, opacity: on ? 0.3 : 0.1 }));
        }
        edge.userData.base = edge.material.opacity;
        edgesG.add(edge);
        N[n.id] = { group: grp, mesh, halo, curve, edge, data: n, flash: 0, r, baseOp: mesh.material.opacity };
      });
      applySel();
      kick();
    }

    /* 选中：其余变暗，相机飞向节点 */
    function applySel() {
      Object.entries(N).forEach(([id, o]) => {
        const dim = sel && sel !== HUB && id !== sel;
        o.mesh.material.opacity = dim ? o.baseOp * 0.25 : o.baseOp;
        if (o.halo) o.halo.material.opacity = dim ? 0.1 : 0.5;
        o.edge.material.opacity = dim ? o.edge.userData.base * 0.2 : sel === id ? Math.min(1, o.edge.userData.base * 1.8) : o.edge.userData.base;
        o.group.children.forEach((c) => { if (c.isSprite && c !== o.halo && c.material.map !== GLOW) c.material.opacity = dim ? 0.3 : 1; });
      });
      if (sel && (N[sel] || sel === HUB)) {
        const p = sel === HUB ? new T.Vector3() : N[sel].group.position;
        cam.tt.copy(p); cam.tr = sel === HUB ? 22 : 15;
        selRing.position.copy(p); selRing.scale.setScalar(sel === HUB ? 8 : N[sel].r * 5); selRing.material.opacity = 0.9;
      } else {
        cam.tt.set(0, 0, 0); cam.tr = 33; selRing.material.opacity = 0;
      }
      kick();
    }

    /* 粒子：头部光点 + 拖尾，沿连线曲线行进 */
    function spawn(id, dir, color, dur, onDone) {
      const o = N[id]; if (!o) { onDone && onDone(); return; }
      const head = sprite(color, 2.4, 1); const trail = [];
      for (let i = 0; i < 8; i++) { const t = sprite(color, 1.9 - i * 0.2, 0.7 - i * 0.075); trail.push(t); partsG.add(t); }
      partsG.add(head);
      parts.push({ id, dir, head, trail, t0: performance.now(), dur, onDone });
      kick();
    }
    function flash(id) { if (id === HUB) hubFlash = performance.now(); else if (N[id]) N[id].flash = performance.now(); kick(); }
    let hubFlash = 0;
    function pulse(from, targets, kind) {
      const color = kind === "ping" ? 0xffdf8a : kind === "alert" ? C.red : kind === "event" ? 0xc8d2ff : 0x8fe3ff;
      const leg2 = () => { flash(HUB); (targets || []).forEach((t) => spawn(t, 1, color, 1100, () => flash(t))); };
      if (opts.reduced) { flash(HUB); if (from) flash(from); (targets || []).forEach(flash); return; }
      if (from && from !== HUB && N[from]) spawn(from, -1, color, 1100, leg2); else leg2();
    }

    /* 交互：拖拽旋转、滚轮/双指缩放、点选、悬停提示 */
    const el = renderer.domElement;
    const ptrs = new Map(); let downAt = null, pinch0 = 0, r0 = 0;
    const ray = new T.Raycaster(); const v2 = new T.Vector2();
    function pick(cx, cy) {
      const rect = el.getBoundingClientRect();
      v2.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(v2, camera);
      const h = ray.intersectObjects(hits, false)[0];
      return h ? h.object.userData.id : null;
    }
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; lastInteract = performance.now();
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); r0 = cam.tr; }
    });
    el.addEventListener("pointermove", (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) { hover(e); return; }
      if (ptrs.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch0) cam.tr = clamp(r0 * (pinch0 / d), 10, 70);
      } else {
        cam.theta -= (e.clientX - p.x) * 0.006; cam.phi = clamp(cam.phi - (e.clientY - p.y) * 0.005, 0.25, 1.48);
        p.x = e.clientX; p.y = e.clientY;
      }
      lastInteract = performance.now(); kick();
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (downAt && ptrs.size === 0 && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6 && performance.now() - downAt.t < 500) {
        const id = pick(e.clientX, e.clientY);
        if (id) { sel = id; applySel(); opts.onSelect && opts.onSelect(id); }
      }
      if (ptrs.size < 2) pinch0 = 0;
      downAt = null;
    };
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", (e) => { e.preventDefault(); cam.tr = clamp(cam.tr * (1 + e.deltaY * 0.0012), 10, 70); lastInteract = performance.now(); kick(); }, { passive: false });
    el.addEventListener("keydown", (e) => {
      const step = { ArrowLeft: [0.12, 0], ArrowRight: [-0.12, 0], ArrowUp: [0, -0.08], ArrowDown: [0, 0.08] }[e.key];
      if (step) { cam.theta += step[0]; cam.phi = clamp(cam.phi + step[1], 0.25, 1.48); e.preventDefault(); kick(); }
      if (e.key === "+" || e.key === "=") { cam.tr = clamp(cam.tr * 0.9, 10, 70); kick(); }
      if (e.key === "-") { cam.tr = clamp(cam.tr * 1.1, 10, 70); kick(); }
    });
    let hoverId = null, hoverT = 0;
    function hover(e) {
      const t = performance.now(); if (t - hoverT < 40) return; hoverT = t;
      const id = pick(e.clientX, e.clientY);
      el.style.cursor = id ? "pointer" : "grab";
      if (id !== hoverId) { hoverId = id; kick(); }
      if (!id) { tip.hidden = true; return; }
      const rect = box.getBoundingClientRect();
      if (id === HUB) tip.innerHTML = "<b>中台</b><span>消息总线 · 点开看队列与连线</span>";
      else {
        const n = N[id].data; const an = n.anomalies || {};
        tip.innerHTML = `<b>${n.label}</b><span>${LIVE[n.live] || n.live} · 24h 消息 ${n.msgs || 0} · 异常 ${big(an.total || 0)}</span>`;
      }
      tip.style.left = e.clientX - rect.left + "px"; tip.style.top = e.clientY - rect.top + "px"; tip.hidden = false;
    }
    el.addEventListener("pointerleave", () => { tip.hidden = true; hoverId = null; });

    /* 渲染循环：页面隐藏或滚出视口时暂停；空闲时只做极慢的相机环绕（减少动效时关闭） */
    function resize() {
      const r = box.getBoundingClientRect(); if (!r.width || !r.height) return;
      renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); kick();
    }
    const ro = new ResizeObserver(resize); ro.observe(box);
    const io = new IntersectionObserver((en) => { visible = en[0].isIntersecting; if (visible) kick(); }); io.observe(box);
    const onVis = () => { if (!document.hidden) kick(); };
    document.addEventListener("visibilitychange", onVis);
    const tmp = new T.Vector3();
    function frame(t) {
      raf = 0;
      if (!visible || document.hidden) return;
      const idle = t - lastInteract > 6000 && !sel && !opts.reduced;
      if (idle) cam.theta += 0.0007;
      const k = opts.reduced ? 1 : 0.08;
      cam.r += (cam.tr - cam.r) * k; cam.target.lerp(cam.tt, k);
      camera.position.set(cam.target.x + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta), cam.target.y + cam.r * Math.cos(cam.phi), cam.target.z + cam.r * Math.sin(cam.phi) * Math.sin(cam.theta));
      camera.lookAt(cam.target);
      // 中台闪光：只在事件到达时
      const hf = hubFlash ? clamp(1 - (t - hubFlash) / 900, 0, 1) : 0;
      hubHalo.scale.setScalar(10 + hf * 6); hubHalo.material.opacity = 0.55 + hf * 0.4;
      Object.entries(N).forEach(([id, o]) => {
        const f = o.flash ? clamp(1 - (t - o.flash) / 900, 0, 1) : 0;
        const hv = hoverId === id ? 1.15 : 1;
        o.mesh.scale.setScalar(hv + f * 0.5);
        if (o.halo) o.halo.scale.setScalar(o.r * 6.5 * (1 + f * 0.8));
        o.group.children.forEach((c) => { if (c.userData.spin && !opts.reduced) c.rotation.z += 0.02; c.isMesh && c.geometry.type === "TorusGeometry" && (c.rotation.x = Math.PI / 2); });
      });
      if (sel) selRing.material.opacity = 0.55 + 0.25 * Math.sin(t / 400);
      // 粒子推进
      parts = parts.filter((p) => {
        const o = N[p.id]; let u = (t - p.t0) / p.dur;
        if (!o || u >= 1) { partsG.remove(p.head); p.trail.forEach((x) => partsG.remove(x)); p.head.material.dispose(); p.trail.forEach((x) => x.material.dispose()); if (o && p.onDone) p.onDone(); else if (!o && p.onDone) p.onDone(); return false; }
        const at = (uu) => o.curve.getPoint(p.dir > 0 ? clamp(uu, 0, 1) : clamp(1 - uu, 0, 1));
        p.head.position.copy(at(u));
        p.trail.forEach((x, i) => x.position.copy(at(u - (i + 1) * 0.03)));
        return true;
      });
      tmp.set(0, 0, 0);
      renderer.render(scene, camera);
      const moving = idle || parts.length || hf > 0 || Math.abs(cam.tr - cam.r) > 0.01 || cam.target.distanceTo(cam.tt) > 0.01 || sel || hoverId || Object.values(N).some((o) => o.flash && t - o.flash < 900 || o.data.working);
      if (moving) kick();
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    resize(); kick();

    return {
      setData,
      pulse,
      select(id) { sel = id; applySel(); },
      reset() { sel = null; applySel(); },
      dispose() {
        cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); document.removeEventListener("visibilitychange", onVis);
        disposeObj(scene); renderer.dispose(); el.remove(); tip.remove();
      },
    };
  }
  window.SB3D = { create };
})();
