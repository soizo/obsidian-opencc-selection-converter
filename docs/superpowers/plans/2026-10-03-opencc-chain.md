# OpenCC Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本项目未经明确要求不使用子代理。

**Goal:** 添加可独立保存、离线使用的有序转换链，以及 `t2gov` 和 `s2gov = 官方 s2t → t2gov` 预设。

**Architecture:** 保留单配置方案和快照的原有磁盘格式，增加非递归链类型；链快照包含有序完整配置和隔离路径的扁平资源集合。Worker 在一个作业内逐步执行完整配置并复合来源映射；继续使用现有快照发布与编辑器最终一次提交机制。

**Tech Stack:** TypeScript 5.9、Obsidian 原生 UI、现有 OpenCC WASM Worker、jsonc-parser、现有 Obsidian CLI 集成测试；无新依赖或原生引擎改动。

**Spec:** `docs/superpowers/specs/2026-10-03-opencc-chain-design.md`（用户已批准）。

## Global Constraints

- 转换链至少包含两个步骤，最多 16 步；单个方案仍使用原有入口。
- 允许重复使用同一单一方案；不支持链中嵌套链。
- 保存时复制各步骤的来源定义及可用快照，形成独立、完整的链快照。不依赖原方案在未来仍然存在。
- 后续编辑、刷新或删除原方案不会悄悄改变已保存的链。
- 保留离线缓存、严格等长检查、Markdown 保护、取消操作和一次撤销；任何阶段失败都不写入文档。
- 资源数量、总字节数、配置大小与执行时间限制在整条链层面有效，不能按步骤重复获得预算。
- UI 沿用 Obsidian 原生组件，中英文文案简短，不引入 UI 库或新的运行时依赖。
- 不做无关重构，不修改原生 OpenCC 实现，不改变默认区域规则，不自动提交或推送。
- 测试仅使用 `~/Desktop/PlayGround/OpenCC-Selection-Converter-Test`；不要并发运行会部署或清空该 vault 缓存的测试命令。

## Review Focus

1. 同一方案重复出现及同名词典内容不同：不去重转换步骤，不混用资源。（Tasks 1、2）
2. 编辑链时原方案已删除，或原方案已有新版本：保存、改名、重排仍使用该链自己的步骤快照，除非用户显式替换或刷新。（Tasks 3、5）
3. 后续步骤改变长度后再恢复原长度，含非 BMP 字符：严格模式仍拒绝，Force 模式来源映射不越界。（Tasks 2、6）
4. HTTP 审阅返回编辑、重复 URL、异步取消：授权不扩大到域名，不因另一步获准而漏检当前步骤，不发布部分链。（Tasks 3、5）
5. 缓存元数据声明空链、嵌套链、超长链、资源越界或配置/来源顺序不匹配：拒绝使用或回退旧版本，不误判为空操作成功。（Tasks 1、3）

## 文件与职责

- `src/schemes/model.ts`：单方案/链、单计划/链计划、单快照/链快照类型。
- `src/schemes/resources.ts`：来源身份、链校验、现有资源准备/加载扩展、离线快照组合与拆分。
- `src/schemes/config.ts`：保持仅解析真正的 OpenCC 配置，收窄单方案类型，不接受插件链描述作为 OpenCC JSON。
- `src/schemes/store.ts`：两类快照的序列化、校验、恢复及审计警告汇总，保持现有提交机制。
- `src/engine/worker.ts`：完整配置顺序执行、trace 来源复合和审计汇总。
- 新增 `src/schemes/presets.ts`：从弹窗移出现有预设目录，统一生成官方和大陆繁体方案定义。
- `src/scheme-modal.ts`、`src/settings.ts`、`src/locales/{en-GB,zh-Hans}.ts`、必要的 `styles.css`：链编辑与来源展示。
- `tests/cli/{config,engine,trace,resources,cache,cache-restart,mapping,editor,settings}.test.ts`：在现有专项追加测试，不建立新的测试框架。
- `tests/fixture-server.mjs`、新增 `tests/fixtures/opencc/gov/`：固定版本大陆繁体与官方 s2t 的可重复加载夹具。
- `scripts/test-cli.mjs`：只扩展正式包验收流程；现有完整专项列表可继续使用。
- `README.md`、`THIRD_PARTY_NOTICES.md`、新增 `engine/licenses/t2gov.txt`、`docs/verification.md`：使用、来源许可和验证证据。

## 类型与接口约定

在 `model.ts` 将当前类型命名为 `SingleSchemeDefinition`、`SingleResourcePlan`、`SingleSnapshot`，并导出兼容入口联合类型：

