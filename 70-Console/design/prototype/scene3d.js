/* Super-Brain 3.0 · 首页 3D 协作网络（WebGL）
   纯前端渲染：星云背景 + 球面分布节点 + 预生成通道线 + 空闲自转 + 拖拽/缩放/点击。
   数据全部来自 DEMO（已由 live.js 换成真实接口数据），本文件不取数、不写数。 */
(function () {
  "use strict";
  const T = window.THREE;
  if (!T) return;

  let R = null;                       // 当前运行实例
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rgba = (c, a) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;

  function colorOf(agent) {
    if (agent.status === "working") return 0xfbbf24;
    if (agent.status === "offline") return 0x6b7280;
    return agent.kind === "chief" ? 0x8b5cf6 : 0x2dd4bf;
  }

  /* 光晕贴图（径向渐变） */
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
    return new T.CanvasTexture(cv);
  }

  /* 节点贴图：光圈 + 首字母 + 名称 */
  function nodeTexture(agent, hex) {
    const S = 256, cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const g = cv.getContext("2d");
    const grd = g.createRadialGradient(S / 2, S / 2, 10, S / 2, S / 2, S / 2);
    grd.addColorStop(0, rgba(hex, 0.34));
    grd.addColorStop(0.62, rgba(hex, 0.10));
    grd.addColorStop(1, rgba(hex, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    g.beginPath();
    g.arc(S / 2, 116, 64, 0, Math.PI * 2);
    g.fillStyle = rgba(hex, 0.16);
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = rgba(hex, 0.95);
    g.stroke();
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "600 56px system-ui, -apple-system, 'PingFang SC', sans-serif";
    g.fillText((agent.name || "?").trim()[0].toUpperCase(), S / 2, 114);
    g.font = "500 24px system-ui, -apple-system, 'PingFang SC', sans-serif";
    g.fillStyle = "rgba(255,255,255,.86)";
    const name = agent.name.length > 12 ? agent.name.slice(0, 12) + "…" : agent.name;
    g.fillText(name, S / 2, 210);
    return new T.CanvasTexture(cv);
  }

  function dispose() {
    if (!R) return;
    cancelAnimationFrame(R.raf);
    R.active = false;
    if (R.ro) R.ro.disconnect();
    R.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
      }
    });
    R.renderer.dispose();
    R = null;
  }

  function mount(canvas, agents, edges, handlers) {
    if (!canvas || !agents || !agents.length) return false;
    dispose();
    const mobile = matchMedia("(max-width: 720px)").matches;
    const W = () => canvas.clientWidth || 640;
    const H = () => canvas.clientHeight || 460;

    // 先探测 WebGL，避免无 GPU 环境抛错（此时静默降级 2D）
    const probe = document.createElement("canvas");
    if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) {
      console.warn("当前环境不支持 WebGL，已降级为 2D 网络视图");
      return false;
    }

    const renderer = (() => {
      try {
        const r = new T.WebGLRenderer({ canvas, antialias: !mobile, alpha: false });
        r.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2));
        r.setSize(W(), H(), false);
        r.setClearColor(0x05070f, 1);
        return r;
      } catch (e) {
        console.warn("WebGL 不可用，已降级为 2D 网络视图：", e && e.message);
        return null;
      }
    })();
    if (!renderer) return false;

    const scene = new T.Scene();
    scene.fog = new T.FogExp2(0x05070f, 0.022);
    const camera = new T.PerspectiveCamera(45, W() / H(), 0.1, 200);
    const dist0 = mobile ? 13 : 10.5;
    camera.position.set(0, 1.8, dist0);
    camera.lookAt(0, 0, 0);

    const world = new T.Group();
    scene.add(world);

    /* 星空 */
    const starN = mobile ? 650 : 1400;
    const starPos = new Float32Array(starN * 3);
    for (let i = 0; i < starN; i++) {
      const r = 26 + Math.random() * 34;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      starPos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
      starPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const starGeo = new T.BufferGeometry();
    starGeo.setAttribute("position", new T.BufferAttribute(starPos, 3));
    const starTex = glowTexture(0xbfd0ff, 0.9);
    const stars = new T.Points(starGeo, new T.PointsMaterial({
      size: mobile ? 0.34 : 0.26, map: starTex, transparent: true, opacity: 0.75,
      depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true,
    }));
    scene.add(stars);

    /* 星云 */
    const nebulas = [[0x6d28d9, 26, -16, 8], [0x0891b2, 22, -22, -6], [0x1e1b4b, 34, -30, 2]];
    nebulas.forEach(([c, s, z, y]) => {
      const sp = new T.Sprite(new T.SpriteMaterial({
        map: glowTexture(c, 0.5), transparent: true, opacity: 0.32,
        depthWrite: false, blending: T.AdditiveBlending,
      }));
      sp.scale.set(s, s, 1);
      sp.position.set(0, y, z);
      scene.add(sp);
    });

    /* 核心光团 */
    const core = new T.Sprite(new T.SpriteMaterial({
      map: glowTexture(0x818cf8, 0.8), transparent: true, opacity: 0.55,
      depthWrite: false, blending: T.AdditiveBlending,
    }));
    core.scale.set(7, 7, 1);
    world.add(core);

    /* 节点（中心 7 入口内环，7 执行者外环） */
    const chiefs = agents.filter(a => a.kind === "chief");
    const workers = agents.filter(a => a.kind !== "chief");
    const pos = {};
    const pickables = [];
    const sprites = [];
    const place = (list, radius, yBase, offset) => {
      list.forEach((a, i) => {
        const ang = offset + (i / Math.max(1, list.length)) * Math.PI * 2;
        const p = new T.Vector3(
          Math.cos(ang) * radius,
          yBase + Math.sin(ang * 2.1) * 0.45,
          Math.sin(ang) * radius * 0.86
        );
        pos[a.id] = p;
        const hex = colorOf(a);
        const mat = new T.SpriteMaterial({
          map: nodeTexture(a, hex), transparent: true, depthWrite: false,
          opacity: 1,
        });
        const sp = new T.Sprite(mat);
        const s = a.kind === "chief" ? 2.5 : 2.15;
        sp.scale.set(s, s, 1);
        sp.position.copy(p);
        sp.userData.agent = a.id;
        sp.userData.sig = a.status + "|" + a.kind;
        sp.userData.baseScale = s;
        world.add(sp);
        sprites.push(sp);
        pickables.push(sp);
      });
    };
    place(chiefs, 2.7, 0.25, 0.35);
    place(workers, 4.9, -0.35, 0.35 + Math.PI / Math.max(1, chiefs.length));

    /* 通道线（全部预生成；空闲半透明，active 才亮并有光点流动） */
    const edgeRefs = [];
    const activePts = [];
    (edges || []).forEach(e => {
      const f = pos[e.from], t = pos[e.to];
      if (!f || !t) return;
      const active = e.state === "active";
      const geo = new T.BufferGeometry().setFromPoints([f, t]);
      const mat = new T.LineBasicMaterial({
        color: active ? 0x8b5cf6 : 0x64748b,
        transparent: true, opacity: active ? 0.85 : 0.16, depthWrite: false,
      });
      const line = new T.Line(geo, mat);
      line.userData.base = mat.opacity;
      line.userData.ends = [e.from, e.to];
      world.add(line);
      edgeRefs.push(line);
      if (active) activePts.push({ from: f.clone(), to: t.clone(), t: Math.random() });
    });

    let particles = null;
    if (activePts.length) {
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(new Float32Array(activePts.length * 3), 3));
      particles = new T.Points(g, new T.PointsMaterial({
        size: 0.42, map: glowTexture(0xc4b5fd, 1), transparent: true, opacity: 0.95,
        depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true,
      }));
      world.add(particles);
    }

    R = {
      renderer, scene, camera, world, sprites, pickables, edgeRefs, activePts, particles,
      canvas, handlers: handlers || {}, dist: dist0, dist0, active: true, dragging: false,
      moved: false, lastX: 0, lastY: 0, raf: 0, last: performance.now(), spin: 0.0016,
      pointers: new Map(), pinch: null, selected: null, hovered: false,
    };

    /* 交互 */
    const raycaster = new T.Raycaster();
    const ndc = new T.Vector2();
    const hitAt = ev => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return raycaster.intersectObjects(pickables, false)[0] || null;
    };

    canvas.addEventListener("pointerdown", ev => {
      canvas.setPointerCapture(ev.pointerId);
      R.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (R.pointers.size === 2) {
        const [a, b] = [...R.pointers.values()];
        R.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cam: R.dist };
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
        R.dist = clamp(R.pinch.cam * (R.pinch.d / Math.max(20, d)), 5.5, 18);
        camera.position.z = R.dist;
        R.moved = true;
        return;
      }
      if (!R.dragging) {
        if (ev.pointerType === "mouse") {
          const hit = hitAt(ev);
          canvas.style.cursor = hit ? "pointer" : "grab";
        }
        return;
      }
      const dx = ev.clientX - R.lastX, dy = ev.clientY - R.lastY;
      R.lastX = ev.clientX;
      R.lastY = ev.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) R.moved = true;
      world.rotation.y += dx * 0.006;
      world.rotation.x = clamp(world.rotation.x + dy * 0.004, -0.75, 0.75);
    });
    const endDrag = ev => {
      R.pointers.delete(ev.pointerId);
      if (R.pointers.size < 2) R.pinch = null;
      const wasDrag = R.dragging;
      R.dragging = false;
      canvas.style.cursor = "grab";
      if (wasDrag && !R.moved && ev.type === "pointerup") {
        const hit = hitAt(ev);
        if (hit && R.handlers.onAgent) R.handlers.onAgent(hit.object.userData.agent);
      }
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => { canvas.style.cursor = "grab"; });
    canvas.addEventListener("wheel", ev => {
      ev.preventDefault();
      R.dist = clamp(R.dist * (1 + (ev.deltaY > 0 ? 0.1 : -0.1)), 5.5, 18);
      camera.position.z = R.dist;
    }, { passive: false });

    /* 尺寸自适应 */
    const ro = new ResizeObserver(() => {
      if (!R) return;
      renderer.setSize(W(), H(), false);
      camera.aspect = W() / H();
      camera.updateProjectionMatrix();
    });
    ro.observe(canvas);
    R.ro = ro;

    /* 渲染循环 */
    const tick = now => {
      if (!R || !R.active) return;
      R.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - R.last) / 1000) || 0.016;
      R.last = now;
      if (!R.dragging) R.world.rotation.y += dt * R.spin;
      stars.rotation.y += dt * 0.004;
      if (particles) {
        const arr = particles.geometry.attributes.position.array;
        R.activePts.forEach((p, i) => {
          p.t = (p.t + dt * 0.3) % 1;
          arr[i * 3] = p.from.x + (p.to.x - p.from.x) * p.t;
          arr[i * 3 + 1] = p.from.y + (p.to.y - p.from.y) * p.t;
          arr[i * 3 + 2] = p.from.z + (p.to.z - p.from.z) * p.t;
        });
        particles.geometry.attributes.position.needsUpdate = true;
      }
      R.renderer.render(R.scene, R.camera);
    };
    R.tick = tick;
    R.raf = requestAnimationFrame(tick);
    return true;
  }

  /* 选中：关联节点高亮，其余淡化 */
  function select(id) {
    if (!R) return;
    R.selected = id;
    const related = new Set([id]);
    R.edgeRefs.forEach(l => {
      const [f, t] = l.userData.ends;
      if (f === id) related.add(t);
      if (t === id) related.add(f);
    });
    R.sprites.forEach(sp => {
      const on = related.has(sp.userData.agent);
      sp.material.opacity = !id ? 1 : (on ? 1 : 0.18);
      const base = sp.userData.baseScale || (sp.userData.baseScale = sp.scale.x);
      sp.scale.setScalar(sp.userData.agent === id ? base * 1.35 : base);
    });
    R.edgeRefs.forEach(l => {
      const [f, t] = l.userData.ends;
      const on = !id || f === id || t === id;
      l.material.opacity = on ? Math.max(l.userData.base, 0.5) : l.userData.base * 0.35;
    });
  }

  function zoom(f) {
    if (!R) return;
    R.dist = clamp(R.dist * f, 5.5, 18);
    R.camera.position.z = R.dist;
  }

  function reset() {
    if (!R) return;
    R.dist = R.dist0;
    R.camera.position.z = R.dist0;
    R.world.rotation.set(0, 0, 0);
  }

  function pause() { if (R) { R.active = false; cancelAnimationFrame(R.raf); } }
  function resume() {
    if (!R || R.active) return;
    R.active = true;
    R.last = performance.now();
    R.raf = requestAnimationFrame(R.tick);
  }

  /* 数据刷新：仅重绘状态/类型变化过的节点贴图，不重置视角 */
  function refresh(agents) {
    if (!R || !agents) return;
    const map = new Map(agents.map(a => [a.id, a]));
    R.sprites.forEach(sp => {
      const a = map.get(sp.userData.agent);
      if (!a) return;
      const sig = a.status + "|" + a.kind;
      if (sp.userData.sig === sig) return;
      sp.userData.sig = sig;
      const old = sp.material.map;
      sp.material.map = nodeTexture(a, colorOf(a));
      sp.material.needsUpdate = true;
      if (old) old.dispose();
    });
  }

  window.SB3D = { mount, select, zoom, reset, pause, resume, refresh };
})();
