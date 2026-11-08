/* PERSONAL AI OS — Super-Brain 真实数据面板
   六个域：记忆 / 知识 / 智能体 / 任务 / 事件 / 监控 + 总览
   原则：只显示 /api/* 返回的真实字段；缺失写「暂无数据」；不估算、不编造。 */
(function (PAO) {
  'use strict';

  PAO.panels = PAO.panels || {};
  var D = PAO.dom;
  var el = D.el;
  var subs = {};

  var STATUS_ZH = {
    pending: '待执行', doing: '执行中', done: '已完成', failed: '失败',
    dead: '死信', cancelled: '已取消'
  };
  var LIVE_ZH = { working: '工作中', idle: '空闲', offline: '离线' };
  var PRIORITY_ZH = { 0: '普通', 1: '高', 2: '紧急' };

  function t(sec) { return PAO.SB ? PAO.SB.fmtTime(sec) : '—'; }
  function keyOf(p) { return p && p.event_id ? p.event_id : ''; }
  function statusKind(s) {
    if (s === 'done') return 'ok';
    if (s === 'doing') return 'cyan';
    if (s === 'failed' || s === 'dead') return 'crit';
    if (s === 'pending') return 'warn';
    return 'muted';
  }
  function liveKind(s) {
    if (s === 'working') return 'cyan';
    if (s === 'idle') return 'ok';
    return 'muted';
  }
  function inputFocused(root) {
    var a = document.activeElement;
    return !!(a && root && root.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'));
  }
  function live(ctx, id) {
    unsub(id);
    subs[id] = ctx.bus.on('sb:data', function () {
      if (PAO.ui.current === id && !inputFocused(ctx.root)) ctx.refresh();
    });
  }
  function unsub(id) { if (subs[id]) { try { subs[id](); } catch (e) {} delete subs[id]; } }

  function empty(text) {
    return el('div', { className: 'pao-empty' }, [
      el('div', { className: 'pao-empty__title', text: text || '暂无数据' }),
      el('div', { className: 'pao-empty__hint', text: '该接口当前没有可展示的真实记录。' })
    ]);
  }

  function metric(k, v, sub, kind) {
    return el('div', { className: 'sb-metric' + (kind ? ' is-' + kind : '') }, [
      el('div', { className: 'sb-metric__k', text: k }),
      el('div', { className: 'sb-metric__v', text: v == null ? '暂无数据' : String(v) }),
      sub ? el('div', { className: 'sb-metric__sub', text: sub }) : null
    ]);
  }
  function bar(pct) {
    var v = Math.max(0, Math.min(95, Number(pct) || 0));
    return el('div', { className: 'sb-bar' }, [
      el('i', { className: 'sb-bar__fill', style: { width: v + '%' } })
    ]);
  }
  function chip(text, kind) {
    return el('span', { className: 'sb-chip' + (kind ? ' is-' + kind : ''), text: text });
  }
  function row(title, meta, aside, onClick, extra) {
    var node = el('div', { className: 'sb-row' }, [
      el('div', { className: 'sb-row__main' }, [
        el('div', { className: 'sb-row__title', text: title }),
        meta ? el('div', { className: 'sb-row__meta', text: meta }) : null,
        extra || null
      ]),
      aside ? el('div', { className: 'sb-row__aside' }, aside) : null
    ]);
    if (onClick) {
      node.classList.add('is-clickable');
      node.addEventListener('click', onClick);
    }
    return node;
  }
  function section(title, hint, kids) {
    return el('div', { className: 'pao-section' }, [
      el('div', { className: 'pao-section__head' }, [
        el('div', { className: 'pao-section__title', text: title }),
        hint ? el('div', { className: 'pao-section__hint', text: hint }) : null
      ]),
      kids
    ]);
  }
  function filters(list, key, onChange) {
    var wrap = el('div', { className: 'sb-chips' });
    list.forEach(function (f, i) {
      var b = el('button', { className: 'sb-chip sb-chip--btn' + (i === 0 ? ' is-on' : ''), attrs: { type: 'button' }, text: f.label });
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(wrap.children, function (c) { c.classList.remove('is-on'); });
        b.classList.add('is-on');
        onChange(f.id);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  /* ======================= 总览 ======================= */
  PAO.panels.home = {
    id: 'home', kicker: 'OVERVIEW', label: 'SUPER-BRAIN CONTROL', zh: '超级大脑 · 总览',
    tagline: 'REAL DATA. REAL AGENTS. REAL QUEUE.', taglineZh: '真实数据 · 真实智能体 · 真实队列。',
    badge: '只读真实数据',
    render: function (root, ctx) {
      var d = PAO.SB ? PAO.SB.data : {};
      var ov = d.overview;
      if (PAO.SB && PAO.SB.state === 'locked') {
        D.appendAll(root, [
          section('尚未接入 Super-Brain', '口令仅保存在本机浏览器', el('div', {}, [
            el('p', { className: 'sb-note', text: '需要输入控制台只读口令才能读取真实运行数据。页面不会显示口令，也不会写入服务端。' }),
            (function () {
              var b = el('button', { className: 'pao-btn pao-btn--primary', attrs: { type: 'button' }, text: '输入只读口令' });
              b.addEventListener('click', function () { ctx.ui.openSuperBrainGate(); });
              return b;
            })()
          ]))
        ]);
        return;
      }
      if (!ov) { D.appendAll(root, [empty('数据加载中…')]); return; }

      var tasks = ov.tasks || {};
      D.appendAll(root, [
        section('运行态', PAO.SB.statusText(), el('div', { className: 'sb-grid' }, [
          metric('指挥入口', (ov.agents_total || 0) - countWorkers(d.agents), '含幕僚长 TRAE', 'cyan'),
          metric('执行者', countWorkers(d.agents), '常驻线程', 'cyan'),
          metric('在线', ov.agents_online, '实时心跳'),
          metric('工作中', ov.agents_working, '当前租约'),
          metric('待执行任务', ov.tasks_pending, '队列', ov.tasks_pending ? 'warn' : ''),
          metric('执行中任务', ov.tasks_running, 'doing', ov.tasks_running ? 'cyan' : ''),
          metric('失败任务', ov.tasks_failed, 'failed + dead', ov.tasks_failed ? 'crit' : ''),
          metric('今日事件', ov.events_today, 'events 表'),
          metric('待批示', ov.pending_decisions, '高优先级 pending', ov.pending_decisions ? 'warn' : ''),
          metric('累计完成', tasks.done || 0, 'done')
        ])),
        section('最近事件', '来自 /api/events', (function () {
          var list = (d.events || []).slice(0, 6);
          if (!list.length) return empty();
          return el('div', { className: 'sb-list' }, list.map(function (e) {
            return row(e.type || '未命名事件', (e.source || '未知来源') + ' · ' + t(e.created_at), chip(STATUS_ZH[e.status] || e.status || '—', statusKind(e.status)));
          }));
        })()),
        section('工作流入口', '幕僚长 → 指挥入口 → 执行者', el('div', { className: 'sb-chips' }, [
          (function () {
            var b = el('button', { className: 'pao-btn pao-btn--ghost', attrs: { type: 'button' }, text: '打开协作网络' });
            b.addEventListener('click', function () { ctx.go('workspace'); });
            return b;
          })(),
          (function () {
            var b = el('button', { className: 'pao-btn pao-btn--ghost', attrs: { type: 'button' }, text: '查看任务队列' });
            b.addEventListener('click', function () { ctx.go('data'); });
            return b;
          })(),
          (function () {
            var b = el('button', { className: 'pao-btn pao-btn--ghost', attrs: { type: 'button' }, text: '查看监控' });
            b.addEventListener('click', function () { ctx.go('trust'); });
            return b;
          })()
        ]))
      ]);
    },
    onEnter: function (ctx) { live(ctx, 'home'); },
    onExit: function () { unsub('home'); }
  };

  function countWorkers(agents) {
    var n = 0;
    (agents || []).forEach(function (a) { if (a.kind === 'worker') n++; });
    return n;
  }

  /* ======================= 记忆（会话线程） ======================= */
  PAO.panels.memory = {
    id: 'memory', kicker: 'MEMORY', label: 'SESSION MEMORY', zh: '记忆 · 会话线程',
    tagline: 'EVERY THREAD, REMEMBERED.', taglineZh: '每一条会话线程，都留下痕迹。',
    badge: 'sessions 表',
    render: function (root, ctx) {
      var d = PAO.SB ? PAO.SB.data : {};
      var sessions = d.sessions || [];
      var workers = {};
      sessions.forEach(function (s) { workers[s.worker || '未知'] = (workers[s.worker || '未知'] || 0) + 1; });
      D.appendAll(root, [
        section('概览', '共 ' + sessions.length + ' 条线程', el('div', { className: 'sb-grid sb-grid--3' }, [
          metric('会话线程', sessions.length),
          metric('涉及执行者', Object.keys(workers).length),
          metric('最近更新', sessions.length ? t(sessions[0].updated_at) : '暂无数据')
        ])),
        section('最近线程', '点击可在三维记忆宇宙中定位', (function () {
          if (!sessions.length) return empty();
          return el('div', { className: 'sb-list' }, sessions.slice(0, 30).map(function (s, i) {
            return row(String(s.thread_id || '线程 ' + (i + 1)), (s.worker || '未知执行者') + ' · ' + t(s.updated_at), null, function () {
              if (PAO.scene && PAO.scene.selectMemory) PAO.scene.selectMemory('S-' + (s.thread_id || i));
            });
          }));
        })()),
        section('执行者记忆分布', '按 sessions.worker 聚合', (function () {
          var keys = Object.keys(workers);
          if (!keys.length) return empty();
          return el('div', { className: 'sb-list' }, keys.map(function (k) {
            return row(k, workers[k] + ' 条线程', chip(String(workers[k]), 'cyan'));
          }));
        })())
      ]);
    },
    onEnter: function (ctx) { live(ctx, 'memory'); },
    onExit: function () { unsub('memory'); }
  };

  /* ======================= 知识 ======================= */
  PAO.panels.cognitive = {
    id: 'cognitive', kicker: 'KNOWLEDGE', label: 'KNOWLEDGE VAULT', zh: '知识 · 本地知识库',
    tagline: 'WHAT IS WRITTEN DOWN, COUNTS.', taglineZh: '写下来的，才算数。',
    badge: 'knowledge/*.md',
    render: function (root, ctx) {
      var d = PAO.SB ? PAO.SB.data : {};
      var items = d.knowledge || [];
      var q = '';
      var cats = {};
      items.forEach(function (x) { cats[x.category || '未分类'] = (cats[x.category || '未分类'] || 0) + 1; });

      var listHost = el('div', { className: 'sb-list' });

      function draw() {
        D.clear(listHost);
        var list = items.filter(function (x) {
          if (!q) return true;
          var hay = (x.title + ' ' + x.path + ' ' + (x.tags || []).join(' ') + ' ' + (x.snippet || '')).toLowerCase();
          return hay.indexOf(q) >= 0;
        });
        if (!list.length) { listHost.appendChild(empty()); return; }
        list.slice(0, 60).forEach(function (x) {
          listHost.appendChild(row(
            x.title || x.path,
            (x.category || '未分类') + (x.tags && x.tags.length ? ' · ' + x.tags.join(' / ') : '') + ' · ' + (x.snippet || '').slice(0, 42),
            chip(x.quality ? 'Q ' + x.quality : '—', x.quality >= 80 ? 'ok' : 'muted')
          ));
        });
      }

      var input = el('input', {
        className: 'sb-input', attrs: { type: 'search', placeholder: '搜索标题 / 路径 / 标签 / 正文…' },
        on: { input: function (e) { q = String(e.target.value || '').trim().toLowerCase(); draw(); } }
      });

      D.appendAll(root, [
        section('概览', '共 ' + items.length + ' 条', el('div', { className: 'sb-grid sb-grid--3' }, [
          metric('知识条目', items.length),
          metric('分类', Object.keys(cats).length),
          metric('最近更新', items.length && items[items.length - 1].updated ? items[items.length - 1].updated : '暂无数据')
        ])),
        section('搜索', '实时过滤', input),
        section('分类分布', '', (function () {
          var keys = Object.keys(cats);
          if (!keys.length) return empty();
          return el('div', { className: 'sb-chips' }, keys.map(function (k) { return chip(k + ' ' + cats[k], 'muted'); }));
        })()),
        section('条目', '', listHost)
      ]);
      draw();
    },
    onEnter: function (ctx) { live(ctx, 'cognitive'); },
    onExit: function () { unsub('cognitive'); }
  };

  /* ======================= 智能体 ======================= */
  /* ======================= 协作网络（三层结构总览） ======================= */
  PAO.panels.workspace = {
    id: 'workspace', kicker: 'COLLABORATION', label: 'AGENT NETWORK', zh: '三层协作网络',
    tagline: 'STAFF → ENTRIES → EXECUTORS.', taglineZh: '幕僚长 → 指挥入口 → 执行者。',
    badge: 'agents 表',
    render: function (root, ctx) {
      var model = PAO.SB ? PAO.SB.agentModel() : [];
      var hub = model.filter(function (m) { return m.id === 'trae-chief'; });
      var chiefs = model.filter(function (m) { return m.kind === 'chief' && m.id !== 'trae-chief'; });
      var workers = model.filter(function (m) { return m.kind !== 'chief'; });

      function card(m) {
        return row(
          m.name,
          (m.zh || '') + ' · ' + (m.taskId ? '任务 #' + m.taskId : '无进行中任务') +
          (m.everConnected ? '' : ' · 未接入过'),
          [
            chip(LIVE_ZH[m.live] || m.live || '未知', liveKind(m.live)),
            m.pending ? chip('待批示 ' + m.pending, 'warn') : null
          ],
          function () {
            PAO.bus.set({ selectedAgent: m.id });
            ctx.go('agent-detail');
          }
        );
      }

      D.appendAll(root, [
        section('结构校验', '固定三层，入口不增不减', el('div', { className: 'sb-grid sb-grid--3' }, [
          metric('幕僚长', hub.length ? 'TRAE' : '未接入', '中枢调度', hub.length ? 'cyan' : 'warn'),
          metric('指挥入口', chiefs.length, '固定结构 · 不增不减', 'ok'),
          metric('执行者', workers.length, '常驻执行线程')
        ])),
        section('第一层 · 幕僚长', hub.length + ' 位', hub.length ? el('div', { className: 'sb-list' }, hub.map(card)) : empty()),
        section('第二层 · 指挥入口', chiefs.length + ' 个', chiefs.length ? el('div', { className: 'sb-list' }, chiefs.map(card)) : empty()),
        section('第三层 · 执行者', workers.length + ' 个', workers.length ? el('div', { className: 'sb-list' }, workers.map(card)) : empty())
      ]);
    },
    onEnter: function (ctx) { live(ctx, 'workspace'); },
    onExit: function () { unsub('workspace'); }
  };

  /* ======================= 智能体面板 ======================= */
  PAO.panels.agent = {
    id: 'agent', kicker: 'AGENTS', label: 'COMMAND LAYER', zh: '智能体 · 指挥与执行',
    tagline: 'SEVEN ENTRIES. ONE STAFF.', taglineZh: '七个入口，一位幕僚长。',
    badge: 'agents 表',
    render: function (root, ctx) {
      var d = PAO.SB ? PAO.SB.data : {};
      var agents = d.agents || [];
      var chiefs = agents.filter(function (a) { return a.kind === 'chief'; });
      var workers = agents.filter(function (a) { return a.kind === 'worker'; });

      function agentRow(a) {
        var meta = (PAO.SB.agentModel().filter(function (m) { return m.id === a.agent_id; })[0]) || {};
        var aside = [
          chip(LIVE_ZH[a.live_status] || a.live_status || '未知', liveKind(a.live_status)),
          a.pending_decisions ? chip('待批示 ' + a.pending_decisions, 'warn') : null
        ];
        return row(
          meta.name || a.agent_id,
          (meta.zh || '') + ' · ' + (a.current_task_id ? '任务 #' + a.current_task_id : '无进行中任务') +
          (a.ever_connected ? '' : ' · 未接入过'),
          aside,
          function () {
            PAO.bus.set({ selectedAgent: a.agent_id });
            ctx.go('agent-detail');
          }
        );
      }

      D.appendAll(root, [
        section('三层结构', '', el('div', { className: 'sb-grid sb-grid--3' }, [
          metric('幕僚长', chiefs.some(function (a) { return a.agent_id === 'trae-chief'; }) ? 'TRAE' : '未接入', '中枢', 'cyan'),
          metric('指挥入口', chiefs.length, '固定七个，不增不减', chiefs.length === 7 ? 'ok' : 'warn'),
          metric('执行者', workers.length, '常驻线程')
        ])),
        section('指挥入口', chiefs.length + ' 个', chiefs.length ? el('div', { className: 'sb-list' }, chiefs.map(agentRow)) : empty()),
        section('执行者', workers.length + ' 个', workers.length ? el('div', { className: 'sb-list' }, workers.map(agentRow)) : empty())
      ]);
    },
    onEnter: function (ctx) { live(ctx, 'agent'); },
    onExit: function () { unsub('agent'); }
  };

  /* ======================= 智能体详情 ======================= */
  PAO.panels['agent-detail'] = {
    id: 'agent-detail', kicker: 'AGENT', label: 'AGENT DETAIL', zh: '智能体详情',
    tagline: 'WHO IS DOING WHAT.', taglineZh: '谁，正在做什么。',
    badge: 'agents/:id',
    render: function (root, ctx) {
      var id = ctx.store.selectedAgent;
      if (!id) { D.appendAll(root, [empty('请先在协作网络或智能体列表中选择一个节点。')]); return; }
      var a = (PAO.SB.data.agents || []).filter(function (x) { return x.agent_id === id; })[0];
      if (!a) { D.appendAll(root, [empty('未找到该智能体。')]); return; }
      var meta = (PAO.SB.agentModel().filter(function (m) { return m.id === id; })[0]) || {};

      D.appendAll(root, [
        section(meta.name || id, meta.zh || '', el('div', {}, [
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: 'ID' }), el('span', { className: 'pao-kv__v is-mono', text: id })]),
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '类型' }), el('span', { className: 'pao-kv__v', text: a.kind === 'chief' ? '指挥入口' : '执行者' })]),
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '实时状态' }), el('span', { className: 'pao-kv__v', text: LIVE_ZH[a.live_status] || a.live_status || '未知' })]),
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '当前任务' }), el('span', { className: 'pao-kv__v', text: a.current_task_id ? '#' + a.current_task_id : '暂无' })]),
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '待批示' }), el('span', { className: 'pao-kv__v' + (a.pending_decisions ? ' is-warn' : ''), text: String(a.pending_decisions || 0) })]),
          el('div', { className: 'pao-kv' }, [el('span', { className: 'pao-kv__k', text: '最近心跳' }), el('span', { className: 'pao-kv__v', text: a.last_seen ? t(a.last_seen) : '从未接入' })])
        ])),
        section('能力', (a.capabilities || []).length + ' 项', (a.capabilities || []).length
          ? el('div', { className: 'sb-chips' }, a.capabilities.map(function (c) { return chip(c, 'cyan'); }))
          : empty()),
        section('最近任务', '最近 10 条', (function () {
          var host = el('div', { className: 'sb-list' });
          PAO.SB.api('/api/agents/' + encodeURIComponent(id)).then(function (r) {
            var list = (r.data && r.data.recent_tasks) || [];
            D.clear(host);
            if (!list.length) { host.appendChild(empty()); return; }
            list.forEach(function (x) {
              host.appendChild(row('#' + x.id + ' · ' + x.type, t(x.created_at) + (x.done_at ? ' → ' + t(x.done_at) : ''),
                chip(STATUS_ZH[x.status] || x.status, statusKind(x.status))));
            });
          }).catch(function () { D.clear(host); host.appendChild(empty('任务历史读取失败')); });
          return host;
        })())
      ]);
    }
  };

  /* ======================= 任务 ======================= */
  PAO.panels.data = {
    id: 'data', kicker: 'TASKS', label: 'TASK QUEUE', zh: '任务 · 队列与进度',
    tagline: 'INTENT IN. OUTCOMES OUT.', taglineZh: '意图进，结果出。',
    badge: 'tasks 表',
    render: function (root, ctx) {
      var d = PAO.SB ? PAO.SB.data : {};
      var all = d.tasks || [];
      var filter = 'ALL';
      var listHost = el('div', { className: 'sb-list' });

      function draw() {
        D.clear(listHost);
        var list = all.filter(function (x) { return filter === 'ALL' || x.status === filter; });
        if (!list.length) { listHost.appendChild(empty()); return; }
        list.slice(0, 60).forEach(function (x) {
          var extra = null;
          if (x.status === 'doing') {
            extra = el('div', { className: 'sb-progress' }, [
              bar(x.progress),
              el('span', { className: 'sb-progress__text', text: (x.progress || 0) + '%' + (x.estimate_samples ? ' · 中位数样本 ' + x.estimate_samples : ' · 默认估算') })
            ]);
          }
          listHost.appendChild(row(
            '#' + x.id + ' · ' + (x.type || '未命名任务'),
            (x.lease_owner || '未派发') + ' · ' + t(x.created_at) + (x.retry_count ? ' · 重试 ' + x.retry_count : '') + (x.summary ? ' · ' + String(x.summary).slice(0, 40) : ''),
            [chip(STATUS_ZH[x.status] || x.status || '未知', statusKind(x.status)), PRIORITY_ZH[x.priority] ? chip(PRIORITY_ZH[x.priority], x.priority >= 1 ? 'warn' : 'muted') : null],
            null, extra
          ));
        });
      }

      D.appendAll(root, [
        section('概览', '共 ' + all.length + ' 条（最近 80）', el('div', { className: 'sb-grid sb-grid--3' }, [
          metric('待执行', all.filter(function (x) { return x.status === 'pending'; }).length),
          metric('执行中', all.filter(function (x) { return x.status === 'doing'; }).length),
          metric('已完成', all.filter(function (x) { return x.status === 'done'; }).length)
        ])),
        filters([
          { id: 'ALL', label: '全部' }, { id: 'doing', label: '执行中' },
          { id: 'pending', label: '待执行' }, { id: 'done', label: '已完成' },
          { id: 'failed', label: '失败' }
        ], 'status', function (f) { filter = f; draw(); }),
        listHost
      ]);
      draw();
    },
    onEnter: function (ctx) { live(ctx, 'data'); },
    onExit: function () { unsub('data'); }
  };

  /* ======================= 事件 ======================= */
  PAO.panels.model = {
    id: 'model', kicker: 'EVENTS', label: 'EVENT STREAM', zh: '事件 · 实时数据流',
    tagline: 'EVERY SIGNAL, ON THE RECORD.', taglineZh: '每一个信号，都有记录。',
    badge: 'events 表 + SSE',
    render: function (root, ctx) {
      var d = PAO.SB ? PAO.SB.data : {};
      var all = d.events || [];
      var filter = 'ALL';
      var listHost = el('div', { className: 'sb-list' });

      function draw() {
        D.clear(listHost);
        var list = all.filter(function (x) { return filter === 'ALL' || x.type === filter; });
        if (!list.length) { listHost.appendChild(empty()); return; }
        list.slice(0, 80).forEach(function (x) {
          listHost.appendChild(row(
            x.type || '未命名事件',
            (x.source || '未知来源') + ' · ' + t(x.created_at) + ' · EVENT ' + String(x.event_id || '').slice(0, 12),
            [chip(STATUS_ZH[x.status] || x.status || '—', statusKind(x.status)), x.priority > 0 ? chip('P' + x.priority, 'warn') : null]
          ));
        });
      }

      var types = {};
      all.forEach(function (x) { types[x.type || '未分类'] = (types[x.type || '未分类'] || 0) + 1; });

      D.appendAll(root, [
        section('推送状态', PAO.SB.statusText() + ((PAO.SB.data.events[0]) ? ' · 最新 ' + t(PAO.SB.data.events[0].created_at) : ''), el('div', { className: 'sb-grid sb-grid--3' }, [
          metric('今日事件', (d.overview || {}).events_today || 0),
          metric('当前列表', all.length),
          metric('事件类型', Object.keys(types).length)
        ])),
        filters([{ id: 'ALL', label: '全部' }].concat(Object.keys(types).slice(0, 7).map(function (k) { return { id: k, label: k }; })), 'type', function (f) { filter = f; draw(); }),
        listHost
      ]);
      draw();
    },
    onEnter: function (ctx) { live(ctx, 'model'); },
    onExit: function () { unsub('model'); }
  };

  /* ======================= 监控 ======================= */
  PAO.panels.trust = {
    id: 'trust', kicker: 'MONITOR', label: 'SYSTEM MONITOR', zh: '监控 · 心跳与健康',
    tagline: 'NOTHING WITHOUT EVIDENCE.', taglineZh: '一切，皆有证据。',
    badge: 'monitor 接口',
    render: function (root, ctx) {
      var d = PAO.SB ? PAO.SB.data : {};
      var m = d.monitor || {};
      var ov = d.overview || {};
      var hb = m.heartbeats || [];
      var queue = m.queue || {};
      var sys = m.system || {};
      var health = m.health || null;

      D.appendAll(root, [
        section('队列', '', el('div', { className: 'sb-grid' }, [
          metric('待执行', queue.pending || 0, 'pending', queue.pending ? 'warn' : ''),
          metric('执行中', queue.doing || 0, 'doing'),
          metric('已完成', queue.done || 0, 'done', 'ok'),
          metric('失败', queue.failed || 0, 'failed', queue.failed ? 'crit' : ''),
          metric('死信', queue.dead || 0, 'dead', queue.dead ? 'crit' : ''),
          metric('待批示', ov.pending_decisions || 0, '高优先级')
        ])),
        section('系统', '来自 /proc', el('div', { className: 'sb-grid sb-grid--3' }, [
          metric('负载', (sys.loadavg || []).join(' / ') || '暂无数据', '1 / 5 / 15 分钟'),
          metric('内存总量', sys.mem_total_mb ? sys.mem_total_mb + ' MB' : '暂无数据'),
          metric('可用内存', sys.mem_available_mb ? sys.mem_available_mb + ' MB' : '暂无数据')
        ])),
        section('心跳', hb.length + ' 个', hb.length ? el('div', { className: 'sb-list' }, hb.map(function (h) {
          var age = h.age_seconds || 0;
          return row(h.agent, '心跳 ' + t(h.ts) + (h.note ? ' · ' + h.note : ''),
            chip(age < 120 ? '正常' : age < 600 ? '偏慢' : '超时', age < 120 ? 'ok' : age < 600 ? 'warn' : 'crit'));
        })) : empty()),
        section('健康快照', health ? '最新 health-*.jsonl' : '暂无数据', health
          ? el('pre', { className: 'sb-pre', text: JSON.stringify(health, null, 2).slice(0, 1600) })
          : empty())
      ]);
    },
    onEnter: function (ctx) { live(ctx, 'trust'); },
    onExit: function () { unsub('trust'); }
  };

  /* ======================= 口令闸门（不显示、不落盘） ======================= */
  PAO.ui = PAO.ui || {};
  PAO.ui.openSuperBrainGate = function () {
    var ui = PAO.ui;
    if (!ui.modal) return;
    var input = el('input', {
      className: 'sb-input', attrs: { type: 'password', placeholder: '控制台只读口令', autocomplete: 'off' }
    });
    var err = el('div', { className: 'sb-note is-crit', text: '' });
    ui.modal({
      kicker: 'SUPER-BRAIN',
      title: '接入真实运行数据',
      body: el('div', {}, [
        el('p', { className: 'sb-note', text: '口令只保存在本机浏览器（localStorage），不会显示在界面、不会写入日志、不会上传。' }),
        input,
        err
      ]),
      actions: [
        { label: '取消', onClick: function (close) { close(); } },
        {
          label: '接入', primary: true, onClick: function (close) {
            var v = String(input.value || '').trim();
            if (!v) { err.textContent = '请输入口令。'; return; }
            PAO.SB.setToken(v);
            var offFail = PAO.bus.on('sb:auth-fail', function () { err.textContent = '口令无效，请重新输入。'; offFail(); });
            var offOk = PAO.bus.on('sb:data', function () { offOk(); close(); ui.toast('ok', '已接入 Super-Brain', '真实数据正在同步。'); });
            setTimeout(function () { offFail(); offOk(); }, 12000);
          }
        }
      ]
    });
    setTimeout(function () { input.focus(); }, 30);
  };

  PAO.bus.on('sb:auth-needed', function () {
    if (!PAO.ui || PAO.ui.current) return;
  });
})(window.PAO = window.PAO || {});
