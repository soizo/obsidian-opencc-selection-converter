# OpenCC Selection Converter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本项目默认由当前会话直接执行；未经用户明确要求，不启动 subagent-driven-development 或独立代理审查。

**Goal:** 交付可安装的 Obsidian 插件，以真实 OpenCC 方案安全转换选区可见文字并原位写回。

**Architecture:** 固定版官方 C++ 核心编译为 WASM，最小绑定负责真实匹配追踪和词典枚举。TypeScript 分为 Obsidian 接入、源码投影、方案资源/快照、串行 Worker 四个职责；所有编辑在内存校验后单事务提交。

**Tech Stack:** TypeScript、Obsidian API、宿主 CM6、esbuild、Microsoft `jsonc-parser`、OpenCC 1.4.2、Emscripten 4.0.15；功能测试由 Node 标准库脚本驱动 Obsidian CLI，在 Obsidian 内执行，不使用 Node 测试运行器代替应用验收。

**Spec:** [已批准设计](../specs/2026-10-02-opencc-selection-converter-design.md)。执行者先完整阅读设计及[可行性记录](../../feasibility.md)。

**Status:** 书面设计与实施计划已获用户确认，当前会话直接执行。勾选项表示已完成步骤；未勾选项仍是待实现/待验收目标，不代表现有能力。

## Global Constraints

- `minAppVersion`：1.13.7；源码模式、实时预览；Android/iOS 为目标，未经真机测试不宣称已验证。
- 不依赖运行时 Node/Electron/系统 OpenCC，不下载可执行代码；使用 Obsidian 原生 UI。
- 只处理一个连续选区；无选区、阅读模式、不支持的编辑器均不修改正文。
- 选区外源码逐字不变；正常跳过保护区不算失败，实际加载/转换/映射失败则整次不写。
- 所有实际转换阶段都执行；不支持非 mmseg 分词插件，不静默忽略配置字段。
- 六类区域：行内代码、代码块、引用、行内公式、块级公式、公式子区域；三种策略，默认仅选区完全位于内部时转换；父区保护优先。
- 默认检查每次实际替换等长及最终等长，单位为 Unicode 码点；强制变长不绕过其他安全检查。
- 初始上限：配置 2 MiB，单依赖 64 MiB，单快照 128 MiB、256 个资源，配置嵌套深度 32，选区 200,000 码点，输出 8 MiB，追踪 64 MiB，WASM 内存 256 MiB；单资源请求及单次 Worker 工作各 30 秒，后者不含排队。
- 笔记正文不上传、不落入插件缓存或日志；一次转换一次可独立撤销的事务。
- 功能测试全部指向 `OpenCC-Selection-Converter-Test`，路径为 `~/Desktop/PlayGround/OpenCC-Selection-Converter-Test`；不写其他 vault。
- 构建/类型/静态诊断不是功能测试，仍须执行；不把 CLI 的零退出码当作 eval 成功。
- 原仓库当前分支执行；用户已授权阶段性本地提交，未授权额外分支或推送；不启动子代理。

## Review Focus

以下是容易被“常规中文转换成功”掩盖的风险，已分配到任务测试：

1. 补充平面汉字、组合字符、孤立代理项、NUL 和半个转义单元：不能混淆码点、UTF-16 与字节，也不能静默截断。（任务 3、6、8）
2. 两次长度变化恰好抵消、normalization 改写后再次分词、group 中同前缀不同优先级：不能套用最终字符串下标或猜测 diff。（任务 3、8）
3. 同一文本被编辑后撤销恢复、同文件双窗口、方案选择弹窗期间光标变化：旧任务仍必须失效，不能写进错误视图。（任务 9）
4. 资源同名不同目录、vault `../`/编码路径边界、缓存标记部分写入、换来源失败：不能拿旧资源冒充新来源或越界读文件。（任务 4、5）
5. 转换结果形成围栏、表格管道、实体或链接语法；样式包装只选到一半：不能清理选区外标记或改变目标地址。（任务 6、7、8）

## 文件地图与工具链

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 插件生命周期、命令注册、菜单和设置入口；测试构建注入测试入口 |
| `src/settings.ts`, `src/scheme-modal.ts` | 原生设置、方案编辑/选择、资源确认；不复制转换逻辑 |
| `src/engine/types.ts`, `src/engine/client.ts`, `src/engine/worker.ts` | 明确协议、单 Worker 队列、WASM 生命周期 |
| `engine/bridge.cpp`, `engine/trace.hpp`, `engine/trace.cpp` | C ABI、核心追踪/枚举及预算检查 |
| `engine/patches/opencc-trace.patch`, `engine/upstream.lock.json` | 最小上游补丁、来源提交及工具链锁定 |
| `src/schemes/model.ts`, `config.ts`, `resources.ts`, `store.ts` | 方案类型、配置解析、资源定位读取、快照/元数据提交恢复 |
| `src/selection/editor.ts`, `types.ts`, `markdown.ts`, `latex.ts`, `serialize.ts`, `convert.ts` | 编辑器上下文、投影数据、两类语法、写回检查、统一转换协调 |
| `src/limits.ts`, `src/errors.ts` | 设计的固定边界和可脱敏的结构化错误，不建立通用配置框架 |
| `scripts/build.mjs`, `build-engine.sh`, `test-cli.mjs` | 构建、隔离工具链编译、真实 CLI 部署/断言驱动 |
| `tests/cli/run.ts`, `assert.ts`, `fixtures.ts`, `*.test.ts` | 测试构建中的用例与确定性合成数据 |
| `tests/fixtures/`, `tests/fixture-server.mjs` | 公开/自造词典、Markdown 样例、只服务固定测试资源的本地 HTTP fixture |
| `manifest.json`, `versions.json`, `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` | 实际任务需要时创建，不提前搭空架子 |
| `README.md`, `THIRD_PARTY_NOTICES.md`, `docs/testing.md`, `docs/verification.md` | 使用与限制、许可、运行说明、最终证据 |

