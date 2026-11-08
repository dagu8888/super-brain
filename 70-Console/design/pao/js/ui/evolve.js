/* PERSONAL AI OS — 自我迭代审阅面板
   职责：把「升级提案」变成可审阅、可批准、可回滚的对象。
   设计原则：默认不信任——没有点批准，一行代码都不会被写入。 */
(function (PAO) {
  'use strict';

  PAO.panels = PAO.panels || {};
  var D = PAO.dom;
  var el = D.el;

  var state = { list: [], selected: null, loading: false, busy: false };

  var STATUS_LABEL = {
    proposed: ['待批准', 'warn'],
    applying: ['应用中', 'cyan'],
    applied: ['已应用', 'ok'],
    failed: ['失败已回滚', 'crit'],
    rejected: ['已拒绝', 'muted'],
    rolled_back: ['已回滚', 'muted']
  };

  function api(path, opts) {
    return fetch(path, opts).then(function (r) { return r.json(); });
  }

  function badge(status) {
    var m = STATUS_LABEL[status] || [status, 'muted'];
    return el('span', { className: 'pao-badge pao-badge--' + m[1], text: m[0] });
  }

  PAO.panels['evolve'] = {
    id: 'evolve', kicker: 'SELF-EVOLUTION', label: 'SELF EVOLUTION', zh: '自我迭代',
    tagline: 'CHANGE YOURSELF. WITH PERMISSION.', taglineZh: '可以改自己，但要先被允许。',
    badge: '需人工批准',

    render: function (root, ctx) {
      D.clear(root);
      var wrap = el('div', { className: 'pao-evolve' });
      root.appendChild(wrap);

      wrap.appendChild(el('div', { className: 'pao-stage-note' }, [
        D.icon('shield', 13),
        el('span', { text: '所有升级都必须经你批准：批准后系统先快照 → 写入 → 语法检查 → 冒烟测试，任一步失败自动回滚原文件。' })
      ]));

      var listBox = el('div', { className: 'pao-evolve__list' });
      var detailBox = el('div', { className: 'pao-evolve__detail' });
      wrap.appendChild(listBox);
      wrap.appendChild(detailBox);

      function refresh() {
        listBox.appendChild(el('div', { className: 'pao-empty' }, [
          el('div', { className: 'pao-empty__title', text: '正在加载提案…' })
        ]));
        api('/api/evolve/proposals').then(function (d) {
          D.clear(listBox);
          state.list = d.proposals || [];

          if (!state.list.length) {
            D.appendAll(listBox, [
              el('div', { className: 'pao-section' }, [
                el('div', { className: 'pao-section__head' }, [
                  el('div', { className: 'pao-section__title', text: '暂无提案' })
                ]),
                el('div', { className: 'pao-section__body' }, [
                  el('div', { className: 'pao-empty' }, [
                    el('div', { className: 'pao-empty__title', text: '还没有任何自我迭代提案' }),
                    el('div', { className: 'pao-empty__hint', text: '在管家对话里说「帮我升级自己」，或让模型通过 propose_upgrade 提出改动，提案会出现在这里等待你批准。' })
                  ])
                ])
              ])
            ]);
            D.clear(detailBox);
            return;
          }

          var head = el('div', { className: 'pao-section__head' }, [
            el('div', { className: 'pao-section__title', text: '提案列表' }),
            el('div', { className: 'pao-section__hint', text: '共 ' + state.list.length + ' 条' })
          ]);
          listBox.appendChild(head);

          state.list.slice().reverse().forEach(function (p) {
            var row = el('button', {
              className: 'pao-evolve__item' + (state.selected === p.id ? ' is-active' : ''),
              attrs: { type: 'button' }
            }, [
              el('div', { className: 'pao-evolve__itemHead' }, [
                el('span', { className: 'pao-evolve__goal', text: p.goal }),
                badge(p.status)
              ]),
              el('div', { className: 'pao-evolve__itemMeta' }, [
                el('span', { text: p.files + ' 个文件' }),
                el('span', { text: (p.targets || []).indexOf('server') > -1 ? '需重启' : '刷新生效' }),
                el('span', { className: 'pao-mono', text: D.fmt.ago(p.createdAt) })
              ])
            ]);
            row.addEventListener('click', function () {
              state.selected = p.id;
              refresh();
            });
            listBox.appendChild(row);
          });

          if (state.selected) {
            var sel = null;
            for (var i = 0; i < state.list.length; i++) if (state.list[i].id === state.selected) sel = state.list[i];
            if (sel) renderDetail(detailBox, sel, refresh);
          } else {
            D.clear(detailBox);
            detailBox.appendChild(el('div', { className: 'pao-empty' }, [
              el('div', { className: 'pao-empty__hint', text: '点选上方提案查看改动详情。' })
            ]));
          }
        }).catch(function (e) {
          D.clear(listBox);
          listBox.appendChild(el('div', { className: 'pao-empty' }, [
            el('div', { className: 'pao-empty__title', text: '无法读取提案' }),
            el('div', { className: 'pao-empty__hint', text: '后端未连接：' + e.message })
          ]));
        });
      }

      function renderDetail(box, p, refreshFn) {
        D.clear(box);

        box.appendChild(el('div', { className: 'pao-section' }, [
          el('div', { className: 'pao-section__head' }, [
            el('div', { className: 'pao-section__title', text: p.goal }),
            badge(p.status)
          ]),
          el('div', { className: 'pao-section__body' }, [
            p.plan ? el('p', { className: 'pao-evolve__plan', text: p.plan }) : null,
            el('div', { className: 'pao-kv' }, [
              el('span', { className: 'pao-kv__k', text: '提案编号' }),
              el('span', { className: 'pao-kv__v pao-mono', text: p.id })
            ]),
            el('div', { className: 'pao-kv' }, [
              el('span', { className: 'pao-kv__k', text: '生效方式' }),
              el('span', { className: 'pao-kv__v', text: p.needsRestart ? '改动后端，需重启进程' : '改动前端，刷新页面即可' })
            ]),
            p.error ? el('div', { className: 'pao-warnbox' }, [D.icon('warning', 14), el('span', { text: p.error })]) : null
          ])
        ]));

        /* 逐行 diff */
        var filesSec = el('div', { className: 'pao-section' }, [
          el('div', { className: 'pao-section__head' }, [
            el('div', { className: 'pao-section__title', text: '逐行改动（' + (p.preview || []).length + ' 个文件）' }),
            el('div', { className: 'pao-section__hint', text: '点击文件名展开 / 收起' })
          ])
        ]);
        var body = el('div', { className: 'pao-section__body' });
        filesSec.appendChild(body);
        box.appendChild(filesSec);

        renderFileDiffs(body, p);

        function renderFileDiffs(host, prop) {
          host.appendChild(el('div', { className: 'pao-diff__loading', text: '正在加载逐行差异…' }));

          fetch('/api/evolve/diff?id=' + prop.id)
            .then(function (r) { return r.json(); })
            .then(function (d) {
              D.clear(host);
              var files = (d.diff && d.diff.files) || {};

              (prop.preview || []).forEach(function (f, idx) {
                var fd = files[f.path];
                host.appendChild(buildFileBlock(f, fd, idx === 0));
              });
            })
            .catch(function (e) {
              D.clear(host);
              host.appendChild(el('div', { className: 'pao-empty' }, [
                el('div', { className: 'pao-empty__text', text: '无法加载差异：' + e.message })
              ]));
            });
        }

        function buildFileBlock(f, fd, openByDefault) {
          var addN = f.added || 0, delN = f.removed || 0;

          var headRight = el('div', { className: 'pao-diff__counts' }, [
            addN ? el('span', { className: 'pao-diff__add', text: '+' + addN }) : null,
            delN ? el('span', { className: 'pao-diff__del', text: '-' + delN }) : null
          ]);

          var fileBox = el('div', { className: 'pao-diff' + (openByDefault ? ' is-open' : '') });

          var head = el('button', { className: 'pao-diff__head', attrs: { type: 'button' } }, [
            el('span', { className: 'pao-diff__path pao-mono', text: f.path }),
            headRight,
            el('span', { className: 'pao-diff__chev' }, [D.icon('chevron', 13)])
          ]);
          head.addEventListener('click', function () { fileBox.classList.toggle('is-open'); });
          fileBox.appendChild(head);

          if (f.reason) {
            fileBox.appendChild(el('div', { className: 'pao-diff__reason', text: f.reason }));
          }

          var bodyBox = el('div', { className: 'pao-diff__body' });

          if (!fd || !fd.hunks || !fd.hunks.length) {
            bodyBox.appendChild(el('div', { className: 'pao-diff__empty', text: f.existed ? '内容无变化或差异过大' : '新文件（全部内容为新增）' }));
          } else {
            var shown = 0;
            var LIMIT = 500;
            fd.hunks.forEach(function (h) {
              if (shown > LIMIT) return;
              bodyBox.appendChild(el('div', { className: 'pao-diff__hunkHead', text: '@@ -' + h.oldStart + ',' + h.oldCount + ' +' + h.newStart + ',' + h.newCount + ' @@' }));

              h.lines.forEach(function (l) {
                if (shown > LIMIT) return;
                shown++;
                var row = el('div', { className: 'pao-diff__line pao-diff__line--' + l.type });
                row.appendChild(el('span', { className: 'pao-diff__ln', text: l.oldLine == null ? '' : String(l.oldLine) }));
                row.appendChild(el('span', { className: 'pao-diff__ln', text: l.newLine == null ? '' : String(l.newLine) }));
                row.appendChild(el('span', { className: 'pao-diff__mark', text: l.type === 'add' ? '+' : (l.type === 'del' ? '-' : ' ') }));
                row.appendChild(el('span', { className: 'pao-diff__text', text: l.text || ' ' }));
                bodyBox.appendChild(row);
              });
            });
            if (fd.truncated || shown > LIMIT) {
              bodyBox.appendChild(el('div', { className: 'pao-diff__empty', text: '差异过大，仅显示前 ' + LIMIT + ' 行。' }));
            }
          }

          fileBox.appendChild(bodyBox);
          return fileBox;
        }

        /* 操作区 */
        var actions = el('div', { className: 'pao-section' }, [
          el('div', { className: 'pao-section__body' })
        ]);
        var actBody = actions.querySelector('.pao-section__body');

        if (p.status === 'proposed') {
          var approve = el('button', {
            className: 'pao-btn pao-btn--primary pao-btn--block', attrs: { type: 'button' },
            text: state.busy ? '应用中…' : '批准并应用'
          });
          approve.addEventListener('click', async function () {
            if (state.busy) return;
            var ok = await PAO.ui.confirm({
              kicker: '高风险操作',
              title: '确认修改系统自身代码？',
              text: '系统会先快照 ' + p.files + ' 个文件，再写入并执行语法检查与冒烟测试；任一步失败将自动回滚到原文件。' + (p.needsRestart ? ' 本次改动包含后端文件，应用后需重启进程才会生效。' : ''),
              danger: true, confirmText: '批准并应用'
            });
            if (!ok) return;
            state.busy = true;
            refreshFn();
            try {
              var r = await api('/api/evolve/approve', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: p.id })
              });
              state.busy = false;
              if (r.ok) {
                PAO.ui.toast('ok', '升级已应用', '语法检查与冒烟测试均通过' + (p.needsRestart ? '，请重启进程生效。' : '，刷新页面即可。'));
              } else {
                PAO.ui.toast('crit', r.rolledBack ? '应用失败，已自动回滚' : '应用失败', r.error || '');
              }
            } catch (e) {
              state.busy = false;
              PAO.ui.toast('crit', '请求失败', e.message);
            }
            refreshFn();
          });
          actBody.appendChild(approve);

          var reject = el('button', {
            className: 'pao-btn pao-btn--ghost pao-btn--block', attrs: { type: 'button' }, text: '拒绝（保留记录）'
          });
          reject.addEventListener('click', function () {
            PAO.ui.toast('info', '提案已标记为拒绝', '未写入任何文件。可在后端清理。');
          });
          actBody.appendChild(reject);
        }

        if (p.status === 'applied') {
          var rb = el('button', {
            className: 'pao-btn pao-btn--danger pao-btn--block', attrs: { type: 'button' }, text: '回滚到应用前'
          });
          rb.addEventListener('click', async function () {
            var ok = await PAO.ui.confirm({
              kicker: '回滚', title: '回滚这次升级？', danger: true,
              text: '将从快照恢复 ' + p.files + ' 个文件到应用前的状态。若改动含后端文件，回滚后同样需要重启。'
            });
            if (!ok) return;
            try {
              var r = await api('/api/evolve/rollback', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: p.id })
              });
              if (r.error) PAO.ui.toast('crit', '回滚失败', r.error);
              else PAO.ui.toast('ok', '已回滚', '文件已恢复到应用前状态。');
            } catch (e) { PAO.ui.toast('crit', '请求失败', e.message); }
            refreshFn();
          });
          actBody.appendChild(rb);
        }

        if (p.testReport) {
          actBody.appendChild(el('div', { className: 'pao-evolve__report' }, [
            el('div', { className: 'pao-evolve__reportTitle', text: '测试报告' }),
            el('div', { className: 'pao-kv' }, [
              el('span', { className: 'pao-kv__k', text: '语法检查' }),
              el('span', { className: 'pao-kv__v', text: (p.testReport.syntax || []).filter(function (s) { return s.ok; }).length + ' / ' + (p.testReport.syntax || []).length + ' 通过' })
            ]),
            el('div', { className: 'pao-kv' }, [
              el('span', { className: 'pao-kv__k', text: '冒烟测试' }),
              el('span', { className: 'pao-kv__v', text: p.testReport.smoke && p.testReport.smoke.ok ? '通过' : '未通过' })
            ])
          ]));
        }

        box.appendChild(actions);

        box.appendChild(el('div', { className: 'pao-disclosure' }, [
          el('div', { className: 'pao-disclosure__title', text: '安全边界' }),
          el('p', { className: 'pao-disclosure__text', text: '工具层只允许：读取项目文件、写入项目文件（快照后）、按白名单执行 node --check 与冒烟测试。不提供任意 shell，不允许访问项目根之外，不允许写入 .env 与数据目录。' })
        ]));
      }

      refresh();
    }
  };
})(window.PAO = window.PAO || {});
