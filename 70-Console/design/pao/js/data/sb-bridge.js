/* PERSONAL AI OS — Super-Brain 真实数据桥
   数据源：同源 /api/*（只读）+ /api/stream（SSE）
   口令：只存本机浏览器 localStorage（键与 /console/ 原型一致），绝不写入页面/日志
   无数据：一律保留空数组，界面显示「暂无数据」，不编造 */
(function (PAO) {
  'use strict';

  var LS = 'sb-viewer-token';
  var TASK_MS = 12000;      // 轮询兜底周期
  var SSE_RETRY_MS = 45000; // SSE 重试间隔

  var NAME = {
    'trae-chief': { zh: 'TRAE', role: '幕僚长入口', kind: 'chief' },
    'dsh-chief': { zh: 'DSH', role: '多智能体入口', kind: 'chief' },
    'dsh2-chief': { zh: 'DSH2', role: '多智能体入口', kind: 'chief' },
    'maus-chief': { zh: 'MAUS', role: '外脑入口', kind: 'chief' },
    'maus2-chief': { zh: 'MAUS2', role: '外脑入口', kind: 'chief' },
    'grok-chief': { zh: 'Grok', role: '外脑入口', kind: 'chief' },
    'deepseek-chief': { zh: 'DeepSeek', role: '外脑入口', kind: 'chief' },
    'code-worker': { zh: 'code-worker', role: '代码执行', kind: 'worker' },
    'trae-developer': { zh: 'trae-developer', role: '开发执行', kind: 'worker' },
    'knowledge-worker': { zh: 'knowledge-worker', role: '知识整理', kind: 'worker' },
    'archive-worker': { zh: 'archive-worker', role: '归档整理', kind: 'worker' },
    'research-worker': { zh: 'research-worker', role: '研究分析', kind: 'worker' },
    'analysis-worker': { zh: 'analysis-worker', role: '数据分析', kind: 'worker' },
    'chat-worker': { zh: 'chat-worker', role: '对话执行', kind: 'worker' },
    'test-agent-worker': { zh: 'test-agent-worker', role: '测试执行', kind: 'worker' }
  };

  var SB = {
    state: 'locked',            // locked | connecting | online | polling | offline
    token: '',
    data: {
      overview: null, agents: [], tasks: [], totalTasks: 0,
      events: [], relations: [], knowledge: [], monitor: null,
      sessions: [], agentMemory: []
    },
    lastEventAt: 0,
    lastLoadAt: 0,
    error: '',
    _es: null, _pollTimer: 0, _sseTimer: 0, _reloadTimer: 0, _loading: false,

    /* ---------------- 口令 ---------------- */
    readToken: function () {
      try { return localStorage.getItem(LS) || ''; } catch (e) { return ''; }
    },
    setToken: function (t) {
      t = String(t || '').trim();
      if (!t) return false;
      SB.token = t;
      try { localStorage.setItem(LS, t); } catch (e) {}
      SB.connect();
      return true;
    },
    clearToken: function () {
      SB.token = '';
      try { localStorage.removeItem(LS); } catch (e) {}
      SB._closeStream();
      clearTimeout(SB._pollTimer); clearTimeout(SB._sseTimer);
      SB._setState('locked');
      PAO.bus.emit('sb:auth-needed', {});
    },
    hasToken: function () { return !!SB.token; },

    /* ---------------- 状态 ---------------- */
    _setState: function (s, err) {
      if (SB.state === s && !err) return;
      SB.state = s;
      SB.error = err || '';
      PAO.bus.set({ sbState: s });
      PAO.bus.emit('sb:state', { state: s, error: SB.error });
    },

    /* ---------------- HTTP ---------------- */
    api: function (path) {
      return fetch(path, {
        headers: { Authorization: 'Bearer ' + SB.token },
        cache: 'no-store',
        credentials: 'same-origin'
      }).then(function (r) {
        if (r.status === 401) { var e = new Error('无效口令'); e.code = 401; throw e; }
        if (!r.ok) { var e2 = new Error('HTTP ' + r.status); e2.code = r.status; throw e2; }
        return r.json();
      }).then(function (d) {
        if (d && d.ok === false) { var e3 = new Error(d.error || '接口返回失败'); e3.code = 400; throw e3; }
        return d;
      });
    },

    connect: function () {
      if (!SB.token) { SB._setState('locked'); PAO.bus.emit('sb:auth-needed', {}); return; }
      SB._setState('connecting');
      SB.loadAll();
      SB._openStream();
    },

    /* ---------------- 全量拉取 ---------------- */
    loadAll: function () {
      if (!SB.token || SB._loading) return Promise.resolve();
      SB._loading = true;
      var t = SB.token;
      function g(p) { return SB.api(p); }
      return Promise.all([
        g('/api/overview'), g('/api/agents'), g('/api/tasks?limit=80'),
        g('/api/relations'), g('/api/events?limit=80'),
        g('/api/knowledge?limit=300'), g('/api/monitor'), g('/api/memory')
      ]).then(function (res) {
        if (t !== SB.token) return null;   // 口令已切换，丢弃旧响应
        var ov = res[0].data, ag = res[1].data || [], tk = res[2],
          rel = res[3].data || [], ev = res[4].data || [],
          kn = res[5].data || [], mon = res[6].data || null, mem = res[7].data || {};
        SB.data.overview = ov;
        SB.data.agents = ag.filter(function (a) { return a.status !== 'disabled'; });
        SB.data.tasks = tk.data || [];
        SB.data.totalTasks = tk.total || (tk.data || []).length;
        SB.data.relations = rel;
        SB.data.events = ev;
        SB.data.knowledge = kn;
        SB.data.monitor = mon;
        SB.data.sessions = mem.sessions || [];
        SB.data.agentMemory = mem.agent_memory || [];
        SB.lastLoadAt = Date.now();
        if (SB.state !== 'online') SB._setState('online');
        SB.apply();
        PAO.bus.emit('sb:data', SB.data);
        PAO.bus.emit('memory:real-loaded', { count: SB.data.sessions.length });
        return SB.data;
      }).catch(function (e) {
        if (e && e.code === 401) {
          SB._closeStream();
          SB._setState('locked', '无效口令');
          PAO.bus.emit('sb:auth-fail', { error: '无效口令' });
        } else {
          SB._setState(SB._es ? 'polling' : 'offline', e && e.message);
        }
        return null;
      }).then(function (r) { SB._loading = false; return r; });
    },

    /* ---------------- 数据映射进 PAO.DATA ---------------- */
    apply: function () {
      var D = PAO.DATA;
      if (!D) return;
      var d = SB.data;
      D.sb = d;
      D.overview = d.overview;
      D.agents = d.agents;
      D.tasks = d.tasks;
      D.events = d.events;
      D.relations = d.relations;
      D.knowledge = d.knowledge;
      D.monitor = d.monitor;
      D.sessions = d.sessions;

      /* 记忆宇宙：真实会话线程 → 记忆节点（按执行者聚簇） */
      var memories = d.sessions.map(function (s, i) {
        return {
          id: 'S-' + (s.thread_id || i),
          title: String(s.thread_id || '会话 ' + (i + 1)).slice(0, 48),
          content: '执行者：' + (s.worker || '未知') + ' · 最近更新：' + fmtTime(s.updated_at),
          category: 'EVENTS', categoryZh: '事件',
          cluster: s.worker || 'unknown',
          confidence: 1, validity: 'ACTIVE', sensitivity: 'LOW',
          source: { type: 'USER_PROVIDED', typeZh: '运行时会话', label: 'Super-Brain sessions 表', ref: 'sessions' },
          createdAt: iso(s.updated_at), updatedAt: iso(s.updated_at),
          links: [], tags: ['会话', s.worker || ''], weight: 0.5
        };
      });
      var counts = {};
      memories.forEach(function (m) { counts[m.cluster] = (counts[m.cluster] || 0) + 1; });
      var centers = [[8.4, 1.8, 2.2], [-3.1, 7.6, -4.8], [-8.2, -2.4, 3.6], [2.9, 6.9, 5.4], [-6.4, -5.8, -2.1], [5.7, -6.2, 4.9]];
      var cols = ['#A9C6FF', '#91DFFF', '#55DDF5', '#9178FF', '#4F8FE0', '#5FD6C8'];
      D.memories = memories;
      D.memoryClusters = Object.keys(counts).map(function (k, i) {
        return {
          id: 'sc-' + i, name: 'SESSION', zh: k, color: cols[i % cols.length],
          count: counts[k], center: centers[i % centers.length], radius: 9,
          desc: k + ' 的会话线程 · 共 ' + counts[k] + ' 条'
        };
      });
      D.memoryReal = true;

      /* 六大模块指标接真实数字 */
      var ov = d.overview || {};
      var chiefs = d.agents.filter(function (a) { return a.kind === 'chief'; });
      var workers = d.agents.filter(function (a) { return a.kind === 'worker'; });
      var kk = d.knowledge.length;
      D.modules = (D.modules || []).map(function (m) {
        var metrics;
        if (m.id === 'memory') metrics = [{ k: '会话线程', v: String(d.sessions.length) }, { k: '执行者', v: String(workers.length) }, { k: '今日事件', v: String(ov.events_today || 0) }];
        else if (m.id === 'cognitive') metrics = [{ k: '知识条目', v: String(kk) }, { k: '分类', v: String(countCats(d.knowledge)) }, { k: '实时接口', v: '8' }];
        else if (m.id === 'agent') metrics = [{ k: '指挥入口', v: String(chiefs.length) }, { k: '执行者', v: String(workers.length) }, { k: '在线', v: String(ov.agents_online || 0) }];
        else if (m.id === 'data') metrics = [{ k: '任务总数', v: String(SB.data.totalTasks) }, { k: '待执行', v: String(ov.tasks_pending || 0) }, { k: '失败', v: String(ov.tasks_failed || 0) }];
        else if (m.id === 'model') metrics = [{ k: '今日事件', v: String(ov.events_today || 0) }, { k: '关系', v: String(d.relations.length) }, { k: '推送', v: SB._es ? 'SSE' : '轮询' }];
        else metrics = [{ k: '心跳', v: String(((d.monitor || {}).heartbeats || []).length) }, { k: '待批示', v: String(ov.pending_decisions || 0) }, { k: '失败', v: String(ov.tasks_failed || 0) }];
        return { id: m.id, num: m.num, name: m.name, zh: m.zh, tagline: m.tagline, taglineZh: m.taglineZh, desc: m.desc, color: m.color, metrics: metrics };
      });
      /* 模块中文名与职责改为 Super-Brain 真实域 */
      var ZH = {
        memory: { name: 'SESSION MEMORY', tagline: 'EVERY THREAD REMEMBERED', taglineZh: '会话记忆', zh: '记忆', desc: '运行时会话线程与执行者记忆（真实 sessions 表）。' },
        cognitive: { name: 'KNOWLEDGE VAULT', tagline: 'WHAT IS WRITTEN DOWN COUNTS', taglineZh: '本地知识库', zh: '知识', desc: '本地知识库 Markdown 条目，按分类与关键词检索。' },
        agent: { name: 'COMMAND LAYER', tagline: 'SEVEN ENTRIES ONE STAFF', taglineZh: '指挥入口与执行者', zh: '智能体', desc: '七个指挥入口与常驻执行者的真实在线状态。' },
        data: { name: 'TASK QUEUE', tagline: 'INTENT IN OUTCOMES OUT', taglineZh: '任务队列', zh: '任务', desc: '任务队列：状态、优先级、执行者与历史结果。' },
        model: { name: 'EVENT STREAM', tagline: 'EVERY SIGNAL ON RECORD', taglineZh: '事件流', zh: '事件', desc: '事件流：来源、类型、优先级与时间线（SSE 实时）。' },
        trust: { name: 'SYSTEM MONITOR', tagline: 'NOTHING WITHOUT EVIDENCE', taglineZh: '心跳与健康', zh: '监控', desc: '心跳、队列、系统负载与失败审计。' }
      };
      D.modules.forEach(function (m) {
        var z = ZH[m.id];
        if (z) {
          m.zh = z.zh; m.name = z.name; m.tagline = z.tagline;
          m.taglineZh = z.taglineZh; m.desc = z.desc;
        }
      });

      D.meta = D.meta || {};
      D.meta.disclaimer = '全部指标来自 Super-Brain 只读接口：/api/overview、agents、tasks、relations、events、knowledge、monitor、memory。无数据的字段显示「暂无数据」，不做估算。';
      D.meta.stageZh = '运行阶段 · Super-Brain 真实数据接入';
      D.meta.stage = 'RUNNING · SUPER-BRAIN READ-ONLY FEED';
      D.stats = {
        backend: SB.state, agents: d.agents.length, online: ov.agents_online || 0,
        working: ov.agents_working || 0, tasks: SB.data.totalTasks,
        tasksRunning: ov.tasks_running || 0, tasksPending: ov.tasks_pending || 0,
        eventsToday: ov.events_today || 0, pending: ov.pending_decisions || 0,
        sessions: d.sessions.length
      };
    },

    /* ---------------- SSE 实时推送 ---------------- */
    _openStream: function () {
      SB._closeStream();
      if (typeof EventSource === 'undefined' || !SB.token) return;
      var since = Math.floor((SB.lastLoadAt || Date.now()) / 1000) - 60;
      var url = '/api/stream?token=' + encodeURIComponent(SB.token) + '&since=' + since;
      var es;
      try { es = new EventSource(url, { withCredentials: true }); } catch (e) { SB._startPolling(); return; }
      SB._es = es;

      function onEvent(ev) {
        SB.lastEventAt = Date.now();
        if (SB.state !== 'online') SB._setState('online');
        var p = null;
        try { p = JSON.parse(ev.data); } catch (e) { return; }
        if (!p) return;
        SB.data.events.unshift(p);
        if (SB.data.events.length > 200) SB.data.events.length = 200;
        PAO.bus.emit('srv:event', p);
        PAO.bus.emit('sb:event', p);
        clearTimeout(SB._reloadTimer);
        SB._reloadTimer = setTimeout(function () { SB.loadAll(); }, 2500);
      }
      es.addEventListener('event', onEvent);
      es.onmessage = onEvent;
      es.onerror = function () {
        try { es.close(); } catch (e) {}
        if (SB._es !== es) return;
        SB._es = null;
        if (SB.state === 'online') SB._setState('polling');
        SB._startPolling();
        clearTimeout(SB._sseTimer);
        SB._sseTimer = setTimeout(function () { if (SB.token) SB._openStream(); }, SSE_RETRY_MS);
      };
    },

    _closeStream: function () {
      if (SB._es) { try { SB._es.close(); } catch (e) {} SB._es = null; }
    },

    _startPolling: function () {
      clearTimeout(SB._pollTimer);
      function tick() {
        if (!SB.token) return;
        SB.loadAll();
        SB._pollTimer = setTimeout(tick, TASK_MS);
      }
      SB._pollTimer = setTimeout(tick, 1000);
    },

    /* ---------------- 给 3D / 面板用的派生模型 ---------------- */
    agentModel: function () {
      return SB.data.agents.map(function (a) {
        var meta = NAME[a.agent_id] || {};
        var ls = a.live_status || 'offline';
        var pending = a.pending_decisions || 0;
        var status = 'idle';
        if (a.status === 'disabled') status = 'paused';
        else if (pending > 0) status = 'waiting';
        else if (ls === 'working') status = 'running';
        else if (ls === 'offline') status = 'paused';
        var short = String(a.agent_id || '').replace(/-chief$/, '').toUpperCase();
        return {
          id: a.agent_id,
          name: short || a.agent_id,
          zh: meta.role || (a.kind === 'chief' ? '指挥入口' : '执行者'),
          role: meta.role || (a.kind === 'chief' ? '指挥入口' : '执行者'),
          kind: a.kind,
          live: ls,
          status: status,
          pending: pending,
          taskId: a.current_task_id || null,
          everConnected: !!a.ever_connected,
          capabilities: a.capabilities || []
        };
      });
    },

    statusText: function () {
      var s = SB.state;
      if (s === 'online') return 'SSE 实时';
      if (s === 'polling') return '轮询兜底';
      if (s === 'connecting') return '连接中';
      if (s === 'offline') return '连接失败';
      return '未接入';
    },

    status: function () {
      return { state: SB.state, lastEventAt: SB.lastEventAt, lastLoadAt: SB.lastLoadAt, error: SB.error };
    },

    init: function () {
      SB.token = SB.readToken();
      if (!SB.token) { SB._setState('locked'); PAO.bus.emit('sb:auth-needed', {}); return; }
      SB.connect();
    }
  };

  function iso(sec) { return sec ? new Date(Number(sec) * 1000).toISOString() : ''; }
  function fmtTime(sec) {
    if (!sec) return '未知';
    var d = new Date(Number(sec) * 1000), n = new Date();
    var diff = (n.getTime() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function countCats(list) {
    var s = {};
    (list || []).forEach(function (x) { s[x.category] = 1; });
    return Object.keys(s).length;
  }

  SB.fmtTime = fmtTime;
  SB.iso = iso;
  PAO.SB = SB;
})(window.PAO = window.PAO || {});
