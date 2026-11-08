# Super-Brain 3.0 Design System（V3.0 · Phase 2 交付）

> 日期：2026-11-08 ｜ 作者：Trae Agent（总负责人）
> 依据：《SUPER-BRAIN 2.0→3.0 完整工程升级开发总指令》§3–§8、§16–§20
> 状态：VERIFIED 落地——tokens.css / base.css / preview.html 已随本文档提交，浏览器可直接打开 preview.html 查看
> 上游输入：[Phase 1 现状审计报告](../../30-Reviews/2026-11-08-V3-Phase1-现状审计报告.md)

---

## 1. 定位与设计原则

Super-Brain 3.0 控制台 = **Apple Design Language + Spatial Interface + Premium AI Command Center**。

| 关键词 | 含义 | 落地约束 |
|---|---|---|
| Minimalism 极简 | 每屏一个视觉中心 | 首页视觉中心必须是 Agent 协作网络，不堆统计卡片 |
| Clarity 清晰 | 信息层级靠字号/字重/灰度区分 | 三级文字色，禁止用花哨色区分层级 |
| Depth 层次 | 材质分三级：背景 → 卡片 → 玻璃浮层 | 玻璃仅用于顶栏/侧栏/详情面板，不全屏滥用 |
| Fluidity 流畅 | 四档动效时长，统一缓动 | 见 §9 动效规范 |
| Consistency 一致 | 全部颜色/尺寸来自 tokens.css | 代码评审发现硬编码色值一律打回 |
| Intelligence 智能 | 实时事件驱动 UI 变化 | 数据真实性见 §11 |
| Professional 专业 | 成熟高端 AI 操作系统的观感 | 禁止项见下 |

**明确禁止**（总指令 §3.3）：廉价赛博朋克、大面积荧光色、过多霓虹描边、过多渐变、无意义粒子动画、全屏毛玻璃、过多装饰性发光、密集传统后台表格、为科技感而加的无意义图形。

---

## 2. 落地文件清单

| 文件 | 内容 | 状态 |
|---|---|---|
| [tokens.css](tokens.css) | 全部设计变量：色彩/表面/圆角/间距/阴影/玻璃/动效/布局尺寸，浅色 + 深色双主题 | VERIFIED |
| [base.css](base.css) | 全局基础样式：字体、焦点、卡片、玻璃（含降级）、按钮、状态徽章、骨架屏、空态/错误态、主布局、详情面板、Agent 节点、reduced-motion | VERIFIED |
| [preview.html](preview.html) | 设计预览页：色彩/排版/按钮/卡片/徽章/Agent 节点画廊，右上角可切换深浅色 | VERIFIED |

纪律：前端工程（Phase 4 起）只准引用变量；新增变量必须先改 tokens.css 再使用。

---

## 3. Design Tokens 总表

与 tokens.css 一一对应（节选核心，全量见文件）：

| 类别 | 变量 | 浅色 | 深色 |
|---|---|---|---|
| 页面背景 | `--sb-bg` | #F5F5F7 | #111113 |
| 卡片表面 | `--sb-surface-solid` | #FFFFFF | #222226 |
| 玻璃表面 | `--sb-surface-glass` | rgba(255,255,255,.68) | rgba(40,40,46,.72) |
| 主文字 | `--sb-text-primary` | #1D1D1F | #F5F5F7 |
| 次文字 | `--sb-text-secondary` | #6E6E73 | #A1A1A8 |
| 辅助文字 | `--sb-text-tertiary` | #86868B | #777780 |
| 品牌主色 | `--sb-primary` | #007AFF | #0A84FF |
| 成功/警告/危险/信息 | `--sb-success/warning/danger/info` | #30A46C / #D99A24 / #E5484D / #0A84FF | 同浅色 |
| 协作紫 | `--sb-collaborating` | #8B7CFF | #9C8FFF |
| 描边 | `--sb-border` | rgba(60,60,67,.12) | rgba(255,255,255,.10) |
| 圆角 | xs/sm/md/lg/xl/pill | 6/10/14/20/26/999px | 同浅色 |
| 间距 | space-1…12 | 4/8/12/16/20/24/32/40/48px | 同浅色 |
| 阴影 | card / floating | 双层柔和投影 | 加深版 |
| 玻璃 | blur / saturation | 24px / 180% | 同浅色 |
| 动效 | fast/normal/smooth/slow | 120/200/300/450ms | 同浅色 |
| 缓动 | `--sb-ease` | cubic-bezier(0.2,0,0,1) | 同浅色 |
| 布局 | 侧栏/详情面板/顶栏 | 248px / 380px / 56px | 同浅色 |

