/* Super-Brain 协作中枢 · 指挥中心 4.0
   中台是编排核心（photosphere 着色器，石墨海军蓝，不是恒星）。
   Agent 仍是各自的星体，但只在蓝 / 紫两族里变化，离线转石墨。
   连线只画 /api/relations 的真实关系；光点只在 pulse() 被真实消息调用时出现。
   不使用 MeshBasicMaterial，也不用装饰性转环。WebGL 不可用时由 app.js 退回平面。 */
(function () {
  "use strict";
  const T = window.THREE;
  if (!T) return;
  const HUB = "__hub__";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const big = (n) => (n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 1 : 2) + "万" : String(n));

  function hashStr(s) {
    let h = 2166136261;
    const str = String(s || "");
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }

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
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.4); a *= 0.5; }
  return s;
}`;

  const FULL_VS = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

  function makeBloom(renderer) {
    const pars = { minFilter: T.LinearFilter, magFilter: T.LinearFilter, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false };
    const rtScene = new T.WebGLRenderTarget(2, 2, Object.assign({ depthBuffer: true }, pars));
    const rtA = new T.WebGLRenderTarget(2, 2, pars);
    const rtB = new T.WebGLRenderTarget(2, 2, pars);
    const quadScene = new T.Scene();
    const quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const thresh = new T.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.82 }, uSoft: { value: 0.14 } },
      vertexShader: FULL_VS,
      fragmentShader: "uniform sampler2D tDiffuse; uniform float uThreshold; uniform float uSoft; varying vec2 vUv; void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; float l = max(c.r, max(c.g, c.b)); float s = smoothstep(uThreshold, uThreshold + uSoft, l); gl_FragColor = vec4(c * s, 1.0); }",
      depthTest: false, depthWrite: false
    });
    const blur = new T.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new T.Vector2() } },
      vertexShader: FULL_VS,
      fragmentShader: "uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv) * 0.227027; c += texture2D(tDiffuse, vUv + uDir * 1.384615) * 0.316216; c += texture2D(tDiffuse, vUv - uDir * 1.384615) * 0.316216; c += texture2D(tDiffuse, vUv + uDir * 3.230769) * 0.070270; c += texture2D(tDiffuse, vUv - uDir * 3.230769) * 0.070270; gl_FragColor = c; }",
      depthTest: false, depthWrite: false
    });
    const comp = new T.ShaderMaterial({
      uniforms: { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: 0.42 } },
      vertexShader: FULL_VS,
      fragmentShader: "uniform sampler2D tScene; uniform sampler2D tBloom; uniform float uStrength; varying vec2 vUv; void main(){ vec3 col = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength; float vig = smoothstep(1.02, 0.32, length(vUv - 0.5)); col *= mix(0.8, 1.0, vig); gl_FragColor = vec4(col, 1.0); }",
      depthTest: false, depthWrite: false
    });
    const quad = new T.Mesh(new T.PlaneGeometry(2, 2), thresh);
    quad.frustumCulled = false;
    quadScene.add(quad);
    let bw = 2, bh = 2;
    function pass(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(quadScene, quadCam); }
    function blurTo(src, dst, dx, dy) {
      blur.uniforms.tDiffuse.value = src.texture;
      blur.uniforms.uDir.value.set(dx, dy);
      pass(blur, dst);
    }
    return {
      resize(w, h) {
        const W = Math.max(2, w | 0), H = Math.max(2, h | 0);
        rtScene.setSize(W, H);
        bw = Math.max(2, (W * 0.5) | 0);
        bh = Math.max(2, (H * 0.5) | 0);
        rtA.setSize(bw, bh); rtB.setSize(bw, bh);
      },
      render(scene, camera) {
        renderer.autoClear = true;
        renderer.setRenderTarget(rtScene);
        renderer.render(scene, camera);
        thresh.uniforms.tDiffuse.value = rtScene.texture;
        pass(thresh, rtA);
        blurTo(rtA, rtB, 1 / bw, 0);
        blurTo(rtB, rtA, 0, 1 / bh);
        blurTo(rtA, rtB, 1 / bw, 0);
        blurTo(rtB, rtA, 0, 1 / bh);
        comp.uniforms.tScene.value = rtScene.texture;
        comp.uniforms.tBloom.value = rtA.texture;
        pass(comp, null);
      },
      dispose() {
        rtScene.dispose(); rtA.dispose(); rtB.dispose();
        thresh.dispose(); blur.dispose(); comp.dispose();
        quad.geometry.dispose();
      }
    };
  }

  function ribbonGeo(curve, width, n) {
    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    const idx = [];
    const up = new T.Vector3(0, 1, 0);
    const side = new T.Vector3();
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const p = curve.getPoint(t);
      const tang = curve.getTangent(t);
      side.crossVectors(tang, up);
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      side.normalize().multiplyScalar(width);
      const o = i * 2;
      pos[o * 3] = p.x + side.x; pos[o * 3 + 1] = p.y + side.y; pos[o * 3 + 2] = p.z + side.z;
      pos[(o + 1) * 3] = p.x - side.x; pos[(o + 1) * 3 + 1] = p.y - side.y; pos[(o + 1) * 3 + 2] = p.z - side.z;
      uv[o * 2] = t; uv[o * 2 + 1] = 0;
      uv[(o + 1) * 2] = t; uv[(o + 1) * 2 + 1] = 1;
      if (i < n - 1) idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    g.setAttribute("uv", new T.BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  function layoutOrg(list, edges) {
    const pos = {};
    list.forEach((n) => {
      const h = hashStr(n.id);
      const h2 = hashStr(n.id + ":b");
      const hy = hashStr(n.id + ":y");
      const offline = n.statusKey === "offline";
      const err = n.statusKey === "error";
      const chief = n.kind === "chief";
      const base = chief ? 6.6 : 10.4;
      const r = base + (offline ? 5.2 : err ? 2.1 : 0) + h2 * (chief ? 2.6 : 3.8);
      const ang = h * Math.PI * 2;
      const y = (hy - 0.5) * (chief ? 4.4 : 6.2);
      pos[n.id] = new T.Vector3(Math.cos(ang) * r, y, Math.sin(ang) * r * (0.62 + h2 * 0.5));
    });
    const pairs = (edges || []).filter((e) => pos[e.source] && pos[e.target]);
    const ids = list.map((n) => n.id);
    const byId = {};
    list.forEach((n) => { byId[n.id] = n; });
    for (let iter = 0; iter < 86; iter++) {
      const force = {};
      ids.forEach((id) => { force[id] = new T.Vector3(); });
      for (let a = 0; a < ids.length; a++) {
        for (let b = a + 1; b < ids.length; b++) {
          const d = pos[ids[a]].clone().sub(pos[ids[b]]);
          const len = Math.max(0.4, d.length());
          d.multiplyScalar((7.2 / (len * len)) / len);
          force[ids[a]].add(d);
          force[ids[b]].sub(d);
        }
      }
      pairs.forEach((e) => {
        const d = pos[e.target].clone().sub(pos[e.source]);
        const len = Math.max(0.2, d.length());
        const pull = (len - 6.4) * 0.05;
        d.multiplyScalar(pull / len);
        force[e.source].add(d);
        force[e.target].sub(d);
      });
      ids.forEach((id) => {
        const n = byId[id];
        const p = pos[id];
        const targetR = n.statusKey === "offline" ? 16.5 : n.kind === "chief" ? 8.4 : 12.6;
        const radial = p.clone();
        const r = Math.max(0.25, radial.length());
        radial.multiplyScalar(((targetR - r) * 0.022) / r);
        force[id].add(radial);
        force[id].y += -p.y * 0.012;
        p.add(force[id].multiplyScalar(0.52));
        if (p.length() < 3.3) p.setLength(3.3);
      });
    }
    return pos;
  }

  function create(box, opts) {
    opts = opts || {};
    const mobile = !!opts.mobile;
    const dprCap = mobile ? 1 : 1.25;
    const renderer = new T.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!renderer.getContext()) throw new Error("WebGL 不可用");
    renderer.setClearColor(0x0c121c, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.domElement.setAttribute("aria-label", "指挥中心，可拖拽环绕，点节点看详情，点连线看证据");
    renderer.domElement.tabIndex = 0;
    box.appendChild(renderer.domElement);
    const labelLayer = document.createElement("div");
    labelLayer.className = "space-labels";
    box.appendChild(labelLayer);
    const tip = document.createElement("div");
    tip.className = "tip3d";
    tip.hidden = true;
    box.appendChild(tip);

    const timeU = { value: 0 };
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(46, 1, 0.08, 420);
    const cam = { theta: 0.72, phi: 1.02, r: 32, tr: 32, target: new T.Vector3(), tt: new T.Vector3() };
    let cssW = 1, cssH = 1, lastInteract = 0, sel = null, raf = 0, visible = true, bloomOn = !mobile;
    let bloom = null;
    try { bloom = makeBloom(renderer); } catch (err) { bloomOn = false; bloom = null; }
    const keyWorld = new T.Vector3(0.42, 0.86, 0.28).normalize();

    const world = new T.Group();
    scene.add(world);

    const starMat = new T.ShaderMaterial({
      uniforms: { uSize: { value: mobile ? 1.0 : 1.15 } },
      vertexShader: "attribute float aSize; uniform float uSize; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(aSize * uSize * (200.0 / max(12.0, -mv.z)), 0.0, 2.6); gl_Position = projectionMatrix * mv; }",
      fragmentShader: "void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p, p); if (d > 1.0) discard; float a = pow(1.0 - d, 1.5); gl_FragColor = vec4(vec3(0.72, 0.8, 0.9) * a, a); }",
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });
    const starN = mobile ? 420 : 1100;
    const sPos = new Float32Array(starN * 3);
    const sSize = new Float32Array(starN);
    for (let i = 0; i < starN; i++) {
      const u = hashStr("s" + i);
      const v = hashStr("t" + i);
      const th = u * Math.PI * 2;
      const ph = Math.acos(2 * v - 1);
      const r = 40 + hashStr("r" + i) * 150;
      sPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      sPos[i * 3 + 1] = r * Math.cos(ph) * 0.8;
      sPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      sSize[i] = 0.55 + hashStr("z" + i) * 0.9;
    }
    const sg = new T.BufferGeometry();
    sg.setAttribute("position", new T.BufferAttribute(sPos, 3));
    sg.setAttribute("aSize", new T.BufferAttribute(sSize, 1));
    const stars = new T.Points(sg, starMat);
    stars.frustumCulled = false;
    scene.add(stars);

    const hub = new T.Group();
    world.add(hub);
    const photo = new T.ShaderMaterial({
      uniforms: { uTime: timeU, uFlash: { value: 0 }, uKey: { value: new T.Vector3(0.4, 0.8, 0.3) } },
      vertexShader: "varying vec3 vN; varying vec3 vObj; varying vec3 vView; void main(){ vObj = normalize(position); vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }",
      fragmentShader: NOISE + `
        uniform float uTime; uniform float uFlash; uniform vec3 uKey;
        varying vec3 vN; varying vec3 vObj; varying vec3 vView;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(-vView);
          float mu = clamp(dot(N, V), 0.0, 1.0);
          float ndl = clamp(dot(N, normalize(uKey)) * 0.5 + 0.55, 0.0, 1.0);
          float g = fbm(vObj * 3.2 + vec3(0.0, uTime * 0.015, 0.0));
          float lane = smoothstep(0.08, 0.0, abs(fract(g * 4.0) - 0.5));
          vec3 base = mix(vec3(0.07, 0.10, 0.16), vec3(0.16, 0.24, 0.36), g);
          vec3 col = base * (0.45 + 0.7 * ndl);
          col += vec3(0.55, 0.72, 0.95) * lane * 0.18 * ndl;
          col += vec3(0.75, 0.86, 1.0) * pow(mu, 18.0) * 0.2;
          col += vec3(0.65, 0.78, 1.0) * pow(1.0 - mu, 2.4) * 0.35;
          col += vec3(0.8, 0.88, 1.0) * uFlash;
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    const hubCore = new T.Mesh(new T.SphereGeometry(1.22, mobile ? 36 : 48, mobile ? 24 : 32), photo);
    hubCore.userData.id = HUB;
    hub.add(hubCore);
    const hubAir = new T.ShaderMaterial({
      uniforms: { uGain: { value: 0.55 } },
      vertexShader: "varying vec3 vN; varying vec3 vView; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }",
      fragmentShader: "uniform float uGain; varying vec3 vN; varying vec3 vView; void main(){ float fres = pow(1.0 - clamp(dot(normalize(vN), normalize(-vView)), 0.0, 1.0), 2.2); float a = fres * 0.45 * uGain; gl_FragColor = vec4(vec3(0.55, 0.7, 0.95) * a, a); }",
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.BackSide
    });
    const hubShell = new T.Mesh(new T.SphereGeometry(1.48, 28, 18), hubAir);
    hubShell.raycast = function () {};
    hub.add(hubShell);

    const nodesG = new T.Group();
    const edgesG = new T.Group();
    const partsG = new T.Group();
    world.add(edgesG, nodesG, partsG);
    const pickables = [hubCore];
    let N = {};
    let sig = "";
    let parts = [];
    let hubFlash = 0;
    let edgeSel = null;
    const edgeRecs = [];
    const labelEls = [];

    function edgeMat(color, dashed) {
      return new T.ShaderMaterial({
        uniforms: { uColor: { value: new T.Color(color) }, uDash: { value: dashed ? 1 : 0 }, uDim: { value: 1 } },
        vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: `
          uniform vec3 uColor; uniform float uDash; uniform float uDim; varying vec2 vUv;
          void main() {
            float across = pow(clamp(1.0 - abs(vUv.y * 2.0 - 1.0), 0.0, 1.0), 1.7);
            float dash = uDash > 0.5 ? step(0.48, fract(vUv.x * 16.0)) : 1.0;
            float a = across * 0.55 * dash * uDim;
            gl_FragColor = vec4(uColor, a);
          }`,
        transparent: true, depthWrite: false, side: T.DoubleSide
      });
    }

    function worldMats(family, mode, seed) {
      const mat = new T.ShaderMaterial({
        uniforms: {
          uTime: timeU, uSeed: { value: seed * 17.0 }, uFamily: { value: family }, uMode: { value: mode },
          uKey: { value: new T.Vector3(0.4, 0.8, 0.3) }, uFlash: { value: 0 }, uDim: { value: 1 }, uComm: { value: 0 }
        },
        vertexShader: NOISE + `
          uniform float uSeed;
          varying vec3 vN; varying vec3 vObj; varying vec3 vView;
          void main() {
            vec3 obj = normalize(position);
            float n = fbm(obj * 2.4 + uSeed);
            vec3 p = position + normal * (n - 0.5) * 0.05;
            vObj = obj;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            vView = mv.xyz;
            vN = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: NOISE + `
          uniform float uSeed; uniform float uFamily; uniform float uMode; uniform vec3 uKey; uniform float uFlash; uniform float uDim; uniform float uComm;
          varying vec3 vN; varying vec3 vObj; varying vec3 vView;
          void main() {
            vec3 N = normalize(vN);
            vec3 V = normalize(-vView);
            float mu = clamp(dot(N, V), 0.0, 1.0);
            float ndl = clamp(dot(N, normalize(uKey)) * 0.55 + 0.5, 0.0, 1.0);
            float n = fbm(vObj * 2.8 + uSeed);
            vec3 chief = mix(vec3(0.08, 0.09, 0.16), vec3(0.22, 0.16, 0.32), n);
            vec3 worker = mix(vec3(0.05, 0.10, 0.14), vec3(0.10, 0.22, 0.28), n);
            vec3 albedo = uFamily < 0.5 ? chief : worker;
            if (uMode > 2.5) albedo = mix(albedo, vec3(0.16, 0.17, 0.19), 0.78);
            else if (uMode > 1.5) albedo = mix(albedo, vec3(0.32, 0.18, 0.12), 0.35);
            vec3 col = albedo * (0.34 + 0.78 * ndl);
            col += vec3(0.9, 0.94, 1.0) * pow(max(dot(N, normalize(normalize(uKey) + V)), 0.0), 28.0) * ndl * 0.16;
            col += vec3(0.7, 0.8, 1.0) * uComm * 0.35;
            col += vec3(0.85, 0.9, 1.0) * uFlash;
            col *= mix(0.22, 1.0, uDim);
            gl_FragColor = vec4(col, 1.0);
          }`
      });
      const atmo = new T.ShaderMaterial({
        uniforms: {
          uMode: { value: mode }, uComm: { value: 0 }, uDim: { value: 1 }, uBusy: { value: mode > 0.5 && mode < 1.5 ? 1 : 0 },
          uTint: { value: new T.Color(family < 0.5 ? 0xb3a4e0 : 0x7ec4d8) }
        },
        vertexShader: "varying vec3 vN; varying vec3 vView; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }",
        fragmentShader: `
          uniform float uMode; uniform float uComm; uniform float uDim; uniform float uBusy; uniform vec3 uTint;
          varying vec3 vN; varying vec3 vView;
          void main() {
            float fres = pow(1.0 - clamp(dot(normalize(vN), normalize(-vView)), 0.0, 1.0), 2.15);
            vec3 tint = uTint;
            if (uMode > 1.5 && uMode < 2.5) tint = mix(tint, vec3(0.86, 0.58, 0.32), 0.75);
            if (uMode > 2.5) tint *= 0.25;
            float a = fres * (uMode > 2.5 ? 0.12 : 0.55);
            a += fres * uBusy * 0.35;
            a += fres * uComm * 0.7;
            a *= mix(0.35, 1.0, uDim);
            gl_FragColor = vec4(tint * a, a);
          }`,
        transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.BackSide
      });
      const halo = new T.ShaderMaterial({
        uniforms: { uTime: timeU, uDim: { value: 1 } },
        vertexShader: "varying vec3 vN; varying vec3 vView; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }",
        fragmentShader: `
          uniform float uTime; uniform float uDim; varying vec3 vN; varying vec3 vView;
          void main() {
            float fres = pow(1.0 - clamp(dot(normalize(vN), normalize(-vView)), 0.0, 1.0), 2.4);
            float pulse = 0.75 + 0.25 * sin(uTime * 1.3);
            float a = fres * 0.28 * pulse * uDim;
            gl_FragColor = vec4(vec3(0.62, 0.76, 0.95) * a, a);
          }`,
        transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.BackSide
      });
      return { mat: mat, atmo: atmo, halo: halo };
    }

    function disposeObj(o) {
      o.traverse((x) => {
        if (x.geometry && x.userData.ownGeo) x.geometry.dispose();
        if (x.material && x.userData.ownMat) {
          const mats = Array.isArray(x.material) ? x.material : [x.material];
          mats.forEach((m) => m.dispose());
        }
      });
    }
    function clearLabels() {
      labelEls.forEach((el) => el.remove());
      labelEls.length = 0;
    }
    function makeLabel(n) {
      const el = document.createElement("div");
      const off = n.statusKey === "offline";
      const busy = n.statusKey === "working";
      el.className = "space-label" + (off ? " off" : "") + (busy ? " busy" : "") + (n.statusKey === "error" ? " bad" : "");
      const b = document.createElement("b");
      b.textContent = n.label || n.id || "";
      if (n.badge === "外部" || n.badge === "人") {
        const tag = document.createElement("i");
        tag.className = n.badge === "人" ? "tag-human" : "tag-ext";
        tag.textContent = n.badge;
        b.appendChild(tag);
      }
      const comm = document.createElement("i");
      comm.className = "tag-comm";
      comm.textContent = "通信中";
      comm.hidden = true;
      b.appendChild(comm);
      el.appendChild(b);
      const role = document.createElement("small");
      role.textContent = [n.role, n.statusText].filter(Boolean).join(" · ");
      el.appendChild(role);
      if (n.work) {
        const w = document.createElement("small");
        w.className = "work";
        w.textContent = String(n.work).slice(0, 32);
        el.appendChild(w);
      }
      if (n.activity) {
        const a = document.createElement("small");
        a.className = "when";
        a.textContent = n.activity;
        el.appendChild(a);
      }
      if (n.load) {
        const a = document.createElement("small");
        a.className = "when";
        a.textContent = "执行中任务 " + n.load;
        el.appendChild(a);
      }
      const an = n.anomalies && n.anomalies.total;
      if (an) {
        const tag = document.createElement("em");
        tag.textContent = big(an);
        el.appendChild(tag);
      }
      if (n.pending) {
        const tag = document.createElement("em");
        tag.textContent = String(n.pending);
        el.appendChild(tag);
      }
      labelLayer.appendChild(el);
      labelEls.push(el);
      return { el: el, comm: comm };
    }

    function curveBetween(a, b) {
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y += 0.65 + Math.min(1.8, a.distanceTo(b) * 0.06);
      return new T.QuadraticBezierCurve3(a.clone(), mid, b.clone());
    }

    function setData(g) {
      const list = (g.nodes || []).filter((n) => n.id !== HUB);
      const edges = g.edges || [];
      const s = JSON.stringify({
        n: list.map((n) => [n.id, n.label, n.kind, n.statusKey, n.statusText, n.work, n.activity, n.load, n.weight, n.pending, n.anomalies && n.anomalies.total]),
        e: edges.map((e) => [e.source, e.target, e.type, e.task_count, e.evidence, e.state, e.last_at])
      });
      if (s === sig) return;
      sig = s;
      clearLabels();
      [nodesG, edgesG].forEach((grp) => {
        grp.children.slice().forEach((c) => { grp.remove(c); disposeObj(c); });
      });
      edgeRecs.length = 0;
      N = {};
      pickables.length = 1;
      const hubNode = (g.nodes || []).find((n) => n.id === HUB) || { label: "中台", role: "编排", statusText: "在线" };
      const hubLab = makeLabel(Object.assign({ id: HUB, statusKey: "idle" }, hubNode));
      N._hubLabel = hubLab.el;
      N._hubComm = hubLab.comm;
      const placed = layoutOrg(list, edges);
      list.forEach((n) => {
        n._p = placed[n.id] || new T.Vector3(4, 0, 0);
        const on = n.statusKey === "idle" || n.statusKey === "working" || n.statusKey === "error";
        const mode = n.statusKey === "working" ? 1 : n.statusKey === "error" ? 2 : n.statusKey === "offline" ? 3 : 0;
        const family = n.kind === "chief" ? 0 : 1;
        const seed = hashStr(n.id);
        const radius = clamp((n.kind === "chief" ? 0.5 : 0.38) + 0.045 * Math.log2(1 + (n.weight || 0)), 0.36, 0.78);
        const grp = new T.Group();
        grp.position.copy(n._p);
        const mats = worldMats(family, mode, seed);
        const mesh = new T.Mesh(new T.SphereGeometry(radius, mobile ? 24 : 32, mobile ? 16 : 22), mats.mat);
        mesh.userData.id = n.id;
        mesh.userData.ownGeo = true;
        mesh.userData.ownMat = true;
        grp.add(mesh);
        pickables.push(mesh);
        const atmo = new T.Mesh(new T.SphereGeometry(radius * 1.18, 24, 16), mats.atmo);
        atmo.raycast = function () {};
        atmo.userData.ownGeo = true;
        atmo.userData.ownMat = true;
        grp.add(atmo);
        let halo = null;
        if (n.statusKey === "working") {
          halo = new T.Mesh(new T.SphereGeometry(radius * 1.42, 22, 14), mats.halo);
          halo.raycast = function () {};
          halo.userData.ownGeo = true;
          halo.userData.ownMat = true;
          grp.add(halo);
        } else mats.halo.dispose();
        const lab = makeLabel(n);
        const toHub = curveBetween(new T.Vector3(), n._p);
        nodesG.add(grp);
        N[n.id] = {
          group: grp, mesh: mesh, atmo: atmo, halo: halo, mats: mats, curve: toHub,
          data: n, lab: lab.el, comm: lab.comm, r: radius, on: on, busy: n.statusKey === "working"
        };
      });
      edges.forEach((e) => {
        const a = N[e.source], b = N[e.target];
        if (!a || !b) return;
        const curve = curveBetween(a.group.position, b.group.position);
        const hist = e.evidence === "history";
        const mesh = new T.Mesh(ribbonGeo(curve, hist && (e.task_count || 0) > 0 ? 0.045 : 0.03, 28), edgeMat(hist ? 0x8eace8 : 0x7ec4d8, !hist));
        mesh.userData.ownGeo = true;
        mesh.userData.ownMat = true;
        mesh.raycast = function () {};
        edgesG.add(mesh);
        edgeRecs.push({ mesh: mesh, curve: curve, data: e });
      });
      applySel();
      kick();
    }

    function markComm(id, until) {
      if (id === HUB) {
        if (N._hubComm) N._hubComm.hidden = false;
        N._hubUntil = until;
        return;
      }
      const o = N[id];
      if (!o) return;
      o.commUntil = until;
      if (o.comm) o.comm.hidden = false;
      if (o.mats && o.mats.atmo) o.mats.atmo.uniforms.uComm.value = 1;
      if (o.mats) o.mats.mat.uniforms.uComm.value = 1;
    }

    function applySel() {
      const dimOthers = !!(sel && sel !== HUB);
      Object.keys(N).forEach((id) => {
        const o = N[id];
        if (!o || !o.mats) return;
        const focused = sel === id;
        const dim = dimOthers && !focused ? 0.34 : 1;
        o.mats.mat.uniforms.uDim.value = dim;
        o.mats.atmo.uniforms.uDim.value = dim;
        if (o.halo) o.halo.material.uniforms.uDim.value = dim;
        if (o.lab) o.lab.classList.toggle("dim", dim < 0.9 && !focused);
      });
      edgeRecs.forEach((e) => {
        const touch = !sel || sel === HUB || e.data.source === sel || e.data.target === sel || edgeSel === e;
        e.mesh.material.uniforms.uDim.value = touch ? (edgeSel === e ? 1.6 : 1) : 0.18;
      });
      if (N._hubLabel) N._hubLabel.classList.toggle("dim", !!(sel && sel !== HUB));
      photo.uniforms.uFlash.value = sel === HUB ? 0.16 : 0;
      if (sel && (N[sel] || sel === HUB)) {
        const p = sel === HUB ? new T.Vector3() : N[sel].group.position;
        cam.tt.copy(p);
        cam.tr = sel === HUB ? 16 : 11;
      } else if (!edgeSel) {
        cam.tt.set(0, 0, 0);
        cam.tr = 32;
      }
      kick();
    }

    const courierGeo = new T.BufferGeometry();
    courierGeo.setAttribute("position", new T.Float32BufferAttribute([0, 0, 0], 3));
    function courierPoint(color) {
      const mat = new T.ShaderMaterial({
        uniforms: { uColor: { value: new T.Color(color) }, uSize: { value: 9 } },
        vertexShader: "uniform float uSize; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = uSize * (160.0 / max(1.0, -mv.z)); gl_Position = projectionMatrix * mv; }",
        fragmentShader: "uniform vec3 uColor; void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p, p); if (d > 1.0) discard; float a = pow(1.0 - d, 1.5); gl_FragColor = vec4(uColor * a, a); }",
        transparent: true, depthWrite: false, blending: T.AdditiveBlending
      });
      const p = new T.Points(courierGeo, mat);
      p.frustumCulled = false;
      p.userData.ownMat = true;
      return p;
    }
    function spawn(id, dir, color, dur, onDone) {
      const o = N[id];
      if (!o || !o.curve) { if (onDone) onDone(); return; }
      const head = courierPoint(color);
      const trail = [];
      for (let i = 0; i < 5; i++) {
        const t = courierPoint(color);
        t.material.uniforms.uSize.value = 7 - i;
        trail.push(t);
        partsG.add(t);
      }
      partsG.add(head);
      parts.push({ id: id, dir: dir, head: head, trail: trail, t0: performance.now(), dur: dur, onDone: onDone });
      kick();
    }
    function flash(id) {
      const until = performance.now() + 1400;
      if (id === HUB) hubFlash = performance.now();
      else if (N[id]) N[id].flash = performance.now();
      markComm(id, until);
      kick();
    }
    function pulse(from, targets, kind) {
      const color = kind === "ping" ? 0xd7b07a : kind === "alert" ? 0xe07a72 : kind === "event" ? 0xb3a4e0 : 0x8eace8;
      const leg2 = () => { flash(HUB); (targets || []).forEach((t) => spawn(t, 1, color, 900, () => flash(t))); };
      if (opts.reduced) { flash(HUB); if (from) flash(from); (targets || []).forEach(flash); return; }
      if (from && from !== HUB && N[from]) spawn(from, -1, color, 900, leg2);
      else leg2();
    }

    const el = renderer.domElement;
    const ptrs = new Map();
    let downAt = null, pinch0 = 0, r0 = 0;
    const ray = new T.Raycaster();
    const v2 = new T.Vector2();
    function pickNode(cx, cy) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      v2.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(v2, camera);
      const h = ray.intersectObjects(pickables, false)[0];
      return h ? h.object.userData.id : null;
    }
    function pickEdge() {
      let best = null, bestD = Infinity;
      edgeRecs.forEach((e) => {
        for (let i = 0; i <= 10; i++) {
          const p = e.curve.getPoint(i / 10);
          const dist = ray.distanceToPoint(p);
          const reach = Math.max(0.28, p.distanceTo(camera.position) * 0.014);
          if (dist < reach && dist < bestD) { bestD = dist; best = e; }
        }
      });
      return best;
    }
    el.addEventListener("pointerdown", (e) => {
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 非可信事件仍可点选 */ }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      lastInteract = performance.now();
      if (ptrs.size === 2) {
        const both = Array.from(ptrs.values());
        pinch0 = Math.hypot(both[0].x - both[1].x, both[0].y - both[1].y);
        r0 = cam.tr;
      }
    });
    el.addEventListener("pointermove", (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) { hover(e); return; }
      if (ptrs.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const both = Array.from(ptrs.values());
        const d = Math.hypot(both[0].x - both[1].x, both[0].y - both[1].y);
        if (pinch0) cam.tr = clamp(r0 * (pinch0 / d), 6, 78);
      } else {
        cam.theta -= (e.clientX - p.x) * 0.006;
        cam.phi = clamp(cam.phi - (e.clientY - p.y) * 0.005, 0.28, 1.45);
        p.x = e.clientX; p.y = e.clientY;
      }
      lastInteract = performance.now();
      kick();
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (downAt && ptrs.size === 0 && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6 && performance.now() - downAt.t < 500) {
        const id = pickNode(e.clientX, e.clientY);
        if (id) {
          edgeSel = null;
          sel = id;
          applySel();
          if (opts.onSelect) opts.onSelect(id);
        } else {
          const edge = pickEdge();
          if (edge) {
            edgeSel = edge;
            sel = null;
            const mid = edge.curve.getPoint(0.5);
            cam.tt.copy(mid);
            cam.tr = clamp(Math.min(cam.tr, 18), 12, 22);
            applySel();
            if (opts.onEdge) opts.onEdge(edge.data);
          }
        }
      }
      if (ptrs.size < 2) pinch0 = 0;
      downAt = null;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      cam.tr = clamp(cam.tr * (1 + e.deltaY * 0.0011), 6, 78);
      lastInteract = performance.now();
      kick();
    }, { passive: false });
    let hoverId = null, hoverEdge = null, hoverT = 0;
    function nameOf(id) {
      if (id === HUB) return "中台";
      const o = N[id];
      return (o && o.data && o.data.label) || id;
    }
    function hover(e) {
      const t = performance.now();
      if (t - hoverT < 40) return;
      hoverT = t;
      const id = pickNode(e.clientX, e.clientY);
      const edge = id ? null : pickEdge();
      el.style.cursor = id || edge ? "pointer" : "grab";
      if (id !== hoverId || edge !== hoverEdge) { hoverId = id; hoverEdge = edge; kick(); }
      tip.replaceChildren();
      const rect = box.getBoundingClientRect();
      if (id) {
        const b = document.createElement("b");
        const s = document.createElement("span");
        if (id === HUB) { b.textContent = "中台"; s.textContent = "编排 · 在线"; }
        else {
          const n = N[id].data;
          b.textContent = n.label || id;
          const bits = [n.role, n.statusText, n.work, n.activity].filter(Boolean);
          if (n.load) bits.push("执行中任务 " + n.load);
          s.textContent = bits.join(" · ");
        }
        tip.append(b, s);
      } else if (edge) {
        const d = edge.data;
        const b = document.createElement("b");
        b.textContent = nameOf(d.source) + " → " + nameOf(d.target);
        const s = document.createElement("span");
        const ev = d.evidence === "history" ? "历史派发" : d.evidence === "default_route" ? "默认路由" : (d.evidence || "");
        s.textContent = [d.type, (d.task_count || 0) + " 次", ev].filter(Boolean).join(" · ");
        tip.append(b, s);
      } else { tip.hidden = true; return; }
      tip.style.left = (e.clientX - rect.left) + "px";
      tip.style.top = (e.clientY - rect.top) + "px";
      tip.hidden = false;
    }
    el.addEventListener("pointerleave", () => { tip.hidden = true; hoverId = null; hoverEdge = null; });

    const tmp = new T.Vector3();
    function placeLabel(elLab, worldPos, lift) {
      tmp.copy(worldPos);
      tmp.y += lift || 0;
      tmp.project(camera);
      if (tmp.z > 1) { elLab.style.display = "none"; return null; }
      const x = (tmp.x * 0.5 + 0.5) * cssW;
      const y = (-tmp.y * 0.5 + 0.5) * cssH;
      if (x < -40 || y < -40 || x > cssW + 40 || y > cssH + 40) { elLab.style.display = "none"; return null; }
      return { x: x, y: y };
    }
    function layoutLabels() {
      const items = [];
      if (N._hubLabel) {
        const p = placeLabel(N._hubLabel, hub.position, 1.7);
        if (p) items.push({ el: N._hubLabel, p: p, pri: sel === HUB ? 0 : 2 });
      }
      Object.keys(N).forEach((id) => {
        const o = N[id];
        if (!o || !o.lab) return;
        const p = placeLabel(o.lab, o.group.position, o.r * 0.35);
        if (!p) return;
        const pri = sel === id ? 0 : o.busy ? 1 : o.data && o.data.statusKey === "error" ? 2 : 4;
        items.push({ el: o.lab, p: p, pri: pri });
      });
      items.sort((a, b) => a.pri - b.pri);
      const used = [];
      const near = sel && sel !== HUB ? new Set([sel, HUB].concat(edgeRecs.filter((e) => e.data.source === sel || e.data.target === sel).flatMap((e) => [e.data.source, e.data.target]))) : null;
      items.forEach((item) => {
        if (near && item.el !== N._hubLabel && !(N[sel] && item.el === N[sel].lab) && !edgeRecs.some((e) => (e.data.source === sel || e.data.target === sel) && N[e.data.source] && N[e.data.target] && (item.el === N[e.data.source].lab || item.el === N[e.data.target].lab))) {
          if (item.pri > 1) { item.el.style.display = "none"; return; }
        }
        const gapX = item.pri <= 1 ? 72 : 118;
        const gapY = item.pri <= 1 ? 36 : 54;
        if (used.some((u) => Math.abs(u.x - item.p.x) < gapX && Math.abs(u.y - item.p.y) < gapY)) { item.el.style.display = "none"; return; }
        used.push(item.p);
        item.el.style.display = "";
        item.el.style.transform = "translate(" + item.p.x.toFixed(1) + "px," + item.p.y.toFixed(1) + "px) translate(-50%, -120%)";
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
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    const io = new IntersectionObserver((en) => { visible = !!(en[0] && en[0].isIntersecting); if (visible) kick(); }, { threshold: 0.01 });
    io.observe(box);
    const onVis = () => { if (!document.hidden) kick(); };
    document.addEventListener("visibilitychange", onVis);

    function frame(now) {
      raf = 0;
      if (!visible || document.hidden) return;
      const t = now / 1000;
      timeU.value = opts.reduced ? 0 : t;
      const k = opts.reduced ? 1 : 0.08;
      cam.r += (cam.tr - cam.r) * k;
      cam.target.lerp(cam.tt, k);
      camera.position.set(
        cam.target.x + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta),
        cam.target.y + cam.r * Math.cos(cam.phi),
        cam.target.z + cam.r * Math.sin(cam.phi) * Math.sin(cam.theta)
      );
      camera.lookAt(cam.target);
      const inv = camera.matrixWorldInverse;
      const hf = hubFlash ? clamp(1 - (now - hubFlash) / 900, 0, 1) : 0;
      photo.uniforms.uFlash.value = Math.max(sel === HUB ? 0.1 : 0, hf);
      photo.uniforms.uKey.value.copy(keyWorld).transformDirection(inv);
      if (N._hubUntil && now > N._hubUntil && N._hubComm) N._hubComm.hidden = true;
      Object.keys(N).forEach((id) => {
        const o = N[id];
        if (!o || !o.mats) return;
        const f = o.flash ? clamp(1 - (now - o.flash) / 900, 0, 1) : 0;
        o.mats.mat.uniforms.uFlash.value = f;
        o.mats.mat.uniforms.uKey.value.copy(keyWorld).transformDirection(inv);
        const comm = o.commUntil && now < o.commUntil;
        const c = comm ? 1 : 0;
        o.mats.mat.uniforms.uComm.value = c;
        o.mats.atmo.uniforms.uComm.value = c;
        if (o.comm) o.comm.hidden = !comm;
      });
      layoutLabels();
      parts = parts.filter((p) => {
        const o = N[p.id];
        const u = (now - p.t0) / p.dur;
        if (!o || !o.curve || u >= 1) {
          partsG.remove(p.head);
          p.trail.forEach((x) => partsG.remove(x));
          p.head.material.dispose();
          p.trail.forEach((x) => x.material.dispose());
          if (p.onDone) p.onDone();
          return false;
        }
        const at = (uu) => o.curve.getPoint(p.dir > 0 ? clamp(uu, 0, 1) : clamp(1 - uu, 0, 1));
        p.head.position.copy(at(u));
        p.trail.forEach((x, i) => x.position.copy(at(u - (i + 1) * 0.035)));
        return true;
      });
      let drew = false;
      if (bloomOn && bloom) {
        try { bloom.render(scene, camera); drew = true; }
        catch (err) { bloomOn = false; renderer.setRenderTarget(null); }
      }
      if (!drew) { renderer.setRenderTarget(null); renderer.render(scene, camera); }
      const moving = parts.length || Math.abs(cam.tr - cam.r) > 0.03 || cam.target.distanceTo(cam.tt) > 0.03 || (hubFlash && now - hubFlash < 900);
      let live = moving;
      Object.keys(N).forEach((id) => {
        const o = N[id];
        if (o && (o.busy || (o.commUntil && now < o.commUntil) || (o.flash && now - o.flash < 900))) live = true;
      });
      if (visible && !document.hidden && (live || now - lastInteract < 900)) kick();
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    resize();
    kick();

    return {
      setData: setData,
      pulse: pulse,
      select(id) { edgeSel = null; sel = id; applySel(); },
      reset() { sel = null; edgeSel = null; cam.tr = 32; cam.tt.set(0, 0, 0); applySel(); },
      dispose() {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        clearLabels();
        if (bloom) bloom.dispose();
        scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m) => m.dispose && m.dispose());
          }
        });
        renderer.dispose();
        el.remove();
        labelLayer.remove();
        tip.remove();
      }
    };
  }

  window.SB3D = { create: create, version: "4.0.0" };
})();
