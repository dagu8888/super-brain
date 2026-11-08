/* ==========================================================================
   PERSONAL AI OS — MODULE 05 · 模型网关（Model Gateway）  js/ui/panels/model.js
   依赖：PAO.dom / PAO.bus / PAO.scene / PAO.ui / PAO.DATA（只读）
   约束：ES5（var + function）、IIFE、颜色只用 CSS 变量、不用 innerHTML 拼数据、
        事件委托、render 重建 DOM、onExit 清 timer。
   ========================================================================== */
(function (PAO) {
  'use strict';

  var dom = PAO.dom;

  /* ---------- 01 · 常量 ---------- */
  /* 路由规则命中提示：按任务类型在规则文本里做关键词匹配 */
  var TASK_KEY = {
    reasoning: ['推理', '复杂'],
    summary: ['摘要', '长文本', '压缩'],
    vision: ['图像', '视觉', '多模态'],
    private: ['隐私', '本地', '敏感']
  };

  /* ---------- 02 · 本地状态 ---------- */
  var st = {
    host: null, ctx: null,
    models: [], tasks: [], rules: [], results: {},
    task: null,          // 当前任务类型 id
    scanning: false,     // 是否正在播放比选动画
    scanIdx: -1,         // 当前高亮的模型下标
    ticks: 0,
    timer: null,
    result: null,        // { taskId, modelId, score, why, estCost, estLatency, rule }
    log: [],             // 最近 6 条：{ at, taskZh, model, score }
    selected: null,      // 用户点选的模型 id
    refs: { cards: {}, flags: {}, taskRow: null, routeBtn: null, status: null, resultBox: null, logBox: null }
  };

  /* ---------- 03 · 小工具 ---------- */
  function arr(v) { return Object.prototype.toString.call(v) === '[object Array]' ? v : []; }

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
  function hint(text) { return dom.el('span', { className: 'pao-section__hint', text: text }); }
  function empty(text) { return dom.el('div', { className: 'pao-empty', text: text }); }

  function clamp01(v) {
    var n = Number(v);
    if (isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function meter(value, color) {
    var wrap = dom.el('div', { className: 'pao-meter', style: { flex: '1 1 auto', minWidth: '40px' } });
    var fill = dom.el('i', { className: 'pao-meter__fill' });
    fill.style.transform = 'scaleX(' + clamp01(value) + ')';
    fill.style.transformOrigin = 'left center';
    if (color) fill.style.background = color;
    wrap.appendChild(fill);
    return wrap;
  }

  function kv(k, v) {
    return dom.el('div', { className: 'pao-kv' }, [
      dom.el('span', { className: 'pao-kv__k', text: k }),
      dom.el('span', { className: 'pao-kv__v' }, v)
    ]);
  }

  function mono(text, color) {
    return dom.el('span', {
      className: 'pao-mono', text: text,
      style: { color: color || 'var(--text-1)', letterSpacing: '0' }
    });
  }

  /* 延迟：数字 → 「820 毫秒」；字符串原样 */
  function fmtLatency(v) {
    if (v == null || v === '') return '—';
    if (typeof v === 'number') return dom.fmt.num(v) + ' 毫秒';
    return String(v);
  }

  /* 千词成本：数字 → 「¥0.042 / 千词」；字符串原样 */
  function fmtCost1k(v) {
    if (v == null || v === '') return '—';
    var n = Number(v);
    if (isNaN(n)) return String(v);
    return '¥' + n.toFixed(3) + ' / 千词';
  }

  /* 单次预计成本 */
  function fmtCost(v) {
    if (v == null || v === '') return '—';
    var n = Number(v);
    if (isNaN(n)) return String(v);
    return '¥' + n.toFixed(3);
  }

  function scoreText(v) {
    var n = Number(v);
    return isNaN(n) ? '—' : n.toFixed(2);
  }

  function pctText(v) {
    var n = Number(v);
    return isNaN(n) ? '—' : Math.round(n * 100) + '%';
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function clockOf(d) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function modelById(id) {
    for (var i = 0; i < st.models.length; i++) if (st.models[i].id === id) return st.models[i];
    return null;
  }

  function taskById(id) {
    for (var i = 0; i < st.tasks.length; i++) if (st.tasks[i].id === id) return st.tasks[i];
    return null;
  }

  function taskLabel(id) {
    var t = taskById(id);
    return t ? (t.zh || t.name || t.id) : (id || '—');
  }

  function resultsFor(taskId) {
    var list = arr(st.results[taskId]).slice();
    list.sort(function (a, b) { return (Number(b && b.score) || 0) - (Number(a && a.score) || 0); });
    return list;
  }

  /* 规则命中：先按任务关键词匹配，匹配不到按任务序号取一条，保证每次都有解释 */
  function pickRule(taskId) {
    if (!st.rules.length) return null;
    var keys = TASK_KEY[taskId] || [], i, j, hay;
    for (i = 0; i < st.rules.length; i++) {
      hay = String(st.rules[i].cond || '') + ' ' + String(st.rules[i].action || '') + ' ' + String(st.rules[i].zh || '');
      for (j = 0; j < keys.length; j++) if (hay.indexOf(keys[j]) > -1) return st.rules[i];
    }
    var idx = 0;
    for (i = 0; i < st.tasks.length; i++) if (st.tasks[i].id === taskId) idx = i;
    return st.rules[idx % st.rules.length] || st.rules[0];
  }

  /* ---------- 04 · 状态同步 ---------- */
  function sync(ctx) {
    var data = dataOf(ctx);
    var routing = data.routing || {};
    st.models = arr(data.models);
    st.tasks = arr(routing.tasks);
    st.rules = arr(routing.rules);
    st.results = routing.results || {};
    if (!st.task || !taskById(st.task)) st.task = st.tasks.length ? st.tasks[0].id : null;
  }

  /* ---------- 05 · 分区头 ---------- */
  function sectionHead(title, rightText, marginTop) {
    var head = dom.el('div', {
      className: 'pao-section__head',
      style: marginTop ? { marginTop: marginTop } : null
    }, [dom.el('h3', { className: 'pao-section__title', text: title })]);
    if (rightText) head.appendChild(hint(rightText));
    return head;
  }

  /* ---------- 06 · 核心宣言 ---------- */
  function manifestoSection() {
    return dom.el('section', {
      className: 'pao-section',
      dataset: { sec: 'manifesto' },
      style: {
        padding: '18px 16px', border: '1px solid var(--line)',
        borderRadius: 'var(--r-l)', background: 'var(--glass-2)'
      }
    }, [
      dom.el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
        dom.el('div', {
          text: '模型可替换 · 个人记忆可迁移',
          style: { fontSize: 'var(--fs-h1)', lineHeight: '1.2', color: 'var(--text-1)', letterSpacing: 'var(--track-cn)' }
        }),
        dom.el('span', {
          className: 'pao-tag', text: '示例数据',
          style: { color: 'var(--cyan)', borderColor: 'var(--line)' }
        })
      ]),
      dom.el('div', {
        className: 'pao-mono', text: 'MODEL INDEPENDENCE · CONTEXT OWNERSHIP · MEMORY PORTABILITY',
        style: { marginTop: '8px', fontSize: 'var(--fs-kicker)', letterSpacing: 'var(--track-wide)', color: 'var(--text-5)' }
      }),
      dom.el('p', {
        text: '任何一家模型都可以被替换；你的上下文、偏好与记忆留在自己手里，换模型只需改一条路由规则。',
        style: { margin: '10px 0 0', fontSize: 'var(--fs-small)', lineHeight: 'var(--lh-small)', color: 'var(--text-2)' }
      })
    ]);
  }

  /* ---------- 07 · 四个模型卡 ---------- */
  function attrRow(label, valueNode) {
    return dom.el('div', {
      className: 'pao-kv',
      style: { alignItems: 'center' }
    }, [
      dom.el('span', { className: 'pao-kv__k', text: label }),
      dom.el('span', {
        className: 'pao-kv__v',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', minWidth: '60px' }
      }, valueNode)
    ]);
  }

  function barCell(value, color) {
    return [meter(value, color), mono(pctText(value), 'var(--text-3)')];
  }

  function chipRow(list) {
    var row = dom.el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' } });
    var items = arr(list);
    for (var i = 0; i < items.length; i++) {
      row.appendChild(dom.el('span', { className: 'pao-chip', text: String(items[i]) }));
    }
    if (!items.length) row.appendChild(dom.el('span', { text: '—', style: { color: 'var(--text-5)', fontSize: 'var(--fs-micro)' } }));
    return row;
  }

  function modelCard(m, ctx) {
    var flag = dom.el('span', {
      className: 'pao-tag', text: '已选中',
      style: { display: 'none', color: 'var(--cyan)', borderColor: 'var(--line)' }
    });

    var head = dom.el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
      dom.el('span', {
        className: 'pao-mono', text: String(m.name || m.id).toUpperCase(),
        style: { fontSize: 'var(--fs-title)', letterSpacing: 'var(--track)', color: 'var(--text-1)' }
      }),
      dom.el('span', { text: m.zh || '', style: { fontSize: 'var(--fs-small)', color: 'var(--text-3)' } }),
      flag
    ]);

    var card = dom.el('button', {
      type: 'button',
      className: 'pao-model-card',
      dataset: { act: 'model', model: m.id },
      'aria-pressed': 'false',
      style: {
        display: 'flex', flexDirection: 'column', gap: '5px', width: '100%',
        textAlign: 'left', cursor: 'pointer', padding: '12px',
        border: '1px solid var(--line)', borderRadius: 'var(--r-m)', background: 'var(--glass)'
      }
    }, [
      head,
      dom.el('div', {
        text: m.provider || '—',
        style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)', letterSpacing: 'var(--track-cn)' }
      }),
      attrRow('智能度', barCell(m.intelligence, 'var(--cyan)')),
      attrRow('延迟', mono(fmtLatency(m.latencyMs), 'var(--text-1)')),
      attrRow('成本', mono(fmtCost1k(m.costPer1k), 'var(--text-1)')),
      attrRow('隐私', barCell(m.privacy, 'var(--ok)')),
      attrRow('可用性', barCell(m.availability, 'var(--violet)')),
      chipRow(m.bestFor)
    ]);

    if (m.note) {
      card.appendChild(dom.el('div', {
        text: m.note, style: { fontSize: 'var(--fs-micro)', color: 'var(--text-4)', lineHeight: 'var(--lh-small)' }
      }));
    }

    card.addEventListener('mouseenter', function () {
      if (ctx && ctx.scene && ctx.scene.highlightModel) {
        try { ctx.scene.highlightModel(m.id); } catch (err) { /* 场景未就绪时忽略 */ }
      }
      card.style.borderColor = 'var(--line-strong)';
    });
    card.addEventListener('mouseleave', function () {
      card.style.borderColor = st.selected === m.id || (st.result && st.result.modelId === m.id) ? 'var(--line-accent)' : '';
    });

    st.refs.cards[m.id] = card;
    st.refs.flags[m.id] = flag;
    return card;
  }

  function modelsSection(ctx) {
    var sec = dom.el('section', { className: 'pao-section', dataset: { sec: 'models' } });
    sec.appendChild(sectionHead('模型清单 · 可替换层', st.models.length + ' 个 · 示例值'));
    if (!st.models.length) {
      sec.appendChild(empty('模型清单尚未载入（DATA.models）。'));
      return sec;
    }
    var grid = dom.el('div', { className: 'pao-grid-2' }), i;
    for (i = 0; i < st.models.length; i++) grid.appendChild(modelCard(st.models[i], ctx));
    sec.appendChild(grid);
    sec.appendChild(dom.el('p', {
      className: 'pao-section__hint',
      text: '性能数字为示例值，非真实模型测试结果。',
      style: { marginTop: '8px' }
    }));
    return sec;
  }

  /* ---------- 08 · 卡片状态（扫描 / 选中 / 中选） ---------- */
  function applyCardStates() {
    var hot = {}, i, m, node, on;
    if (st.scanning && st.scanIdx >= 0 && st.models[st.scanIdx]) hot[st.models[st.scanIdx].id] = true;
    else {
      if (st.result) hot[st.result.modelId] = true;
      if (st.selected) hot[st.selected] = true;
    }
    for (i = 0; i < st.models.length; i++) {
      m = st.models[i];
      node = st.refs.cards[m.id];
      if (!node) continue;
      on = !!hot[m.id];
      node.style.borderColor = on ? 'var(--line-accent)' : '';
      node.style.background = on ? 'var(--cyan-06)' : '';
      node.style.transform = on ? 'translateY(-1px)' : '';
      node.setAttribute('aria-pressed', st.selected === m.id ? 'true' : 'false');
      if (st.refs.flags[m.id]) st.refs.flags[m.id].style.display = st.selected === m.id ? '' : 'none';
    }
  }

  /* ---------- 09 · 任务切换按钮 ---------- */
  function renderTasks() {
    var box = st.refs.taskRow;
    if (!box) return;
    dom.clear(box);
    var i, t, on;
    for (i = 0; i < st.tasks.length; i++) {
      t = st.tasks[i];
      on = st.task === t.id;
      box.appendChild(dom.el('button', {
        type: 'button',
        className: 'pao-btn ' + (on ? 'pao-btn--primary' : 'pao-btn--ghost'),
        dataset: { act: 'task', task: t.id },
        title: t.name || '',
        'aria-pressed': on ? 'true' : 'false'
      }, [dom.el('span', { text: t.zh || t.name || t.id })]));
    }
  }

  function renderStatus() {
    var node = st.refs.status;
    if (!node) return;
    if (st.scanning) {
      node.textContent = '正在比选 ' + st.models.length + ' 个模型 · 每 140 毫秒切换一次';
    } else if (st.result) {
      var m = modelById(st.result.modelId);
      node.textContent = '已完成 · ' + taskLabel(st.result.taskId) + ' → ' + (m ? String(m.name).toUpperCase() : st.result.modelId);
    } else {
      node.textContent = '就绪 · 当前任务：' + taskLabel(st.task);
    }
  }

  /* ---------- 10 · 结果卡 + 备选排序 ---------- */
  function ruleLine(rule) {
    return dom.el('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '2px', paddingTop: '6px', borderTop: '1px dashed var(--line)' }
    }, [
      dom.el('span', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }
      }, [
        dom.el('span', { text: '命中规则', style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)' } }),
        mono(rule.cond || '—', 'var(--text-2)'),
        dom.el('span', { text: '→', style: { color: 'var(--text-5)' } }),
        mono(rule.action || '—', 'var(--cyan)')
      ]),
      dom.el('span', { text: rule.zh || '', style: { fontSize: 'var(--fs-micro)', color: 'var(--text-4)', lineHeight: 'var(--lh-small)' } })
    ]);
  }

  function resultCard(r) {
    var m = modelById(r.modelId);
    var st1 = Number(r.score);
    var card = dom.el('div', {
      className: 'pao-list__item',
      style: {
        display: 'flex', flexDirection: 'column', gap: '6px',
        borderColor: 'var(--line-accent)', background: 'var(--cyan-06)'
      }
    });

    card.appendChild(dom.el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
      dom.el('span', { text: '中选模型', style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)', letterSpacing: 'var(--track-cn)' } }),
      dom.el('span', {
        className: 'pao-mono', text: m ? String(m.name || m.id).toUpperCase() : String(r.modelId || '—'),
        style: { fontSize: 'var(--fs-title)', letterSpacing: 'var(--track)', color: 'var(--text-1)' }
      }),
      dom.el('span', { text: m ? (m.zh || '') : '', style: { fontSize: 'var(--fs-small)', color: 'var(--text-3)' } }),
      dom.el('span', { className: 'pao-tag', text: '模拟', style: { color: 'var(--cyan)', borderColor: 'var(--line)' } })
    ]));

    card.appendChild(dom.el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
      meter(isNaN(st1) ? 0 : st1, 'var(--cyan)'),
      mono(scoreText(r.score), 'var(--cyan)'),
      dom.el('span', { text: '置信度', style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)' } })
    ]));

    card.appendChild(kv('预计成本', mono(fmtCost(r.estCost), 'var(--text-1)')));
    card.appendChild(kv('预计延迟', mono(fmtLatency(r.estLatency), 'var(--text-1)')));
    card.appendChild(dom.el('p', {
      text: r.why || '示例数据未给出理由。',
      style: { margin: '2px 0 0', fontSize: 'var(--fs-small)', lineHeight: 'var(--lh-small)', color: 'var(--text-2)' }
    }));
    if (r.rule) card.appendChild(ruleLine(r.rule));
    return card;
  }

  function alternativesBlock(taskId) {
    var list = resultsFor(taskId);
    var box = dom.el('div', { style: { marginTop: '10px' } });
    box.appendChild(dom.el('div', {
      className: 'pao-kv__k', text: '备选模型排序（按得分）',
      style: { display: 'block', marginBottom: '6px' }
    }));
    if (!list.length) {
      box.appendChild(empty('无备选结果。'));
      return box;
    }
    var rows = dom.el('div', { className: 'pao-list' }), i, it, m, on;
    for (i = 0; i < list.length; i++) {
      it = list[i];
      m = modelById(it.modelId);
      on = i === 0;
      rows.appendChild(dom.el('div', {
        className: 'pao-list__item',
        style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
      }, [
        dom.el('span', {
          text: String(i + 1),
          style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)', fontFamily: 'var(--font-mono)', minWidth: '12px' }
        }),
        dom.el('span', {
          className: 'pao-mono',
          text: m ? String(m.name || m.id).toUpperCase() : String(it.modelId),
          style: { fontSize: 'var(--fs-small)', letterSpacing: 'var(--track)', color: on ? 'var(--text-1)' : 'var(--text-2)', minWidth: '68px' }
        }),
        meter(it.score, on ? 'var(--cyan)' : 'var(--muted)'),
        dom.el('span', {
          className: 'pao-mono', text: scoreText(it.score),
          style: { fontSize: 'var(--fs-micro)', color: on ? 'var(--cyan)' : 'var(--text-3)' }
        })
      ]));
    }
    box.appendChild(rows);
    return box;
  }

  function renderResult() {
    var box = st.refs.resultBox;
    if (!box) return;
    dom.clear(box);
    if (st.scanning) {
      box.appendChild(empty('正在比选 ' + st.models.length + ' 个模型…'));
      return;
    }
    if (!st.result) {
      box.appendChild(empty('尚未路由。选择任务类型后点击「开始路由」。'));
      return;
    }
    box.appendChild(resultCard(st.result));
    box.appendChild(alternativesBlock(st.result.taskId));
  }

  /* ---------- 11 · 路由日志 ---------- */
  function renderLog() {
    var box = st.refs.logBox;
    if (!box) return;
    dom.clear(box);
    if (!st.log.length) {
      box.appendChild(empty('尚无路由记录。完成一次路由后在此显示，最多保留 6 条。'));
      return;
    }
    for (var i = 0; i < st.log.length; i++) {
      var e = st.log[i];
      box.appendChild(dom.el('div', {
        className: 'pao-list__item',
        style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
      }, [
        dom.el('span', {
          className: 'pao-mono', text: clockOf(e.at),
          style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)' }
        }),
        dom.el('span', { text: e.taskZh, style: { fontSize: 'var(--fs-small)', color: 'var(--text-2)' } }),
        dom.el('span', { text: '→', style: { color: 'var(--text-5)', fontSize: 'var(--fs-small)' } }),
        dom.el('span', {
          className: 'pao-mono', text: e.model,
          style: { fontSize: 'var(--fs-small)', letterSpacing: 'var(--track)', color: 'var(--text-1)' }
        }),
        dom.el('span', {
          className: 'pao-mono', text: '得分 ' + e.score,
          style: { fontSize: 'var(--fs-micro)', color: 'var(--cyan)' }
        })
      ]));
    }
  }

  /* ---------- 12 · 路由模拟器 ---------- */
  function routingSection() {
    var sec = dom.el('section', { className: 'pao-section', dataset: { sec: 'routing' } });
    sec.appendChild(sectionHead('任务路由模拟器', '本地规则模拟'));

    st.refs.taskRow = dom.el('div', {
      className: 'pao-seg',
      style: { display: 'flex', gap: '6px', flexWrap: 'wrap' }
    });
    sec.appendChild(st.refs.taskRow);
    renderTasks();

    var ctrl = dom.el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' }
    });
    st.refs.routeBtn = dom.el('button', {
      type: 'button', className: 'pao-btn pao-btn--primary', dataset: { act: 'route' }
    }, [dom.icon('route', 14), dom.el('span', { text: '开始路由' })]);
    ctrl.appendChild(st.refs.routeBtn);
    st.refs.status = dom.el('span', { className: 'pao-section__hint', text: '就绪' });
    ctrl.appendChild(st.refs.status);
    sec.appendChild(ctrl);

    st.refs.resultBox = dom.el('div', { style: { marginTop: '10px' } });
    sec.appendChild(st.refs.resultBox);
    renderResult();

    sec.appendChild(sectionHead('路由日志', '最近 6 条', '14px'));
    st.refs.logBox = dom.el('div', { className: 'pao-list' });
    sec.appendChild(st.refs.logBox);
    renderLog();
    return sec;
  }

  function setBusy(busy) {
    if (!st.refs.routeBtn) return;
    st.refs.routeBtn.disabled = !!busy;
    st.refs.routeBtn.style.opacity = busy ? '0.6' : '';
    st.refs.routeBtn.style.cursor = busy ? 'progress' : 'pointer';
  }

  function toast(ctx, kind, title, text) {
    if (ctx && ctx.ui && ctx.ui.toast) ctx.ui.toast(kind, title, text);
  }

  function scanStep(ctx) {
    st.ticks++;
    st.scanIdx = (st.scanIdx + 1) % st.models.length;
    applyCardStates();
    if (st.ticks >= st.models.length * 2) finishRoute(ctx);
  }

  function startRoute(ctx) {
    if (!st.models.length) {
      toast(ctx, 'warn', '无法路由', '模型清单尚未载入（DATA.models）。');
      return;
    }
    if (st.scanning) return;
    st.scanning = true;
    st.scanIdx = -1;
    st.ticks = 0;
    st.result = null;
    applyCardStates();
    renderResult();
    renderStatus();
    setBusy(true);
    st.timer = setInterval(function () { scanStep(ctx); }, 140);
  }

  function finishRoute(ctx) {
    if (st.timer) {
      clearInterval(st.timer);
      st.timer = null;
    }
    st.scanning = false;
    st.scanIdx = -1;

    var list = resultsFor(st.task);
    var winner = list.length ? list[0] : null;
    if (!winner) {
      var best = st.models[0], i;
      for (i = 1; i < st.models.length; i++) {
        if ((Number(st.models[i].intelligence) || 0) > (Number(best.intelligence) || 0)) best = st.models[i];
      }
      winner = {
        modelId: best.id,
        score: 0.5,
        why: '示例结果缺失，按智能度默认选择。',
        estCost: null,
        estLatency: best.latencyMs
      };
    }

    st.result = {
      taskId: st.task,
      modelId: winner.modelId,
      score: winner.score,
      why: winner.why,
      estCost: winner.estCost,
      estLatency: winner.estLatency,
      rule: pickRule(st.task)
    };

    var m = modelById(st.result.modelId);
    var name = m ? String(m.name || m.id).toUpperCase() : String(st.result.modelId);

    st.log.unshift({
      at: new Date(),
      taskZh: taskLabel(st.task),
      model: name,
      score: scoreText(st.result.score)
    });
    if (st.log.length > 6) st.log.length = 6;

    applyCardStates();
    renderResult();
    renderLog();
    renderStatus();
    setBusy(false);

    /* 总线不可用或抛错时不得阻断面板交互 */
    if (PAO.bus && PAO.bus.emit) {
      try { PAO.bus.emit('model:route', { task: st.task, modelId: st.result.modelId }); } catch (err) { /* 忽略 */ }
    }
    toast(ctx, 'ok', '路由完成', name + ' · 置信 ' + scoreText(st.result.score) + '（模拟）');
  }

  function cancelScan() {
    if (st.timer) {
      clearInterval(st.timer);
      st.timer = null;
    }
    st.scanning = false;
    st.scanIdx = -1;
    st.ticks = 0;
    setBusy(false);
  }

  /* ---------- 13 · 路由规则列表 ---------- */
  function rulesSection() {
    var sec = dom.el('section', { className: 'pao-section', dataset: { sec: 'rules' } });
    sec.appendChild(sectionHead('路由规则', st.rules.length + ' 条 · 本地判定'));
    if (!st.rules.length) {
      sec.appendChild(empty('路由规则尚未载入（DATA.routing.rules）。'));
      return sec;
    }
    var list = dom.el('div', { className: 'pao-list' }), i, r;
    for (i = 0; i < st.rules.length; i++) {
      r = st.rules[i];
      list.appendChild(dom.el('div', {
        className: 'pao-list__item',
        style: { display: 'flex', flexDirection: 'column', gap: '3px' }
      }, [
        dom.el('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, [
          dom.el('span', {
            className: 'pao-mono', text: String(i + 1),
            style: { fontSize: 'var(--fs-micro)', color: 'var(--text-5)' }
          }),
          mono(r.cond || '—', 'var(--text-2)'),
          dom.el('span', { text: '→', style: { color: 'var(--text-5)' } }),
          mono(r.action || '—', 'var(--cyan)')
        ]),
        dom.el('span', { text: r.zh || '', style: { fontSize: 'var(--fs-small)', color: 'var(--text-3)', lineHeight: 'var(--lh-small)' } })
      ]));
    }
    sec.appendChild(list);
    return sec;
  }

  /* ---------- 14 · 页脚 ---------- */
  function footer() {
    return dom.el('footer', {
      style: { paddingTop: '10px', borderTop: '1px solid var(--line)', marginTop: '4px' }
    }, [
      dom.el('div', { className: 'pao-divider', style: { marginBottom: '8px' } }),
      dom.el('div', {
        text: '示例数据 · 路由决策由本地规则模拟，不代表真实模型调度',
        style: { fontSize: 'var(--fs-small)', color: 'var(--text-4)', letterSpacing: 'var(--track-cn)', lineHeight: 'var(--lh-small)' }
      })
    ]);
  }

  /* ---------- 15 · 重绘 ---------- */
  function paint(ctx) {
    if (!st.host) return;
    dom.clear(st.host);
    st.refs.cards = {};
    st.refs.flags = {};
    st.host.appendChild(manifestoSection());
    st.host.appendChild(modelsSection(ctx));
    st.host.appendChild(routingSection());
    st.host.appendChild(rulesSection());
    st.host.appendChild(footer());
    applyCardStates();
    renderStatus();
  }

  /* ---------- 16 · 事件委托 ---------- */
  function onHostClick(e) {
    var node = closestOf(e.target, '[data-act]', st.host);
    if (!node) return;
    var act = node.getAttribute('data-act');
    var ctx = st.ctx;

    if (act === 'model') {
      var mid = node.getAttribute('data-model');
      st.selected = (st.selected === mid) ? null : mid;
      applyCardStates();
      if (st.selected && ctx && ctx.scene && ctx.scene.highlightModel) {
        try { ctx.scene.highlightModel(st.selected); } catch (err) { /* 忽略 */ }
      }
      return;
    }

    if (act === 'task') {
      var tid = node.getAttribute('data-task');
      if (!tid) return;
      if (st.scanning) {
        cancelScan();
        renderResult();
      }
      st.task = tid;
      renderTasks();
      renderStatus();
      return;
    }

    if (act === 'route') {
      if (node.disabled) return;
      startRoute(ctx);
    }
  }

  /* ---------- 17 · 面板注册 ---------- */
  PAO.panels = PAO.panels || {};

  PAO.panels['model'] = {
    id: 'model',
    kicker: 'MODULE 05',
    label: 'MODEL GATEWAY',
    zh: '模型网关',
    tagline: 'MODELS ARE REPLACEABLE. PERSONAL MEMORY IS PORTABLE.',
    taglineZh: '模型可替换，个人记忆可迁移。',
    badge: '示例数据',

    render: function (root, ctx) {
      cancelScan();
      st.ctx = ctx;
      st.host = dom.el('div', {
        dataset: { pao: 'model' },
        style: { display: 'flex', flexDirection: 'column', gap: '16px', width: '100%' }
      });
      sync(ctx);
      root.appendChild(st.host);
      st.host.addEventListener('click', onHostClick);
      paint(ctx);
    },

    onEnter: function (ctx) { st.ctx = ctx || st.ctx; },

    onExit: function () {
      cancelScan();
      if (st.host) {
        st.host.removeEventListener('click', onHostClick);
        st.host = null;
      }
    }
  };
})(window.PAO = window.PAO || {});
