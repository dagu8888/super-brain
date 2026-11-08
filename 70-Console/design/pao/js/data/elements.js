/* PERSONAL AI OS — 五行色彩系统（WU XING PALETTE）
   设计原则：
     1) 五行色 = 身份色（节点是什么）  —— 木青 / 火赤 / 土黄 / 金白 / 水玄
     2) 状态色 = 运行色（节点正在做什么）—— idle 灰 / thinking 青 / running 亮 / waiting 琥珀 / completed 绿 / failed 红 / paused 紫
     两套色互不替代：身份看色相，状态看亮灭与节奏。
     3) 深空背景（#05070B）适配：保持传统色相，提亮明度，避免脏暗。 */
(function (PAO) {
  'use strict';

  var ELEMENTS = {
    wood: {
      id: 'wood', zh: '木', hanzi: '木',
      color: 0x3FBF8F, hex: '#3FBF8F',
      nature: '生发', virtue: '生长 · 创造 · 探索',
      desc: '主生发与延展，对应创造、研究与一切从无到有的过程。'
    },
    fire: {
      id: 'fire', zh: '火', hanzi: '火',
      color: 0xE5674E, hex: '#E5674E',
      nature: '炎上', virtue: '行动 · 能量 · 执行',
      desc: '主炎上与释放，对应智能体运行、任务执行与一切真正发生的动作。'
    },
    earth: {
      id: 'earth', zh: '土', hanzi: '土',
      color: 0xD9A93C, hex: '#D9A93C',
      nature: '承载', virtue: '承载 · 储存 · 居中',
      desc: '主承载与化合，对应数据、项目、管家这类居中调和的存在。'
    },
    metal: {
      id: 'metal', zh: '金', hanzi: '金',
      color: 0xCFD8E6, hex: '#CFD8E6',
      nature: '从革', virtue: '秩序 · 边界 · 器物',
      desc: '主收敛与决断，对应权限、规则、工具与模型网关这类"器"。'
    },
    water: {
      id: 'water', zh: '水', hanzi: '水',
      color: 0x4E86D9, hex: '#4E86D9',
      nature: '润下', virtue: '流动 · 记忆 · 智慧',
      desc: '主润下与藏纳，对应记忆、模型这类流动汇聚之物。'
    }
  };

  /* 相生顺序：木→火→土→金→水→木 */
  var CYCLE = ['wood', 'fire', 'earth', 'metal', 'water'];

  /* 六大模块 → 五行 */
  var MODULE_ELEMENT = {
    memory: 'water',        // 记忆如水，深流藏纳
    cognitive: 'wood',      // 认知如木，向上生长
    agent: 'fire',          // 运行时如火，真正发生
    data: 'earth',          // 数据如土，承载万物
    model: 'water',         // 模型如水，多源汇流
    trust: 'metal'          // 信任如金，立界守规
  };

  /* 十个 Agent → 五行 */
  var AGENT_ELEMENT = {
    agent_concierge: 'earth',      // 中宫调和
    agent_memory: 'water',
    agent_intelligence: 'metal',
    agent_project: 'earth',
    agent_development: 'wood',
    agent_research: 'wood',
    agent_creation: 'fire',
    agent_data: 'earth',
    agent_tools: 'metal',
    agent_external: 'fire'
  };

  /* 七层架构 → 五行（自上而下 L1→L7） */
  var LAYER_ELEMENT = ['water', 'earth', 'water', 'wood', 'metal', 'fire', 'wood'];

  /* 状态色（与元素色分离，用于光点/脉冲） */
  var STATUS = {
    idle: { color: 0x7E8999, hex: '#7E8999', zh: '待命' },
    thinking: { color: 0x55DDF5, hex: '#55DDF5', zh: '理解中' },
    running: { color: 0x91DFFF, hex: '#91DFFF', zh: '执行中' },
    waiting: { color: 0xE0B15C, hex: '#E0B15C', zh: '等待中' },
    completed: { color: 0x5FD6A8, hex: '#5FD6A8', zh: '已完成' },
    failed: { color: 0xE06767, hex: '#E06767', zh: '失败' },
    paused: { color: 0x9178FF, hex: '#9178FF', zh: '已暂停' }
  };

  function elementOf(kind, id) {
    var key = null;
    if (kind === 'module') key = MODULE_ELEMENT[id];
    else if (kind === 'agent') key = AGENT_ELEMENT[id];
    else if (kind === 'layer') key = LAYER_ELEMENT[typeof id === 'number' ? id : 0];
    return ELEMENTS[key] || ELEMENTS.earth;
  }

  function colorOf(kind, id) {
    return elementOf(kind, id).color;
  }

  PAO.ELEMENTS = ELEMENTS;
  PAO.ELEMENT_CYCLE = CYCLE;
  PAO.STATUS_COLORS = STATUS;
  PAO.elementOf = elementOf;
  PAO.elementColor = colorOf;
})(window.PAO = window.PAO || {});
