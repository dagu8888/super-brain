/* Super-Brain 协作中枢 · 知识宇宙 2.8
   结构仍是知识库接口返回的文档和 [[wikilink]]，不编造笔记、不给未解析双链造节点。
   实线 = 解析到本文档集里的双链。团块和虚线 = 同分类 / 同标签的推断分组。
   展开深度 1–8 级，默认 8，首页尽量密。发光只服务这条数字神经：星点、晕光、星云。
   单击沿邻域探索，双击打开原文。没有 WebGL 时退回同一套平面图。 */
(function () {
  "use strict";
  const T = window.THREE;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function catColor(category) {
    const c = String(category || "").toLowerCase();
    if (c.indexOf("concept") >= 0) return [0.56, 0.70, 0.93];
    if (c.indexOf("decision") >= 0) return [0.64, 0.56, 0.86];
    if (c.indexOf("playbook") >= 0) return [0.45, 0.74, 0.80];
    if (c.indexOf("staging") >= 0 || c.indexOf("暂存") >= 0) return [0.80, 0.60, 0.40];
    return [0.58, 0.66, 0.78];
  }

  function matchDoc(d, q) {
    if (!q) return true;
    const blob = [d.title, d.path, d.category, d.type, d.snippet, (d.tags || []).join(" ")].join(" ").toLowerCase();
    return blob.indexOf(q) >= 0;
  }

  function folderName(path) {
    const parts = String(path || "").split("/");
    return parts.length >= 2 ? parts[parts.length - 2] : "";
  }

  function createModel() {
    let nodes = [];
    let wiki = [];
    let query = "";
    let filter = { category: "", tag: "", type: "" };
    let focus = -1;
    let hop = 8;

    function addKey(map, raw, i) {
      const key = String(raw || "").trim().toLowerCase();
      if (key && !map.has(key)) map.set(key, i);
    }

    function setDocs(docs) {
      nodes = (docs || []).map((doc, i) => ({
        i: i,
        doc: doc,
        title: doc.title || doc.path || "未命名",
        category: doc.category || "未分类",
        tags: Array.isArray(doc.tags) ? doc.tags.filter(Boolean) : [],
        type: doc.type || "",
        links: Array.isArray(doc.links) ? doc.links : [],
        wiki: [],
        unresolved: [],
        degree: 0,
        x: 0, y: 0, z: 0,
        size: 0.32,
        color: catColor(doc.category || ""),
        anchor: { x: 0, y: 0, z: 0 }
      }));
      const by = new Map();
      nodes.forEach((n) => {
        const path = String(n.doc.path || "");
        addKey(by, path, n.i);
        addKey(by, path.replace(/\.md$/i, ""), n.i);
        addKey(by, n.title, n.i);
        addKey(by, path.split("/").pop().replace(/\.md$/i, ""), n.i);
      });
      function resolve(name) {
        const key = String(name || "").trim().toLowerCase();
        return by.has(key) ? by.get(key) : -1;
      }
      wiki = [];
      const seenE = new Set();
      nodes.forEach((n) => {
        const neigh = new Set();
        n.links.forEach((name) => {
          const j = resolve(name);
          if (j < 0) { n.unresolved.push(name); return; }
          if (j === n.i) return;
          neigh.add(j);
          const a = Math.min(n.i, j);
          const b = Math.max(n.i, j);
          const ek = a + ":" + b;
          if (!seenE.has(ek)) { seenE.add(ek); wiki.push({ a: a, b: b, kind: "wikilink" }); }
        });
        n.wiki = Array.from(neigh);
      });
      nodes.forEach((n) => {
        const back = new Set(n.wiki);
        wiki.forEach((e) => {
          if (e.a === n.i) back.add(e.b);
          if (e.b === n.i) back.add(e.a);
        });
        n.wiki = Array.from(back);
        n.degree = n.wiki.length;
        n.size = clamp(0.28 + 0.11 * Math.sqrt(n.degree), 0.28, 0.62);
      });
      layout();
      focus = -1;
      hop = 8;
    }

    function layout() {
      const groups = {};
      nodes.forEach((n) => { (groups[n.category] = groups[n.category] || []).push(n); });
      const names = Object.keys(groups).sort();
      names.forEach((name, gi) => {
        const ang = (gi / Math.max(1, names.length)) * Math.PI * 2 - Math.PI / 2;
        const anchor = {
          x: Math.cos(ang) * 8.2,
          y: gi % 2 === 0 ? 1.35 : -1.15,
          z: Math.sin(ang) * 8.2 * 0.92
        };
        const items = groups[name];
        const spread = 1.35 + Math.sqrt(items.length) * 0.85;
        items.forEach((n, i) => {
          const a = (i / Math.max(1, items.length)) * Math.PI * 2 + gi * 0.35;
          const rad = items.length === 1 ? 0.2 : spread * (0.62 + (i % 2) * 0.38);
          n.x = anchor.x + Math.cos(a) * rad;
          n.y = anchor.y + ((i % 3) - 1) * 0.72;
          n.z = anchor.z + Math.sin(a) * rad;
          n.anchor = anchor;
        });
      });
    }

    function passes(n) {
      if (!n) return false;
      if (filter.category && n.category !== filter.category) return false;
      if (filter.tag && n.tags.indexOf(filter.tag) < 0) return false;
      if (filter.type && n.type !== filter.type) return false;
      return true;
    }

    function groupNeighbors(i) {
      const n = nodes[i];
      if (!n) return [];
      const tags = {};
      n.tags.forEach((t) => { tags[t] = 1; });
      const out = [];
      nodes.forEach((m) => {
        if (m.i === i) return;
        if (m.category && m.category === n.category) { out.push({ i: m.i, reason: "同分类" }); return; }
        if (m.tags.some((t) => tags[t])) out.push({ i: m.i, reason: "同标签" });
      });
      return out;
    }

    function neighborhood(hops) {
      const seen = new Set();
      if (focus < 0 || !nodes[focus]) return seen;
      seen.add(focus);
      let wikiFront = [focus];
      let groupFront = [focus];
      for (let h = 0; h < hops; h++) {
        const newWiki = [];
        wikiFront.forEach((id) => {
          (nodes[id].wiki || []).forEach((j) => {
            if (!seen.has(j)) { seen.add(j); newWiki.push(j); }
          });
        });
        groupFront.forEach((id) => {
          groupNeighbors(id).forEach((g) => {
            if (!seen.has(g.i)) seen.add(g.i);
          });
        });
        wikiFront = newWiki;
        groupFront = newWiki;
      }
      return seen;
    }

    function visibleMask() {
      const local = focus >= 0 ? neighborhood(Math.max(1, hop)) : null;
      return nodes.map((n) => passes(n) && (!local || local.has(n.i)));
    }

    function canExpand() {
      if (focus < 0) return false;
      const now = neighborhood(hop);
      const nxt = neighborhood(hop + 1);
      for (const i of nxt) {
        if (!now.has(i) && passes(nodes[i])) return true;
      }
      return false;
    }

    function inferredEdges(depth, visible) {
      const out = [];
      const seen = new Set();
      const limit = Math.max(1, Math.min(8, depth || 1));
      nodes.forEach((n) => {
        if (visible && !visible[n.i]) return;
        let taken = 0;
        groupNeighbors(n.i).forEach((g) => {
          if (taken >= limit) return;
          if (visible && !visible[g.i]) return;
          if ((n.wiki || []).indexOf(g.i) >= 0) return;
          const a = Math.min(n.i, g.i);
          const b = Math.max(n.i, g.i);
          const key = a + ":" + b;
          if (seen.has(key)) return;
          seen.add(key);
          taken += 1;
          out.push({ a: a, b: b, kind: "inferred", reason: g.reason });
        });
      });
      return out;
    }

    function snapshot() {
      const visible = visibleMask();
      const q = query.trim().toLowerCase();
      const hits = nodes.map((n) => matchDoc(n.doc, q));
      const wikiVis = wiki.filter((e) => visible[e.a] && visible[e.b]);
      const inferred = inferredEdges(hop, visible);
      const byCat = {};
      nodes.forEach((n) => { if (visible[n.i]) (byCat[n.category] = byCat[n.category] || []).push(n); });
      const groups = Object.keys(byCat).map((name) => {
        const items = byCat[name];
        const a = items[0].anchor || { x: 0, y: 0, z: 0 };
        let max = 1.4;
        items.forEach((n) => { max = Math.max(max, Math.hypot(n.x - a.x, n.z - a.z) + 1.05); });
        return { name: name, x: a.x, y: a.y, z: a.z, r: max, color: catColor(name), count: items.length };
      });
      let fly = -1;
      if (q) {
        for (let i = 0; i < nodes.length; i++) if (hits[i] && visible[i]) { fly = i; break; }
      }
      if (fly < 0 && focus >= 0 && visible[focus]) fly = focus;
      const n = nodes[focus];
      const card = n && visible[focus] ? {
        doc: n.doc,
        hop: hop,
        canExpand: canExpand(),
        wiki: n.wiki.filter((j) => visible[j]).map((j) => nodes[j].doc),
        inferred: groupNeighbors(focus).filter((g) => visible[g.i] && n.wiki.indexOf(g.i) < 0).map((g) => ({ doc: nodes[g.i].doc, reason: g.reason })),
        unresolved: n.unresolved.slice(),
        visibleCount: visible.filter(Boolean).length
      } : null;
      return {
        nodes: nodes, visible: visible, hits: hits, wikiVis: wikiVis, inferred: inferred,
        groups: groups, focus: focus, hop: hop, query: q, fly: fly, card: card
      };
    }

    return {
      setDocs: setDocs,
      snapshot: snapshot,
      setQuery(q) { query = q || ""; },
      setFilter(f) {
        filter = { category: (f && f.category) || "", tag: (f && f.tag) || "", type: (f && f.type) || "" };
        if (focus >= 0 && nodes[focus] && !passes(nodes[focus])) focus = -1;
      },
      focusAt(i) { if (nodes[i] && passes(nodes[i])) focus = i; },
      indexOfPath(path) { return nodes.findIndex((n) => n.doc && n.doc.path === path); },
      expand() { if (hop < 8) hop += 1; },
      setDepth(n) { hop = Math.max(1, Math.min(8, n | 0)); },
      reset() { focus = -1; hop = 8; },
      facets() {
        const categories = [], tags = [], types = [];
        const sc = new Set(), st = new Set(), sy = new Set();
        nodes.forEach((n) => {
          if (n.category && !sc.has(n.category)) { sc.add(n.category); categories.push(n.category); }
          n.tags.forEach((t) => { if (t && !st.has(t)) { st.add(t); tags.push(t); } });
          if (n.type && !sy.has(n.type)) { sy.add(n.type); types.push(n.type); }
        });
        categories.sort(); tags.sort(); types.sort();
        return { categories: categories, tags: tags, types: types };
      },
      node(i) { return nodes[i] || null; }
    };
  }

  const FULL_VS = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

  function makeBloom(renderer) {
    const pars = { minFilter: T.LinearFilter, magFilter: T.LinearFilter, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false };
    const rtScene = new T.WebGLRenderTarget(2, 2, Object.assign({ depthBuffer: true }, pars));
    const rtA = new T.WebGLRenderTarget(2, 2, pars);
    const rtB = new T.WebGLRenderTarget(2, 2, pars);
    const quadScene = new T.Scene();
    const quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const thresh = new T.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.42 }, uSoft: { value: 0.22 } },
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
      uniforms: { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: 0.92 } },
      vertexShader: FULL_VS,
      fragmentShader: "uniform sampler2D tScene; uniform sampler2D tBloom; uniform float uStrength; varying vec2 vUv; void main(){ vec3 col = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength; float vig = smoothstep(1.05, 0.28, length(vUv - 0.5)); col *= mix(0.78, 1.0, vig); gl_FragColor = vec4(col, 1.0); }",
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
        comp.uniforms.tScene.value = rtScene.texture;
        comp.uniforms.tBloom.value = rtA.texture;
        pass(comp, null);
      },
      dispose() { rtScene.dispose(); rtA.dispose(); rtB.dispose(); thresh.dispose(); blur.dispose(); comp.dispose(); quad.geometry.dispose(); }
    };
  }

  function labelOf(n, nodes) {
    const dup = nodes.some((m) => m !== n && m.title === n.title);
    const folder = folderName(n.doc.path);
    return {
      title: dup && folder ? n.title + " · " + folder : n.title,
      sub: [n.category, n.type, n.degree ? "双链 " + n.degree : ""].filter(Boolean).join(" · ")
    };
  }

  function createGL(box, opts, bridge) {
    const mobile = !!opts.mobile;
    const renderer = new T.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!renderer.getContext()) throw new Error("WebGL 不可用");
    renderer.setClearColor(0x0c121c, 1);
    const dprCap = mobile ? 1 : 1.25;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.domElement.setAttribute("aria-label", "知识宇宙，拖拽环绕，单击沿关系探索，双击打开文档");
    renderer.domElement.tabIndex = 0;
    box.appendChild(renderer.domElement);
    const labelLayer = document.createElement("div");
    labelLayer.className = "space-labels";
    box.appendChild(labelLayer);

    const timeU = { value: 0 };
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(46, 1, 0.08, 240);
    const root = new T.Group();
    scene.add(root);
    const volG = new T.Group();
    const nodeG = new T.Group();
    const lineG = new T.Group();
    root.add(volG, nodeG, lineG);

    let bloom = null, bloomOn = !opts.reduced;
    try { if (bloomOn) bloom = makeBloom(renderer); } catch (e) { bloomOn = false; bloom = null; }

    const starMat = new T.ShaderMaterial({
      uniforms: { uGain: { value: 0.92 } },
      vertexShader: "attribute float aSize; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(aSize * (180.0 / max(8.0, -mv.z)), 0.0, 2.4); gl_Position = projectionMatrix * mv; }",
      fragmentShader: "uniform float uGain; void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p, p); if (d > 1.0) discard; float a = pow(1.0 - d, 1.6) * uGain; gl_FragColor = vec4(vec3(0.75, 0.82, 0.92) * a, a); }",
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });
    const starN = mobile ? 640 : 1500;
    const sPos = new Float32Array(starN * 3);
    const sSize = new Float32Array(starN);
    for (let i = 0; i < starN; i++) {
      const u = ((i * 97) % 1000) / 1000;
      const v = ((i * 57) % 1000) / 1000;
      const th = u * Math.PI * 2;
      const ph = Math.acos(2 * v - 1);
      const r = 28 + ((i * 13) % 20);
      sPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      sPos[i * 3 + 1] = r * Math.cos(ph) * 0.72;
      sPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      sSize[i] = 0.7 + (i % 5) * 0.15;
    }
    const sg = new T.BufferGeometry();
    sg.setAttribute("position", new T.BufferAttribute(sPos, 3));
    sg.setAttribute("aSize", new T.BufferAttribute(sSize, 1));
    const stars = new T.Points(sg, starMat);
    stars.frustumCulled = false;
    stars.raycast = function () {};
    scene.add(stars);

    const volMat = new T.ShaderMaterial({
      uniforms: { uColor: { value: new T.Color(0.5, 0.6, 0.8) } },
      vertexShader: "varying vec3 vN; varying vec3 vView; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }",
      fragmentShader: "uniform vec3 uColor; varying vec3 vN; varying vec3 vView; void main(){ float mu = clamp(dot(normalize(vN), normalize(-vView)), 0.0, 1.0); float rim = pow(1.0 - mu, 1.35); float a = rim * 0.42; gl_FragColor = vec4(uColor, a); }",
      transparent: true, depthWrite: false, side: T.BackSide
    });
    const volGeo = new T.SphereGeometry(1, 22, 16);

    const haloMat = new T.ShaderMaterial({
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
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vGlow; varying vec3 vN; varying vec3 vView;
        void main() {
          float fres = pow(1.0 - clamp(dot(normalize(vN), normalize(-vView)), 0.0, 1.0), 1.45);
          float a = fres * 0.72 * clamp(vGlow, 0.0, 1.2);
          if (a < 0.03) discard;
          gl_FragColor = vec4(vColor * a, a);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.BackSide
    });

    const nodeMat = new T.ShaderMaterial({
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
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vGlow; varying vec3 vN; varying vec3 vView;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(-vView);
          float mu = clamp(dot(N, V), 0.0, 1.0);
          if (mu < 0.03) discard;
          float rim = pow(1.0 - mu, 2.2);
          vec3 col = vColor * (0.55 + 0.95 * mu);
          col += vColor * pow(mu, 2.2) * 0.9;
          col += vec3(0.82, 0.88, 0.98) * pow(mu, 10.0) * 0.42;
          col += vColor * rim * 0.55;
          col *= 0.72 + 0.4 * clamp(vGlow, 0.0, 1.25);
          gl_FragColor = vec4(col, 1.0);
        }`,
      transparent: false
    });
    const nodeGeo = new T.SphereGeometry(1, 20, 14);

    let docMesh = null;
    let haloMesh = null;
    let docSig = "";
    let snap = { nodes: [], visible: [], hits: [], wikiVis: [], inferred: [], groups: [], focus: -1, query: "" };
    let hover = -1;
    const labelPool = [];
    const cam = { theta: 0.42, phi: 0.86, r: 26, ttheta: 0.42, tphi: 0.86, tr: 26, target: new T.Vector3(), tt: new T.Vector3() };
    let fly = null, raf = 0, visible = true, cssW = 1, cssH = 1;
    const ray = new T.Raycaster();
    const v2 = new T.Vector2();
    const ndc = new T.Vector3();
    const el = renderer.domElement;

    function clearGroup(g) {
      g.children.slice().forEach((c) => {
        g.remove(c);
        if (c.geometry && c.userData.ownGeo) c.geometry.dispose();
        if (c.material && c.userData.ownMat) {
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          mats.forEach((m) => m.dispose());
        }
      });
    }

    function buildVolumes() {
      clearGroup(volG);
      (snap.groups || []).forEach((g) => {
        const mat = volMat.clone();
        mat.uniforms.uColor.value = new T.Color(g.color[0], g.color[1], g.color[2]);
        const mesh = new T.Mesh(volGeo, mat);
        mesh.position.set(g.x, g.y, g.z);
        mesh.scale.setScalar(g.r);
        mesh.raycast = function () {};
        mesh.userData.ownMat = true;
        volG.add(mesh);
      });
    }

    function buildNodes() {
      if (docMesh) {
        nodeG.remove(docMesh);
        if (docMesh.geometry !== nodeGeo) docMesh.geometry.dispose();
        docMesh = null;
      }
      if (haloMesh) {
        nodeG.remove(haloMesh);
        if (haloMesh.geometry !== nodeGeo) haloMesh.geometry.dispose();
        haloMesh = null;
      }
      const list = snap.nodes || [];
      if (!list.length) return;
      function meshWith(mat) {
        const geo = nodeGeo.clone();
        const colors = new Float32Array(list.length * 3);
        const glows = new Float32Array(list.length);
        list.forEach((n, i) => {
          colors[i * 3] = n.color[0]; colors[i * 3 + 1] = n.color[1]; colors[i * 3 + 2] = n.color[2];
          glows[i] = 1;
        });
        geo.setAttribute("aColor", new T.InstancedBufferAttribute(colors, 3));
        geo.setAttribute("aGlow", new T.InstancedBufferAttribute(glows, 1));
        const mesh = new T.InstancedMesh(geo, mat, list.length);
        mesh.frustumCulled = false;
        if (mat === haloMat) mesh.raycast = function () {};
        nodeG.add(mesh);
        return mesh;
      }
      haloMesh = meshWith(haloMat);
      docMesh = meshWith(nodeMat);
    }

    function paintOne(mesh, scaleOf) {
      if (!mesh) return;
      const glow = mesh.geometry.getAttribute("aGlow");
      const dummy = new T.Object3D();
      const focusNode = snap.focus >= 0 ? snap.nodes[snap.focus] : null;
      const hoverNode = hover >= 0 ? snap.nodes[hover] : null;
      snap.nodes.forEach((n, i) => {
        const on = !!(snap.visible && snap.visible[i]);
        let g = on ? 0.9 : 0;
        if (on && snap.query && snap.hits && !snap.hits[i]) g = 0.28;
        if (on && focusNode && focusNode.wiki && focusNode.wiki.indexOf(i) >= 0) g = Math.max(g, 1.1);
        if (on && hoverNode && (i === hover || hoverNode.wiki.indexOf(i) >= 0)) g = Math.max(g, 1.25);
        if (on && i === snap.focus) g = 1.15;
        glow.setX(i, g);
        dummy.position.set(n.x, n.y, n.z);
        dummy.scale.setScalar(on ? scaleOf(n) : 0.0001);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      glow.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
    }
    function paintNodes() {
      paintOne(haloMesh, (n) => n.size * 2.35);
      paintOne(docMesh, (n) => n.size);
    }

    function segmentLine(pairs, colorOf, dashed) {
      if (!pairs.length) return;
      const pos = new Float32Array(pairs.length * 2 * 3);
      const col = new Float32Array(pairs.length * 2 * 3);
      pairs.forEach((e, i) => {
        const a = snap.nodes[e.a], b = snap.nodes[e.b];
        if (!a || !b) return;
        const c = colorOf(e);
        const o = i * 6;
        pos[o] = a.x; pos[o + 1] = a.y; pos[o + 2] = a.z;
        pos[o + 3] = b.x; pos[o + 4] = b.y; pos[o + 5] = b.z;
        for (let k = 0; k < 2; k++) {
          col[i * 6 + k * 3] = c[0]; col[i * 6 + k * 3 + 1] = c[1]; col[i * 6 + k * 3 + 2] = c[2];
        }
      });
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(pos, 3));
      geo.setAttribute("color", new T.BufferAttribute(col, 3));
      const mat = dashed
        ? new T.LineDashedMaterial({ vertexColors: true, transparent: true, opacity: 0.72, dashSize: 0.22, gapSize: 0.16 })
        : new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, blending: T.AdditiveBlending });
      const line = new T.LineSegments(geo, mat);
      if (dashed) line.computeLineDistances();
      line.userData.ownGeo = true;
      line.userData.ownMat = true;
      line.raycast = function () {};
      lineG.add(line);
    }

    function edgeSparks(pairs, gain) {
      if (!pairs.length) return;
      const pos = [];
      const col = [];
      pairs.forEach((e) => {
        const a = snap.nodes[e.a], b = snap.nodes[e.b];
        if (!a || !b) return;
        const tint = e.kind === "inferred" ? [0.84, 0.66, 0.42] : [0.72, 0.84, 0.98];
        for (let k = 1; k <= 3; k++) {
          const t = k / 4;
          pos.push(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
          col.push(tint[0], tint[1], tint[2]);
        }
      });
      if (!pos.length) return;
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
      geo.setAttribute("color", new T.Float32BufferAttribute(col, 3));
      const mat = new T.PointsMaterial({
        size: 0.11 + gain, vertexColors: true, transparent: true, opacity: 0.9,
        depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true
      });
      const pts = new T.Points(geo, mat);
      pts.userData.ownGeo = true;
      pts.userData.ownMat = true;
      pts.raycast = function () {};
      pts.frustumCulled = false;
      lineG.add(pts);
    }

    function buildLines() {
      clearGroup(lineG);
      const hot = (e) => (e.a === hover || e.b === hover || e.a === snap.focus || e.b === snap.focus);
      segmentLine(snap.wikiVis || [], (e) => hot(e) ? [0.86, 0.93, 1.0] : [0.55, 0.72, 0.92], false);
      segmentLine(snap.inferred || [], (e) => hot(e) ? [0.95, 0.78, 0.5] : [0.78, 0.62, 0.4], true);
      edgeSparks(snap.wikiVis || [], 0.04);
      edgeSparks(snap.inferred || [], 0);
    }

    function sync(next) {
      const sig = (next.nodes || []).map((n) => n.doc.path).join("|");
      snap = next;
      if (sig !== docSig) { docSig = sig; buildNodes(); }
      buildVolumes();
      paintNodes();
      buildLines();
      kick();
    }

    function placeLabels() {
      const list = [];
      const focusNode = snap.focus >= 0 ? snap.nodes[snap.focus] : null;
      (snap.nodes || []).forEach((n, i) => {
        if (!snap.visible || !snap.visible[i]) return;
        let pri = 5;
        if (i === snap.focus) pri = 0;
        else if (i === hover) pri = 1;
        else if (snap.query && snap.hits && snap.hits[i]) pri = 2;
        else if (focusNode && focusNode.wiki.indexOf(i) >= 0) pri = 3;
        else if (n.degree) pri = 4;
        root.updateWorldMatrix(true, false);
        ndc.set(n.x, n.y, n.z);
        root.localToWorld(ndc);
        const dist = ndc.distanceTo(camera.position);
        if (snap.focus < 0 && dist > 52 && pri > 4) return;
        list.push({ n: n, i: i, pri: pri, dist: dist, world: ndc.clone() });
      });
      list.sort((a, b) => a.pri - b.pri || a.dist - b.dist);
      const cap = snap.focus >= 0 ? 36 : 48;
      while (labelPool.length < Math.min(cap, list.length)) {
        const elLab = document.createElement("div");
        elLab.className = "space-label galaxy-label";
        const b = document.createElement("b");
        const sm = document.createElement("small");
        elLab.append(b, sm);
        labelLayer.appendChild(elLab);
        labelPool.push(elLab);
      }
      const used = [];
      let shown = 0;
      labelPool.forEach((elLab) => { elLab.style.display = "none"; });
      list.forEach((item) => {
        if (shown >= cap) return;
        ndc.copy(item.world).project(camera);
        if (ndc.z > 1) return;
        const x = (ndc.x * 0.5 + 0.5) * cssW;
        const y = (-ndc.y * 0.5 + 0.5) * cssH;
        if (x < -30 || y < -30 || x > cssW + 30 || y > cssH + 30) return;
        const gap = item.pri <= 1 ? 36 : 50;
        const gapX = item.pri <= 1 ? 70 : 108;
        const gapY = item.pri <= 1 ? 28 : 40;
        if (used.some((p) => Math.abs(p.x - x) < gapX && Math.abs(p.y - y) < gapY)) return;
        used.push({ x: x, y: y });
        const elLab = labelPool[shown++];
        const text = labelOf(item.n, snap.nodes);
        elLab.style.display = "";
        elLab.classList.toggle("dim", !!(snap.query && snap.hits && !snap.hits[item.i] && item.i !== snap.focus));
        elLab.querySelector("b").textContent = text.title;
        elLab.querySelector("small").textContent = text.sub;
        elLab.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px) translate(-50%, -130%)";
      });
    }

    function easeTo(i, dist) {
      const n = snap.nodes[i];
      if (!n) return;
      fly = {
        from: cam.tt.clone(), to: new T.Vector3(n.x, n.y, n.z),
        t0: performance.now(), dur: opts.reduced ? 1 : 1300,
        r0: cam.tr, r1: dist || 5.6, p0: cam.tphi, p1: 1.02
      };
      kick();
    }
    function easeHome() {
      fly = {
        from: cam.tt.clone(), to: new T.Vector3(),
        t0: performance.now(), dur: opts.reduced ? 1 : 1100,
        r0: cam.tr, r1: 26, p0: cam.tphi, p1: 0.86
      };
      cam.ttheta = 0.42;
      kick();
    }
    function easeToWorld(x, y, z, dist) {
      fly = {
        from: cam.tt.clone(), to: new T.Vector3(x, y, z),
        t0: performance.now(), dur: opts.reduced ? 1 : 1100,
        r0: cam.tr, r1: dist || 16, p0: cam.tphi, p1: 0.95
      };
      kick();
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
      timeU.value = opts.reduced ? 0 : now / 1000;
      if (!opts.reduced) root.position.y = Math.sin(now / 1000 * 0.28) * 0.03;
      if (fly) {
        const u = clamp((now - fly.t0) / fly.dur, 0, 1);
        const e = 1 - Math.pow(1 - u, 3);
        cam.tt.lerpVectors(fly.from, fly.to, e);
        cam.tr = fly.r0 + (fly.r1 - fly.r0) * e;
        cam.tphi = fly.p0 + (fly.p1 - fly.p0) * e;
        if (u >= 1) fly = null;
      }
      const damp = opts.reduced ? 1 : 0.08;
      cam.theta += (cam.ttheta - cam.theta) * damp;
      cam.phi += (cam.tphi - cam.phi) * damp;
      cam.r += (cam.tr - cam.r) * damp;
      cam.target.lerp(cam.tt, damp);
      camera.position.set(
        cam.target.x + cam.r * Math.sin(cam.phi) * Math.cos(cam.theta),
        cam.target.y + cam.r * Math.cos(cam.phi),
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

    function pick(cx, cy) {
      if (!docMesh || !snap.nodes.length) return -1;
      const rect = el.getBoundingClientRect();
      v2.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(v2, camera);
      const hit = ray.intersectObject(docMesh, false)[0];
      if (!hit || hit.instanceId == null) return -1;
      if (snap.visible && !snap.visible[hit.instanceId]) return -1;
      return hit.instanceId;
    }
    let ptr = null;
    const ptrs = new Map();
    let pinch = 0, r0 = 0;
    let lastTap = { t: 0, i: -1 };
    el.addEventListener("pointerdown", (e) => {
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 非可信事件仍可点选 */ }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      ptr = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (ptrs.size === 2) {
        const both = Array.from(ptrs.values());
        pinch = Math.hypot(both[0].x - both[1].x, both[0].y - both[1].y);
        r0 = cam.tr;
      }
    });
    el.addEventListener("pointermove", (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) {
        const id = pick(e.clientX, e.clientY);
        if (id !== hover) { hover = id; paintNodes(); buildLines(); el.style.cursor = id >= 0 ? "pointer" : "grab"; }
        return;
      }
      if (ptrs.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const both = Array.from(ptrs.values());
        const d = Math.hypot(both[0].x - both[1].x, both[0].y - both[1].y);
        if (pinch) cam.tr = clamp(r0 * (pinch / d), 2.8, 64);
      } else if (Math.hypot(e.clientX - ptr.x, e.clientY - ptr.y) > 3) {
        cam.ttheta -= (e.clientX - p.x) * 0.005;
        cam.tphi = clamp(cam.tphi - (e.clientY - p.y) * 0.004, 0.25, 1.45);
        p.x = e.clientX; p.y = e.clientY;
        fly = null;
      }
      kick();
    });
    const up = (e) => {
      const was = ptr;
      ptrs.delete(e.pointerId);
      if (was && ptrs.size === 0 && Math.hypot(e.clientX - was.x, e.clientY - was.y) < 6 && performance.now() - was.t < 500) {
        const id = pick(e.clientX, e.clientY);
        const now = performance.now();
        if (id >= 0 && id === lastTap.i && now - lastTap.t < 380) {
          lastTap = { t: 0, i: -1 };
          if (bridge.onOpen) bridge.onOpen(id);
        } else if (id >= 0) {
          lastTap = { t: now, i: id };
          if (bridge.onPick) bridge.onPick(id);
        }
      }
      if (ptrs.size < 2) pinch = 0;
      ptr = ptrs.size ? ptr : null;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", () => { if (hover >= 0) { hover = -1; paintNodes(); buildLines(); } });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      cam.tr = clamp(cam.tr * (1 + e.deltaY * 0.0011), 2.8, 64);
      fly = null;
      kick();
    }, { passive: false });

    resize();
    kick();
    return {
      sync: sync,
      easeTo: easeTo,
      easeHome: easeHome,
      easeToWorld: easeToWorld,
      dispose() {
        cancelAnimationFrame(raf);
        ro.disconnect(); io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        clearGroup(volG); clearGroup(lineG);
        if (docMesh) { nodeG.remove(docMesh); docMesh.geometry.dispose(); }
        if (haloMesh) { nodeG.remove(haloMesh); haloMesh.geometry.dispose(); }
        volGeo.dispose(); nodeGeo.dispose(); starMat.dispose(); volMat.dispose(); nodeMat.dispose(); haloMat.dispose(); sg.dispose();
        if (bloom) bloom.dispose();
        renderer.dispose();
        el.remove(); labelLayer.remove();
      }
    };
  }

  function create2D(box, opts, bridge) {
    const cv = document.createElement("canvas");
    cv.setAttribute("aria-label", "知识宇宙平面，单击沿关系探索，双击打开文档");
    box.appendChild(cv);
    const ctx = cv.getContext("2d");
    const labels = document.createElement("div");
    labels.className = "space-labels";
    box.appendChild(labels);
    let snap = { nodes: [], visible: [], hits: [], wikiVis: [], inferred: [], groups: [], focus: -1, query: "" };
    let hover = -1;
    let W = 1, H = 1, dpr = 1, raf = 0;
    const cam = { x: 0, y: 0, z: 1, tx: 0, ty: 0, tz: 1 };
    function resize() {
      const r = box.getBoundingClientRect();
      if (!r.width || !r.height) return;
      dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      W = r.width; H = r.height;
      cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
      cv.style.width = W + "px"; cv.style.height = H + "px";
      draw();
    }
    function project(n) {
      const s = Math.min(W, H) * 0.042 / cam.z;
      return { x: W / 2 + (n.x - cam.x) * s, y: H / 2 + (n.z - cam.y) * s, s: s };
    }
    function rgb(c, a) {
      return "rgba(" + (c[0] * 255 | 0) + "," + (c[1] * 255 | 0) + "," + (c[2] * 255 | 0) + "," + a + ")";
    }
    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sky = ctx.createRadialGradient(W * 0.5, H * 0.46, 20, W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
      sky.addColorStop(0, "#172033");
      sky.addColorStop(1, "#0c121c");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "rgba(180, 200, 230, 0.45)";
      for (let i = 0; i < 80; i++) {
        const x = ((i * 97) % 1000) / 1000 * W;
        const y = ((i * 57) % 1000) / 1000 * H;
        ctx.globalAlpha = 0.25;
        ctx.fillRect(x, y, 1.2, 1.2);
      }
      ctx.globalAlpha = 1;
      (snap.groups || []).forEach((g) => {
        const p = project({ x: g.x, y: g.y, z: g.z });
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, g.r * p.s, g.r * p.s * 0.72, 0, 0, 7);
        ctx.fillStyle = rgb(g.color, 0.06);
        ctx.fill();
        ctx.strokeStyle = rgb(g.color, 0.28);
        ctx.lineWidth = 1;
        ctx.stroke();
      });
      function strokeEdge(e, color, dash) {
        const a = snap.nodes[e.a], b = snap.nodes[e.b];
        if (!a || !b) return;
        const pa = project(a), pb = project(b);
        ctx.beginPath();
        ctx.setLineDash(dash ? [5, 5] : []);
        ctx.strokeStyle = color;
        ctx.lineWidth = dash ? 1 : 1.4;
        ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        ctx.setLineDash([]);
      }
      (snap.wikiVis || []).forEach((e) => strokeEdge(e, "rgba(126, 168, 214, 0.85)", false));
      (snap.inferred || []).forEach((e) => strokeEdge(e, "rgba(212, 161, 90, 0.75)", true));
      labels.replaceChildren();
      const used = [];
      (snap.nodes || []).forEach((n, i) => {
        if (!snap.visible || !snap.visible[i]) return;
        const p = project(n);
        const dim = snap.query && snap.hits && !snap.hits[i] && i !== snap.focus;
        ctx.globalAlpha = dim ? 0.28 : 1;
        const rad = Math.max(4, n.size * p.s * 1.15);
        const glow = ctx.createRadialGradient(p.x, p.y, rad * 0.2, p.x, p.y, rad * 3.1);
        glow.addColorStop(0, rgb(n.color, 0.55));
        glow.addColorStop(1, rgb(n.color, 0));
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad * 3.1, 0, 7); ctx.fill();
        const g = ctx.createRadialGradient(p.x - rad * 0.3, p.y - rad * 0.35, rad * 0.1, p.x, p.y, rad);
        g.addColorStop(0, "rgba(226, 234, 246, 0.95)");
        g.addColorStop(0.45, rgb(n.color, 1));
        g.addColorStop(1, "rgba(8, 12, 20, 0.95)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 7); ctx.fill();
        if (i === snap.focus || i === hover) {
          ctx.strokeStyle = i === snap.focus ? "rgba(214, 228, 255, 0.9)" : "rgba(214, 228, 255, 0.45)";
          ctx.lineWidth = i === snap.focus ? 2 : 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, rad + 4, 0, 7); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (used.some((u) => Math.hypot(u.x - p.x, u.y - p.y) < 46)) return;
        used.push(p);
        const elLab = document.createElement("div");
        elLab.className = "space-label galaxy-label" + (dim ? " dim" : "");
        const text = labelOf(n, snap.nodes);
        const b = document.createElement("b");
        b.textContent = text.title;
        const sm = document.createElement("small");
        sm.textContent = text.sub;
        elLab.append(b, sm);
        elLab.style.transform = "translate(" + p.x.toFixed(1) + "px," + (p.y - rad - 6).toFixed(1) + "px) translate(-50%, -100%)";
        labels.appendChild(elLab);
      });
    }
    function loop() {
      cam.z += (cam.tz - cam.z) * (opts.reduced ? 1 : 0.08);
      cam.x += (cam.tx - cam.x) * (opts.reduced ? 1 : 0.08);
      cam.y += (cam.ty - cam.y) * (opts.reduced ? 1 : 0.08);
      draw();
      if (Math.abs(cam.tz - cam.z) > 0.002 || Math.abs(cam.tx - cam.x) > 0.01 || Math.abs(cam.ty - cam.y) > 0.01) raf = requestAnimationFrame(loop);
      else raf = 0;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(loop); }
    function easeTo(i, dist) {
      const n = snap.nodes[i];
      if (!n) return;
      cam.tx = n.x; cam.ty = n.z;
      cam.tz = clamp((dist || 5.6) / 13, 0.32, 1.15);
      kick();
    }
    function easeHome() { cam.tx = 0; cam.ty = 0; cam.tz = 1; kick(); }
    function easeToWorld(x, y, z, dist) {
      cam.tx = x; cam.ty = z;
      cam.tz = clamp((dist || 16) / 13, 0.36, 1.2);
      kick();
    }
    function hitAt(cx, cy) {
      const rect = cv.getBoundingClientRect();
      const x = cx - rect.left, y = cy - rect.top;
      let best = -1, bd = 18;
      (snap.nodes || []).forEach((n, i) => {
        if (!snap.visible || !snap.visible[i]) return;
        const p = project(n);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < Math.max(bd, n.size * p.s)) { bd = d; best = i; }
      });
      return best;
    }
    cv.addEventListener("wheel", (e) => { e.preventDefault(); cam.tz = clamp(cam.tz * (1 + e.deltaY * 0.001), 0.28, 2.4); kick(); }, { passive: false });
    let down = null;
    let lastTap = { t: 0, i: -1 };
    cv.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, tx: cam.tx, ty: cam.ty, t: performance.now() }; });
    cv.addEventListener("pointermove", (e) => {
      if (!down) {
        const id = hitAt(e.clientX, e.clientY);
        if (id !== hover) { hover = id; cv.style.cursor = id >= 0 ? "pointer" : "grab"; draw(); }
        return;
      }
      const s = Math.min(W, H) * 0.042 / cam.z;
      cam.tx = down.tx - (e.clientX - down.x) / s;
      cam.ty = down.ty - (e.clientY - down.y) / s;
      cam.x = cam.tx; cam.y = cam.ty; draw();
    });
    cv.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) {
        const id = hitAt(e.clientX, e.clientY);
        const now = performance.now();
        if (id >= 0 && id === lastTap.i && now - lastTap.t < 380) {
          lastTap = { t: 0, i: -1 };
          if (bridge.onOpen) bridge.onOpen(id);
        } else if (id >= 0) {
          lastTap = { t: now, i: id };
          if (bridge.onPick) bridge.onPick(id);
        }
      }
      down = null;
    });
    const ro = new ResizeObserver(resize); ro.observe(box);
    resize();
    return {
      sync(next) { snap = next; draw(); },
      easeTo: easeTo,
      easeHome: easeHome,
      easeToWorld: easeToWorld,
      dispose() { cancelAnimationFrame(raf); ro.disconnect(); cv.remove(); labels.remove(); }
    };
  }

  function create(box, opts) {
    opts = opts || {};
    const model = createModel();
    const bridge = {
      onPick(i) {
        model.focusAt(i);
        const snap = model.snapshot();
        impl.sync(snap);
        impl.easeTo(i, 5.6);
        if (opts.onFocus) opts.onFocus(snap.card);
      },
      onOpen(i) {
        const n = model.node(i);
        if (n && n.doc && n.doc.path && opts.onOpen) opts.onOpen(n.doc.path);
      }
    };
    let impl = null;
    let gl = false;
    try {
      const c = document.createElement("canvas");
      gl = !!(T && (c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl")));
    } catch (e) { gl = false; }
    if (gl) {
      try { impl = createGL(box, opts, bridge); }
      catch (e) { impl = null; }
    }
    if (!impl) impl = create2D(box, opts, bridge);
    let lastFly = -2;
    function emit() {
      const snap = model.snapshot();
      impl.sync(snap);
      if (opts.onFocus) opts.onFocus(snap.card);
      if (opts.onDepth) opts.onDepth(snap.hop);
      return snap;
    }
    return {
      setDocs(list) { model.setDocs(list); lastFly = -2; return emit(); },
      setQuery(q) {
        const before = model.snapshot().fly;
        model.setQuery(q);
        const snap = model.snapshot();
        impl.sync(snap);
        const hits = (snap.nodes || []).filter((n, i) => snap.hits[i]).length;
        if (q && snap.fly >= 0 && snap.fly !== before && snap.fly !== lastFly) {
          lastFly = snap.fly;
          impl.easeTo(snap.fly, 7.2);
        }
        return q ? hits : snap.nodes.length;
      },
      setFilter(f) {
        const filter = f || {};
        model.setFilter(filter);
        const snap = emit();
        const vis = snap.nodes.filter((n, i) => snap.visible[i]);
        if (!vis.length) return;
        if (!filter.category && !filter.tag && !filter.type) { impl.easeHome(); return; }
        let x = 0, y = 0, z = 0, spread = 2;
        vis.forEach((n) => { x += n.x; y += n.y; z += n.z; });
        x /= vis.length; y /= vis.length; z /= vis.length;
        vis.forEach((n) => { spread = Math.max(spread, Math.hypot(n.x - x, n.z - z)); });
        if (impl.easeToWorld) impl.easeToWorld(x, y, z, clamp(spread * 2.6 + 3.5, 7, 24));
      },
      reset() { model.reset(); lastFly = -2; emit(); impl.easeHome(); },
      expand() {
        model.expand();
        const snap = emit();
        if (snap.focus >= 0) impl.easeTo(snap.focus, clamp(8 + (snap.hop - 1) * 1.6, 8, 28));
      },
      setDepth(n) {
        model.setDepth(n);
        const snap = emit();
        if (snap.focus >= 0) impl.easeTo(snap.focus, clamp(8 + (snap.hop - 1) * 1.6, 8, 28));
        return snap;
      },
      flyIn() {
        const snap = model.snapshot();
        if (snap.fly >= 0) impl.easeTo(snap.fly, 5.8);
        else impl.easeHome();
      },
      focusPath(path) {
        const i = model.indexOfPath(path);
        if (i < 0) return;
        bridge.onPick(i);
      },
      facets() { return model.facets(); },
      isLocal() { return model.snapshot().focus >= 0; },
      dispose() { impl.dispose(); }
    };
  }

  window.SBGALAXY = { create: create, version: "2.8.0" };
})();
