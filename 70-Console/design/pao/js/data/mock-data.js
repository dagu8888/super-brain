/* =============================================================================
 * PERSONAL AI OS — js/data/mock-data.js
 * 演示数据层 · PAO-DEMO-0.9.2
 *
 * 说明：
 *   1) 全部为本地演示数据，非真实用户信息；不含任何真实人名、公司、邮箱、电话。
 *   2) 所有连接器均为模拟，未接入任何真实账户，任何"执行"都发生在本地内存中。
 *   3) 每条记忆都标注来源类型（用户主动提供 / 行为观察 / 模型推断），
 *      推断类条目在 source.label 中写明推断依据与样本量，置信度一律 ≤ 0.86。
 *   4) 时间基准 2026-11-06，所有时间戳为 ISO 8601 字符串，时区 +08:00。
 *
 * 只读对象：消费方请勿修改 DATA 内部字段。
 * ========================================================================== */

(function (PAO) {
  'use strict';

  var DATA = {};

  /* ===========================================================================
   * 1. meta — 产品身份与诚实声明
   * ======================================================================== */

  DATA.meta = {
    product: 'PERSONAL AI OS',
    layer: 'A NEW LAYER OF PERSONAL INTELLIGENCE.',
    slogan: 'KNOW ME. THINK WITH ME. ACT FOR ME.',
    sloganZh: '懂我 · 与我同思 · 为我而行',
    stage: 'RUNNING · LOCAL ENGINE + CLOUD BRAIN',
    stageZh: '运行阶段 · 本地引擎 + 云脑超级大脑已接入',
    stageNote: '记忆与知识图谱为真实数据；部分能力（连接器、权限演练、架构蓝图）为本地模拟，已逐项标注。',
    build: 'PAO-1.0.0',
    generatedAt: '2026-11-08T14:40:00+08:00',
    disclaimer: '记忆库（60 条）来自本机元 AI 记忆库真实导入；知识图谱（132 篇本地 vault + 云脑 25 条目实时接口）为真实数据；连接器与权限演练为本地模拟，未接入外部账户。',
    honesty: {
      demoData: '真实数据 · 本地后端驱动',
      simulatedLink: '模拟连接 · 未接入真实账户',
      simulatedRun: '本地模拟 · 未调用外部服务',
      stageNote: '真实数据驱动 · 部分能力为本地模拟'
    }
  };

  /* ===========================================================================
   * 2. modules — 六大模块（3D 宇宙中的六个功能星体）
   * ======================================================================== */

  DATA.modules = [
    {
      id: 'memory', num: '01', name: 'PERSONAL MEMORY', zh: '记忆系统',
      tagline: 'EVERYTHING THAT MATTERS, REMEMBERED.',
      taglineZh: '所有重要的事，都被记住。',
      desc: '长期个人记忆网络，区分用户事实、观察行为与模型推断；节点之间以语义与时间双维度连接。',
      metrics: [{ k: '记忆条目', v: '1,284' }, { k: '关联密度', v: '3.7' }, { k: '记忆簇', v: '8' }],
      color: '#55DDF5'
    },
    {
      id: 'cognitive', num: '02', name: 'COGNITIVE ENGINE', zh: '认知引擎',
      tagline: 'A MODEL OF HOW I THINK.',
      taglineZh: '一个关于我如何思考的模型。',
      desc: '从记忆里归纳七个维度的个人画像，每一维都带置信度、证据链与冲突项，可被用户改写。',
      metrics: [{ k: '画像维度', v: '7' }, { k: '平均置信度', v: '0.74' }, { k: '待解冲突', v: '2' }],
      color: '#9178FF'
    },
    {
      id: 'agent', num: '03', name: 'AGENT RUNTIME', zh: '智能体运行时',
      tagline: 'INTENT IN. OUTCOMES OUT.',
      taglineZh: '一句意图输入，一个结果输出。',
      desc: '九步执行链：理解意图、检索记忆、组装上下文、生成计划、检查权限、请求确认、执行、验证、完成。',
      metrics: [{ k: '执行步骤', v: '9' }, { k: '可用工具', v: '7' }, { k: '需确认动作', v: '4' }],
      color: '#91DFFF'
    },
    {
      id: 'data', num: '04', name: 'DATA UNIVERSE', zh: '数据宇宙',
      tagline: 'TEN STREAMS. ONE SELF.',
      taglineZh: '十条数据流，汇聚成一个我。',
      desc: '十个潜在数据入口，四个处理阶段：采集、接入、治理、存储；默认全部关闭，逐项授权。',
      metrics: [{ k: '数据入口', v: '10' }, { k: '已模拟接入', v: '2' }, { k: '处理阶段', v: '4' }],
      color: '#5FD6A8'
    },
    {
      id: 'model', num: '05', name: 'MODEL GATEWAY', zh: '模型网关',
      tagline: 'THE RIGHT MIND FOR THE RIGHT JOB.',
      taglineZh: '合适的心智，做合适的事。',
      desc: '按任务类型、隐私等级与成本预算路由到不同模型，隐私优先时可强制走本地模型。',
      metrics: [{ k: '可选模型', v: '4' }, { k: '路由任务', v: '4' }, { k: '路由规则', v: '5' }],
      color: '#E0B15C'
    },
    {
      id: 'trust', num: '06', name: 'TRUST LAYER', zh: '权限与信任',
      tagline: 'NOTHING WITHOUT CONSENT.',
      taglineZh: '未经同意，寸步不行。',
      desc: '五层信任结构：控制权核心、数据授权、模型访问、Agent 执行、审计；每次动作留痕且可撤销。',
      metrics: [{ k: '权限项', v: '8' }, { k: '审计记录', v: '14' }, { k: '信任分', v: '0.87' }],
      color: '#C98CFF'
    }
  ];

  /* ===========================================================================
   * 3. memories — 52 条长期记忆
   *    分布：FACTS 12 / EVENTS 10 / PREFERENCES 10 / RELATIONSHIPS 7 / GOALS 7 / DECISIONS 6
   *    来源：USER_PROVIDED 21 / OBSERVED 17 / INFERENCE 14
   * ======================================================================== */

  DATA.memories = [

    // ── 按 createdAt 升序排列（真实记忆库的自然顺序，类别交错出现）──────────
    { id: 'MEM-0004', category: 'FACTS', categoryZh: '事实', title: '常驻时区为东八区',
      content: '引导设置里填写：定居江临市城西，长期按东八区作息，出差最远到东九区，不做跨时区的实时协作。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在引导设置第 3 步主动填写', ref: 'ONBOARD-03' }, createdAt: '2025-09-18T10:12:00+08:00', updatedAt: '2026-09-02T09:40:00+08:00',
      confidence: 0.97, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '工作方式', links: ['MEM-0009', 'MEM-0142', 'MEM-0017'], tags: ['时区', '协作'], weight: 0.74
    },
    { id: 'MEM-0009', category: 'FACTS', categoryZh: '事实', title: '家到工作室骑行十二分钟',
      content: '六周内 28 次为骑行，平均 12 分钟；雨天改乘地铁，耗时约 26 分钟，通常会提前 10 分钟出门。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据 34 次通勤定位记录推断，其中 28 次骑行、6 次地铁', ref: 'LOC-0031' }, createdAt: '2025-09-21T08:26:00+08:00', updatedAt: '2026-08-14T07:58:00+08:00',
      confidence: 0.84, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '居住与生活', links: ['MEM-0004', 'MEM-0083', 'MEM-0038'], tags: ['通勤', '定位'], weight: 0.52
    },
    { id: 'MEM-0017', category: 'PREFERENCES', categoryZh: '偏好', title: '深度工作放在上午九点到十一点半',
      content: '引导时选定的深度工作窗口为 09:00–11:30，期间关闭消息通知。11 月 6 日用户把窗口改为清晨 06:00–08:00，本条已标记为已修正。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在引导设置中选择的时段，后于 11 月 6 日在偏好面板修改', ref: 'ONBOARD-07' }, createdAt: '2025-10-02T21:15:00+08:00', updatedAt: '2026-11-06T22:12:00+08:00',
      confidence: 0.95, validity: 'CORRECTED', sensitivity: 'MEDIUM', cluster: '工作方式', links: ['MEM-0031', 'MEM-0202', 'MEM-0088'], tags: ['深度工作', '时段'], weight: 0.88
    },
    { id: 'MEM-0023', category: 'EVENTS', categoryZh: '事件', title: '三个周四连续加班至深夜',
      content: '10 月的三个周四都在 23:00 之后还有文件提交记录，而次日上午日程为空；同一周的周五会议被挪到了下午。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '文档提交时间戳与日历空闲块比对', ref: 'LOG-0118' }, createdAt: '2025-10-06T09:05:00+08:00', updatedAt: '2026-01-08T10:22:00+08:00',
      confidence: 0.9, validity: 'AGING', sensitivity: 'LOW', cluster: '工作方式', links: ['MEM-0017', 'MEM-0186', 'MEM-0057'], tags: ['加班', '节奏'], weight: 0.49
    },
    { id: 'MEM-0029', category: 'RELATIONSHIPS', categoryZh: '关系', title: '伴侣阿岚从事儿科护理',
      content: '伴侣阿岚在市里一家儿童医院做护理，三班倒；她的排班决定了一周里哪天晚上家里没人做饭，日程需要避开。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在家庭关系引导中填写', ref: 'ONBOARD-11' }, createdAt: '2025-10-14T21:40:00+08:00', updatedAt: '2026-09-19T20:15:00+08:00',
      confidence: 0.98, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '家庭与关系', links: ['MEM-0238', 'MEM-0155', 'MEM-0062'], tags: ['家庭', '排班'], weight: 0.86
    },
    { id: 'MEM-0031', category: 'PREFERENCES', categoryZh: '偏好', title: '上午十一点前不排会议',
      content: '三个月后补充的硬规则：11:00 前不排会议，外部客户指定时段除外；内部沟通一律挪到下午，宁可多等一天。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在偏好设置中追加，并注明「除外部客户」', ref: 'PREF-0042' }, createdAt: '2025-10-19T09:30:00+08:00', updatedAt: '2026-10-11T08:44:00+08:00',
      confidence: 0.96, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '工作方式', links: ['MEM-0017', 'MEM-0088', 'MEM-0121'], tags: ['会议', '边界'], weight: 0.92
    },
    { id: 'MEM-0038', category: 'FACTS', categoryZh: '事实', title: '工作台为双屏与有线网络',
      content: '两台 27 寸显示器横置，一把青轴机械键盘，主机走有线千兆；摄像头与麦克风分开，录音时才插上。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据设备指纹与屏幕分辨率记录推断，21 次开机中 19 次为双屏', ref: 'DEV-0009' }, createdAt: '2025-10-27T22:03:00+08:00', updatedAt: '2026-07-30T21:10:00+08:00',
      confidence: 0.82, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '居住与生活', links: ['MEM-0009', 'MEM-0181', 'MEM-0083'], tags: ['设备', '工作台'], weight: 0.44
    },
    { id: 'MEM-0043', category: 'EVENTS', categoryZh: '事件', title: '新建长文《被外包的记忆》',
      content: '11 月 3 日晚在文档工具里新建长文，标题《被外包的记忆》，首日写了 1,840 字，之后停笔两周才回来。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '文档创建事件与字数快照', ref: 'DOC-0207' }, createdAt: '2025-11-03T23:18:00+08:00', updatedAt: '2026-09-28T22:40:00+08:00',
      confidence: 0.93, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '创作与表达', links: ['MEM-0094', 'MEM-0299', 'MEM-0174'], tags: ['写作', '长文'], weight: 0.81
    },
    { id: 'MEM-0051', category: 'PREFERENCES', categoryZh: '偏好', title: '阅读偏非虚构与纸质书',
      content: '近八个月读完 14 本，11 本非虚构；纸质 9 本，电子书集中在通勤时段，小说只在出差路上读。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '阅读应用与购书记录合并统计', ref: 'READ-0055' }, createdAt: '2025-11-11T20:22:00+08:00', updatedAt: '2026-10-03T19:35:00+08:00',
      confidence: 0.87, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '学习与阅读', links: ['MEM-0192', 'MEM-0316', 'MEM-0148'], tags: ['阅读', '非虚构'], weight: 0.58
    },
    { id: 'MEM-0057', category: 'GOALS', categoryZh: '目标', title: '把睡眠稳定在七小时',
      content: '目标不是早睡，而是起床时间固定；目前完成度约一半，工作日能到 7 小时，周末容易滑到 8 点半。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在年度目标里手写的三条之一', ref: 'GOAL-0002' }, createdAt: '2025-11-18T07:12:00+08:00', updatedAt: '2026-10-20T23:05:00+08:00',
      confidence: 0.94, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '健康与作息', links: ['MEM-0168', 'MEM-0231', 'MEM-0106'], tags: ['睡眠', '目标'], weight: 0.79
    },
    { id: 'MEM-0062', category: 'RELATIONSHIPS', categoryZh: '关系', title: '每周日晚与父母通话',
      content: '每周日 20:30 前后通话 20 到 30 分钟，聊身体和家里的小事；通话结束后基本不再打开工作文件。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '通话记录与屏幕使用时间对照', ref: 'LOG-0141' }, createdAt: '2025-11-24T21:02:00+08:00', updatedAt: '2026-10-26T21:30:00+08:00',
      confidence: 0.91, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '家庭与关系', links: ['MEM-0029', 'MEM-0238', 'MEM-0207'], tags: ['父母', '通话'], weight: 0.67
    },
    { id: 'MEM-0071', category: 'DECISIONS', categoryZh: '决策', title: '保持独立顾问不做全职',
      content: '2025 年底拒绝一份全职邀约，理由是「不想再解释为什么上午不回消息」；决定把收入拆成三个客户，不押注单一来源。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在决策复盘文档中记录', ref: 'DEC-0001' }, createdAt: '2025-12-02T22:48:00+08:00', updatedAt: '2026-06-17T09:26:00+08:00',
      confidence: 0.96, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '财务与消费', links: ['MEM-0099', 'MEM-0212', 'MEM-0127'], tags: ['职业', '独立'], weight: 0.9
    },

    { id: 'MEM-0078', category: 'PREFERENCES', categoryZh: '偏好', title: '会议集中在周二与周三',
      content: '83% 的会议落在周二和周三，周一上午几乎没有会议；周四下午开始变稀，周五基本只剩一次同步。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据 11 周日历推断，会议时段分布高度集中', ref: 'CAL-0088' }, createdAt: '2025-12-09T18:40:00+08:00', updatedAt: '2026-09-09T17:22:00+08:00',
      confidence: 0.85, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '工作方式', links: ['MEM-0017', 'MEM-0031', 'MEM-0186'], tags: ['会议', '周节奏'], weight: 0.63
    },
    { id: 'MEM-0083', category: 'EVENTS', categoryZh: '事件', title: '工作室搬入共享办公空间',
      content: '12 月中旬把工作台搬到城西一处共享办公空间，工位靠窗；此后周三、周四到岗率最高，周一基本不去。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '门禁刷卡记录与日程对照', ref: 'LOG-0166' }, createdAt: '2025-12-16T10:35:00+08:00', updatedAt: '2026-08-21T11:04:00+08:00',
      confidence: 0.92, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '居住与生活', links: ['MEM-0009', 'MEM-0038', 'MEM-0223'], tags: ['工作室', '通勤'], weight: 0.55
    },
    { id: 'MEM-0088', category: 'PREFERENCES', categoryZh: '偏好', title: '沟通优先异步文字',
      content: '明确说过「不要突然打电话」；可以接受 24 小时内回复，紧急事项希望是一条带结论的消息，而不是一串追问。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在沟通偏好中写下，并在两次会议里重复', ref: 'PREF-0019' }, createdAt: '2025-12-23T15:08:00+08:00', updatedAt: '2026-10-15T16:52:00+08:00',
      confidence: 0.97, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '工作方式', links: ['MEM-0031', 'MEM-0017', 'MEM-0121'], tags: ['沟通', '异步'], weight: 0.89
    },
    { id: 'MEM-0094', category: 'GOALS', categoryZh: '目标', title: '一年内完成一本小册子',
      content: '计划 12 万字以内、8 到 12 章，先连载再结集；自己定的截止是 2026 年 12 月，允许延后一个月。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户写下的年度创作目标', ref: 'GOAL-0004' }, createdAt: '2026-01-05T09:18:00+08:00', updatedAt: '2026-09-30T22:15:00+08:00',
      confidence: 0.93, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '创作与表达', links: ['MEM-0043', 'MEM-0299', 'MEM-0333'], tags: ['写作', '出版'], weight: 0.84
    },
    { id: 'MEM-0099', category: 'FACTS', categoryZh: '事实', title: '收入结构以三个长期客户为主',
      content: '三个长期客户合计约 82%，其余为一次性项目；用户要求只记结构不记金额，明细留在本地账本里。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在财务设置中填写，明确要求隐藏金额', ref: 'ONBOARD-21' }, createdAt: '2026-01-12T20:26:00+08:00', updatedAt: '2026-08-06T19:40:00+08:00',
      confidence: 0.95, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '财务与消费', links: ['MEM-0071', 'MEM-0212', 'MEM-0312'], tags: ['收入', '客户'], weight: 0.7
    },
    { id: 'MEM-0106', category: 'EVENTS', categoryZh: '事件', title: '连续十四天清晨跑步三公里',
      content: '1 月连续 14 天 06:40 出门跑 3 公里，配速从 7 分 10 秒提到 6 分 25 秒；第 15 天下雨中断，之后没有恢复。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '手环运动记录连续段识别', ref: 'ACT-0033' }, createdAt: '2026-01-19T07:05:00+08:00', updatedAt: '2026-03-02T08:12:00+08:00',
      confidence: 0.9, validity: 'AGING', sensitivity: 'MEDIUM', cluster: '健康与作息', links: ['MEM-0057', 'MEM-0168', 'MEM-0257'], tags: ['运动', '习惯'], weight: 0.47
    },
    { id: 'MEM-0112', category: 'PREFERENCES', categoryZh: '偏好', title: '口味偏清淡少油',
      content: '23 单外卖里 17 单是清蒸或炖煮，辣度基本选「不辣」，饮料固定无糖；只有和客户吃饭时才点重口。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据 23 单外卖订单内容与备注推断', ref: 'ORD-0112' }, createdAt: '2026-01-27T12:40:00+08:00', updatedAt: '2026-10-08T12:18:00+08:00',
      confidence: 0.81, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '健康与作息', links: ['MEM-0161', 'MEM-0257', 'MEM-0057'], tags: ['饮食', '健康'], weight: 0.41
    },
    { id: 'MEM-0118', category: 'RELATIONSHIPS', categoryZh: '关系', title: '技术合伙人 A. RIVERA',
      content: '认识六年，负责工程实现，不参与对外沟通；两人约定周五下午同步一次，其余时间只用文字，不打电话。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在关系网络里手动添加并备注协作方式', ref: 'REL-0007' }, createdAt: '2026-02-03T11:22:00+08:00', updatedAt: '2026-10-02T14:30:00+08:00',
      confidence: 0.96, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '工作方式', links: ['MEM-0142', 'MEM-0292', 'MEM-0121'], tags: ['合伙人', '协作'], weight: 0.83
    },
    { id: 'MEM-0121', category: 'PREFERENCES', categoryZh: '偏好', title: '决策前先写一页纸',
      content: '四次决策记录里都能找到同一份东西：决定前一天建的一页纸文档，列三个选项和各自最坏的失败方式，写完常改掉原判断。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '决策前 24 小时内均有同名「一页纸」文档创建记录，共 4 次', ref: 'DOC-0231' }, createdAt: '2026-02-11T21:34:00+08:00', updatedAt: '2026-09-15T20:48:00+08:00',
      confidence: 0.89, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '工作方式', links: ['MEM-0031', 'MEM-0127', 'MEM-0071'], tags: ['决策', '写作'], weight: 0.76
    },
    { id: 'MEM-0127', category: 'DECISIONS', categoryZh: '决策', title: '拒绝需要交出数据的合作',
      content: '一份合作要求接入用户行为数据，在评审会上直接否掉，即使那是当年金额最大的一笔；理由写在会议纪要第一行。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在会后当晚记录的决策', ref: 'DEC-0004' }, createdAt: '2026-02-18T19:06:00+08:00', updatedAt: '2026-09-22T10:15:00+08:00',
      confidence: 0.97, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '价值与判断', links: ['MEM-0121', 'MEM-0271', 'MEM-0321'], tags: ['数据', '边界'], weight: 0.91
    },
    { id: 'MEM-0133', category: 'EVENTS', categoryZh: '事件', title: '客户提案被退回并重写三版',
      content: '2 月下旬一份提案被退回两次，第三版才通过；三版之间用户删掉了全部形容词式描述，只留数字与结论。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '文档版本历史与邮件往返记录', ref: 'DOC-0198' }, createdAt: '2026-02-25T16:48:00+08:00', updatedAt: '2026-06-05T15:20:00+08:00',
      confidence: 0.88, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '工作方式', links: ['MEM-0118', 'MEM-0023', 'MEM-0202'], tags: ['提案', '修改'], weight: 0.5
    },
    { id: 'MEM-0142', category: 'FACTS', categoryZh: '事实', title: '常用工作语言为中文与英文',
      content: '中文是日常与内部沟通语言；英文用于对外文档、设计说明和客户邮件，阅读与写作明显好于口语表达。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在引导设置中填写', ref: 'ONBOARD-04' }, createdAt: '2026-03-12T09:20:00+08:00', updatedAt: '2026-10-28T21:05:00+08:00',
      confidence: 0.98, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '工作方式', links: ['MEM-0031', 'MEM-0207', 'MEM-0316'], tags: ['语言', '协作'], weight: 0.87
    },
    { id: 'MEM-0148', category: 'GOALS', categoryZh: '目标', title: '系统学完统计学基础',
      content: '目标是自己能完整做完一次 A/B 检验并解释置信区间，不接受「调包就行」；每周留两个晚上，进度约 40%。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在季度目标里写下，并附了书目', ref: 'GOAL-0009' }, createdAt: '2026-03-18T22:10:00+08:00', updatedAt: '2026-10-13T21:44:00+08:00',
      confidence: 0.92, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '学习与阅读', links: ['MEM-0218', 'MEM-0316', 'MEM-0051'], tags: ['统计', '学习'], weight: 0.78
    },
    { id: 'MEM-0155', category: 'RELATIONSHIPS', categoryZh: '关系', title: '女儿小满九岁学钢琴',
      content: '女儿小满九岁，学钢琴两年，每周六上午上课；比赛前两周家里晚上不安排工作，练琴时间优先。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在家庭成员设置中填写', ref: 'ONBOARD-12' }, createdAt: '2026-03-26T20:15:00+08:00', updatedAt: '2026-10-26T19:08:00+08:00',
      confidence: 0.97, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '家庭与关系', links: ['MEM-0029', 'MEM-0238', 'MEM-0207'], tags: ['家庭', '孩子'], weight: 0.85
    },
    { id: 'MEM-0161', category: 'EVENTS', categoryZh: '事件', title: '一次取消五个订阅',
      content: '4 月初一次性取消 5 个订阅，只留记账、云盘和一个阅读应用；月支出从 620 元降到 210 元，之后又新开了一个。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '账单扣款中断与账户注销记录', ref: 'BILL-0071' }, createdAt: '2026-04-02T10:02:00+08:00', updatedAt: '2026-08-31T09:30:00+08:00',
      confidence: 0.87, validity: 'AGING', sensitivity: 'LOW', cluster: '财务与消费', links: ['MEM-0312', 'MEM-0099', 'MEM-0112'], tags: ['订阅', '支出'], weight: 0.43
    },    {
      id: 'MEM-0168', category: 'FACTS', categoryZh: '事实', title: '近三周平均入睡为零点四十七',
      content: '手环 21 天记录：平均入睡 00:47，深睡占比 18%，周末平均补觉 1.2 小时；有 6 天在 01:30 之后才睡。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据手环连续 21 天睡眠记录推断', ref: 'WEAR-0021' }, createdAt: '2026-04-09T08:40:00+08:00', updatedAt: '2026-10-22T07:55:00+08:00',
      confidence: 0.86, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '健康与作息', links: ['MEM-0057', 'MEM-0106', 'MEM-0231'], tags: ['睡眠', '手环'], weight: 0.6
    },
    { id: 'MEM-0174', category: 'EVENTS', categoryZh: '事件', title: '长文第一部分发出并收到反馈',
      content: '4 月 16 日发出长文第一部分，两天收到 40 余条反馈，其中 12 条指向同一个论证跳跃；用户当天记下要补一节。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '发布记录与本地评论抓取（示例数据）', ref: 'DOC-0221' }, createdAt: '2026-04-16T21:12:00+08:00', updatedAt: '2026-09-11T20:36:00+08:00',
      confidence: 0.9, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '创作与表达', links: ['MEM-0043', 'MEM-0299', 'MEM-0326'], tags: ['发布', '反馈'], weight: 0.72
    },
    { id: 'MEM-0181', category: 'FACTS', categoryZh: '事实', title: '家中备份为双盘位 NAS',
      content: '一台双盘位 NAS，每周日 02:00 做增量备份，异地副本放在一块移动硬盘里，三个月才更新一次。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据局域网设备发现与备份任务日志推断', ref: 'DEV-0017' }, createdAt: '2026-04-23T23:30:00+08:00', updatedAt: '2026-07-09T22:14:00+08:00',
      confidence: 0.8, validity: 'STALE', sensitivity: 'LOW', cluster: '居住与生活', links: ['MEM-0038', 'MEM-0312', 'MEM-0004'], tags: ['备份', '设备'], weight: 0.35
    },
    { id: 'MEM-0186', category: 'DECISIONS', categoryZh: '决策', title: '每周三设为无会议日',
      content: '从 5 月起执行，前两周被破了 3 次，第三周起才稳定；无会议日的产出约为普通日的 1.6 倍，这个数字是用户自己估的。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在日程规则里新增的硬约束', ref: 'DEC-0007' }, createdAt: '2026-04-30T09:00:00+08:00', updatedAt: '2026-10-16T09:12:00+08:00',
      confidence: 0.94, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '工作方式', links: ['MEM-0078', 'MEM-0031', 'MEM-0223'], tags: ['无会议日', '专注'], weight: 0.73
    },
    { id: 'MEM-0192', category: 'PREFERENCES', categoryZh: '偏好', title: '更接受案例型材料',
      content: '19 次文档标注里，案例段落的停留时长是理论段落的 2.4 倍；理论段落常被折叠，案例几乎都会被完整划线。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据 19 次文档阅读标注与停留时长推断', ref: 'READ-0091' }, createdAt: '2026-05-07T21:26:00+08:00', updatedAt: '2026-09-25T20:03:00+08:00',
      confidence: 0.83, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '学习与阅读', links: ['MEM-0051', 'MEM-0148', 'MEM-0316'], tags: ['学习', '材料'], weight: 0.56
    },
    { id: 'MEM-0198', category: 'RELATIONSHIPS', categoryZh: '关系', title: '导师 M. HALVORSEN',
      content: '每年见两次，只看方向不给方案；用户把「不要替我决定」写进了这段关系的备注，也说过这是他最需要的部分。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在关系网络里手动添加', ref: 'REL-0011' }, createdAt: '2026-05-14T18:20:00+08:00', updatedAt: '2026-09-06T19:40:00+08:00',
      confidence: 0.95, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '价值与判断', links: ['MEM-0142', 'MEM-0121', 'MEM-0321'], tags: ['导师', '关系'], weight: 0.77
    },
    { id: 'MEM-0202', category: 'PREFERENCES', categoryZh: '偏好', title: '自称清晨效率最高',
      content: '用户说自己清晨 6 点后最清醒，习惯先写两小时再开始一天；但过去 8 周日历里，6 点到 8 点只出现过 3 次写作记录。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在偏好面板的自述，与日程记录不一致，已标记冲突', ref: 'PREF-0061' }, createdAt: '2026-05-21T07:35:00+08:00', updatedAt: '2026-10-19T07:20:00+08:00',
      confidence: 0.62, validity: 'STALE', sensitivity: 'MEDIUM', cluster: '工作方式', links: ['MEM-0017', 'MEM-0168', 'MEM-0031'], tags: ['自述', '冲突'], weight: 0.38
    },
    { id: 'MEM-0207', category: 'EVENTS', categoryZh: '事件', title: '女儿演出提前离场去接人',
      content: '5 月 28 日下午 4 点日历写着「小满演出」，4 点 40 分提前离场去接人；当晚没有再打开工作文件。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '日历事件与位置移动记录', ref: 'CAL-0134' }, createdAt: '2026-05-28T16:05:00+08:00', updatedAt: '2026-05-29T09:10:00+08:00',
      confidence: 0.89, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '家庭与关系', links: ['MEM-0155', 'MEM-0062', 'MEM-0142'], tags: ['家庭', '演出'], weight: 0.66
    },
    { id: 'MEM-0212', category: 'GOALS', categoryZh: '目标', title: '建立六个月现金流缓冲',
      content: '缓冲金放在单独账户，按每月固定支出乘 6 计算；当前约 3.4 个月，计划明年一季度补满，不再往里加新的用途。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在财务目标里填写，并注明不与投资混用', ref: 'GOAL-0012' }, createdAt: '2026-06-04T20:40:00+08:00', updatedAt: '2026-10-05T21:18:00+08:00',
      confidence: 0.93, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '财务与消费', links: ['MEM-0071', 'MEM-0099', 'MEM-0161'], tags: ['现金流', '目标'], weight: 0.8
    },
    { id: 'MEM-0218', category: 'EVENTS', categoryZh: '事件', title: '参加六小时线下统计工作坊',
      content: '6 月 11 日一场线下统计工作坊，全程 6 小时，记了 11 页手写笔记，回来扫描进笔记库并标了三个待查问题。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '日历事件与笔记扫描记录', ref: 'LOG-0209' }, createdAt: '2026-06-11T09:30:00+08:00', updatedAt: '2026-06-12T10:05:00+08:00',
      confidence: 0.9, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '学习与阅读', links: ['MEM-0148', 'MEM-0192', 'MEM-0316'], tags: ['工作坊', '统计'], weight: 0.54
    },
    { id: 'MEM-0223', category: 'FACTS', categoryZh: '事实', title: '平均每十一分钟切换一次窗口',
      content: '六周窗口日志：日均切换 47 次，平均每 11 分钟换一次；最长连续专注 38 分钟，出现在周三上午。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据 6 周应用窗口切换日志推断', ref: 'LOG-0177' }, createdAt: '2026-06-18T18:55:00+08:00', updatedAt: '2026-10-09T19:02:00+08:00',
      confidence: 0.84, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '工作方式', links: ['MEM-0186', 'MEM-0133', 'MEM-0038'], tags: ['专注', '多任务'], weight: 0.59
    },
    { id: 'MEM-0231', category: 'DECISIONS', categoryZh: '决策', title: '二十三点半后不看工作消息',
      content: '日程里有一条 23:30 生效的提醒，连续存在 19 周；8 周屏幕记录里，执行日之后一晚的使用时长平均少 34 分钟。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '日程提醒记录与 8 周屏幕使用时间夜间段比对', ref: 'LOG-0241' }, createdAt: '2026-06-25T23:40:00+08:00', updatedAt: '2026-10-24T23:15:00+08:00',
      confidence: 0.9, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '健康与作息', links: ['MEM-0057', 'MEM-0168', 'MEM-0218'], tags: ['边界', '睡眠'], weight: 0.61
    },
    { id: 'MEM-0238', category: 'FACTS', categoryZh: '事实', title: '家庭成员为三人与一只猫',
      content: '与伴侣、女儿同住，另有一只七岁的橘猫「豆子」；女儿生日 4 月 19 日，伴侣生日 11 月 2 日，都记进了提醒。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在家庭成员设置中填写', ref: 'ONBOARD-13' }, createdAt: '2026-07-02T19:48:00+08:00', updatedAt: '2026-10-28T20:22:00+08:00',
      confidence: 0.98, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '家庭与关系', links: ['MEM-0029', 'MEM-0155', 'MEM-0062'], tags: ['家庭', '生日'], weight: 0.9
    },
    { id: 'MEM-0257', category: 'GOALS', categoryZh: '目标', title: '实际目标是体脂降到一成八',
      content: '12 周训练与饮食记录显示，用户真正盯的是体脂率而不是体重；训练以力量为主，有氧只作为补充。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据 12 周训练记录与体重体脂对照推断，用户未公开写明目标', ref: 'ACT-0074' }, createdAt: '2026-07-23T07:50:00+08:00', updatedAt: '2026-10-18T08:26:00+08:00',
      confidence: 0.79, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '健康与作息', links: ['MEM-0106', 'MEM-0112', 'MEM-0057'], tags: ['体脂', '训练'], weight: 0.57
    },
    { id: 'MEM-0264', category: 'EVENTS', categoryZh: '事件', title: '一笔四万二的设备采购',
      content: '7 月底下单一套 4.2 万元的录音与拍摄设备，分三期付款；此后两周没有新的内容产出，设备只用过两次。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '订单记录与设备首次使用时间', ref: 'BILL-0104' }, createdAt: '2026-07-30T15:12:00+08:00', updatedAt: '2026-09-18T16:40:00+08:00',
      confidence: 0.91, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '财务与消费', links: ['MEM-0161', 'MEM-0099', 'MEM-0174'], tags: ['采购', '设备'], weight: 0.48
    },
    { id: 'MEM-0271', category: 'FACTS', categoryZh: '事实', title: '反对用行为数据做差别定价',
      content: '合同模板第 7 条固定写着「不得将使用行为用于定价或续费差异化」，这条在 3 份已签合同里都保留了。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '合同模板条款比对，3 份已签合同均保留该条', ref: 'DOC-0244' }, createdAt: '2026-08-06T10:14:00+08:00', updatedAt: '2026-10-11T11:30:00+08:00',
      confidence: 0.96, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '价值与判断', links: ['MEM-0127', 'MEM-0321', 'MEM-0198'], tags: ['定价', '原则'], weight: 0.86
    },
    { id: 'MEM-0278', category: 'PREFERENCES', categoryZh: '偏好', title: '愿为可维修性多付两成',
      content: '17 次购买比较里，可拆修与长保修选项被选中的概率高约 3 倍；同类产品价差 15% 到 20% 时仍选可修的那款。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据 17 次商品对比与最终选择推断', ref: 'ORD-0140' }, createdAt: '2026-08-13T21:08:00+08:00', updatedAt: '2026-10-02T20:35:00+08:00',
      confidence: 0.82, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '价值与判断', links: ['MEM-0161', 'MEM-0316', 'MEM-0271'], tags: ['消费', '维修'], weight: 0.45
    },
    { id: 'MEM-0285', category: 'DECISIONS', categoryZh: '决策', title: '放弃付费课程改自学',
      content: '第三周停课后申请退款，改按课程目录自学；理由是进度被固定周次拖住，而自己只需要其中两章。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据课程平台登录、退款与后续笔记推断', ref: 'EDU-0022' }, createdAt: '2026-08-20T22:36:00+08:00', updatedAt: '2026-09-29T21:05:00+08:00',
      confidence: 0.78, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '学习与阅读', links: ['MEM-0148', 'MEM-0218', 'MEM-0051'], tags: ['学习', '退款'], weight: 0.42
    },
    { id: 'MEM-0292', category: 'RELATIONSHIPS', categoryZh: '关系', title: '与客户对接人沟通频率下降',
      content: '近八周与 J. PARK 的往来从每周 4 次降到 1 次，事情转给了另一位同事；最后一次会议只开了 12 分钟。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据 8 周会议与邮件往返记录推断，未做人工确认', ref: 'REL-0021' }, createdAt: '2026-08-27T17:24:00+08:00', updatedAt: '2026-10-07T18:10:00+08:00',
      confidence: 0.76, validity: 'AGING', sensitivity: 'MEDIUM', cluster: '工作方式', links: ['MEM-0118', 'MEM-0133', 'MEM-0326'], tags: ['客户', '协作'], weight: 0.39
    },
    { id: 'MEM-0299', category: 'GOALS', categoryZh: '目标', title: '小册子拆成十二章',
      content: '写作项目里已经躺着 12 个章节文件，每章目标 8,000 到 12,000 字；第 4 章「记忆的所有权」提纲改过两次。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '写作项目目录中的 12 个章节文件与版本记录', ref: 'DOC-0251' }, createdAt: '2026-09-03T21:40:00+08:00', updatedAt: '2026-10-30T22:20:00+08:00',
      confidence: 0.94, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '创作与表达', links: ['MEM-0094', 'MEM-0043', 'MEM-0174'], tags: ['结构', '写作'], weight: 0.82
    },
    { id: 'MEM-0312', category: 'FACTS', categoryZh: '事实', title: '订阅类支出使用率不足三成',
      content: '9 项订阅里 6 项月内打开不足 3 次；账单显示总额回升到 340 元，但实际使用集中在两个应用上。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据 5 个月账单与登录记录交叉推断', ref: 'BILL-0122' }, createdAt: '2026-09-24T09:36:00+08:00', updatedAt: '2026-10-27T10:02:00+08:00',
      confidence: 0.83, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '财务与消费', links: ['MEM-0161', 'MEM-0099', 'MEM-0181'], tags: ['订阅', '支出'], weight: 0.46
    },
    { id: 'MEM-0316', category: 'FACTS', categoryZh: '事实', title: '设计出身自学脚本与统计',
      content: '工业设计本科，自学脚本用于排版自动化；统计学到回归部分，自评「能读懂，不能独立推导」。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在能力自评里填写，附一次脚本失败的例子', ref: 'ONBOARD-31' }, createdAt: '2026-10-02T20:18:00+08:00', updatedAt: '2026-10-25T21:40:00+08:00',
      confidence: 0.93, validity: 'ACTIVE', sensitivity: 'LOW', cluster: '学习与阅读', links: ['MEM-0148', 'MEM-0051', 'MEM-0192'], tags: ['能力', '自学'], weight: 0.68
    },
    { id: 'MEM-0321', category: 'DECISIONS', categoryZh: '决策', title: '只公布方法论不公布客户',
      content: '决定对外案例一律匿名化，只写方法与结果区间，不写客户名和具体金额；这条比多拿到两个案例更重要。',
      source: { type: 'USER_PROVIDED', typeZh: '用户主动提供', label: '用户在对外沟通准则里写下', ref: 'DEC-0012' }, createdAt: '2026-10-08T10:26:00+08:00', updatedAt: '2026-10-29T09:15:00+08:00',
      confidence: 0.97, validity: 'ACTIVE', sensitivity: 'HIGH', cluster: '价值与判断', links: ['MEM-0271', 'MEM-0127', 'MEM-0198'], tags: ['匿名', '原则'], weight: 0.88
    },
    { id: 'MEM-0326', category: 'RELATIONSHIPS', categoryZh: '关系', title: '合作编辑承担了事实核查',
      content: '八次修订记录显示，改动集中在数据与引文，正文结构只动过两处；编辑 L. YU 实际上承担了事实核查。',
      source: { type: 'INFERENCE', typeZh: '模型推断', label: '据 8 次文档修订记录逐段比对推断', ref: 'DOC-0264' }, createdAt: '2026-10-14T16:32:00+08:00', updatedAt: '2026-11-02T17:18:00+08:00',
      confidence: 0.8, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '创作与表达', links: ['MEM-0174', 'MEM-0292', 'MEM-0299'], tags: ['编辑', '核查'], weight: 0.51
    },
    { id: 'MEM-0333', category: 'GOALS', categoryZh: '目标', title: '明年春天开一门小课',
      content: '10 月的想法清单里写着一行：6 次课、每次 90 分钟、上限 20 人、不录播；只有这一行，主题顺序都还空着。',
      source: { type: 'OBSERVED', typeZh: '行为观察', label: '想法清单文档中 10 月新增的一条记录', ref: 'DOC-0258' }, createdAt: '2026-10-27T22:50:00+08:00', updatedAt: '2026-11-05T21:12:00+08:00',
      confidence: 0.88, validity: 'ACTIVE', sensitivity: 'MEDIUM', cluster: '学习与阅读', links: ['MEM-0094', 'MEM-0299', 'MEM-0148'], tags: ['教学', '计划'], weight: 0.64
    }
  ];

  /* ===========================================================================
   * 4. memoryClusters — 8 个记忆簇
   *    count 为该簇内实际记忆条目数（与 memories[].cluster 完全对应）
   *    center 是 3D 场景中的建议坐标，半径 6–11，八簇在球面上错开分布
   * ======================================================================== */

  DATA.memoryClusters = [
    { id: 'c-work', name: '工作方式', zh: '工作方式', color: '#55DDF5', count: 14, center: [8.4, 1.8, 2.2], radius: 8.9, desc: '深度工作时段、会议习惯、与合伙人的协作节奏。' },
    { id: 'c-health', name: '健康与作息', zh: '健康与作息', color: '#5FD6A8', count: 6, center: [-3.1, 7.6, -4.8], radius: 9.5, desc: '睡眠时长、运动断档、饮食口味与身体目标。' },
    { id: 'c-family', name: '家庭与关系', zh: '家庭与关系', color: '#9178FF', count: 5, center: [-8.2, -2.4, 3.6], radius: 9.3, desc: '伴侣排班、女儿学琴、与父母的固定通话。' },
    { id: 'c-learning', name: '学习与阅读', zh: '学习与阅读', color: '#91DFFF', count: 7, center: [2.9, 6.9, 5.4], radius: 9.2, desc: '非虚构阅读、统计学进度、课程取舍与教学计划。' },
    { id: 'c-money', name: '财务与消费', zh: '财务与消费', color: '#E0B15C', count: 6, center: [-6.4, -5.8, -2.1], radius: 8.9, desc: '收入结构、现金流缓冲、订阅与设备支出。' },
    { id: 'c-life', name: '居住与生活', zh: '居住与生活', color: '#7E8999', count: 4, center: [5.7, -6.2, 4.9], radius: 9.7, desc: '通勤方式、工作台设备、工作室位置与备份习惯。' },
    { id: 'c-create', name: '创作与表达', zh: '创作与表达', color: '#C98CFF', count: 5, center: [-1.8, -3.4, 8.6], radius: 9.4, desc: '长文、小册子章节、发布反馈与合作编辑。' },
    { id: 'c-values', name: '价值与判断', zh: '价值与判断', color: '#E06767', count: 5, center: [3.4, -1.2, -8.3], radius: 9.1, desc: '数据边界、定价原则、匿名化与导师关系。' }
  ];
  /* ===========================================================================
   * 5. cognitive — 七维认知画像
   *    score 为当前估计值，confidence 为对该估计的置信度；两者不相等是刻意设计。
   *    conflicts 数组中的记忆 id 表示与结论方向相反的条目，全部真实存在。
   * ======================================================================== */

  DATA.cognitive = {
    summary: {
      contextCoverage: 0.78,
      inferenceHealth: 0.81,
      conflictCount: 2,
      lastRebuild: '2026-11-06T22:10:00+08:00',
      scope: '基于 1,284 条记忆中的 52 条高权重条目重建；其余条目只参与索引，不参与画像。',
      note: 'contextCoverage 指画像对近 90 天上下文的覆盖比例，非准确率。'
    },
    dimensions: [
      {
        id: 'preferences', name: 'Personal Preferences', zh: '个人偏好', score: 0.86, confidence: 0.83,
        summary: '在时间安排上明显偏向上午处理高认知负荷任务，并把会议压缩到周二、周三的下午。',
        evidence: ['MEM-0031', 'MEM-0088', 'MEM-0121'], inference: '据近 6 周日程与用户自述交叉推断。',
        conflicts: ['MEM-0202'], updatedAt: '2026-11-06T22:10:00+08:00',
        factors: [{ k: '自主决定', v: 0.9 }, { k: '外部约束', v: 0.4 }, { k: '身体节律', v: 0.7 }]
      },
      {
        id: 'patterns', name: 'Behavioral Patterns', zh: '行为模式', score: 0.79, confidence: 0.71,
        summary: '每周三的无会议日产出最高，但注意力窗口短，平均每 11 分钟切换一次任务。',
        evidence: ['MEM-0223', 'MEM-0078', 'MEM-0186', 'MEM-0023'],
        inference: '据 6 周窗口日志与日历联合统计推断，未做对照实验，因果性不成立。',
        conflicts: [], updatedAt: '2026-11-06T22:10:00+08:00',
        factors: [{ k: '任务类型', v: 0.7 }, { k: '环境干扰', v: 0.6 }, { k: '睡眠时长', v: 0.5 }]
      },
      {
        id: 'goals', name: 'Goal Orientation', zh: '目标取向', score: 0.82, confidence: 0.76,
        summary: '目标集中在「可持续的独立」：现金流、睡眠、写作各占一条，短期收益让位于长期可控性。',
        evidence: ['MEM-0094', 'MEM-0148', 'MEM-0212', 'MEM-0057'],
        inference: '据 4 条目标类记忆与 2 次决策复盘共同归纳。',
        conflicts: ['MEM-0264'], updatedAt: '2026-11-06T22:10:00+08:00',
        factors: [{ k: '长期收益', v: 0.85 }, { k: '即时满足', v: 0.45 }, { k: '家庭责任', v: 0.65 }]
      },
      {
        id: 'decisionContext', name: 'Decision Context', zh: '决策情境', score: 0.74, confidence: 0.68,
        summary: '重大决定前会先写一页纸并列出失败路径，决策周期约 3 天，很少在会议现场拍板。',
        evidence: ['MEM-0121', 'MEM-0127', 'MEM-0071', 'MEM-0285'],
        inference: '据 4 次决策记录的时间跨度与前置文档推断。',
        conflicts: [], updatedAt: '2026-11-05T21:46:00+08:00',
        factors: [{ k: '书面材料', v: 0.8 }, { k: '时间压力', v: 0.35 }, { k: '他人意见', v: 0.4 }]
      },
      {
        id: 'risk', name: 'Risk Profile', zh: '风险特质', score: 0.58, confidence: 0.62,
        summary: '对不可逆风险容忍度低（数据、声誉），对可逆的金钱风险容忍度中等偏高（设备、试错）。',
        evidence: ['MEM-0127', 'MEM-0071', 'MEM-0264', 'MEM-0278'],
        inference: '据 4 次取舍记录按「可逆性」维度重新归类推断。',
        conflicts: [], updatedAt: '2026-11-04T20:12:00+08:00',
        factors: [{ k: '可逆性', v: 0.9 }, { k: '金额规模', v: 0.5 }, { k: '声誉影响', v: 0.8 }]
      },
      {
        id: 'knowledge', name: 'Knowledge Structure', zh: '知识结构', score: 0.66, confidence: 0.74,
        summary: '设计方法扎实、工程实现偏工具化、统计仍在补课；跨领域迁移强于单点深度。',
        evidence: ['MEM-0316', 'MEM-0148', 'MEM-0218', 'MEM-0051'],
        inference: '据能力自评、学习记录与阅读结构推断，无任何外部测评数据。',
        conflicts: [], updatedAt: '2026-11-03T19:30:00+08:00',
        factors: [{ k: '实践密度', v: 0.7 }, { k: '系统训练', v: 0.4 }, { k: '迁移能力', v: 0.8 }]
      },
      {
        id: 'confidence', name: 'Confidence Profile', zh: '置信自评', score: 0.71, confidence: 0.65,
        summary: '对自我叙述的置信度低于对行为记录的置信度；自述与记录冲突时，系统默认采信记录并标注差异。',
        evidence: ['MEM-0202', 'MEM-0017', 'MEM-0168'],
        inference: '据 3 组自述与记录的落差推断，样本偏小，仅供参考。',
        conflicts: ['MEM-0202'], updatedAt: '2026-11-06T21:58:00+08:00',
        factors: [{ k: '自述一致性', v: 0.4 }, { k: '记录完整度', v: 0.75 }, { k: '时间衰减', v: 0.6 }]
      }
    ],
    preferenceEdit: {
      field: '深度工作时间段',
      from: '上午 09:00–11:30',
      to: '清晨 06:00–08:00',
      reason: '用户在偏好面板主动修改，理由是「上午已经被会议吃掉了」。',
      affected: [
        { dim: 'patterns', impact: 'HIGH', note: '周三无会议日的专注块需整体前移，最长连续专注可能被通勤切断。' },
        { dim: 'goals', impact: 'MEDIUM', note: '写作目标依赖清晨两小时，需重新核算每周可用字数。' },
        { dim: 'risk', impact: 'LOW', note: '作息前移会压缩睡眠窗口，与「睡眠七小时」目标存在轻微冲突。' }
      ],
      recomputeSteps: ['定位受影响维度', '回查 18 条相关记忆', '重估行为模式权重', '生成新的置信度并写入审计']
    }
  };

  /* ===========================================================================
   * 6. agent — 九步执行链、工具清单、三个预设任务
   *    所有执行均为本地模拟，不调用任何外部服务。
   * ======================================================================== */

  DATA.agent = {
    steps: [
      { id: 'intent', name: 'UNDERSTAND INTENT', zh: '理解意图', desc: '把自然语言请求拆成可执行的动作、时间范围与优先级，标出不明确的假设。' },
      { id: 'retrieve', name: 'RETRIEVE MEMORY', zh: '检索记忆', desc: '在个人记忆网络中按语义与时间双路召回，返回带权重与来源的候选条目。' },
      { id: 'context', name: 'BUILD CONTEXT', zh: '组装上下文', desc: '把命中的记忆、当前日程与硬约束装进有限窗口，冲突项显式标注而不是悄悄丢掉。' },
      { id: 'plan', name: 'GENERATE PLAN', zh: '生成计划', desc: '产出多个候选方案，按冲突数量、家庭时间与疲劳风险排序，只保留可解释的那一个。' },
      { id: 'perm', name: 'CHECK PERMISSIONS', zh: '检查权限', desc: '逐项核对所需权限范围与当前授权状态，缺失即中止，不降级为「悄悄试一下」。' },
      { id: 'approve', name: 'REQUEST APPROVAL', zh: '请求确认', desc: '把计划、涉及权限与不可撤销的副作用一起呈现，等待用户明确点击。' },
      { id: 'execute', name: 'EXECUTE ACTION', zh: '执行动作', desc: '按确认结果执行，每一步都写入本地审计；失败时保留现场而不回滚成空白。' },
      { id: 'verify', name: 'VERIFY RESULT', zh: '验证结果', desc: '回读执行结果，检查冲突、遗漏与被拒绝的条目，给出可核对的通过项数量。' },
      { id: 'done', name: 'COMPLETE', zh: '完成', desc: '交付产物与审计记录，把控制权交还用户，并说明哪些部分没有被验证。' }
    ],
    tools: [
      { id: 'calendar.read', name: '日历读取', scope: 'read', risk: 'LOW', desc: '读取演示日历中的事件与空闲块。' },
      { id: 'calendar.write', name: '日历写入', scope: 'write', risk: 'HIGH', desc: '创建或修改日程块，外部账户需二次确认。' },
      { id: 'docs.read', name: '文档读取', scope: 'read', risk: 'LOW', desc: '读取本地演示文档的标题与摘要。' },
      { id: 'docs.write', name: '文档写入', scope: 'write', risk: 'MEDIUM', desc: '生成周报、计划等新文档，不覆盖原文件。' },
      { id: 'mail.read', name: '邮件读取', scope: 'read', risk: 'HIGH', desc: '读取邮件正文与发件人，当前仅使用本地示例邮件。' },
      { id: 'mail.compose', name: '邮件拟稿', scope: 'write', risk: 'HIGH', desc: '生成回复草稿；不发送，发送需单独授权。' },
      { id: 'local.file.write', name: '本地文件写入', scope: 'write', risk: 'MEDIUM', desc: '在演示目录写入设置与导出文件。' }
    ],
    tasks: [
      {
        id: 'T-WEEK',
        label: '整理本周工作并安排下周日程',
        prompt: '帮我整理本周的重要工作，并根据我的偏好安排下周的日程。',
        chips: ['本周工作', '下周日程', '阅读型任务'],
        usedMemory: ['MEM-0031', 'MEM-0088', 'MEM-0121', 'MEM-0142'],
        permissions: [{ scope: 'calendar.write', reason: '需要在日历中创建 5 个日程块', risk: 'HIGH' }],
        steps: [
          { id: 'intent', detail: '解析请求中的两个动作：回顾本周、编排下周；识别时间范围与优先级。', output: '意图：周报整理 + 下周日程编排；范围 11-02 至 11-08；优先保证深度工作块。', ms: 420 },
          { id: 'retrieve', detail: '在记忆网络中检索与工作节奏、会议偏好、当前项目相关的条目。', output: '命中 18 条记忆，其中 4 条高权重：MEM-0031、MEM-0088、MEM-0121、MEM-0142。', ms: 610 },
          { id: 'context', detail: '组装上下文：时区、可用时段、本周已发生事件、三条硬约束。', output: '上下文包 3.2k tokens；标注 2 处冲突（清晨偏好与日程记录不一致）。', ms: 380 },
          { id: 'plan', detail: '生成候选计划并做可行性检查：冲突、通勤、家庭时间。', output: '生成 3 个候选方案，选出冲突最少的一个，共 5 个日程块。', ms: 720 },
          { id: 'perm', detail: '检查执行计划所需的权限范围与当前授权状态。', output: '需要 calendar.write；当前已授权，但写入外部账户仍需二次确认。', ms: 240 },
          { id: 'approve', detail: '把计划与权限影响一起呈现，等待明确确认。', output: '已请求确认：5 个日程块 + 1 份周报草稿；等待用户点击。', ms: 900 },
          { id: 'execute', detail: '按确认结果写入日程，并生成周报草稿。', output: '写入 5 个日程块（本地模拟），生成 640 字周报草稿。', ms: 1240 },
          { id: 'verify', detail: '回读写入结果，检查时间冲突与遗漏项。', output: '回读 5 条，0 冲突；周报覆盖 4 个项目，1 项缺数据已标注。', ms: 460 },
          { id: 'done', detail: '整理产物与审计记录，把控制权交还用户。', output: '完成；生成审计条目 A-2042，控制权已交还。', ms: 180 }
        ],
        plan: [
          { t: '周一 06:00–08:00', d: '深度写作：小册第 4 章提纲（按新偏好前移）' },
          { t: '周一 15:00', d: '与 A. RIVERA 文字同步，不开会' },
          { t: '周三 全天', d: '无会议日，只留 1 个 90 分钟评审' },
          { t: '周四 14:00', d: '客户提案第二版复核（外部客户指定时段）' },
          { t: '周五 16:30', d: '周报定稿 + 下周风险清单' }
        ],
        result: {
          title: '本周工作摘要与下周日程草案',
          summary: '本周完成 3 个交付、1 个提案被退回重写；下周安排 5 个日程块，其中 2 个为深度工作，全部避开上午 11 点后的会议窗口。',
          items: ['本周交付：品牌手册终稿、组件库说明、客户提案第二版', '本周未完成：小册第 4 章仍停在提纲，累计 2 次推迟', '下周优先：周三无会议日用于写作，周四下午留给客户'],
          verify: {
            checks: ['5 个日程块与现有事件无时间冲突', '深度工作块未被会议侵占', '周报中的 4 个项目均可回溯到具体文档'],
            passed: 3, total: 3
          }
        }
      },
      {
        id: 'T-TRIP',
        label: '根据偏好制定旅行计划',
        prompt: '下个月想带家人出去四天，别太赶，按我的习惯安排。',
        chips: ['四天行程', '带家人', '不要太赶'],
        usedMemory: ['MEM-0029', 'MEM-0155', 'MEM-0051', 'MEM-0112'],
        permissions: [{ scope: 'calendar.write', reason: '需要在日历中预留 4 天并标注通勤时间', risk: 'HIGH' }],
        steps: [
          { id: 'intent', detail: '识别出行人数、天数与「不要赶」这一隐含约束。', output: '意图：4 天家庭出行，节奏舒缓；硬约束：避开伴侣夜班、女儿周六钢琴课。', ms: 380 },
          { id: 'retrieve', detail: '召回家庭成员作息、饮食偏好与阅读习惯。', output: '命中 11 条，关键 4 条：MEM-0029、MEM-0155、MEM-0051、MEM-0112。', ms: 540 },
          { id: 'context', detail: '把排班、课程与通勤时间叠加到候选日期上。', output: '可用窗口收窄到 12 月 11–14 日；每天单程移动不超过 90 分钟。', ms: 450 },
          { id: 'plan', detail: '生成三条候选路线，按「每日移动时长」排序。', output: '三个方案：近郊三晚、湖区两晚、山间民宿三晚；推荐近郊方案。', ms: 660 },
          { id: 'perm', detail: '核对写入日历与读取家庭日程的权限。', output: 'calendar.write 已授权；家庭日程仅读取时段，不读取事件内容。', ms: 210 },
          { id: 'approve', detail: '呈现路线、预算区间与需要确认的两处不确定项。', output: '已请求确认：日期、住宿档次、是否接受一次 2 小时车程。', ms: 780 },
          { id: 'execute', detail: '在日历中占位 4 天，并生成待办清单。', output: '写入 4 天占位（本地模拟），生成 9 条待办，未预订任何真实服务。', ms: 1020 },
          { id: 'verify', detail: '检查与既有日程、钢琴课、夜班的冲突。', output: '0 冲突；周六钢琴课已自动跳过，改为周日上午补课。', ms: 380 },
          { id: 'done', detail: '交付行程草案并注明未验证项。', output: '完成；住宿价格与开放时间为示例值，未被验证。', ms: 160 }
        ],
        plan: [
          { t: '第 1 天 上午', d: '10:00 出发，车程 80 分钟，午后到达' },
          { t: '第 1 天 下午', d: '住处附近步行，不安排景点' },
          { t: '第 2 天 全天', d: '一个主活动 + 午睡窗口，预留 2 小时空白' },
          { t: '第 3 天 全天', d: '自由活动，雨天备选室内方案' },
          { t: '第 4 天 上午', d: '11:00 返程，避开晚高峰' }
        ],
        result: {
          title: '四天家庭出行草案（未预订）',
          summary: '按「每天只安排一件事」的节奏排出四天，避开伴侣夜班与女儿钢琴课；住宿与票价均为示例区间，未做任何真实预订。',
          items: ['日期：12 月 11–14 日，周四出发避开周末人流', '节奏：每日单程移动 ≤90 分钟，午睡窗口固定 13:00–14:00', '饮食：已按清淡口味标注 3 家备选，未验证营业状态'],
          verify: {
            checks: ['与伴侣夜班排班无重叠', '女儿钢琴课已改期而非取消', '四天均未安排超过 2 小时的连续移动'],
            passed: 3, total: 3
          }
        }
      },
      {
        id: 'T-MAIL',
        label: '汇总重要邮件并拟定回复',
        prompt: '把这周的重要邮件汇总一下，帮我拟三封回复。',
        chips: ['本周邮件', '三封回复', '只拟稿不发送'],
        usedMemory: ['MEM-0088', 'MEM-0031', 'MEM-0121'],
        permissions: [
          { scope: 'mail.read', reason: '需要读取本周邮件以判断重要性', risk: 'HIGH' },
          { scope: 'mail.compose', reason: '需要生成 3 封回复草稿（不发送）', risk: 'HIGH' }
        ],
        steps: [
          { id: 'intent', detail: '区分「汇总」与「回复」两类动作，确认不包含发送。', output: '意图：汇总 + 拟稿；明确排除发送动作。', ms: 360 },
          { id: 'retrieve', detail: '召回沟通偏好与回复风格的记忆。', output: '命中 9 条，关键 3 条：MEM-0088、MEM-0031、MEM-0121。', ms: 480 },
          { id: 'context', detail: '装入本周邮件摘要与三条风格约束（简短、带结论、不承诺时间）。', output: '上下文包 2.1k tokens，包含 12 封示例邮件。', ms: 340 },
          { id: 'plan', detail: '按发件人重要性排序，选出 3 封必须回复的。', output: '选出 3 封：客户提案反馈、合作邀约、供应商延期说明。', ms: 590 },
          { id: 'perm', detail: '检查 mail.read 与 mail.compose 的授权状态。', output: 'mail.read 已撤销、mail.compose 待确认；本次仅使用本地模拟邮箱。', ms: 230 },
          { id: 'approve', detail: '说明「未接入真实邮箱」，请用户确认是否继续在示例数据上演示。', output: '已请求确认：在 12 封本地示例邮件上继续，不接触任何真实账户。', ms: 700 },
          { id: 'execute', detail: '生成三封草稿，保存为本地文本，不进入任何发件队列。', output: '生成 3 封草稿（合计 410 字），保存到演示目录。', ms: 880 },
          { id: 'verify', detail: '检查草稿是否包含具体承诺、金额或日期。', output: '3 封均无硬承诺；1 封含「下周三前」已改写为「本周内」。', ms: 320 },
          { id: 'done', detail: '交付草稿与「未发送」状态。', output: '完成；3 封草稿状态为「未发送」，未产生任何外部请求。', ms: 150 }
        ],
        plan: [
          { t: '第 1 封', d: '回复客户提案反馈：确认收到，给出两处修改方向' },
          { t: '第 2 封', d: '回复合作邀约：先问数据条款，不直接答应' },
          { t: '第 3 封', d: '回复供应商延期：要求新的交付日期，不接受口头保证' }
        ],
        result: {
          title: '本周邮件摘要与三封草稿',
          summary: '12 封示例邮件中筛出 3 封需要回复的，全部按「先结论、后细节、不硬承诺」写成草稿；一封邮件里的时间承诺已改为模糊表述。',
          items: ['摘要：2 封需决策、5 封仅需知会、5 封可归档', '草稿：3 封，合计 410 字，状态均为「未发送」', '风险：合作邀约中的数据条款需人工确认，已标红'],
          verify: {
            checks: ['草稿中无具体金额与交付日期承诺', '未触发任何发送或外部请求', '3 封草稿的发件人均为示例地址'],
            passed: 3, total: 3
          }
        }
      }
    ]
  };
  /* ===========================================================================
   * 7. sources — 十个潜在数据入口
   *    状态：SIMULATED 2 / PAUSED 2 / NOT_CONNECTED 6
   *    注意：本系统不存在 CONNECTED 状态；SIMULATED 也只是「本地样例」而非真实账户。
   *    icon 取值限定在 dom.icon() 图标集内（见 CONTRACT §9）。
   * ======================================================================== */

  DATA.sources = [
    {
      id: 'email', name: 'EMAIL', zh: '电子邮件', icon: 'data', type: 'STRUCTURED', typeZh: '结构化文本',
      status: 'NOT_CONNECTED', statusZh: '未连接', scope: '尚未授权任何范围', scopeList: [],
      lastSync: null, processing: '待授权', retention: '未设定', records: 0, risk: 'HIGH',
      desc: '收件箱是意图密度最高的入口，也是隐私风险最高的入口；需要正文读取、发件人识别与附件解析三项独立授权。',
      demoNote: '模拟连接 · 未接入真实账户'
    },
    {
      id: 'calendar', name: 'CALENDAR', zh: '日历', icon: 'sun', type: 'STRUCTURED', typeZh: '结构化文本',
      status: 'SIMULATED', statusZh: '演示已开启', scope: '演示范围：仅读取本地样例日程',
      scopeList: ['读取事件标题与时间', '读取空闲块', '写入需二次确认'],
      lastSync: '2026-11-06T22:38:00+08:00', processing: '本地规则抽取（模拟）', retention: '仅本次会话', records: 312, risk: 'MEDIUM',
      desc: '唯一默认开启的时间入口。让智能体知道「什么时候不能打扰」，也是所有日程类动作的写入目标。',
      demoNote: '模拟连接 · 未接入真实账户'
    },
    {
      id: 'documents', name: 'DOCUMENTS', zh: '文档', icon: 'edit', type: 'LONG_TEXT', typeZh: '长文本',
      status: 'SIMULATED', statusZh: '演示已开启', scope: '演示范围：读取 6 份样例文档的标题与摘要',
      scopeList: ['读取标题与摘要', '读取字数与版本', '不读取正文全文'],
      lastSync: '2026-11-06T22:20:00+08:00', processing: '本地分块索引（模拟）', retention: '随会话结束清空', records: 148, risk: 'MEDIUM',
      desc: '创作类记忆的主要来源。当前只索引摘要与版本号，正文全文需要单独授权，避免把未完成的草稿变成「事实」。',
      demoNote: '模拟连接 · 未接入真实账户'
    },
    {
      id: 'images', name: 'IMAGES', zh: '图像', icon: 'fullscreen', type: 'MEDIA', typeZh: '二进制媒体',
      status: 'PAUSED', statusZh: '已暂停', scope: '曾授权：读取相册缩略图与拍摄时间',
      scopeList: ['读取缩略图', '读取拍摄时间与地点'],
      lastSync: '2026-09-18T19:05:00+08:00', processing: '本地视觉描述（模拟）', retention: '30 天后自动清除', records: 1, risk: 'HIGH',
      desc: '图像能补上文字记不住的生活细节，但人脸与地点是无法撤回的信息；演示中曾开启两周后主动暂停。',
      demoNote: '模拟连接 · 未接入真实账户'
    },
    {
      id: 'voice', name: 'VOICE', zh: '语音', icon: 'play', type: 'AUDIO', typeZh: '音频流',
      status: 'NOT_CONNECTED', statusZh: '未连接', scope: '尚未授权任何范围', scopeList: [],
      lastSync: null, processing: '待授权', retention: '未设定', records: 0, risk: 'HIGH',
      desc: '语音是最自然也最难撤回的入口。默认关闭，且要求「先转写、后删除原始音频」的两段式授权。',
      demoNote: '模拟连接 · 未接入真实账户'
    },
    {
      id: 'browser', name: 'BROWSER', zh: '浏览器', icon: 'search', type: 'EVENT_STREAM', typeZh: '行为事件流',
      status: 'NOT_CONNECTED', statusZh: '未连接', scope: '尚未授权任何范围', scopeList: [],
      lastSync: null, processing: '待授权', retention: '未设定', records: 0, risk: 'HIGH',
      desc: '阅读轨迹能反映真实兴趣，但也最容易变成监控。授权粒度为「域名级」，可按站点单独关闭。',
      demoNote: '模拟连接 · 未接入真实账户'
    },
    {
      id: 'mobile', name: 'MOBILE', zh: '手机', icon: 'route', type: 'EVENT_STREAM', typeZh: '行为事件流',
      status: 'PAUSED', statusZh: '已暂停', scope: '曾授权：仅位置与屏幕使用时长',
      scopeList: ['位置轨迹（粗粒度）', '屏幕使用时长'],
      lastSync: '2026-10-02T08:30:00+08:00', processing: '端上聚合（模拟）', retention: '7 天后降采样', records: 0, risk: 'HIGH',
      desc: '位置与使用时长的组合足以还原一个人的一天，因此演示中只保留粗粒度聚合，并且在 10 月主动暂停。',
      demoNote: '模拟连接 · 未接入真实账户'
    },
    {
      id: 'desktop', name: 'DESKTOP', zh: '桌面', icon: 'home', type: 'EVENT_STREAM', typeZh: '行为事件流',
      status: 'NOT_CONNECTED', statusZh: '未连接', scope: '尚未授权任何范围', scopeList: [],
      lastSync: null, processing: '待授权', retention: '未设定', records: 0, risk: 'MEDIUM',
      desc: '窗口切换与文件创建时间能解释「时间去哪了」。只采事件时间戳，不采窗口内容，这是可以接受的最小粒度。',
      demoNote: '模拟连接 · 未接入真实账户'
    },
    {
      id: 'wearables', name: 'WEARABLES', zh: '穿戴设备', icon: 'sync', type: 'TELEMETRY', typeZh: '时序遥测',
      status: 'NOT_CONNECTED', statusZh: '未连接', scope: '尚未授权任何范围', scopeList: [],
      lastSync: null, processing: '待授权', retention: '未设定', records: 0, risk: 'MEDIUM',
      desc: '睡眠与心率是推断「状态」而非「行为」的关键信号；只取日级聚合，不取秒级原始波形。',
      demoNote: '模拟连接 · 未接入真实账户'
    },
    {
      id: 'input', name: 'INPUT', zh: '输入行为', icon: 'settings', type: 'INPUT', typeZh: '输入行为',
      status: 'NOT_CONNECTED', statusZh: '未连接', scope: '尚未授权任何范围', scopeList: [],
      lastSync: null, processing: '待授权', retention: '未设定', records: 0, risk: 'HIGH',
      desc: '键击节奏与输入法候选能反映犹豫与改写，但它离密码只有一步之遥，因此默认永久关闭。',
      demoNote: '模拟连接 · 未接入真实账户'
    }
  ];

  /* ===========================================================================
   * 8. pipeline — 数据从入口到记忆的四个阶段
   * ======================================================================== */

  DATA.pipeline = [
    { id: 'capture', name: 'CAPTURE', zh: '采集', desc: '在授权范围内取到原始信号，未授权即跳过，不做「先存下来再说」。', note: '采集端只做最小化裁剪，原始数据不落地到长期存储。' },
    { id: 'ingest', name: 'INGESTION', zh: '接入', desc: '结构化、去重、归一化时间与实体，把不同来源对齐到同一条时间轴。', note: '同一件事来自日历与文档时，保留两条来源而不是合并成一条。' },
    { id: 'govern', name: 'GOVERNANCE', zh: '治理', desc: '判定敏感级别、来源类型与有效期；推断类内容必须写明依据，否则不得入库。', note: '治理阶段是唯一有权驳回写入的环节。' },
    { id: 'store', name: 'MEMORY STORE', zh: '记忆存储', desc: '写入记忆网络，建立语义与时间双维度连接，并同步更新关联密度与簇归属。', note: '写入后即可被检索，但画像重建是异步的，最长延迟 15 分钟。' }
  ];

  /* ===========================================================================
   * 9. models — 四个可选模型（全部为示例供应商，性能数字为示例值）
   * ======================================================================== */

  DATA.models = [
    {
      id: 'model-a', name: 'MODEL A', zh: '通用推理模型', provider: '示例供应商 · 演示',
      intelligence: 0.94, latencyMs: 820, costPer1k: 0.042, privacy: 0.45, availability: 0.99,
      contextWindow: '128k', modality: '文本',
      bestFor: ['Reasoning', 'Summarization'],
      weakness: '隐私等级低，敏感上下文不能出本机；长文档成本上升快。',
      note: '性能数字为示例值，非真实测试结果。', color: '#55DDF5'
    },
    {
      id: 'model-b', name: 'MODEL B', zh: '长上下文模型', provider: '示例供应商 · 演示',
      intelligence: 0.89, latencyMs: 1150, costPer1k: 0.028, privacy: 0.40, availability: 0.97,
      contextWindow: '512k', modality: '文本',
      bestFor: ['Long Context', 'Retrieval'],
      weakness: '首字延迟高，短请求不划算；对指令顺序敏感。',
      note: '性能数字为示例值，非真实测试结果。', color: '#9178FF'
    },
    {
      id: 'model-c', name: 'MODEL C', zh: '视觉理解模型', provider: '示例供应商 · 演示',
      intelligence: 0.81, latencyMs: 690, costPer1k: 0.061, privacy: 0.38, availability: 0.96,
      contextWindow: '32k + 图像', modality: '文本 + 图像',
      bestFor: ['Vision', 'OCR'],
      weakness: '单张成本最高；对小字与手写体识别不稳定。',
      note: '性能数字为示例值，非真实测试结果。', color: '#5FD6A8'
    },
    {
      id: 'local', name: 'LOCAL MODEL', zh: '本地私有模型', provider: '本机运行 · 演示',
      intelligence: 0.72, latencyMs: 240, costPer1k: 0, privacy: 0.98, availability: 0.93,
      contextWindow: '32k', modality: '文本',
      bestFor: ['Private Processing', 'Offline'],
      weakness: '复杂推理明显弱于云端模型；显存受限，长上下文会截断。',
      note: '性能数字为示例值；延迟为端上模拟值，非实测。', color: '#E0B15C'
    }
  ];
  /* ===========================================================================
   * 10. routing — 任务到模型的路由偏好与候选结果
   *     规则可被单独关闭；「隐私优先」是唯一不可关闭的规则。
   * ======================================================================== */

  DATA.routing = {
    tasks: [
      { id: 'reasoning', zh: '复杂推理', name: 'Reasoning' },
      { id: 'summary', zh: '摘要生成', name: 'Summarization' },
      { id: 'vision', zh: '图像理解', name: 'Vision' },
      { id: 'private', zh: '私有处理', name: 'Private Processing' }
    ],
    rules: [
      { id: 'r1', cond: '隐私等级 = HIGH', action: '强制本地模型', zh: '隐私优先', locked: true, note: '不可关闭；即使本地模型置信度更低也先走本地。' },
      { id: 'r2', cond: '预计成本 > ¥0.05', action: '切换到长上下文模型', zh: '成本护栏', locked: false, note: '单次调用超过 5 分钱时优先选单价更低的候选。' },
      { id: 'r3', cond: '响应预算 < 500 毫秒', action: '优先本地模型', zh: '延迟优先', locked: false, note: '交互式补全类请求，等待超过半秒即视为失败。' },
      { id: 'r4', cond: '输入包含图像', action: '只路由到视觉模型', zh: '模态匹配', locked: true, note: '文本模型无法处理图像，不做降级重试。' },
      { id: 'r5', cond: '外部服务不可用', action: '降级到本地模型并标注', zh: '降级标注', locked: false, note: '降级必须在结果中写明「由本地模型生成」。' }
    ],
    results: {
      reasoning: [
        { modelId: 'model-a', score: 0.92, why: '推理链完整度最高，适合多步规划与自检。', estCost: '¥0.014', estLatency: '820 毫秒' },
        { modelId: 'model-b', score: 0.86, why: '长上下文下不会丢中间结论，但首字延迟高。', estCost: '¥0.031', estLatency: '1,150 毫秒' },
        { modelId: 'local', score: 0.64, why: '隐私等级 HIGH 时唯一可选，复杂推理会明显变浅。', estCost: '¥0.000', estLatency: '240 毫秒' }
      ],
      summary: [
        { modelId: 'model-b', score: 0.9, why: '可直接吞下整份周报与会议记录，摘要不丢细节。', estCost: '¥0.022', estLatency: '1,150 毫秒' },
        { modelId: 'model-a', score: 0.88, why: '短文本摘要质量相当，成本略高但更快。', estCost: '¥0.014', estLatency: '820 毫秒' },
        { modelId: 'local', score: 0.7, why: '本地可离线完成，适合含敏感内容的日记与健康记录。', estCost: '¥0.000', estLatency: '240 毫秒' }
      ],
      vision: [
        { modelId: 'model-c', score: 0.87, why: '唯一支持图像输入的候选；对截图与图表较稳。', estCost: '¥0.061', estLatency: '690 毫秒' },
        { modelId: 'model-a', score: 0.0, why: '不支持图像输入，仅列出以说明为何被排除。', estCost: '—', estLatency: '—' }
      ],
      private: [
        { modelId: 'local', score: 0.93, why: '数据不出本机，隐私等级 HIGH 的唯一合规选择。', estCost: '¥0.000', estLatency: '240 毫秒' },
        { modelId: 'model-a', score: 0.0, why: '需上传上下文，隐私等级 HIGH 时被规则 r1 强制排除。', estCost: '—', estLatency: '—' }
      ]
    }
  };

  /* ===========================================================================
   * 11. trust — 权限、溯源与审计
   *     score 是综合信任分（授权完整度 × 可撤销性 × 审计覆盖率），不是安全评分。
   * ======================================================================== */

  DATA.trust = {
    score: 0.87,
    scoreNote: '综合信任分 = 授权完整度 0.82 × 可撤销性 0.95 × 审计覆盖率 0.91，四舍五入到两位。',
    layers: [
      { id: 'control', zh: '控制权核心', desc: '一切权限的最终开关在用户手上，系统不能自行扩权。' },
      { id: 'data', zh: '数据授权', desc: '按入口、按粒度、按有效期授权，撤回后立即停止采集。' },
      { id: 'model', zh: '模型访问', desc: '按隐私等级决定哪些上下文可以离开本机。' },
      { id: 'agent', zh: 'Agent 执行', desc: '写操作与不可逆操作一律二次确认。' },
      { id: 'audit', zh: '审计', desc: '每个动作留痕，包含被拒绝的请求。' }
    ],
    permissions: [
      {
        id: 'P-01', zh: '日历写入', scope: 'calendar.write', target: '智能体运行时',
        state: 'GRANTED', stateZh: '已授权', risk: 'HIGH', riskZh: '高',
        grantedAt: '2026-10-18T09:12:00+08:00', lastUsed: '2026-11-06T22:38:00+08:00',
        note: '写入外部日历时仍需逐次确认；演示环境只写本地模拟日历。', revocable: true
      },
      {
        id: 'P-02', zh: '日历读取', scope: 'calendar.read', target: '智能体运行时',
        state: 'GRANTED', stateZh: '已授权', risk: 'MEDIUM', riskZh: '中',
        grantedAt: '2025-09-18T10:20:00+08:00', lastUsed: '2026-11-06T23:12:00+08:00',
        note: '只读事件标题与时间，不读参与人邮箱。', revocable: true
      },
      {
        id: 'P-03', zh: '文档读取', scope: 'docs.read', target: '记忆索引器',
        state: 'GRANTED', stateZh: '已授权', risk: 'LOW', riskZh: '低',
        grantedAt: '2025-09-18T10:22:00+08:00', lastUsed: '2026-11-06T22:20:00+08:00',
        note: '仅读取标题、摘要与版本号，正文全文未授权。', revocable: true
      },
      {
        id: 'P-04', zh: '文档写入', scope: 'docs.write', target: '智能体运行时',
        state: 'GRANTED', stateZh: '已授权', risk: 'MEDIUM', riskZh: '中',
        grantedAt: '2026-11-05T11:04:00+08:00', lastUsed: '2026-11-06T22:38:00+08:00',
        note: '只新建文件，不覆盖已有文档；覆盖需要单独授权。', revocable: true
      },
      {
        id: 'P-05', zh: '邮件读取', scope: 'mail.read', target: '智能体运行时',
        state: 'REVOKED', stateZh: '已撤销', risk: 'HIGH', riskZh: '高',
        grantedAt: '2026-08-12T14:30:00+08:00', lastUsed: null,
        note: '用户在 11 月 4 日主动撤销；当前所有邮件类任务只使用本地示例邮件。', revocable: true
      },
      {
        id: 'P-06', zh: '邮件拟稿', scope: 'mail.compose', target: '智能体运行时',
        state: 'PENDING', stateZh: '待确认', risk: 'HIGH', riskZh: '高',
        grantedAt: null, lastUsed: null,
        note: '拟稿不等于发送；发送权限不在可授权列表内，演示中不提供。', revocable: true
      },
      {
        id: 'P-07', zh: '浏览记录', scope: 'browser.read', target: '记忆索引器',
        state: 'REVOKED', stateZh: '已撤销', risk: 'MEDIUM', riskZh: '中',
        grantedAt: '2026-02-14T20:00:00+08:00', lastUsed: null,
        note: '授权 3 天后被撤销，原因是「读到的比我想给的多」。', revocable: true
      },
      {
        id: 'P-08', zh: '本地文件写入', scope: 'local.file.write', target: '智能体运行时',
        state: 'PENDING', stateZh: '待确认', risk: 'MEDIUM', riskZh: '中',
        grantedAt: null, lastUsed: null,
        note: '写入范围限制在演示目录内；请求会在 1 小时后自动过期。', revocable: true
      }
    ],
    provenance: [
      { memoryId: 'MEM-0142', chain: ['用户输入', '引导设置', '记忆写入'], hash: '0x8f3a', verifiedAt: '2026-03-12T09:20:00+08:00', sealed: true },
      { memoryId: 'MEM-0031', chain: ['用户输入', '偏好面板', '记忆写入'], hash: '0x2c71', verifiedAt: '2025-10-19T09:30:00+08:00', sealed: true },
      { memoryId: 'MEM-0238', chain: ['用户输入', '家庭成员设置', '记忆写入'], hash: '0xb104', verifiedAt: '2026-07-02T19:48:00+08:00', sealed: true },
      { memoryId: 'MEM-0099', chain: ['用户输入', '财务设置', '金额脱敏', '记忆写入'], hash: '0x5de9', verifiedAt: '2026-01-12T20:26:00+08:00', sealed: true },
      { memoryId: 'MEM-0127', chain: ['会议纪要', '用户确认', '决策归档', '记忆写入'], hash: '0x71af', verifiedAt: '2026-02-18T19:06:00+08:00', sealed: false }
    ],
    audit: [
      { id: 'A-2044', ts: '2026-11-06T23:12:00+08:00', actor: '智能体运行时', action: '检索记忆', target: '记忆库 · 1,284 条', result: 'ALLOWED', resultZh: '已允许', detail: '为「整理本周工作」召回 18 条，取权重最高的 4 条进入上下文。' },
      { id: 'A-2043', ts: '2026-11-06T23:10:00+08:00', actor: '记忆索引器', action: '重建索引', target: '记忆库 · 增量 37 条', result: 'ALLOWED', resultZh: '已允许', detail: '本地增量重建，耗时 2.4 秒；未上传任何内容。' },
      { id: 'A-2042', ts: '2026-11-06T22:38:00+08:00', actor: '智能体运行时', action: '写入日程', target: '日历 · 5 个日程块', result: 'ALLOWED', resultZh: '已允许', detail: '用户二次确认后写入；仅写入本地模拟日历，0 冲突。' },
      { id: 'A-2041', ts: '2026-11-06T22:35:00+08:00', actor: '智能体运行时', action: '请求权限', target: 'calendar.write', result: 'ALLOWED', resultZh: '已允许', detail: '用户在确认框中点击「允许本次执行」，非永久授权。' },
      { id: 'A-2040', ts: '2026-11-06T21:58:00+08:00', actor: '用户', action: '撤销授权', target: 'browser.read', result: 'ALLOWED', resultZh: '已允许', detail: '从信任面板撤销，采集立即停止；已入库的 0 条记录无需清除。' },
      { id: 'A-2039', ts: '2026-11-06T20:14:00+08:00', actor: '模型网关', action: '路由请求', target: '私有处理 · 本地模型', result: 'ALLOWED', resultZh: '已允许', detail: '隐私等级 HIGH，规则 r1 生效，强制本地模型。' },
      { id: 'A-2038', ts: '2026-11-06T18:02:00+08:00', actor: '模型网关', action: '拒绝路由', target: '图像理解 · MODEL C', result: 'DENIED', resultZh: '已拒绝', detail: '请求上下文含高敏感标记，未发送至任何外部服务。' },
      { id: 'A-2037', ts: '2026-11-05T22:40:00+08:00', actor: '智能体运行时', action: '读取邮件', target: '模拟邮箱 · 12 封示例邮件', result: 'ALLOWED', resultZh: '已允许', detail: 'mail.read 处于撤销状态，本次仅读取本地样例数据。' },
      { id: 'A-2036', ts: '2026-11-05T16:20:00+08:00', actor: '用户', action: '修改偏好', target: '深度工作时间段', result: 'ALLOWED', resultZh: '已允许', detail: '09:00–11:30 → 06:00–08:00，触发 3 个维度重算。' },
      { id: 'A-2035', ts: '2026-11-05T11:26:00+08:00', actor: '记忆索引器', action: '标记过期', target: 'MEM-0202', result: 'ALLOWED', resultZh: '已允许', detail: '自述与 8 周日历记录冲突，有效期由 ACTIVE 降为 STALE。' },
      { id: 'A-2034', ts: '2026-11-04T21:40:00+08:00', actor: '智能体运行时', action: '请求权限', target: 'mail.compose', result: 'DENIED', resultZh: '已拒绝', detail: '用户拒绝并备注「先不接邮箱」，请求保持待确认状态。' },
      { id: 'A-2033', ts: '2026-11-03T09:12:00+08:00', actor: '用户', action: '导出数据', target: '记忆条目 · 46 条', result: 'ALLOWED', resultZh: '已允许', detail: '导出 JSON，含来源类型与推断依据字段；导出文件留在本地。' },
      { id: 'A-2032', ts: '2026-11-01T23:30:00+08:00', actor: '智能体运行时', action: '执行动作', target: '本地文件 · settings.json', result: 'ALLOWED', resultZh: '已允许', detail: '写入 1.2 KB 设置文件；该次授权为一次性授权，已失效。' },
      { id: 'A-2031', ts: '2026-11-01T23:29:00+08:00', actor: '智能体运行时', action: '请求权限', target: 'local.file.write', result: 'EXPIRED', resultZh: '已过期', detail: '用户未在 1 小时内确认，请求自动过期，未执行任何写入。' }
    ]
  };
  /* ===========================================================================
   * 12. architecture — 七层技术栈
   *     方向：L1 在最底（贴近数据），L7 在最上（贴近人）。
   *     components[].state 只能是 '规划中' | '模拟' | '原型' —— 没有任何组件标为「已上线」。
   * ======================================================================== */

  DATA.architecture = {
    axisNote: '纵向为数据流向（自下而上），横向为信任边界；L6 横切全栈，不参与线性数据流。',
    layers: [
      {
        id: 'L1', code: 'L1', name: 'CAPTURE & CONNECT', zh: '采集与连接',
        duty: 'Hold the only door to the outside world.', dutyZh: '守住通往外部世界的唯一一道门：没有授权，就没有采集。',
        components: [
          { name: 'Calendar Connector', zh: '日历连接器', state: '模拟' },
          { name: 'Document Watcher', zh: '文档监听器', state: '模拟' },
          { name: 'Email Connector', zh: '邮件连接器', state: '规划中' },
          { name: 'Voice Gateway', zh: '语音网关', state: '规划中' }
        ],
        input: ['用户逐项授权', '连接器产生的原始事件'],
        output: ['未标准化的原始事件流'],
        depends: [],
        note: '本层不含任何解析逻辑，只负责「取到」与「取不到」；拒绝即返回空，不做补偿性采集。'
      },
      {
        id: 'L2', code: 'L2', name: 'INGESTION & NORMALIZATION', zh: '接入与规范化',
        duty: 'Make ten different streams speak one language.', dutyZh: '把十条不同来源的数据流，对齐到同一条时间轴与同一套实体。',
        components: [
          { name: 'Event Normalizer', zh: '事件归一化器', state: '原型' },
          { name: 'Entity Resolver', zh: '实体对齐器', state: '原型' },
          { name: 'Deduplicator', zh: '去重器', state: '原型' },
          { name: 'Chunker', zh: '分块器', state: '原型' }
        ],
        input: ['原始事件流'],
        output: ['结构化片段', '统一时间轴'],
        depends: ['L1'],
        note: '同一件事来自两个来源时保留两条，而不是合并成一条；合并会永久丢失「谁说的」。'
      },
      {
        id: 'L3', code: 'L3', name: 'MEMORY & KNOWLEDGE', zh: '记忆与知识',
        duty: 'Remember, connect, and know when to forget.', dutyZh: '记住、连接，并且知道什么时候该让一条记忆变旧。',
        components: [
          { name: 'Memory Store', zh: '记忆库', state: '原型' },
          { name: 'Vector Index', zh: '向量索引', state: '原型' },
          { name: 'Link Builder', zh: '关联构建器', state: '原型' },
          { name: 'Decay Scheduler', zh: '衰减调度器', state: '规划中' }
        ],
        input: ['结构化片段'],
        output: ['记忆条目', '记忆间连接', '记忆簇归属'],
        depends: ['L2'],
        note: '衰减不是删除：AGING → STALE 只是降低检索权重，条目仍可被用户翻出来。'
      },
      {
        id: 'L4', code: 'L4', name: 'COGNITIVE ENGINE', zh: '认知引擎',
        duty: 'Turn what happened into how I tend to think.', dutyZh: '把发生过的事，归纳成「我倾向于怎么想」，并承认归纳可能错。',
        components: [
          { name: 'Dimension Extractor', zh: '维度抽取器', state: '原型' },
          { name: 'Conflict Detector', zh: '冲突检测器', state: '原型' },
          { name: 'Evidence Binder', zh: '证据绑定器', state: '原型' },
          { name: 'Profile Rebuilder', zh: '画像重建器', state: '规划中' }
        ],
        input: ['记忆条目', '记忆簇统计'],
        output: ['七维画像', '每维的置信度与证据链'],
        depends: ['L3'],
        note: '每个结论都必须能点回到具体记忆；点不回去的结论不允许出现在界面上。'
      },
      {
        id: 'L5', code: 'L5', name: 'MODEL GATEWAY & AGENT RUNTIME', zh: '模型网关与智能体运行时',
        duty: 'Route the right mind, then act in nine honest steps.', dutyZh: '把任务路由给合适的心智，再用九个诚实的步骤把它做完。',
        components: [
          { name: 'Model Router', zh: '模型路由器', state: '原型' },
          { name: 'Cost Guard', zh: '成本护栏', state: '原型' },
          { name: 'Step Runner', zh: '步骤执行器', state: '原型' },
          { name: 'Permission Broker', zh: '权限代理', state: '原型' },
          { name: 'Tool Sandbox', zh: '工具沙箱', state: '规划中' }
        ],
        input: ['意图', '上下文包', '权限状态'],
        output: ['执行计划', '动作结果', '草稿与摘要'],
        depends: ['L3', 'L4'],
        note: '九步中的第 6 步（请求确认）不可跳过，也不可被「记住我的选择」永久跳过。'
      },
      {
        id: 'L6', code: 'L6', name: 'TRUST & GOVERNANCE', zh: '治理与信任',
        duty: 'Every request passes through here. No exceptions.', dutyZh: '所有读写请求都必须经过这里，包括系统自己的请求，没有例外。',
        components: [
          { name: 'Consent Store', zh: '授权存储', state: '原型' },
          { name: 'Audit Log', zh: '审计日志', state: '原型' },
          { name: 'Redaction Engine', zh: '脱敏引擎', state: '原型' },
          { name: 'Provenance Sealer', zh: '溯源封存器', state: '规划中' }
        ],
        input: ['每一次读写请求', '每一次模型调用'],
        output: ['允许或拒绝', '审计条目', '脱敏后的副本'],
        depends: [],
        note: '本层是横切的，不参与线性数据流；它的依赖方向与其他层相反——其他层依赖它，它不依赖任何层。'
      },
      {
        id: 'L7', code: 'L7', name: 'USER EXPERIENCE & ECOSYSTEM', zh: '用户体验与生态',
        duty: 'Make the invisible legible, and the exit easy.', dutyZh: '让看不见的过程变得可读，也让「离开」这件事足够容易。',
        components: [
          { name: '3D Universe', zh: '三维宇宙', state: '原型' },
          { name: 'Panel System', zh: '面板系统', state: '原型' },
          { name: 'Guided Mode', zh: '引导模式', state: '原型' },
          { name: 'Export & Portability', zh: '导出与迁移', state: '规划中' }
        ],
        input: ['下层输出', '用户手势与语音'],
        output: ['可视化', '确认框', '可带走的导出文件'],
        depends: ['L5', 'L6'],
        note: '导出的文件必须是完整可读的 JSON，而不是只能被本产品读取的私有格式。'
      }
    ]
  };

  /* ===========================================================================
   * 13. guided — 八幕引导
   *     focus 对应镜头落点：core|memory|cognitive|agent|data|model|trust|architecture
   * ======================================================================== */

  DATA.guided = [
    {
      i: 0, act: 'ACT I', title: '个人智能核心苏醒', titleEn: 'AWAKENING', focus: 'core',
      text: '一切从一个空的核心开始。它没有你的任何数据，也不假装认识你。自检只确认三件事：记忆索引可用、模型网关可达、权限核在线。做完这三件事，它才有资格开口。',
      highlight: ['memory', 'cognitive'], caption: '核心完成自检 · 记忆索引载入'
    },
    {
      i: 1, act: 'ACT I', title: '记忆开始成形', titleEn: 'MEMORY TAKES SHAPE', focus: 'memory',
      text: '五十二条记忆散成八个簇：工作方式、健康与作息、家庭、学习、财务、居住、创作、价值判断。每条都写着它是被你说出来的、被观察到的，还是被推断出来的——这三者的分量并不相同。',
      highlight: ['memory'], caption: '52 条记忆 · 8 个记忆簇 · 关联密度 3.7'
    },
    {
      i: 2, act: 'ACT II', title: '从记忆到画像', titleEn: 'COGNITION', focus: 'cognitive',
      text: '认知引擎把记忆折叠成七个维度，每一维都带一个分数和一个更低的置信度。分数是「我猜你是这样」，置信度是「我有多确定」。两者不相等，是这个系统诚实的地方。',
      highlight: ['cognitive', 'memory'], caption: '七维画像重建 · 2 处冲突待解'
    },
    {
      i: 3, act: 'ACT II', title: '一句意图，九个步骤', titleEn: 'THE AGENT', focus: 'agent',
      text: '「帮我整理本周工作」这句话进入运行时后，会被拆成九步：理解、检索、组装、计划、查权限、请求确认、执行、验证、完成。其中第六步永远停下来等你，因为写日历这件事不可撤销。',
      highlight: ['agent', 'memory'], caption: '执行链就绪 · 等待用户确认'
    },
    {
      i: 4, act: 'ACT III', title: '数据宇宙的十道门', titleEn: 'TEN DOORS', focus: 'data',
      text: '十个数据入口，默认全部关闭。演示里只模拟开启两个：日历与文档，而且只读摘要。每开一道门，都要单独说清楚读什么、留多久、怎么撤回——这不是设置项，是协议。',
      highlight: ['data'], caption: '2 个模拟接入 · 2 个已暂停 · 6 个未连接'
    },
    {
      i: 5, act: 'ACT III', title: '把任务交给合适的心智', titleEn: 'ROUTING', focus: 'model',
      text: '同一个问题，四种模型给出四种代价：更聪明但更贵、更长但更慢、能看图但更贵、够笨但不出本机。路由器的工作不是选最强的，而是选此刻最合适的，并说明为什么。',
      highlight: ['model', 'agent'], caption: '4 个模型就绪 · 隐私规则强制本地'
    },
    {
      i: 6, act: 'ACT IV', title: '不同意，就不发生', titleEn: 'CONSENT', focus: 'trust',
      text: '权限与信任不是一个设置页，而是一层横切所有请求的膜。八项授权里有两项已撤销、两项待确认；十四天审计里有一次拒绝、一次过期。被拒绝的记录同样留痕，这才是可审计。',
      highlight: ['trust'], caption: '信任分 0.87 · 审计 14 条 · 0 异常'
    },
    {
      i: 7, act: 'ACT IV', title: '一座可以被拆开的建筑', titleEn: 'THE STACK', focus: 'architecture',
      text: '七层结构，从采集到体验。每一层都标着它是规划中、模拟还是原型——没有一层写着「已上线」。这不是谦辞，是这份演示愿意被追问的地方：哪里真的跑起来了，哪里还只是图纸。',
      highlight: ['architecture', 'trust'], caption: '7 层拆解 · 全组件未上线'
    }
  ];

  /* ===========================================================================
   * 14. stats — 底部状态条
   * ======================================================================== */

  DATA.stats = {
    memory: { items: '1,284', health: '正常', growth: '+37 / 本周' },
    agent: { running: 0, queued: 0, status: '待命' },
    sources: { connected: 2, total: 10, status: '模拟接入' },
    models: { available: 4, routed: '本地优先', status: '路由就绪' },
    security: { score: 'A', open: 0, status: '无异常' }
  };

  /* ===========================================================================
   * 15. settings — 演示面板默认值
   * ======================================================================== */

  DATA.settings = {
    qualityOptions: [
      { id: 'high', zh: '高', desc: '完整粒子与数据流，建议独显环境' },
      { id: 'medium', zh: '中', desc: '减少粒子数量，保留流光' },
      { id: 'low', zh: '低', desc: '静态布局，关闭数据流与自动旋转' }
    ],
    quality: 'high',
    reducedMotion: true,
    showLabels: true,
    showFlows: true,
    autoRotate: false,
    guidedSeen: false,
    locale: 'zh-CN',
    theme: 'dark'
  };

  /* ===========================================================================
   * 16. searchIndex — 搜索条目索引
   *     由 memories / cognitive.dimensions / sources 确定性派生，
   *     不引入随机性；新增记忆时索引自动跟随，避免两处不一致。
   * ======================================================================== */

  DATA.searchIndex = (function () {
    var out = [];
    var i;
    for (i = 0; i < DATA.memories.length; i++) {
      out.push({
        id: DATA.memories[i].id, type: 'memory',
        title: DATA.memories[i].title,
        sub: DATA.memories[i].categoryZh + ' · ' + DATA.memories[i].cluster
      });
    }
    for (i = 0; i < DATA.cognitive.dimensions.length; i++) {
      out.push({
        id: 'dim-' + DATA.cognitive.dimensions[i].id, type: 'dimension',
        title: DATA.cognitive.dimensions[i].zh,
        sub: '认知维度 · 置信度 ' + DATA.cognitive.dimensions[i].confidence
      });
    }
    for (i = 0; i < DATA.sources.length; i++) {
      out.push({
        id: 'src-' + DATA.sources[i].id, type: 'source',
        title: DATA.sources[i].zh,
        sub: '数据入口 · ' + DATA.sources[i].statusZh
      });
    }
    return out;
  })();

  /* ===========================================================================
   * 17. 常用派生查询（只读函数，不修改任何数据）
   * ======================================================================== */

  DATA.helpers = {
    memoryById: function (id) {
      for (var i = 0; i < DATA.memories.length; i++) {
        if (DATA.memories[i].id === id) { return DATA.memories[i]; }
      }
      return null;
    },
    byCategory: function (cat) {
      var out = [];
      for (var i = 0; i < DATA.memories.length; i++) {
        if (cat === 'ALL' || DATA.memories[i].category === cat) { out.push(DATA.memories[i]); }
      }
      return out;
    },
    byCluster: function (cluster) {
      var out = [];
      for (var i = 0; i < DATA.memories.length; i++) {
        if (DATA.memories[i].cluster === cluster) { out.push(DATA.memories[i]); }
      }
      return out;
    },
    clusterCounts: function () {
      var map = {};
      for (var i = 0; i < DATA.memories.length; i++) {
        var c = DATA.memories[i].cluster;
        map[c] = (map[c] || 0) + 1;
      }
      return map;
    },
    categoryCounts: function () {
      var map = {};
      for (var i = 0; i < DATA.memories.length; i++) {
        var c = DATA.memories[i].category;
        map[c] = (map[c] || 0) + 1;
      }
      return map;
    }
  };

  PAO.DATA = DATA;
})(window.PAO = window.PAO || {});
