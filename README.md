# OpenCC Selection Converter

在 Obsidian 中用真实 OpenCC 自定义配置安全转换当前可见选区，同时保护 Markdown 结构与选区外源码。

插件支持桌面端和移动端代码路径，提供库内文件或 URL 方案、离线缓存、严格等长检查、原子撤销、命令面板、独立方案命令和右键入口。当前发布前验证基于 Obsidian 桌面应用及其移动模拟；尚未在 Android 或 iOS 真机验证。

## 安装

当前没有公开商店版本。先构建，然后把正式发布文件复制到 vault 的插件目录：

```text
npm ci
npm run build:engine
npm run build

复制 dist/main.js、dist/manifest.json、dist/versions.json 到：
<Vault>/.obsidian/plugins/opencc-selection-converter/
```

重新加载 Obsidian，在「第三方插件」中启用 **OpenCC Selection Converter**。构建原生引擎需要 `engine/upstream.lock.json` 中固定的 OpenCC 与 emsdk 源码版本；普通安装不需要编译器或网络运行时。

## 使用

```text
1. 设置 → OpenCC Selection Converter → 添加方案。
2. 输入方案名称，并选择库内 JSON 配置或配置 URL。
3. 预览配置引用的词典；核对并明确批准 HTTP 资源后加载。
4. 在源码模式或实时预览中选中文字。
5. 运行「转换选区（默认方案）」、选择方案命令，或使用右键菜单。
6. 需要时使用一次撤销恢复整次转换。
```

每个活动方案都有稳定的独立命令，可在 Obsidian「快捷键」设置中分别绑定。无选区时不会转换全文。

## 方案与缓存

- 支持真实 OpenCC JSON/JSONC 配置、inline、text、ocd 和 ocd2 词典，以及项目已验证的转换阶段。
- URL 相对依赖默认相对于配置 URL；库内相对依赖默认相对于配置文件。高级设置可指定依赖基址或逐项覆盖。
- HTTP 使用精确 URL 授权，不按整个域名授权。选中的笔记文字只在本地 WASM 引擎中处理，不上传、不记录、不写入缓存。
- 成功方案保存完整不可变快照；离线可复用。刷新失败时保留上一份可用快照并显示状态。

## 安全映射与等长

默认严格模式会检查本次原生 OpenCC 的每个实际匹配以及最终 Unicode 码点数量。任一长度变化都会取消整次写入。

「强制模式」允许长度变化，但不会绕过选区边界、Markdown 结构、链接目标、区域策略或候选源码重解析。跨格式词组无法唯一分配时，输出继承词组起始处格式。

手动「等长检查」会显示：

- 检查完整：等长
- 存在长度风险
- 检查不完整

它是方案审计，不替代每次转换时的实际匹配检查。

## 区域策略

行内代码、代码块、引用、行内数学、块数学和数学子组分别支持：始终转换、仅完整选区位于区域内时转换、永不转换。父区域不允许时，子区域也不会转换。

数学仅支持已验证的固定子集，包括常用希腊/符号命令、文本与字体命令、分式、根式、上下标和转义。未知宏、环境或歧义结构会明确拒绝，不猜测源码映射。

## 已知限制

- 仅支持 Markdown 源码模式和实时预览，不支持阅读模式选区。
- 多选区会拒绝；没有选区不会退化为全文转换。
- 复杂的无别名 wikilink 路径、标题或块引用会保守拒绝。
- 代码区域允许转换时只保护外围结构，不保证编程语言语义。
- Obsidian 打开并保存 CRLF 文件时会规范化为 LF；插件保证编辑器文档内换行不被转换逻辑改写，不承诺磁盘字节级保真。
- 桌面移动模拟不等同于 Android/iOS 真机验收；用户真实方案也需自行验证。

## 开发与验证

测试会操作专用 vault，并清空其中本插件的测试缓存。不要指向真实 vault。详见 [`docs/testing.md`](docs/testing.md) 与 [`docs/verification.md`](docs/verification.md)。

## 致谢

转换核心来自 [OpenCC](https://github.com/BYVoid/OpenCC)。完整第三方来源、固定版本和许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 与 `engine/licenses/`。

## 贡献

本仓库目前没有配置公开远程地址、问题追踪器或正式贡献流程。不要假定维护者接受 pull request。提交修改前应先与仓库所有者确认；代码改动至少运行 `npm run check` 和对应的最小专用 vault 测试。

## 许可证

**UNLICENSED**：本项目源码尚未获得公开使用、复制或分发许可。第三方组件仍分别适用 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 所列许可证；该状态不改变任何第三方权利。
