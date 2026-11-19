const vscode = require('vscode');
const path = require('node:path').posix;

const ignored = new Set(['.git', '.gocache', '.gomodcache', 'node_modules', 'vendor', 'bin', 'obj']);
const exclude = `**/{${[...ignored].join(',')}}/**`;

function node(uri, directory, label, project = false) {
  const item = new vscode.TreeItem(label ?? path.basename(uri.path), directory
    ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  item.uri = uri;
  item.resourceUri = uri;
  item.iconPath = directory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
  if (!directory) item.command = { command: 'vscode.open', title: '打开文件', arguments: [uri] };
  if (project) item.contextValue = 'polyglotProject';
  return item;
}

async function children(item) {
  if (item) {
    const entries = await vscode.workspace.fs.readDirectory(item.uri);
    return entries.filter(([name, type]) => !ignored.has(name) && !(type & vscode.FileType.SymbolicLink))
      .map(([name, type]) => node(vscode.Uri.joinPath(item.uri, name), Boolean(type & vscode.FileType.Directory)))
      .sort((left, right) => right.collapsibleState - left.collapsibleState || left.label.localeCompare(right.label));
  }
  const markers = await vscode.workspace.findFiles('**/{go.mod,*.sln,*.slnx,*.csproj}', exclude);
  return markers.map(marker => {
    const folder = marker.with({ path: path.dirname(marker.path) });
    const name = path.basename(marker.path);
    const label = name === 'go.mod' ? `Go · ${path.basename(folder.path)}` : `C# · ${name}`;
    const item = node(folder, true, label, true);
    item.id = marker.toString();
    item.description = vscode.workspace.asRelativePath(folder, true);
    return item;
  }).sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

async function launch(item, noDebug) {
  if (!item) return;
  const folder = vscode.workspace.getWorkspaceFolder(item.uri);
  const configs = vscode.workspace.getConfiguration('launch', item.uri).get('configurations', []);
  const choices = configs.filter(config => config.request === 'launch' && config.name)
    .map(config => ({ label: config.name, description: config.type, config }));
  if (!choices.length) {
    await vscode.window.showInformationMessage('当前工作区没有启动配置，请先在「运行和调试」中添加。');
    return;
  }
  const choice = await vscode.window.showQuickPick(choices, { placeHolder: '选择要启动的配置' });
  if (choice) await vscode.debug.startDebugging(folder, choice.config, { noDebug });
}

function activate(context) {
  const changes = new vscode.EventEmitter();
  const refresh = () => changes.fire(undefined);
  context.subscriptions.push(changes,
    vscode.window.registerTreeDataProvider('polyglotProjects.tree', {
      onDidChangeTreeData: changes.event, getTreeItem: item => item, getChildren: children
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.commands.registerCommand('polyglotProjects.refresh', refresh),
    vscode.commands.registerCommand('polyglotProjects.run', item => launch(item, true)),
    vscode.commands.registerCommand('polyglotProjects.debug', item => launch(item, false)));
}

module.exports = { activate };