```ts
type ChainSchemeDefinition = {
  id: string;
  name: string;
  source: { kind: 'chain'; steps: SingleSchemeDefinition[] };
};
type SchemeDefinition = SingleSchemeDefinition | ChainSchemeDefinition;
type ChainResourcePlan = {
  definition: ChainSchemeDefinition;
  steps: SingleResourcePlan[];
  warnings: string[];
  httpUrls: string[];
  requiresHttpConfirmation: boolean;
};
type ResourcePlan = SingleResourcePlan | ChainResourcePlan;
type SnapshotStep = Omit<SingleSnapshot, 'resources'>;
type ChainSnapshot = {
  id: string; schemeId: string; sourceKey: string; engineId: string;
  createdAt: number; sourceVersions?: SourceVersion[];
  steps: SnapshotStep[];
  resources: LoadedResource[];
};
type Snapshot = SingleSnapshot | ChainSnapshot;
```

以 `definition.source.kind === 'chain'` 或 `'steps' in snapshot/plan` 缩窄类型，不为旧缓存强加新 discriminant。`SnapshotStep` 的 ID 是来源元数据，不是对子快照目录的持有引用；链的磁盘目录保存完整字节。缓存类型必须保留联合成员，不能对联合直接使用会丢失成员字段的 `Omit<Snapshot, 'resources'>`。

## Task 1: 链类型、来源身份和快照组合

**Files:** `src/schemes/{model,config,resources,store}.ts`、`src/engine/worker.ts`、`src/{scheme-modal,settings,limits}.ts`、`tests/cli/config.test.ts`、`tests/cli/engine.test.ts`，以及因联合类型需要显式缩窄的现有单方案夹具。此任务仅对尚未实现的消费者增加明确拒绝链的类型分支，不提前实现后续任务。

**Interfaces:** 保持 `schemeSourceKey(definition: SchemeDefinition): Promise<string>`；新增 `combineSnapshots(definition: ChainSchemeDefinition, steps: readonly SingleSnapshot[]): Promise<ChainSnapshot>` 和 `splitChainSnapshot(definition: ChainSchemeDefinition, snapshot: ChainSnapshot): Promise<SingleSnapshot[]>` 于 `resources.ts`。单方案版本的 `prepareScheme`、`loadPrepared` 使用重载保留具体返回类型。

- [ ] **1. 写失败测试。** 从现有 `schemeSourceKey` 入口提交链定义，验证来源身份的行为，测试名 `config/chain-source-identity`；首次可将链输入断言为原有类型，避免以编译失败冒充行为失败。

```ts
equal(await schemeSourceKey(chain), await schemeSourceKey({ ...chain, name: '改名' }));
ok(await schemeSourceKey(chain) !== await schemeSourceKey(reversed));
// 更改任一步 source/dependencyBase/overrides 必须改变 key；单方案 key 不变。
```

- [ ] **2. 运行 RED。** `npm run test:cli -- config`；确认新增测试因不支持链而失败，旧测试仍通过。
- [ ] **3. 实现类型和身份。** 保留单方案 key 的原有编码算法；链使用带版本标签的有序单方案 key 数组计算身份，不把名称、原方案 ID、HTTP 授权列表算作来源内容。添加 `LIMITS.chainSteps = 16`；活动链只接受 2–16 个合法单方案，拒绝嵌套，不通过强制类型断言绕过运行时校验。
- [ ] **4. 写组合/拆分测试再实现。** `combineSnapshots` 核对步骤数量、每步来源身份与 engineId，深拷贝资源并按 `step/<index>/` 前缀重写配置中引用的虚拟路径；汇总 sourceVersions。重复步骤保留两次。`splitChainSnapshot` 校验整链身份，再从自包含内容还原可重排的单步骤，不读取原方案目录或源文件。覆盖 `same.txt` 分别含 `甲→乙`、`乙→丙`、源对象未修改、错误身份拒绝、空/单步/17 步/嵌套拒绝、16 步接受。
- [ ] **5. 运行 GREEN。** `npm run check` 和 `npm run test:cli -- config` 全通过；检查 diff 仅包含此任务及必要类型适配。

## Task 2: Worker 顺序执行与 trace 复合

**Files:** `src/engine/worker.ts`、`tests/cli/{engine,trace}.test.ts`。

**Interfaces:** `EngineClient.validate/convertPlain/convert/checkLengths` 签名不变，接受 Task 1 的 `Snapshot` 联合；`TraceResult`、`LengthReport` 对调用者保持不变。

