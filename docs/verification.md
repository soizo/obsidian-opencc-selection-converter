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

## 尚未验收

阶段 4–11 尚未完成；缓存、源码投影、写回或设置管理没有完成证据。方案资源当前仅由测试构造，不能视为用户方案加载功能。尚未进行 Android/iOS 真机验证。可行性探针不替代正式插件验收。
