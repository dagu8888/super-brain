/* ==========================================================================
   PERSONAL AI OS — MODULE 04 · 数据宇宙（Data Universe）  js/ui/panels/data.js
   依赖：PAO.dom / PAO.bus / PAO.scene / PAO.ui / PAO.DATA（只读）
   约束：ES5（var + function）、IIFE、颜色只用 CSS 变量、不用 innerHTML 拼数据、
        事件委托、render 重建 DOM、onExit 清 timer。
   ========================================================================== */
(function (PAO) {
  'use strict';

  var dom = PAO.dom;

  /* ---------- 01 · 文案常量 ---------- */
  var ST_META = {
    SIMULATED: { zh: '模拟接入', en: 'SIMULATED', dot: 'var(--cyan)', scene: 'connected' },
    PAUSED: { zh: '已暂停', en: 'PAUSED', dot: 'var(--warn)', scene: 'paused' },
    NOT_CONNECTED: { zh: '未连接', en: 'NOT CONNECTED', dot: 'var(--grey)', scene: 'off' }
  };
  var PROC_META = { PROCESSING: '处理中', IDLE: '空闲', QUEUED: '排队中', PAUSED: '已暂停', DONE: '已完成', FAILED: '处理失败' };
  var RISK_META = {
    LOW: { zh: '低', color: 'var(--ok)' },
    MEDIUM: { zh: '中', color: 'var(--warn)' },
    HIGH: { zh: '高', color: 'var(--crit)' }
  };
  /* DATA.sources[].icon 可能是语义名，dom.ICONS 里没有的做兜底映射 */
  var ICON_BY_ID = {
    email: 'mail', calendar: 'calendar', documents: 'doc', images: 'image', voice: 'voice',
    browser: 'browser', mobile: 'mobile', desktop: 'desktop', wearables: 'watch', input: 'edit'
  };
  /* 管线四段职责（UI 文案；DATA.pipeline 只给 id / name / zh） */
  var PIPE_META = {
    capture: {
      en: 'CAPTURE', zh: '采集', vol: '1 284', unit: '条 / 小时',
      duty: '按最小必要原则从各数据源拉取原始内容，只取完成当前任务所需的字段。',
      items: ['按授权范围过滤，未授权字段不进入管线', '仅在本地缓存摘要，不保留完整副本', '全部为模拟链路，不产生任何真实网络请求'],
      out: '原始记录（未清洗）'
    },
    ingest: {
      en: 'INGESTION', zh: '接入清洗', vol: '968', unit: '条 / 小时',
      duty: '标准化格式、去重、切分与打标，把异构的原始内容整理成可计算的结构。',
      items: ['识别重复内容并合并为单条事件', '抽取时间、人物、主题三类基础标签', '异常记录进入隔离区，不静默丢弃'],
      out: '结构化记录'
    },
    govern: {
      en: 'GOVERNANCE', zh: '治理审核', vol: '812', unit: '条 / 小时',
      duty: '判定敏感级别、保留期限与可访问范围，决定哪些内容有资格进入长期记忆。',
      items: ['按敏感级别套用保留策略（30 天 / 90 天 / 长期）', '来源标记为事实 / 观察 / 推断，供界面区分呈现', '越权访问请求在此环节被拦截并记入审计'],
      out: '合规记录'
    },
    store: {
      en: 'MEMORY STORE', zh: '记忆存储', vol: '782', unit: '条 / 小时',
      duty: '写入个人记忆库，建立索引与关联，成为可被智能体检索的长期上下文。',
      items: ['写入时生成版本号，后续修订保留历史', '与认知维度、关联记忆建立双向索引', '可随时导出为标准格式，不绑定任何模型'],
      out: '记忆条目 + 索引'
    }
  };
  var BTN_META = {
    connect: { act: 'connect', label: '模拟接入', cls: 'pao-btn pao-btn--primary', icon: 'sync' },
    pause: { act: 'pause', label: '暂停', cls: 'pao-btn pao-btn--ghost', icon: 'pause' },
    resume: { act: 'resume', label: '恢复', cls: 'pao-btn pao-btn--primary', icon: 'play' },
    revoke: { act: 'revoke', label: '撤销授权', cls: 'pao-btn pao-btn--danger', icon: 'unlock' }
  };

  /* ---------- 02 · 本地可变状态（DATA 只读，切换结果写这里） ---------- */
  var st = {
    host: null, ctx: null,
    map: {},        // id -> { status, scopeList, lastSync }
    init: {},       // id -> { scopeList } 初始快照，接入时恢复范围
    selected: null, // 展开的数据源 id
    pipeOpen: null, // 展开的管线段 id
    revoked: {},    // id -> true，撤销后 3 秒提示
    timers: []
  };

  /* ---------- 03 · 小工具 ---------- */
  function arr(v) { return Object.prototype.toString.call(v) === '[object Array]' ? v : []; }

  function cloneList(v) {
    var src = arr(v), out = [], i;
    for (i = 0; i < src.length; i++) out.push(String(src[i]));
    return out;
  }

  function closestOf(node, sel, stop) {
    while (node && node !== stop) {
      if (node.nodeType === 1) {
        if (node.matches && node.matches(sel)) return node;
        if (node.msMatchesSelector && node.msMatchesSelector(sel)) return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  function dataOf(ctx) { return (ctx && ctx.data) || PAO.DATA || {}; }

  function clearTimers() {
    for (var i = 0; i < st.timers.length; i++) clearTimeout(st.timers[i]);
    st.timers = [];
  }

  function addTimer(fn, ms) {
    var id = setTimeout(function () {
      var k = st.timers.indexOf(id);
      if (k > -1) st.timers.splice(k, 1);
      fn();
    }, ms);
    st.timers.push(id);
  }

  function kv(k, v) {
    return dom.el('div', { className: 'pao-kv' }, [
      dom.el('span', { className: 'pao-kv__k', text: k }),
      dom.el('span', { className: 'pao-kv__v' }, v)
    ]);
  }
  function hint(text) { return dom.el('span', { className: 'pao-section__hint', text: text }); }
  function empty(text) { return dom.el('div', { className: 'pao-empty', text: text }); }
  function dot(color) {
    return dom.el('i', { style: { width: '6px', height: '6px', borderRadius: '50%', background: color, display: 'inline-block', flex: '0 0 auto' } });
  }
  function statusTag(meta) {
    return dom.el('span', { className: 'pao-tag', style: { display: 'inline-flex', alignItems: 'center', gap: '5px', color: meta.dot, borderColor: 'var(--line)' } }, [dot(meta.dot), meta.zh]);
  }
  function revokedTag() {
    return dom.el('span', { className: 'pao-tag', style: { display: 'inline-flex', alignItems: 'center', gap: '5px', color: 'var(--crit)', borderColor: 'var(--crit-30)' } }, ['已撤销']);
  }
  function btn(meta) {
    return dom.el('button', { type: 'button', className: meta.cls, dataset: { act: meta.act } }, [dom.icon(meta.icon, 14), dom.el('span', { text: meta.label })]);
  }
  function iconName(source) {
    var raw = source && source.icon ? String(source.icon) : '';
    if (raw && dom.ICONS && dom.ICONS[raw]) return raw;
    var byId = ICON_BY_ID[source && source.id ? String(source.id) : ''];
    if (byId && dom.ICONS && dom.ICONS[byId]) return byId;
    return raw || 'data';
  }
  function procLabel(raw) {
    if (!raw) return '—';
    var key = String(raw).toUpperCase();
    return PROC_META[key] || String(raw);
  }
  function isProcessing(source) {
    if (!source) return false;
    var p = String(source.processing || '').toUpperCase();
    var s = String(source.status || '').toUpperCase();
    return p.indexOf('PROCESS') === 0 || s === 'PROCESSING';
  }
  function riskOf(raw) {
    var key = String(raw == null ? '' : raw).toUpperCase();
    if (RISK_META[key]) return RISK_META[key];
    if (raw) return { zh: String(raw), color: 'var(--grey)' };
    return { zh: '未评估', color: 'var(--grey)' };
  }

  /* ---------- 04 · 状态同步 ---------- */
  function syncState(ctx) {
    var list = arr(dataOf(ctx).sources), i, s;
    for (i = 0; i < list.length; i++) {
      s = list[i];
      if (!s || !s.id) continue;
      if (!st.map[s.id]) {
        st.map[s.id] = {
          status: ST_META[s.status] ? s.status : 'NOT_CONNECTED',
          scopeList: cloneList(s.scopeList),
          lastSync: s.lastSync || null
        };
        st.init[s.id] = { scopeList: cloneList(s.scopeList) };
      }
    }
    if (st.selected && !st.map[st.selected]) st.selected = null;
  }
  function viewOf(id) {
    return st.map[id] || { status: 'NOT_CONNECTED', scopeList: [], lastSync: null };
  }
  function findSource(ctx, id) {
    var list = arr(dataOf(ctx).sources), i;
    for (i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function countsOf(ctx) {
    var list = arr(dataOf(ctx).sources);
    var out = { total: list.length, simulated: 0, paused: 0, off: 0 }, i, v;
    for (i = 0; i < list.length; i++) {
      v = viewOf(list[i].id);
      if (v.status === 'SIMULATED') out.simulated++;
      else if (v.status === 'PAUSED') out.paused++;
      else out.off++;
    }
    return out;
  }

  /* ---------- 05 · 分区头 ---------- */
  function sectionHead(title, rightText) {
    var head = dom.el('div', { className: 'pao-section__head' }, [dom.el('h3', { className: 'pao-section__title', text: title })]);
    if (rightText) head.appendChild(hint(rightText));
    return head;
  }

  /* ---------- 06 · 顶部概览 ---------- */
  function statCell(label, value, colorVar, note) {
    return dom.el('div', {
      className: 'pao-kv',
      style: {
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px',
        padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 'var(--r-m)', background: 'var(--glass)'
      }
    }, [
      dom.el('span', { className: 'pao-kv__k', text: label }),
      dom.el('span', {
        className: 'pao-num', text: String(value),
        style: { fontSize: 'var(--fs-h2)', lineHeight: '1.15', color: colorVar || 'var(--text-1)', fontFamily: 'var(--font-mono)' }
      }),
      dom.el('span', { text: note || '单位 · 个', style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)', letterSpacing: 'var(--track-cn)' } })
    ]);
  }

  function overviewSection(ctx) {
    var sec = dom.el('section', { className: 'pao-section', dataset: { sec: 'overview' } });
    var c = countsOf(ctx);
    sec.appendChild(sectionHead('数据源总览', '本地真实数据源'));
    if (!c.total) {
      sec.appendChild(empty('数据源清单尚未载入（等待 PAO.DATA）。'));
      return sec;
    }
    sec.appendChild(dom.el('div', { className: 'pao-grid-2' }, [
      statCell('数据源总数', c.total, 'var(--text-1)', '全部为本地模拟连接器'),
      statCell('模拟接入', c.simulated, 'var(--cyan)', '仅读取示例数据'),
      statCell('已暂停', c.paused, 'var(--warn)', '保留配置，不采集'),
      statCell('未连接', c.off, 'var(--grey)', '未授权任何范围')
    ]));
    sec.appendChild(dom.el('p', {
      className: 'pao-section__hint', text: '所有连接器均为模拟，未接入真实账户。', style: { marginTop: '8px' }
    }));
    return sec;
  }

  /* ---------- 07 · 数据处理管线 ---------- */
  function pipeSeg(p) {
    var meta = PIPE_META[p.id] || { en: p.name || String(p.id).toUpperCase(), zh: p.zh || '', vol: '—', unit: '条 / 小时' };
    var open = st.pipeOpen === p.id;
    return dom.el('button', {
      type: 'button', className: 'pao-list__item', dataset: { act: 'pipe', pipe: p.id },
      style: {
        flex: '1 1 0', minWidth: '0', display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
        gap: '3px', textAlign: 'left', cursor: 'pointer',
        borderColor: open ? 'var(--line-accent)' : '', background: open ? 'var(--cyan-06)' : ''
      }
    }, [
      dom.el('span', { text: meta.zh, style: { fontSize: 'var(--fs-body)', color: 'var(--text-1)', letterSpacing: '0', whiteSpace: 'nowrap', lineHeight: '1.3' } }),
      dom.el('span', { className: 'pao-mono', text: meta.en, style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)', letterSpacing: 'var(--track)' } }),
      dom.el('span', { className: 'pao-num', text: String(meta.vol), style: { fontSize: 'var(--fs-title)', color: 'var(--cyan)', fontFamily: 'var(--font-mono)' } }),
      dom.el('span', { text: meta.unit, style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)' } })
    ]);
  }

  function pipeArrow() {
    return dom.el('span', {
      'aria-hidden': 'true',
      style: { alignSelf: 'center', flex: '0 0 auto', display: 'flex', alignItems: 'center', color: 'var(--text-5)' }
    }, [dom.icon('chevron', 12)]);
  }

  function pipeDetail(p) {
    var meta = PIPE_META[p.id];
    if (!meta) return empty('该段暂无说明。');
    var box = dom.el('div', {
      style: { marginTop: '8px', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 'var(--r-m)', background: 'var(--glass-2)' }
    });
    box.appendChild(dom.el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } }, [
      dom.el('strong', { text: (p.zh || meta.zh) + ' · ' + (p.name || meta.en), style: { fontSize: 'var(--fs-body)', color: 'var(--text-1)', fontWeight: '500' } }),
      dom.el('span', { className: 'pao-mono', text: 'STAGE ' + String(p.id || '').toUpperCase(), style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)', letterSpacing: 'var(--track)' } })
    ]));
    box.appendChild(dom.el('p', {
      text: meta.duty, style: { margin: '6px 0 8px', fontSize: 'var(--fs-small)', lineHeight: 'var(--lh-small)', color: 'var(--text-2)' }
    }));
    var list = dom.el('div', { className: 'pao-list' }), i;
    for (i = 0; i < meta.items.length; i++) {
      list.appendChild(dom.el('div', { className: 'pao-list__item' }, [
        dom.el('span', { className: 'pao-mono', text: '·', style: { color: 'var(--cyan)', marginRight: '6px' } }),
        dom.el('span', { text: meta.items[i], style: { fontSize: 'var(--fs-small)', color: 'var(--text-2)' } })
      ]));
    }
    box.appendChild(list);
    box.appendChild(dom.el('div', { text: '输出：' + meta.out, style: { marginTop: '6px', fontSize: 'var(--fs-small)', color: 'var(--text-3)' } }));
    box.appendChild(dom.el('div', { text: '处理量为本地统计值。', style: { marginTop: '4px', fontSize: 'var(--fs-micro)', color: 'var(--text-5)' } }));
    return box;
  }

  function pipelineSection(ctx) {
    var sec = dom.el('section', { className: 'pao-section', dataset: { sec: 'pipeline' } });
    var pipes = arr(dataOf(ctx).pipeline), row, i;
    sec.appendChild(sectionHead('数据处理管线', '四段 · 本地统计'));
    sec.appendChild(dom.el('p', { className: 'pao-section__hint', text: '点击任一段查看该段职责。', style: { margin: '0 0 8px' } }));
    if (!pipes.length) {
      sec.appendChild(empty('管线定义尚未载入（DATA.pipeline）。'));
      return sec;
    }
    row = dom.el('div', { className: 'pao-list', style: { display: 'flex', flexDirection: 'row', alignItems: 'stretch', gap: '6px', flexWrap: 'nowrap' } });
    for (i = 0; i < pipes.length; i++) {
      if (i) row.appendChild(pipeArrow());
      row.appendChild(pipeSeg(pipes[i]));
    }
    sec.appendChild(row);
    if (st.pipeOpen) {
      var hit = null;
      for (i = 0; i < pipes.length; i++) if (pipes[i].id === st.pipeOpen) hit = pipes[i];
      if (hit) sec.appendChild(pipeDetail(hit));
    }
    return sec;
  }

  /* ---------- 08 · 数据源网格 ---------- */
  function syncLine(v) {
    if (!v.lastSync) return dom.el('span', { text: '尚未同步', style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)' } });
    return dom.el('span', { className: 'pao-mono', text: '最近同步 · ' + dom.fmt.ago(v.lastSync), style: { fontSize: 'var(--fs-micro)', color: 'var(--text-3)' } });
  }

  function recordsLine(source, v) {
    if (v.status === 'NOT_CONNECTED') {
      return dom.el('span', { text: '记录数 —', style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)' } });
    }
    if (isProcessing(source)) {
      return dom.el('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%' } }, [
        dom.el('span', { className: 'pao-tag', text: '处理中', style: { color: 'var(--warn)', borderColor: 'var(--warn-30)' } }),
        dom.el('span', { className: 'pao-mono', text: dom.fmt.num(source.records) + ' 条', style: { fontSize: 'var(--fs-micro)', color: 'var(--text-3)' } })
      ]);
    }
    return dom.el('span', { className: 'pao-mono', text: dom.fmt.num(source.records) + ' 条', style: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)' } });
  }

  function progressBar(source) {
    var wrap = dom.el('div', { className: 'pao-meter', style: { width: '100%', marginTop: '2px' } });
    var ratio = 0.5, rec = Number(source && source.records);
    if (!isNaN(rec) && rec > 0) ratio = Math.min(0.94, 0.35 + (rec % 60) / 100);
    var fill = dom.el('i', { className: 'pao-meter__fill' });
    fill.style.transform = 'scaleX(' + ratio + ')';
    fill.style.transformOrigin = 'left center';
    fill.style.background = 'var(--warn)';
    wrap.appendChild(fill);
    return wrap;
  }

  function sourceCard(source) {
    var v = viewOf(source.id);
    var meta = ST_META[v.status] || ST_META.NOT_CONNECTED;
    var active = st.selected === source.id;
    var ic = dom.icon(iconName(source), 18);
    ic.style.color = meta.dot;
    ic.style.flex = '0 0 auto';

    var top = dom.el('span', { style: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minWidth: '0' } }, [
      ic,
      dom.el('span', { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '0' } }, [
        dom.el('span', {
          className: 'pao-mono', text: String(source.name || source.id || '').toUpperCase(),
          style: { fontSize: 'var(--fs-small)', letterSpacing: 'var(--track)', color: 'var(--text-1)' }
        }),
        dom.el('span', { text: source.zh || '', style: { fontSize: 'var(--fs-small)', color: 'var(--text-3)', letterSpacing: 'var(--track-cn)' } })
      ])
    ]);

    var badgeRow = dom.el('span', { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' } }, [statusTag(meta)]);
    if (st.revoked[source.id]) badgeRow.appendChild(revokedTag());

    var card = dom.el('button', {
      type: 'button', className: 'pao-list__item', dataset: { act: 'source', src: source.id },
      style: {
        display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '6px',
        width: '100%', textAlign: 'left', cursor: 'pointer',
        borderColor: active ? 'var(--line-accent)' : '', background: active ? 'var(--cyan-06)' : ''
      }
    }, [top, badgeRow, syncLine(v), recordsLine(source, v)]);
    if (isProcessing(source) && v.status !== 'NOT_CONNECTED') card.appendChild(progressBar(source));
    return card;
  }

  function gridSection(ctx) {
    var sec = dom.el('section', { className: 'pao-section', dataset: { sec: 'sources' } });
    var list = arr(dataOf(ctx).sources), grid, i;
    sec.appendChild(sectionHead('数据源', list.length + ' 个 · 全部模拟'));
    if (!list.length) {
      sec.appendChild(empty('数据源清单尚未载入（DATA.sources）。'));
      return sec;
    }
    grid = dom.el('div', { className: 'pao-source-grid' });
    for (i = 0; i < list.length; i++) grid.appendChild(sourceCard(list[i]));
    sec.appendChild(grid);
    return sec;
  }

  /* ---------- 09 · 数据源详情 ---------- */
  function detailActions(v) {
    var row = dom.el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' } });
    if (v.status === 'SIMULATED') row.appendChild(btn(BTN_META.pause));
    else if (v.status === 'PAUSED') row.appendChild(btn(BTN_META.resume));
    else row.appendChild(btn(BTN_META.connect));
    return row;
  }

  function scopeListBlock(v) {
    if (!v.scopeList.length) return empty('尚未授权任何范围。');
    var list = dom.el('div', { className: 'pao-list' }), i;
    for (i = 0; i < v.scopeList.length; i++) {
      list.appendChild(dom.el('div', { className: 'pao-list__item' }, [
        dom.el('span', { className: 'pao-mono', text: '·', style: { color: 'var(--cyan)', marginRight: '6px' } }),
        dom.el('span', { text: v.scopeList[i], style: { fontSize: 'var(--fs-small)', color: 'var(--text-2)' } })
      ]));
    }
    return list;
  }

  function detailSection(ctx) {
    var sec = dom.el('section', { className: 'pao-section', dataset: { sec: 'detail' } });
    if (!st.selected) {
      sec.appendChild(sectionHead('数据源详情', '点击上方卡片'));
      sec.appendChild(empty('尚未选择数据源。点击任意卡片查看授权范围与处理状态。'));
      return sec;
    }

    var source = findSource(ctx, st.selected);
    if (!source) {
      sec.appendChild(sectionHead('数据源详情', '—'));
      sec.appendChild(empty('该数据源不在当前数据集中。'));
      return sec;
    }

    var v = viewOf(source.id);
    var meta = ST_META[v.status] || ST_META.NOT_CONNECTED;
    var risk = riskOf(source.risk);
    var ic = dom.icon(iconName(source), 18);
    ic.style.color = meta.dot;

    sec.appendChild(dom.el('div', { className: 'pao-section__head' }, [
      dom.el('h3', { className: 'pao-section__title', text: '数据源详情' }),
      dom.el('button', {
        type: 'button', className: 'pao-btn pao-btn--icon', dataset: { act: 'close-detail' },
        title: '收起详情', 'aria-label': '收起详情'
      }, [dom.icon('close', 14)])
    ]));

    var titleRow = dom.el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' } }, [
      ic,
      dom.el('span', { className: 'pao-mono', text: String(source.name || source.id).toUpperCase(), style: { fontSize: 'var(--fs-title)', letterSpacing: 'var(--track)', color: 'var(--text-1)' } }),
      dom.el('span', { text: source.zh || '', style: { fontSize: 'var(--fs-body)', color: 'var(--text-3)' } }),
      statusTag(meta)
    ]);
    if (st.revoked[source.id]) titleRow.appendChild(revokedTag());
    sec.appendChild(titleRow);

    if (source.desc) {
      sec.appendChild(dom.el('p', {
        text: source.desc, style: { margin: '0 0 8px', fontSize: 'var(--fs-small)', lineHeight: 'var(--lh-small)', color: 'var(--text-2)' }
      }));
    }

    sec.appendChild(kv('数据种类', (source.typeZh || source.type || '未标注') + (source.type ? '（' + source.type + '）' : '')));
    sec.appendChild(kv('授权状态', meta.zh + ' · ' + meta.en));
    sec.appendChild(kv('最近同步', v.lastSync ? dom.fmt.time(v.lastSync) + '（' + dom.fmt.ago(v.lastSync) + '）' : '尚未同步'));
    sec.appendChild(kv('处理状态', v.status === 'NOT_CONNECTED' ? '未运行（未授权）' : procLabel(source.processing)));
    sec.appendChild(kv('保留策略', source.retention || '未设定'));
    sec.appendChild(kv('风险等级', dom.el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: risk.color } }, [
      dot(risk.color), risk.zh + '（' + String(source.risk || '—') + '）'
    ])));

    sec.appendChild(dom.el('div', {
      className: 'pao-kv__k', text: '采集范围' + (source.scope ? ' · ' + source.scope : ''),
      style: { marginTop: '10px', display: 'block' }
    }));
    sec.appendChild(scopeListBlock(v));
    sec.appendChild(detailActions(v));

    if (v.status === 'SIMULATED' || v.status === 'PAUSED') {
      sec.appendChild(dom.el('div', { className: 'pao-danger-zone' }, [
        dom.el('div', {
          text: '撤销授权：立即停止采集并清空授权范围，已进入记忆库的内容仍保留。',
          style: { fontSize: 'var(--fs-small)', color: 'var(--text-3)', marginBottom: '8px' }
        }),
        btn(BTN_META.revoke)
      ]));
    }

    sec.appendChild(dom.el('p', {
      className: 'pao-section__hint', text: '本面板的所有连接器与同步状态均为本地模拟。', style: { marginTop: '10px' }
    }));
    return sec;
  }

  /* ---------- 10 · 页脚声明 ---------- */
  function footer() {
    return dom.el('footer', { style: { paddingTop: '10px', borderTop: '1px solid var(--line)', marginTop: '4px' } }, [
      dom.el('div', { className: 'pao-divider', style: { marginBottom: '8px' } }),
      dom.el('div', {
        text: '外部连接器为本地模拟 · 未接入任何外部账户',
        style: { fontSize: 'var(--fs-small)', color: 'var(--text-4)', letterSpacing: 'var(--track-cn)', lineHeight: 'var(--lh-small)' }
      })
    ]);
  }

  /* ---------- 11 · 重绘 ---------- */
  function paint() {
    if (!st.host) return;
    dom.clear(st.host);
    var ctx = st.ctx;
    st.host.appendChild(overviewSection(ctx));
    st.host.appendChild(pipelineSection(ctx));
    st.host.appendChild(gridSection(ctx));
    st.host.appendChild(detailSection(ctx));
    st.host.appendChild(footer());
  }

  /* ---------- 12 · 场景 / 事件 / 提示 ---------- */
  function sceneSet(ctx, id, state) {
    if (ctx && ctx.scene && ctx.scene.setSourceState) {
      try { ctx.scene.setSourceState(id, state); } catch (err) { /* 场景未就绪时忽略 */ }
    }
  }
  function sceneHighlight(ctx, id) {
    if (ctx && ctx.scene && ctx.scene.highlightSource) {
      try { ctx.scene.highlightSource(id); } catch (err) { /* 忽略 */ }
    }
  }
  function emitToggle(id, connected) {
    /* 总线不可用或抛错时不得阻断面板交互 */
    if (!PAO.bus || !PAO.bus.emit) return;
    try { PAO.bus.emit('source:toggle', { id: id, connected: !!connected }); } catch (err) { /* 忽略 */ }
  }
  function toast(ctx, kind, title, text) {
    if (ctx && ctx.ui && ctx.ui.toast) ctx.ui.toast(kind, title, text);
  }
  function labelOf(source) { return '「' + ((source && (source.zh || source.name || source.id)) || '该数据源') + '」'; }

  /* ---------- 13 · 行为：接入 / 暂停 / 恢复 / 撤销 ---------- */
  function doConnect(ctx, source) {
    var v = viewOf(source.id), init = st.init[source.id];
    v.status = 'SIMULATED';
    v.scopeList = cloneList(init ? init.scopeList : []);
    if (!v.scopeList.length && source.scope) v.scopeList = [String(source.scope)];
    if (!v.scopeList.length) v.scopeList = ['最小必要字段（模拟授权）'];
    delete st.revoked[source.id];
    emitToggle(source.id, true);
    sceneSet(ctx, source.id, 'connected');
    sceneHighlight(ctx, source.id);
    toast(ctx, 'ok', '已模拟接入', labelOf(source) + ' 以模拟方式接入，未读取任何真实账户数据。');
    paint();
  }

  function doPause(ctx, source) {
    viewOf(source.id).status = 'PAUSED';
    emitToggle(source.id, false);
    sceneSet(ctx, source.id, 'paused');
    toast(ctx, 'warn', '已暂停', labelOf(source) + ' 停止采集，已进入记忆库的内容保留。');
    paint();
  }

  function doResume(ctx, source) {
    var v = viewOf(source.id), init = st.init[source.id];
    v.status = 'SIMULATED';
    if (!v.scopeList.length) v.scopeList = cloneList(init ? init.scopeList : []);
    if (!v.scopeList.length) v.scopeList = ['最小必要字段（模拟授权）'];
    emitToggle(source.id, true);
    sceneSet(ctx, source.id, 'connected');
    toast(ctx, 'ok', '已恢复', labelOf(source) + ' 恢复模拟采集。');
    paint();
  }

  function markRevoked(id) {
    st.revoked[id] = true;
    addTimer(function () {
      delete st.revoked[id];
      paint();
    }, 3000);
  }

  function doRevoke(ctx, source) {
    var v = viewOf(source.id);
    v.status = 'NOT_CONNECTED';
    v.scopeList = [];           // 授权范围清空；lastSync 保留历史值
    emitToggle(source.id, false);
    sceneSet(ctx, source.id, 'off');
    markRevoked(source.id);
    toast(ctx, 'crit', '已撤销授权', labelOf(source) + ' 已停止采集，授权范围已清空（本地模拟）。');
    paint();
  }

  function revoke(ctx, source) {
    var ui = ctx && ctx.ui;
    var text = '撤销后该数据源将立即停止数据采集，已进入记忆库的内容仍将保留（可另行删除）。此为本地模拟操作。';
    if (!ui || !ui.confirm) {
      doRevoke(ctx, source);
      return;
    }
    var p = ui.confirm({ danger: true, title: '确认撤销授权', text: text, confirmText: '确认撤销' });
    if (p && typeof p.then === 'function') {
      p.then(function (ok) { if (ok) doRevoke(ctx, source); });
    } else {
      doRevoke(ctx, source);
    }
  }

  /* ---------- 14 · 事件委托 ---------- */
  function onHostClick(e) {
    var node = closestOf(e.target, '[data-act]', st.host);
    if (!node) return;
    var act = node.getAttribute('data-act');
    var ctx = st.ctx;
    var id, source;

    if (act === 'pipe') {
      var pid = node.getAttribute('data-pipe');
      st.pipeOpen = (st.pipeOpen === pid) ? null : pid;
      paint();
      return;
    }
    if (act === 'source') {
      id = node.getAttribute('data-src');
      st.selected = (st.selected === id) ? null : id;
      sceneHighlight(ctx, id);
      paint();
      return;
    }
    if (act === 'close-detail') {
      st.selected = null;
      paint();
      return;
    }

    id = st.selected;
    source = id ? findSource(ctx, id) : null;
    if (!source) return;

    if (act === 'connect') doConnect(ctx, source);
    else if (act === 'pause') doPause(ctx, source);
    else if (act === 'resume') doResume(ctx, source);
    else if (act === 'revoke') revoke(ctx, source);
  }

  /* ---------- 15 · 面板注册 ---------- */
  PAO.panels = PAO.panels || {};

  PAO.panels['data'] = {
    id: 'data',
    kicker: 'MODULE 04',
    label: 'DATA UNIVERSE',
    zh: '数据宇宙',
    tagline: 'YOUR DIGITAL WORLD. ONE INTELLIGENCE LAYER.',
    taglineZh: '你的数字世界，一层智能统筹。',
    badge: '模拟连接',

    render: function (root, ctx) {
      clearTimers();
      st.ctx = ctx;
      st.host = dom.el('div', {
        dataset: { pao: 'data' },
        style: { display: 'flex', flexDirection: 'column', gap: '16px', width: '100%' }
      });
      syncState(ctx);
      root.appendChild(st.host);
      st.host.addEventListener('click', onHostClick);
      paint();
    },

    onEnter: function (ctx) { st.ctx = ctx || st.ctx; },

    onExit: function () {
      clearTimers();
      if (st.host) {
        st.host.removeEventListener('click', onHostClick);
        st.host = null;
      }
    }
  };
})(window.PAO = window.PAO || {});
