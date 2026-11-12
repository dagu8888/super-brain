/* Super-Brain 协作中枢 v2 · 协作网 3.0
   中台是程序化光球（米粒、对流、日冕、耀斑、赤道机械环），Agent 是各自不同的星体。
   连线是细的引力索 / 等离子体，光点只在真实消息到达时沿索飞行。
   不使用 MeshBasicMaterial。WebGL 不可用时由 app.js 退回平面。 */
(function () {
  "use strict";
  const T = window.THREE;
  if (!T) return;
  const HUB = "__hub__";
  const LIVE = { working: "执行中", idle: "在线", degraded: "在场但回执失败", offline: "离线", unused: "未接入", disabled: "已暂停" };
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
  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.4);
    a *= 0.5;
  }
  return s;
}
vec3 spinY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
`;

  const FULL_VS = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

  function makeBloom(renderer) {
    const pars = { minFilter: T.LinearFilter, magFilter: T.LinearFilter, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false };
    const rtScene = new T.WebGLRenderTarget(2, 2, Object.assign({ depthBuffer: true }, pars));
    const rtA = new T.WebGLRenderTarget(2, 2, pars);
    const rtB = new T.WebGLRenderTarget(2, 2, pars);
    const quadScene = new T.Scene();
    const quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const thresh = new T.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.78 }, uSoft: { value: 0.18 } },
      vertexShader: FULL_VS,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uThreshold;
        uniform float uSoft;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float l = max(c.r, max(c.g, c.b));
          float s = smoothstep(uThreshold, uThreshold + uSoft, l);
          gl_FragColor = vec4(c * s, 1.0);
        }
      `,
      depthTest: false, depthWrite: false
    });
    const blur = new T.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new T.Vector2() } },
      vertexShader: FULL_VS,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 uDir;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv) * 0.227027;
          c += texture2D(tDiffuse, vUv + uDir * 1.384615) * 0.316216;
          c += texture2D(tDiffuse, vUv - uDir * 1.384615) * 0.316216;
          c += texture2D(tDiffuse, vUv + uDir * 3.230769) * 0.070270;
          c += texture2D(tDiffuse, vUv - uDir * 3.230769) * 0.070270;
          gl_FragColor = c;
        }
      `,
      depthTest: false, depthWrite: false
    });
    const comp = new T.ShaderMaterial({
      uniforms: { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: 0.95 } },
      vertexShader: FULL_VS,
      fragmentShader: `
        uniform sampler2D tScene;
        uniform sampler2D tBloom;
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          vec3 base = texture2D(tScene, vUv).rgb;
          vec3 bloom = texture2D(tBloom, vUv).rgb;
          vec3 col = base + bloom * uStrength;
          float vig = smoothstep(1.05, 0.28, length(vUv - 0.5));
          col *= mix(0.72, 1.0, vig);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthTest: false, depthWrite: false
    });
    const quad = new T.Mesh(new T.PlaneGeometry(2, 2), thresh);
    quad.frustumCulled = false;
    quadScene.add(quad);
    let bw = 2, bh = 2;
    function pass(mat, target) {
      quad.material = mat;
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCam);
    }
    function blurTo(src, dst, dirx, diry) {
      blur.uniforms.tDiffuse.value = src.texture;
      blur.uniforms.uDir.value.set(dirx, diry);
      pass(blur, dst);
    }
    return {
      strength: comp.uniforms.uStrength,
      resize(w, h) {
        const W = Math.max(2, w | 0), H = Math.max(2, h | 0);
        rtScene.setSize(W, H);
        bw = Math.max(2, (W * 0.5) | 0);
        bh = Math.max(2, (H * 0.5) | 0);
        rtA.setSize(bw, bh);
        rtB.setSize(bw, bh);
      },
      render(scene, camera) {
        const prev = renderer.autoClear;
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
        renderer.autoClear = prev;
      },
      dispose() {
        rtScene.dispose(); rtA.dispose(); rtB.dispose();
        thresh.dispose(); blur.dispose(); comp.dispose();
        quad.geometry.dispose();
      }
    };
  }

  function annulus(inner, outer, seg) {
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      pos.push(c * inner, 0, s * inner, c * outer, 0, s * outer);
      const u = i / seg;
      uv.push(u, 0, u, 1);
    }
    for (let i = 0; i < seg; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
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
      if (i < n - 1) {
        const a = o;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    g.setAttribute("uv", new T.BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  function create(box, opts) {
    opts = opts || {};
    const mobile = !!opts.mobile;
    const dprCap = mobile ? 1 : 1.25;
    const renderer = new T.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance", failIfMajorPerformanceCaveat: false });
    if (!renderer.getContext()) throw new Error("WebGL 不可用");
    renderer.setClearColor(0x05070e, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.domElement.setAttribute("aria-label", "3D 协作网拓扑，可拖拽旋转，点星体看详情");
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
    const camera = new T.PerspectiveCamera(48, 1, 0.08, 420);
    const cam = { theta: 0.62, phi: 1.05, r: 34, tr: 34, target: new T.Vector3(), tt: new T.Vector3() };
    let cssW = 1, cssH = 1, lastInteract = 0, sel = null, raf = 0, visible = true, bloomOn = !mobile;
    let bloom = null;
    try { bloom = makeBloom(renderer); } catch (err) { bloomOn = false; bloom = null; }

    const world = new T.Group();
    scene.add(world);
    const farSpin = new T.Group();
    const nearSpin = new T.Group();
    scene.add(farSpin);
    scene.add(nearSpin);

    const starMat = new T.ShaderMaterial({
      uniforms: { uTime: timeU, uSize: { value: mobile ? 1.15 : 1.45 } },
      vertexShader: `
        attribute float aPhase;
        attribute float aSize;
        uniform float uTime;
        uniform float uSize;
        varying float vPh;
        varying float vTw;
        void main() {
          vPh = aPhase;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float tw = 0.72 + 0.28 * sin(uTime * 1.7 + aPhase);
          vTw = tw;
          float ps = aSize * uSize * tw * (260.0 / max(12.0, -mv.z));
          gl_PointSize = clamp(ps, 0.0, 5.5);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying float vPh;
        varying float vTw;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float d = dot(p, p);
          if (d > 1.0) discard;
          float core = pow(clamp(1.0 - d, 0.0, 1.0), 1.35);
          vec3 col = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.90, 0.72), sin(vPh) * 0.5 + 0.5);
          gl_FragColor = vec4(col * core * (0.85 + 0.35 * vTw), 1.0);
        }
      `,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });
    function starLayer(parent, n, radius, size, spreadY) {
      const pos = new Float32Array(n * 3);
      const phase = new Float32Array(n);
      const sizes = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const r = radius[0] + Math.pow(Math.random(), 0.65) * (radius[1] - radius[0]);
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.cos(ph) * spreadY;
        pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        phase[i] = Math.random() * 6.28318;
        sizes[i] = size * (0.45 + Math.random() * (Math.random() < 0.04 ? 2.8 : 1));
      }
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(pos, 3));
      g.setAttribute("aPhase", new T.BufferAttribute(phase, 1));
      g.setAttribute("aSize", new T.BufferAttribute(sizes, 1));
      const pts = new T.Points(g, starMat);
      pts.frustumCulled = false;
      parent.add(pts);
      return pts;
    }
    const starCount = mobile ? 1600 : 4200;
    starLayer(farSpin, Math.floor(starCount * 0.62), [80, 220], 1.05, 0.85);
    starLayer(nearSpin, Math.floor(starCount * 0.28), [40, 90], 1.55, 0.7);
    starLayer(world, Math.floor(starCount * 0.1), [18, 36], 1.1, 0.35);

    const nebulaMat = (color, scale) => new T.ShaderMaterial({
      uniforms: { uTime: timeU, uColor: { value: new T.Color(color) }, uScale: { value: scale } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: NOISE + `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uScale;
        varying vec2 vUv;
        void main() {
          vec2 q = vUv * 2.0 - 1.0;
          float rad = dot(q, q);
          if (rad > 1.0) discard;
          float z0 = sqrt(max(0.0, 1.0 - rad));
          float dens = 0.0;
          vec3 p = vec3(q * uScale, z0);
          for (int i = 0; i < 3; i++) {
            dens += fbm(p + uTime * 0.012 + float(i) * 2.1) * (0.62 / float(i + 1));
            p.z += 0.42;
            p.xy *= 1.35;
          }
          float edge = smoothstep(1.0, 0.35, rad);
          float a = smoothstep(0.38, 0.8, dens) * edge * 1.65;
          vec3 col = mix(uColor, vec3(1.0, 0.95, 0.88), smoothstep(0.7, 1.0, dens));
          gl_FragColor = vec4(col * a, a);
        }
      `,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide
    });
    function nebula(x, y, z, s, color, sc) {
      const m = new T.Mesh(new T.PlaneGeometry(s, s), nebulaMat(color, sc));
      m.position.set(x, y, z);
      m.userData.billboard = true;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    }
    const nebulas = [
      nebula(-16, 7, -26, 36, 0x7a5cff, 2.2),
      nebula(22, -4, -32, 42, 0xd45288, 1.8),
      nebula(-6, 12, -40, 48, 0x3a96d8, 1.6)
    ];

    const dustN = mobile ? 280 : 700;
    const dustPos = new Float32Array(dustN * 3);
    const dustPh = new Float32Array(dustN);
    for (let i = 0; i < dustN; i++) {
      const r = 3 + Math.random() * 22;
      const a = Math.random() * Math.PI * 2;
      dustPos[i * 3] = Math.cos(a) * r;
      dustPos[i * 3 + 1] = (Math.random() - 0.5) * 2.4;
      dustPos[i * 3 + 2] = Math.sin(a) * r;
      dustPh[i] = Math.random() * 6.28;
    }
    const dustGeo = new T.BufferGeometry();
    dustGeo.setAttribute("position", new T.BufferAttribute(dustPos, 3));
    dustGeo.setAttribute("aPhase", new T.BufferAttribute(dustPh, 1));
    dustGeo.setAttribute("aSize", new T.BufferAttribute(new Float32Array(dustN).fill(0.85), 1));
    world.add(new T.Points(dustGeo, starMat));

    /* 中台光球。可见表面是 photosphere 着色器，不是纯色球体。 */
    const hub = new T.Group();
    world.add(hub);
    const photo = new T.ShaderMaterial({
      uniforms: { uTime: timeU, uFlash: { value: 0 } },
      vertexShader: `
        varying vec3 vN;
        varying vec3 vObj;
        varying vec3 vView;
        void main() {
          vObj = normalize(position);
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: NOISE + `
        uniform float uTime;
        uniform float uFlash;
        varying vec3 vN;
        varying vec3 vObj;
        varying vec3 vView;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(-vView);
          float mu = clamp(dot(N, V), 0.0, 1.0);
          vec3 sp = spinY(vObj, uTime * 0.05);
          vec3 warp = sp * 3.4 + fbm(sp * 2.1 + uTime * 0.07) * 0.55;
          float g = fbm(warp * 3.6 + vec3(0.0, uTime * 0.045, 0.0));
          float cells = smoothstep(0.38, 0.74, g);
          float lane = smoothstep(0.16, 0.0, abs(g - 0.46));
          vec3 dark = vec3(0.42, 0.08, 0.015);
          vec3 mid = vec3(0.98, 0.55, 0.12);
          vec3 hot = vec3(1.0, 0.95, 0.78);
          vec3 col = mix(dark, mid, cells);
          col = mix(col, hot, smoothstep(0.68, 0.95, g) * 0.85);
          col *= mix(0.55, 1.0, 1.0 - lane * 0.45);
          float spot = fbm(sp * 1.15 + uTime * 0.02);
          col *= 0.78 + 0.42 * spot;
          float limb = pow(mu, 0.5);
          col *= mix(0.22, 1.18, limb);
          col += vec3(1.0, 0.86, 0.55) * uFlash;
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    const hubCore = new T.Mesh(new T.SphereGeometry(1.62, mobile ? 40 : 56, mobile ? 28 : 40), photo);
    hubCore.userData.id = HUB;
    hub.add(hubCore);

    function coronaShell(scale, gain, speed) {
      const mat = new T.ShaderMaterial({
        uniforms: { uTime: timeU, uGain: { value: gain }, uSpeed: { value: speed } },
        vertexShader: `
          varying vec3 vN;
          varying vec3 vObj;
          varying vec3 vView;
          void main() {
            vObj = normalize(position);
            vN = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = mv.xyz;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: NOISE + `
          uniform float uTime;
          uniform float uGain;
          uniform float uSpeed;
          varying vec3 vN;
          varying vec3 vObj;
          varying vec3 vView;
          void main() {
            vec3 N = normalize(vN);
            vec3 V = normalize(-vView);
            float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.15);
            float n = fbm(vObj * 2.4 + uTime * uSpeed);
            float a = fres * (0.35 + 0.9 * n) * uGain;
            vec3 col = mix(vec3(1.0, 0.42, 0.08), vec3(1.0, 0.86, 0.55), fres);
            gl_FragColor = vec4(col * a, a);
          }
        `,
        transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.FrontSide
      });
      const mesh = new T.Mesh(new T.SphereGeometry(1.62 * scale, 36, 24), mat);
      mesh.raycast = function () {};
      mesh.renderOrder = 2;
      return mesh;
    }
    hub.add(coronaShell(1.18, 0.55, 0.05), coronaShell(1.62, 0.28, 0.03), coronaShell(2.25, 0.14, 0.02));

    const flareMat = new T.ShaderMaterial({
      uniforms: { uTime: timeU, uAmt: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uAmt;
        varying vec2 vUv;
        void main() {
          float y = abs(vUv.y - 0.5) * 2.0;
          float spine = exp(-y * y * 10.0);
          float along = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.15, vUv.x);
          float a = spine * along * uAmt;
          gl_FragColor = vec4(vec3(1.0, 0.72, 0.32) * a, a);
        }
      `,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide
    });
    const flare = new T.Mesh(new T.PlaneGeometry(4.8, 0.55), flareMat);
    flare.raycast = function () {};
    flare.position.set(2.1, 0.2, 0);
    flare.renderOrder = 3;
    hub.add(flare);
    let nextFlare = 2.5, flareT = -10;

    function machineRing(inner, outer, tilt, speed, tint) {
      const mat = new T.ShaderMaterial({
        uniforms: { uTime: timeU, uTint: { value: new T.Color(tint) }, uSpeed: { value: speed } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform float uTime;
          uniform vec3 uTint;
          uniform float uSpeed;
          varying vec2 vUv;
          void main() {
            float a = vUv.x * 6.28318;
            float teeth = step(0.42, fract(a * 9.0));
            float across = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
            float flow = 0.45 + 0.55 * sin(a * 18.0 - uTime * uSpeed);
            float pulse = smoothstep(0.92, 1.0, fract(vUv.x * 3.0 - uTime * 0.08));
            float alpha = (0.18 + 0.55 * teeth * flow + pulse * 0.8) * across;
            gl_FragColor = vec4(uTint * alpha * 1.4, alpha);
          }
        `,
        transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide
      });
      const mesh = new T.Mesh(annulus(inner, outer, 160), mat);
      mesh.rotation.x = tilt;
      mesh.userData.spin = speed > 0 ? 0.12 : -0.08;
      mesh.raycast = function () {};
      return mesh;
    }
    const ringA = machineRing(2.55, 2.78, Math.PI / 2.35, 3.2, 0xf5c451);
    const ringB = machineRing(3.15, 3.28, Math.PI / 1.75, -2.1, 0x7fd4ff);
    hub.add(ringA, ringB);

    const nodesG = new T.Group();
    world.add(nodesG);
    const edgesG = new T.Group();
    world.add(edgesG);
    const partsG = new T.Group();
    world.add(partsG);
    const pickables = [hubCore];
    let N = {};
    let sig = "";
    let parts = [];
    let hubFlash = 0;
    const labelEls = [];

    const tetherMat = (color, hot) => new T.ShaderMaterial({
      uniforms: { uTime: timeU, uColor: { value: new T.Color(color) }, uHot: { value: hot ? 1 : 0 }, uDim: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uHot;
        uniform float uDim;
        varying vec2 vUv;
        void main() {
          float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
          across = pow(clamp(across, 0.0, 1.0), 1.6);
          float flow = 0.35 + 0.65 * pow(clamp(sin(vUv.x * 28.0 - uTime * (1.4 + uHot)), 0.0, 1.0), 4.0);
          float a = across * (0.10 + 0.16 * uHot + 0.22 * flow) * uDim;
          gl_FragColor = vec4(uColor * a * 1.8, a);
        }
      `,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide
    });

    function bodyKind(n, seed) {
      if (n.live === "unused" || n.live === "disabled") return 5;
      if (n.kind === "chief") return 1;
      const k = Math.floor(seed * 4);
      return k === 0 ? 0 : k === 1 ? 2 : k === 2 ? 3 : 4;
    }
    function planetMaterials(kind, mode, seed, spin) {
      const mat = new T.ShaderMaterial({
        uniforms: {
          uTime: timeU, uSeed: { value: seed * 20.0 }, uType: { value: kind }, uMode: { value: mode },
          uToStar: { value: new T.Vector3(1, 0, 0) }, uLights: { value: mode < 1.5 ? 1 : 0 },
          uFlash: { value: 0 }, uDim: { value: 1 }, uSpin: { value: spin }, uRelief: { value: kind === 1 ? 0.0 : kind === 5 ? 0.22 : 0.08 }
        },
        vertexShader: NOISE + `
          uniform float uTime; uniform float uSeed; uniform float uRelief; uniform float uSpin;
          varying vec3 vN; varying vec3 vObj; varying vec3 vView;
          void main() {
            vec3 obj = normalize(position);
            vec3 sp = spinY(obj, uTime * uSpin);
            float n = fbm(sp * 2.3 + uSeed);
            vec3 p = position + normal * (n - 0.45) * uRelief;
            vObj = obj;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            vView = mv.xyz;
            vN = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: NOISE + `
          uniform float uTime; uniform float uSeed; uniform float uType; uniform float uMode;
          uniform vec3 uToStar; uniform float uLights; uniform float uFlash; uniform float uDim; uniform float uSpin;
          varying vec3 vN; varying vec3 vObj; varying vec3 vView;
          void main() {
            vec3 N = normalize(vN);
            vec3 L = normalize(uToStar);
            float ndl = dot(N, L);
            float day = smoothstep(-0.05, 0.42, ndl);
            vec3 sp = spinY(vObj, uTime * uSpin) * 2.7 + uSeed;
            float n = fbm(sp);
            float n2 = fbm(sp * 2.2 + 3.0);
            float lat = vObj.y;
            vec3 albedo = vec3(0.2);
            if (uType < 0.5) {
              float land = smoothstep(0.46, 0.58, n);
              float cap = smoothstep(0.68, 0.9, abs(lat));
              vec3 ocean = vec3(0.04, 0.16, 0.26);
              vec3 ground = mix(vec3(0.13, 0.28, 0.12), vec3(0.34, 0.28, 0.14), n2);
              albedo = mix(ocean, ground, land);
              albedo = mix(albedo, vec3(0.86, 0.9, 0.93), cap);
            } else if (uType < 1.5) {
              float b = sin(lat * 16.0 + fbm(vec3(uSeed, lat * 4.0, uTime * 0.05)) * 2.2) * 0.5 + 0.5;
              vec3 c1 = vec3(0.55, 0.16, 0.32);
              vec3 c2 = vec3(0.95, 0.62, 0.38);
              vec3 c3 = vec3(0.18, 0.05, 0.12);
              albedo = mix(c3, mix(c1, c2, b), 0.9);
              float storm = smoothstep(0.7, 0.92, fbm(sp * 1.3));
              albedo = mix(albedo, vec3(0.95, 0.84, 0.72), storm * 0.5);
            } else if (uType < 2.5) {
              float crev = smoothstep(0.4, 0.7, n2);
              albedo = mix(vec3(0.55, 0.78, 0.86), vec3(0.18, 0.32, 0.42), crev);
              albedo = mix(albedo, vec3(0.92, 0.96, 1.0), smoothstep(0.55, 0.85, abs(lat)));
            } else if (uType < 3.5) {
              albedo = mix(vec3(0.45, 0.28, 0.12), vec3(0.72, 0.48, 0.22), n);
              albedo = mix(albedo, vec3(0.2, 0.1, 0.06), smoothstep(0.62, 0.8, n2) * 0.7);
            } else if (uType < 4.5) {
              albedo = mix(vec3(0.08, 0.05, 0.05), vec3(0.28, 0.08, 0.05), n2);
              float lava = smoothstep(0.62, 0.82, n);
              albedo = mix(albedo, vec3(1.0, 0.42, 0.08), lava);
            } else {
              albedo = mix(vec3(0.10, 0.11, 0.13), vec3(0.28, 0.30, 0.34), n2);
            }
            if (uMode > 1.5) albedo = mix(albedo, vec3(0.14, 0.16, 0.20), 0.82);
            else if (uMode > 0.5) albedo = mix(albedo, vec3(0.75, 0.40, 0.12), 0.42);
            vec3 night = vec3(0.004, 0.005, 0.01);
            if (uLights > 0.5 && uType < 0.5) {
              float city = smoothstep(0.64, 0.84, fbm(sp * 7.0)) * (1.0 - smoothstep(0.42, 0.62, n));
              night += vec3(1.0, 0.78, 0.4) * city * 1.6;
            }
            if (uType > 3.5 && uType < 4.5 && uLights > 0.5) {
              night += vec3(1.0, 0.35, 0.05) * smoothstep(0.6, 0.85, n) * 0.8;
            }
            if (uLights < 0.5) night *= 0.25;
            vec3 col = mix(night, albedo, day);
            float term = smoothstep(0.0, 0.12, abs(ndl)) * (1.0 - smoothstep(0.12, 0.45, abs(ndl)));
            col += vec3(1.0, 0.45, 0.12) * term * (uMode > 1.5 ? 0.05 : 0.28);
            vec3 V = normalize(-vView);
            vec3 H = normalize(L + V);
            float spec = pow(max(dot(N, H), 0.0), uType < 1.5 && uType > 0.5 ? 18.0 : 40.0) * day;
            col += vec3(1.0, 0.95, 0.85) * spec * (uType < 1.5 && uType > 0.5 ? 0.35 : 0.12);
            col += vec3(1.0, 0.9, 0.65) * uFlash;
            col *= mix(0.18, 1.0, uDim);
            gl_FragColor = vec4(col, 1.0);
          }
        `
      });
      const cloud = new T.ShaderMaterial({
        uniforms: { uTime: timeU, uSeed: { value: seed * 9.0 }, uMode: { value: mode }, uSpin: { value: spin * 1.3 }, uDim: { value: 1 }, uToStar: mat.uniforms.uToStar },
        vertexShader: `
          varying vec3 vObj; varying vec3 vN; varying vec3 vView;
          void main() {
            vObj = normalize(position);
            vN = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = mv.xyz;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: NOISE + `
          uniform float uTime; uniform float uSeed; uniform float uMode; uniform float uSpin; uniform float uDim; uniform vec3 uToStar;
          varying vec3 vObj; varying vec3 vN; varying vec3 vView;
          void main() {
            vec3 sp = spinY(vObj, uTime * uSpin);
            float c = fbm(sp * 3.1 + uSeed);
            float a = smoothstep(0.5, 0.74, c);
            float day = smoothstep(-0.1, 0.45, dot(normalize(vN), normalize(uToStar)));
            if (uMode > 1.5) a *= 0.12;
            a *= 0.62 * mix(0.25, 1.0, uDim);
            vec3 col = vec3(0.92, 0.95, 0.98) * (0.2 + 0.85 * day) * a;
            gl_FragColor = vec4(col, a);
          }
        `,
        transparent: true, depthWrite: false
      });
      const atmo = new T.ShaderMaterial({
        uniforms: {
          uTime: timeU, uMode: { value: mode }, uBusy: { value: 0 }, uDim: { value: 1 },
          uTint: { value: new T.Color(kind === 1 ? 0xff8ab8 : kind === 2 ? 0xb7f4ff : kind === 4 ? 0xff7840 : 0x8fd0ff) },
          uToStar: mat.uniforms.uToStar, uSeed: { value: seed * 4.0 }
        },
        vertexShader: `
          varying vec3 vObj; varying vec3 vN; varying vec3 vView;
          void main() {
            vObj = normalize(position);
            vN = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = mv.xyz;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: NOISE + `
          uniform float uTime; uniform float uMode; uniform float uBusy; uniform float uDim; uniform vec3 uTint; uniform vec3 uToStar; uniform float uSeed;
          varying vec3 vObj; varying vec3 vN; varying vec3 vView;
          void main() {
            vec3 N = normalize(vN);
            vec3 V = normalize(-vView);
            float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.3);
            float day = smoothstep(-0.2, 0.5, dot(N, normalize(uToStar)));
            float aurora = 0.0;
            if (uBusy > 0.5) {
              float a = fbm(vec3(vObj.x * 4.0, vObj.y * 9.0 + uTime * 0.55, uSeed));
              aurora = smoothstep(0.52, 0.86, a) * pow(abs(vObj.y), 1.2);
            }
            float alpha = fres * (0.25 + 0.75 * day) * (uMode > 1.5 ? 0.16 : 0.85);
            alpha += aurora * 0.85;
            alpha *= mix(0.3, 1.0, uDim);
            vec3 col = uTint * fres + vec3(0.45, 1.0, 0.72) * aurora + vec3(1.0, 0.8, 0.3) * aurora * 0.4;
            gl_FragColor = vec4(col * alpha, alpha);
          }
        `,
        transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.BackSide
      });
      return { mat, cloud, atmo };
    }

    function gasRing(r, col) {
      const mat = new T.ShaderMaterial({
        uniforms: { uTime: timeU, uColor: { value: new T.Color(col) }, uDim: { value: 1 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform float uTime; uniform vec3 uColor; uniform float uDim; varying vec2 vUv;
          void main() {
            float bands = 0.55 + 0.45 * sin(vUv.y * 48.0 + vUv.x * 12.0);
            float a = bands * smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.82, vUv.y) * 0.55 * uDim;
            gl_FragColor = vec4(uColor * a, a);
          }
        `,
        transparent: true, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending
      });
      const mesh = new T.Mesh(annulus(r * 1.45, r * 2.15, 80), mat);
      mesh.rotation.x = Math.PI / 2.2;
      mesh.raycast = function () {};
      return mesh;
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

    function makeLabel(name, sub, badge, on, busy) {
      const el = document.createElement("div");
      el.className = "space-label" + (on ? "" : " off") + (busy ? " busy" : "");
      const b = document.createElement("b");
      b.textContent = name;
      if (badge === "外部" || badge === "人") {
        const tag = document.createElement("i");
        tag.className = badge === "人" ? "tag-human" : "tag-ext";
        tag.textContent = badge;
        b.appendChild(tag);
      }
      const s = document.createElement("small");
      s.textContent = sub || "";
      el.append(b, s);
      labelLayer.appendChild(el);
      labelEls.push(el);
      return el;
    }

    function setData(g) {
      const list = (g.nodes || []).filter((n) => n.id !== HUB);
      const hubNode = (g.nodes || []).find((n) => n.id === HUB);
      const s = JSON.stringify(list.map((n) => [n.id, n.label, n.kind, n.live, n.working, n.msgs, n.tasks, n.anomalies && n.anomalies.total, n.sub, n.pending, n.badge, n.external]));
      if (s === sig && N._hubSub === (hubNode && hubNode.sub)) return;
      sig = s;
      clearLabels();
      [nodesG, edgesG].forEach((grp) => {
        grp.children.slice().forEach((c) => { grp.remove(c); disposeObj(c); });
      });
      N = {};
      pickables.length = 1;
      const hubLabel = makeLabel("中台", (hubNode && hubNode.sub) || "在线 · 消息总线", "", true, false);
      N._hubLabel = hubLabel;
      N._hubSub = hubNode && hubNode.sub;
      const chiefs = list.filter((n) => n.kind === "chief");
      const workers = list.filter((n) => n.kind !== "chief");
      const place = (arr, R, y0) => arr.forEach((n, i) => {
        const a = -Math.PI / 2 + (i / Math.max(1, arr.length)) * Math.PI * 2;
        n._p = new T.Vector3(Math.cos(a) * R, y0 + Math.sin(a * 2 + i) * 1.05, Math.sin(a) * R);
      });
      place(chiefs, 9.2, 0.4);
      place(workers, 15.4, -0.6);
      list.forEach((n) => {
        const on = n.live === "idle" || n.live === "working" || n.live === "degraded";
        const cold = !on;
        const mode = cold ? 2 : n.live === "degraded" ? 1 : 0;
        const seed = hashStr(n.id);
        const kind = bodyKind(n, seed);
        const spin = 0.05 + seed * 0.12;
        const radius = clamp((n.kind === "chief" ? 0.62 : 0.42) + 0.08 * Math.log2(1 + (n.weight || 0)), 0.38, n.kind === "chief" ? 1.15 : 0.86);
        const grp = new T.Group();
        grp.position.copy(n._p);
        const mats = planetMaterials(kind, mode, seed, cold ? spin * 0.15 : spin);
        const toStar = n._p.clone().negate().normalize();
        mats.mat.uniforms.uToStar.value.copy(toStar);
        const mesh = new T.Mesh(new T.SphereGeometry(radius, mobile ? 28 : 40, mobile ? 20 : 28), mats.mat);
        mesh.userData.id = n.id;
        mesh.userData.ownGeo = true;
        mesh.userData.ownMat = true;
        grp.add(mesh);
        pickables.push(mesh);
        let cloud = null;
        if (kind !== 5) {
          cloud = new T.Mesh(new T.SphereGeometry(radius * 1.035, 28, 20), mats.cloud);
          cloud.raycast = function () {};
          cloud.userData.ownGeo = true;
          cloud.userData.ownMat = true;
          grp.add(cloud);
        } else mats.cloud.dispose();
        const atmo = new T.Mesh(new T.SphereGeometry(radius * 1.16, 28, 20), mats.atmo);
        atmo.raycast = function () {};
        atmo.userData.ownGeo = true;
        atmo.userData.ownMat = true;
        grp.add(atmo);
        let ring = null;
        if (kind === 1 || (kind === 2 && seed > 0.72)) {
          ring = gasRing(radius, kind === 1 ? 0xffb0d0 : 0xc6f6ff);
          ring.userData.ownGeo = true;
          ring.userData.ownMat = true;
          grp.add(ring);
        }
        let moon = null;
        if (n.kind === "chief" || seed > 0.62) {
          const mr = radius * 0.28;
          const moonMat = planetMaterials(seed > 0.5 ? 5 : 2, mode, seed + 0.3, spin * 0.5);
          moonMat.cloud.dispose();
          moonMat.atmo.dispose();
          moon = new T.Mesh(new T.SphereGeometry(mr, 16, 12), moonMat.mat);
          moon.userData.ownGeo = true;
          moon.userData.ownMat = true;
          moon.userData.orbit = radius * 2.35;
          moon.userData.phase = seed * 6.28;
          moon.userData.mat = moonMat.mat;
          moon.raycast = function () {};
          grp.add(moon);
        }
        const busy = !!(n.working && on);
        mats.atmo.uniforms.uBusy.value = busy ? 1 : 0;
        const badge = n.badge === "外部" || n.external || n.kind === "external" ? "外部" : (n.badge === "人" ? "人" : "");
        const lab = makeLabel(n.label || n.id, n.sub || LIVE[n.live] || "", badge, on, busy);
        const an = n.anomalies && n.anomalies.total;
        if (an) {
          const tag = document.createElement("em");
          tag.className = "tag-alert";
          tag.textContent = big(an);
          lab.appendChild(tag);
        }
        if (n.pending) {
          const tag = document.createElement("em");
          tag.className = "tag-pend";
          tag.textContent = String(n.pending);
          lab.appendChild(tag);
        }
        const mid = n._p.clone().multiplyScalar(0.5);
        mid.y += 1.6 + n._p.length() * 0.05;
        const curve = new T.QuadraticBezierCurve3(new T.Vector3(0, 0, 0), mid, n._p.clone());
        const hot = (n.msgs || 0) > 0;
        const edge = new T.Mesh(ribbonGeo(curve, hot ? 0.055 : 0.03, 42), tetherMat(hot ? 0xf5c451 : 0x7ec8ff, hot));
        edge.userData.ownGeo = true;
        edge.userData.ownMat = true;
        edge.renderOrder = 1;
        edgesG.add(edge);
        nodesG.add(grp);
        N[n.id] = { group: grp, mesh, cloud, atmo, ring, moon, mats, curve, edge, data: n, lab, r: radius, on, busy, toStar };
      });
      applySel();
      kick();
    }

    function applySel() {
      const dimOthers = sel && sel !== HUB;
      Object.entries(N).forEach(([id, o]) => {
        if (!o || !o.mats) return;
        const dim = (dimOthers && id !== sel) || (sel === HUB) ? (id === sel ? 1 : 0.28) : 1;
        const focused = sel === id;
        o.mats.mat.uniforms.uDim.value = focused ? 1 : dim;
        if (o.mats.cloud) o.mats.cloud.uniforms.uDim.value = focused ? 1 : dim;
        o.mats.atmo.uniforms.uDim.value = focused ? 1 : dim;
        if (o.ring) o.ring.material.uniforms.uDim.value = focused ? 1 : dim;
        if (o.moon) o.moon.userData.mat.uniforms.uDim.value = focused ? 1 : dim;
        o.edge.material.uniforms.uDim.value = focused ? 1.4 : dim;
        if (o.lab) o.lab.classList.toggle("dim", dim < 0.9 && !focused);
      });
      if (N._hubLabel) N._hubLabel.classList.toggle("dim", !!(sel && sel !== HUB));
      photo.uniforms.uFlash.value = sel === HUB ? 0.18 : 0;
      if (sel && (N[sel] || sel === HUB)) {
        const p = sel === HUB ? new T.Vector3() : N[sel].group.position;
        cam.tt.copy(p);
        cam.tr = sel === HUB ? 16 : 11;
      } else {
        cam.tt.set(0, -0.2, 0);
        cam.tr = 34;
      }
      kick();
    }

    const courierGeo = new T.BufferGeometry();
    courierGeo.setAttribute("position", new T.Float32BufferAttribute([0, 0, 0], 3));
    function courierPoint(color) {
      const mat = new T.ShaderMaterial({
        uniforms: { uColor: { value: new T.Color(color) }, uSize: { value: 8 } },
        vertexShader: `uniform float uSize; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = uSize * (180.0 / max(1.0, -mv.z)); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform vec3 uColor; void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p,p); if (d>1.0) discard; float a = pow(1.0-d, 1.4); gl_FragColor = vec4(uColor * a, a); }`,
        transparent: true, depthWrite: false, blending: T.AdditiveBlending
      });
      const p = new T.Points(courierGeo, mat);
      p.frustumCulled = false;
      p.userData.ownMat = true;
      return p;
    }
    function spawn(id, dir, color, dur, onDone) {
      const o = N[id];
      if (!o || !o.curve) { onDone && onDone(); return; }
      const head = courierPoint(color);
      head.material.uniforms.uSize.value = 14;
      const trail = [];
      for (let i = 0; i < 7; i++) {
        const t = courierPoint(color);
        t.material.uniforms.uSize.value = 9 - i;
        trail.push(t);
        partsG.add(t);
      }
      partsG.add(head);
      parts.push({ id, dir, head, trail, t0: performance.now(), dur, onDone });
      kick();
    }
    function flash(id) {
      if (id === HUB) hubFlash = performance.now();
      else if (N[id]) N[id].flash = performance.now();
      kick();
    }
    function pulse(from, targets, kind) {
      const color = kind === "ping" ? 0xffdf8a : kind === "alert" ? 0xff4d5e : kind === "event" ? 0xc8d2ff : 0x8fe3ff;
      const leg2 = () => { flash(HUB); (targets || []).forEach((t) => spawn(t, 1, color, 1100, () => flash(t))); };
      if (opts.reduced) { flash(HUB); if (from) flash(from); (targets || []).forEach(flash); return; }
      if (from && from !== HUB && N[from]) spawn(from, -1, color, 1100, leg2);
      else leg2();
    }

    const el = renderer.domElement;
    const ptrs = new Map();
    let downAt = null, pinch0 = 0, r0 = 0;
    const ray = new T.Raycaster();
    const v2 = new T.Vector2();
    function pick(cx, cy) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      v2.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(v2, camera);
      const h = ray.intersectObjects(pickables, false)[0];
      return h ? h.object.userData.id : null;
    }
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      lastInteract = performance.now();
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
        r0 = cam.tr;
      }
    });
    el.addEventListener("pointermove", (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) { hover(e); return; }
      if (ptrs.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch0) cam.tr = clamp(r0 * (pinch0 / d), 7, 78);
      } else {
        cam.theta -= (e.clientX - p.x) * 0.006;
        cam.phi = clamp(cam.phi - (e.clientY - p.y) * 0.005, 0.22, 1.45);
        p.x = e.clientX; p.y = e.clientY;
      }
      lastInteract = performance.now();
      kick();
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
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      cam.tr = clamp(cam.tr * (1 + e.deltaY * 0.0011), 7, 78);
      lastInteract = performance.now();
      kick();
    }, { passive: false });
    el.addEventListener("keydown", (e) => {
      const step = { ArrowLeft: [0.12, 0], ArrowRight: [-0.12, 0], ArrowUp: [0, -0.08], ArrowDown: [0, 0.08] }[e.key];
      if (step) { cam.theta += step[0]; cam.phi = clamp(cam.phi + step[1], 0.22, 1.45); e.preventDefault(); kick(); }
      if (e.key === "+" || e.key === "=") { cam.tr = clamp(cam.tr * 0.9, 7, 78); kick(); }
      if (e.key === "-") { cam.tr = clamp(cam.tr * 1.1, 7, 78); kick(); }
    });
    let hoverId = null, hoverT = 0;
    function hover(e) {
      const t = performance.now();
      if (t - hoverT < 40) return;
      hoverT = t;
      const id = pick(e.clientX, e.clientY);
      el.style.cursor = id ? "pointer" : "grab";
      if (id !== hoverId) { hoverId = id; kick(); }
      tip.replaceChildren();
      if (!id) { tip.hidden = true; return; }
      const rect = box.getBoundingClientRect();
      const b = document.createElement("b");
      const s = document.createElement("span");
      if (id === HUB) { b.textContent = "中台"; s.textContent = "在线 · 消息总线 · 点开看队列与连线"; }
      else {
        const n = N[id].data;
        const an = n.anomalies || {};
        b.textContent = n.label || id;
        s.textContent = (n.sub || LIVE[n.live] || n.live) + " · 24h 消息 " + (n.msgs || 0) + " · 异常 " + big(an.total || 0);
      }
      tip.append(b, s);
      tip.style.left = (e.clientX - rect.left) + "px";
      tip.style.top = (e.clientY - rect.top) + "px";
      tip.hidden = false;
    }
    el.addEventListener("pointerleave", () => { tip.hidden = true; hoverId = null; });

    const tmp = new T.Vector3();
    const tmp2 = new T.Vector3();
    const side = new T.Vector3();
    function placeLabel(elLab, world, lift) {
      tmp.copy(world);
      tmp.y += lift || 0;
      tmp.project(camera);
      if (tmp.z > 1) { elLab.style.opacity = "0"; return; }
      const x = (tmp.x * 0.5 + 0.5) * cssW;
      const y = (-tmp.y * 0.5 + 0.5) * cssH;
      elLab.style.opacity = "";
      elLab.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px) translate(-50%, -120%)";
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
      const idle = now - lastInteract > 5000 && !sel && !opts.reduced;
      if (idle) cam.theta += 0.00055;
      const breathe = !opts.reduced && idle ? Math.sin(t * 0.35) * 0.65 : 0;
      const k = opts.reduced ? 1 : 0.075;
      cam.r += (cam.tr + breathe - cam.r) * k;
      cam.target.lerp(cam.tt, k);
      const bob = opts.reduced ? 0 : Math.sin(t * 0.22) * 0.04;
      camera.position.set(
        cam.target.x + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta),
        cam.target.y + cam.r * Math.cos(cam.phi + bob),
        cam.target.z + cam.r * Math.sin(cam.phi) * Math.sin(cam.theta)
      );
      camera.lookAt(cam.target);
      camera.updateMatrixWorld(true);
      const invCam = camera.matrixWorldInverse;
      farSpin.rotation.y = cam.theta * 0.08;
      nearSpin.rotation.y = cam.theta * 0.18;
      nearSpin.rotation.x = cam.phi * 0.05;
      nebulas.forEach((m) => m.quaternion.copy(camera.quaternion));
      if (!opts.reduced && t > nextFlare) { flareT = t; nextFlare = t + 6.5 + Math.random() * 7; }
      const fAge = t - flareT;
      const fAmt = fAge > 0 && fAge < 1.6 ? Math.sin(Math.min(1, fAge / 1.6) * Math.PI) : 0;
      flareMat.uniforms.uAmt.value = opts.reduced ? 0 : fAmt;
      if (fAmt > 0) {
        const ang = t * 0.37;
        flare.position.set(Math.cos(ang) * 2.15, Math.sin(ang * 0.6) * 0.7, Math.sin(ang) * 2.15);
        flare.lookAt(camera.position);
      }
      ringA.rotation.z += opts.reduced ? 0 : 0.0025;
      ringB.rotation.z -= opts.reduced ? 0 : 0.0018;
      const hf = hubFlash ? clamp(1 - (now - hubFlash) / 900, 0, 1) : 0;
      photo.uniforms.uFlash.value = Math.max(sel === HUB ? 0.12 : 0, hf);
      Object.entries(N).forEach(([id, o]) => {
        if (!o || !o.mats) return;
        const f = o.flash ? clamp(1 - (now - o.flash) / 900, 0, 1) : 0;
        o.mats.mat.uniforms.uFlash.value = f;
        if (o.toStar) o.mats.mat.uniforms.uToStar.value.copy(o.toStar).transformDirection(invCam);
        if (o.moon) {
          const ang = o.moon.userData.phase + t * (opts.reduced ? 0 : 0.35);
          const rad = o.moon.userData.orbit;
          o.moon.position.set(Math.cos(ang) * rad, Math.sin(ang * 0.7) * rad * 0.25, Math.sin(ang) * rad);
          tmp2.copy(o.group.position).add(o.moon.position).negate().normalize();
          o.moon.userData.mat.uniforms.uToStar.value.copy(tmp2).transformDirection(invCam);
        }
        if (o.lab) {
          side.set(1, 0.15, 0).applyQuaternion(camera.quaternion).multiplyScalar(o.r * 1.15);
          tmp.copy(o.group.position).add(side);
          placeLabel(o.lab, tmp, o.r * 0.2);
        }
      });
      if (N._hubLabel) placeLabel(N._hubLabel, hub.position, 2.5);
      parts = parts.filter((p) => {
        const o = N[p.id];
        const u = (now - p.t0) / p.dur;
        if (!o || !o.curve || u >= 1) {
          partsG.remove(p.head); p.trail.forEach((x) => partsG.remove(x));
          p.head.material.dispose(); p.trail.forEach((x) => x.material.dispose());
          if (p.onDone) p.onDone();
          return false;
        }
        const at = (uu) => o.curve.getPoint(p.dir > 0 ? clamp(uu, 0, 1) : clamp(1 - uu, 0, 1));
        p.head.position.copy(at(u));
        p.trail.forEach((x, i) => x.position.copy(at(u - (i + 1) * 0.028)));
        return true;
      });
      let drew = false;
      if (bloomOn && bloom) {
        try { bloom.render(scene, camera); drew = true; }
        catch (err) { bloomOn = false; renderer.setRenderTarget(null); }
      }
      if (!drew) { renderer.setRenderTarget(null); renderer.render(scene, camera); }
      const moving = true;
      if (moving && visible && !document.hidden) kick();
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    resize();
    kick();

    return {
      setData, pulse,
      select(id) { sel = id; applySel(); },
      reset() { sel = null; cam.tr = 34; cam.tt.set(0, -0.2, 0); applySel(); },
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

  window.SB3D = { create, version: "3.0.0" };
})();