## 4. 主题机制

- 双主题通过 `[data-theme="dark"]` 属性切换（可挂在 `<html>` 或任意容器）。
- 默认跟随系统 `prefers-color-scheme`，用户在 Settings 可手动锁定浅/深/跟随。
- 主题属于**客户端状态**（总指令 §18.3），存 localStorage，不进入业务数据流。
- 新增组件必须双主题自查：preview.html 右上角开关即验收工具。

## 5. 字体与排版

字栈（tokens.css `--sb-font-family`）：SF Pro（设备可用时）→ PingFang SC → Hiragino Sans GB → Microsoft YaHei → sans-serif。**任何设备都有可靠回退，不假设 SF Pro 存在**（总指令 §4.3）。

字号阶梯：

| 层级 | 字号/行高 | 字重 | 用途 |
|---|---|---|---|
| Display | 34px / 41px | 700 | 首页关键数字（在线 Agent 数等真实指标） |
| Title 1 | 28px / 34px | 700 | 页面标题 |
| Title 2 | 22px / 28px | 700 | 区块标题 |
| Title 3 | 17px / 22px | 600 | 卡片标题 |
| Body | 14px / 1.55 | 400 | 正文（全局基准） |
| Caption | 12px / 16px | 400 | 次要说明（次文字色） |
| Micro | 11px / 14px | 400 | 事件 ID、时间戳等（辅助文字色） |

## 6. 图标系统

- 选型：**lucide-react**（MIT 许可，线性风格与 Apple 观感一致，React 原生组件）。
- 规格：16 / 20 / 24px 三档，stroke-width 2，颜色一律 `currentColor`。
- 导航语义映射：

| 页面 | 图标 | 页面 | 图标 |
|---|---|---|---|
| Command Center | LayoutDashboard | Knowledge Graph | Share2 |
| Agents | Bot | Memory | Database |
| Tasks | ListChecks | System Monitor | Activity |
| Collaboration | Network | Settings | Settings2 |

## 7. 布局规范

### 7.1 桌面主布局（已实现于 base.css）

```
┌────────────┬──────────────────────────────────┐
│ Sidebar    │ TopBar（56px，玻璃）             │
│ 248px      ├──────────────────────────────────┤
│ 8 页导航    │ Content（padding 24px，滚动区）  │
└────────────┴──────────────────────────────────┘
        详情面板：fixed 右侧 380px，data-open 控制滑入滑出（300ms）
```

- 栅格：`grid-template-columns: var(--sb-sidebar-width) minmax(0, 1fr)`，主区 `min-width:0` 防溢出。
- 详情面板打开时**不遮挡关键操作**：内容区保持可滚动，面板外点击行为按 §8.3 规则。

### 7.2 响应式断点（总指令 §20）

| 断点 | 形态 |
|---|---|
| ≥1280px | 完整布局（侧栏 + 内容 + 380px 详情面板） |
| 768–1279px | 侧栏折叠为 64px 纯图标栏；详情面板带半透明遮罩 |
| <768px | 单栏：侧栏改抽屉；详情面板全屏；图谱降级为列表 + 局部图 |

不允许简单等比缩小桌面页。

## 8. 页面信息架构（8 页）

API 端点为契约草案（Phase 4 与后端适配层 console_api 共同定稿；数据源均为 Phase 1 审计确认的现存表/文件）：

