/* PERSONAL AI OS — MODULE 02 · 认知引擎（COGNITIVE ENGINE）
 * 归属：C · Panels-MC。只写本文件，不改他人文件。
 * 规范：ES5（var / function）、IIFE 包裹、不拼数据 innerHTML、颜色只取 CSS 变量、渲染幂等。
 * 数据契约见 docs/DATA-DICT.md：DATA.cognitive.summary / dimensions[7] / preferenceEdit。
 */
(function (PAO) {
  'use strict';

  PAO.panels = PAO.panels || {};
  var D = PAO.dom;

/* ===== 1. 常量 ===== */
  var IMPACT = {
    HIGH: { zh: '高', kind: 'crit' },
    MEDIUM: { zh: '中', kind: 'warn' },
    LOW: { zh: '低', kind: 'muted' }
  };

  /* 重算步骤 → 中文标题；步骤可能是字符串，也可能是对象 */
  var STEP_FALLBACK = ['读取当前偏好画像', '比对历史证据强度', '重算受影响维度', '写入认知草稿'];

/* ===== 2. 模块级状态（render 多次调用仍保持，onEnter 时恢复） ===== */
  var S = {
    open: {},        // 展开的维度 id → true
    prefTo: null,    // 输入框里的修正值
    applied: false,  // 是否已应用修正
    baseline: null,  // 实验前分值快照
    relearn: {},     // 待重新学习的维度 id → true
    rebuilding: false,
    prefBusy: false
  };

  var T = { chain: [] };     // 计时器句柄
  var offBus = null;

  /* 最近一次 render 的节点与重绘函数 */
  var V = {};

/* ===== 3. 基础工具 ===== */
  function isFn(f) { return typeof f === 'function'; }

  function el(tag, cls, kids, css) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (css) n.style.cssText = css;
    appendKids(n, kids);
    return n;
  }

  function appendKids(n, kids) {
    if (kids == null) return n;
    if (!Array.isArray(kids)) kids = [kids];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k == null || k === false) continue;
      if (typeof k === 'string' || typeof k === 'number') n.appendChild(document.createTextNode(String(k)));
      else if (k.nodeType) n.appendChild(k);
    }
    return n;
  }

  function tx(tag, cls, text, kids) {
    var n = el(tag, cls, kids);
    if (text != null) n.textContent = String(text);
    return n;
  }

  function nowIso() { return new Date().toISOString(); }
  function clamp01(v) { v = Number(v) || 0; return v < 0 ? 0 : v > 1 ? 1 : v; }

  function clrTimers() {
    for (var i = 0; i < T.chain.length; i++) clearTimeout(T.chain[i]);
    T.chain.length = 0;
  }

  function U(ctx) { return (ctx && ctx.ui) || PAO.ui || {}; }

  function toast(ctx, kind, title, text) {
    var u = U(ctx);
    if (u && isFn(u.toast)) {
      try { u.toast(kind, title, text); return; } catch (err) { /* 降级 */ }
    }
    fallbackToast(kind, title, text);
  }

  /* shell 的 toast 未就绪时兜底：任何点击都必有可见反馈 */
  function fallbackToast(kind, title, text) {
    var color = kind === 'ok' ? 'var(--ok)' : kind === 'warn' ? 'var(--warn)'
      : kind === 'crit' ? 'var(--crit)' : 'var(--cyan)';
    var host = document.getElementById('pao-toast-fallback');
    if (!host) {
      host = el('div', 'pao-toast-host');
      host.id = 'pao-toast-fallback';
      host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9998;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
      document.body.appendChild(host);
    }
    var card = el('div', 'pao-toast');
    card.style.cssText = 'background:var(--glass-2);border:1px solid var(--line);border-radius:var(--r-m);padding:10px 12px;min-width:180px;max-width:320px;';
    var t = tx('div', 'pao-toast__title', title);
    t.style.cssText = 'color:' + color + ';font-size:13px;line-height:1.5;';
    card.appendChild(t);
    if (text) card.appendChild(tx('div', 'pao-toast__text', text));
    host.appendChild(card);
    setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 2600);
  }