构建选择：开发依赖锁定 `obsidian@1.13.1`（npm 类型包版本，不是应用最低版本）、`esbuild@0.28.2`、`typescript@5.9.3`；任务 1 提交完整 lockfile。运行时仅引入 `jsonc-parser@3.3.1` 处理与原生一致的注释/尾逗号及精确报错；宿主 `obsidian`、CM6、Lezer 类型/模块设为 external，不打包第二份 CM6。依赖来源在实施时按作者官方仓库复核。

OpenCC 1.4.2 标签已解析到提交 `025f371dc76b598d77384fbdab90c937471844d8`；emsdk 4.0.15 为 `389a68bc35dcff7ebae4614e1615099dafda00d1`。外部仓库仅放 `~/Local/Cloned/`，重用前核对 HEAD 和工作区；不 reset 或覆盖已有修改，补丁施加在可丢弃的构建副本。工具链激活只影响构建子进程，不修改全局 shell 配置。工具链/下载失败即报告，不静默换引擎或版本。

初始插件版本 `0.1.0`、`isDesktopOnly:false`、`minAppVersion:1.13.7`。构建输出 `dist/main.js`、`dist/manifest.json`、`dist/versions.json`；Worker 和 WASM 由 main.js 内嵌资产按需建立 Blob，插件安装不依赖额外文件被 Obsidian 下载。测试构建含用例；生产构建必须删除测试入口和所有测试数据。只保留必要的构建产物在本地，生成文件忽略，源码/锁文件/许可/测试进入 Git。

## 跨任务类型约定

以下类型在拥有它们的任务首次落地，不一次创建大而空的类型文件。

- `Span = { from: number; to: number }`：半开区间；任务 1 在 `src/selection/types.ts` 定义。源码中的 Span 为 UTF-16；明确命名为 scalar 的字段才是码点偏移。
- `SchemeDefinition`：`id, name, source:{kind:'url'|'vault',location:string}, dependencyBaseUrl?, overrides:Record<string,string>, allowInsecureHttp:boolean`。
- 任务 4 在 `src/schemes/config.ts` 定义 `ParsedConfig = {originalText:string,value:OpenCCConfig,references:ConfigReference[]}`，其中 ConfigReference 为 `{jsonPath:string,type:'text'|'ocd'|'ocd2',file:string}`；OpenCCConfig 是设计第 4.2 节支持集合的递归配置类型。
- `ResourcePlan = {config:ParsedConfig,definition:SchemeDefinition,sourceKey:string,virtualConfigText:string,resources:ResourceLocation[]}`；ResourceLocation 为 `{source:SchemeDefinition['source'],originalRef:string,virtualPath:string,configPaths:string[],dictType:'text'|'ocd'|'ocd2'}`。由任务 4 在 `src/schemes/model.ts` 增补。
- `Snapshot`：`id, schemeId, sourceKey, engineId, configText, virtualConfigText, resources, createdAt`；资源类型 LoadedResource 包含 ResourceLocation 的全部字段及 `bytes:Uint8Array,sha256:string`。任务 2 先在 `src/schemes/model.ts` 定义 Snapshot 和资源字段，任务 4 提取复用定位类型；提交清单和磁盘资源文件分开保存。
- `MatchRecord`：`stagePath, dictPath, inputScalar:Span, outputScalar:Span, inputLength, outputLength`；范围属于该阶段的逻辑文本。dictPath 可标识一个 group 根，不能冒称已经定位到某个叶词典。
- `TraceResult`：`output:string, origins:number[], matches:MatchRecord[]`；origins 将每个输出码点映射到原始可见输入码点，同长度替换按位置，变长替换归属原匹配起始处。多阶段合成在 Worker 内完成。
- `LengthReport`：`snapshotId, status:'equal'|'risk'|'incomplete', checkedEntries, risks, reasons`；风险记录带阶段、词典/配置路径、键、默认目标和长度，不包含笔记正文。
- `RuleSettings`：`regions:Record<RegionKind,'always'|'inside'|'never'>, force:boolean`；任务 1 在 `src/selection/types.ts` 定义默认策略，RegionKind 为 `inlineCode|codeBlock|quote|inlineMath|blockMath|mathGroup`。
- `Projection`：`source, selection, regions, runs, protectedSpans, structure`；run 的有序 units 逐码点保存 `text, source:Span, styleKey, encoding`，并保留完整语法单元范围。
- `PatchPlan`：`changes:Array<{from,to,insert}>, selection:Span`。只允许在原选区内产生 edits；允许的特殊序列化调整按设计第 5.4 节验证。
- `PluginError`：`code, message, source?, configPath?, sourceSpan?`；UI 使用脱敏信息，不直接把底层对象或选区 dump 到日志。

## 验证驱动约定

任务 1 实现 `npm run test:cli -- <suite>`。Node 脚本仅检查环境、构建/复制发布文件、启动固定资源服务器、调用 CLI、读取结果；不在 Node 中导入产品模块执行业务测试。

测试构建给真实插件实例增加 `runCliSuite(name: string, runId: string): Promise<void>`。它在 Obsidian 内运行用例，将 `{runId,suite,passed,failed,checks,errors}` 写入专用 vault 的 `.opencc-test-results/<runId>.json`。驱动只接受本次随机 runId 的文件和非零检查数；断言失败、超时、缺报告均以非零状态退出。CLI stdout 只回短标识，避免 eval 输出截断造成假通过。

