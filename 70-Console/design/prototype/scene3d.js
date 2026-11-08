/* Super-Brain 3.0 · 首页 3D 协作网络（WebGL）
   迭代 1：状态分层布局（工作中/空闲/离线）、动态增删、相机自适应、全屏。
   数据来自 DEMO（已由 live.js 换成真实接口数据），本文件只渲染，不取数、不写数。 */
(function () {
  "use strict";
  const T = window.THREE;
  if (!T) return;

  let R = null;
  const TEX = new Map();                 // 贴图缓存：状态|类型|名称
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rgba = (c, a) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;

  const STAFF_ID = "trae-chief";          // 幕僚长（顶层）
  const HUB_ID = "__dispatch__";          // 任务调度中枢（虚拟节点，数据来自 overview）
  const isHub = a => !!a && a.id === HUB_ID;
  const isStaff = a => !!a && a.id === STAFF_ID;
  const accessText = a => (isHub(a) ? "中枢" : (a.everConnected === false ? "未接入" : "已接入"));
  const onlineText = a => {
    if (isHub(a)) return "在线";
    if (a.kind === "chief") return a.status === "offline" ? "久未使用" : "在线";
    return a.status === "offline" ? "离线" : "在线";
  };
  const workText = a => (a.status === "working" ? (isHub(a) ? "调度中" : "工作中")
    : (a.status === "offline" ? "离线" : "空闲"));
  const decideText = a => ((a.pendingDecisions || 0) > 0 ? `待批示 ${a.pendingDecisions}` : "无待批示");
  const roleText = a => (isStaff(a) ? "幕僚长" : (isHub(a) ? "派发与分诊"
    : (a.role || (a.kind === "chief" ? "指挥入口" : "执行者"))));
  const subText = a => [accessText(a), onlineText(a), workText(a), decideText(a)].join(" · ");

  const bucket = a => (a.status === "offline" ? "offline" : (a.status === "working" ? "working" : "idle"));
  const STATUS_LABEL = {
    working: "工作中", idle: "空闲", offline: "离线", collaborating: "协作中",
    waiting: "等待", completed: "已完成", error: "异常",
  };
  const statusLabel = a => (isHub(a) && a.status === "working" ? "调度中"
    : (isStaff(a) ? "幕僚长" : (STATUS_LABEL[a.status] || a.status || "未知")));
  const colorOf = a => (isStaff(a) ? 0xa78bfa
    : isHub(a) ? 0x22d3ee
      : a.status === "offline" ? 0x64748b
        : a.status === "working" ? 0xfbbf24
          : (a.kind === "chief" ? 0x8b5cf6 : 0x2dd4bf));

  function hubAgent(meta) {
    meta = meta || {};
    const pending = meta.pending || 0, doing = meta.doing || 0, dec = meta.pendingDecisions || 0;
    return {
      id: HUB_ID, name: "任务调度", role: "派发与分诊", kind: "dispatch",
      status: doing > 0 ? "working" : "idle",
      currentTask: `待派 ${pending} · 执行中 ${doing}${dec ? ` · 待批示 ${dec}` : ""}`,
      lastActive: "实时", everConnected: true, pendingDecisions: dec,
      queue: { pending, doing },
    };
  }

  function glowTexture(hex, strength) {
    const S = 128, cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const g = cv.getContext("2d");
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, rgba(hex, strength));
    grd.addColorStop(0.35, rgba(hex, strength * 0.45));
    grd.addColorStop(1, rgba(hex, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    const tex = new T.CanvasTexture(cv);
    if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }

  /* 节点贴图：光圈 + 首字母 + 名称（离线灰化并降低对比） */
  function nodeTexture(a, hex, short) {
    const S = 256, cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const g = cv.getContext("2d");
    const alpha = a.status === "offline" ? 0.55 : 1;
    const grd = g.createRadialGradient(S / 2, S / 2, 10, S / 2, S / 2, S / 2);
    grd.addColorStop(0, rgba(hex, 0.34 * alpha));
    grd.addColorStop(0.62, rgba(hex, 0.10 * alpha));
    grd.addColorStop(1, rgba(hex, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    g.beginPath();
    g.arc(S / 2, 116, 62, 0, Math.PI * 2);
    g.fillStyle = rgba(hex, 0.16 * alpha);
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = rgba(hex, 0.95 * alpha);
    g.stroke();
    g.fillStyle = a.status === "offline" ? "rgba(203,213,225,.75)" : "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "600 56px system-ui, -apple-system, 'PingFang SC', sans-serif";
    g.fillText((a.name || "?").trim()[0].toUpperCase(), S / 2, 114);
    if (!short) {
      g.font = "500 23px system-ui, -apple-system, 'PingFang SC', sans-serif";
      g.fillStyle = a.status === "offline" ? "rgba(148,163,184,.5)" : "rgba(255,255,255,.86)";
      const name = a.name.length > 12 ? a.name.slice(0, 12) + "…" : a.name;
      g.fillText(name, S / 2, 204);
      g.font = "400 15px system-ui, -apple-system, 'PingFang SC', sans-serif";
      g.fillStyle = a.status === "offline" ? "rgba(148,163,184,.34)" : "rgba(203,213,225,.62)";
      g.fillText(subText(a), S / 2, 230);
    }
    if ((a.pendingDecisions || 0) > 0) {           // 关键决策待批示：红点角标
      const n = Math.min(99, a.pendingDecisions);
      g.beginPath();
      g.arc(198, 46, 20, 0, Math.PI * 2);
      g.fillStyle = "rgba(239,68,68,.95)";
      g.fill();
      g.fillStyle = "#fff";
      g.font = "700 20px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(n), 198, 47);
    }
    const tex = new T.CanvasTexture(cv);
    if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function texFor(a, short) {
    const key = `${a.status}|${a.kind}|${a.name}|${short ? 1 : 0}|${subText(a)}|${a.pendingDecisions || 0}`;
    let t = TEX.get(key);
    if (!t) { t = nodeTexture(a, colorOf(a), short); TEX.set(key, t); }
    return t;
  }

  function dispose() {
    if (!R) return;
    cancelAnimationFrame(R.raf);
    R.active = false;
    if (R.ro) R.ro.disconnect();
    if (R.onKey) document.removeEventListener("keydown", R.onKey);
    if (R.tip) R.tip.remove();
    if (R.hud) R.hud.remove();
    if (R.particles) { R.particles.geometry.dispose(); R.particles.material.dispose(); }
    R.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach(m => { if (m.map && ![...TEX.values()].includes(m.map)) m.map.dispose(); m.dispose(); });
      }
    });
    R.renderer.dispose();
    R = null;
  }

  function mount(canvas, agents, edges, handlers, meta) {
    if (!canvas || !agents || !agents.length) return false;
    const mobile = matchMedia("(max-width: 720px)").matches;
    const probe = document.createElement("canvas");
    if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) {
      console.warn("当前环境不支持 WebGL，已降级为 2D 网络视图");
      return false;
    }
    dispose();

    const W = () => canvas.clientWidth || 640;
    const H = () => canvas.clientHeight || 460;
    let renderer;
    try {
      renderer = new T.WebGLRenderer({ canvas, antialias: !mobile, alpha: false });
    } catch (e) {
      console.warn("WebGL 初始化失败，已降级为 2D 网络视图：", e && e.message);
      return false;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2));
    renderer.setSize(W(), H(), false);
    renderer.setClearColor(0x05070f, 1);

    const scene = new T.Scene();
    scene.fog = new T.FogExp2(0x05070f, 0.02);
    const camera = new T.PerspectiveCamera(45, W() / H(), 0.1, 300);
    const world = new T.Group();
    scene.add(world);

    /* 星空 */
    const starN = mobile ? 650 : 1400;
    const pos = new Float32Array(starN * 3);
    for (let i = 0; i < starN; i++) {
      const r = 26 + Math.random() * 34, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const starGeo = new T.BufferGeometry();
    starGeo.setAttribute("position", new T.BufferAttribute(pos, 3));
    const stars = new T.Points(starGeo, new T.PointsMaterial({
      size: mobile ? 0.34 : 0.26, map: glowTexture(0xbfd0ff, 0.9), transparent: true,
      opacity: 0.72, depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true,
    }));
    scene.add(stars);

    /* 星云 + 核心光团 */
    [[0x6d28d9, 26, -16, 8], [0x0891b2, 22, -22, -6], [0x1e1b4b, 34, -30, 2]].forEach(([c, s, z, y]) => {
      const sp = new T.Sprite(new T.SpriteMaterial({
        map: glowTexture(c, 0.5), transparent: true, opacity: 0.3,
        depthWrite: false, blending: T.AdditiveBlending,
      }));
      sp.scale.set(s, s, 1);
      sp.position.set(0, y, z);
      scene.add(sp);
    });
    const core = new T.Sprite(new T.SpriteMaterial({
      map: glowTexture(0x818cf8, 0.8), transparent: true, opacity: 0.5,
      depthWrite: false, blending: T.AdditiveBlending,
    }));
    core.scale.set(7, 7, 1);
    world.add(core);

    R = {
      canvas, renderer, scene, camera, world, stars, mobile, handlers: handlers || {},
      nodes: new Map(), edges: [], particles: null, activePts: [],
      fit: 12, zoom: 1, theta: 0.42, phi: 0.18, auto: true,
      dragging: false, moved: false, lastX: 0, lastY: 0, pointers: new Map(), pinch: null,
      raf: 0, last: performance.now(), active: true, w: W(), h: H(),
      mode: "overview", focusId: null, hoverId: null, lookTarget: new T.Vector3(),
      tip: null, hud: null, meta: meta || {},
    };
    mountOverlays(canvas);
    R.reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    R.auto = !R.reduceMotion;
    R.onKey = e => { if (e.key === "Escape" && R && R.mode === "focus") exitFocus(); };
    document.addEventListener("keydown", R.onKey);

    setData(agents, edges, true, meta);
    bindCanvas();
    const ro = new ResizeObserver(() => {
      if (!R) return;
      R.w = W(); R.h = H();
      renderer.setSize(R.w, R.h, false);
      camera.aspect = R.w / R.h;
      camera.updateProjectionMatrix();
      computeFit();
    });
    ro.observe(canvas);
    R.ro = ro;
    computeFit();
    R.lookTarget.set(0, 0, 0);
    start();
    return true;
  }

  /* ---------- 浮层：hover 概况 + 聚焦 HUD ---------- */
  function mountOverlays(canvas) {
    const host = canvas.parentElement;
    const tip = document.createElement("div");
    tip.className = "net-tip";
    tip.hidden = true;
    host.appendChild(tip);
    const hud = document.createElement("div");
    hud.className = "net-hud";
    hud.hidden = true;
    hud.innerHTML = `
      <button class="net-hud-back" type="button">← 返回全景（Esc）</button>
      <div class="net-hud-head">
        <strong class="h-name"></strong>
        <span class="sb-status h-status" data-status="idle"></span>
      </div>
      <div class="net-hud-meta h-meta"></div>
      <div class="net-hud-badge h-badge" hidden></div>
      <div class="net-hud-task"><span class="h-task">暂无任务</span></div>
      <div class="net-hud-bar h-bar" hidden><i></i></div>
      <h4>最近任务</h4>
      <ul class="net-hud-recent h-recent"><li class="h-empty">暂无数据</li></ul>
      <button class="net-hud-more" type="button">查看完整详情</button>`;
    host.appendChild(hud);
    R.tip = tip;
    R.hud = hud;
    hud.querySelector(".net-hud-back").addEventListener("click", () => exitFocus());
    hud.querySelector(".net-hud-more").addEventListener("click", () => {
      if (R.focusId && R.handlers.onMore) R.handlers.onMore(R.focusId);
    });
  }

  function tipHTML(a) {
    const pending = (a.pendingDecisions || 0) > 0
      ? `<div class="net-tip-badge">关键决策待批示 ${a.pendingDecisions} 项</div>` : "";
    return `<div class="net-tip-title"><i style="background:#${colorOf(a).toString(16).padStart(6, "0")}"></i>
      <strong>${a.name}</strong><span>${statusLabel(a)}</span></div>
      <div class="net-tip-meta">${roleText(a)} · ${accessText(a)} · ${onlineText(a)} · ${workText(a)}</div>
      ${pending}
      <div class="net-tip-task">${a.currentTask || "当前无任务"}</div>
      <div class="net-tip-hint">最近活动：${a.lastActive || "—"} · 点击进入场景</div>`;
  }

  function showTip(agent, ev) {
    if (!R || !R.tip) return;
    const host = R.canvas.parentElement;
    const rect = host.getBoundingClientRect();
    R.tip.innerHTML = tipHTML(agent);
    R.tip.hidden = false;
    const x = Math.max(8, Math.min(rect.width - R.tip.offsetWidth - 10, ev.clientX - rect.left + 16));
    const y = Math.max(8, Math.min(rect.height - R.tip.offsetHeight - 10, ev.clientY - rect.top + 16));
    R.tip.style.left = x + "px";
    R.tip.style.top = y + "px";
  }

  function hideTip() {
    if (R && R.tip) R.tip.hidden = true;
    if (R) R.hoverId = null;
  }

  function showHUD(agent) {
    if (!R || !R.hud) return;
    const hud = R.hud;
    hud.hidden = false;
    hud.querySelector(".h-name").textContent = agent.name;
    const st = hud.querySelector(".h-status");
    st.textContent = statusLabel(agent);
    st.dataset.status = agent.status;
    hud.querySelector(".h-meta").textContent =
      `${roleText(agent)} · ${accessText(agent)} · ${onlineText(agent)} · ${workText(agent)}`;
    const badge = hud.querySelector(".h-badge");
    if (badge) {
      const dec = agent.pendingDecisions || 0;
      badge.hidden = dec <= 0;
      badge.textContent = dec > 0 ? `关键决策待批示 ${dec} 项` : "";
    }
    const task = agent.currentTask || "暂无任务";
    hud.querySelector(".h-task").textContent = task;
    const pct = /(\d{1,3})\s*%/.exec(task);
    const bar = hud.querySelector(".h-bar");
    if (pct && +pct[1] <= 100) {
      bar.hidden = false;
      bar.querySelector("i").style.width = pct[1] + "%";
    } else {
      bar.hidden = true;
    }
    const more = hud.querySelector(".net-hud-more");
    if (more) more.hidden = isHub(agent);
    const ul = hud.querySelector(".h-recent");
    if (isHub(agent)) {
      ul.innerHTML = '<li class="h-empty">调度中枢无个人任务</li>';
    } else {
      ul.innerHTML = '<li class="h-empty">加载中…</li>';
      loadRecent(agent.id, ul);
    }
  }

  async function loadRecent(id, ul) {
    let d = null;
    try {
      if (window.SB && SB.api) d = (await SB.api("/api/agents/" + encodeURIComponent(id))).data;
    } catch (e) { d = null; }
    if (!R || !ul.isConnected) return;
    const list = (d && d.recent_tasks) || [];
    if (!list.length) { ul.innerHTML = '<li class="h-empty">暂无数据</li>'; return; }
    const LBL = { done: "完成", doing: "进行中", pending: "待处理", failed: "失败", dead: "死信", cancelled: "取消" };
    ul.innerHTML = list.slice(0, 5).map(t =>
      `<li><span>#${t.id}</span><b>${t.type || "任务"}</b><em data-s="${t.status}">${LBL[t.status] || t.status}</em></li>`
    ).join("");
  }

  function focusAgent(id) {
    if (!R) return;
    const n = R.nodes.get(id);
    if (!n) return;
    R.mode = "focus";
    R.focusId = id;
    R.auto = false;
    hideTip();
    applyEmphasis();
    showHUD(n.agent);
  }

  function exitFocus() {
    if (!R || R.mode !== "focus") return;
    R.mode = "overview";
    R.focusId = null;
    R.auto = true;
    R.zoom = 1;
    if (R.hud) R.hud.hidden = true;
    applyEmphasis();
  }

  function applyEmphasis() {
    if (!R) return;
    const fid = R.mode === "focus" ? R.focusId : null;
    const related = new Set();
    if (fid) {
      related.add(fid);
      R.edges.forEach(e => {
        if (e.from === fid) related.add(e.to);
        if (e.to === fid) related.add(e.from);
      });
    }
    R.nodes.forEach(n => {
      if (n.removing) { n.topacity = 0; return; }
      const base = n.baseOpacity ?? 1;
      const s = n.baseScale ?? n.tscale;
      if (!fid) { n.topacity = base; n.tscale = s; return; }
      if (n.agent.id === fid) { n.topacity = 1; n.tscale = s * 1.28; }
      else if (related.has(n.agent.id) && base > 0.2) { n.topacity = Math.max(base, 0.5); n.tscale = s; }
      else { n.topacity = 0.1; n.tscale = s * 0.95; }
    });
    R.edges.forEach(e => {
      const on = !fid || e.from === fid || e.to === fid;
      e.line.material.opacity = !fid ? e.base : (on ? Math.max(e.base, 0.55) : e.base * 0.18);
    });
  }

  /* ---------- 数据 → 场景（diff，不重建、不重置视角） ---------- */
  function setData(agents, edges, initial, meta) {
    if (!R) return;
    if (meta) R.meta = meta;
    const merged = agents.filter(a => a.id !== HUB_ID);
    merged.push(hubAgent(R.meta));                 // 调度中枢随队列数据实时更新
    const alive = new Set(merged.map(a => a.id));
    const fresh = [];
    merged.forEach(a => {
      let n = R.nodes.get(a.id);
      if (!n) {
        const mat = new T.SpriteMaterial({ map: texFor(a, R.mobile), transparent: true, opacity: 0, depthWrite: false });
        const sp = new T.Sprite(mat);
        sp.scale.set(0.1, 0.1, 1);
        sp.position.set(0, 0, 0);
        sp.userData.agent = a.id;
        R.world.add(sp);
        n = { agent: a, sprite: sp, texKey: "", tpos: new T.Vector3(), tscale: 2.3, topacity: 1, removing: false };
        R.nodes.set(a.id, n);
        fresh.push(n);
      }
      n.removing = false;
      n.agent = a;
      const key = `${a.status}|${a.kind}|${a.name}|${subText(a)}|${a.pendingDecisions || 0}`;
      if (n.texKey !== key) {
        n.texKey = key;
        n.sprite.material.map = texFor(a, R.mobile);
        n.sprite.material.needsUpdate = true;
      }
    });
    R.nodes.forEach((n, id) => { if (!alive.has(id)) n.removing = true; });
    layout();
    // 新节点直接落到目标位置后淡入，避免从中心飞出
    fresh.forEach(n => {
      n.sprite.position.copy(n.tpos);
      n.sprite.scale.set(n.tscale, n.tscale, 1);
      n.sprite.material.opacity = 0;
    });
    if (initial) {
      R.nodes.forEach(n => { n.sprite.material.opacity = n.topacity; });
      computeFit();
      snapCamera();
    }
    rebuildEdges(edges || []);
    computeFit();
    if (R.mode === "focus" && R.focusId) {
      const n = R.nodes.get(R.focusId);
      if (n && !n.removing) refreshHUD(n.agent);
      else exitFocus();
    }
  }

  function refreshHUD(agent) {
    if (!R || !R.hud) return;
    R.hud.querySelector(".h-name").textContent = agent.name;
    const st = R.hud.querySelector(".h-status");
    st.textContent = statusLabel(agent);
    st.dataset.status = agent.status;
    R.hud.querySelector(".h-meta").textContent =
      `${roleText(agent)} · ${accessText(agent)} · ${onlineText(agent)} · ${workText(agent)}`;
    const badge = R.hud.querySelector(".h-badge");
    if (badge) {
      const dec = agent.pendingDecisions || 0;
      badge.hidden = dec <= 0;
      badge.textContent = dec > 0 ? `关键决策待批示 ${dec} 项` : "";
    }
    const task = agent.currentTask || "暂无任务";
    R.hud.querySelector(".h-task").textContent = task;
    const pct = /(\d{1,3})\s*%/.exec(task);
    const bar = R.hud.querySelector(".h-bar");
    if (pct && +pct[1] <= 100) {
      bar.hidden = false;
      bar.querySelector("i").style.width = pct[1] + "%";
    } else {
      bar.hidden = true;
    }
  }

  function snapCamera() {
    if (!R) return;
    const d = R.fit * R.zoom;
    R.camera.position.set(
      Math.cos(R.phi) * Math.sin(R.theta) * d,
      Math.sin(R.phi) * d + d * 0.1,
      Math.cos(R.phi) * Math.cos(R.theta) * d
    );
    R.camera.lookAt(0, 0, 0);
  }

  function layout() {
    if (!R) return;
    const pin = (id, x, y, z, scale, opacity) => {
      const n = R.nodes.get(id);
      if (!n || n.removing) return;
      n.tpos.set(x, y, z);
      n.baseScale = scale; n.baseOpacity = opacity;
      n.tscale = scale; n.topacity = opacity;
    };
    pin(STAFF_ID, 0, 5.5, 0, 3.9, 1);        // 顶层：幕僚长
    pin(HUB_ID, 0, 0.9, 0, 3.2, 0.96);       // 中层：任务调度中枢

    const groups = { working: [], idle: [], offline: [] };
    R.nodes.forEach(n => {
      if (n.removing || n.agent.id === STAFF_ID || n.agent.id === HUB_ID) return;
      groups[bucket(n.agent)].push(n);
    });
    // 工作 → 内圈居中；空闲 → 中环淡化；离线 → 外缘近乎隐去
    const order = [...groups.working, ...groups.idle, ...groups.offline];
    order.forEach((node, i) => {
      const total = Math.max(1, order.length);
      const ang = (i / total) * Math.PI * 2 - Math.PI / 2;
      const b = bucket(node.agent);
      const r = b === "working" ? 3.6 : b === "idle" ? 5.9 : 8.4;
      const y = -4.9 + (b === "offline" ? -0.45 : 0) + Math.cos(ang * 2) * 0.18;
      node.tpos.set(Math.cos(ang) * r, y, Math.sin(ang) * r);
      const chiefF = node.agent.kind === "chief" ? 1.05 : 1;
      node.baseScale = (b === "working" ? 2.7 : b === "idle" ? 2.35 : 1.95) * chiefF;
      node.baseOpacity = b === "working" ? 1 : b === "idle" ? 0.5 : 0.1;
      node.tscale = node.baseScale;
      node.topacity = node.baseOpacity;
    });
    applyEmphasis();
  }

  function rebuildEdges(edges) {
    if (!R) return;
    R.edges.forEach(e => { R.world.remove(e.line); e.line.geometry.dispose(); e.line.material.dispose(); });
    R.edges = [];
    R.activePts = [];
    const list = edges.filter(e => e.evidence !== "default_route");   // 默认路由由中枢连线表达
    const hubN = R.nodes.get(HUB_ID), staffN = R.nodes.get(STAFF_ID);
    if (staffN && hubN && !staffN.removing && !hubN.removing) {
      list.push({ from: STAFF_ID, to: HUB_ID, structural: true,
        state: hubN.agent.status === "working" ? "active" : "idle" });
    }
    if (hubN && !hubN.removing) {
      R.nodes.forEach(n => {
        if (n.removing || n.agent.id === HUB_ID || n.agent.id === STAFF_ID) return;
        list.push({ from: HUB_ID, to: n.agent.id, structural: true,
          state: bucket(n.agent) === "working" ? "active" : "idle" });
      });
    }
    list.forEach(e => {
      const a = R.nodes.get(e.from), b = R.nodes.get(e.to);
      if (!a || !b) return;
      const active = e.state === "active";
      const structural = !!e.structural;
      const geo = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
      const mat = new T.LineBasicMaterial({
        color: active ? (structural ? 0x22d3ee : 0x8b5cf6) : 0x475569, transparent: true,
        opacity: active ? (structural ? 0.5 : 0.8) : (structural ? 0.06 : 0.14),
        depthWrite: false,
      });
      const line = new T.Line(geo, mat);
      R.world.add(line);
      R.edges.push({ line, from: e.from, to: e.to, active, structural, base: mat.opacity });
      if (active) R.activePts.push({ from: e.from, to: e.to, t: Math.random() });
    });
    if (R.particles) {
      R.world.remove(R.particles);
      R.particles.geometry.dispose();
      R.particles.material.dispose();
      R.particles = null;
    }
    if (R.activePts.length) {
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(new Float32Array(R.activePts.length * 3), 3));
      const m = new T.PointsMaterial({
        size: 0.38, map: glowTexture(0xc4b5fd, 1), transparent: true, opacity: 0.95,
        depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true,
      });
      R.particles = new T.Points(g, m);
      R.world.add(R.particles);
    }
    applyEmphasis();
  }

  function computeFit() {
    if (!R) return;
    let max = 3.2;
    R.nodes.forEach(n => {
      if (n.removing) return;
      max = Math.max(max, Math.hypot(n.tpos.x, n.tpos.y, n.tpos.z) + 1.6);
    });
    const vFov = 45 * Math.PI / 180;
    const aspect = Math.max(0.4, R.w / R.h);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    R.fit = Math.max(max / Math.tan(vFov / 2), max / Math.tan(hFov / 2)) * 1.02;
  }

  /* ---------- 交互 ---------- */
  function bindCanvas() {
    const canvas = R.canvas;
    canvas.addEventListener("pointerdown", ev => {
      hideTip();
      canvas.setPointerCapture(ev.pointerId);
      R.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (R.pointers.size === 2) {
        const [a, b] = [...R.pointers.values()];
        R.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: R.zoom };
      }
      R.dragging = true;
      R.moved = false;
      R.lastX = ev.clientX;
      R.lastY = ev.clientY;
      canvas.style.cursor = "grabbing";
    });
    canvas.addEventListener("pointermove", ev => {
      if (R.pointers.has(ev.pointerId)) R.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (R.pointers.size === 2 && R.pinch) {
        const [a, b] = [...R.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        R.zoom = clamp(R.pinch.z * (R.pinch.d / Math.max(20, d)), 0.55, 2.2);
        R.moved = true;
        return;
      }
      if (!R.dragging) {
        if (ev.pointerType === "mouse" && R.mode === "overview" && performance.now() - (R.hoverAt || 0) > 60) {
          R.hoverAt = performance.now();
          const id = pick(ev);
          if (id !== R.hoverId) R.hoverId = id;
          if (id) {
            const n = R.nodes.get(id);
            if (n) showTip(n.agent, ev);
            canvas.style.cursor = "pointer";
          } else {
            hideTip();
            canvas.style.cursor = "grab";
          }
        }
        return;
      }
      const dx = ev.clientX - R.lastX, dy = ev.clientY - R.lastY;
      R.lastX = ev.clientX;
      R.lastY = ev.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) R.moved = true;
      R.theta -= dx * 0.005;
      R.phi = clamp(R.phi + dy * 0.004, -0.8, 0.8);
    });
    const end = ev => {
      R.pointers.delete(ev.pointerId);
      if (R.pointers.size < 2) R.pinch = null;
      const was = R.dragging;
      R.dragging = false;
      canvas.style.cursor = "grab";
      if (was && !R.moved && ev.type === "pointerup") {
        const hit = pick(ev);
        if (hit) focusAgent(hit);
        else if (R.mode === "focus") exitFocus();
      }
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => { canvas.style.cursor = "grab"; hideTip(); });
    canvas.addEventListener("wheel", ev => {
      ev.preventDefault();
      R.zoom = clamp(R.zoom * (ev.deltaY > 0 ? 1.1 : 0.9), 0.55, 2.2);
    }, { passive: false });
  }

  function pick(ev) {
    if (!R) return null;
    const rect = R.canvas.getBoundingClientRect();
    const rc = new T.Raycaster();
    rc.setFromCamera(new T.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    ), R.camera);
    const sprites = [];
    R.nodes.forEach(n => { if (!n.removing) sprites.push(n.sprite); });
    const hit = rc.intersectObjects(sprites, false)[0];
    return hit ? hit.object.userData.agent : null;
  }

  /* ---------- 帧循环 ---------- */
  function start() {
    const tick = now => {
      if (!R || !R.active) return;
      R.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - R.last) / 1000) || 0.016;
      R.last = now;

      if (R.auto && !R.dragging && R.mode === "overview") R.theta += dt * 0.02;
      const d = R.fit * R.zoom;
      let goal, look = new T.Vector3(0, 0, 0);
      if (R.mode === "focus" && R.nodes.get(R.focusId)) {
        const p = R.nodes.get(R.focusId).sprite.position;
        const fd = 2.9 * R.zoom;
        goal = p.clone().add(new T.Vector3(
          Math.cos(R.phi) * Math.sin(R.theta) * fd,
          Math.sin(R.phi) * fd + 0.9,
          Math.cos(R.phi) * Math.cos(R.theta) * fd
        ));
        look.copy(p);
      } else {
        goal = new T.Vector3(
          Math.cos(R.phi) * Math.sin(R.theta) * d,
          Math.sin(R.phi) * d + d * 0.1,
          Math.cos(R.phi) * Math.cos(R.theta) * d
        );
      }
      R.camera.position.lerp(goal, 1 - Math.exp(-dt * 4.5));
      R.lookTarget.lerp(look, 1 - Math.exp(-dt * 6));
      R.camera.lookAt(R.lookTarget);

      const k = 1 - Math.exp(-dt * 6);
      R.nodes.forEach((n, id) => {
        n.sprite.position.lerp(n.tpos, k);
        const s = n.sprite.scale.x + (n.tscale - n.sprite.scale.x) * k;
        n.sprite.scale.set(s, s, 1);
        n.sprite.material.opacity += (n.topacity - n.sprite.material.opacity) * k;
        if (n.removing && n.sprite.material.opacity < 0.02) {
          R.world.remove(n.sprite);
          n.sprite.material.dispose();
          n.sprite.geometry && n.sprite.geometry.dispose();
          R.nodes.delete(id);
        }
      });

      R.edges.forEach(e => {
        const a = R.nodes.get(e.from), b = R.nodes.get(e.to);
        if (!a || !b || a.removing || b.removing || bucket(a.agent) === "offline" || bucket(b.agent) === "offline") {
          e.line.visible = false;
          return;
        }
        e.line.visible = true;
        const arr = e.line.geometry.attributes.position.array;
        arr[0] = a.sprite.position.x; arr[1] = a.sprite.position.y; arr[2] = a.sprite.position.z;
        arr[3] = b.sprite.position.x; arr[4] = b.sprite.position.y; arr[5] = b.sprite.position.z;
        e.line.geometry.attributes.position.needsUpdate = true;
      });

      if (R.particles) {
        const arr = R.particles.geometry.attributes.position.array;
        R.activePts.forEach((p, i) => {
          const a = R.nodes.get(p.from), b = R.nodes.get(p.to);
          if (!a || !b) return;
          p.t = (p.t + dt * 0.28) % 1;
          arr[i * 3] = a.sprite.position.x + (b.sprite.position.x - a.sprite.position.x) * p.t;
          arr[i * 3 + 1] = a.sprite.position.y + (b.sprite.position.y - a.sprite.position.y) * p.t;
          arr[i * 3 + 2] = a.sprite.position.z + (b.sprite.position.z - a.sprite.position.z) * p.t;
        });
        R.particles.geometry.attributes.position.needsUpdate = true;
      }

      R.stars.rotation.y += dt * 0.004;
      R.renderer.render(R.scene, R.camera);
    };
    R.tick = tick;
    R.raf = requestAnimationFrame(tick);
  }

  function pause() { if (R) { R.active = false; cancelAnimationFrame(R.raf); } }
  function resume() {
    if (!R || R.active) return;
    R.active = true;
    R.last = performance.now();
    R.raf = requestAnimationFrame(R.tick);
  }
  function zoom(f) { if (R) R.zoom = clamp(R.zoom * f, 0.55, 2.2); }
  function reset() { if (R) { R.zoom = 1; R.theta = 0.42; R.phi = 0.18; } }
  function resize() {
    if (!R) return;
    R.w = R.canvas.clientWidth || R.w;
    R.h = R.canvas.clientHeight || R.h;
    R.renderer.setSize(R.w, R.h, false);
    R.camera.aspect = R.w / R.h;
    R.camera.updateProjectionMatrix();
    computeFit();
  }

  window.SB3D = {
    mount, pause, resume, zoom, reset, resize, focus: focusAgent, exitFocus,
    update: (agents, edges, meta) => setData(agents, edges, false, meta),
    select: () => {},
  };
})();
