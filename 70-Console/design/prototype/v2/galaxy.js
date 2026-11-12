/* Super-Brain 协作中枢 · 知识星图
   旋臂、核球、尘埃带、银晕和一颗远处的伴星系。文档是更亮的命名星，
   背景星与尘埃不能点开。没有 WebGL 时退回平面旋涡。 */
(function () {
  "use strict";
  const T = window.THREE;

  function hashStr(s) {
    let h = 2166136261;
    const str = String(s || "");
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const PAL = [
    [0.98, 0.78, 0.42],
    [0.45, 0.78, 1.0],
    [1.0, 0.48, 0.68],
    [0.55, 0.92, 0.78],
    [0.72, 0.62, 1.0],
    [1.0, 0.62, 0.35]
  ];

  const NOISE = `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.4); a *= 0.5; }
  return s;
}
`;
  const FULL_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  function makeBloom(renderer) {
    const pars = { minFilter: T.LinearFilter, magFilter: T.LinearFilter, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false };
    const rtScene = new T.WebGLRenderTarget(2, 2, Object.assign({ depthBuffer: true }, pars));
    const rtA = new T.WebGLRenderTarget(2, 2, pars);
    const rtB = new T.WebGLRenderTarget(2, 2, pars);
    const quadScene = new T.Scene();
    const quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const thresh = new T.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.84 }, uSoft: { value: 0.16 } },
      vertexShader: FULL_VS,
      fragmentShader: `uniform sampler2D tDiffuse; uniform float uThreshold; uniform float uSoft; varying vec2 vUv;
        void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; float l = max(c.r, max(c.g, c.b)); float s = smoothstep(uThreshold, uThreshold + uSoft, l); gl_FragColor = vec4(c * s, 1.0); }`,
      depthTest: false, depthWrite: false
    });
    const blur = new T.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new T.Vector2() } },
      vertexShader: FULL_VS,
      fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;
        void main(){ vec4 c = texture2D(tDiffuse, vUv) * 0.227027;
          c += texture2D(tDiffuse, vUv + uDir * 1.384615) * 0.316216;
          c += texture2D(tDiffuse, vUv - uDir * 1.384615) * 0.316216;
          c += texture2D(tDiffuse, vUv + uDir * 3.230769) * 0.070270;
          c += texture2D(tDiffuse, vUv - uDir * 3.230769) * 0.070270;
          gl_FragColor = c; }`,
      depthTest: false, depthWrite: false
    });
    const comp = new T.ShaderMaterial({
      uniforms: { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: 0.62 } },
      vertexShader: FULL_VS,
      fragmentShader: `uniform sampler2D tScene; uniform sampler2D tBloom; uniform float uStrength; varying vec2 vUv;
        void main(){
          vec3 base = texture2D(tScene, vUv).rgb;
          vec3 bloom = texture2D(tBloom, vUv).rgb;
          vec3 col = base + bloom * uStrength;
          float vig = smoothstep(1.08, 0.25, length(vUv - 0.5));
          col *= mix(0.62, 1.0, vig);
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthTest: false, depthWrite: false
    });
    const quad = new T.Mesh(new T.PlaneGeometry(2, 2), thresh);
    quad.frustumCulled = false;
    quadScene.add(quad);
    let bw = 2, bh = 2;
    function pass(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(quadScene, quadCam); }
    return {
      resize(w, h) {
        const W = Math.max(2, w | 0), H = Math.max(2, h | 0);
        rtScene.setSize(W, H);
        bw = Math.max(2, (W * 0.5) | 0); bh = Math.max(2, (H * 0.5) | 0);
        rtA.setSize(bw, bh); rtB.setSize(bw, bh);
      },
      render(scene, camera) {
        renderer.autoClear = true;
        renderer.setRenderTarget(rtScene);
        renderer.render(scene, camera);
        thresh.uniforms.tDiffuse.value = rtScene.texture;
        pass(thresh, rtA);
        blur.uniforms.tDiffuse.value = rtA.texture; blur.uniforms.uDir.value.set(1 / bw, 0); pass(blur, rtB);
        blur.uniforms.tDiffuse.value = rtB.texture; blur.uniforms.uDir.value.set(0, 1 / bh); pass(blur, rtA);
        blur.uniforms.tDiffuse.value = rtA.texture; blur.uniforms.uDir.value.set(1 / bw, 0); pass(blur, rtB);
        blur.uniforms.tDiffuse.value = rtB.texture; blur.uniforms.uDir.value.set(0, 1 / bh); pass(blur, rtA);
        comp.uniforms.tScene.value = rtScene.texture;
        comp.uniforms.tBloom.value = rtA.texture;
        pass(comp, null);
      },
      dispose() { rtScene.dispose(); rtA.dispose(); rtB.dispose(); thresh.dispose(); blur.dispose(); comp.dispose(); quad.geometry.dispose(); }
    };
  }

  function matchDoc(d, q) {
    if (!q) return true;
    const blob = [d.title, d.path, d.category, d.snippet, (d.tags || []).join(" ")].join(" ").toLowerCase();
    return blob.indexOf(q) >= 0;
  }

  function layoutDocs(docs) {
    const cats = [];
    const map = {};
    docs.forEach((d, i) => {
      const name = d.category || "未分类";
      if (!map[name]) { map[name] = { name, items: [] }; cats.push(map[name]); }
      map[name].items.push({ doc: d, index: i });
    });
    const perArm = [[], [], [], []];
    cats.forEach((c, i) => perArm[i % 4].push(c));
    const placed = [];
    perArm.forEach((list, arm) => {
      list.forEach((c, ci) => {
        const r0 = 3.1 + ((ci + 0.2) / Math.max(1, list.length)) * 12.2;
        const col = PAL[hashStr(c.name) % PAL.length];
        c.items.forEach((it) => {
          const d = it.doc;
          const h = hashStr(d.path || d.title || String(it.index));
          const ang = ((h % 1000) / 1000) * Math.PI * 2;
          const rad = Math.sqrt(((h >>> 10) % 1000) / 1000) * Math.min(1.35, 0.28 * Math.sqrt(c.items.length));
          const r = r0 + Math.cos(ang) * rad * 0.55;
          const theta = arm * (Math.PI / 2) + Math.log(1.0 + r) * 2.55 + Math.sin(ang) * rad * 0.09;
          placed.push({
            doc: d,
            x: Math.cos(theta) * r,
            y: ((((h >>> 20) % 1000) / 1000) - 0.5) * 0.42,
            z: Math.sin(theta) * r,
            color: col,
            cat: c.name,
            size: 0.26 + ((h % 7) / 7) * 0.14
          });
        });
      });
    });
    return placed;
  }

  function buildEdges(placed) {
    const edges = [];
    const byCat = {};
    const byParent = {};
    const byTag = {};
    placed.forEach((p, i) => {
      const cat = p.cat || "";
      (byCat[cat] = byCat[cat] || []).push(i);
      const parent = String(p.doc.path || "").split("/").slice(0, -1).join("/");
      if (parent) (byParent[parent] = byParent[parent] || []).push(i);
      (p.doc.tags || []).forEach((t) => { if (t) (byTag[t] = byTag[t] || []).push(i); });
    });
    function chain(ids) {
      if (ids.length < 2 || ids.length > 14) return;
      for (let i = 1; i < ids.length; i++) edges.push([ids[i - 1], ids[i]]);
    }
    Object.keys(byCat).forEach((k) => chain(byCat[k]));
    Object.keys(byParent).forEach((k) => chain(byParent[k]));
    Object.keys(byTag).forEach((k) => { if (byTag[k].length >= 2 && byTag[k].length <= 8) chain(byTag[k]); });
    const seen = new Set();
    const out = [];
    edges.forEach((e) => {
      const a = Math.min(e[0], e[1]), b = Math.max(e[0], e[1]);
      const k = a + ":" + b;
      if (seen.has(k) || out.length > 320) return;
      seen.add(k);
      out.push([a, b]);
    });
    return out;
  }

  function create2D(box, opts) {
    const cv = document.createElement("canvas");
    cv.setAttribute("aria-label", "知识星图平面");
    box.appendChild(cv);
    const ctx = cv.getContext("2d");
    const labels = document.createElement("div");
    labels.className = "space-labels";
    box.appendChild(labels);
    let docs = [], placed = [], query = "", W = 1, H = 1, dpr = 1, raf = 0, hover = -1;
    let cam = { x: 0, y: 0, z: 1, tz: 1, tx: 0, ty: 0 };
    function resize() {
      const r = box.getBoundingClientRect();
      if (!r.width || !r.height) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width; H = r.height;
      cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
      cv.style.width = W + "px"; cv.style.height = H + "px";
      draw();
    }
    function project(p) {
      const z = cam.z;
      const s = Math.min(W, H) * 0.034 / z;
      return { x: W / 2 + (p.x - cam.x) * s, y: H / 2 + (p.z - cam.y) * s * 0.72, s };
    }
    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = ctx.createRadialGradient(W * 0.5, H * 0.48, 10, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
      g.addColorStop(0, "#1a1208");
      g.addColorStop(0.18, "#120818");
      g.addColorStop(1, "#05070e");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 700; i++) {
        const a = i * 2.399;
        const rad = 8 + (i % 90) * (Math.min(W, H) * 0.006);
        const arm = i % 4;
        const th = arm * 1.57 + Math.log(1 + rad) * 0.42 + (i % 13) * 0.02;
        const x = W / 2 + Math.cos(th) * rad * cam.z;
        const y = H / 2 + Math.sin(th) * rad * 0.62 * cam.z;
        const outer = rad / (Math.min(W, H) * 0.5);
        ctx.fillStyle = outer > 0.55 ? "rgba(170,200,255,0.75)" : "rgba(255,196,120,0.8)";
        ctx.globalAlpha = 0.35 + (i % 5) * 0.08;
        ctx.fillRect(x, y, i % 17 === 0 ? 2 : 1, i % 17 === 0 ? 2 : 1);
      }
      ctx.globalAlpha = 1;
      const core = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 70 / cam.z);
      core.addColorStop(0, "rgba(255,244,220,0.95)");
      core.addColorStop(0.25, "rgba(255,176,70,0.45)");
      core.addColorStop(1, "rgba(255,120,40,0)");
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, 70 / cam.z, 0, 7); ctx.fill();
      labels.replaceChildren();
      const q = query.trim().toLowerCase();
      placed.forEach((p, i) => {
        const hit = matchDoc(p.doc, q);
        if (q && !hit) ctx.globalAlpha = 0.12; else ctx.globalAlpha = 1;
        const s = project(p);
        const rad = Math.max(2.2, p.size * s.s * 1.6);
        const glow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, rad * 4);
        const c = p.color;
        glow.addColorStop(0, "rgba(255,255,255,0.95)");
        glow.addColorStop(0.4, "rgba(" + (c[0] * 255 | 0) + "," + (c[1] * 255 | 0) + "," + (c[2] * 255 | 0) + ",0.8)");
        glow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(s.x, s.y, rad * 4, 0, 7); ctx.fill();
        if (!q || hit || placed.length <= 24) {
          const el = document.createElement("div");
          el.className = "space-label galaxy-label" + (q && !hit ? " dim" : "");
          const b = document.createElement("b");
          b.textContent = p.doc.title || p.doc.path || "未命名";
          const sm = document.createElement("small");
          sm.textContent = p.cat || "";
          el.append(b, sm);
          el.style.transform = "translate(" + s.x.toFixed(1) + "px," + (s.y - rad - 8).toFixed(1) + "px) translate(-50%, -100%)";
          labels.appendChild(el);
        }
      });
      ctx.globalAlpha = 1;
    }
    function loop() {
      cam.z += (cam.tz - cam.z) * 0.08;
      cam.x += (cam.tx - cam.x) * 0.08;
      cam.y += (cam.ty - cam.y) * 0.08;
      draw();
      if (Math.abs(cam.tz - cam.z) > 0.002) raf = requestAnimationFrame(loop);
      else raf = 0;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(loop); }
    cv.addEventListener("wheel", (e) => { e.preventDefault(); cam.tz = clamp(cam.tz * (1 + e.deltaY * 0.001), 0.35, 2.4); kick(); }, { passive: false });
    let down = null;
    cv.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, tx: cam.tx, ty: cam.ty, t: performance.now() }; });
    cv.addEventListener("pointermove", (e) => {
      if (!down) return;
      const s = Math.min(W, H) * 0.034 / cam.z;
      cam.tx = down.tx - (e.clientX - down.x) / s;
      cam.ty = down.ty - (e.clientY - down.y) / (s * 0.72);
      cam.x = cam.tx; cam.y = cam.ty; draw();
    });
    cv.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) {
        const r = cv.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        let best = -1, bd = 18;
        placed.forEach((p, i) => {
          const s = project(p);
          const d = Math.hypot(s.x - x, s.y - y);
          if (d < bd) { bd = d; best = i; }
        });
        if (best >= 0 && placed[best].doc.path && opts.onSelect) opts.onSelect(placed[best].doc.path);
      }
      down = null;
    });
    const ro = new ResizeObserver(resize); ro.observe(box);
    resize();
    return {
      setDocs(list) { docs = list || []; placed = layoutDocs(docs); draw(); },
      setQuery(q) {
        query = q || "";
        draw();
        const n = docs.filter((d) => matchDoc(d, query.trim().toLowerCase())).length;
        return query ? n : docs.length;
      },
      reset() { cam.tz = 1; cam.tx = 0; cam.ty = 0; kick(); },
      flyIn() { cam.tz = 0.48; kick(); },
      dispose() { cancelAnimationFrame(raf); ro.disconnect(); cv.remove(); labels.remove(); }
    };
  }

  function createGL(box, opts) {
    const mobile = !!opts.mobile;
    const renderer = new T.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!renderer.getContext()) throw new Error("WebGL 不可用");
    renderer.setClearColor(0x03040a, 1);
    const dprCap = mobile ? 1 : 1.2;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.domElement.setAttribute("aria-label", "知识星图，可拖拽环绕，点文档星打开");
    renderer.domElement.tabIndex = 0;
    box.appendChild(renderer.domElement);
    const labelLayer = document.createElement("div");
    labelLayer.className = "space-labels";
    box.appendChild(labelLayer);
    const timeU = { value: 0 };
    const focusU = { value: 1 };
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(52, 1, 0.08, 900);
    const disk = new T.Group();
    scene.add(disk);
    const haloG = new T.Group();
    scene.add(haloG);
    const companion = new T.Group();
    companion.position.set(24, 6, -16);
    companion.scale.setScalar(0.16);
    scene.add(companion);
    let bloom = null, bloomOn = !mobile && !opts.reduced;
    try { if (bloomOn) bloom = makeBloom(renderer); } catch (e) { bloomOn = false; bloom = null; }

    const starMat = new T.ShaderMaterial({
      uniforms: { uTime: timeU, uFocus: focusU, uGain: { value: 1 } },
      vertexShader: `
        attribute float aPhase; attribute float aSize; attribute vec3 aColor;
        uniform float uTime; uniform float uFocus;
        varying vec3 vCol; varying float vPh;
        void main() {
          vCol = aColor; vPh = aPhase;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float tw = 0.78 + 0.22 * sin(uTime * 1.4 + aPhase);
          float ps = aSize * tw * uFocus * (220.0 / max(10.0, -mv.z));
          gl_PointSize = clamp(ps, 0.0, 3.6);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform float uGain; varying vec3 vCol; varying float vPh;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float d = dot(p, p);
          if (d > 1.0) discard;
          float a = pow(clamp(1.0 - d, 0.0, 1.0), 1.25);
          vec3 col = vCol * a * uGain;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });

    function addPoints(parent, count, fill, gain) {
      const pos = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);
      const phase = new Float32Array(count);
      const size = new Float32Array(count);
      for (let i = 0; i < count; i++) fill(i, pos, col, phase, size);
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(pos, 3));
      g.setAttribute("aColor", new T.BufferAttribute(col, 3));
      g.setAttribute("aPhase", new T.BufferAttribute(phase, 1));
      g.setAttribute("aSize", new T.BufferAttribute(size, 1));
      const mat = starMat.clone();
      mat.uniforms.uTime = timeU;
      mat.uniforms.uFocus = focusU;
      mat.uniforms.uGain = { value: gain };
      const pts = new T.Points(g, mat);
      pts.frustumCulled = false;
      parent.add(pts);
      return pts;
    }

    const armN = mobile ? 2800 : 6400;
    addPoints(disk, armN, (i, pos, col, phase, size) => {
      const arm = i % 4;
      const f = Math.pow((hashStr("a" + i) % 10000) / 10000, 0.62);
      const r = 0.4 + f * 17.5;
      let theta = arm * (Math.PI / 2) + Math.log(1 + r) * 2.7;
      const scatter = (0.12 + (1 - f) * 0.55) * (((hashStr("s" + i) % 1000) / 1000) - 0.5) * 2;
      const lane = (hashStr("l" + i) % 1000) / 1000;
      theta += lane < 0.72 ? scatter : scatter * 0.15 + 0.34;
      const thick = (0.05 + (1 - f) * 0.55) * (((hashStr("y" + i) % 1000) / 500) - 1);
      pos[i * 3] = Math.cos(theta) * r;
      pos[i * 3 + 1] = thick;
      pos[i * 3 + 2] = Math.sin(theta) * r;
      const blue = f;
      col[i * 3] = 1.0 * (1 - blue) + 0.55 * blue;
      col[i * 3 + 1] = 0.78 * (1 - blue) + 0.82 * blue;
      col[i * 3 + 2] = 0.42 * (1 - blue) + 1.0 * blue;
      phase[i] = (hashStr("p" + i) % 1000) / 159;
      size[i] = (0.7 + (hashStr("z" + i) % 100) / 100) * (hashStr("b" + i) % 40 === 0 ? 2.4 : 1);
    }, 1);

    addPoints(disk, mobile ? 500 : 1100, (i, pos, col, phase, size) => {
      const arm = i % 4;
      const f = 0.25 + ((hashStr("d" + i) % 1000) / 1000) * 0.7;
      const r = 2.2 + f * 14;
      const theta = arm * (Math.PI / 2) + Math.log(1 + r) * 2.7 + 0.42;
      pos[i * 3] = Math.cos(theta) * r;
      pos[i * 3 + 1] = (((hashStr("dy" + i) % 100) / 100) - 0.5) * 0.18;
      pos[i * 3 + 2] = Math.sin(theta) * r;
      col[i * 3] = 0.55; col[i * 3 + 1] = 0.24; col[i * 3 + 2] = 0.12;
      phase[i] = i;
      size[i] = 1.3;
    }, 0.55);

    addPoints(disk, mobile ? 700 : 1600, (i, pos, col, phase, size) => {
      const u = (hashStr("bx" + i) % 10000) / 10000;
      const v = (hashStr("by" + i) % 10000) / 10000;
      const w = (hashStr("bz" + i) % 10000) / 10000;
      const r = Math.pow(u, 0.35) * 3.4;
      const th = v * Math.PI * 2;
      const ph = Math.acos(2 * w - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.72;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      col[i * 3] = 1.0; col[i * 3 + 1] = 0.82; col[i * 3 + 2] = 0.55;
      phase[i] = th;
      size[i] = 1.1 + (1 - r / 3.4) * 1.6;
    }, 1.15);

    addPoints(haloG, mobile ? 600 : 1400, (i, pos, col, phase, size) => {
      const u = (hashStr("h" + i) % 10000) / 10000;
      const th = ((hashStr("ht" + i) % 10000) / 10000) * Math.PI * 2;
      const ph = Math.acos(2 * ((hashStr("hp" + i) % 10000) / 10000) - 1);
      const r = 10 + Math.pow(u, 0.5) * 34;
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph);
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      col[i * 3] = 0.85; col[i * 3 + 1] = 0.78; col[i * 3 + 2] = 0.62;
      phase[i] = th;
      size[i] = 0.7;
    }, 0.45);

    addPoints(companion, mobile ? 400 : 900, (i, pos, col, phase, size) => {
      const arm = i % 2;
      const f = (hashStr("c" + i) % 1000) / 1000;
      const r = 0.4 + f * 14;
      const theta = arm * Math.PI + Math.log(1 + r) * 2.2 + (((hashStr("cs" + i) % 100) / 100) - 0.5);
      pos[i * 3] = Math.cos(theta) * r;
      pos[i * 3 + 1] = (((hashStr("cy" + i) % 100) / 100) - 0.5) * 0.8;
      pos[i * 3 + 2] = Math.sin(theta) * r;
      col[i * 3] = 0.62; col[i * 3 + 1] = 0.72; col[i * 3 + 2] = 1.0;
      phase[i] = f * 6;
      size[i] = 1;
    }, 0.7);

    const coreMat = new T.ShaderMaterial({
      uniforms: { uTime: timeU },
      vertexShader: `varying vec3 vN; varying vec3 vObj; varying vec3 vView;
        void main(){ vObj = normalize(position); vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: NOISE + `uniform float uTime; varying vec3 vN; varying vec3 vObj; varying vec3 vView;
        void main(){
          vec3 N = normalize(vN); vec3 V = normalize(-vView);
          float mu = clamp(dot(N, V), 0.0, 1.0);
          float g = fbm(vObj * 4.0 + uTime * 0.05);
          vec3 col = mix(vec3(0.85, 0.28, 0.05), vec3(1.0, 0.86, 0.55), g);
          col = mix(col, vec3(1.0, 0.97, 0.9), pow(mu, 0.45));
          col *= 0.7 + pow(mu, 0.6);
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    const core = new T.Mesh(new T.SphereGeometry(0.72, 36, 24), coreMat);
    disk.add(core);
    const shellMat = new T.ShaderMaterial({
      uniforms: { uTime: timeU },
      vertexShader: `varying vec3 vN; varying vec3 vView;
        void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vView;
        void main(){
          float fres = pow(1.0 - clamp(dot(normalize(vN), normalize(-vView)), 0.0, 1.0), 2.0);
          vec3 col = vec3(1.0, 0.72, 0.32) * fres;
          gl_FragColor = vec4(col, fres);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.BackSide
    });
    const shell = new T.Mesh(new T.SphereGeometry(1.35, 28, 18), shellMat);
    shell.raycast = function () {};
    disk.add(shell);

    const docMat = new T.ShaderMaterial({
      uniforms: { uTime: timeU },
      vertexShader: `
        attribute vec3 aColor; attribute float aGlow;
        varying vec3 vColor; varying float vGlow; varying vec3 vN; varying vec3 vView;
        void main() {
          vColor = aColor; vGlow = aGlow;
          vec3 pos = position;
          vec3 center = vec3(0.0);
          #ifdef USE_INSTANCING
            pos = (instanceMatrix * vec4(position, 1.0)).xyz;
            center = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #endif
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          vec4 mc = modelViewMatrix * vec4(center, 1.0);
          vView = mv.xyz;
          vN = normalize(mv.xyz - mc.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor; varying float vGlow; varying vec3 vN; varying vec3 vView;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(-vView);
          float mu = clamp(dot(N, V), 0.0, 1.0);
          float core = pow(mu, 2.4);
          if (core < 0.05) discard;
          vec3 col = mix(vColor, vec3(1.0, 0.97, 0.9), core);
          col *= core * (0.8 + 2.2 * vGlow);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });
    const docGeo = new T.SphereGeometry(1, 12, 10);
    let docMesh = null;
    let stream = null;
    let placed = [];
    let query = "";
    const labelPool = [];

    function clearDocs() {
      if (docMesh) { disk.remove(docMesh); docMesh = null; }
      if (stream) { disk.remove(stream); stream.geometry.dispose(); stream.material.dispose(); stream = null; }
    }
    function paintQuery() {
      if (!docMesh) return 0;
      const q = query.trim().toLowerCase();
      const glow = docMesh.geometry.getAttribute("aGlow");
      let n = 0;
      for (let i = 0; i < placed.length; i++) {
        const hit = matchDoc(placed[i].doc, q);
        if (!q || hit) n++;
        glow.setX(i, !q ? 1 : hit ? 1 : 0.06);
      }
      glow.needsUpdate = true;
      focusU.value = q ? 0.45 : 1;
      return q ? n : placed.length;
    }
    function applyDocs(list) {
      clearDocs();
      placed = layoutDocs(list || []);
      if (!placed.length) { paintQuery(); return 0; }
      docMesh = new T.InstancedMesh(docGeo, docMat, placed.length);
      docMesh.frustumCulled = false;
      const colors = new Float32Array(placed.length * 3);
      const glows = new Float32Array(placed.length);
      const dummy = new T.Object3D();
      placed.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.scale.setScalar(p.size);
        dummy.updateMatrix();
        docMesh.setMatrixAt(i, dummy.matrix);
        colors[i * 3] = p.color[0]; colors[i * 3 + 1] = p.color[1]; colors[i * 3 + 2] = p.color[2];
        glows[i] = 1;
      });
      docMesh.instanceMatrix.needsUpdate = true;
      docGeo.setAttribute("aColor", new T.InstancedBufferAttribute(colors, 3));
      docGeo.setAttribute("aGlow", new T.InstancedBufferAttribute(glows, 1));
      disk.add(docMesh);
      const edges = buildEdges(placed);
      if (edges.length) {
        const samples = 16;
        const count = edges.length * samples;
        const pos = new Float32Array(count * 3);
        const col = new Float32Array(count * 3);
        const phase = new Float32Array(count);
        const size = new Float32Array(count);
        edges.forEach((e, ei) => {
          const a = placed[e[0]], b = placed[e[1]];
          for (let s = 0; s < samples; s++) {
            const t = s / (samples - 1);
            const k = ei * samples + s;
            const arc = Math.sin(t * Math.PI) * 0.35;
            pos[k * 3] = a.x + (b.x - a.x) * t;
            pos[k * 3 + 1] = a.y + (b.y - a.y) * t + arc;
            pos[k * 3 + 2] = a.z + (b.z - a.z) * t;
            col[k * 3] = (a.color[0] + b.color[0]) * 0.5;
            col[k * 3 + 1] = (a.color[1] + b.color[1]) * 0.5;
            col[k * 3 + 2] = (a.color[2] + b.color[2]) * 0.5;
            phase[k] = ei + t;
            size[k] = 0.85;
          }
        });
        const g = new T.BufferGeometry();
        g.setAttribute("position", new T.BufferAttribute(pos, 3));
        g.setAttribute("aColor", new T.BufferAttribute(col, 3));
        g.setAttribute("aPhase", new T.BufferAttribute(phase, 1));
        g.setAttribute("aSize", new T.BufferAttribute(size, 1));
        const mat = starMat.clone();
        mat.uniforms.uTime = timeU;
        mat.uniforms.uFocus = { value: 1 };
        mat.uniforms.uGain = { value: 0.85 };
        stream = new T.Points(g, mat);
        stream.frustumCulled = false;
        disk.add(stream);
      }
      return paintQuery();
    }

    const cam = { theta: 0.5, phi: 0.78, r: 38, ttheta: 0.5, tphi: 0.78, tr: 38, target: new T.Vector3(), tt: new T.Vector3(0, 0, 0) };
    let fly = null, raf = 0, visible = true, cssW = 1, cssH = 1, lastInteract = 0;
    const ray = new T.Raycaster();
    const v2 = new T.Vector2();
    const ndc = new T.Vector3();

    function placeLabels() {
      const q = query.trim().toLowerCase();
      const show = [];
      placed.forEach((p, i) => {
        const hit = matchDoc(p.doc, q);
        if (q && !hit) return;
        ndc.set(p.x, p.y, p.z);
        disk.updateWorldMatrix(true, true);
        disk.localToWorld(ndc);
        const dist = ndc.distanceTo(camera.position);
        if (placed.length <= 24 || hit && q || dist < 16) show.push({ i, dist, p, world: ndc.clone() });
      });
      show.sort((a, b) => a.dist - b.dist);
      const keep = show.slice(0, placed.length <= 24 ? 24 : 14);
      while (labelPool.length < keep.length) {
        const el = document.createElement("div");
        el.className = "space-label galaxy-label";
        const b = document.createElement("b");
        const sm = document.createElement("small");
        el.append(b, sm);
        labelLayer.appendChild(el);
        labelPool.push(el);
      }
      const used = [];
      labelPool.forEach((el, idx) => {
        const item = keep[idx];
        if (!item) { el.style.display = "none"; return; }
        ndc.copy(item.world).project(camera);
        if (ndc.z > 1) { el.style.display = "none"; return; }
        const x = (ndc.x * 0.5 + 0.5) * cssW;
        const y = (-ndc.y * 0.5 + 0.5) * cssH;
        if (x < -20 || y < -20 || x > cssW + 20 || y > cssH + 20) { el.style.display = "none"; return; }
        if (used.some((p) => Math.hypot(p.x - x, p.y - y) < 46)) { el.style.display = "none"; return; }
        used.push({ x, y });
        el.style.display = "";
        el.querySelector("b").textContent = item.p.doc.title || item.p.doc.path || "未命名";
        el.querySelector("small").textContent = item.p.cat || "";
        el.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px) translate(-50%, -140%)";
      });
    }

    function resize() {
      const r = box.getBoundingClientRect();
      if (!r.width || !r.height) return;
      cssW = r.width; cssH = r.height;
      const pr = Math.min(window.devicePixelRatio || 1, dprCap);
      renderer.setPixelRatio(pr);
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
      if (bloom) bloom.resize(Math.floor(r.width * pr), Math.floor(r.height * pr));
      kick();
    }
    const ro = new ResizeObserver(resize); ro.observe(box);
    const io = new IntersectionObserver((en) => { visible = !!(en[0] && en[0].isIntersecting); if (visible) kick(); }, { threshold: 0.01 });
    io.observe(box);
    const onVis = () => { if (!document.hidden) kick(); };
    document.addEventListener("visibilitychange", onVis);

    function frame(now) {
      raf = 0;
      if (!visible || document.hidden) return;
      const t = now / 1000;
      timeU.value = opts.reduced ? 0 : t;
      if (!opts.reduced) {
        disk.rotation.y = t * 0.018;
        haloG.rotation.y = t * 0.004;
        companion.rotation.y = t * 0.03;
      }
      if (fly) {
        const u = clamp((now - fly.t0) / fly.dur, 0, 1);
        const e = 1 - Math.pow(1 - u, 3);
        cam.tt.lerpVectors(fly.from, fly.to, e);
        cam.tr = fly.r0 + (fly.r1 - fly.r0) * e;
        cam.tphi = fly.p0 + (fly.p1 - fly.p0) * e;
        if (u >= 1) fly = null;
      }
      const damp = opts.reduced ? 1 : 0.06;
      cam.theta += (cam.ttheta - cam.theta) * damp;
      cam.phi += (cam.tphi - cam.phi) * damp;
      cam.r += (cam.tr - cam.r) * damp;
      cam.target.lerp(cam.tt, damp);
      const breathe = opts.reduced ? 0 : Math.sin(t * 0.2) * 0.25;
      camera.position.set(
        cam.target.x + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta),
        cam.target.y + cam.r * Math.cos(cam.phi) + breathe,
        cam.target.z + cam.r * Math.sin(cam.phi) * Math.sin(cam.theta)
      );
      camera.lookAt(cam.target);
      placeLabels();
      let drew = false;
      if (bloomOn && bloom) {
        try { bloom.render(scene, camera); drew = true; }
        catch (err) { bloomOn = false; renderer.setRenderTarget(null); }
      }
      if (!drew) { renderer.setRenderTarget(null); renderer.render(scene, camera); }
      if (visible && !document.hidden) kick();
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }

    const el = renderer.domElement;
    let ptr = null, pinch = 0, r0 = 0;
    const ptrs = new Map();
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      ptr = { x: e.clientX, y: e.clientY, t: performance.now() };
      fly = null; lastInteract = performance.now();
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y); r0 = cam.tr;
      }
    });
    el.addEventListener("pointermove", (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      if (ptrs.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) cam.tr = clamp(r0 * (pinch / d), 2.4, 90);
      } else {
        cam.ttheta -= (e.clientX - p.x) * 0.005;
        cam.tphi = clamp(cam.tphi - (e.clientY - p.y) * 0.004, 0.18, 1.45);
        p.x = e.clientX; p.y = e.clientY;
      }
      fly = null;
    });
    function pick(cx, cy) {
      if (!docMesh) return -1;
      disk.updateWorldMatrix(true, true);
      const rect = el.getBoundingClientRect();
      v2.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(v2, camera);
      const hit = ray.intersectObject(docMesh, false)[0];
      return hit && hit.instanceId != null ? hit.instanceId : -1;
    }
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (ptr && ptrs.size === 0 && Math.hypot(e.clientX - ptr.x, e.clientY - ptr.y) < 6 && performance.now() - ptr.t < 500) {
        const id = pick(e.clientX, e.clientY);
        if (id >= 0 && placed[id] && placed[id].doc.path && opts.onSelect) opts.onSelect(placed[id].doc.path);
      }
      if (ptrs.size < 2) pinch = 0;
      ptr = null;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      cam.tr = clamp(cam.tr * (1 + e.deltaY * 0.0011), 2.4, 92);
      fly = null;
    }, { passive: false });

    resize();
    kick();
    return {
      setDocs(list) { return applyDocs(list); },
      setQuery(q) { query = q || ""; return paintQuery(); },
      reset() {
        fly = null;
        cam.tt.set(0, 0, 0); cam.tr = 38; cam.tphi = 0.78;
      },
      flyIn() {
        const dest = placed.length ? placed[Math.floor(Math.random() * placed.length)] : null;
        disk.updateWorldMatrix(true, true);
        const to = dest ? disk.localToWorld(new T.Vector3(dest.x, dest.y, dest.z)) : new T.Vector3(8, 0.2, 3);
        fly = { from: cam.tt.clone(), to, t0: performance.now(), dur: opts.reduced ? 1 : 2600, r0: cam.tr, r1: dest ? 6.5 : 9, p0: cam.tphi, p1: 1.12 };
      },
      dispose() {
        cancelAnimationFrame(raf);
        ro.disconnect(); io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        clearDocs();
        starMat.dispose();
        docMat.dispose();
        if (bloom) bloom.dispose();
        scene.traverse((o) => {
          if (o.geometry && o !== docMesh) o.geometry.dispose();
          if (o.material && o.material.dispose) o.material.dispose();
        });
        docGeo.dispose();
        renderer.dispose();
        el.remove(); labelLayer.remove();
      }
    };
  }

  function create(box, opts) {
    opts = opts || {};
    let gl = false;
    try {
      const c = document.createElement("canvas");
      gl = !!(T && (c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl")));
    } catch (e) { gl = false; }
    if (!gl) return create2D(box, opts);
    try { return createGL(box, opts); }
    catch (e) { return create2D(box, opts); }
  }

  window.SBGALAXY = { create, version: "1.0.0" };
})();
