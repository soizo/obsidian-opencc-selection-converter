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
- 当前输出上限在 native conversion 返回后检查；按批准计划，阶段 3 才把输出与追踪预算移进共享匹配生成循环。因此这里只验证拒绝，不宣称限制转换过程中的瞬时输出内存。

小型格式 fixture SHA-256 记录在 `tests/fixtures/opencc/README.md`。官方 `s2twp` fixture SHA-256：

- config `681dd1ff5f3a1efe93a6f56006ee7f58f767fa0366fd3a2ec6165c983e39415d`
- CJK compatibility `4b1faa6649012f524068ec18c0fb520ead343c11cbe0a8e4c8853ca61369d666`
- STCharacters `94639fe1d2bbeb3dcb4f29a297cda70ecfd26425b8a935f4b6bac0746c3987f2`
- STPhrases `c472f936ab624e8887ed48c2572d0af68b904f0be72d98e237a6b8c1f5de024d`
- generated ST phrases `815bbb98c644095fb0bfd76dbf259b9da4350a19d4927b2342e7928fb26b20e2`
- TWPhrases `4298bc78f8ff472eed0afd31996cb35f6e56cd4ace5ef8a6d27a35a5374b9476`
- TWVariants `ed89fe928857500a77cbb601be4a1769da34ce863875eaae18d1d50bd036db5e`
- TWVariantsPhrases `a9c356943779f1d9af8b38751fe9222a02dc211a56c83f83871cfc8558afe178`

## 尚未验收

阶段 3–11 均未完成：没有逐次匹配追踪、缓存、源码投影、写回或设置管理的完成证据。方案资源当前仅由测试构造，不能视为用户方案加载功能。尚未进行 Android/iOS 真机验证。可行性探针不替代正式插件验收。
