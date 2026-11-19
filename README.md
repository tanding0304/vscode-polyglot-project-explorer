# Polyglot Project Explorer

在 VS Code 活动栏添加独立的「工程」入口。原有资源管理器和工作区目录不变。

- 从当前工作区查找 `go.mod`、`.csproj`、`.sln` 和 `.slnx`，分别列出工程和解决方案。
- 展开节点浏览目录，点击文件打开源码。新增工程后，可点视图右上角刷新。
- 右键工程选择运行或调试，再选该工作区已有的启动配置。扩展不会生成配置，也不会推断配置对应哪个工程。请安装所用语言的调试扩展。

## 本地安装

从 GitHub Releases 下载 `.vsix`，在 VS Code 扩展视图菜单选择「从 VSIX 安装」，或运行 `code --install-extension polyglot-project-explorer-0.1.0.vsix`。安装后，用「打开文件夹」打开完整仓库，而不是仅包含部分目录的多根工作区。

开发时可使用 `code --extensionDevelopmentPath="$PWD" /path/to/workspace` 启动扩展开发窗口。运行 `npm test` 检查 JavaScript 语法。