所有调用显式指定 vault。部署前用 CLI 核对实际 vault 路径等于指定新库；不匹配则在复制或创建文件前退出。smoke/wrong-vault 是驱动自检：用错误 expected-path 运行同一 CLI 守卫，并确认未产生写入，不需要业务模块在 Node 中运行。只在这个 vault 关闭 restricted mode、启用/重载测试插件；不全局重启 Obsidian。

测试用例使用 `equal(actual, expected)`、`ok(value)`、`rejectsCode(promise, code)`，由 `tests/cli/assert.ts` 提供，不引入测试框架。下述断言代码是各任务必须实现的命名用例内容；fixture 帮助函数由对应 suite 自己定义，不作为产品 API。

---

### Task 1: 插件加载、无选区保护与 CLI 测试闭环

**Files:** Create `manifest.json`, `versions.json`, `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `scripts/build.mjs`, `scripts/test-cli.mjs`, `src/main.ts`, `src/limits.ts`, `src/errors.ts`, `src/selection/types.ts`, `src/selection/editor.ts`, `tests/cli/run.ts`, `tests/cli/assert.ts`, `tests/cli/fixtures.ts`, `tests/cli/smoke.test.ts`。

**Interfaces:** 产出 `OpenCCSelectionConverter extends Plugin`，ID `opencc-selection-converter`；`captureTarget(view: MarkdownView): CapturedTarget` 捕获传入的 MarkdownView/EditorView、文件、文档 revision 和单选区，不提供隐式全文范围。CapturedTarget 在 editor.ts 定义为 `{view,cm,file,filePath,doc,revision,selectionRevision,selection,anchor,head}`；file 为 TFile 身份，filePath 是捕获时路径字符串，doc 为不可变 CM6 Text，selection 为排序后的 Span，anchor/head 保留方向。产出上述 CLI 驱动与断言；初始无方案时只提示添加方案，不放占位转换算法。

- [x] **写失败用例。** `smoke/no-selection`、`smoke/unsupported-view`、`smoke/wrong-vault`：
  ```ts
  equal(await invokeDefaultWithNoSelection(), {changed:false, code:'NO_SELECTION'});
  equal(await invokeDefaultInReadingMode(), {changed:false, code:'UNSUPPORTED_VIEW'});
  equal(await targetVaultGuardWithWrongExpectedPath(), {writes:0, rejected:true});
  ```
- [x] **运行红灯。** `npm run test:cli -- smoke`；确认真实 CLI 报告插件/命令缺失，或者保护断言失败。先让 runner 能报告失败，再实现插件行为，不把构建错误当完整行为回归证据。
- [x] **实现最小闭环。** 创建真实插件及构建；通过 editor extension 与公开 editorInfoField 建立 Editor→EditorView 关联，不依赖 editor.cm 或 state.values 私有结构；记录原始编辑视图而非操作时猜活动文件；源码/实时预览由统一入口识别。`limits.ts` 写入设计全部固定边界；测试入口只在 test define 下编译，读取结果路径受 vault guard 限制。
- [x] **验证。** `npm run check && npm run test:cli -- smoke`；至少上述三个命名用例通过；生产构建查不到 `runCliSuite`，不创建笔记正文缓存。
- [x] **提交。** 显式 stage 本任务 Files 中的新文件（不 stage dist、vault 或 `.opencc-test-results`），`git commit -m "feat: add plugin entry and Obsidian CLI test harness"`。

### Task 2: 固定版原生 OpenCC 的离线 WASM 运行

**Files:** Create `engine/upstream.lock.json`, `engine/bridge.cpp`, `scripts/build-engine.sh`, `src/engine/types.ts`, `src/engine/client.ts`, `src/engine/worker.ts`, `src/schemes/model.ts`, `tests/fixtures/opencc/`, `tests/cli/engine.test.ts`, `THIRD_PARTY_NOTICES.md`; Modify `scripts/build.mjs`, `src/main.ts`, `.gitignore`, `package.json`。

**Interfaces:** 定义 Snapshot；产出 `EngineClient.validate(snapshot: Snapshot, signal: AbortSignal): Promise<void>`、`convertPlain(snapshot, input, signal): Promise<string>`、`dispose(): void`。C ABI 为 `occ_open(configPtr,len)`、`occ_convert(handle,inputPtr,len)`、`occ_result_ptr()`、`occ_result_len()`、`occ_error_ptr()`、`occ_error_len()`、`occ_close(handle)`；open 返回正数句柄或 -1，convert/后续 trace/check 返回 0 或 -1；close 返回 void，所有 ptr/len 为无符号字节位置/长度。结果内存归模块，JS 立即拷贝，输入堆分配并 finally 释放。

- [x] **写失败用例。** `engine/offline-formats`、`engine/long-input`、`engine/invalid-encoding`，固定 text/inline/ocd/ocd2 样例与期望；二进制 fixture 由固定版官方工具生成一次并记录来源，业务断言仍在 CLI。
  ```ts
  equal(await actualEngine('s2twp', '服务器软件'), '伺服器軟體');
  equal(await actualEngine('custom-chain', '软件'.repeat(25000)), '軟體'.repeat(25000));
  await rejectsCode(actualEngine('custom-chain', '甲\u0000乙'), 'INVALID_TEXT');
  ```
- [x] **运行红灯。** `npm run test:cli -- engine`；正确识别未实现的 engine endpoint，不以下载失败替代行为失败。
- [x] **实现真实引擎。** 克隆固定源码/emsdk 到规定目录，构建 browser/worker-only ESM；编译异常捕获和内存上限，不启用 Emscripten 动态链接；桥接预检再次拒绝非 mmseg 分词，不能让宿主漏检变成任意插件加载。桥接严格检查 UTF-8/NUL、显式字节长度及错误；Worker 内禁用网络，传入 wasmBinary/locateFile，不依赖 Electron 的 process 探测。本任务先验证固定 WASM 内存上限及返回结果大小；任务 3 在共享匹配循环中补齐生成过程预算，在此之前不宣称超限保护全部完成。实现单 Worker 串行队列、job ID/实例 generation、任务开始后的 watchdog 和 signal 取消；快照字节不能因 transfer 而让后续重载失效。记录许可。
- [x] **验证。** `npm run build:engine && npm run check && npm run test:cli -- engine`；覆盖 normalization、mmseg/缺省、两种 group 策略、多候选、混合换行、四种词典、破损词典；50,000 字不切片、不触发栈越界。比较实例销毁前后句柄数量，错误后能重新加载。
- [x] **提交。** stage 本任务源码/fixture/来源记录，不提交克隆目录和 SDK；`git commit -m "feat: run native OpenCC offline in a browser worker"`。

### Task 3: 原生逐次匹配追踪与完整词条检查

**Files:** Create `engine/trace.hpp`, `engine/trace.cpp`, `engine/patches/opencc-trace.patch`, `tests/cli/trace.test.ts`; Modify `engine/bridge.cpp`, `engine/upstream.lock.json`, `src/engine/types.ts`, `src/engine/worker.ts`, `src/engine/client.ts`, `scripts/build-engine.sh`。

**Interfaces:** 产出 `EngineClient.convert(snapshot:Snapshot, input:string, signal:AbortSignal): Promise<TraceResult>`、`checkLengths(snapshot:Snapshot, signal:AbortSignal): Promise<LengthReport>`；新增对应 C ABI `occ_trace(handle,inputPtr,len)`、`occ_check_lengths(handle)`，复用结果缓冲与错误协议。

- [x] **写失败用例。** `trace/cancelled-lengths`、`trace/normalization-origins`、`trace/group-policy`、`trace/unicode`、`trace/enumeration`：
  ```ts
  const r = await traced('甲→甲乙;丙丁→丙', '甲丙丁');
  equal(r.output, '甲乙丙'); ok(r.matches.some(m => m.inputLength !== m.outputLength));
  equal((await traced('𠀀→𠀁', '𠀀')).origins, [0]);
  equal((await scan('binary-with-longer-default')).status, 'risk');
  ```
- [x] **运行红灯。** `npm run test:cli -- trace`；应因无追踪/枚举能力或错误来源映射失败，不能只因 fixture 没有部署失败。
- [x] **实现同一原生匹配循环的观测。** 对 `Conversion.hpp/.cpp` 的真实 AppendConverted 路径增加可选 observer/预算钩子；普通与追踪调用共享匹配实现。使用公开 GetSegmentation/GetConversionChain/GetConversions/GetNormalizationConverter 遍历配置，保留 segment 边界及阶段偏移。使用 GetLexicon/GetDictGroupItems 枚举叶词典，配置根/文件位置映射独立保存；禁止 `#define private public` 或复制一套 JS 匹配逻辑。原生补丁若必须扩展到其他源文件，逐项记录原因而非绕过接口。
- [x] **验证。** `npm run build:engine && npm run test:cli -- trace`；追踪输出与 convertPlain 对每个官方/自订 fixture 相等；检查二进制词典、不可达风险条目、默认候选、分词-only 词典不误判；normalization 变长后再次分词来源正确；输出/追踪预算在生成中止住，部分检查只能 incomplete。
- [x] **提交。** stage 本任务 Files，`git commit -m "feat: trace native matches and inspect dictionary lengths"`。

