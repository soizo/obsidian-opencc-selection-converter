# Obsidian CLI 可行性探针

这些脚本是设计阶段的验证工具，不是插件实现或完整验收测试。只在专用 `OpenCC-Selection-Converter-Test` vault 运行；脚本会检查 vault 名称。Node/Electron 仅用于桌面 CLI 测试引导，不能据此声称插件支持移动端。

## 引擎探针

从 npm 获取已核对来源的固定版本到临时目录，不在产品项目安装依赖：

```sh
mkdir -p "$HOME/Desktop/PlayGround/opencc-selection-research"
(cd "$HOME/Desktop/PlayGround/opencc-selection-research" && npm pack opencc-wasm@0.13.1 --ignore-scripts --silent && tar -xzf opencc-wasm-0.13.1.tgz)
```

在本仓库根目录执行：

```sh
obsidian vault=OpenCC-Selection-Converter-Test eval "code=globalThis.openccProbeRoot='$HOME/Desktop/PlayGround/opencc-selection-research'; eval(require('fs').readFileSync('$PWD/docs/probes/engine-probe.js','utf8'))"
```

必须检查返回值 `pass: true`、12 项结果及是否出现 fatal，不能只看 CLI 退出码。结果也写入临时目录的 `engine-probe-result.json`。仓库中的 `engine-result.json` 是本次结果快照，不会自动更新。

Worker 内禁用 fetch 和 XMLHttpRequest，显式传入 WASM 二进制和所需词典；使用堆内存传递长字符串。后两项观察用于证明总字数等长和原生配置加载各自存在不足，不是相应产品问题已经解决。

## 编辑器探针

需要打开名为 `Syntax-Probe.md` 的测试笔记，其正文包含 `软**件**`，且没有未保存的用户编辑。首次在新 vault 可通过 CLI 创建：

```sh
obsidian vault=OpenCC-Selection-Converter-Test create path=Syntax-Probe.md content="前缀 软**件** 后缀" open
```

文件已存在则只打开，不覆盖：

```sh
obsidian vault=OpenCC-Selection-Converter-Test open path=Syntax-Probe.md
obsidian vault=OpenCC-Selection-Converter-Test eval "code=eval(require('fs').readFileSync('$PWD/docs/probes/editor-probe.js','utf8'))"
```

分别验证实时预览和源码模式，一次 transaction 修改两个文字位置、其余源码不变，undo/redo 能整次恢复。成功路径最后撤销修改并回到实时预览；若断言失败可能留下测试修改，因此仅使用专用测试笔记。探针未测试与相邻手工输入的撤销分组隔离。

`editor-result.json` 是本次结果快照。