- [ ] **1. 写失败测试。** 新增 `engine/chain-resegment`：A 用单字分词把 `甲乙→丙丁`，B 的 normalization 把完整 `丙丁→戊己`，再转换 `戊己→庚辛`；断言最终 `庚辛`。分别顺序调用真实原生引擎作为差分校验，并断言手写预期，避免两边共同出错。
- [ ] **2. 运行 RED。** `npm run test:cli -- engine trace`；确认链未被执行，而非夹具无效或宿主启动失败。
- [ ] **3. 实现执行。** 在现有 `execute(request: EngineRequest): Promise<EngineOutput>` 内保留单作业生命周期，校验全部配置与资源预算，安装隔离资源；按顺序打开/转换/关闭每个配置。将 `parseReport` 校验输入改为当前步骤输入，不用原始输入检查后续步骤。单方案输出与路径保持原样。
- [ ] **4. 写来源和审计测试再实现。** `trace/chain-origins` 使用 A `甲→乙乙`、B `乙乙→丙`，输入 `甲𠀀`：

```ts
equal(result.output, '丙𠀀');
equal(result.origins, [0, 1]);
equal(result.matches.map(m => [m.inputLength, m.outputLength]), [[1, 2], [2, 1]]);
equal(report.status, 'risk');
```

  每步来源复合为 `next.origins.map(index => previousOrigins[index])`；保留全部匹配的步骤本地标量区间，并给 `stagePath/dictPath` 加 `$.steps[index]` 前缀。审计汇总计数、风险和原因：incomplete 优先于 risk，risk 优先于 equal，snapshotId 指向整链。
- [ ] **5. 写预算和恢复测试再实现。** 总配置文本字节、256 个资源、128 MiB 快照、64 MiB trace 和 30 秒作业超时均不能按步骤重置；原文配置总量与虚拟配置总量分别受现有 2 MiB 限制。中间输出仍受 8 MiB 限制，进入下一原生调用仍遵守其输入限制，超限拒绝整链。覆盖后步损坏词典、跨步累计 trace 超限、取消后下一单方案可用、同名词典与重复步骤按序执行、空字符串、非 BMP 字符。
- [ ] **6. 运行 GREEN。** `npm run check` 和 `npm run test:cli -- engine trace`；无新增句柄/文件残留，单方案差分测试全部保留。

## Task 3: 资源准备、HTTP 审阅与持久化

**Files:** `src/schemes/{resources,store}.ts`、`tests/cli/{resources,cache,cache-restart}.test.ts`。

**Interfaces:** `prepareScheme(app: App, definition: SchemeDefinition, signal: AbortSignal): Promise<ResourcePlan>`、`loadPrepared(app: App, plan: ResourcePlan, engine: EngineClient, signal: AbortSignal): Promise<Snapshot>` 保持入口名；`SchemeStore` 的公有方法签名不变。Task 1 的组合/拆分支持离线创建与重排。

- [ ] **1. 写失败测试。** `cache/chain-independent` 加载两个合成单方案并组合、activate，移除原方案并删除源文件，重新 `SchemeStore.load()` 后断言链输入 `甲` 输出 `丙`。还原旧单方案缓存同时验证 `软件→軟體`，证明没有破坏旧格式。
- [ ] **2. 运行 RED。** `npm run test:cli -- resources cache`；确认新链在加载/提交处失败。
- [ ] **3. 扩展资源路径。** 链 prepare 返回每步单计划及聚合警告和精确 HTTP URL；任何 HTTP 配置必须先获得授权才读取。load 捕获完整审阅计划，各步资源只按所属步骤授权读取，累计预算后用 `combineSnapshots` 组装并验证一次整链。开始和结束检查所有本地版本；中途失败不发布。
- [ ] **4. 扩展缓存。** 存储扁平资源文件与有序步骤元数据，校验计数、配置、虚拟路径、来源顺序与 identity 后交给 engine.validate；警告从全部步骤汇总。草稿允许尚未凑齐两步的非嵌套链，以便失败后恢复编辑，但仍拒绝非法字段类型、超过 16 步与嵌套；活动方案必须完整。保留双槽提交、上一版回退、只清理所属完整快照目录的规则。
- [ ] **5. 补失败路径和真实重启测试。** 新增链版中断 metadata 写入、损坏资源回退、步骤重排 key 变化、改名复用 snapshotId、缺失原方案后的拆分/重排；测试一个 HTTP 步骤获准但另一步未获准会失败，重复 URL 审阅不产生域授权，取消不发布。扩展 `cache-restart` ticket 同时保存单方案和链，停止夹具服务器并真实重载插件后两者都可用。
- [ ] **6. 运行 GREEN。** `npm run check` 和 `npm run test:cli -- resources cache` 全通过，包含驱动自动执行的真实离线重启阶段。