/* ===== 4. 数据访问（全部做存在性保护） ===== */
  function ctxData(ctx) { return (ctx && ctx.data) || PAO.DATA || {}; }
  function cogData(ctx) { return ctxData(ctx).cognitive || {}; }
  function dimsList(ctx) { return cogData(ctx).dimensions || []; }
  function summary(ctx) { return cogData(ctx).summary || {}; }
  function prefEdit(ctx) { return cogData(ctx).preferenceEdit || {}; }

  function findMem(ctx, id) {
    var arr = ctxData(ctx).memories || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  function findDim(ctx, id) {
    var arr = dimsList(ctx);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id || arr[i].zh === id) return arr[i];
    }
    return null;
  }

  /* 冲突条目可能是记忆 id、对象或纯文本，统一成可读一行 */
  function conflictText(ctx, c) {
    if (c == null) return '未命名冲突';
    if (typeof c === 'string') {
      var m = findMem(ctx, c);
      return m ? m.title : c;
    }
    var id = c.memoryId || c.memId || c.id;
    var mm = id ? findMem(ctx, id) : null;
    var base = mm ? mm.title : (c.title || c.zh || c.text || id || '未命名冲突');
    var note = c.note || c.desc || '';
    return note ? base + ' · ' + note : base;
  }

  function stepText(s) {
    if (s == null) return '处理中';
    if (typeof s === 'string') return s;
    return s.zh || s.label || s.text || s.name || s.title || s.t || '处理中';
  }

  function impactOf(a) {
    var raw = String((a && (a.impact || a.level)) || '').toUpperCase();
    return IMPACT[raw] || IMPACT.MEDIUM;
  }

  function affectedDimId(a) {
    return (a && (a.dim || a.dimension || a.id)) || '';
  }

/* ===== 5. 结构原语 ===== */
  function sec(title, hint) {
    var head = el('div', 'pao-section__head');
    head.appendChild(tx('div', 'pao-section__title', title));
    var hintEl = tx('div', 'pao-section__hint', hint || '');
    head.appendChild(hintEl);
    var body = el('div', null, null, 'display:grid;gap:9px;margin-top:9px;');
    var wrap = el('div', 'pao-section', [head, body]);
    return { wrap: wrap, body: body, hint: hintEl };
  }

  function kv(label, valueNode) {
    var v = el('div', 'pao-kv__v');
    if (valueNode && valueNode.nodeType) v.appendChild(valueNode);
    else if (valueNode != null) v.textContent = String(valueNode);
    return el('div', 'pao-kv', [tx('div', 'pao-kv__k', label), v]);
  }

  function btn(label, cls, iconName, fn) {
    var b = D.el('button', { type: 'button', className: cls });
    if (iconName) b.appendChild(D.icon(iconName, 14));
    b.appendChild(tx('span', null, label));
    b.addEventListener('click', function (ev) { ev.preventDefault(); fn(); });
    return b;
  }

  function meter(value, color) {
    var m = el('div', 'pao-meter');
    var f = el('i', 'pao-meter__fill');
    f.style.cssText = 'transform:scaleX(' + clamp01(value) + ');' + (color ? 'background:' + color + ';' : '');
    m.appendChild(f);
    return m;
  }

  function scoreColor(v) {
    v = Number(v) || 0;
    if (v >= 0.75) return 'var(--ok)';
    if (v >= 0.55) return 'var(--cyan)';
    if (v >= 0.35) return 'var(--warn)';
    return 'var(--crit)';
  }