### Task 4: 配置验证与完整依赖定位

**Files:** Create `src/schemes/config.ts`, `tests/cli/config.test.ts`; Modify `src/schemes/model.ts`, `package.json`, `package-lock.json`, `src/errors.ts`。

**Interfaces:** `parseConfig(text: string): ParsedConfig`（规范结构、原文与 JSON 路径）；`resolveDependencies(config: ParsedConfig, definition: SchemeDefinition): ResourcePlan`（配置来源、原引用、去重定位、virtual path、JSON 路径）；不在这些函数中联网。资源计划不得包含笔记内容。

- [x] **写失败用例。** `config/strict-known-fields`、`config/all-stages`、`config/paths`：
  ```ts
  equal(discoveredPaths(commentsAndTrailingCommaConfig), ['normalization/字典.txt','seg/词典.ocd2','../字典.txt']);
  equal(resolveVaultRef('配置/main.json', '../词典/繁体.txt'), '词典/繁体.txt');
  await rejectsCode(parseFixture({segmentation:{type:'jieba'}}), 'UNSUPPORTED_SEGMENTATION');
  await rejectsCode(resolveFixtureWithVaultEscape(), 'PATH_OUTSIDE_VAULT');
  ```
- [x] **运行红灯。** `npm run test:cli -- config`；明确记录错误字段路径、根目录越界或漏掉 normalization 的失败。
- [x] **实现解析和定位。** 使用官方 Microsoft jsonc-parser 严格检查解析错误及未知/重复键；接受核心有效的缺省 name/segmentation/group policy，不机械照搬 schema 的更严 required 字段。遍历所有阶段与嵌套 dict，按设计支持集合校验；URL 用标准 URL，vault 使用明确归一化函数，不通过盲目字符串拼接或双重百分号解码。拒绝孤立代理项/NUL、凭据 URL、未知 scheme、跨来源隐式读取及超限深度。
- [x] **验证。** `npm run check && npm run test:cli -- config`；同名不同目录不碰撞；URL `../`、绝对 URL、覆盖、依赖基址和非 HTTPS 确认；资源数/深度/配置大小边界；text 与 binary 类型不靠扩展名猜；未知字段报 JSON 路径。
- [x] **提交。** stage 本任务 Files，`git commit -m "feat: validate OpenCC configs and resolve dependencies"`。

