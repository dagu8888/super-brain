# 知识库规范（Vault Rules）

本知识库遵循「文件优先（file over app）」原则，学习自 kepano（Obsidian CEO）的公开 vault：

## 目录：少而平，不嵌套
- `Playbooks/` — 可复用的操作流程、方法论
- `Concepts/` — 概念、认知、领域知识
- `Decisions/` — 决策记录（为什么这么做）
- 根目录文件 — 未归类的草稿与杂记，定期整理进上面三个目录

## 属性（frontmatter）：跨类复用、短名、列表优先
每篇笔记以 frontmatter 开头，字段全集见 [[知识笔记模板]]：
- `title` `category` `tags` `source` `created` `updated` `version` `quality` `rating`
- `category` 必须是 `Playbooks` / `Concepts` / `Decisions` 之一（根目录文件可省略，由目录兜底）
- `tags` 用复数名词，逗号分隔
- `rating` 7 分制（1–7），只给评价得上的内容打分
- 日期一律 `YYYY-MM-DD`

## 链接：疯狂用 [[wikilink]]
- 正文里提到任何已有或该有的笔记，都写成 `[[笔记文件名]]`
- 未解析的链接不是错误，是面包屑——提示「这里还缺一篇笔记」
- 图谱页的 `.canvas` 导出会根据这些链接自动生成连线

## 复盘：日期命名
- `30-Reviews/` 里的一律 `YYYY-MM-DD.md`，年度回顾用 [[年度回顾40问模板]]
