/* PERSONAL AI OS — 场景门面：唯一 3D 入口（构建 / 模式 / 拾取 / 镜头 / 启动进度） */
(function (PAO) {
  'use strict';

  var scene = {
    mode: 'universe',
    ready: false,
    env: null,
    core: null,
    modules: null,
    memory: null,
    arch: null,
    agents: null,
    human: null,
    graph: null,
    _listeners: {},
    _graphLoaded: false,
    _pendingMode: null,
    _graphStats: null,
    _fadeTween: null,
    _bootP: 1,
    _dim: 0,

    on: function (event, fn) {
      (scene._listeners[event] || (scene._listeners[event] = [])).push(fn);
      return function () {
        var a = scene._listeners[event]; if (!a) return;
        var i = a.indexOf(fn); if (i > -1) a.splice(i, 1);
      };
    },

    emit: function (event, payload) {
      var a = scene._listeners[event];
      if (a) a.slice().forEach(function (fn) { try { fn(payload); } catch (e) { console.error(e); } });
    },

    init: function () {
      var eng = PAO.engine;
      var data = PAO.DATA || { memories: [], memoryClusters: [], architecture: { layers: [] } };

      scene.env = PAO.buildEnv();
      eng.scene.add(scene.env.group);

      scene.core = PAO.buildCore();
      eng.scene.add(scene.core.group);

      scene.modules = PAO.buildModules();
      eng.scene.add(scene.modules.group);

      scene.memory = PAO.buildMemory(data);
      eng.scene.add(scene.memory.group);

      scene.arch = PAO.buildArchitecture(data);
      eng.scene.add(scene.arch.group);

      // Agent 节点网络（真实状态驱动）
      if (PAO.buildAgents) {
        scene.agents = PAO.buildAgents();
        eng.scene.add(scene.agents.group);
        scene.agents.setVisible(false);
      }

      /* Super-Brain 真实数据到达后重建记忆宇宙与 Agent 网络 */
      PAO.bus.on('sb:data', function () {
        var d = PAO.DATA || {};
        var n = (d.memories || []).length;
        if (scene.memory && d.memoryReal && scene._memCount !== n) {
          scene._memCount = n;
          var wasMem = scene.memory.group.visible;
          eng.scene.remove(scene.memory.group);
          scene.memory = PAO.buildMemory(d);
          eng.scene.add(scene.memory.group);
          scene.memory.setVisible(wasMem);
        }
        if (scene.agents && !scene._agentsBuilt) {
          scene._agentsBuilt = true;
          scene.rebuildAgents();
        } else if (scene.agents) {
          scene.syncAgentStatus();
        }
      });

      /* 知识图谱（数据按需从 /api/graph 拉取） */
      if (PAO.buildGraphScene) {
        scene.graph = PAO.buildGraphScene();
        eng.scene.add(scene.graph.group);
        scene.graph.setVisible(false);
      }

      PAO.rig.init(eng.camera);

      eng.onFrame(function (dt, t) {
        scene.env.update(dt, t);
        if (scene.mode === 'universe' || scene.mode === 'workspace') {
          scene.core.update(dt, t);
          if (scene.mode === 'universe') scene.modules.update(dt, t);
          if (scene.mode === 'workspace' && scene.agents) scene.agents.update(dt, t);
        } else if (scene.mode === 'memory') {
          scene.memory.update(dt, t);
        } else if (scene.mode === 'architecture') {
          scene.arch.update(dt, t);
        } else if (scene.mode === 'graph') {
          if (scene.graph) scene.graph.update(dt, t);
        }
        PAO.rig.update(dt, t);
        PAO.pointer.update();
        if (PAO.labels) PAO.labels.update();
        scene._updateFade(dt);
      });

      scene.ready = true;
      return scene;
    },

    /* ---------- Agent 网络重建 / 状态同步 ---------- */
    rebuildAgents: function () {
      if (!PAO.buildAgents || !PAO.engine) return;
      var eng = PAO.engine;
      var wasVisible = scene.agents && scene.agents.group ? scene.agents.group.visible : false;
      if (scene.agents) {
        try { scene.agents.dispose(); } catch (e) {}
        if (scene.agents.group && scene.agents.group.parent) eng.scene.remove(scene.agents.group);
      }
      var old = scene.agents;
      scene.agents = PAO.buildAgents();
      eng.scene.add(scene.agents.group);
      scene.agents.setVisible(wasVisible);
      scene.agents.setProgress(1);
      scene.applyQuality(PAO.engine.quality);
      if (old && old.group && old.group.parent) eng.scene.remove(old.group);
      if (PAO.labels) PAO.labels.refresh && PAO.labels.refresh();
    },

    syncAgentStatus: function () {
      if (!scene.agents || !PAO.SB) return;
      var model = PAO.SB.agentModel();
      for (var i = 0; i < model.length; i++) {
        var m = model[i];
        var n = scene.agents.getAgent(m.id);
        if (n && n.status !== m.status) scene.agents.setAgentStatus(m.id, m.status, m.role);
      }
    },

    /* ---------- 启动进度 0..1 ---------- */
    setBootProgress: function (p) {
      scene._bootP = p;
      if (scene.env) scene.env.setProgress(p);
      if (scene.core) scene.core.setProgress(p);
      if (scene.modules) scene.modules.setProgress(p);
      if (scene.agents) scene.agents.setProgress(p);
      // 启动期间镜头从极远推近
      var r = 34 - 17.5 * Math.min(1, Math.pow(p, 1.35));
      PAO.rig.tRadius = r;
      PAO.rig.radius = r;
      PAO.rig.tPhi = 1.05 + 0.11 * p;
      PAO.rig.phi = PAO.rig.tPhi;
    },

    /* ---------- 模式 ---------- */
    setMode: function (mode) {
      if (mode === scene.mode) return;
      if (mode === scene._pendingMode) return;   // 已在切往该模式，忽略重复请求
      scene._pendingMode = mode;
      scene._transition(function () {
        scene.mode = mode;
        var uni = mode === 'universe' || mode === 'workspace';
        var ws = mode === 'workspace';
        var isGraph = mode === 'graph';

        if (scene.graph) scene.graph.setVisible(isGraph);
        if (isGraph) scene.loadGraph();

        scene.core.group.visible = mode === 'universe';
        scene.modules.group.visible = mode === 'universe';
        if (scene.core && scene.core.setDim) scene.core.setDim(ws ? 1 : 0);
        /* Agent 网络只在「网络」视图出现，避免与六大模块在同一视图互相遮挡 */
        if (scene.agents) scene.agents.setVisible(mode === 'workspace');
        scene.memory.setVisible(mode === 'memory');
        scene.arch.setVisible(mode === 'architecture');

        if (mode === 'graph') {
          PAO.rig.tweenTo({ theta: 0.42, phi: 1.24, radius: 23, target: new THREE.Vector3(0, 0, 0) }, 1100);
        } else if (mode === 'workspace') {
          /* 固定机位：正对三层网络，保证 DOM 标签与节点严格对齐 */
          PAO.rig.tweenTo({ theta: 0, phi: 1.32, radius: 21, target: new THREE.Vector3(0, 0.2, 0) }, 900);
        } else if (mode === 'universe') {
          PAO.rig.tweenTo({ theta: 0.62, phi: 1.16, radius: 18.5, target: new THREE.Vector3(0, 0.4, 0) }, 900);
        } else if (mode === 'memory') {
          PAO.rig.tweenTo({ theta: 0.5, phi: 1.16, radius: 26, target: new THREE.Vector3(0, 0, 0) }, 900);
        } else if (mode === 'architecture') {
          PAO.rig.tweenTo({ theta: 0.75, phi: 1.30, radius: 18, target: new THREE.Vector3(0, 0, 0) }, 900);
        }
        scene._pendingMode = null;
        if (PAO.bus) PAO.bus.set({ mode: mode });
      });
    },

    _BASE_EXPOSURE: 1.05,

    _transition: function (fn) {
      var eng = PAO.engine;
      /* 基准必须固定：若用「当前曝光」作基准，连续切换会让基准不断下移
         （1.05 → 0.37 → …），最终停在中途再也回不去。 */
      var base = scene._BASE_EXPOSURE;
      eng.renderer.toneMappingExposure = base;
      scene._fadeTween = { t: 0, dur: 0.42, start: base, fn: fn, phase: 0, startedAt: (typeof performance !== 'undefined' ? performance.now() : Date.now()) };
    },

    _updateFade: function (dt) {
      var f = scene._fadeTween;
      if (!f) return;
      var eng = PAO.engine;
      f.t += dt;
      var k = Math.min(1, f.t / f.dur);

      if (f.phase === 0) {
        eng.renderer.toneMappingExposure = f.start * (1 - k * 0.72);
        if (k >= 1) {
          try { f.fn && f.fn(); } catch (e) { console.error('[scene] transition fn', e); }
          f.phase = 1; f.t = 0;
        }
      } else {
        eng.renderer.toneMappingExposure = f.start * (0.28 + k * 0.72);
        if (k >= 1) {
          eng.renderer.toneMappingExposure = f.start;
          scene._fadeTween = null;
        }
      }
      /* 兜底：过渡超过 3 秒仍未收敛则强制复位（原值 1.05） */
      /* 超时按真实时间判断：页面隐藏时 rAF 会被节流，累积 dt 不可靠。
         若过渡已超过 1.5 秒真实时间仍未完成，直接结算，避免回来时停在中间态。 */
      var nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (f && f.startedAt && nowMs - f.startedAt > 1500) {
        if (f.phase === 0) {
          try { f.fn && f.fn(); } catch (e) { console.error('[scene] transition fn (forced)', e); }
        }
        eng.renderer.toneMappingExposure = scene._BASE_EXPOSURE;
        scene._fadeTween = null;
        scene._pendingMode = null;
      }
    },

    /* ---------- 镜头 ---------- */
    home: function () {
      scene.modules.setActive(null);
      scene.core.setDim(0);
      scene._dim = 0;
      if (scene.mode !== 'universe') scene.setMode('universe');
      else PAO.rig.home(1100);
      if (PAO.bus) PAO.bus.set({ activeModule: null });
    },

    focusCore: function () {
      if (scene.mode !== 'universe') scene.setMode('universe');
      scene.modules.setActive(null);
      scene.core.setDim(0);
      PAO.rig.tweenTo({ theta: 0.55, phi: 1.24, radius: 8.4, target: new THREE.Vector3(0, 0, 0) }, 1100);
    },

    focusModule: function (id) {
      if (scene.mode === 'memory' || scene.mode === 'architecture') {
        scene.setMode('universe');
        setTimeout(function () { scene.focusModule(id); }, 480);
        return;
      }
      var item = scene.modules.getItem(id);
      if (!item) { scene.home(); return; }

      scene.modules.setActive(id);
      scene.modules.pulse(id);
      scene.core.setDim(1);
      scene.core.pulse(item.def.color);

      var pos = item.node.position.clone();
      var theta = Math.atan2(pos.x, pos.z);
      var radius = Math.max(12.5, pos.length() * 1.15);

      PAO.rig.tweenTo({
        theta: theta,
        phi: 1.24,
        radius: radius,
        target: pos.clone().multiplyScalar(0.78)
      }, 1150);

      if (PAO.bus) PAO.bus.set({ activeModule: id });
      scene.emit('module:enter', id);
    },

    /* ---------- 拾取 ---------- */
    getPickables: function () {
      if (scene.mode === 'graph') return scene.graph ? scene.graph.pickables : [];
      if (scene.mode === 'memory') return scene.memory.pickables;
      if (scene.mode === 'architecture') return scene.arch.pickables;
      var arr = [];
      if (scene.core) arr = arr.concat(scene.core.pickables);
      if (scene.mode === 'workspace') {
        if (scene.agents) arr = arr.concat(scene.agents.pickables);
        return arr;
      }
      /* universe：只拾取六大模块（Agent 网络作为背景层，不抢交互）
         workspace：只拾取 Agent 节点 */
      if (scene.modules) arr = arr.concat(scene.modules.pickables);
      return arr;
    },

    handlePick: function (hit) {
      if (!hit) return;
      if (hit.kind === 'module') {
        if (PAO.bus) PAO.bus.emit('nav:go', { id: hit.pickId, source: 'scene' });
      } else if (hit.kind === 'memory') {
        scene.memory.select(hit.pickId);
        if (PAO.bus) {
          PAO.bus.set({ memorySelected: hit.pickId });
          PAO.bus.emit('memory:select', { id: hit.pickId });
        }
      } else if (hit.kind === 'arch') {
        var li = hit.object.userData.layerIndex;
        scene.arch.setLayer(li);
        if (PAO.bus) PAO.bus.emit('arch:layer', { index: li });
      } else if (hit.kind === 'note') {
        scene.graph.select(hit.pickId);
        PAO.bus.set({ selectedNote: hit.pickId });
        PAO.bus.emit('graph:note', { id: hit.pickId });
        if (PAO.ui) PAO.ui.go('graph');
      } else if (hit.kind === 'agent') {
        var ag = scene.agents && scene.agents.getAgent ? scene.agents.getAgent(hit.pickId) : null;
        PAO.bus.emit('agent:selected', { agentId: hit.pickId, agent: ag || null });
        PAO.bus.set({ selectedAgent: hit.pickId });
        scene.focusAgent(hit.pickId);
        if (PAO.ui) PAO.ui.go('agent-detail');
      } else if (hit.kind === 'core') {
        if (PAO.bus) PAO.bus.emit('nav:home', {});
      }
    },

    handleHover: function (hit) {
      if (scene.mode !== 'universe' && scene.mode !== 'workspace' && scene.mode !== 'graph') {
        PAO.bus.emit('hover:none', {});
        return;
      }
      var kind = hit ? hit.kind : null;
      var id = hit ? hit.pickId : null;

      if (scene.mode === 'graph' && scene.graph) {
        scene.graph.setHover(kind === 'note' ? id : null);
        if (kind === 'note') {
          PAO.bus.emit('hover:pick', { kind: 'note', id: id, x: PAO.pointer.screenX, y: PAO.pointer.screenY });
        } else {
          PAO.bus.emit('hover:none', {});
        }
        return;
      }
      scene.modules.setHover(kind === 'module' ? id : null);
      if (scene.agents && scene.agents.setHover) {
        scene.agents.setHover(kind === 'agent' ? id : null);
      }

      /* 广播给悬停预览卡（含鼠标屏幕坐标） */
      if (hit && (kind === 'module' || kind === 'agent' || kind === 'core')) {
        PAO.bus.emit('hover:pick', {
          kind: kind, id: id,
          x: PAO.pointer.screenX, y: PAO.pointer.screenY
        });
      } else {
        PAO.bus.emit('hover:none', {});
      }
    },

    /* ---------- 知识图谱 ---------- */
    /* source: 'local'（本地 Obsidian vault）| 'cloud'（云脑超级大脑知识库） */
    loadGraph: function (source) {
      if (!scene.graph) return;
      var src = source || scene._graphSource || 'local';
      if (scene._graphLoaded && scene._graphSource === src) return;
      scene._graphLoaded = true;
      scene._graphSource = src;
      PAO.bus.emit('graph:loading', {});
      var url = src === 'cloud' ? '/api/cloud-graph' : '/api/graph';
      fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        if (d.error) { PAO.bus.emit('graph:error', d); scene._graphLoaded = false; return; }
        scene.graph.load(d.graph);
        scene._graphStats = d.graph.stats;
        PAO.bus.emit('graph:loaded', d.graph.stats);
      }).catch(function (e) {
        scene._graphLoaded = false;
        PAO.bus.emit('graph:error', { error: e.message });
      });
    },

    focusNote: function (noteId) {
      if (!scene.graph) return;
      if (scene.mode !== 'graph') scene.setMode('graph');
      var p = scene.graph.focusNode(noteId);
      if (!p) return;
      scene.graph.select(noteId);
      var dist = 8;
      PAO.rig.tweenTo({
        theta: Math.atan2(p.x, p.z), phi: 1.25, radius: dist, target: p.clone()
      }, 900);
    },

    /* 聚焦单个 Agent 节点（点击后"进入"该节点的空间） */
    focusAgent: function (agentId) {
      if (!scene.agents) return;
      var n = scene.agents.getAgent(agentId);
      if (!n || !n.group) return;
      if (scene.mode !== 'workspace' && scene.mode !== 'universe') scene.setMode('workspace');
      var pos = n.group.position.clone();
      var theta = Math.atan2(pos.x, pos.z);
      PAO.rig.tweenTo({
        theta: theta, phi: 1.30, radius: n.isHub ? 11 : 8.4, target: pos
      }, 950);
      scene.agents.setHover(agentId);
      if (PAO.bus) PAO.bus.set({ selectedAgent: agentId });
      scene.emit('agent:focus', agentId);
    },

    handleDoubleClick: function () {
      if (scene.mode !== 'universe') { scene.setMode('universe'); return; }
      var hit = PAO.pointer.pick();
      if (!hit || hit.kind === 'core') scene.focusCore();
      else scene.home();
    },

    /* ---------- 记忆 ---------- */
    selectMemory: function (id) {
      if (scene.mode !== 'memory') {
        scene.setMode('memory');
        setTimeout(function () { scene.memory.select(id); }, 520);
      } else {
        scene.memory.select(id);
      }
      if (PAO.bus) PAO.bus.set({ memorySelected: id });
      var rec = scene.memory.getNode(id);
      if (rec) {
        PAO.rig.tweenTo({
          theta: Math.atan2(rec.base.x, rec.base.z),
          phi: 1.18,
          radius: 12.5,
          target: rec.base.clone()
        }, 900);
      }
    },

    setMemoryFilter: function (cat) {
      if (scene.memory) scene.memory.setFilter(cat);
      if (PAO.bus) PAO.bus.set({ memoryFilter: cat || 'ALL' });
    },

    /* ---------- 数据源 / 模型 / 架构 ---------- */
    setSourceState: function (id, state) {
      if (scene.modules) {
        var dataNode = scene.modules.getItem('data');
        if (dataNode) {
          if (state === 'connected') { scene.modules.pulse('data'); if (scene.core) scene.core.pulse(0x55ddf5); }
        }
      }
    },

    highlightSource: function (id) {
      scene.modules.setHover(null);
    },

    highlightModel: function (id) {
      if (scene.modules) scene.modules.pulse('model');
    },

    setArchitectureLayer: function (i) {
      if (scene.mode !== 'architecture') scene.setMode('architecture');
      if (scene.arch) scene.arch.setLayer(i);
    },

    explodeArchitecture: function (on) {
      if (scene.mode !== 'architecture') scene.setMode('architecture');
      if (scene.arch) scene.arch.setExplode(on);
    },

    /* ---------- 引导 ---------- */
    setGuidedStage: function (i) {
      var guided = (PAO.DATA && PAO.DATA.guided) || [];
      var act = guided[i];
      if (!act) return;
      if (act.focus === 'architecture') { scene.setMode('architecture'); scene.arch.setLayer(-1); }
      else if (act.focus === 'memory') { scene.setMode('memory'); }
      else {
        if (scene.mode !== 'universe') scene.setMode('universe');
        if (act.focus === 'core') scene.focusCore();
        else scene.focusModule(act.focus);
      }
      (act.highlight || []).forEach(function (id) { if (id !== act.focus) scene.modules.pulse(id); });
      if (PAO.bus) PAO.bus.set({ guidedStage: i });
    },

    /* ---------- 质量 ---------- */
    applyQuality: function (q) {
      if (scene.env) scene.env.setQuality(q);
      if (scene.core) scene.core.setQuality(q);
      if (scene.modules) scene.modules.setQuality(q);
      if (scene.memory) scene.memory.setQuality(q);
      if (scene.arch) scene.arch.setQuality(q);
      if (scene.agents) scene.agents.setQuality(q);
      if (scene.graph) scene.graph.setQuality(q);
      if (scene.human) scene.human.setQuality(q);
    },

    getCamera: function () {
      return { position: PAO.engine.camera.position.clone(), target: PAO.rig.target.clone() };
    },

    isLowPerf: function () { return PAO.engine.quality === 'low'; },

    /* 供 DOM 标签投影使用 */
    labelTargets: function () {
      if (scene.mode === 'workspace' && scene.agents) {
        var out = [];
        var ZH = { idle: '空闲', thinking: '思考', running: '执行中', waiting: '待批示', completed: '完成', failed: '失败', paused: '暂停' };
        var HEX = { idle: '#7E8999', thinking: '#55DDF5', running: '#91DFFF', waiting: '#E0B15C', completed: '#5FD6A8', failed: '#E06767', paused: '#9178FF' };
        scene.agents.pickables.forEach(function (pk) {
          var n = scene.agents.getAgent(pk.userData.pickId);
          if (!n || !n.group) return;
          var v = n.group.position.clone();
          v.y += n.isHub ? 1.2 : 1.0;
          out.push({
            id: n.agentId, num: '', name: n.name, zh: n.zh,
            kind: 'agent', pos: v, element: null, hex: HEX[n.status] || HEX.idle,
            status: n.status, statusZh: ZH[n.status] || n.status
          });
        });
        return out;
      }
      if (scene.mode === 'universe' && scene.modules) {
        return scene.modules.items.map(function (it) {
          var v = it.node.position.clone();
          var dir = new THREE.Vector3(v.x, 0, v.z).normalize().multiplyScalar(0.72);
          v.add(dir);
          v.y += 1.02;
          return { id: it.def.id, num: it.def.num, name: it.def.name, zh: it.def.zh, kind: 'module', pos: v };
        });
      }
      if (scene.mode === 'architecture' && scene.arch) {
        return scene.arch.items.map(function (it) {
          var v = it.group.position.clone();
          v.x -= 4.35;
          return { id: it.def.code, num: it.def.code, name: it.def.name, zh: it.def.zh, kind: 'arch', pos: v };
        });
      }
      return [];
    }
  };

  PAO.scene = scene;
})(window.PAO = window.PAO || {});
