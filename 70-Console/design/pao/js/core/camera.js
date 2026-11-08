/* PERSONAL AI OS — 空间镜头：球坐标 + 阻尼 + 补间 */
(function (PAO) {
  'use strict';

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  var rig = {
    theta: 0.62,     // 水平角
    phi: 1.18,       // 极角
    radius: 18.5,
    target: new THREE.Vector3(0, 0, 0),

    tTheta: 0.62,
    tPhi: 1.18,
    tRadius: 18.5,
    tTarget: new THREE.Vector3(0, 0, 0),

    damping: 0.075,
    minRadius: 5.2,
    maxRadius: 34,
    minPhi: 0.32,
    maxPhi: 2.42,

    _tween: null,
    _autoRotate: false,
    _autoIdle: 2.4,

    init: function (camera) {
      rig.camera = camera;
      rig.homePreset = { theta: 0.62, phi: 1.16, radius: 18.5, target: new THREE.Vector3(0, 0.4, 0) };
      rig.apply(0, true);
    },

    orbitDelta: function (dx, dy) {
      rig._autoIdle = 0;
      rig.tTheta -= dx * 0.0042;
      rig.tPhi = clamp(rig.tPhi - dy * 0.0034, rig.minPhi, rig.maxPhi);
      rig._tween = null;
    },

    zoom: function (delta) {
      rig._autoIdle = 0;
      rig.tRadius = clamp(rig.tRadius * (1 + delta * 0.0011), rig.minRadius, rig.maxRadius);
      rig._tween = null;
    },

    tweenTo: function (opts, duration, onDone) {
      var cfg = {
        from: { theta: rig.tTheta, phi: rig.tPhi, radius: rig.tRadius, target: rig.tTarget.clone() },
        to: {
          theta: opts.theta != null ? opts.theta : rig.tTheta,
          phi: opts.phi != null ? opts.phi : rig.tPhi,
          radius: opts.radius != null ? opts.radius : rig.tRadius,
          target: opts.target ? opts.target.clone() : rig.tTarget.clone()
        },
        t: 0,
        dur: (duration || 1000) / 1000,
        ease: opts.ease || 'inOutQuint',
        onDone: onDone || null,
        freeze: opts.freeze !== false
      };
      // 保持最短旋转路径
      var d = cfg.to.theta - cfg.from.theta;
      while (d > Math.PI) { cfg.to.theta -= Math.PI * 2; d = cfg.to.theta - cfg.from.theta; }
      while (d < -Math.PI) { cfg.to.theta += Math.PI * 2; d = cfg.to.theta - cfg.from.theta; }
      rig._tween = cfg;
      rig._autoIdle = 0;
    },

    /* 依据世界坐标聚焦（保持当前朝向感） */
    focusWorld: function (vec, distance, opts) {
      opts = opts || {};
      var cam = rig.camera;
      var cur = cam.position;
      var dx = cur.x - vec.x, dy = cur.y - vec.y, dz = cur.z - vec.z;
      var theta = Math.atan2(dx, dz);
      var horiz = Math.sqrt(dx * dx + dz * dz);
      var phi = Math.atan2(horiz, dy - (vec.y - vec.y)) || 1.2;
      phi = clamp(dy > 0 ? Math.atan2(horiz, dy) : 1.32, rig.minPhi, rig.maxPhi);
      if (opts.keepAngle) {
        theta = rig.tTheta;
        phi = rig.tPhi;
      }
      rig.tweenTo({ theta: theta, phi: phi, radius: distance, target: vec }, opts.duration || 1100);
    },

    home: function (duration) {
      var p = rig.homePreset;
      rig.tweenTo({ theta: p.theta, phi: p.phi, radius: p.radius, target: p.target }, duration || 1200);
    },

    setAutoRotate: function (on) { rig._autoRotate = !!on; },

    update: function (dt, t) {
      rig._autoIdle += dt;

      if (rig._tween) {
        var tw = rig._tween;
        tw.t += dt;
        var k = clamp(tw.t / tw.dur, 0, 1);
        var e = PAO.engine.ease[tw.ease] ? PAO.engine.ease[tw.ease](k) : k;
        rig.tTheta = lerp(tw.from.theta, tw.to.theta, e);
        rig.tPhi = lerp(tw.from.phi, tw.to.phi, e);
        rig.tRadius = lerp(tw.from.radius, tw.to.radius, e);
        rig.tTarget.lerpVectors(tw.from.target, tw.to.target, e);
        if (k >= 1) { rig._tween = null; if (tw.onDone) tw.onDone(); }
      } else if (rig._autoRotate && rig._autoIdle > 3.2 && PAO.bus && PAO.bus.store.autoRotate !== false) {
        rig.tTheta += dt * 0.055;
      }

      rig.theta = lerp(rig.theta, rig.tTheta, rig.damping);
      rig.phi = lerp(rig.phi, rig.tPhi, rig.damping);
      rig.radius = lerp(rig.radius, rig.tRadius, rig.damping);
      rig.target.lerp(rig.tTarget, rig.damping);

      rig.apply(t, false);
    },

    apply: function (dt, immediate) {
      var cam = rig.camera;
      if (!cam) return;
      var sinPhi = Math.sin(rig.phi);
      cam.position.set(
        rig.target.x + rig.radius * sinPhi * Math.sin(rig.theta),
        rig.target.y + rig.radius * Math.cos(rig.phi),
        rig.target.z + rig.radius * sinPhi * Math.cos(rig.theta)
      );
      cam.lookAt(rig.target);

      // 极轻的呼吸感（不影响可读性）
      if (!immediate && !PAO.bus.store.reducedMotion) {
        cam.position.y += Math.sin(dt * 0.5) * 0.012;
      }
    }
  };

  PAO.rig = rig;
})(window.PAO = window.PAO || {});
