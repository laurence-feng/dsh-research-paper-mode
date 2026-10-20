# 科研论文写作模式 / Research Paper Writing Mode

一个 DSH 智能体模式（agent preset），面向学术论文的检索、成稿、润色与投稿返修。
安装后在 **新会话** 的模式选择器里出现为「**科研论文写作**」。

An agent preset for DSH. Once installed it appears as **科研论文写作** in the
New-Session agent-preset selector.

源码 / Source: <https://github.com/laurence-feng/dsh-research-paper-mode>

---

## 1. 这个模式提供什么

| 能力 | 实现 |
|---|---|
| 学术网络检索 | 预设内置 `web_search` / `web_fetch`（`@deepseek-ai/dsh-tool-web`） |
| 文献检索 | 本包提供的 `literature_search`（学术站点限定、去重、年份过滤、可选正文摘录） |
| 文档润色 | 本包提供的 `paper_polish`（用当前会话模型改写，分段处理长文，返回修改说明） |
| 学术规范自查 | 本包提供的 `paper_style_check`（中英双规则，确定性、可复现、带字符偏移） |
| 参考文献格式化 | 本包提供的 `citation_format`（BibTeX → APA / IEEE / GB-T 7714 / Nature / MLA / Chicago） |
| 写作工作流 | 一段写入系统提示词的方法论（检索 → 提纲 → 成稿 → 润色 → 自查 → 参考文献） |
| 人设 | `@deepseek-ai/dsh-persona`：科研写作助手，含「不得编造文献」的引用纪律 |

预设还包含写作所需的常规工具：`bash`/`pwsh`、`read`/`write`/`edit`、`glob`/`grep`、
`todo_write`、`ask_user_question`、skills、计划模式（plan mode）、上下文压缩与
`present`（交付文件卡片）。

## 2. 四个专用工具

### `literature_search`
```
literature_search({ query, scope, yearFrom, yearTo, maxResults, fetchExcerpts })
```
- `scope`：`arxiv`、`pubmed`、`pmc`、`semanticscholar`、`springer`、`sciencedirect`、
  `ieee`、`acm`、`cnki`、`wanfang`、`doaj`。多个 scope 会拼成 `site:` 限定。
- 结果按 URL 与标题去重，按 `publishedAt` 中解析出的年份过滤（无日期的条目保留），
  并在 `notes` 里说明丢弃了多少条、过滤窗口是什么。
- `fetchExcerpts > 0` 时抓取前 N 条正文并抽成纯文本摘录（每条约一次 HTTP 请求）。
- 只返回可核验的 `title` / `url` / `snippet` / `publishedAt`；工具不生成引用，也不补全缺失字段。

### `paper_polish`
```
paper_polish({ text | path, style, language, instructions })
```
- `style`：`academic`（默认）、`journal-en`、`journal-zh`、`concise`、`abstract`、
  `reviewer-response`。
- `language`：`auto`（默认，跟随原文）、`zh`、`en`。
- 超长文本按段落/句子边界切块后逐块润色并保序拼接；单次上限由 `maxInputChars` 控制
  （默认 24000 字符），超出时明确报错并建议分段。
- 要求模型只输出 `{"polished": ..., "notes": [...]}`；模型不遵守时**不会失败**，
  而是把整段回复当作润色结果并在 `warnings` 里说明。
- **不写任何文件**。润色结果交回给智能体，由它用自己的 `edit` / `write` 工具落盘，
  这样文件沙箱与「先读后写」策略仍然有效。

### `paper_style_check`
```
paper_style_check({ text, language, maxIssues })
```
- 英文：冗词与口语化短语、缩写（`don't` → `do not`）、第一人称、无依据断言、
  标点前空格、重复词、连写空格、可能的被动语态、`etc.`、超长句/段。
- 中文：口语化表达（`很多`、`搞定`、`其实`…）、以断言代替证据（`众所周知`…）、
  半角标点混用、直引号、虚词重复（`的的`）、中英文之间缺空格、全角空格、超长句/段。
- 返回 `language`、`stats`（字数/句数/段数/平均句长/长句数）、`issues`
  （`rule` / `severity` / `message` / `suggestion` / `excerpt` / `offset`）与 `summary`。
- 完全确定性：同样的输入总是同样的输出，便于在稿件修改前后对比。

### `citation_format`
```
citation_format({ references, style, sort })
```
- 支持 `article`、`inproceedings`/`conference`、`book`、`phdthesis`、
  `techreport`、`misc`/`online` 等类型，解析嵌套花括号与引号值。
