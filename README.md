# Polyglot Project Explorer

在 VS Code 活动栏添加独立的「工程」入口。原有资源管理器和工作区目录不变。

- 在工作区根目录创建 `polyglot-projects.json`，例如 `{"projects":["server/go.mod","Battle/Server.sln"]}`。只显示清单中的工程，不递归扫描；解决方案节点自动展开其引用的 C# 工程。修改清单后点击刷新。
- 展开节点浏览目录，点击文件打开源码。新增工程后，可点视图右上角刷新。
- 右键工程选择「运行启动配置」或「调试启动配置」。可以为工程绑定启动配置，跳过选择框。请安装所用语言的调试扩展。

## 为工程绑定启动配置

在工作区根目录的 `polyglot-projects.json` 中添加可选的 `launch`：

```json
{
  "projects": ["server/go.mod", "Battle/Server.sln"],
  "launch": {
    "server/go.mod": "Go: Server",
    "Battle/Server.sln": ["C#: local_game", "C#: local_battle"],
    "Battle/Server/Server.csproj": ["C#: local_game", "C#: local_battle"]
  }
}
```

键是相对于工作区根目录的 `go.mod`、`.sln` / `.slnx` 或 `.csproj` 路径，值可以是单个启动配置 `name` 或名称数组（需与所属工作区 `.vscode/launch.json` 中一致）。保存后点击工程视图右上角的刷新按钮。

绑定单个配置时，右键运行或调试会直接启动；绑定多个配置时，只弹出这几个配置供选择；未绑定时仍列出全部启动配置，配置名称找不到时会先提示再回到选择流程。右键 `main.go` 仍使用原有的 Go 快速启动方式。

## 本地安装

从 GitHub Releases 下载 `.vsix`，在 VS Code 扩展视图菜单选择「从 VSIX 安装」，或运行 `code --install-extension polyglot-project-explorer-0.1.1.vsix`。安装后，用「打开文件夹」打开完整仓库，而不是仅包含部分目录的多根工作区。

开发时可使用 `code --extensionDevelopmentPath="$PWD" /path/to/workspace` 启动扩展开发窗口。运行 `npm test` 检查 JavaScript 语法。
