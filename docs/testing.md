# 测试与发布验证

## 安全边界

CLI 集成测试只允许使用名为 `OpenCC-Selection-Converter-Test` 的专用 vault：

```text
~/Desktop/PlayGround/OpenCC-Selection-Converter-Test
```

驱动会验证真实路径和 `.opencc-cli-owned` 标记，禁用测试插件后清空该专用插件缓存，再部署构建。每次顶层运行会替换 Obsidian 渲染上下文；同一轮中的插件重载保留缓存，以验证离线恢复。不要把脚本改为指向真实 vault。

测试内容、URL 服务和笔记都是合成夹具。报告只保存运行 ID、套件名、计数与错误，不保存真实选区文字。

## 常用命令

```text
npm run check
npm run test:cli -- smoke
npm run test:cli -- mapping
npm run test:cli -- editor
npm run test:cli -- settings
npm run test:cli -- production
npm test
```

`npm test` 把完整矩阵拆成多个宿主专项，各自生成新的 UUID 报告；之后关闭夹具服务器并真实重载插件，验证缓存离线恢复。不要因为修改文档或单一模块而重复运行完整矩阵。

## 构建

```text
npm ci
npm run test:build
npm run build
```

`test:build` 将 Git 跟踪及未忽略的新文件复制到临时目录，重新运行 `npm ci` 和 `npm run build`，不复制本地依赖、`build/` 或 SDK；它验证普通构建不依赖本地原生产物，也不生成动态代码导入。

`build` 静态打包随仓库保存的 `engine/generated/opencc.mjs` 和 `opencc.wasm`，生成：

```text
dist/main.js
dist/manifest.json
dist/versions.json
dist/styles.css
```

修改原生源码后，使用 `engine/upstream.lock.json` 固定的本地 OpenCC 与 emsdk checkout 执行 `npm run build:engine`，更新并一同提交 `engine/generated/` 中的两个生成资产，然后执行 `npm run build`。安装了固定版 SDK 的开发环境还应运行 `node scripts/verify-artifact.mjs`。

`verify-artifact.mjs` 检查正式包不含测试入口、测试词典或 Node 运行时依赖，包含项目 MIT 及完整第三方许可，包含所需原生 ABI，并保持 WASM 32 MiB 初始 / 256 MiB 最大内存。

## 正式包验收

```text
npm run test:cli -- production
```

该套件构建并部署正式包，不使用 `runCliSuite`。它通过真实设置界面添加合成库内方案，设置默认项，在合成笔记中执行正式命令，并验证一次撤销恢复原文。

## 移动验证

桌面模拟命令：

```text
obsidian dev:mobile vault=OpenCC-Selection-Converter-Test on
# 完成设置、命令和布局检查后必须恢复：
obsidian dev:mobile vault=OpenCC-Selection-Converter-Test off
```

模拟重点：设置页可滚动且无横向溢出；弹窗按钮可触达；源码/实时预览转换、提示和撤销可用；插件不依赖 Node 或桌面文件系统。

桌面移动模拟不能证明 Android/iOS 的 Worker、WASM 内存、WebView、文件适配器或生命周期行为。没有真机证据时必须写“未验证”，不能写“移动端通过”。本次使用 Obsidian 1.13.7 执行 `dev:mobile on` 后，CLI 模拟环境未发现已部署的社区插件；显式启用与重载同样返回“plugin not found”。两次尝试均由 trap 恢复 `dev:mobile off`，因此没有移动模拟通过证据。

## 发布前最小清单

1. 固定版本与第三方许可一致。
2. `npm run check` 通过。
3. 相关专项通过；仅在最终交付点运行一次完整矩阵。
4. 正式包验收通过。
5. 移动模拟最终处于关闭状态。
6. `dist/` 仅包含正常 Obsidian 安装资产。
7. 不提交专用 vault 报告、缓存、构建中间物或真实用户数据。
