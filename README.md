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
    "Battle/Server/Server.csproj": "C#: Server"
  }
}
```

键是相对于工作区根目录的 `go.mod` 或 `.csproj` 路径（包括解决方案展开后显示的 C# 工程），值必须和所属工作区 `.vscode/launch.json` 中启动配置的 `name` 一致。保存后点击工程视图右上角的刷新按钮。

绑定有效时，右键运行或调试会直接启动；未绑定时仍可手动选择，配置名称找不到时会先提示再回到选择流程。右键 `main.go` 仍使用原有的 Go 快速启动方式。

## 本地安装

从 GitHub Releases 下载 `.vsix`，在 VS Code 扩展视图菜单选择「从 VSIX 安装」，或运行 `code --install-extension polyglot-project-explorer-0.1.1.vsix`。安装后，用「打开文件夹」打开完整仓库，而不是仅包含部分目录的多根工作区。

开发时可使用 `code --extensionDevelopmentPath="$PWD" /path/to/workspace` 启动扩展开发窗口。运行 `npm test` 检查 JavaScript 语法。