### Task 5: URL/vault 加载、完整快照与可恢复缓存

**Files:** Create `src/schemes/resources.ts`, `src/schemes/store.ts`, `tests/fixture-server.mjs`, `tests/cli/resources.test.ts`, `tests/cli/cache.test.ts`; Modify `src/schemes/model.ts`, `src/main.ts`, `scripts/test-cli.mjs`。

**Interfaces:** `prepareScheme(app:App, definition:SchemeDefinition, signal:AbortSignal): Promise<ResourcePlan>` 只读取配置并返回资源计划；`loadPrepared(app:App, plan:ResourcePlan, engine:EngineClient, signal:AbortSignal): Promise<Snapshot>` 在确认后读取依赖、校验并生成快照。`SchemeStore(app:App, engine:EngineClient)` 提供 `load():Promise<void>`、`activate(definition:SchemeDefinition,snapshot:Snapshot):Promise<void>`、`getActive(id:string):Promise<Snapshot>`、`remove(id:string):Promise<void>`、`saveRules(rules:RuleSettings):Promise<void>`、`getRules():RuleSettings`、`getDefinitions():readonly SchemeDefinition[]`、`getStatus(id:string):SchemeStatus`、`getDefaultId():string|null`、`setDefault(id:string|null):Promise<void>`，以及 `saveDraft(definition:SchemeDefinition):Promise<void>`、`getDraft(id:string):SchemeDefinition|null`、`setStatus(id:string,status:SchemeStatus):Promise<void>`。SchemeStatus 定义为 `{kind:'unloaded'|'loading'|'ready'|'dirty'|'stale'|'unavailable',error?:PluginError,warnings:string[],snapshotId?:string,lastSuccess?:number}`；对应设计六类状态，不把草稿当活动定义。

- [x] **写失败用例。** `cache/refresh-fallback`、`cache/interrupted-commit`、`cache/source-identity`、`resources/no-note-upload`：
  ```ts
  equal(await convertAfterFailedRefresh('软件'), '軟體');
  equal(await recoveredSnapshotAfterTruncatedCommit(), previousSnapshotId);
  equal(await activeSourceAfterFailedSourceEdit(), previousSourceKey);
  equal(await fixtureRequestsDuringCachedConversion('独特正文哨兵'), []);
  ```
- [x] **运行红灯。** `npm run test:cli -- resources cache`；本地 fixture server 只绑定 loopback 且只服务白名单路径，真实 Obsidian 请求经过确认的测试 HTTP 来源。驱动 finally 关闭服务器。
- [x] **实现资源与提交协议。** requestUrl/Vault Adapter 读取，任务 token 使超时/取消后的迟到结果无效；WebCrypto 哈希资源和 sourceKey。快照目录先写资源、最后完整标记、再写活动元数据；恢复扫描已提交且身份/哈希匹配的目录，保留当前与上一版。内存 snapshot 只供一次队列任务取用，切换时释放未用资源引用；升级引擎重新 validate。元数据用双版本提交记录避免方案/默认配置自身的半写入；它不是数据库或通用存储层。编辑或首次添加先 saveDraft，加载阶段更新 status；activate 成功才更新活动定义并清除草稿，失败记录不会替换活动来源。仅改名称时沿用 sourceKey 相同的快照，不重新下载。
- [x] **验证。** `npm run test:cli -- resources cache`；真实文件更新、删除、rename 标脏，显式 reload 后生效；restart/reload 后断网读缓存；hash 损坏/标记截断/写入中止不覆盖旧版；删除方案不删源文件。测试 Unicode/空格文件名、百分号作为普通 vault 文件名、编码路径与 `../` 边界；源文件必须由宿主 vault 文件索引识别，不通过任意 adapter 路径读取系统文件。归一化不能证明符号链接的真实磁盘隔离，不冒称操作系统沙箱；若宿主允许越界链接且无法识别，记录实际证据并停下确认限制，不能引入仅桌面可用的 Node realpath 冒充跨平台解决。记录请求 API 无流式硬限额/最终重定向 URL 时的明确限制。
- [x] **提交。** stage 本任务 Files，`git commit -m "feat: load schemes with durable validated snapshots"`。

执行澄清：用户要求本地文件放入库内即可读取，不要求物理磁盘沙箱。按宿主文件索引处理；链接探针记录在 `docs/probes/vault-symlink-boundary.md`。缓存仅恢复已发布元数据引用的当前/上一版，不将未发布孤立目录自动升级为活动方案；未知/损坏遗留不批量清除。

### Task 6: Markdown 可见文字与递归区域投影

**Files:** Create `src/selection/markdown.ts`, `tests/cli/markdown.test.ts`, `tests/fixtures/markdown/`; Modify `src/selection/types.ts`, `src/selection/editor.ts`。

**Interfaces:** 在既有 Span/RuleSettings 之上定义 `Region={id:string,kind:RegionKind,source:Span,parentId:string|null}` 与 Projection；`projectMarkdown(state: EditorState, selection: Span, rules: RuleSettings): Projection`。`regionAllows(region: Region, selection: Span, rules: RuleSettings): boolean` 使用原选区，包含父链。数学区域先记录待解析节点，不将它误当普通正文放行；任务 7 接入后才验收数学转换。

