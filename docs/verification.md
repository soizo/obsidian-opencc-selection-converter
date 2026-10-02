# 验证记录

## 阶段 1：插件入口与 CLI 闭环

执行环境：Obsidian/installer 1.13.7，专用 `OpenCC-Selection-Converter-Test` vault。功能断言在应用内运行，Node 只负责守卫、部署及读取结果。

- 红灯：真实命令注册表确认转换命令缺失；添加无方案入口后，无选区、阅读模式、多选区三项返回错误代码不符，CLI 明确退出 1。
- 绿灯：`npm run check && npm test && npm run build` 通过，CLI **6 通过 / 0 失败**：错误 vault 路径拒绝、无选区保护、阅读模式保护、有选区但无方案提示、多选区保护、默认命令注册。
- 上述保护用例同时断言测试笔记全文未变。错误 vault 守卫在任何部署写入前运行；结果只接受本次随机 run ID。
- 生产 `dist/main.js` 静态检查不含 `runCliSuite`、测试笔记目录或 smoke 用例。生产插件实际转换功能尚未实现，不能把此检查视为完整发布验收。
- 活跃 LSP 检查没有 TypeScript 错误；通用 ast-grep 的无扩展名导入告警不适用于本项目的 esbuild/Bundler 解析，三个“小类建议拆分”提示未采纳。
- 首次关闭专用库 restricted mode 会短暂重载 CLI 命令。驱动通过有时限的就绪检查等待 `onLayoutReady`，随后再次验证 vault 身份；不靠固定长延迟或 CLI 零退出码判断成功。

### 依赖审计

