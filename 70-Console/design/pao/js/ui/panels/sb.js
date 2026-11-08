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
  /* kepano/40-questions 简体中文版（translations/zh-hans/year.md） */
  var QUESTIONS_40 = [
    '你今年做了哪些之前从未做过的事？',
    '你有没有遵守年初时和自己许下的约定？',
    '你身边有人生孩子了吗？',
    '你身边有人去世了吗？',
    '你去了哪些城市/州/国家？',
    '明年你想要获得哪些你今年没有的东西？',
    '今年的哪个或哪些日子会铭刻在你的记忆中，为什么？',
    '你今年最大的成就是什么？',
    '你今年最大的失败是什么？',
    '你今年还遇到过哪些困难？',
    '你今年是否生过病或受过伤？',
    '你今年买过的最好的东西是什么？',
    '谁的行为值得去表扬？',
    '谁的行为令你感到震惊？',
    '你大部分的钱都花到哪里去了？',
    '有什么事让你感到超级、超级、超级兴奋？',
    '哪首歌会永远让你想起这一年？',
    '与去年的这个时候相比，你是：感到更快乐还是更悲伤了？变得更健康还是更糟了？变得更富还是更穷了？',
    '你希望自己能做得更多的是什么？',
    '你希望自己能做得更少的是什么？',
    '你是如何度过节假日的？',
    '你今年坠入爱河了吗？',
    '你是否有讨厌某个你去年此时不觉得讨厌的人呢？',
    '你最喜欢的电视节目是什么？',
    '你读过最好的一本书是什么？',
    '你今年发现的最好听的一首歌是什么？',
    '你今年看过最喜欢的一部电影是什么？',
    '你今年吃过最好吃的一顿饭是什么？',
    '有什么是你想要且得到了的？',
    '有什么是你想要却没有得到的？',
    '你生日那天做了什么？',
    '有什么还未发生的事，如果发生了，会让你的这一年变得无比满足?',
    '你会如何描述你今年的个人时尚风格？',
    '是什么让你保持理智？',
    '你最欣赏哪个名人/公众人物？',
    '哪个政治问题最令你有感而发？',
    '你想念哪些人？',
    '在你新认识的人之中，谁是最好的？',
    '今年你学到了什么宝贵的人生经验？',
    '能够总结你这一年的一句话是什么？'
  ];
  /* 40 问中可由年度真实数据佐证的问题（1-based 序号 → 生成佐证文本） */
  function annualEvidence(n, a) {
    if (!a) return '';
    if (n === 7) return a.active_days ? '全年有事件记录 ' + a.active_days + ' 天' : '';
    if (n === 8) return a.tasks_done ? '全年完成任务 ' + a.tasks_done + ' 条' : '';
    if (n === 9) return a.tasks_failed ? '全年失败任务 ' + a.tasks_failed + ' 条' : '';
    if (n === 18) return a.knowledge_new ? '全年新增知识笔记 ' + a.knowledge_new + ' 篇' : '';
    if (n === 29) return (a.top_types && a.top_types[0]) ? '完成最多的任务类型：' + a.top_types[0].type + '（' + a.top_types[0].n + ' 条）' : '';
    if (n === 38) return (a.per_agent && a.per_agent[0]) ? '产出最高的执行者：' + a.per_agent[0].agent + '（完成 ' + a.per_agent[0].done + ' 条）' : '';
    return '';
  }
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
        })()),
        section('分形回顾', '日 / 周 / 月 三个尺度的真实计数', (function () {
          var host = el('div', { className: 'sb-list' }, [empty('加载中…')]);
          var state = { mode: 'days', data: null };

          function drawMode() {
            D.clear(host);
            var f = state.data;
            if (!f) { host.appendChild(empty('暂无数据')); return; }
            if (state.mode === 'days') {
              var days = (f.days || []).slice(-14);
              if (!days.length) { host.appendChild(empty()); return; }
              days.forEach(function (x) {
                var top = (x.top_sources || []).map(function (s) { return s.source + '×' + s.n; }).join(' / ');
                host.appendChild(row(x.date,
                  '事件 ' + x.events + ' · 完成 ' + x.tasks_done + ' · 失败 ' + x.tasks_failed + ' · 会话 ' + x.sessions + (top ? ' · ' + top : ''),
                  x.events ? chip(String(x.events), 'cyan') : chip('0', 'muted')));
              });
            } else if (state.mode === 'weeks') {
              var weeks = f.weeks || [];
              if (!weeks.length) { host.appendChild(empty()); return; }
              weeks.forEach(function (x) {
                host.appendChild(row(x.week,
                  '事件 ' + x.events + ' · 完成 ' + x.tasks_done + ' · 失败 ' + x.tasks_failed,
                  x.events ? chip(String(x.events), 'cyan') : chip('0', 'muted')));
              });
            } else {
              var months = f.months || [];
              if (!months.length) { host.appendChild(empty()); return; }
              months.forEach(function (x) {
                host.appendChild(row(x.month,
                  '事件 ' + x.events + ' · 完成 ' + x.tasks_done + ' · 失败 ' + x.tasks_failed,
                  x.events ? chip(String(x.events), 'cyan') : chip('0', 'muted')));
              });
            }
          }

          var wrap = el('div', { className: 'sb-chips' });
          [{ id: 'days', label: '日（近 14 天）' }, { id: 'weeks', label: '周' }, { id: 'months', label: '月' }].forEach(function (m, i) {
            var b = el('button', { className: 'sb-chip sb-chip--btn' + (i === 0 ? ' is-on' : ''), attrs: { type: 'button' }, text: m.label });
            b.addEventListener('click', function () {
              Array.prototype.forEach.call(wrap.children, function (c) { c.classList.remove('is-on'); });
              b.classList.add('is-on');
              state.mode = m.id;
              drawMode();
            });
            wrap.appendChild(b);
          });

          PAO.SB.api('/api/review/fractal?days=30').then(function (r) {
            state.data = r.data || null;
            drawMode();
          }).catch(function () {
            D.clear(host);
            host.appendChild(empty('分形回顾接口暂不可用'));
          });

          return el('div', {}, [wrap, host]);
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
      var catFilter = '';
      var cats = {};
      items.forEach(function (x) { cats[x.category || '未分类'] = (cats[x.category || '未分类'] || 0) + 1; });

      var listHost = el('div', { className: 'sb-list' });
      var expanded = {};

      function draw() {
        D.clear(listHost);
        var list = items.filter(function (x) {
          if (catFilter && (x.category || '未分类') !== catFilter) return false;
          if (!q) return true;
          var hay = (x.title + ' ' + x.path + ' ' + (x.tags || []).join(' ') + ' ' + (x.snippet || '')).toLowerCase();
          return hay.indexOf(q) >= 0;
        });
        if (!list.length) { listHost.appendChild(empty()); return; }
        list.slice(0, 60).forEach(function (x) {
          var metaBits = [x.category || '未分类'];
          if (x.tags && x.tags.length) metaBits.push(x.tags.join(' / '));
          if (x.updated) metaBits.push('更新 ' + x.updated);
          else if (x.created) metaBits.push('创建 ' + x.created);
          var aside = [
            chip(x.quality ? 'Q ' + x.quality : '—', x.quality >= 80 ? 'ok' : 'muted'),
            x.rating ? chip('★ ' + x.rating + '/7', 'cyan') : null
          ];
          var linksBox = null;
          if (expanded[x.path]) {
            var links = x.links || [];
            linksBox = el('div', { className: 'sb-chips' }, links.length
              ? links.map(function (ln) { return chip('[[' + ln + ']]', 'cyan'); })
              : [chip('无 wikilink', 'muted')]);
          }
          listHost.appendChild(row(
            x.title || x.path,
            metaBits.join(' · '),
            aside,
            function () { expanded[x.path] = !expanded[x.path]; draw(); },
            linksBox
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
        section('分类分布', '点击筛选，再次点击取消', (function () {
          var keys = Object.keys(cats);
          if (!keys.length) return empty();
          var wrap = el('div', { className: 'sb-chips' });
          keys.forEach(function (k) {
            var b = el('button', { className: 'sb-chip sb-chip--btn', attrs: { type: 'button' }, text: k + ' ' + cats[k] });
            b.addEventListener('click', function () {
              var on = b.classList.contains('is-on');
              Array.prototype.forEach.call(wrap.children, function (c) { c.classList.remove('is-on'); });
              catFilter = on ? '' : k;
              if (!on) b.classList.add('is-on');
              draw();
            });
            wrap.appendChild(b);
          });
          return wrap;
        })()),
        section('条目', '点击条目展开 wikilinks', listHost)
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

  /* ======================= 图谱（真实关系表） ======================= */
  PAO.panels.graph = {
    id: 'graph', kicker: 'KNOWLEDGE GRAPH', label: 'RELATION GRAPH', zh: '图谱 · 真实关系',
    tagline: 'EVERY LINK, FROM THE DATABASE.', taglineZh: '每条关系，都来自关系表。',
    badge: 'relations + knowledge',
    render: function (root, ctx) {
      var d = PAO.SB ? PAO.SB.data : {};
      var rel = d.relations || [];
      var kn = d.knowledge || [];
      var kinds = {};
      rel.forEach(function (r) { var k = r.rel || r.type || r.relation || '未分类'; kinds[k] = (kinds[k] || 0) + 1; });
      var knKinds = {};
      kn.forEach(function (k) { var t = k.kind || k.type || '未分类'; knKinds[t] = (knKinds[t] || 0) + 1; });

      D.appendAll(root, [
        section('概览', 'relations 表', el('div', { className: 'sb-grid sb-grid--3' }, [
          metric('关系总数', rel.length, '最近 300 条', rel.length ? 'ok' : ''),
          metric('知识条目', kn.length, 'knowledge 表'),
          metric('关系类型', Object.keys(kinds).length, 'rel 字段')
        ])),
        section('知识分布', Object.keys(knKinds).length + ' 类', Object.keys(knKinds).length
          ? el('div', { className: 'sb-chips' }, Object.keys(knKinds).slice(0, 10).map(function (k) {
              return chip(k + ' ' + knKinds[k], 'muted');
            }))
          : empty()),
        section('关系列表', rel.length + ' 条', rel.length
          ? el('div', { className: 'sb-list' }, rel.slice(0, 80).map(function (r) {
              var a = r.from || r.source || r.src || '?';
              var b = r.to || r.target || r.dst || '?';
              return row(a + ' → ' + b, (r.rel || r.type || '关系') + (r.note ? ' · ' + r.note : ''),
                chip(String(r.rel || r.type || 'rel'), 'cyan'));
            }))
          : empty()),
        section('知识画布', 'JSON Canvas 1.0 · 可在 Obsidian 打开', (function () {
          var stats = el('div', { className: 'sb-note', text: '根据知识库分类分组、[[wikilink]] 连线，布局确定性预生成。' });
          var btn = el('button', { className: 'pao-btn pao-btn--ghost', attrs: { type: 'button' }, text: '导出 .canvas' });
          btn.addEventListener('click', function () {
            btn.disabled = true;
            btn.textContent = '生成中…';
            PAO.SB.api('/api/knowledge/canvas').then(function (r) {
              var d = r.data || {};
              var blob = new Blob([JSON.stringify(d.canvas || {}, null, 2)], { type: 'application/json' });
              var a = el('a', { attrs: { href: URL.createObjectURL(blob), download: 'super-brain-knowledge.canvas' } });
              document.body.appendChild(a);
              a.click();
              setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
              var s = d.stats || {};
              stats.textContent = '已导出：节点 ' + (s.nodes != null ? s.nodes : '—') +
                ' · 连线 ' + (s.edges != null ? s.edges : '—') +
                ' · 未解析链接 ' + (s.unresolved != null ? s.unresolved : '—') + '（面包屑，非错误）';
              btn.disabled = false;
              btn.textContent = '重新导出 .canvas';
            }).catch(function (e) {
              stats.textContent = '导出失败：' + ((e && e.message) || '未知错误');
              btn.disabled = false;
              btn.textContent = '导出 .canvas';
            });
          });
          return el('div', {}, [el('div', { className: 'sb-chips' }, [btn]), stats]);
        })())
      ]);
    },
    onEnter: function (ctx) { live(ctx, 'graph'); },
    onExit: function () { unsub('graph'); }
  };

  /* ======================= 架构（真实运行结构） ======================= */
  PAO.panels.architecture = {
    id: 'architecture', kicker: 'ARCHITECTURE', label: 'RUNTIME ARCHITECTURE', zh: '架构 · 三层运行结构',
    tagline: 'ONE STAFF. SEVEN ENTRIES. EXECUTORS.', taglineZh: '一位幕僚长，七个入口，常驻执行者。',
    badge: 'agents + tasks',
    render: function (root, ctx) {
      var d = PAO.SB ? PAO.SB.data : {};
      var ov = d.overview || {};
      var model = PAO.SB ? PAO.SB.agentModel() : [];
      var hub = model.filter(function (m) { return m.id === 'trae-chief'; });
      var chiefs = model.filter(function (m) { return m.kind === 'chief' && m.id !== 'trae-chief'; });
      var workers = model.filter(function (m) { return m.kind !== 'chief'; });

      D.appendAll(root, [
        section('三层结构', '真实 agents 表', el('div', { className: 'sb-grid sb-grid--3' }, [
          metric('幕僚长', hub.length ? 'TRAE' : '未接入', '调度中枢', hub.length ? 'cyan' : 'warn'),
          metric('指挥入口', chiefs.length, '固定结构'),
          metric('执行者', workers.length, '常驻线程')
        ])),
        section('运行时', '来自 overview', el('div', { className: 'sb-grid' }, [
          metric('在线智能体', (ov.agents_online || 0) + ' / ' + (ov.agents_total || 0), '心跳汇总', (ov.agents_online === ov.agents_total && ov.agents_total) ? 'ok' : ''),
          metric('工作中', ov.agents_working || 0, '当前租约'),
          metric('任务总量', d.totalTasks || 0, 'tasks 表'),
          metric('今日事件', ov.events_today || 0, 'events 表'),
          metric('会话线程', (d.sessions || []).length, 'memory 接口'),
          metric('待批示', ov.pending_decisions || 0, 'pipeline')
        ])),
        section('链路', '同源只读接入', el('div', { className: 'sb-list' }, [
          row('浏览器 → /api/*', 'GET 只读接口 · Bearer 口令 · 不写库', chip(PAO.SB.state === 'online' ? '在线' : '离线', PAO.SB.state === 'online' ? 'ok' : 'crit')),
          row('浏览器 → /api/stream', 'SSE 实时推送 · 断线自动降级为轮询', chip(PAO.SB.statusText(), PAO.SB.state === 'online' ? 'cyan' : 'muted')),
          row('agent → 任务 → 事件', '执行者租约任务，结果写回 events', chip('真实数据', 'ok'))
        ]))
      ]);
    },
    onEnter: function (ctx) { live(ctx, 'architecture'); },
    onExit: function () { unsub('architecture'); }
  };

  /* ======================= 进化（真实样本，不估算） ======================= */
  PAO.panels.evolve = {
    id: 'evolve', kicker: 'EVOLVE', label: 'SELF-LEARNING', zh: '进化 · 样本与收敛',
    tagline: 'LEARN FROM HISTORY. CAP AT 95%.', taglineZh: '从历史中学习，最高只报 95%。',
    badge: 'tasks 历史样本',
    render: function (root, ctx) {
      var d = PAO.SB ? PAO.SB.data : {};
      var ov = d.overview || {};
      var tasks = d.tasks || [];
      var sampled = tasks.filter(function (x) { return x.estimate_samples > 0; });
      var samples = 0;
      sampled.forEach(function (x) { samples += x.estimate_samples; });

      D.appendAll(root, [
        section('学习样本', '来自 tasks.estimate_samples', el('div', { className: 'sb-grid sb-grid--3' }, [
          metric('有历史样本任务', sampled.length, '可自学习', sampled.length ? 'ok' : ''),
          metric('样本总量', samples || '暂无数据', '历史同类型耗时'),
          metric('进度封顶', '95%', '不会显示 100% 假完成')
        ])),
        section('收敛依据', '真实执行记录', el('div', { className: 'sb-grid' }, [
          metric('累计完成', ((ov.tasks || {}).done) || 0, 'done'),
          metric('失败 / 死信', ((ov.tasks || {}).failed) || 0, 'failed + dead', ((ov.tasks || {}).failed) ? 'crit' : ''),
          metric('今日事件', ov.events_today || 0, 'events 表'),
          metric('当前并发', ov.tasks_running || 0, 'doing'),
          metric('在线智能体', (ov.agents_online || 0) + ' / ' + (ov.agents_total || 0), '实时心跳'),
          metric('待批示', ov.pending_decisions || 0, '需人工确认')
        ])),
        section('口径', '', el('div', { className: 'sb-list' }, [
          row('进度估算', '仅使用同类型任务的历史中位数；无样本时显示「暂无数据」，不套默认值。', chip('真实', 'ok')),
          row('上限保护', '任何任务进度最高 95%，完成以 tasks 表 done 为准。', chip('约束', 'warn')),
          row('高风险动作', '必须人工确认，并写入审计记录；口令永不显示、不落盘。', chip('审计', 'cyan'))
        ])),
        section('年度回顾', 'kepano 40 问 · 数据佐证来自全年真实运行记录', (function () {
          var year = new Date().getFullYear();
          var host = el('div', {}, [empty('加载中…')]);
          PAO.SB.api('/api/review/annual?year=' + year).then(function (r) {
            var a = r.data || null;
            D.clear(host);
            if (!a) { host.appendChild(empty()); return; }
            var topAgent = (a.per_agent && a.per_agent[0]) ? a.per_agent[0] : null;
            D.appendAll(host, [
              el('div', { className: 'sb-grid sb-grid--3' }, [
                metric('完成任务', a.tasks_done, year + ' 全年 done'),
                metric('失败任务', a.tasks_failed, 'failed + dead', a.tasks_failed ? 'crit' : ''),
                metric('事件总数', a.events_total, 'events 表'),
                metric('活跃天数', a.active_days, '有事件的日子'),
                metric('新增知识', a.knowledge_new, '10-Knowledge'),
                metric('TOP 执行者', topAgent ? topAgent.agent + ' · ' + topAgent.done : '暂无数据', '按完成数')
              ]),
              el('div', { className: 'pao-section__title', style: { margin: '18px 0 8px' }, text: year + ' · 40 问' }),
              el('div', { className: 'sb-list' }, QUESTIONS_40.map(function (qtext, i) {
                var ev = annualEvidence(i + 1, a);
                return row((i + 1) + '. ' + qtext,
                  '数据佐证：' + (ev || '暂无数据，留待人工填写'),
                  ev ? chip('有佐证', 'ok') : chip('人工', 'muted'));
              }))
            ]);
          }).catch(function () {
            D.clear(host);
            host.appendChild(empty('年度回顾接口暂不可用'));
          });
          return host;
        })())
      ]);
    },
    onEnter: function (ctx) { live(ctx, 'evolve'); },
    onExit: function () { unsub('evolve'); }
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