- [ ] **写失败用例。** `markdown/visible-runs`、`markdown/inside-rule`、`markdown/partial-unit`：
  ```ts
  equal(projectedText('软**件**'), '软件');
  equal(projectedText('[说明](https://example.com/软件)'), '说明');
  equal(eligibleRunsForWholeNote('正文\n`代码`'), ['正文']);
  equal(sourceRangeOfVisibleEscapedBracket(), {from:0,to:2});
  ```
- [ ] **运行红灯。** `npm run test:cli -- markdown`，在真实 CM6 源码/实时预览状态构建同一组 fixture，断言纯投影结果而非浏览器截图猜测。
- [ ] **实现适配和区域树。** 使用公开 syntaxTree/ensureSyntaxTree 及注册的 editor extension，禁止索引 state.values。解析整块上下文后裁剪选区；语法树未覆盖完整上下文则报错。合并连续引用行、处理 fenced/indented code、多反引号 inline code、表格单元格；隐藏注释/frontmatter、目标/图片/嵌入、Callout 元数据按设计保护；实体使用平台解码并限制单元数量，不自行维护 HTML 实体大全。记录结构指纹供重解析比较。
- [ ] **验证。** `npm run test:cli -- markdown`；六策略中的代码/引用递归矩阵；父跳过优先；横跨两个区不伪装 inside；每个物理换行/被跳过区中断拼词；标题、列表、表格、链接别名、裸 URL、脚注、隐藏内容与 raw HTML 报错；组合字符及半个 UTF-16 字符边界不误定位。未启用数学解析前数学是显式 unsupported，不声称全套投影已完成。
- [ ] **提交。** stage 本任务 Files，`git commit -m "feat: project visible Markdown with nested region policies"`。

### Task 7: 明确支持集合内的 LaTeX 嵌套投影

**Files:** Create `src/selection/latex.ts`, `tests/cli/latex.test.ts`, `tests/fixtures/latex/`; Modify `src/selection/markdown.ts`, `src/selection/types.ts`。

**Interfaces:** `projectLatex(source: string, region: Region, selection: Span, rules: RuleSettings): MathProjection` 返回可见 units、子区、保护跨度和结构指纹；复用任务 6 的 Region/Span，不另设公式策略系统。数学编码信息存入 unit.encoding 供任务 8 序列化。

- [ ] **写失败用例。** `latex/nested-policy`、`latex/symbol-not-command`、`latex/unsupported`：
  ```ts
  equal(mathVisibleText('\\times'), '×');
  equal(eligibleMathInsideArgument('\\frac{甲}{乙}', '甲'), '甲');
  equal(eligibleChildTextWhenSelectingWholeFormula(), '');
  await rejectsCode(projectChosenUnknownMacro(), 'UNSUPPORTED_MATH');
  ```
- [ ] **运行红灯。** `npm run test:cli -- latex`；测试对真实 Markdown 数学区域取源码位置，不仅对脱离宿主的字符串 parser 断言。
- [ ] **实现有限语法递归解析。** 显式读取命令、参数、花括号、上下标和 sqrt 可选指数；准确实现设计第 5.3 节全部文字/字体命令及符号表、标准希腊字母及其变体。提供命令→显示符号→可写编码的双向表；未知命令/environment 明确报错，不按其命令名字母转换。继承原选区与父区域决策，不能先裁剪到每个子区再判断 inside。
- [ ] **验证。** `npm run test:cli -- latex`；公式内直接字符也能转换而非仅 text；嵌套分式/上下标/根指数、引用中公式、不同子区跨选、转义花括号；已跳过未知宏不导致整次失败，实际选择未知宏则全文不动。重叠/不平衡语法拒绝。
- [ ] **提交。** stage 本任务 Files，`git commit -m "feat: map supported LaTeX through recursive regions"`。

### Task 8: 转换来源合成、严格等长与安全序列化

**Files:** Create `src/selection/serialize.ts`, `src/selection/convert.ts`, `tests/cli/mapping.test.ts`; Modify `src/selection/types.ts`。

**Interfaces:** `convertProjection(projection: Projection, snapshot: Snapshot, rules: RuleSettings, engine: EngineClient, signal: AbortSignal): Promise<PatchPlan>`；`serialize(projection, convertedRuns): PatchPlan`；`validatePatch(state: EditorState, projection: Projection, patch: PatchPlan): void`。同一 run 只做一次完整配置转换，行内格式不切断词组。

- [ ] **写失败用例。** `mapping/phrase`、`mapping/strict-per-match`、`mapping/force`、`mapping/syntax`：
  ```ts
  equal(await convertedSource('软**件**', equalLengthScheme), '軟**體**');
  await rejectsCode(convertedSource('甲**丙丁**', cancellingLengthsScheme), 'LENGTH_CHANGED');
  equal(await convertedSource('甲**乙**', shrinkingScheme, {force:true}), '丙');
  equal(await convertedSource('\\[说明\\]', bracketScheme), '【說明】');
  ```
