# 技术可行性与验证记录

状态：设计前验证，尚无插件实现。以下结论不能作为插件已可用的证明。

## 验证环境

- macOS，Obsidian 应用及 installer 均为 1.13.7。
- 所有运行时验证由 Obsidian CLI 驱动，并显式选择 `vault=OpenCC-Selection-Converter-Test`。
- 专用 vault：`~/Desktop/PlayGround/OpenCC-Selection-Converter-Test`。测试未读写用户其他 vault 的笔记。
- CLI 没有公开的创建 vault 子命令。本次通过 CLI `eval` 检查已安装应用的 `vault-open` IPC 处理器后，调用其“新建”模式：目标存在时拒绝创建，不覆盖现有目录。这是一次性的测试环境引导，不应成为插件运行依赖。
- 原始资料、临时探针和结果在 `~/Desktop/PlayGround/opencc-selection-research/`，不是产品代码。

## 1. 引擎选型

### 纯 JavaScript：不作为首选

`nk2028/opencc-js` 提供浏览器转换、内置词典和自订替换表，但作者明确说明不保证所有输入与原生 OpenCC 一致，其 API 也不是原生配置加载 API。不能把 `CustomConverter` 等同于完整 JSON 配置及二进制词典支持。

来源：[opencc-js 作者文档](https://github.com/nk2028/opencc-js)。

### 官方 Node 原生包：不适合两端统一

`opencc` 是官方 C++ 的 Node 绑定，包包含平台特定的原生依赖。Obsidian 官方文档指出，移动端没有 Node.js/Electron API；因此它不适合作为本项目的统一运行时。

来源：[OpenCC package.json](https://github.com/BYVoid/OpenCC/blob/ver.1.4.2/package.json)、[Obsidian 移动开发文档](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Getting%20started/Mobile%20development.md)。

### C++ WebAssembly：优先验证

OpenCC 官方 README 列出 `opencc-wasm`，其维护仓库为 `frankslin/OpenCC` 的 `wasm-lib`，是独立维护的移植，不冒称官方 Node 包或官方发布的 WASM。

已下载 npm `opencc-wasm@0.13.1` 到临时验证目录，使用 `npm pack --ignore-scripts`，未向插件项目安装依赖。其 ESM WASM 约 715 KiB；整个 npm 包解包约 24.8 MB，不宜把所有打包数据直接计为最小插件体积。

- 包 SHA-256：`6bb31beb3a47dda984e53324176c4f563f5c889adf0946a8d2219c0af0dc8a4d`
- ESM WASM SHA-256：`2f9dbaf3cac799dedc37e6c8918bf408de54590b57928cbb7502633b7dac7c73`

底层导出包括配置加载、转换、阶段检查、销毁和 Emscripten 内存文件系统。适合将用户配置及依赖放入隔离的虚拟目录后执行，而不是把词典扁平化为自订替换表。

高层 `Converter()` 默认会自动从 CDN 加载资源，不能不加限制地用于本项目。应在加载层统一解析、展示并缓存资源，把引擎代码和 WASM 随插件发布，不运行时下载可执行代码。

来源：[官方 OpenCC README](https://github.com/BYVoid/OpenCC/blob/ver.1.4.2/README.md)、[WASM 作者文档](https://github.com/frankslin/OpenCC/tree/fe5516a9e8110998c9ae62dad3cdf208d3ed4bed/wasm-lib)、[构建脚本](https://github.com/frankslin/OpenCC/blob/fe5516a9e8110998c9ae62dad3cdf208d3ed4bed/wasm-lib/build.sh)、[底层绑定](https://github.com/frankslin/OpenCC/blob/fe5516a9e8110998c9ae62dad3cdf208d3ed4bed/wasm-lib/src/main.cpp)。

## 2. 配置并非只有 conversion_chain

官方 1.4.2 配置包含 normalization、可选 segmentation、conversion_chain，以及 text/ocd/ocd2/inline/group 词典。嵌套 group 有匹配策略；分词插件还能声明资源。资源发现必须覆盖全部这些位置，不能只遍历转换链。

官方解析器接受注释和尾逗号。宿主加载层不能用严格 `JSON.parse` 提前拒绝引擎本来接受的配置，也不能忽略未知配置项。支持范围应针对固定引擎版本列出；任意本机动态分词插件不能默认视为 WASM 可用。

来源：[官方配置 schema](https://github.com/BYVoid/OpenCC/blob/ver.1.4.2/data/config/opencc_config.schema.json)、[Config.cpp](https://github.com/BYVoid/OpenCC/blob/ver.1.4.2/src/Config.cpp)。

## 3. 源码映射不能只检查总长度

官方 `Inspect()` 返回初始分词、各阶段分段结果，以及 normalization 等管线阶段。它有助于解释错误，但不等同于每个实际词典命中的输入/输出偏移。

例如同一段里一个词变长、另一个词变短，总字数仍可能相等；仅按最终字符串下标套回格式，会发生内部错位。默认等长策略与强制模式的格式归属都需要可靠的映射依据，不能靠总长度或猜测性 diff 宣称安全。

应进一步验证原生匹配过程能否提供足够的偏移追踪；若现有发布包不暴露所需信息，考虑在固定版本的 C++ 核心外增加小型 WASM 绑定，而不是自行实现另一套 OpenCC 匹配算法。完整二进制词典等长检查也需要词条枚举；现有绑定未提供通用词典枚举接口。

来源：[ConversionInspection.hpp](https://github.com/BYVoid/OpenCC/blob/ver.1.4.2/src/ConversionInspection.hpp)、[SingleStageConverter.cpp](https://github.com/BYVoid/OpenCC/blob/ver.1.4.2/src/SingleStageConverter.cpp)、[Conversion.cpp](https://github.com/BYVoid/OpenCC/blob/ver.1.4.2/src/Conversion.cpp)。

## 4. Obsidian 编辑器探针

### 已通过

在同一测试笔记上分别切换实时预览和源码模式，通过 CLI `eval` 调用真实编辑器 API：

- 将 `软**件**` 用一个 `Editor.transaction` 的两个 changes 改成 `軟**體**`。
- 整篇笔记与预期精确比较，除两个目标字外完全一致。
- 调用一次 undo，恢复全部原文；redo 恢复全部修改；最后 undo 留下原文。

这是编辑器 API 的可行性证据，不是插件端到端测试，也未证明与相邻用户输入的撤销分组隔离。

### 观察结果与边界

编辑器的语法树能给出加粗、链接目标、反斜线转义、行内代码、代码块、引用和数学 token 的源码偏移。但它并不直接提供用户需求中的完整嵌套“区域树”或最终可见文字投影：引用需跨行归组，LaTeX 命令、括号和子区域需要进一步分析。

不能依赖渲染 DOM 的 textContent 直接反推源码，也不能根据几种 token 的名字就宣布完整 Markdown/LaTeX 兼容。实际实现应通过公开的编辑器扩展接口接入 CM6，并为 Obsidian 特有 token 的版本差异做保护；遇到无法可靠定位的内容明确拒绝写入。

探针使用内部 state 字段只用于观察，不应照搬为稳定的产品 API。

来源：[Obsidian Editor API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)、[编辑器扩展文档](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Editor/Editor%20extensions.md)。

## 5. 引擎探针状态

首轮在专用 Worker 导入 ESM 加载器时失败，错误为 `Failed to resolve module specifier 'module'`。CLI 退出码仍为 0，因此测试不能只依赖 CLI 进程退出状态，必须断言返回结果。

已定位：Obsidian 的 Electron Worker 暴露 `process.versions.node`，加载器因此进入 Node 分支并执行 `import('module')`；Blob ESM 不能解析这个裸模块名。探针仅在自己创建的 Worker 内去掉 Node 环境暴露，再使用浏览器分支和显式 WASM bytes 复验；不修改 Obsidian 主窗口全局对象。

第二次暴露 Blob URL 的相对 WASM 地址问题：即使提供 wasmBinary，生成的加载器仍调用 `new URL('opencc-wasm.wasm', import.meta.url)`。显式提供 locateFile 后解决；测试通过传入二进制加载，不实际请求这个地址。

短文本 8 项检查通过后，50,000 字长选区检查发现 `memory access out of bounds`。检查生成代码确认，`cwrap` 的 string 参数通过 `stringToUTF8OnStack` 分配在栈上。改为 `_malloc` / `stringToUTF8` / 数字指针调用 / `finally _free` 后，同样输入通过，不切分转换文本。一旦发生 WASM 越界应废弃该实例，不能继续复用损坏状态。

最终在关闭 Worker 的 fetch 和 XMLHttpRequest、且无 Node 环境的情况下，12 项断言/观察均得到预期结果：

| 检查 | 结果 |
| --- | --- |
| 打包配置 + `.ocd2` 词典 | `服务器软件 → 伺服器軟體` |
| normalization 与阶段检查 | 返回两段 pipeline 及分词结果 |
| 自订相对路径 text 词典、两阶段链 | `[软件]` 转换为 `【軟體】`，换行保留 |
| 自订变长词组检查 | 检查结果显示 `甲乙 → 丙` |
| inline + normalization | `Ａ → 甲 → 乙` |
| 嵌套 group 优先级 | 采用第一个匹配词典 |
| 缺失词典 | 明确抛出词典路径与查找失败原因 |
| 未知词典类型 | 明确拒绝 `invented` |
| 混合换行 | CRLF、LF、CR 均逐字保留 |
| 50,000 字输入 | 完整结果匹配，未切段；单次观察约 9 ms，不作为性能保证 |
| 总长度相同但内部偏移 | `甲丙丁 → 甲乙丙`，证实仅总长度检查不足 |
| 未知配置字段 | 原生引擎仍接受，证实宿主必须增加明确的配置检查 |

后两项是风险复现，不是这些风险已经被产品解决。原生 Config.cpp 对 schema 不符只发出 warning 然后继续，故不能把“引擎能加载”当作“所有配置都被支持”。

可复用探针、结果快照及运行步骤保存在 [probes/README.md](probes/README.md)。

## 6. 建议的架构方向（待确认）

优先采用固定版本的 OpenCC C++ 核心编译为浏览器/Worker WASM，增加最小的匹配偏移和词典枚举绑定；不在 JavaScript 重写 OpenCC 匹配语义。现有 `opencc-wasm` 是可行性参考，其发布接口还不足以独立满足精确源码映射和完整词典检查。自有绑定及构建尚未实现或验证。

另外两条路线的取舍：直接用已有 WASM 包可减少构建工作，但缺少必要的追踪/枚举接口；纯 JS 或桌面原生绑定分别不能覆盖真实配置语义或移动端目标。

插件层保持四个明确职责：Obsidian 入口与原子提交、可见文本/区域/源码映射、配置资源与快照缓存、Worker 内的 OpenCC 引擎。设置使用 Obsidian 原生组件，不引入额外前端框架。

## 7. 未验证事项

- 产品加载器的 URL 依赖解析、跨域、重定向、下载限制、缓存持久化与失败回退。
- 原生词典命中偏移、所有词典格式的枚举、等长检查及强制写回。
- Markdown/LaTeX 完整嵌套投影、部分选区、实体、嵌入及语法再验证。
- 菜单、命令、设置、热键、异步编辑竞争及长选区性能。
- Android/iOS 真机；CLI 移动模拟不代替真机验证。