- 风格：`apa`、`ieee`、`gb7714`、`nature`、`mla`、`chicago`；`sort` 为
  `author`（默认）/ `year` / `none`。编号风格（IEEE、GB/T 7714、Nature）自动编号。
- GB/T 7714 细节：>3 位作者按语种选 `等` / `et al.`，会议论文用 `[C]//`，期刊用
  `[J]`，在线资源用 `[EB/OL]`。
- 非 BibTeX 输入（裸 URL、自由格式）**原样保留**并写入 `warnings`，
  绝不猜测缺失的年份、卷期或 DOI。

## 3. 配置

预设行 `research-paper-tools` 没有声明 Config schema，未知键忽略、每个值都会被夹到安全区间。

```yaml
- id: research-paper-tools
  name: 'dsh-research-paper-mode'
  config:
    searchMaxResults: 8       # 1-25
    searchExcerptChars: 1200  # 200-8000
    maxInputChars: 24000      # 500-200000
    chunkChars: 6000          # 500-20000
    styleMaxIssues: 60        # 1-500
    # polishMaxTokens: 8192   # 不设则用模型默认
```

默认值写在 `index.js` 的 `resolveConfig()` 里。改配置后需要重新安装该 bundle 并重启 DSH。

## 4. 安装 / 更新 / 卸载

包名是 `dsh-research-paper-mode`（`cordis.patch.yml` 里的预设行按这个名字引用它）。

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile desktop add github:laurence-feng/dsh-research-paper-mode
```

也可以在 DSH 的 **Plugins** 页面填仓库地址安装，或让 `plugin_manager` 装：

```
install_bundle   target: github:laurence-feng/dsh-research-paper-mode
remove_bundle    target: 'dsh-research-paper-mode'
```

装完确认 bundle 已启用，然后**新建会话**，在模式选择器里选「科研论文写作」。

### 本地开发安装

开发时用 `link:` 指向本目录，改完源码**重启 DSH** 即可加载新模块：

```
install_bundle   target: <本目录的绝对路径>
```

**重要**：Node 按解析后的真实路径缓存 ESM 模块，因此**改动源码后需要重启 DSH**
才会加载新的一代模块；仅重新安装或开关 bundle 不会刷新已加载的模块。

不要手工改 profile 的 `package.json` 或 `cordis.patch.yml`，交给 `plugin_manager` /
`dsh plugin` 处理。

## 5. 为什么本包不 import `@deepseek-ai/dsh-tools`

Harness 自带的 `defineTool` 位于应用归档（`app.asar`）内的
`@deepseek-ai/dsh-tools`。profile 里安装的 bundle 由**普通 Node ESM 解析**加载，
解析基准是包自己的真实目录，看不到归档里的包——直接 `import` 会让整个插件
`failed to import`，预设随之损坏。

因此 `lib/tool-schema.js` 重新实现了本包用到的那一小部分：参数/返回值 schema DSL
与入参校验。产物是标准的注册用 `ToolDefinition`（`parameters` 与 `output.schema`
都是注册表所校验的 JSON Schema 子集）。副作用是**本包零依赖**，可以安装在任意位置。

## 6. 开发与验证

```bash
node test/run.mjs     # 50 项测试，不需要 Harness 在运行
```

`test/run.mjs` 用一个假的 Host context 驱动 `apply()`，覆盖：工具注册、
参数校验、返回值形状校验、四条 `execute()` 路径（含网络服务的成功与缺失、
模型不遵守 JSON 约定、分段、超限、无法解析的引用列表），以及 patch/manifest 结构。
纯逻辑（`lib/`）没有 Harness 依赖，全部可直接单测。

## 7. 文件

```
package.json            bundle 清单（dsh.bundle.patch、icon、locale 导出）
cordis.patch.yml        预设声明：人设、本包工具行、常规工具行
index.js                插件入口：注册四个工具 + 写入工作流提示词段
lib/tool-schema.js      defineTool 的自包含实现（见第 5 节）
lib/text.js             HTML→文本、分块、语言判定、URL 归一化等
lib/style.js            中英学术写作规则
lib/polish.js           润色提示词构造、结果解析、流式调用
lib/citation.js         BibTeX 解析与六种引用风格
tools/*.js              四个工具的注册与执行
locale/en.json, zh.json Plugin Manager 中显示的标题与描述
icon.svg                模式图标
test/run.mjs            测试
```

## 8. 许可

MIT，见 [LICENSE](./LICENSE)。