| # | 页面 | 路由 | 目的 | 核心区块 | 数据源（现存） |
|---|---|---|---|---|---|
| 1 | Command Center | `/command` | 一眼看懂整个智能组织 | 顶部真实指标条 / Agent 协作网络图 / 底部实时事件时间轴 / 右侧详情面板 | agents、tasks、events、runtime-*.jsonl |
| 2 | Agents | `/agents` | Agent 花名册与单机详情 | 卡片网格（非密集表格）/ 筛选 / 详情面板 | agents 表 + heartbeats |
| 3 | Tasks | `/tasks` | 任务全生命周期 | 状态列看板或列表 / 搜索筛选排序 / 任务时间线 | tasks 表 + events 表 |
| 4 | Collaboration | `/collaboration` | Agent 间协作追踪 | 协作链路 / 委派与交接记录 / 按 Agent·Task·时间筛选 | task_delegated / task_linked / receipt 事件 |
| 5 | Knowledge Graph | `/knowledge` | 知识形成与关联 | 2D 交互图谱 / 搜索 / 类型与关系筛选 / 增量更新 | 10-Knowledge frontmatter + task_linked |
| 6 | Memory | `/memory` | 记忆可视化（只读为主） | 全局/Agent/项目记忆分 Tab / 搜索 / 来源追溯 | sessions 表（仅 7 条，如实展示） |
| 7 | System Monitor | `/monitor` | 系统健康实况 | 服务状态 / 线程心跳 / 队列深度 / 磁盘内存（有数据才显示） | health.py 七项检查 + heartbeats |
| 8 | Settings | `/settings` | 偏好与系统设置 | 主题 / 通知 / 连接状态 / 高风险操作区（确认+审计） | 客户端偏好 + api 状态 |

空态统一原则：无数据显示「暂无数据」+ 一句引导，**禁止用假数据填充**（总指令 0.2-8、§13）。

## 9. 组件规范

### 9.1 基础组件（19 个，Phase 4 建库）

Button / IconButton / Input / SearchInput / Select / Dropdown / Tooltip / Badge / Avatar / Card / Tabs / Modal / Drawer / Popover / Toast / Skeleton / EmptyState / ErrorState / LoadingState。

每个组件必须定义：Props、数据结构、交互事件、加载/错误/空数据表现、权限约束（总指令 §19）。已在 base.css 具备样式的：Button、Card、Badge（.sb-status）、Skeleton、EmptyState、ErrorState。其余 Phase 4 按同一 token 体系补齐，**同一组件全系统只许一个版本**。

### 9.2 业务组件（11 个）

| 组件 | 关键 Props | 说明 |
|---|---|---|
| AgentNode | name, role, status, currentTask?, selected?, onClick | 总指令 §6.3 参考实现为准；头像字母仅演示，生产用稳定 Agent ID |
| AgentCard | agent, healthSummary?, onOpenDetail | Agents 页卡片，信息密度低于节点高于表格 |
| AgentStatusBadge | status | 复用 .sb-status，7 态映射见 §9.3 |
| TaskCard | task, onOpenDetail | 标题/状态/优先级/当前 Agent/最近事件 |
| TaskTimeline | taskId, events[] | 按真实事件渲染，允许分支/重试，不强制线性（§9.3） |
| CollaborationEdge | id, 坐标, active, onClick | 流动动画仅真实协作活动期间触发（总指令 §7.4） |
| EventTimeline | events[], paused, filters | 新事件自然进入；用户上翻时不强制拉回 |
| KnowledgeNode / KnowledgeEdge | 总指令 §11.3 类型 | 增量更新，不打断用户当前视图 |
| SystemHealthIndicator | source: health 检查结果 | 无采集数据显示「暂无数据」 |
| DetailPanel | target{type,id}, open, pinned, history | 全系统统一详情入口：Agent/Task/Event/Knowledge 共用 |

### 9.3 状态映射（前端展示模型 ↔ 2.0 真实数据，审计 §4/§5）

**Agent 7 态为派生态**，派生规则须由 console_api 数据支撑，无支撑不显示：