`npm audit --omit=dev`：0 项。完整 `npm audit` 仍有 **2 项中危**：固定 `obsidian@1.13.1` 类型包及其 `moment@2.29.4` 开发依赖，实际是同一个 [GHSA-4p3w-j4w9-5jqw](https://github.com/advisories/GHSA-4p3w-j4w9-5jqw) 沿依赖链传播。插件没有导入 moment，Obsidian API/CM6 从宿主加载而非重新打包。不执行建议的强制修复，因为它会把 Obsidian 类型降到 0.14.5。本记录不评价 Obsidian 应用自身的依赖安全。

安装包元数据指向 `obsidianmd/obsidian-api`、`microsoft/TypeScript`、`evanw/esbuild`，以及 CodeMirror/Lezer 作者维护的 GitHub 和 `code.haverbeke.berlin` 仓库；完整版本和完整性摘要固定在 `package-lock.json`。

## 阶段 2：固定版离线 OpenCC WASM

来源和工具链由 `engine/upstream.lock.json` 固定：OpenCC 1.4.2 commit `025f371dc76b598d77384fbdab90c937471844d8`，emsdk 4.0.15 commit `389a68bc35dcff7ebae4614e1615099dafda00d1`。构建脚本核对 HEAD 及 tracked 工作区，导出独立源码副本，不改外部 checkout，也不写 shell 启动配置。CMake 输出确认使用回退的准确版本 `1.4.2`，没有误取父仓库版本。

- 红灯：`npm run test:cli -- engine` 在应用内以“Native engine endpoint not implemented”失败 7 项；不是下载或 Node runner 假失败。
- 绿灯：`npm run build:engine && npm run check && npm run test:cli -- engine`；后续扩充后 engine suite **16 通过 / 0 失败**。`npm test` 连同 smoke 为 **21 通过 / 0 失败**（含驱动 vault 守卫）。
- 真实格式：inline、text、ocd、ocd2；官方 `s2twp` 配置及七份固定 ocd2 依赖得到 `服务器软件 → 伺服器軟體`。另覆盖 normalization、缺省分词、mmseg、两种 group 策略、多候选默认值、混合换行。
- 边界：50,000 Unicode 码点不切片；NUL、孤立代理项、200,001 码点、超过 8 MiB 输出、257 个资源被明确拒绝；破损 ocd2 后新 Worker 可恢复。主动任务取消会终止 Worker；队列串行执行；每次 native close 后桥接断言活动句柄为 0。
- 二进制反汇编确认实际 WASM memory 为 `(memory $0 512 4096)`：初始 32 MiB、最大 256 MiB。Worker 禁止 fetch/XHR/WebSocket，使用内嵌 `wasmBinary`；生产包扫描没有 Node/Electron 运行时依赖。
- 补齐校验后再跑红绿回归：损坏 UTF-8/NUL 文本词典、NUL/反斜线/越界虚拟路径、超大原始配置、词典达到 128 MiB 但加配置后超限，原先均失败，现均按明确代码拒绝。配置、路径、词典编码及完整快照字节数在写入虚拟文件系统之前校验。
- 生产 `dist/main.js` 约 958 KiB；不含 CLI hook 或测试 fixture。WASM、loader 和完整第三方许可文本内嵌，不依赖额外安装文件。构建逐份确认许可全文存在；许可源文件保留原始格式。引擎 ID 由实际 WASM 与 loader 的 SHA-256 派生，避免代码更新后沿用手写版本标记。
- 阶段 2 当时只在 native conversion 返回后检查输出上限，因此本阶段记录只证明拒绝；生成中的预算控制已在阶段 3 补齐，见下文。

小型格式 fixture SHA-256 记录在 `tests/fixtures/opencc/README.md`。官方 `s2twp` fixture SHA-256：

- config `681dd1ff5f3a1efe93a6f56006ee7f58f767fa0366fd3a2ec6165c983e39415d`
- CJK compatibility `4b1faa6649012f524068ec18c0fb520ead343c11cbe0a8e4c8853ca61369d666`
- STCharacters `94639fe1d2bbeb3dcb4f29a297cda70ecfd26425b8a935f4b6bac0746c3987f2`
- STPhrases `c472f936ab624e8887ed48c2572d0af68b904f0be72d98e237a6b8c1f5de024d`
- generated ST phrases `815bbb98c644095fb0bfd76dbf259b9da4350a19d4927b2342e7928fb26b20e2`
- TWPhrases `4298bc78f8ff472eed0afd31996cb35f6e56cd4ace5ef8a6d27a35a5374b9476`
- TWVariants `ed89fe928857500a77cbb601be4a1769da34ce863875eaae18d1d50bd036db5e`
- TWVariantsPhrases `a9c356943779f1d9af8b38751fe9222a02dc211a56c83f83871cfc8558afe178`

## 阶段 3：原生逐次追踪与词条检查

- 首轮红灯：6 项缺少追踪/枚举接口；312.5 MiB 扩张用例收到 `std` 而非 `OUTPUT_LIMIT`。引擎改在实际 `Conversion::AppendConverted` 匹配循环追加输出前检查预算，普通与追踪转换共用该循环。
- 第一轮绿灯：原生 WASM 构建成功，`npm run check && npm test` **28 通过 / 0 失败**。覆盖抵消的扩张/收缩、normalization 后再次分词、group 策略、码点来源、遮蔽风险词条、分词-only 词典排除、两种二进制格式，以及生成时输出上限与恢复。
- 追踪来自原生匹配观察，不从输出字符串做 diff。group 匹配定位到实际 conversion 使用的 group 根，不伪造叶词典来源。
- `.clangd` 使用构建生成的 SDK target/sysroot 编译数据库；修正最初缺失头文件的级联诊断后，三个 C++ 文件的主动 LSP 检查无错误，实际 WASM 编译也通过。
- 完整绿灯：`npm run build:engine && npm run check && npm test && npm run build && node scripts/verify-artifact.mjs && npm audit --omit=dev && git diff --check` 全部成功；应用内 CLI **35 通过 / 0 失败**。
- text/ocd/ocd2 长默认候选均报告风险，较长的未选候选不误判；官方 s2twp 含 50,000 码点输入与未追踪转换逐项一致。保留原始 segment 边界；空 group 被核心省略后仍报告正确 JSON 索引。
- 加载失败及部分枚举均返回 `incomplete`，不当作等长；保留已检查条目数与原因，取消仍拒绝。压力用例验证 19,200 个计划条目没有被部分扫描误报通过，之后可正常检查和转换。
- 追踪上限测试曾暴露原生字符串在约 48 MiB 时扩容导致提前内存失败。计数探针确认位置后，将最后一次容量增长限制到 64 MiB，避免几何扩容越过预算；探针已移除。超大追踪现按 `TRACE_LIMIT` 拒绝，后续任务恢复正常。
- 新增静态产物核验脚本复用许可证、测试隔离、ABI、Node 依赖排除和内存上限检查；不在 Node 中执行功能断言。生产包 **1,042,632 字节**；生产依赖审计 0 项。WASM 初始/最大内存仍为 32/256 MiB。
- 最后一次主动 LSP 批次为 11 个文件：0 诊断、8 个确认干净、3 个 push-only 未确认；不把后者当作已确认。实际原生编译和 TypeScript 检查均通过。
- 限制：追踪逐阶段保存中间结果，8 MiB 上限也适用于这些结果；可能比普通转换的分段临时缓冲更早拒绝超大中间结果，但不返回不同的成功输出。JSON/工作数据预算不等于整个进程的物理内存上限。当前为直接自查，未做独立代理审查。

## 阶段 4：配置验证与依赖定位

- 红灯：6 项配置用例因缺少实现失败；基础实现后 7/7 通过。随后用 10,000 层嵌套复现解析器先于深度检查抛错，增加词法预检后通过；字符串和注释中的括号不计入深度。
- `npm run check && npm test && npm run build && node scripts/verify-artifact.mjs` 通过，应用内 CLI **43 通过 / 0 失败**。官方 s2twp 经依赖去重和虚拟路径重写后仍得到 `伺服器軟體`。
- 覆盖 JSONC、重复/未知字段与配置路径、全部转换阶段、URL 基址和显式覆盖、vault 越界与百分号字面量、来源隔离、凭据/危险协议拒绝、资源数量和编码边界。依赖类型不按扩展名猜测，原配置对象不修改。
- 本阶段不联网；HTTP 来源汇总到计划并标记需要确认。后续加载阶段必须在请求前落实确认，不能把计划标记当成已经获得授权。
- 使用官方 Microsoft `jsonc-parser@3.3.1`，MIT 原文已纳入产物。生产包 **1,044,161 字节**，静态产物检查通过。主动 LSP：0 诊断，2 文件确认干净、2 文件 push-only 未确认；TypeScript 编译检查通过。
- 生产审计首次尝试因 npm bulk 请求失败后回退到旧接口而收到 HTTP 400，尚不能声明审计通过；`npm ls --omit=dev --depth=0` 确认生产树仅有固定版 jsonc-parser。随后重试 `npm audit --omit=dev --registry=https://registry.npmjs.org --fetch-retries=1` 成功，报告 **0 项漏洞**；未执行强制修复或重装。

## 阶段 5：资源加载与持久快照

- 先观察资源加载 4 项红灯、缓存核心 3 项红灯，再逐步实现；后续草稿、重载、状态和保留策略的缺口均有应用内失败记录。
- 最终 `npm run check && npm test && npm run build && node scripts/verify-artifact.mjs && git diff --check` 通过：CLI **59 通过 / 0 失败**，生产包 **1,095,776 字节**。运行的是专用 Obsidian vault，不是 Node 业务测试。
- URL 通过宿主 requestUrl 读取；HTTP 地址逐项批准，vault 文件通过宿主索引与 TFile 读取。覆盖 Unicode/空格/百分号文件名、取消、HTTP 失败、来源身份、字典实际原生转换，以及转换过程中没有额外请求。
- 双版本元数据、资源 SHA-256、快照完整标记及发布前回读校验。覆盖刷新失败、元数据半写、标记截断、资源损坏后的旧版回退；两份元数据都损坏时拒绝重置。草稿不替代活动来源，规则/默认值可恢复，仅改名复用已有快照，删除不碰源文件。
- CLI 在缓存准备完成后真正关闭本地资源服务器，再 `plugin:reload`；新插件实例从磁盘恢复并成功转换。缓存读取重新进行原生验证，不持有全部方案的资源字节。
- 状态查询比较源文件版本，覆盖修改、rename、删除以及显式重载。状态/加载中错误提示是会话态，活动定义、草稿、规则、默认值和快照引用持久化。
- 成功提交后回收曾发布但已不再引用的旧快照，保留当前与上一版；未知目录、失败写入遗留和无法校验的内容保留，不进行全目录破坏性扫除。清理失败不撤销已经成功的提交。实测宿主非递归 rmdir 对空目录返回 EISDIR，改为复查为空后调用宿主递归删除。
- HTTP API 无流式下载硬上限、底层取消或最终重定向地址暴露：大小在返回后检查，超时/取消使迟到结果失效，相对路径使用明确配置地址/基址，不承诺最终重定向传输协议可被检查。
- 用户澄清本地来源只要求“放入库内即可读取”，不要求物理磁盘沙箱；采用 Obsidian 文件索引边界。符号链接探针与原始证据见 `docs/probes/vault-symlink-boundary.md`。
- 主动 LSP 检查曾返回 0 诊断，3 文件确认干净、3 文件 push-only 未确认；最终 TypeScript 编译检查通过。未进行独立代理审查。

## 阶段 6：Markdown 投影初版

- 专用 Obsidian CLI：全套 **78 通过 / 0 失败**；源码模式和实时预览均覆盖跨格式词组、链接文字、实体完整/部分源码单元、简单 wikilink 别名定位、隐藏内容、表格、代码、引用嵌套策略矩阵、引用式链接、Unicode 边界及 200,000 标量上限。
- 使用公开 ensureSyntaxTree 和注册的编辑器扩展；不读取 state.values。先识别整块上下文再裁剪，解析不完整时报错。实体使用平台 DOMParser 解码单个合法引用，并限制数量；不解析任意 HTML 输入。
- 红灯暴露实体未解码、表格上下文缺失、链接定义保护不全，以及同一缩进代码行被重复建区的问题，修复后通过。测试另修正引用惰性续行的错误预期，并等待编辑器实际收到文件更新后再取状态。
- `npm run check && npm test && npm run build && node scripts/verify-artifact.mjs && git diff --check` 通过。产物仍为 1,095,776 字节：投影尚未接入用户命令，不把测试覆盖等同于完整用户功能交付。主动 LSP：0 诊断、3 文件确认干净、1 文件未确认。
- 阶段 6 验证时数学投影尚未启用；后续阶段 7 已接入支持集合。带路径、标题或块引用的无别名 wikilink 暂时明确拒绝；此兼容性缺口留待最终验收，不能宣称已覆盖所有 wikilink。原始 HTML 明确拒绝。宿主语法树证据见 `tests/fixtures/markdown/`。

## 阶段 7：有限 LaTeX 嵌套投影

- 先观察 8 项缺少实现的红灯，再实现递归解析；后续用例暴露未知宏参数被当作普通文字、重复上下标未拒绝、引用前缀混入块公式，修复后数学专项 13/13 通过。
- 源码模式/实时预览均通过真实数学区域位置测试：直接字符、符号/希腊变体、全部十二种文字/字体命令、分式、根指数、嵌套上下标、转义与部分命令、引用内块公式、未知环境和不平衡结构。仍遵循原始选区及父区域规则，不把子参数裁剪后冒充 inside。
- 命令与可见符号有正反映射，命令源码作为完整单元；未知宏可能影响后续参数时保守拒绝。已整体跳过的子区不解释其宏。递归深度上限 64；不是完整 TeX 实现。
- 全套 `npm run check && npm test && npm run build && node scripts/verify-artifact.mjs && git diff --check` 通过：**90 通过 / 0 失败**。产物仍为 1,095,776 字节，用户转换入口尚未接通。主动 LSP：0 诊断，2 文件确认干净、2 文件未确认。

## 尚未验收

阶段 8–11 尚未完成：写回、设置界面与完整用户工作流尚未接通；复杂无别名 wikilink 仍有兼容性缺口。加载和缓存已有真实宿主验证，但默认转换命令仍返回 NO_SCHEME。尚未进行 Android/iOS 真机验证。可行性探针不替代正式插件验收。
