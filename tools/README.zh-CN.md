# 标注与审核工具

[English](README.md) | **简体中文** · [网页与练习方式](../README.zh-CN.md)

工具用于生成、维护和验证词库；日常练习可直接打开 `app/index.html` 或本文件夹中的 `打开网页.cmd`。Python 脚本使用标准库，需要 Python 3.10 以上。以下命令均在仓库根目录运行。

## 自备词库

四六级或其他词库可用 JSON 输入，条数不限，不要求沿用雅思的分类。参考 [原始列表示例](examples/source.json) 和 [完整标注示例](examples/vocab.json)。旧 Markdown 解析器只适用于原始 1533 条笔记格式，通用词库请使用 JSON。

原始 JSON 可以是字符串数组、对象数组或带 `items` 数组的对象。对象必填 `original`；可选 `id`、`category`、`type`、`sourceMeaning`。省略 ID 时按顺序生成，之后修订列表应保留稳定 ID。`type` 支持 `word`、`phrase`、`name`、`code`、`number`、`time`、`date`，数字等建议明确填写类型。

完整标注 JSON 的字段：

| 字段 | 含义 |
| --- | --- |
| `datasetId` | 根对象中的词库标识，用于隔离学习记录；换词库用新值 |
| `items` | 根对象中的非空词条数组 |
| `id` / `original` | 稳定 ID / 原答案，条目不拆分 |
| `english` / `phonetic` | 完整英文或英文读法 / `/.../` 包围的英式 IPA |
| `meanings` | `{pos, zh}` 中文义项数组，普通词、短语、专名必填 |
| `category` / `type` | 分类 / 词条类型 |
| `acceptedAnswers` | 非空有效答案数组，包含原答案 |
| `synonyms` | `{english, chinese, meaningIndex, sense, note}` 学习替换建议 |
| `speakText` | 浏览器应朗读的英文文本 |
| `pronunciationNote` | 可选读音备注，无备注填空字符串 |

`meaningIndex` 从 0 开始，对应具体中文义项。同义建议不自动加入答案。数字、数字日期／时间和编号可以只给英文读法与 IPA；月份、星期等日历词汇仍需中文。完整词形要保留冠词、复数和时态。专名读音不确定时在备注中说明。

## 手动标注与导出

复制完整标注示例，编辑自己的文件，然后先导出到本地目录：

```sh
python tools/build_vocab.py --input tools/examples/vocab.json --output-dir private/my-vocab
python tools/verify_full.py --data private/my-vocab/vocab.json --js private/my-vocab/vocab.js
```

确认内容后，替换命令中的输入路径，并用 `--replace` 更新网页词库：

```sh
python tools/build_vocab.py --input tools/examples/vocab.json --output-dir app/data --replace
python tools/verify_full.py
```

不加 `--replace` 会拒绝覆盖已有词库。工具同步生成 `vocab.json` 和 `vocab.js`。覆盖前保存原词库并导出学习备份；不同词库使用不同 `datasetId`。同一词库修订释义时保留标识及条目 ID。

## 可选 API 标注

流程为：解析原始列表 → 本地确定英文读法及答案规则 → 批量结构化标注 → 语义审校 → 修补确认的问题 → 验证并导出。API 生成完整英式 IPA、常见中文义项、按义项匹配的同义建议和读音备注；来源文本作为数据处理。自动输出仍须人工检查，格式通过不代表语义全对。

标注、审校和修补工具必须用 `--source` 明确指定自己的本地输入，不再默认读取原始文档。词库默认输出到 `app/data/`；准备新词库时请先使用单独的输出目录。

只解析原始列表，无需 API：

```sh
python tools/full_pipeline.py --source tools/examples/source.json --prepare-only --output-dir private/my-annotation
```

标注使用兼容 Chat Completions 的 HTTPS 接口和 `response_format: {"type":"json_object"}`。必须在本地运行时提供完整请求 URL、模型与密钥；仓库没有默认服务商、实际地址或固定模型，`.env` 不会自动加载。

在自己的 PowerShell 终端中配置：

```powershell
$env:LISTENING_API_URL = Read-Host '完整 HTTPS Chat Completions 请求地址'
$env:LISTENING_API_MODEL = Read-Host '模型名称'
python tools/full_pipeline.py --source tools/examples/source.json --output-dir private/my-annotation --batch-size 12 --workers 4
```

脚本会隐藏输入密钥，不保存到文件。自动化可通过进程环境变量 `LISTENING_API_KEY` 提供。URL 不得包含用户名、密码、查询参数或片段。实际配置只供标注／审校脚本使用，不进入前端或词库。

思考参数默认不发送。只有服务商和模型明确支持时，才可设置以下可选环境变量：

```powershell
$env:LISTENING_API_THINKING = 'enabled'
$env:LISTENING_API_REASONING_EFFORT = Read-Host '接口支持的推理强度'
```

前者发送 `thinking: {"type":"enabled"}`，后者发送 `reasoning_effort`。参数支持因接口而异，不支持时请删除相应环境变量。脚本只保留结构化结果，不保存完整响应或模型思考内容；服务错误日志使用 HTTP 状态或错误类型。

