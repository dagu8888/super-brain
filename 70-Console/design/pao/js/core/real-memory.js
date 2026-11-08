/* PERSONAL AI OS — 真实记忆数据源
   从本地后端 /api/memory 拉取真实记忆库（元 AI vault 种子），映射为
   buildMemory 需要的 { memories, memoryClusters } 结构。
   无任何虚构条目；links 置空（真实库暂无关联索引），诚实标注。 */
(function (PAO) {
  'use strict';

  var TYPE_TO_CAT = {
    decision: 'DECISIONS', decision_zh: '决策',
    preference: 'PREFERENCES',
    knowledge: 'FACTS',
    experience: 'EVENTS',
    project: 'GOALS',
    profile: 'FACTS'
  };

  var CAT_ZH = {
    DECISIONS: '决策', PREFERENCES: '偏好', FACTS: '事实',
    EVENTS: '事件', GOALS: '目标', RELATIONSHIPS: '关系'
  };

  /* 六簇球面分布（与 mock 簇同尺度：半径 6-11 错开） */
  var CLUSTER_CENTERS = {
    DECISIONS:   [8.4, 1.8, 2.2],
    PREFERENCES: [-3.1, 7.6, -4.8],
    FACTS:       [-8.2, -2.4, 3.6],
    EVENTS:      [2.9, 6.9, 5.4],
    GOALS:       [-6.4, -5.8, -2.1],
    RELATIONSHIPS: [5.7, -6.2, 4.9]
  };
  var CLUSTER_COLORS = {
    DECISIONS: '#A9C6FF', PREFERENCES: '#91DFFF', FACTS: '#55DDF5',
    EVENTS: '#9178FF', GOALS: '#4F8FE0', RELATIONSHIPS: '#5FD6C8'
  };

  function mapMemory(r) {
    var cat = TYPE_TO_CAT[r.type] || 'FACTS';
    return {
      id: r.id,
      title: (r.title || r.id).slice(0, 60),
      content: r.content || '',
      category: cat,
      categoryZh: CAT_ZH[cat],
      cluster: cat, /* 按类别聚簇——真实库当前无语义簇标注，诚实取类别 */
      confidence: r.confidence != null ? r.confidence : 0.5,
      validity: 'ACTIVE',
      sensitivity: 'LOW',
      source: {
        type: r.seeded ? 'VAULT_SEED' : 'USER',
        typeZh: r.seeded ? '元AI记忆库种子' : '用户写入',
        label: r.sourcePath || r.source || '',
        ref: r.sourcePath || ''
      },
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
      links: [],
      tags: r.tags || [],
      weight: r.importance != null ? Math.min(1, r.importance / 100) : 0.5
    };
  }

  /* 拉真实数据；成功时同步覆盖 PAO.DATA.memories / memoryClusters，
     使 3D 记忆宇宙与记忆面板等所有消费方一次性切换为真实数据。 */
  PAO.loadRealMemoryData = function () {
    return fetch('/api/memory?limit=all')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error || !d.results || !d.results.length) return null;
        var memories = d.results.map(mapMemory);
        /* 按真实类别计数生成簇 */
        var counts = {};
        memories.forEach(function (m) { counts[m.cluster] = (counts[m.cluster] || 0) + 1; });
        var clusters = Object.keys(counts).map(function (cat) {
          return {
            id: 'rc-' + cat.toLowerCase(),
            name: cat,
            zh: CAT_ZH[cat] || cat,
            color: CLUSTER_COLORS[cat] || '#7E8999',
            count: counts[cat],
            center: CLUSTER_CENTERS[cat] || [0, 0, 0],
            radius: 9,
            desc: CAT_ZH[cat] + '类真实记忆 · 共 ' + counts[cat] + ' 条（来自本地记忆库）'
          };
        });
        var real = {
          memories: memories,
          memoryClusters: clusters,
          stats: d.stats,
          real: true
        };
        /* 覆盖全局演示数据 → 面板/3D/hover 全部读到真实记忆 */
        if (PAO.DATA) {
          PAO.DATA.memories = memories;
          PAO.DATA.memoryClusters = clusters;
          PAO.DATA.memoryReal = true;
        }
        return real;
      })
      .catch(function () { return null; });
  };
})(window.PAO = window.PAO || {});
