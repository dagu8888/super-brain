/* PERSONAL AI OS — 知识图谱面板
   把 Obsidian vault 的图谱统计、目录分布、枢纽节点与单篇详情呈现出来。 */
(function (PAO) {
  'use strict';

  PAO.panels = PAO.panels || {};
  var D = PAO.dom;
  var el = D.el;

  var state = { stats: null, summary: null, selected: null, loading: false, source: 'local' };

  PAO.panels['graph'] = {
    id: 'graph', kicker: 'KNOWLEDGE GRAPH', label: 'KNOWLEDGE GRAPH', zh: '知识图谱',
    tagline: 'YOUR NOTES. AS A LIVING NETWORK.', taglineZh: '笔记不是文件夹，是一张网。',
    badge: '本地 Obsidian',

    render: function (root, ctx) {
      D.clear(root);
      var wrap = el('div', { className: 'pao-graph' });
      root.appendChild(wrap);

      var head = el('div', { className: 'pao-graph__head' });
      var body = el('div', { className: 'pao-graph__body' });
      wrap.appendChild(head);
      wrap.appendChild(body);

      function renderAll() {
        D.clear(head);
        D.clear(body);
        /* 面板徽标随数据源切换（静态属性 + 已渲染 DOM 同步更新） */
        PAO.panels['graph'].badge = state.source === 'cloud' ? '云脑 · 超级大脑' : '本地 Obsidian';
        var badgeEl = document.querySelector('#pao-panel .pao-badge');
        if (badgeEl) badgeEl.textContent = PAO.panels['graph'].badge;

        /* 顶部：数据源切换 + 重新加载 */
        var isCloud = state.source === 'cloud';
        head.appendChild(el('div', { className: 'pao-stage-note' }, [
          D.icon('memory', 13),
          el('span', { text: isCloud
            ? '正在读取云脑（超级大脑）知识库，数据来自 8.218.106.225 实时接口。'
            : '正在读取本地 Obsidian 库。所有数据留在本机，不上传。' })
        ]));

        /* 数据源切换：本地 vault / 云脑 */
        var srcRow = el('div', { className: 'pao-graph__sources' });
        [['local', '本地 Obsidian'], ['cloud', '云脑 · 超级大脑']].forEach(function (pair) {
          var key = pair[0];
          var btn = el('button', {
            className: 'pao-btn pao-btn--ghost' + (state.source === key ? ' is-active' : ''),
            attrs: { type: 'button' }
          }, [el('span', { text: pair[1] })]);
          btn.addEventListener('click', function () {
            if (state.source === key) return;
            state.source = key;
            state.summary = null;
            state.selected = null;
            state.error = null;
            renderAll();
            load();
            PAO.scene.loadGraph(key);
          });
          srcRow.appendChild(btn);
        });
        head.appendChild(srcRow);

        var reload = el('button', {
          className: 'pao-btn pao-btn--ghost pao-btn--block', attrs: { type: 'button' }
        }, [D.icon('refresh', 13), el('span', { text: isCloud ? '重新拉取云脑图谱' : '重新扫描本地库' })]);
        reload.addEventListener('click', function () {
          PAO.scene._graphLoaded = false;
          PAO.scene._graphSource = null;
          state.stats = null;
          load();
          PAO.scene.loadGraph(state.source);
        });
        head.appendChild(reload);

        if (state.loading) {
          body.appendChild(el('div', { className: 'pao-empty' }, [
            el('div', { className: 'pao-empty__title', text: '正在解析知识图谱…' }),
            el('div', { className: 'pao-empty__hint', text: isCloud ? '连接云脑接口、拉取知识条目、构建关系网络' : '扫描笔记、解析 wikilink、构建关系网络' })
          ]));
          return;
        }

        if (!state.summary) {
          body.appendChild(el('div', { className: 'pao-empty' }, [
            el('div', { className: 'pao-empty__title', text: '尚未加载图谱' }),
            el('div', { className: 'pao-empty__hint', text: isCloud ? '点上方「重新拉取云脑图谱」开始。' : '点上方「重新扫描本地库」开始。' })
          ]));
          return;
        }

        var s = state.summary.stats || {};

        /* 统计四格 */
        if (state.source === 'cloud') {
          body.appendChild(el('div', { className: 'pao-graph__stats' }, [
            statCard('知识条目', s.notes, '云脑节点'),
            statCard('关系', s.edges, s.tagEdges + ' 条标签共现'),
            statCard('分类', Object.keys(state.summary.folders || {}).length, '个 category'),
            statCard('连通块', s.components, '最大 ' + s.largestComponent + ' 篇')
          ]));
        } else {
          body.appendChild(el('div', { className: 'pao-graph__stats' }, [
            statCard('笔记', s.notes, '节点'),
            statCard('关系', s.edges, s.linkEdges + ' 链接 + ' + s.tagEdges + ' 标签'),
            statCard('链接解析率', (s.linkResolveRate || 0) + '%', s.brokenLinks + ' 条未匹配'),
            statCard('连通块', s.components, '最大 ' + s.largestComponent + ' 篇')
          ]));
        }

        /* 目录分布 */
        var folders = state.summary.folders || {};
        var fKeys = Object.keys(folders).sort(function (a, b) { return folders[b] - folders[a]; });
        var maxF = Math.max.apply(null, fKeys.map(function (k) { return folders[k]; }).concat([1]));

        if (fKeys.length) {
          var sec = section('目录分布', fKeys.length + ' 个目录');
          fKeys.forEach(function (k) {
            var pct = Math.round((folders[k] / maxF) * 100);
            var row = el('div', { className: 'pao-graph__bar-row' }, [
              el('span', { className: 'pao-graph__bar-label', text: k }),
              el('span', { className: 'pao-graph__bar' }, [el('i', { style: { width: pct + '%' } })]),
              el('span', { className: 'pao-graph__bar-num', text: String(folders[k]) })
            ]);
            sec.body.appendChild(row);
          });
          body.appendChild(sec.el);
        }

        /* 高频标签 */
        var tags = state.summary.hubTags || [];
        if (tags.length) {
          var tagSec = section('高频标签', tags.length + ' 个');
          var tagWrap = el('div', { className: 'pao-graph__tags' });
          tags.forEach(function (t) {
            tagWrap.appendChild(el('button', {
              className: 'pao-chip', attrs: { type: 'button' }, text: '#' + t.tag + ' · ' + t.count
            }));
          });
          tagSec.body.appendChild(tagWrap);
          body.appendChild(tagSec.el);
        }

        /* 枢纽节点 */
        var top = state.summary.topNodes || [];
        if (top.length) {
          var topSec = section('枢纽节点', '度数最高');
          top.forEach(function (n) {
            var isIndex = /^(all-memories|00-总览|Index|Memory Home)$/i.test(n.title);
            var row = el('button', {
              className: 'pao-graph__node' + (isIndex ? ' is-index' : ''),
              attrs: { type: 'button' }
            }, [
              el('span', { className: 'pao-graph__deg', text: String(n.degree) }),
              el('span', { className: 'pao-graph__node-main' }, [
                el('span', { className: 'pao-graph__title', text: n.title }),
                el('span', { className: 'pao-graph__meta', text: n.folder + ' · 入链 ' + n.inLinks })
              ])
            ]);
            row.addEventListener('click', function () {
              PAO.bus.emit('graph:focus-request', { title: n.title });
            });
            topSec.body.appendChild(row);
          });
          topSec.body.appendChild(el('div', { className: 'pao-section__hint', text: '索引页（all-memories 等）会链向全库，三维视图里已淡化处理。' }));
          body.appendChild(topSec.el);
        }

        /* 选中笔记详情 */
        if (state.selected && state.selected.node) {
          var nd = state.selected;
          var dSec = section(nd.node.title, nd.node.folder);
          dSec.body.appendChild(el('div', { className: 'pao-kv' }, [
            el('span', { className: 'pao-kv__k', text: '度数' }),
            el('span', { className: 'pao-kv__v', text: nd.node.degree + '（入 ' + nd.node.inLinks + ' / 出 ' + nd.node.outLinks + '）' })
          ]));
          if (nd.node.tags && nd.node.tags.length) {
            dSec.body.appendChild(el('div', { className: 'pao-kv' }, [
              el('span', { className: 'pao-kv__k', text: '标签' }),
              el('span', { className: 'pao-kv__v', text: nd.node.tags.join(' · ') })
            ]));
          }
          if (nd.inbound && nd.inbound.length) {
            dSec.body.appendChild(el('div', { className: 'pao-graph__rel-title', text: '被引用（' + nd.inbound.length + '）' }));
            nd.inbound.slice(0, 6).forEach(function (r) {
              dSec.body.appendChild(el('div', { className: 'pao-graph__rel' }, [el('span', { text: r.title })]));
            });
          }
          if (nd.outbound && nd.outbound.length) {
            dSec.body.appendChild(el('div', { className: 'pao-graph__rel-title', text: '引用（' + nd.outbound.length + '）' }));
            nd.outbound.slice(0, 6).forEach(function (r) {
              dSec.body.appendChild(el('div', { className: 'pao-graph__rel' }, [el('span', { text: r.title })]));
            });
          }
          body.appendChild(dSec.el);
        }

        body.appendChild(el('div', { className: 'pao-disclosure' }, [
          el('div', { className: 'pao-disclosure__title', text: '数据来源' }),
          el('p', { className: 'pao-disclosure__text', text: state.source === 'cloud'
            ? '节点 = 云脑知识库条目（10-Knowledge/Conceps/Decisions/Playbooks），边 = 共享标签。数据经 /api/knowledge 实时拉取，60 秒缓存。'
            : '节点 = Markdown 笔记，边 = wikilink（强）+ 共享标签（弱）。文件名形如「标题-mem_时间戳」，链接写纯标题，系统已做归一化对齐。' })
        ]));
      }

      function statCard(k, v, sub) {
        return el('div', { className: 'pao-graph__stat' }, [
          el('div', { className: 'pao-graph__stat-k', text: k }),
          el('div', { className: 'pao-graph__stat-v', text: v == null ? '—' : String(v) }),
          el('div', { className: 'pao-graph__stat-sub', text: sub || '' })
        ]);
      }

      function section(title, hint) {
        var box = el('div', { className: 'pao-section' }, [
          el('div', { className: 'pao-section__head' }, [
            el('div', { className: 'pao-section__title', text: title }),
            hint ? el('div', { className: 'pao-section__hint', text: hint }) : null
          ])
        ]);
        var b = el('div', { className: 'pao-section__body' });
        box.appendChild(b);
        return { el: box, body: b };
      }

      function load() {
        state.loading = true;
        renderAll();
        var url = state.source === 'cloud' ? '/api/cloud-graph/summary' : '/api/graph/summary';
        fetch(url).then(function (r) { return r.json(); }).then(function (d) {
          state.loading = false;
          if (d.summary && d.summary.ok) {
            state.summary = d.summary;
          } else {
            state.summary = null;
            state.error = (d.summary && d.summary.reason) || (d.error || '未知错误');
          }
          renderAll();
        }).catch(function (e) {
          state.loading = false;
          state.error = e.message;
          renderAll();
        });
      }

      /* 选中笔记时拉详情（云脑源没有单篇接口，直接用场景内节点数据） */
      var off = PAO.bus.on('graph:note', function (p) {
        if (!p || !p.id) return;
        if (state.source === 'cloud') {
          var nodes = (PAO.scene.graph && PAO.scene.graph.nodes) || [];
          for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].id === p.id) {
              state.selected = { node: nodes[i], inbound: [], outbound: [] };
              renderAll();
              return;
            }
          }
          return;
        }
        fetch('/api/graph/node?id=' + encodeURIComponent(p.id))
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.node) { state.selected = d; renderAll(); }
          }).catch(function () {});
      });

      /* 点枢纽节点：在三维里定位（按标题模糊匹配） */
      var off2 = PAO.bus.on('graph:focus-request', function (p) {
        if (!PAO.scene.graph || !p) return;
        var nodes = PAO.scene.graph.nodes || [];
        var hit = null;
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].title.indexOf(p.title.slice(0, 12)) > -1) { hit = nodes[i]; break; }
        }
        if (hit) {
          PAO.scene.focusNote(hit.id);
          PAO.bus.emit('graph:note', { id: hit.id });
        }
      });

      ctx._cleanup = function () { off(); off2(); };

      load();
    },

    onEnter: function (ctx) {
      if (PAO.scene.mode !== 'graph') PAO.scene.setMode('graph');
    },

    onExit: function (ctx) {
      if (ctx && ctx._cleanup) ctx._cleanup();
    }
  };
})(window.PAO = window.PAO || {});
