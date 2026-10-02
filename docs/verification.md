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

## 尚未验收

阶段 2–11 均未完成：没有自订方案执行、匹配追踪、缓存、源码投影、写回或设置管理的完成证据。尚未进行 Android/iOS 真机验证。可行性探针不替代正式插件验收。