/* ===== 6. 主渲染 ===== */
  function render(root, ctx) {
    if (ctx && ctx.dom) D = ctx.dom;

    clrTimers();
    D.clear(root);
    S.rebuilding = false;
    S.prefBusy = false;

    var bus = ctx && ctx.bus;

    /* ---- 指标区 ---- */
    var sum = summary(ctx);
    var metrics = sec('认知概览', '本地规则模拟 · 非真实模型输出');
    var grid = el('div', 'pao-grid-3');
    grid.appendChild(ringCard('上下文覆盖度', clamp01(sum.contextCoverage),
      D.fmt.pct(sum.contextCoverage || 0), 'var(--cyan)'));
    grid.appendChild(ringCard('推断健康度', clamp01(sum.inferenceHealth),
      D.fmt.pct(sum.inferenceHealth || 0),
      (Number(sum.inferenceHealth) || 0) >= 0.7 ? 'var(--ok)' : 'var(--warn)'));
    var cc = Number(sum.conflictCount) || 0;
    grid.appendChild(ringCard('冲突条目', Math.min(1, cc / 8), D.fmt.num(cc) + ' 条',
      cc > 0 ? 'var(--warn)' : 'var(--ok)'));
    metrics.body.appendChild(grid);

    var stamp = tx('div', 'pao-section__hint', '');
    metrics.body.appendChild(stamp);

    var rebuildRow = el('div', null, null, 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;');
    var rebuildBtn = btn('认知重建', 'pao-btn pao-btn--primary', 'refresh', function () {
      doRebuild();
    });
    var rebuildLabel = rebuildBtn.lastChild;
    rebuildRow.appendChild(rebuildBtn);
    var rebuildText = tx('span', 'pao-section__hint', '将依次重算 7 个维度 · 约 1.6 秒');
    rebuildRow.appendChild(rebuildText);
    metrics.body.appendChild(rebuildRow);

    var rebuildBar = el('div', 'pao-meter');
    var rebuildFill = el('i', 'pao-meter__fill');
    rebuildFill.style.cssText = 'transform:scaleX(0);';
    rebuildBar.appendChild(rebuildFill);
    metrics.body.appendChild(rebuildBar);

    root.appendChild(metrics.wrap);

    /* ---- 七维列表 ---- */
    var dims = sec('认知维度', '共 ' + D.fmt.num(dimsList(ctx).length) + ' 维 · 点击任意维度展开推断链');
    var dimsHost = el('div', null, null, 'display:grid;gap:8px;');
    dims.body.appendChild(dimsHost);
    root.appendChild(dims.wrap);

    /* ---- 偏好修正实验 ---- */
    var pref = prefEdit(ctx);
    var prefSec = sec('偏好修正实验 · 观察认知如何重算',
      '字段：' + (pref.field || '偏好画像') + ' · 本地推导');
    var fromRow = el('div', null, null, 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;');
    fromRow.appendChild(tx('span', 'pao-section__hint', '原值'));
    fromRow.appendChild(tx('span', 'pao-tag pao-tag--fact', pref.from || '—'));
    fromRow.appendChild(D.icon('chevron', 14));
    var prefInput = D.el('input', {
      type: 'text',
      className: 'pao-input',
      'aria-label': '修正后的偏好值',
      placeholder: '输入新的偏好值'
    });
    prefInput.value = S.prefTo != null ? S.prefTo : (pref.to || '');
    prefInput.style.cssText = 'flex:1 1 200px;min-width:150px;background:var(--bg-1);color:var(--white);' +
      'border:1px solid var(--line);border-radius:var(--r-s);padding:7px 9px;' +
      'font-family:var(--font-ui);font-size:13px;';
    fromRow.appendChild(prefInput);
    prefSec.body.appendChild(fromRow);

    var prefActs = el('div', null, null, 'display:flex;flex-wrap:wrap;gap:8px;');
    prefActs.appendChild(btn('应用修正', 'pao-btn pao-btn--primary', 'check', function () {
      applyPref();
    }));
    prefActs.appendChild(btn('恢复原值', 'pao-btn pao-btn--ghost', 'refresh', function () {
      restorePref();
    }));
    prefSec.body.appendChild(prefActs);

    var stepsHost = el('div', null, null, 'display:grid;gap:6px;');
    prefSec.body.appendChild(stepsHost);
    var stepsHint = tx('div', 'pao-section__hint', '每步 400 毫秒，模拟像素级重算过程。');
    prefSec.body.appendChild(stepsHint);
    var affectedHost = el('div', null, null, 'display:grid;gap:6px;');
    prefSec.body.appendChild(affectedHost);

    root.appendChild(prefSec.wrap);

    /* ---- 底部声明 ---- */
    var foot = el('div', null, null, 'margin-top:16px;display:grid;gap:4px;');
    foot.appendChild(el('div', 'pao-divider'));
    foot.appendChild(tx('div', 'pao-section__hint', '本地推导 · 认知结论由本地规则基于真实记忆库计算生成'));
    root.appendChild(foot);

    /* ---- 节点引用 ---- */
    V = {
      root: root, ctx: ctx,
      stamp: stamp,
      rebuildBtn: rebuildBtn, rebuildLabel: rebuildLabel,
      rebuildText: rebuildText, rebuildFill: rebuildFill, rebuildBar: rebuildBar,
      dimsHost: dimsHost, stepsHost: stepsHost, stepsHint: stepsHint,
      affectedHost: affectedHost, prefInput: prefInput,
      dimEls: [], stepEls: [],
      drawDims: null, drawAffected: null, drawStamp: null
    };
    rebuildBtn.setAttribute('data-role', 'rebuild');

/* ===== 7. 片段构建 ===== */
    function ringCard(label, value, display, color) {
      var card = el('div', 'pao-metric');
      card.style.cssText = 'align-items:center;gap:4px;padding:8px 4px;' +
        'border:1px solid var(--line);border-radius:var(--r-s);';
      card.appendChild(D.ring(value, { size: 58, color: color }));
      var num = tx('div', 'pao-metric__v', display);
      num.style.cssText = 'font-size:15px;color:' + color + ';';
      card.appendChild(num);
      card.appendChild(tx('div', 'pao-metric__k', label));
      return card;
    }

    function miniKv(label, node) {
      var row = el('div', null, null,
        'display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:center;');
      row.appendChild(tx('span', 'pao-section__hint', label));
      row.appendChild(node);
      return row;
    }

    function bioBlock(label, text) {
      var b = el('div', null, null,
        'display:grid;gap:2px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-s);');
      b.appendChild(tx('div', 'pao-kv__k', label));
      var t = tx('div', null, text || '（本维度暂无内容）');
      t.style.cssText = 'color:var(--white);line-height:1.7;';
      b.appendChild(t);
      return b;
    }

    function evidenceBlock(dim) {
      var ids = dim.evidence || [];
      var box = el('div', null, null, 'display:grid;gap:5px;');
      box.appendChild(tx('div', 'pao-kv__k', '支撑记忆（' + D.fmt.num(ids.length) + ' 条）'));
      if (!ids.length) {
        box.appendChild(tx('div', 'pao-section__hint', '暂无支撑记忆，该维度主要由规则外推。'));
        return box;
      }
      var wrap = el('div', null, null, 'display:flex;flex-wrap:wrap;gap:6px;');
      for (var i = 0; i < ids.length; i++) {
        (function (id) {
          var m = findMem(ctx, id);
          var chip = D.el('button', {
            type: 'button',
            className: 'pao-chip',
            text: m ? m.title : id
          });
          chip.setAttribute('title', id + (m ? ' · ' + (m.categoryZh || m.category || '') : ''));
          chip.addEventListener('click', function (ev) {
            ev.preventDefault();
            if (bus && isFn(bus.emit)) bus.emit('memory:select', { id: id });
            if (ctx && ctx.scene && isFn(ctx.scene.selectMemory)) {
              try { ctx.scene.selectMemory(id); } catch (e1) {}
            }
            if (ctx && isFn(ctx.go)) ctx.go('memory');
          });
          wrap.appendChild(chip);
        })(ids[i]);
      }
      box.appendChild(wrap);
      return box;
    }

    function conflictBlock(dim) {
      var list = dim.conflicts || [];
      var box = el('div', null, null,
        'display:grid;gap:5px;padding:9px 10px;border:1px solid var(--warn);border-radius:var(--r-s);');
      var head = el('div', null, null, 'display:flex;align-items:center;gap:6px;');
      var ic = D.icon('warning', 15);
      ic.style.cssText = 'color:var(--warn);';
      head.appendChild(ic);
      var ht = tx('span', null, '与以下记忆存在张力（' + D.fmt.num(list.length) + ' 条）');
      ht.style.cssText = 'color:var(--warn);';
      head.appendChild(ht);
      box.appendChild(head);
      for (var i = 0; i < list.length; i++) {
        box.appendChild(tx('div', 'pao-section__hint', '· ' + conflictText(ctx, list[i])));
      }
      return box;
    }

    function factorsBlock(dim) {
      var fs = dim.factors || [];
      var box = el('div', null, null, 'display:grid;gap:5px;');
      box.appendChild(tx('div', 'pao-kv__k', '影响因子'));
      if (!fs.length) {
        box.appendChild(tx('div', 'pao-section__hint', '本维度未注册影响因子。'));
        return box;
      }
      for (var i = 0; i < fs.length; i++) {
        var f = fs[i] || {};
        var key = f.k || f.label || f.name || ('因子 ' + (i + 1));
        if (typeof f.v === 'number') {
          box.appendChild(miniKv(key, meter(f.v, 'var(--cyan)')));
        } else {
          box.appendChild(miniKv(key, tx('span', null, f.v == null ? '—' : String(f.v))));
        }
      }
      return box;
    }

    function confBlock(dim) {
      return tx('div', 'pao-section__hint', confExplain(dim));
    }

    function confExplain(dim) {
      var n = (dim.evidence || []).length;
      var c = (dim.conflicts || []).length;
      var score = Number(dim.score) || 0;
      var conf = Number(dim.confidence) || 0;
      var gap = Math.abs(score - conf);
      var lvl = conf >= 0.8 ? '高' : conf >= 0.6 ? '中' : '偏低';
      var s = '置信度 ' + D.fmt.pct(conf) + '（' + lvl + '）：由 ' + n + ' 条支撑记忆拟合';
      s += c ? '，同时有 ' + c + ' 条记忆与之张力，拉低了可信度。' : '，当前未发现相互冲突的条目。';
      s += gap > 0.18
        ? ' 结论强度与置信度相差 ' + D.fmt.pct(gap) + '，建议补充证据后重算。'
        : ' 结论强度与置信度基本吻合。';
      s += '（本地规则模拟，非真实模型输出）';
      return s;
    }

/* ===== 8. 维度列表 ===== */
    function dimRow(dim, idx) {
      var open = !!S.open[dim.id];
      var conflicts = dim.conflicts || [];
      var item = el('div', 'pao-list__item' + (open ? ' is-active' : ''));
      item.setAttribute('data-dim-id', dim.id);
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');

      var main = el('div', 'pao-list__main');
      var nameWrap = el('div', null, null,
        'display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;');
      nameWrap.appendChild(tx('span', 'pao-list__title', dim.zh || dim.id));
      if (conflicts.length) {
        var warn = D.icon('warning', 13);
        warn.style.cssText = 'color:var(--warn);';
        warn.setAttribute('title', conflicts.length + ' 条冲突');
        nameWrap.appendChild(warn);
      }
      if (S.relearn[dim.id]) nameWrap.appendChild(tx('span', 'pao-tag pao-tag--inference', '待重新学习'));
      main.appendChild(nameWrap);
      main.appendChild(tx('div', 'pao-list__meta',
        (dim.name || '未知维度') + ' · 置信 ' + D.fmt.pct(dim.confidence)));

      var mrow = el('div', null, null, 'display:flex;align-items:center;gap:8px;margin-top:3px;');
      var bar = meter(dim.score, scoreColor(dim.score));
      bar.style.cssText = 'flex:1 1 auto;';
      mrow.appendChild(bar);
      var sc = tx('span', 'pao-mono', D.fmt.pct(dim.score));
      sc.style.cssText = 'color:' + scoreColor(dim.score) + ';flex:none;';
      mrow.appendChild(sc);
      main.appendChild(mrow);
      item.appendChild(main);

      var aside = el('div', 'pao-list__aside');
      aside.appendChild(D.icon('chevron', 14));
      item.appendChild(aside);

      item.addEventListener('click', function () {
        if (S.open[dim.id]) delete S.open[dim.id];
        else S.open[dim.id] = true;
        drawDims();
      });
      item.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        if (S.open[dim.id]) delete S.open[dim.id];
        else S.open[dim.id] = true;
        drawDims();
      });

      return item;
    }

    function dimDetail(dim) {
      var conflicts = dim.conflicts || [];
      var body = el('div', null, null,
        'display:grid;gap:8px;margin:0 0 4px 14px;padding:10px 0 2px 12px;' +
        'border-left:1px solid var(--line);');
      body.appendChild(bioBlock('结论摘要', dim.summary));
      body.appendChild(bioBlock('推断依据', dim.inference));
      body.appendChild(evidenceBlock(dim));
      if (conflicts.length) body.appendChild(conflictBlock(dim));
      body.appendChild(factorsBlock(dim));
      body.appendChild(confBlock(dim));
      body.appendChild(tx('div', 'pao-section__hint', '最后更新 ' + D.fmt.time(dim.updatedAt) +
        ' · ' + D.fmt.ago(dim.updatedAt)));
      return body;
    }

    function drawDims() {
      D.clear(dimsHost);
      var arr = dimsList(ctx);
      V.dimEls = [];
      if (!arr.length) {
        var dempty = el('div', 'pao-empty');
        dempty.appendChild(tx('div', 'pao-empty__title', '认知维度尚未载入'));
        dempty.appendChild(tx('div', 'pao-empty__text', '数据加载后会自动显示七个维度。'));
        dimsHost.appendChild(dempty);
        return;
      }
      for (var i = 0; i < arr.length; i++) {
        var row = dimRow(arr[i], i);
        V.dimEls.push(row);
        dimsHost.appendChild(row);
        if (S.open[arr[i].id]) dimsHost.appendChild(dimDetail(arr[i]));
      }
    }

/* ===== 9. 重建动画（1.6 秒，逐维点亮） ===== */
    function drawStamp() {
      var s = summary(ctx);
      stamp.textContent = '上次重建 ' + D.fmt.time(s.lastRebuild) + ' · ' + D.fmt.ago(s.lastRebuild) +
        ' · 本地推导';
    }

    function doRebuild() {
      if (S.rebuilding) {
        toast(ctx, 'info', '正在重建中', '请等待本次模拟重建结束。');
        return;
      }
      S.rebuilding = true;
      rebuildBtn.disabled = true;
      rebuildLabel.textContent = '正在重建认知模型…';
      rebuildText.textContent = '0 / 7 维度';
      rebuildFill.style.transform = 'scaleX(0)';
      rebuildBar.style.cssText = 'margin-top:2px;';

      var arr = dimsList(ctx);
      var n = arr.length || 7;
      var per = Math.floor(1600 / n);

      for (var k = 0; k < n; k++) {
        (function (kk) {
          T.chain.push(setTimeout(function () {
            var row = V.dimEls[kk];
            if (row) row.classList.add('is-active');
            rebuildText.textContent = (kk + 1) + ' / ' + n + ' 维度';
            rebuildFill.style.transform = 'scaleX(' + ((kk + 1) / n) + ')';
          }, kk * per));
        })(k);
      }

      T.chain.push(setTimeout(function () {
        var cog = cogData(ctx);
        var t = nowIso();
        if (cog.summary) cog.summary.lastRebuild = t;
        var list = dimsList(ctx);
        for (var j = 0; j < list.length; j++) list[j].updatedAt = t;
        S.rebuilding = false;
        rebuildBtn.disabled = false;
        rebuildLabel.textContent = '认知重建';
        rebuildFill.style.transform = 'scaleX(1)';
        rebuildText.textContent = '重建完成 · ' + D.fmt.time(t);
        drawStamp();
        drawDims();
        toast(ctx, 'ok', '认知模型已重建（模拟）',
          '7 个维度按本地规则重新打分，未调用任何模型服务。');
      }, 1600));
    }

/* ===== 10. 偏好修正实验 ===== */
    function renderSteps(steps) {
      D.clear(stepsHost);
      V.stepEls = [];
      if (!steps.length) {
        stepsHint.textContent = '每步 400 毫秒，模拟像素级重算过程。';
        return;
      }
      var box = el('div', 'pao-steps');
      for (var i = 0; i < steps.length; i++) {
        var s = tx('div', 'pao-step is-pending', stepText(steps[i]));
        V.stepEls.push(s);
        box.appendChild(s);
      }
      stepsHost.appendChild(box);
      stepsHint.textContent = '重算中 · 共 ' + D.fmt.num(steps.length) + ' 步';
    }

    function markStep(i, state) {
      var node = V.stepEls[i];
      if (!node) return;
      node.className = 'pao-step is-' + state;
    }

    function currentSteps() {
      var pe = prefEdit(ctx);
      var steps = pe.recomputeSteps || [];
      return steps.length ? steps : STEP_FALLBACK;
    }

    function applyPref() {
      if (S.prefBusy) {
        toast(ctx, 'info', '正在重算中', '请等待当前重算队列结束。');
        return;
      }
      var val = String(prefInput.value || '').trim();
      if (!val) {
        toast(ctx, 'warn', '请先填写修正值', '留空无法应用偏好修正。');
        return;
      }
      S.prefTo = val;
      S.prefBusy = true;
      var steps = currentSteps();
      renderSteps(steps);

      var idx = 0;
      function tick() {
        if (idx > 0) markStep(idx - 1, 'done');
        if (idx < steps.length) {
          markStep(idx, 'running');
          idx++;
          T.chain.push(setTimeout(tick, 400));
        } else {
          finishPref(steps);
        }
      }
      tick();
    }

    function finishPref(steps) {
      S.prefBusy = false;
      var pe = prefEdit(ctx);
      var affected = pe.affected || [];
      var arr = dimsList(ctx);
      if (!S.baseline) S.baseline = {};
      var touched = [];
      for (var i = 0; i < affected.length; i++) {
        var id = affectedDimId(affected[i]);
        var dim = findDim(ctx, id);
        if (!dim) continue;
        if (S.baseline[dim.id] == null) S.baseline[dim.id] = Number(dim.score) || 0;
        var next = (Number(dim.score) || 0) - 0.03;
        dim.score = Math.max(0, Math.round(next * 1000) / 1000);
        dim.updatedAt = nowIso();
        S.relearn[dim.id] = true;
        touched.push(dim);
      }
      S.applied = true;
      stepsHint.textContent = '完成 ' + D.fmt.num(steps.length) + ' 步 · ' +
        D.fmt.num(touched.length) + ' 个维度已进入重算队列';
      drawDims();
      drawAffected();
      toast(ctx, 'ok',
        '偏好已更新，' + D.fmt.num(affected.length) + ' 个认知维度已进入重算队列（模拟）',
        '仅改变页面内存中的分值，未调用外部模型服务。');
    }

    function restorePref() {
      if (!S.applied) {
        toast(ctx, 'info', '尚未应用修正', '先应用一次修正，再恢复原值。');
        return;
      }
      var arr = dimsList(ctx);
      for (var i = 0; i < arr.length; i++) {
        var base = S.baseline ? S.baseline[arr[i].id] : null;
        if (base != null) {
          arr[i].score = base;
          arr[i].updatedAt = nowIso();
        }
      }
      S.relearn = {};
      S.baseline = null;
      S.applied = false;
      S.prefTo = null;
      var pe = prefEdit(ctx);
      prefInput.value = pe.to || pe.from || '';
      renderSteps([]);
      drawDims();
      drawAffected();
      toast(ctx, 'ok', '已恢复原值（模拟）', '受影响的维度分值回到实验前状态。');
    }

    function drawAffected() {
      D.clear(affectedHost);
      if (!S.applied) {
        affectedHost.appendChild(tx('div', 'pao-section__hint',
          '应用修正后，这里会列出受影响的维度与影响强度。'));
        return;
      }
      var pe = prefEdit(ctx);
      var affected = pe.affected || [];
      affectedHost.appendChild(tx('div', 'pao-kv__k',
        '受影响维度（' + D.fmt.num(affected.length) + ' 条）'));
      for (var i = 0; i < affected.length; i++) {
        (function (a) {
          var imp = impactOf(a);
          var dim = findDim(ctx, affectedDimId(a));
          var row = el('div', 'pao-list__item pao-list__item--static');
          var left = el('div', 'pao-list__main');
          var title = el('div', null, null, 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;');
          title.appendChild(tx('span', 'pao-list__title', dim ? (dim.zh || dim.id) : affectedDimId(a)));
          title.appendChild(D.badge(imp.zh + ' · ' + String((a && (a.impact || a.level)) || 'MEDIUM'),
            imp.kind));
          left.appendChild(title);
          if (a && a.note) left.appendChild(tx('div', 'pao-list__meta', a.note));
          if (dim) {
            left.appendChild(tx('div', 'pao-list__meta',
              '当前分值 ' + D.fmt.pct(dim.score) + ' · 已标注「待重新学习」'));
          }
          row.appendChild(left);

          var aside = el('div', 'pao-list__aside');
          aside.appendChild(tx('span', 'pao-mono', '−0.03'));
          row.appendChild(aside);
          affectedHost.appendChild(row);
        })(affected[i]);
      }
    }

    /* 暴露给生命周期 */
    V.drawDims = drawDims;
    V.drawAffected = drawAffected;
    V.drawStamp = drawStamp;

    /* 首次绘制 */
    drawStamp();
    drawDims();
    drawAffected();
  }

/* ===== 11. 注册 ===== */
  PAO.panels['cognitive'] = {
    id: 'cognitive',
    kicker: 'MODULE 02',
    label: 'COGNITIVE ENGINE',
    zh: '认知引擎',
    tagline: 'NOT DATA. UNDERSTANDING.',
    taglineZh: '不只是数据，而是理解。',
    badge: '本地推导',

    render: function (root, ctx) { render(root, ctx); },

    onEnter: function (ctx) {
      /* 恢复闭包状态：展开项、实验输入值 */
      if (V.prefInput && S.prefTo != null && V.prefInput.value !== S.prefTo) {
        V.prefInput.value = S.prefTo;
      }
      if (V.drawStamp) V.drawStamp();
      if (V.drawDims) V.drawDims();
      if (V.drawAffected) V.drawAffected();
      void ctx;
    },

    onExit: function (ctx) {
      clrTimers();
      S.rebuilding = false;
      S.prefBusy = false;
      if (offBus) { try { offBus(); } catch (e2) {} offBus = null; }
      void ctx;
    }
  };
})(window.PAO = window.PAO || {});
