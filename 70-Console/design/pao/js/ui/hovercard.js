/* PERSONAL AI OS — 空间悬停预览卡 + Agent 详情面板
   交互契约：
     悬停 3D 节点 → 跟随鼠标的简介卡（模块 / Agent 两套内容）
     点击模块     → 镜头进入该模块 + 右侧面板（由 shell 处理）
     点击 Agent   → 镜头聚焦该节点 + 右侧 Agent 详情面板
   事件来源：PAO.scene 在 handleHover / handlePick 时 emit 'hover:pick' / 'hover:none' */
(function (PAO) {
  'use strict';

  var D = PAO.dom;
  var el = D.el;

  var ELEMENT_ICON = { wood: '木', fire: '火', earth: '土', metal: '金', water: '水' };

  var card = {
    visible: false,
    currentId: null,
    _el: null,
    _timer: 0,
    _raf: 0,
    _mx: 0,
    _my: 0,
    _pinned: false,

    init: function () {
      if (card._el) return card;
      var host = document.getElementById('pao-app') || document.body;
      var node = el('div', { className: 'pao-hovercard', attrs: { id: 'pao-hovercard' } });
      host.appendChild(node);
      card._el = node;

      document.addEventListener('mousemove', function (e) {
        card._mx = e.clientX;
        card._my = e.clientY;
        if (card.visible) card._place();
      }, { passive: true });

      loadRegistry();
      if (PAO.bus) {
        PAO.bus.on('srv:online', function () { loadRegistry(); });
        PAO.bus.on('hover:pick', function (p) { card._schedule(p); });
        PAO.bus.on('hover:none', function () { card.hide(); });
        PAO.bus.on('nav:go', function () { card.hide(); });
        PAO.bus.on('scene:blank', function () { card.hide(); });
      }
      return card;
    },

    /* 悬停意图去抖：快速划过的节点不弹卡 */
    _schedule: function (payload) {
      if (!payload || !payload.id) return card.hide();
      if (payload.id === card.currentId && card.visible) { card._render(payload); return; }
      clearTimeout(card._timer);
      card.currentId = payload.id;
      card._pending = payload;
      card._timer = setTimeout(function () {
        if (card.currentId === payload.id) card._render(payload, true);
      }, 130);
    },

    _render: function (p, show) {
      var data = buildData(p);
      if (!data) return card.hide();

      var node = card._el;
      D.clear(node);

      /* 五行色点 / 序号 */
      var head = el('div', { className: 'pao-hovercard__head' }, [
        (function () {
          var dot = el('i', { className: 'pao-hovercard__dot' });
          dot.style.background = data.hex || '#55DDF5';
          return dot;
        })(),
        el('span', { className: 'pao-hovercard__kicker', text: data.kicker }),
        data.badge ? el('span', { className: 'pao-hovercard__badge', text: data.badge }) : null
      ]);

      var name = el('div', { className: 'pao-hovercard__name', text: data.name });
      var zh = el('div', { className: 'pao-hovercard__zh', text: data.zh });

      var parts = [head, name, zh];

      if (data.desc) parts.push(el('div', { className: 'pao-hovercard__desc', text: data.desc }));

      if (data.metrics && data.metrics.length) {
        parts.push(el('div', { className: 'pao-hovercard__metrics' }, data.metrics.map(function (m) {
          return el('div', { className: 'pao-hovercard__metric' }, [
            el('span', { className: 'pao-hovercard__mk', text: m.k }),
            el('span', { className: 'pao-hovercard__mv', text: m.v })
          ]);
        })));
      }

      if (data.status) {
        var st = el('div', { className: 'pao-hovercard__status' }, [
          (function () { var i = el('i'); i.style.background = data.statusColor; return i; })(),
          el('span', { text: data.status })
        ]);
        parts.push(st);
      }

      parts.push(el('div', { className: 'pao-hovercard__cta', text: data.cta }));

      D.appendAll(node, parts);
      node.className = 'pao-hovercard is-in' + (data.kind === 'agent' ? ' pao-hovercard--agent' : '');
      card.visible = true;
      card._place();
    },

    _place: function () {
      var node = card._el;
      if (!node) return;
      var w = node.offsetWidth || 240;
      var h = node.offsetHeight || 120;
      var vw = window.innerWidth;
      var vh = window.innerHeight;

      var x = card._mx + 18;
      var y = card._my + 20;

      /* 右 / 下越界翻转 */
      if (x + w > vw - 12) x = card._mx - w - 18;
      if (y + h > vh - 12) y = card._my - h - 16;
      if (x < 8) x = 8;
      if (y < 8) y = 8;

      node.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
    },

    hide: function () {
      clearTimeout(card._timer);
      card.currentId = null;
      card._pending = null;
      if (!card._el) return;
      card._el.classList.remove('is-in');
      card.visible = false;
    }
  };

  /* ---------------- 内容装配 ---------------- */
  function buildData(p) {
    if (p.kind === 'module') return moduleData(p.id);
    if (p.kind === 'agent') return agentData(p.id);
    if (p.kind === 'core') {
      return {
        kind: 'core', kicker: 'CORE', badge: '',
        name: 'PERSONAL INTELLIGENCE CORE', zh: '个人智能核心',
        desc: '中央智能中枢：整合记忆、认知、执行与治理，五行轨道环绕。',
        hex: '#91DFFF', cta: '双击回到中心视角'
      };
    }
    return null;
  }

  function moduleData(id) {
    var list = (PAO.DATA && PAO.DATA.modules) || [];
    var m = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { m = list[i]; break; }
    if (!m) return null;
    var e = PAO.elementOf ? PAO.elementOf('module', id) : null;
    return {
      kind: 'module',
      kicker: (m.num ? m.num + ' / 06' : '') + (e ? '  ' + e.hanzi : ''),
      badge: '',
      name: m.name, zh: m.zh,
      desc: m.desc,
      metrics: m.metrics || [],
      hex: e ? e.hex : '#55DDF5',
      cta: '点击进入该模块场景'
    };
  }

  /* 后端 Agent 注册表缓存（拿到正式英文名与中文名） */
  var registryCache = {};
  function loadRegistry() {
    if (!PAO.net || PAO.net.state !== 'online') return;
    fetch('/api/agents').then(function (r) { return r.json(); }).then(function (d) {
      (d.agents || []).forEach(function (a) { registryCache[a.id] = a; });
    }).catch(function () {});
  }

  function agentData(id) {
    var n = PAO.scene && PAO.scene.agents ? PAO.scene.agents.getAgent(id) : null;
    var reg = registryCache[id];
    var e = PAO.elementOf ? PAO.elementOf('agent', id) : null;
    var S = PAO.STATUS_COLORS && PAO.STATUS_COLORS[n ? n.status : 'idle'];
    if (!n) return null;
    return {
      kind: 'agent',
      kicker: (e ? e.hanzi + '  ·  ' : '') + (n.isHub ? 'HUB' : 'AGENT'),
      badge: n.isHub ? '枢纽' : '',
      name: (reg && reg.name) || n.name,
      zh: (reg && reg.zh) || n.zh,
      desc: e ? e.virtue : '',
      hex: e ? e.hex : '#55DDF5',
      status: (S ? S.zh : '待命') + (n.note ? ' · ' + n.note : ''),
      statusColor: S ? S.hex : '#7E8999',
      cta: '点击聚焦并查看详情'
    };
  }

  /* ---------------- Agent 详情面板（动态注册） ---------------- */
  PAO.panels = PAO.panels || {};
  PAO.panels['agent-detail'] = {
    id: 'agent-detail', kicker: 'AGENT', label: 'AGENT DETAIL', zh: 'Agent 详情',
    tagline: 'ONE NODE. ONE RESPONSIBILITY.', taglineZh: '一个节点，一份职责。',
    badge: '真实状态',
    render: function (root, ctx) {
      var id = (ctx.store && ctx.store.selectedAgent) || null;
      var n = id && PAO.scene.agents ? PAO.scene.agents.getAgent(id) : null;
      var e = id && PAO.elementOf ? PAO.elementOf('agent', id) : null;
      var S = PAO.STATUS_COLORS || {};

      if (!n) {
        D.appendAll(root, [el('div', { className: 'pao-empty' }, [
          el('div', { className: 'pao-empty__title', text: '未选择 Agent' }),
          el('div', { className: 'pao-empty__hint', text: '在「网络」视图中点击任意节点查看详情。' })
        ])]);
        return;
      }

      var st = S[n.status] || S.idle;

      var rows = [
        ['节点 ID', n.agentId],
        ['五行', e ? e.hanzi + ' · ' + e.virtue : '—'],
        ['类型', n.isHub ? '枢纽节点（总协调）' : '执行节点'],
        ['当前状态', st.zh + (n.note ? ' · ' + n.note : '')]
      ];

      var info = el('div', { className: 'pao-section' }, [
        el('div', { className: 'pao-section__head' }, [
          el('div', { className: 'pao-section__title', text: '节点信息' })
        ]),
        el('div', { className: 'pao-section__body' }, [
          el('div', { className: 'pao-list' }, rows.map(function (r) {
            return el('div', { className: 'pao-kv' }, [
              el('span', { className: 'pao-kv__k', text: r[0] }),
              el('span', { className: 'pao-kv__v pao-mono', text: r[1] })
            ]);
          }))
        ])
      ]);

      var actions = el('div', { className: 'pao-section' }, [
        el('div', { className: 'pao-section__body' }, [
          (function () {
            var b = el('button', { className: 'pao-btn pao-btn--ghost pao-btn--block', attrs: { type: 'button' } },
              [D.icon('search', 13), el('span', { text: '在空间中重新聚焦' })]);
            b.addEventListener('click', function () { PAO.scene.focusAgent(id); });
            return b;
          })(),
          (function () {
            var b = el('button', { className: 'pao-btn pao-btn--ghost pao-btn--block', attrs: { type: 'button' } },
              [D.icon('refresh', 13), el('span', { text: '刷新状态' })]);
            b.addEventListener('click', function () { ctx.refresh(); });
            return b;
          })()
        ])
      ]);

      D.appendAll(root, [
        el('div', { className: 'pao-hero' }, [
          (function () {
            var dot = el('i', { className: 'pao-agentdetail__dot' });
            dot.style.background = e ? e.hex : 'var(--cyan)';
            return dot;
          })(),
          el('div', { className: 'pao-hero__slogan', text: n.name }),
          el('div', { className: 'pao-hero__sloganZh', text: n.zh }),
          el('p', { className: 'pao-hero__text', text: e ? e.desc : '' })
        ]),
        info,
        actions,
        el('div', { className: 'pao-disclosure' }, [
          el('div', { className: 'pao-disclosure__title', text: '状态来源' }),
          el('p', { className: 'pao-disclosure__text', text: '此面板数据来自后端 Agent Registry，经 WebSocket 实时同步；节点颜色与文字状态同源，非前端推断。' })
        ])
      ]);
    }
  };

  PAO.hovercard = card;
})(window.PAO = window.PAO || {});