- [ ] **运行红灯。** `npm run test:cli -- mapping`；使用任务 2/3 的真实 Worker，不用自写替换表模拟关键转换。
- [ ] **实现聚合与序列化。** 在提交前完成所有 runs，按 origins 将输出分配回原 units；严格模式拒绝任一不等长 match，强制模式按起始格式；普通文字、实体/转义、代码、数学分别编码。清除空样式仅限完整选中纯样式包装；无别名 wikilink 仅完整引用可加 alias；不能删目标或改外围栏。使用捕获 state 的纯候选 transaction 生成新状态并重解析上下文，比较结构、受保护跨度、换行和 selection 外源码；不调用 editor.setValue。
- [ ] **验证。** `npm run test:cli -- mapping`；包含 emoji/补充平面汉字和组合序列；新文字生成 Markdown/数学关键字符；只选中转义的一部分且会变化则拒绝；跨链接/加粗、部分样式包装、生成代码闭合符拒绝；换行不变；任一 run 失败所有 edits 作废；无变化返回空 changes。
- [ ] **提交。** stage 本任务 Files，`git commit -m "feat: serialize traced conversion without damaging source structure"`。

### Task 9: 真实编辑器原子提交、撤销隔离与竞争保护

**Files:** Create `tests/cli/editor.test.ts`; Modify `src/selection/editor.ts`, `src/selection/convert.ts`, `src/main.ts`。

**Interfaces:** `captureTarget(view:MarkdownView): CapturedTarget` 增补每个 EditorView 单调 revision；`src/main.ts` 的插件方法 `convertSelection(target:CapturedTarget, schemeId:string, signal:AbortSignal):Promise<ConversionOutcome>` 使用实例持有的 store/engine 和 store.getRules()；`src/selection/editor.ts` 的 `commitPatch(target:CapturedTarget, patch:PatchPlan):void` 同步终检和 dispatch。ConversionOutcome 为 changed/no-change/skipped 或结构化失败，所有入口复用。右键传实际触发的 view，命令在调用当下捕获目标，不能在 await 后重新取活动视图。

- [ ] **写失败用例。** `editor/atomic-undo`、`editor/aba`、`editor/view-identity`：
  ```ts
  equal(await snapshotAfterOneUndo(), originalDocument);
  equal(await priorTypingAfterConversionUndo(), '用户先前输入仍在');
  equal(await commitAfterEditThenUndoToSameText(), {changed:false,code:'STALE_SELECTION'});
  equal(await affectedFilesWhenOtherViewGetsFocus(), ['原始目标.md']);
  ```
- [ ] **运行红灯。** `npm run test:cli -- editor`；在真实应用 editor/history 中断言，不能用数组栈伪造撤销。
- [ ] **实现提交协议。** editor extension 跟踪 docChanged revision、真实选区变化的 selectionRevision 和视图销毁；检查文件对象/捕获路径、anchor/head、scheme 是否仍存在、任务 token/readOnly 状态；异步阶段过后同步一次终检再 dispatch。CM6 transaction 使用 `isolateHistory.of('full')` 与 `Transaction.userEvent.of('input.opencc')`，保护相邻输入；后发任务取消旧任务，取消不提交结果；恢复结果对应选区，无变化不入 undo 历史。
- [ ] **验证。** `npm run test:cli -- editor`；源码/实时预览、多选拒绝、阅读提示、无选区、弹窗后 selection 改变、文档修改后撤销、同文件双视图、文件重命名/关闭、方案删除、取消/后发任务、同步修改；compare 整篇哨兵内容。另用 CLI 创建原始 CRLF 文件并记录打开/保存后的实际磁盘行为，不冒称 byte-for-byte 保真。
- [ ] **提交。** stage 本任务 Files，`git commit -m "feat: commit selection conversion atomically with stale-state guards"`。

### Task 10: 原生方案设置、快捷入口与等长检查交互

**Files:** Create `src/settings.ts`, `src/scheme-modal.ts`, `tests/cli/settings.test.ts`; Modify `src/main.ts`, `src/schemes/store.ts`, `src/engine/client.ts`。

**Interfaces:** `ConverterSettingsTab extends PluginSettingTab`、`SchemeEditModal extends Modal`、`SchemePicker extends FuzzySuggestModal<SchemeDefinition>`；使用 prepareScheme/loadPrepared/activate，不另做下载器。独立命令 ID `convert:<schemeId>`，默认 `convert-default`、选择 `convert-with-scheme`；重命名不改 ID。

- [ ] **写失败用例。** `settings/crud-default`、`settings/resource-consent`、`settings/length-report`：
  ```ts
  equal(commandIdAfterRename(), commandIdBeforeRename());
  equal(requestCountBeforeDependencyConfirmation(), 1); // 仅配置本身
  equal(await displayedStatusAfterFailedRefresh(), '使用旧缓存（刷新失败）');
  equal(await displayedIncompleteAuditBadge(), '检查不完整');
  ```
- [ ] **运行红灯。** `npm run test:cli -- settings`，通过 CLI eval/DOM 触发真实输入、按钮、菜单事件，不仅调用 store 内部方法。
- [ ] **实现交互。** 原生 Setting/Modal/TextComponent/Button 等，来源状态和失败原因可读；添加/编辑先预览依赖并确认；默认方案、独立稳定命令、删除确认、六类策略和 force 警示持久化；名称/错误文本用 textContent，不注入 HTML；等长检查显示完整/风险/不完整及快照版本。重名显示来源帮助区分，不禁止合理重名；快捷键由宿主管理。
- [ ] **验证。** `npm run test:cli -- settings`；右键与命令面板到同一转换路径；用 CLI hotkey 查询确认独立 ID 可绑定，并仅在测试 vault 验证绑定；取消和重复点击、隐藏高级字段、HTTP 风险确认、无默认方案提示、删除默认不偷偷选另一项、刷新使旧审计过期、错误中 query/凭据脱敏；键盘可达、可辨识 label、加载状态不抢焦点。
- [ ] **提交。** stage 本任务 Files，`git commit -m "feat: add native scheme management and conversion controls"`。