批次原子保存，重复运行同一命令可断点续跑。`--reset` 会放弃检查点重新开始；更换来源时应使用新输出目录。`--repair --ids ... --feedback ...` 用于按确认的审校意见重新标注指定条目。

## 审校和修补

对 API 生成的自备词库，可运行独立审校：

```sh
python tools/review_annotations.py --source tools/examples/source.json --data private/my-annotation/vocab.json --batch-size 20 --workers 4
python tools/full_pipeline.py --source tools/examples/source.json --output-dir private/my-annotation --repair --ids demo-word --feedback private/my-annotation/quality_review.json
python tools/verify_full.py --source tools/examples/source.json --data private/my-annotation/vocab.json --js private/my-annotation/vocab.js
```

审校输出默认位于输入词库目录，可用 `--output-dir` 指定。ID 只是示例，需改成确有问题的词条；确认后修补，再复核。手动标注的 JSON 使用基础 `verify_full.py` 校验，不需要来源签名。

手工修补用 `apply_review_patch.py`，格式为 `{"items":[{"id":"demo-word","fields":{"pronunciationNote":"备注"}}]}`。只允许改 `phonetic`、`meanings`、`synonyms`、`pronunciationNote`，保留原答案、分类及别名：

```sh
python tools/apply_review_patch.py private/confirmed-patch.json --source tools/examples/source.json --output-dir private/my-annotation
```

基础验证无需原始笔记或 API；加 `--source` 时进一步核对 API 流水线的来源签名、身份、顺序和本地答案规则。删除中间检查点后，可从同一来源的完整生成词库恢复；恢复会保留词库标识。

## 浏览器审核

```sh
npm --prefix tools ci
npm --prefix tools run test:flows
npm --prefix tools run test:custom
```

完整流程审核自行启动随机端口的本地服务器，也检查直接打开 HTML。其他附带词库审核先运行 `python tools/preview_server.py`，再运行 `npm --prefix tools run test:browser`、`npm --prefix tools run test:visual` 或 `npm --prefix tools run test:speech`；可用 `--url` 指向其他本地预览地址。

换端口时可直接传入地址，例如 `node tools/audit_visual.cjs --url=http://127.0.0.1:11546/`。Windows PowerShell 中通过 npm 的 `--` 转发额外参数时，使用 `npm.cmd`。

所有审核使用独立后台浏览器，不操作已有用户页面。Playwright 默认读取安装的 Chrome；适用的审核可通过 `AUDIT_BROWSER=chrome`、`msedge` 或 `chromium` 选通道，Chrome/Edge 兼容性审核会分别启动两者。Chromium 需另运行 `npm --prefix tools exec -- playwright install chromium`。已有 Playwright 模块可以通过 `AUDIT_PLAYWRIGHT` 提供，仓库不保存本机安装路径。

结果和截图默认写入系统临时目录中的 `tingjian-audit`，可用 `AUDIT_OUTPUT_DIR` 改位置。完整流程、布局和兼容性审核针对默认雅思词库；`audit_custom.cjs` 使用示例词库验证任意条数、四模式、数字别名、纠错、备份与记录隔离。

语音审核将原生引擎事件与受控模拟分开。模拟验证快捷键、播放次数、暂停、取消和错误处理；它不证明实际听得到声音。实际发声需要在使用设备上试听确认。

## 工具一览

| 脚本 | 用途 |
| --- | --- |
| `打开网页.cmd` / `启动本地预览.cmd` | 打开 `app/index.html`／启动本地预览 |
| `vocab_schema.py` / `build_vocab.py` | 自备完整 JSON 校验与导出 |
| `full_pipeline.py` | 原始列表解析、批量标注、续跑、修补及导出 |
| `review_annotations.py` / `apply_review_patch.py` | 语义审校／确认后的字段修补 |
| `verify_full.py` | 字段、义项关系、JSON/JS 一致性及可选来源校验 |
| `preview_server.py` | 仅绑定 localhost 的静态预览 |
| `audit_flows.cjs` / `audit_custom.cjs` | 默认词库／自备词库练习流程 |
| `audit_visual.cjs` / `audit_speech.cjs` | 多屏幕与全屏布局／语音控制及原生错误 |
| `verify_browser.cjs` / `playwright_runtime.cjs` | Chrome/Edge 兼容性／通用运行配置 |
| `check_public.py` | 公开候选、Git 暂存及历史的敏感信息检查 |

## 发布前检查

```sh
python tools/check_public.py
git diff --cached --check
```

扫描器默认只输出检查结果，不生成报告文件；可选 `--report` 保存本地报告。通过检查的文件使用 Git 提交和推送。

公开文件按白名单选择。原始笔记、来源及审校中间文件、实际 API 配置、日志、学习备份和临时报告都不提交；`.gitignore` 不会清除已经存在于 Git 历史的文件，因此扫描也检查历史。上传前核对实际暂存文件，避免直接上传整个本地工作文件夹。