| 展示态 | 派生规则（真实数据源） |
|---|---|
| offline | agents.status≠active，或 last_seen 超过 2×心跳周期（120s）未更新 |
| working | 该 Agent 存在 status='doing' 的任务 |
| collaborating | 存在进行中的 task_delegated / task_linked 事件关联 |
| waiting | 有派给它的 pending 任务且尚未领取（由事件推导，无事件则不展示此态） |
| idle | active 且无任何进行中任务 |
| completed / error | 瞬时事件态，仅在事件时间轴与短时高亮中呈现，不做常驻状态 |

**Task 状态映射**：DB 真实态为 `pending/doing/done/failed/dead/cancelled`：

| DB 真实态 | 前端展示 | 说明 |
|---|---|---|
| pending | 待派发 | — |
| doing | 执行中 | — |
| done | 已完成 | — |
| failed | 失败 | 展示 error 信息 |
| dead | 失败（死信） | 徽章标注「死信」，可溯 retry 历史 |
| cancelled | 已取消 | — |
| （事件推导） | 已分配 / 受阻 / 等待中 | 仅当有对应真实事件时展示，否则不出现 |

进度百分比：仅当后端给出可靠进度才显示数字，否则展示当前阶段 + 最近事件（总指令 §9.4）。

## 10. 动效规范

| 场景 | 动效 | 时长 |
|---|---|---|
| 页面切换 | 轻微淡入 | fast 120ms |
| 详情面板 | 右侧滑入/滑出 | smooth 300ms |
| 卡片/节点悬停 | 上浮 2–3px + 阴影加深 | normal 200ms |
| 按钮按压 | scale(0.97) 回弹 | fast 120ms |
| 新事件进入时间轴 | 轻微淡入 | normal 200ms |
| 真实协作活动 | 连线短暂流动（仅活动期间） | ≤1.8s/周期 |
| 节点新增 | 轻微缩放进入 | smooth 300ms |
| 弹窗 | 淡入 + 轻微位移 | normal 200ms |

铁律：① 动画只允许 `transform` 与 `opacity`（不触发重排）；② `prefers-reduced-motion` 时全部关闭（base.css 已实现）；③ 禁止无意义常动动画。

## 11. 真实性与状态规范（数据验收前置约束）

1. 加载中 → Skeleton 骨架屏；空数据 → EmptyState「暂无数据」；失败 → ErrorState + 重试。
2. WebSocket 断连：进入 `stale` 态，顶部明确横幅「连接已断开，数据可能已过期」，**禁止继续把缓存标为实时**（总指令 §14.3）。
3. 无后端数据的指标（CPU/成本/健康分）一律不展示或显示「暂无数据」，禁止虚构。
4. 每次渲染的数据必须可追溯到 console_api 响应或事件流，组件 props 即证据链。

## 12. 可访问性（总指令 §20）

- 文字对比度 ≥ WCAG AA（4.5:1）；三级文字色仅用于非关键信息。
- 全键盘可达：Tab 焦点环（base.css 已实现 3px 主色描边）、Esc 关面板、Enter 确认、⌘K 搜索、方向键导航列表。
- 状态表达 = 颜色 + 圆点/图标 + 文字三重（.sb-status 已实现）。
- 触控目标：桌面指针 ≥32px，触控 ≥44px。
- 图谱节点须带 aria-label（参考总指令 §6.3 实现）。

## 13. Phase 3 计划（下一步）

1. 首页 Command Center 高保真原型（HTML 静态稿先行评审）：主布局 + Agent 协作网络 + 事件时间轴 + 详情面板。
2. 关键交互演示：节点选中→详情滑入、协作连线点击、时间轴暂停/回放、深浅色切换。
3. 其余 7 页线框级原型。
4. 原型评审通过后进入 Phase 4（前端工程 + console_api 契约定稿 + 真实数据接入）。

---

**Phase 2 交付对照总指令 §22**：页面信息架构 ✓ / Design Tokens ✓ / 浅色主题 ✓ / 深色主题 ✓ / 字体系统 ✓ / 图标系统 ✓ / 组件规范 ✓ / 动效规范 ✓ / 页面布局规范 ✓。