### Task 11: 完整 CLI 验收、移动模拟与可安装交付

**Files:** Create `tests/cli/stability.test.ts`, `README.md`, `docs/testing.md`, `docs/verification.md`; Modify `scripts/build.mjs`, `scripts/test-cli.mjs`, `package.json`, `THIRD_PARTY_NOTICES.md`, `TODO.md`。

**Interfaces:** `npm run build` 生成无测试入口的正式发布文件；`npm run check` 静态检查；`npm run test:cli -- all` 全矩阵；`npm run test:cli -- production` 不依赖 runCliSuite，只从真实命令/设置/笔记与 CLI 状态验证正式构建。所有报告包含版本、引擎 ID、用例数和通过/失败，不存真实笔记内容。

- [ ] **写失败用例。** `stability/limits-cancel`、`stability/reload-offline`、`stability/mobile-emulation`、`production/install`：
  ```ts
  equal(await convertOverLimit(200001), {changed:false,code:'INPUT_LIMIT'});
  equal(await requestsAfterReloadAndCachedConvert(), []);
  equal(await releasedArtifactHasTestHook(), false);
  equal(await conversionAfterWorkerTrapAndRecovery(), expectedText);
  ```
- [ ] **运行红灯。** `npm run test:cli -- stability production`；对缺少的限额、取消恢复、正式构建打包能力形成实际失败；已由前序任务实现的验收项可直接记录通过，不为制造红灯修改已通过功能。
- [ ] **补齐交付闭环。** 覆盖配置/资源数/深度/内存/输出/追踪/超时预算，在 Worker 内止住生成；确保只有一个队列与活动转换器，卸载后无监听/Worker/Blob 泄漏。生产构建内嵌引擎，安装只需正常 Obsidian 发布资产；README 明确 URL 基址、缓存来源、区域例子、等长、force、公式白名单、未支持配置及移动未真机验证。许可清单与锁定版本对应，不添加未授权产品许可声明。
- [ ] **最终验证。** `npm run build:engine && npm run check && npm run build && npm run test:cli -- all`；在专用 vault 用 `dev:mobile on` 检查设置/入口/横向溢出和转换，finally `dev:mobile off`。再 `npm run test:cli -- production`，正式构建重载后验证真实 URL/vault/缓存/转换/undo 和控制台错误；对更改源码做主动 LSP diagnostics。记录桌面应用/installer 版本、模拟与真机差别、通过数及残余限制；没有用户真实方案时不得宣称已验收其方案。
- [ ] **提交与报告。** stage 已审阅源码、测试、README 和验证记录，`git commit -m "test: verify packaged converter through Obsidian CLI"`；检查工作区，报告安装文件路径与证据，不推送、不发布远程 release。

## 依赖顺序、停点与审查

顺序：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11。虽然部分任务理论上可并行，此计划保持同会话串行，避免共享类型和编辑器状态互相干扰。

任务 3 是关键停点：若无法从原生核心获得可靠匹配来源或预算控制，停止并带证据讨论，不用最终长度检查或 diff 猜测替代。任务 6/7 若宿主语法不能支持已批准集合，同样先报告缺口，不悄悄扩大 unsupported 范围。任务 5 不得用“缓存文件存在”代替完整性验证。

每个任务完成后直接自查本任务 diff、对应 CLI 证据和跨模块接口，再本地提交；不因计划提到 review 就启动代理。构建、测试服务器等耗时命令使用后台任务并等自动通知，不轮询。若用户之后授权独立审查，再按授权范围增加。

## 已核对的实现依据

- 固定版 OpenCC 的 [Conversion](https://github.com/BYVoid/OpenCC/blob/025f371dc76b598d77384fbdab90c937471844d8/src/Conversion.hpp)、[ConfigBasedConverter](https://github.com/BYVoid/OpenCC/blob/025f371dc76b598d77384fbdab90c937471844d8/src/ConfigBasedConverter.hpp)、[Dict](https://github.com/BYVoid/OpenCC/blob/025f371dc76b598d77384fbdab90c937471844d8/src/Dict.hpp) 已提供本计划使用的转换链、normalization 和词典枚举访问器；精确命中 observer 仍须实施和验证。
- CM6 [isolateHistory](https://github.com/codemirror/commands/blob/main/src/history.ts) 支持 before/after/full；最终仍以专用 vault 中的相邻输入撤销测试为准，不把查到 API 当作集成已通过。

## 计划自查与规格覆盖

| 设计章节 | 所属任务 |
| --- | --- |
| 1 目标/原子性/隐私，2 平台 | 1、5、8、9、11 |
| 3 架构/队列/生命周期 | 1、2、5、9、11 |
| 4 核心/配置/追踪/等长 | 2、3、4、8 |
| 5 区域/Markdown/LaTeX/序列化 | 6、7、8 |
| 6 来源/验证/缓存恢复 | 4、5、10 |
| 7 手动检查/资源预算 | 2、3、5、10、11 |
| 8 编辑状态/提交/动态命令 | 1、9、10 |
| 9 设置/入口/隐私告知 | 10 |
| 10 CLI 验收，11 交付 | 各任务红绿验证、11 |

自查要求：所有消费的公共名称在前文 Interfaces 或类型约定中有定义；运行测试必须有本次 runId；所有首版限制来自已批准设计；五项 Review Focus 均已落到用例。任务中补充的具体实现方法是实施决策，不改变设计要求。

下一步：用户审核本计划。确认后由当前会话直接执行（superpowers:executing-plans），不启动子代理；原工作目录执行，不创建额外分支。不把批准书面设计当作本计划已获批准。
