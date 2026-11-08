/* PERSONAL AI OS — 空间外壳：顶栏 / 导航 / 上下文面板 / 状态条 / 提示 / 弹层 / 设置 */
(function (PAO) {
  'use strict';

  PAO.panels = PAO.panels || {};

  var NAV = [
    { id: 'home', zh: '总览', en: 'HOME', icon: 'home' },
    { id: 'workspace', zh: '协作', en: 'AGENTS', icon: 'agent' },
    { id: 'memory', zh: '记忆', en: 'MEMORY', icon: 'memory' },
    { id: 'cognitive', zh: '知识', en: 'KNOWLEDGE', icon: 'cognition' },
    { id: 'agent', zh: '智能体', en: 'AGENTS', icon: 'agent' },
    { id: 'data', zh: '任务', en: 'TASKS', icon: 'data' },
    { id: 'model', zh: '事件', en: 'EVENTS', icon: 'model' },
    { id: 'trust', zh: '监控', en: 'MONITOR', icon: 'trust' }
  ];

  var D = PAO.dom;
  var el = D.el;

  var ui = {
    current: null,
    nav: null,
    panel: null,
    panelBody: null,
    panelHead: null,
    _panelCtx: null,
    _settingsOpen: false,
    _modalStack: 0,

    /* ============ 初始化 ============ */
    init: function () {
      ui.data = PAO.DATA || {};
      ui._buildTopbar();
      ui._buildNav();
      ui._buildPanelShell();
      ui._buildStatusbar();
      ui._buildHint();
      ui._buildSettings();
      ui._bindEvents();
      ui._startClock();
      ui._applyReducedMotion();
      return ui;
    },

    /* ============ 顶栏 ============ */
    _buildTopbar: function () {
      var bar = document.getElementById('pao-topbar');
      D.clear(bar);

      var brand = el('div', { className: 'pao-topbar__brand' }, [
        el('div', { className: 'pao-logo', attrs: { 'aria-hidden': 'true' } }, [
          D.svg('svg', { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none' }, [
            D.svg('path', { d: 'M12 2 21 12 12 22 3 12Z', stroke: 'var(--cyan)', 'stroke-width': 1.2 }),
            D.svg('circle', { cx: 12, cy: 12, r: 3.1, stroke: 'var(--ice)', 'stroke-width': 1, fill: 'rgba(85,221,245,.14)' }),
            D.svg('circle', { cx: 12, cy: 12, r: 0.9, fill: 'var(--white)' })
          ])
        ]),
        el('div', { className: 'pao-topbar__titles' }, [
          el('div', { className: 'pao-topbar__name', text: 'PERSONAL AI OS' }),
          el('div', { className: 'pao-topbar__sub', text: 'A NEW LAYER OF PERSONAL INTELLIGENCE' })
        ])
      ]);

      var status = el('div', { className: 'pao-topbar__status' }, [
        el('span', { className: 'pao-dot pao-dot--live' }),
        el('span', { className: 'pao-topbar__statusText', text: 'SUPER-BRAIN · 只读接入' }),
        el('span', { className: 'pao-topbar__divider' }),
        el('span', { className: 'pao-topbar__statusSub', text: '真实数据 · 只读 · 不落盘口令' })
      ]);

      var clock = el('div', { className: 'pao-clock', id: 'pao-clock', text: '--:--:--' });

      var actions = el('div', { className: 'pao-topbar__actions' }, [
        el('button', {
          className: 'pao-btn pao-btn--ghost pao-btn--compact',
          attrs: { type: 'button', title: '接入 / 更换只读口令' },
          on: { click: function () { ui.openSuperBrainGate(); } }
        }, [D.icon('shield', 13), el('span', { text: '接入' })]),
        el('button', {
          className: 'pao-btn pao-btn--icon',
          attrs: { type: 'button', title: '全屏', 'aria-label': '全屏' },
          on: { click: ui.toggleFullscreen }
        }, [D.icon('fullscreen', 15)]),
        el('button', {
          className: 'pao-btn pao-btn--icon',
          attrs: { type: 'button', title: '设置', 'aria-label': '设置' },
          on: { click: function () { ui.openSettings(true); } }
        }, [D.icon('settings', 15)]),
        el('button', {
          className: 'pao-btn pao-btn--icon',
          attrs: { type: 'button', title: '帮助', 'aria-label': '帮助' },
          on: { click: ui.showHelp }
        }, [D.icon('help', 15)])
      ]);

      D.appendAll(bar, [
        brand,
        el('div', { className: 'pao-topbar__right' }, [clock, actions])
      ]);
      ui._statusBarEl = status;
      bar.appendChild(status);
    },

    _startClock: function () {
      var node = document.getElementById('pao-clock');
      function pad(n) { return n < 10 ? '0' + n : '' + n; }
      function tick() {
        var d = new Date();
        node.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      }
      tick();
      setInterval(tick, 1000);
    },

    /* ============ 左侧导航 ============ */
    _buildNav: function () {
      var nav = document.getElementById('pao-nav');
      D.clear(nav);
      var frag = document.createDocumentFragment();

      NAV.forEach(function (item) {
        var btn = el('button', {
          className: 'pao-nav__item' + (item.id === 'home' ? ' is-active' : ''),
          attrs: { type: 'button' },
          dataset: { id: item.id }
        }, [
          el('span', { className: 'pao-nav__bar' }),
          el('span', { className: 'pao-nav__icon' }, [D.icon(item.icon, 17)]),
          el('span', { className: 'pao-nav__label', text: item.zh }),
          el('span', { className: 'pao-nav__en', text: item.en })
        ]);
        btn.addEventListener('click', function () { ui.go(item.id); });
        frag.appendChild(btn);
      });

      nav.appendChild(frag);
      ui.nav = nav;
    },

    _setNavActive: function (id) {
      if (!ui.nav) return;
      var items = ui.nav.querySelectorAll('.pao-nav__item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('is-active', items[i].dataset.id === id);
      }
    },

    /* ============ 右侧面板骨架 ============ */
    _buildPanelShell: function () {
      var panel = document.getElementById('pao-panel');
      D.clear(panel);

      var head = el('div', { className: 'pao-panel__head' });
      var body = el('div', { className: 'pao-panel__body', attrs: { id: 'pao-panel-body' } });
      var foot = el('div', { className: 'pao-panel__foot' });

      panel.appendChild(head);
      panel.appendChild(body);
      panel.appendChild(foot);

      ui.panel = panel;
      ui.panelHead = head;
      ui.panelBody = body;
      ui.panelFoot = foot;
    },

    _renderPanelHead: function (p) {
      var head = ui.panelHead;
      D.clear(head);

      var close = el('button', {
        className: 'pao-btn pao-btn--icon pao-panel__close',
        attrs: { type: 'button', title: '关闭面板（ESC）', 'aria-label': '关闭面板' },
        on: { click: function () { ui.toUniverse(); } }
      }, [D.icon('close', 15)]);

      D.appendAll(head, [
        el('div', { className: 'pao-panel__kickerRow' }, [
          el('span', { className: 'pao-panel__kicker', text: p.kicker || '' }),
          close
        ]),
        el('h2', { className: 'pao-panel__label', text: p.label || '' }),
        el('div', { className: 'pao-panel__zh', text: p.zh || '' }),
        p.tagline ? el('div', { className: 'pao-panel__tagline', text: p.tagline }) : null,
        p.taglineZh ? el('div', { className: 'pao-panel__taglineZh', text: p.taglineZh }) : null
      ]);
    },

    _renderPanelFoot: function (p) {
      D.clear(ui.panelFoot);
      D.appendAll(ui.panelFoot, [
        el('span', { className: 'pao-badge pao-badge--muted', text: p.badge || '真实数据' }),
        el('span', { className: 'pao-panel__stage', text: p.stageText || 'Super-Brain 只读真实数据' })
      ]);
    },

    /* ============ 底部状态条 ============ */
    _buildStatusbar: function () {
      var bar = document.getElementById('pao-statusbar');
      D.clear(bar);
      ui._statEls = {};

      function group(key, icon, label) {
        var val = el('span', { className: 'pao-stat__value', text: '—' });
        var sub = el('span', { className: 'pao-stat__sub', text: '' });
        ui._statEls[key] = { val: val, sub: sub };
        return el('div', { className: 'pao-stat' }, [
          el('span', { className: 'pao-stat__icon' }, [D.icon(icon, 14)]),
          el('div', { className: 'pao-stat__text' }, [
            el('span', { className: 'pao-stat__label', text: label }), val
          ]),
          sub
        ]);
      }

      D.appendAll(bar, [
        group('backend', 'shield', '数据源'),
        group('agents', 'agent', '智能体'),
        group('tasks', 'route', '任务'),
        group('events', 'model', '事件'),
        group('memory', 'memory', '记忆')
      ]);
      bar.appendChild(el('div', { className: 'pao-statusbar__note', text: 'Super-Brain 只读接口 · SSE 实时推送，断线自动轮询' }));

      ui._refreshStats();
      clearInterval(ui._statTimer);
      ui._statTimer = setInterval(ui._refreshStats, 6000);
    },

    _refreshStats: function () {
      if (!ui._statEls) return;
      function set(key, val, sub) {
        var e = ui._statEls[key];
        if (!e) return;
        e.val.textContent = val;
        e.sub.textContent = sub || '';
      }
      var SB = PAO.SB;
      if (!SB) return;
      if (SB.state === 'locked') {
        set('backend', '未接入', '需要只读口令');
        set('agents', '—', ''); set('tasks', '—', ''); set('events', '—', ''); set('memory', '—', '');
        return;
      }
      if (SB.state === 'offline' || !SB.data.overview) {
        set('backend', '连接失败', SB.error || '等待重试');
        set('agents', '—', ''); set('tasks', '—', ''); set('events', '—', ''); set('memory', '—', '');
        return;
      }
      var ov = SB.data.overview || {};
      set('backend', SB.state === 'online' ? '在线' : '轮询', SB.statusText());
      set('agents', (ov.agents_online || 0) + ' / ' + (ov.agents_total || 0), (ov.agents_working || 0) + ' 工作中');
      set('tasks', (ov.tasks_running || 0) + ' 执行中', (ov.tasks_pending || 0) + ' 待执行');
      set('events', String(ov.events_today || 0), '今日事件');
      set('memory', String(SB.data.sessions.length), '会话线程');
    },

    /* ============ 操作提示 ============ */
    _buildHint: function () {
      var h = document.getElementById('pao-home-hint');
      D.clear(h);
      D.appendAll(h, [
        el('span', { className: 'pao-hint__item' }, [D.icon('refresh', 12), el('span', { text: '拖动旋转' })]),
        el('span', { className: 'pao-hint__item' }, [D.icon('search', 12), el('span', { text: '滚轮缩放' })]),
        el('span', { className: 'pao-hint__item' }, [D.icon('chevron', 12), el('span', { text: '点击模块进入' })]),
        el('span', { className: 'pao-hint__item' }, [D.icon('home', 12), el('span', { text: '双击核心回到中心' })])
      ]);
    },

    /* ============ 五行图例（仅 Agent 网络视图显示） ============ */
    _buildWuxing: function () {
      var E = PAO.ELEMENTS;
      if (!E) return;
      var host = document.getElementById('pao-app');
      if (!host) return;
      var old = document.getElementById('pao-wuxing');
      if (old) old.parentNode.removeChild(old);

      var box = el('div', { className: 'pao-wuxing', attrs: { id: 'pao-wuxing' } });
      box.appendChild(el('div', { className: 'pao-wuxing__title', text: '五行 · 身份色' }));

      var order = ['wood', 'fire', 'earth', 'metal', 'water'];
      order.forEach(function (k) {
        var e = E[k];
        var dot = el('i', { className: 'pao-wuxing__dot' });
        dot.style.background = e.hex;
        box.appendChild(el('div', { className: 'pao-wuxing__row' }, [
          dot,
          el('span', { className: 'pao-wuxing__hanzi', text: e.hanzi }),
          el('span', { className: 'pao-wuxing__txt', text: e.virtue })
        ]));
      });

      box.appendChild(el('div', { className: 'pao-wuxing__sep' }));
      box.appendChild(el('div', { className: 'pao-wuxing__title', text: '运行状态' }));

      var S = PAO.STATUS_COLORS || {};
      var st = el('div', { className: 'pao-wuxing__status' });
      ['idle', 'thinking', 'running', 'waiting', 'completed', 'failed'].forEach(function (k) {
        var c = S[k]; if (!c) return;
        var dot = el('i');
        dot.style.background = c.hex;
        st.appendChild(el('span', { className: 'pao-wuxing__st' }, [dot, el('span', { text: c.zh })]));
      });
      box.appendChild(st);
      host.appendChild(box);
      ui.wuxing = box;
    },

    /* ============ 设置抽屉 ============ */
    _buildSettings: function () {
      var host = document.getElementById('pao-settings');
      if (!host) return;
      D.clear(host);
      var drawer = el('aside', { className: 'pao-drawer', attrs: { 'aria-label': '系统设置' } });

      var st = PAO.bus.store;
      var s = (ui.data && ui.data.settings) || {};

      function switchRow(label, hint, on, onChange) {
        var sw = el('button', {
          className: 'pao-switch' + (on ? ' is-on' : ''),
          attrs: { type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false' }
        }, [el('span', { className: 'pao-switch__knob' })]);
        sw.addEventListener('click', function () {
          var next = !sw.classList.contains('is-on');
          sw.classList.toggle('is-on', next);
          sw.setAttribute('aria-checked', next ? 'true' : 'false');
          onChange(next);
        });
        return el('div', { className: 'pao-setting' }, [
          el('div', { className: 'pao-setting__text' }, [
            el('div', { className: 'pao-setting__label', text: label }),
            hint ? el('div', { className: 'pao-setting__hint', text: hint }) : null
          ]),
          sw
        ]);
      }

      var qualitySeg = el('div', { className: 'pao-seg' });
      ['高画质', '节能'].forEach(function (t, i) {
        var b = el('button', {
          className: 'pao-seg__item' + ((i === 0) === (PAO.engine.quality === 'high') ? ' is-active' : ''),
          attrs: { type: 'button' },
          text: t
        });
        b.addEventListener('click', function () {
          qualitySeg.querySelectorAll('.pao-seg__item').forEach(function (x) { x.classList.remove('is-active'); });
          b.classList.add('is-active');
          PAO.engine.setQuality(i === 0 ? 'high' : 'low');
          ui.toast('info', '渲染质量已切换', i === 0 ? '已启用完整粒子与数据流效果。' : '已降低粒子密度以保障帧率。');
        });
        qualitySeg.appendChild(b);
      });

      D.appendAll(drawer, [
        el('div', { className: 'pao-drawer__head' }, [
          el('span', { className: 'pao-drawer__title', text: '系统设置' }),
          el('button', {
            className: 'pao-btn pao-btn--icon', attrs: { type: 'button', 'aria-label': '关闭设置' },
            on: { click: function () { ui.openSettings(false); } }
          }, [D.icon('close', 15)])
        ]),
        el('div', { className: 'pao-drawer__body' }, [
          el('div', { className: 'pao-section__title', text: '渲染' }),
          el('div', { className: 'pao-setting' }, [
            el('div', { className: 'pao-setting__text' }, [
              el('div', { className: 'pao-setting__label', text: '渲染质量' }),
              el('div', { className: 'pao-setting__hint', text: '帧率偏低时会自动降级为节能模式' })
            ]),
            qualitySeg
          ]),
          switchRow('减少动态效果', '关闭持续动画与镜头呼吸，适合专注阅读', st.reducedMotion, function (v) {
            PAO.bus.set({ reducedMotion: v });
            PAO.fx.setReduced(v);
            document.documentElement.classList.toggle('pao-reduce-motion', v);
            ui.toast('info', v ? '已开启减少动态效果' : '已恢复完整动效', '');
          }),
          switchRow('显示空间标签', '在三维空间中显示模块名称', true, function (v) {
            PAO.labels.setVisible(v);
          }),
          switchRow('显示数据流', '模块与核心之间的流动粒子', true, function (v) {
            PAO.scene.modules.items.forEach(function (it) { it.flow.visible = v; it.tube.visible = v; });
          }),
          switchRow('自动旋转', '空闲时缓慢环绕核心', false, function (v) {
            PAO.rig.setAutoRotate(v);
            PAO.bus.set({ autoRotate: v });
          }),
          el('div', { className: 'pao-section__title', text: '显示' }),
          el('button', {
            className: 'pao-btn pao-btn--ghost pao-btn--block',
            attrs: { type: 'button' },
            on: { click: function () { ui.openSettings(false); ui.replayIntro(); } }
          }, [D.icon('play', 13), el('span', { text: '重新播放启动动画' })]),
          el('button', {
            className: 'pao-btn pao-btn--ghost pao-btn--block',
            attrs: { type: 'button' },
            on: { click: ui.toggleFullscreen }
          }, [D.icon('fullscreen', 13), el('span', { text: '切换全屏' })]),
          el('div', { className: 'pao-section__title', text: 'Super-Brain' }),
          el('div', { className: 'pao-about' }, [
            el('div', { className: 'pao-kv' }, [
              el('span', { className: 'pao-kv__k', text: '连接状态' }),
              el('span', { className: 'pao-kv__v', text: PAO.SB ? (PAO.SB.statusText() + ' · ' + PAO.SB.state) : '未初始化' })
            ]),
            el('div', { className: 'pao-kv' }, [
              el('span', { className: 'pao-kv__k', text: '数据范围' }),
              el('span', { className: 'pao-kv__v', text: '只读：overview / agents / tasks / events / knowledge / monitor / memory / relations' })
            ]),
            el('button', {
              className: 'pao-btn pao-btn--ghost pao-btn--block',
              attrs: { type: 'button' },
              on: { click: function () { ui.openSettings(false); ui.openSuperBrainGate(); } }
            }, [D.icon('shield', 13), el('span', { text: '更换只读口令' })]),
            el('button', {
              className: 'pao-btn pao-btn--ghost pao-btn--block',
              attrs: { type: 'button' },
              on: {
                click: function () {
                  if (!PAO.SB) return;
                  PAO.SB.clearToken();
                  ui.openSettings(false);
                  ui.toast('info', '已断开 Super-Brain', '口令已从本机清除。');
                  ui._refreshStats();
                }
              }
            }, [D.icon('close', 13), el('span', { text: '断开并清除本机口令' })])
          ]),
          el('div', { className: 'pao-section__title', text: '关于' }),
          el('div', { className: 'pao-about' }, [
            el('div', { className: 'pao-kv' }, [
              el('span', { className: 'pao-kv__k', text: '产品版本' }),
              el('span', { className: 'pao-kv__v pao-mono', text: 'PAO × SUPER-BRAIN 1.0' })
            ]),
            el('div', { className: 'pao-kv' }, [
              el('span', { className: 'pao-kv__k', text: '项目阶段' }),
              el('span', { className: 'pao-kv__v', text: '运行阶段 · 真实数据只读接入' })
            ]),
            el('p', { className: 'pao-about__note', text: '全部指标来自 Super-Brain 的只读接口；没有记录的字段显示「暂无数据」，不做估算。三维场景中的智能体、记忆与协作关系均由真实表数据生成。' })
          ])
        ])
      ]);
      host.appendChild(drawer);
      host.addEventListener('click', function (e) { if (e.target === host) ui.openSettings(false); });
      ui.settings = host;
      ui.drawer = drawer;
    },

    openSettings: function (open) {
      ui._settingsOpen = !!open;
      if (ui.settings) ui.settings.classList.toggle('is-open', ui._settingsOpen);
    },

    toggleFullscreen: function () {
      var d = document;
      if (!d.fullscreenElement && !d.webkitFullscreenElement) {
        var e = d.documentElement;
        (e.requestFullscreen || e.webkitRequestFullscreen || function () {}).call(e);
        ui.toast('info', '已进入全屏', '按 ESC 退出全屏。');
      } else {
        (d.exitFullscreen || d.webkitExitFullscreen || function () {}).call(d);
      }
    },

    showHelp: function () {
      ui.modal({
        kicker: '操作指南',
        title: '如何探索这个空间系统',
        body: el('div', { className: 'pao-help' }, [
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '旋转视角' }), el('span', { className: 'pao-kv__v', text: '按住左键拖动' })]),
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '缩放' }), el('span', { className: 'pao-kv__v', text: '鼠标滚轮 / 触控板双指' })]),
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '进入模块' }), el('span', { className: 'pao-kv__v', text: '点击空间中的模块或左侧导航' })]),
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '回到中心' }), el('span', { className: 'pao-kv__v', text: '双击中央核心 / 点击总览 / 按 ESC' })]),
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '协作网络' }), el('span', { className: 'pao-kv__v', text: '左侧「协作」进入三层智能体网络' })]),
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '数据来源' }), el('span', { className: 'pao-kv__v', text: '全部来自 Super-Brain 只读接口，无本地模拟' })]),
          el('p', { className: 'pao-about__note', text: '提示：首次使用需点击右上角「接入」输入只读口令；口令只保存在本机浏览器，不会显示或上传。' })
        ]),
        actions: [{ label: '知道了', primary: true, onClick: function (close) { close(); } }]
      });
    },

    /* ============ 面板路由 ============ */
    go: function (id) {
      if (id === 'home') {
        ui.openPanel('home');
        ui._setNavActive('home');
        PAO.scene.home();
        PAO.bus.set({ activeModule: null });
        return;
      }
      if (id === 'workspace') {
        if (PAO.scene.mode !== 'universe') PAO.scene.setMode('universe');
        ui.openPanel(id);
        ui._setNavActive(id);
        PAO.bus.set({ activeModule: null });
        return;
      }

      ui.openPanel(id);

      if (id === 'graph') {
        ui._setNavActive('graph');
        PAO.scene.setMode('graph');
        PAO.bus.set({ activeModule: null, mode: 'graph' });
        return;
      }

      if (id === 'agent-detail') {
        ui._setNavActive('workspace');
        return;
      }

      if (id === 'memory') {
        PAO.scene.setMode('memory');
        PAO.bus.set({ memoryFilter: 'ALL' });
      } else if (id === 'architecture') {
        PAO.scene.setMode('architecture');
        PAO.scene.setArchitectureLayer(-1);
      } else {
        if (PAO.scene.mode !== 'universe') PAO.scene.setMode('universe');
        setTimeout(function () { PAO.scene.focusModule(id); }, 460);
      }
      ui._setNavActive(id);
      PAO.bus.set({ activeModule: id });
    },

    home: function () {
      ui.go('home');
    },

    /* 关闭面板，回到纯净的空间视图（× 与 ESC 的行为） */
    toUniverse: function () {
      ui.closePanel();
      ui._setNavActive('home');
      PAO.scene.home();
      PAO.bus.set({ activeModule: null });
    },

    openPanel: function (id) {
      var p = PAO.panels[id];
      if (!p) {
        p = ui._fallbackPanel(id);
      }
      if (!p) return;

      ui.current = id;
      ui._renderPanelHead(p);
      ui._renderPanelFoot(p);
      D.clear(ui.panelBody);

      var ctx = {
        root: ui.panelBody,
        store: PAO.bus.store,
        bus: PAO.bus,
        data: ui.data,
        dom: D,
        ui: ui,
        scene: PAO.scene,
        dom_root: ui.panel,
        go: function (target) { ui.go(target); },
        refresh: function () { if (ui.current === id) ui.openPanel(id); },
        width: function () { return ui.panel.clientWidth; },
        height: function () { return ui.panelBody.clientHeight; }
      };
      ui._panelCtx = ctx;

      try {
        p.render(ui.panelBody, ctx);
      } catch (err) {
        console.error('[panel] render failed:', id, err);
        D.appendAll(ui.panelBody, [
          el('div', { className: 'pao-empty' }, [
            el('div', { className: 'pao-empty__title', text: '该模块渲染失败' }),
            el('div', { className: 'pao-empty__hint', text: '请查看浏览器控制台获取详细信息。' })
          ])
        ]);
      }

      ui.panel.classList.add('is-open');
      ui.panel.classList.toggle('is-wide', id === 'architecture');
      var appEl = document.getElementById('pao-app');
      if (appEl) appEl.classList.add('is-panel-open');
      if (p.onEnter) { try { p.onEnter(ctx); } catch (e) { console.error(e); } }
    },

    closePanel: function () {
      var id = ui.current;
      if (id && PAO.panels[id] && PAO.panels[id].onExit) {
        try { PAO.panels[id].onExit(ui._panelCtx); } catch (e) { console.error(e); }
      }
      ui.current = null;
      ui._panelCtx = null;
      if (ui.panel) ui.panel.classList.remove('is-open');
      if (ui.panelBody) D.clear(ui.panelBody);
      var appEl = document.getElementById('pao-app');
      if (appEl) appEl.classList.remove('is-panel-open');
    },

    _fallbackPanel: function (id) {
      return {
        id: id, kicker: 'MODULE', label: id.toUpperCase(), zh: '模块',
        tagline: '', taglineZh: '', badge: '加载失败',
        render: function (root) {
          D.appendAll(root, [
            el('div', { className: 'pao-empty' }, [
              el('div', { className: 'pao-empty__title', text: '模块未加载' }),
              el('div', { className: 'pao-empty__hint', text: '该模块的脚本可能加载失败，请检查文件是否存在。' })
            ])
          ]);
        }
      };
    },

    setContextPanelWidth: function (px) {
      if (ui.panel) ui.panel.style.width = Math.max(360, Math.min(620, px)) + 'px';
    },

    /* ============ 提示 / 弹层 ============ */
    toast: function (kind, title, text) {
      var host = document.getElementById('pao-toasts');
      if (!host) return;
      var icons = { ok: 'check', warn: 'warning', crit: 'warning', info: 'help' };
      var node = el('div', { className: 'pao-toast pao-toast--' + (kind || 'info') }, [
        el('span', { className: 'pao-toast__icon' }, [D.icon(icons[kind] || 'help', 14)]),
        el('div', { className: 'pao-toast__text' }, [
          el('div', { className: 'pao-toast__title', text: title || '' }),
          text ? el('div', { className: 'pao-toast__body', text: text }) : null
        ])
      ]);
      host.appendChild(node);
      requestAnimationFrame(function () { node.classList.add('is-in'); });
      setTimeout(function () {
        node.classList.remove('is-in');
        setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 320);
      }, 3800);
    },

    modal: function (opts) {
      var root = document.getElementById('pao-modal-root');
      if (!root) return null;
      opts = opts || {};

      var overlay = el('div', { className: 'pao-modal' });
      var card = el('div', { className: 'pao-modal__card' });

      var close = function () {
        overlay.classList.remove('is-in');
        setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 260);
      };

      if (opts.kicker) card.appendChild(el('div', { className: 'pao-modal__kicker', text: opts.kicker }));
      if (opts.title) card.appendChild(el('h3', { className: 'pao-modal__title', text: opts.title }));
      if (opts.body) {
        card.appendChild(el('div', { className: 'pao-modal__body' }, [opts.body]));
      }
      if (opts.actions && opts.actions.length) {
        var row = el('div', { className: 'pao-modal__actions' });
        opts.actions.forEach(function (a) {
          var b = el('button', {
            className: 'pao-btn ' + (a.primary ? 'pao-btn--primary' : (a.danger ? 'pao-btn--danger' : 'pao-btn--ghost')),
            attrs: { type: 'button' },
            text: a.label
          });
          b.addEventListener('click', function () {
            if (a.onClick) a.onClick(close);
            else close();
          });
          row.appendChild(b);
        });
        card.appendChild(row);
      }

      var x = el('button', {
        className: 'pao-btn pao-btn--icon pao-modal__close',
        attrs: { type: 'button', 'aria-label': '关闭' },
        on: { click: close }
      }, [D.icon('close', 15)]);
      card.appendChild(x);

      overlay.appendChild(card);
      root.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('is-in'); });

      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
      });

      return { close: close, el: overlay, card: card };
    },

    confirm: function (opts) {
      opts = opts || {};
      return new Promise(function (resolve) {
        var settled = false;
        var m = ui.modal({
          kicker: opts.kicker || (opts.danger ? '高风险操作确认' : '请确认'),
          title: opts.title || '确认执行此操作？',
          body: el('div', {}, [
            el('p', { className: 'pao-modal__text', text: opts.text || '' }),
            opts.danger ? el('div', { className: 'pao-warnbox' }, [
              D.icon('warning', 14),
              el('span', { text: '此操作仅作用于页面内存数据，刷新页面即还原。' })
            ]) : null
          ]),
          actions: [
            {
              label: opts.cancelText || '取消',
              onClick: function (close) { settled = true; close(); resolve(false); }
            },
            {
              label: opts.confirmText || '确认',
              danger: !!opts.danger,
              primary: !opts.danger,
              onClick: function (close) { settled = true; close(); resolve(true); }
            }
          ]
        });
        if (m) {
          m.el.addEventListener('click', function (e) {
            if (e.target === m.el && !settled) setTimeout(function () { if (!settled) { settled = true; resolve(false); } }, 0);
          });
        }
      });
    },

    /* ============ 其它 ============ */
    replayIntro: function () {
      try { localStorage.removeItem('pao_intro_seen'); } catch (e) {}
      if (PAO.boot) PAO.boot.run(true);
    },

    _applyReducedMotion: function () {
      var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq && mq.matches) {
        PAO.fx.setReduced(true);
        PAO.bus.set({ reducedMotion: true });
      }
    },

    _bindEvents: function () {
      PAO.bus.on('nav:go', function (p) { if (p && p.id) ui.go(p.id); });
      PAO.bus.on('nav:home', function () { ui.home(); });
      PAO.bus.on('toast', function (p) { ui.toast(p.kind, p.title, p.text); });
      PAO.bus.on('perf:low', function () { ui.toast('warn', '已切换到节能渲染', '为保持流畅，部分粒子与数据流已降低密度。'); });
      PAO.bus.on('state', function () {
        var appEl = document.getElementById('pao-app');
        if (!appEl) return;
        var isWs = PAO.bus.store.mode === 'workspace' ||
          (document.querySelector('.pao-nav__item.is-active') || {}).dataset &&
          document.querySelector('.pao-nav__item.is-active').dataset.id === 'workspace';
        appEl.classList.toggle('is-workspace', !!isWs);
      });
      PAO.bus.on('srv:online', function () { ui._refreshStats(); });
      PAO.bus.on('srv:offline', function () { ui._refreshStats(); });
      PAO.bus.on('srv:agent.status.changed', function () { ui._refreshStats(); });
      PAO.bus.on('srv:task.completed', function () { ui._refreshStats(); });
      PAO.bus.on('srv:task.created', function () { ui._refreshStats(); });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          if (ui._modalOpen()) return;
          if (ui._settingsOpen) { ui.openSettings(false); return; }
          ui.toUniverse();
        }
      });
    },

    _modalOpen: function () {
      var root = document.getElementById('pao-modal-root');
      return root && root.children.length > 0;
    }
  };

  /* ============ 内置：总览面板 ============ */
  PAO.panels.home = {
    id: 'home', kicker: 'OVERVIEW', label: 'PERSONAL INTELLIGENCE UNIVERSE', zh: '个人智能宇宙 · 总览',
    tagline: 'A NEW LAYER OF PERSONAL INTELLIGENCE.', taglineZh: '一层全新的个人智能。',
    badge: '真实数据',
    render: function (root, ctx) {
      var data = ctx.data;
      var mv = (data.meta) || {};

      D.appendAll(root, [
        el('div', { className: 'pao-hero' }, [
          el('div', { className: 'pao-hero__slogan', text: 'KNOW ME. THINK WITH ME. ACT FOR ME.' }),
          el('div', { className: 'pao-hero__sloganZh', text: '懂我 · 与我同思 · 为我而行' }),
          el('p', { className: 'pao-hero__text', text: '这是位于你、你的数据、你的记忆、AI 模型与智能体工具之间的个人智能操作系统。它不是聊天机器人，也不是新的基础模型。' })
        ]),

        el('div', { className: 'pao-stage-note' }, [
          D.icon('warning', 13),
          el('span', { text: '当前阶段：本地记忆引擎、知识图谱与云脑接入已运行；连接器与权限演练为本地模拟。' })
        ]),

        el('div', { className: 'pao-section' }, [
          el('div', { className: 'pao-section__head' }, [
            el('div', { className: 'pao-section__title', text: '六大核心系统' }),
            el('div', { className: 'pao-section__hint', text: '点击任意系统进入其空间场景' })
          ]),
          el('div', { className: 'pao-module-grid' }, (data.modules || []).map(function (m) {
            var card = el('button', { className: 'pao-module-card', attrs: { type: 'button' } }, [
              el('div', { className: 'pao-module-card__num', text: m.num }),
              el('div', { className: 'pao-module-card__name', text: m.name }),
              el('div', { className: 'pao-module-card__zh', text: m.zh }),
              el('div', { className: 'pao-module-card__desc', text: m.desc }),
              el('div', { className: 'pao-module-card__metrics' }, (m.metrics || []).map(function (x) {
                return el('div', { className: 'pao-module-card__metric' }, [
                  el('span', { className: 'pao-module-card__mk', text: x.k }),
                  el('span', { className: 'pao-module-card__mv', text: x.v })
                ]);
              }))
            ]);
            card.addEventListener('click', function () { ctx.go(m.id); });
            return card;
          }))
        ]),

        el('div', { className: 'pao-section' }, [
          el('div', { className: 'pao-section__head' }, [
            el('div', { className: 'pao-section__title', text: '从这里开始' })
          ]),
          el('div', { className: 'pao-cta-row' }, [
            (function () {
              var b = el('button', { className: 'pao-btn pao-btn--primary', attrs: { type: 'button' } }, [D.icon('play', 13), el('span', { text: '启动引导体验' })]);
              b.addEventListener('click', function () { ctx.go('guided'); });
              return b;
            })(),
            (function () {
              var b = el('button', { className: 'pao-btn pao-btn--ghost', attrs: { type: 'button' } }, [D.icon('architecture', 13), el('span', { text: '查看七层架构' })]);
              b.addEventListener('click', function () { ctx.go('architecture'); });
              return b;
            })(),
            (function () {
              var b = el('button', { className: 'pao-btn pao-btn--ghost', attrs: { type: 'button' } }, [D.icon('agent', 13), el('span', { text: '运行一个智能体任务' })]);
              b.addEventListener('click', function () { ctx.go('agent'); });
              return b;
            })()
          ])
        ]),

        el('div', { className: 'pao-disclosure' }, [
          el('div', { className: 'pao-disclosure__title', text: '内容诚实性声明' }),
          el('p', { className: 'pao-disclosure__text', text: mv.disclaimer || '记忆库与知识图谱为真实数据；连接器与权限演练为本地模拟，未接入外部账户。' })
        ])
      ]);
    }
  };

  PAO.ui = ui;
})(window.PAO = window.PAO || {});