## Task 4: 固定上游预设与许可

**Files:** 新增 `src/schemes/presets.ts`、`tests/fixtures/opencc/gov/`、`engine/licenses/t2gov.txt`；修改 `src/scheme-modal.ts`（现有预设入口）、`src/locales/{en-GB,zh-Hans}.ts`（预设名称）、`tests/fixture-server.mjs`、`tests/cli/{resources,settings}.test.ts`、`THIRD_PARTY_NOTICES.md`。

**Interfaces:** `presets.ts` 导出 `PRESETS`（id、名称 MessageKey、来源归属）与 `presetDefinition(id: PresetId): SchemeDefinition`。沿用现有 12 个官方预设的 URL 和依赖基址；新增 `t2gov` 为单 URL 方案，`s2gov` 为包含官方 s2t 与 t2gov 的链，不要求用户先手动添加子方案。

- [ ] **1. 准备固定夹具并写失败测试。** 通过 `gh api` 读取上游提交 `67f2c7293e9ce226fcc1ee15cdb60b9b9dfd5c60` 的 `t2gov/t2gov.json`、三个实际引用的 txt 词典和 LICENSE；官方 s2t 固定 `opencc@1.4.2`，复用已有相同版本官方二进制词典，缺少的配置按固定来源取得。夹具 README 记录准确来源、提交、SHA-256、许可证。根据上游词条选择至少三个有差异的短输入，把人工核对的输出写成字面量；另测 `s2gov(input) === t2gov(s2t(input))`。
- [ ] **2. 运行 RED。** 先在现有 `settings/official-presets` 测试中断言可选 `t2gov`、`s2gov` 并运行 `npm run test:cli -- settings`，确认缺少选项的行为失败，不以新增模块未导出造成的构建错误作为 RED。目录建立后追加 resources 测试，通过本地夹具服务器走真实 `prepareScheme/loadPrepared`，不靠现场互联网决定回归结果。
- [ ] **3. 实现目录。** `t2gov` URL 使用 `https://cdn.jsdelivr.net/gh/TerryTian-tech/OpenCC-Traditional-Chinese-characters-according-to-Chinese-government-standards@67f2c7293e9ce226fcc1ee15cdb60b9b9dfd5c60/t2gov/t2gov.json`；词典相对该地址解析。s2gov 步骤 1 使用原有 npm `s2t.json` 与 `prebuilds/assets/` 基址，不能误用该仓库的同名 s2t。保留上游完整 Apache-2.0 文本，更新 notices；现有 build 会自动将许可嵌入 main.js。
- [ ] **4. 接入现有预设入口并运行 GREEN。** 将 modal 的预设目录和生成定义改用新模块；预设链不进入尚未实现的自定义链编辑表单，但加载和审阅必须支持 Task 3 的链计划。补齐预设名称，使用中性「预设 / Presets」入口并展示来源归属。`npm run check` 和 `npm run test:cli -- resources settings` 全通过；再在专用 vault 真实加载两个 CDN 预设并运行相同样例，记录网络可用性与结果。不用现场成功代替固定夹具测试，网络失败如实记录。

## Task 5: 原生转换链编辑 UI

**Files:** `src/scheme-modal.ts`、`src/settings.ts`、`src/locales/{en-GB,zh-Hans}.ts`、必要的 `styles.css`、`tests/cli/settings.test.ts`。

**Interfaces:** `SchemeEditModal`、`SchemePicker` 和设置页入口不变；使用 Task 4 的目录与 Task 1 的离线组合/拆分，刷新仍使用 Task 3 的 prepare/load。新增 `schemeLocation(definition: SchemeDefinition): string` 在弹窗模块生成安全来源展示，链显示步骤名称而非伪造 URL。

