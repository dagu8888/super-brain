/* PERSONAL AI OS — 环境层：深空穹顶 / 星野 / 空间参照环 */
(function (PAO) {
  'use strict';

  function dotTexture(softness) {
    var s = 64;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(softness || 0.18, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  PAO.buildEnv = function () {
    var group = new THREE.Group();
    group.name = 'env';
    var starTex = dotTexture(0.2);

    /* ---------- 穹顶：极暗渐变，纯 shader，零贴图 ---------- */
    var domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      transparent: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x03050a) },
        uBottom: { value: new THREE.Color(0x081222) },
        uGlow: { value: new THREE.Color(0x0d2b45) },
        uTime: { value: 0 }
      },
      vertexShader: [
        'varying vec3 vPos;',
        'void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uGlow; uniform float uTime;',
        'varying vec3 vPos;',
        'void main(){',
        '  vec3 n = normalize(vPos);',
        '  float v = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);',
        '  vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, v));',
        '  float halo = pow(max(0.0, 1.0 - length(vec2(n.x, n.z)) ), 3.0);',
        '  col += uGlow * halo * 0.55;',
        '  float band = smoothstep(0.46, 0.5, v) * smoothstep(0.58, 0.5, v);',
        '  col += vec3(0.03,0.10,0.16) * band * 0.6;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n')
    });
    var dome = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 24), domeMat);
    dome.name = 'dome';
    group.add(dome);

    /* ---------- 星野：两层，近处亮远处暗 ---------- */
    function makeStars(count, rMin, rMax, size, alpha) {
      var geo = new THREE.BufferGeometry();
      var pos = new Float32Array(count * 3);
      var col = new Float32Array(count * 3);
      var c1 = new THREE.Color(0x9fd8ff);
      var c2 = new THREE.Color(0x6f7fa8);
      var c3 = new THREE.Color(0xffffff);
      for (var i = 0; i < count; i++) {
        var u = Math.random() * 2 - 1;
        var th = Math.random() * Math.PI * 2;
        var r = rMin + Math.random() * (rMax - rMin);
        var s = Math.sqrt(1 - u * u);
        pos[i * 3] = r * s * Math.cos(th);
        pos[i * 3 + 1] = r * u * 0.72;
        pos[i * 3 + 2] = r * s * Math.sin(th);
        var pick = Math.random();
        var cc = pick > 0.86 ? c3 : (pick > 0.5 ? c1 : c2);
        var dim = 0.35 + Math.random() * 0.65;
        col[i * 3] = cc.r * dim;
        col[i * 3 + 1] = cc.g * dim;
        col[i * 3 + 2] = cc.b * dim;
      }
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      var mat = new THREE.PointsMaterial({
        size: size,
        map: starTex,
        vertexColors: true,
        transparent: true,
        opacity: alpha,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
      });
      return new THREE.Points(geo, mat);
    }

    var far = makeStars(2600, 52, 96, 0.42, 0.75);
    var near = makeStars(900, 26, 52, 0.5, 0.45);
    group.add(far, near);

    /* ---------- 空间参照环：极淡，只在低角度可见 ---------- */
    var ringGroup = new THREE.Group();
    ringGroup.rotation.x = Math.PI / 2;
    for (var k = 0; k < 3; k++) {
      var r = 11.5 + k * 2.4;
      var pts = [];
      for (var a = 0; a <= 140; a++) {
        var ang = (a / 140) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r));
      }
      var g = new THREE.BufferGeometry().setFromPoints(pts);
      var m = new THREE.LineDashedMaterial({
        color: 0x2a5f80, transparent: true, opacity: 0.16, dashSize: 0.22, gapSize: 1.6
      });
      var line = new THREE.Line(g, m);
      line.computeLineDistances();
      ringGroup.add(line);
    }
    // 参照环在近赤道视角会读成杂线，故不加入场景（保留代码以便按需启用）

    /* ---------- 尘埃：缓慢漂浮 ---------- */
    var dustGeo = new THREE.BufferGeometry();
    var dCount = 700;
    var dPos = new Float32Array(dCount * 3);
    var dSeed = new Float32Array(dCount);
    for (var d = 0; d < dCount; d++) {
      dPos[d * 3] = (Math.random() - 0.5) * 34;
      dPos[d * 3 + 1] = (Math.random() - 0.5) * 18;
      dPos[d * 3 + 2] = (Math.random() - 0.5) * 34;
      dSeed[d] = Math.random();
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
    var dustMat = new THREE.PointsMaterial({
      color: 0x62c8e8, size: 0.075, map: starTex, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    });
    var dust = new THREE.Points(dustGeo, dustMat);
    group.add(dust);

    var api = {
      group: group,
      pickables: [],
      setVisible: function (v) { group.visible = v; },
      setQuality: function (q) {
        far.visible = true;
        near.visible = q !== 'low';
        dust.visible = q !== 'low';
        far.geometry.setDrawRange(0, q === 'low' ? 1200 : 2600);
      },
      setProgress: function (p) {
        // 启动阶段：星空先浮现
        var a = Math.min(1, p / 0.18);
        far.material.opacity = 0.75 * a;
        near.material.opacity = 0.45 * Math.max(0, (p - 0.1) / 0.2);
        dust.material.opacity = 0.5 * Math.max(0, (p - 0.25) / 0.35);
      },
      update: function (dt, t) {
        domeMat.uniforms.uTime.value = t;
        ringGroup.rotation.z += dt * 0.012;
        dust.rotation.y += dt * 0.006;
        dust.position.y = Math.sin(t * 0.12) * 0.35;
        far.rotation.y += dt * 0.0018;
      }
    };
    return api;
  };
})(window.PAO = window.PAO || {});