- [ ] **1. 写 UI 失败测试。** 在真实设置页添加 A `甲→乙`、B `乙→丙`，选择来源 `chain`，添加 A/B 并保存，断言命令可用且输出 `丙`；编辑为 B/A 后输出 `乙`。新增预设选项测试验证两个新增项可生成正确来源，而不仅断言下拉文字。
- [ ] **2. 运行 RED。** `npm run test:cli -- settings`；确认缺少 chain 来源或预设入口导致失败。
- [ ] **3. 实现编辑。** 来源下拉新增「转换链 / Conversion chain」，复用原生 Setting、Dropdown、Button/ExtraButton。每步独立选择已有单方案并具有带可访问名称的上移、下移、移除按钮；首尾移动禁用，16 步后添加禁用。少于两步保存显示内联错误。保留一行说明「保存后独立于原方案；刷新才重新加载来源」。首次加入步骤捕获其来源定义与活动快照，保存时核对身份，不悄悄替换成更新版本。
- [ ] **4. 实现离线编辑与审阅。** 编辑已有链时从自身快照恢复全部步骤，即使原方案已删除也显示其保留名称。仅改名复用活动快照；重排/删换步骤用保留与新选择的快照重新组合。显式刷新才重新读取保存来源。警告/HTTP 审阅按步骤展示并将确认传播到相应单计划；返回编辑不丢失步骤和名称，关闭/取消不改变活动方案。
- [ ] **5. 完善展示。** 沿用 Task 4 的中性预设入口，两个新增名称使用「繁体 → 大陆繁体」「简体 → 大陆繁体」及对应英文；保留 TerryTian-tech 来源说明。重复添加判断用来源身份，不再假定所有预设都有单一 URL。更新 picker 和审计来源展示的联合类型分支。
- [ ] **6. 补回归后运行 GREEN。** 覆盖无可选单方案、重复步骤、2/16 步边界、原方案删除后离线改名重排、先改原方案再保存链不偷换版本、HTTP 审阅返回、默认项、稳定命令 ID 和删除链不删除源文件。`npm run check` 与 `npm run test:cli -- settings` 全通过。

## Task 6: 原子选区验收、宿主 UI 与交付文档

**Files:** `tests/cli/{mapping,editor}.test.ts`、`scripts/test-cli.mjs`、`README.md`、`docs/verification.md`；必要时只修复相关生产路径。

**Interfaces:** `convertProjection`、`convertSelection`、`commitPatch` 保持现有签名与单次提交行为；它们消费 Task 2 的聚合 TraceResult，无需另一条链专用写入通道。

- [ ] **1. 写并运行选区回归。** 为 mapping helper 增加完整配置快照入口，保持旧测试调用不变。新增链版严格拒绝扩长再缩短、Force 跨格式映射、最终不变不重排格式、链接目标及选区外原文保护；字面量断言包括 `甲**乙**` 经 `甲乙→丙→丁戊己` 后为 `丁戊己`（Force），同链严格模式 `LENGTH_CHANGED`。编辑器用链执行 source/live 两种模式，成功一次撤销，后步失败/取消/选区过期完全不写入。运行 `npm run test:cli -- mapping editor`，实际失败才修生产逻辑。
- [ ] **2. 扩展正式包验收。** 在 `runProduction` 现有流程增加通过真实 UI 创建两个合成单方案和链，执行默认或链命令并一次撤销；仍断言正式包没有 `runCliSuite`。运行 `npm run test:cli -- production`。
- [ ] **3. 宿主视觉与可访问性检查。** 在专用 Obsidian vault 批量检查深色/浅色、常规/窄窗口下的新增、编辑及审阅弹窗；检查键盘完成步骤添加和移动、焦点不丢失、按钮名称、长名称换行及无横向溢出。记录截图路径与结果；恢复原主题/窗口设置。不要操作 Ghostty。最多一次批量检查、一次集中修正后复查。
- [ ] **4. 最终验证。** 顺序运行 `npm run check`、`npm run test:build`、`npm test`、`npm run test:cli -- production`；对改动 TS 文件主动运行 LSP 诊断。检查 `git diff --check`、diff 与 status。长运行命令通过 bg_run，等待完成通知，不轮询。完整矩阵仅在交付前运行一次，若失败则针对失败项修复并明确报告重跑范围。
- [ ] **5. 更新文档与交付。** README 说明链范围、独立快照、显式刷新和两个新预设的来源；verification 记录真实命令结果、宿主 UI 证据及未验证的真机限制。更新本计划和规格的完成状态，仅声明有证据的结果，不提交或推送。

## 计划自查与执行交接

- [x] 每个规格章节对应上述任务；无额外产品范围。
- [x] 链定义、计划、快照及 helper 名称在各任务中一致；明确旧格式和来源身份兼容。
- [x] 五项 Review Focus 均有归属测试；覆盖独立离线生命周期、来源权限与单次提交。
- [x] 不引入原生重编译、新依赖、新框架或子代理。
- [x] 用户审阅实施计划并确认按当前会话直接执行。

在上述审阅完成前，不开始功能实现。用户未要求 Git 分支或提交，因此默认在当前工作区保留聚焦改动，不创建分支、不提交、不推送。
