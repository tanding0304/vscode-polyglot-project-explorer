const vscode = require('vscode');
const path = require('node:path').posix;
const { TextDecoder } = require('node:util');

const ignored = new Set(['.git', '.gocache', '.gomodcache', 'node_modules', 'vendor', 'bin', 'obj']);

function node(uri, directory, label, project = false) {
  const item = new vscode.TreeItem(label ?? path.basename(uri.path), directory
    ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  item.uri = uri;
  item.resourceUri = uri;
  item.iconPath = directory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
  if (!directory) item.command = { command: 'vscode.open', title: '打开文件', arguments: [uri] };
  if (project) item.contextValue = 'polyglotProject';
  if (!directory && path.basename(uri.path) === 'main.go') item.contextValue = 'polyglotGoMain';
  else if (!directory && /\.(go|cs)$/.test(uri.path)) item.contextValue = 'polyglotSource';
  return item;
}

function isProjectPath(entry) {
  return typeof entry === 'string' && !path.isAbsolute(entry) && !entry.split('/').includes('..') &&
    /(?:^|\/)go\.mod$|\.(?:slnx?|csproj)$/.test(entry);
}

async function children(item) {
  if (item?.projects) return item.projects;
  if (item) {
    const entries = await vscode.workspace.fs.readDirectory(item.uri);
    return entries.filter(([name, type]) => !ignored.has(name) && !(type & vscode.FileType.SymbolicLink))
      .map(([name, type]) => node(vscode.Uri.joinPath(item.uri, name), Boolean(type & vscode.FileType.Directory)))
      .sort((left, right) => right.collapsibleState - left.collapsibleState || left.label.localeCompare(right.label));
  }
  const markers = [];
  const launchNames = new Map();
  for (const workspace of vscode.workspace.workspaceFolders ?? []) {
    const manifest = vscode.Uri.joinPath(workspace.uri, 'polyglot-projects.json');
    try {
      const { projects, launch = {} } = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(manifest)));
      if (!Array.isArray(projects) || !projects.every(isProjectPath)) {
        throw new Error('projects 必须是工作区内的工程文件相对路径数组');
      }
      for (const entry of new Set(projects.map(entry => path.normalize(entry)))) {
        markers.push(vscode.Uri.joinPath(workspace.uri, entry));
      }
      const bindings = launch && typeof launch === 'object' && !Array.isArray(launch) && Object.entries(launch);
      if (!bindings || !bindings.every(([entry, name]) => isProjectPath(entry) && typeof name === 'string' && name.trim())) {
        throw new Error('launch 必须是工程相对路径到启动配置名称的映射');
      }
      for (const [entry, name] of bindings) {
        launchNames.set(vscode.Uri.joinPath(workspace.uri, entry).toString(), name);
      }
    } catch (error) {
      if (error.code !== 'FileNotFound') vscode.window.showErrorMessage(`${workspace.name}/polyglot-projects.json：${error.message}`);
    }
  }
  const projects = new Map();
  const solutions = [];
  const roots = [];
  const toolGroups = new Map();
  for (const marker of markers) {
    const folder = marker.with({ path: path.dirname(marker.path) });
    const name = path.basename(marker.path);
    const suffix = path.extname(name);
    const label = name === 'go.mod' ? path.basename(folder.path) : name;
    const item = node(folder, true, label, suffix !== '.sln' && suffix !== '.slnx');
    item.id = marker.toString();
    item.launchName = launchNames.get(item.id);
    item.tooltip = vscode.workspace.asRelativePath(marker, true);
    if (name === 'go.mod') {
      const workspace = vscode.workspace.getWorkspaceFolder(marker);
      const tools = workspace && vscode.Uri.joinPath(workspace.uri, 'tools');
      if (tools && folder.path.startsWith(`${tools.path}/`)) {
        const key = tools.toString();
        if (!toolGroups.has(key)) {
          const group = node(tools, true, 'Go · Tools');
          group.id = key;
          group.projects = [];
          toolGroups.set(key, group);
        }
        toolGroups.get(key).projects.push(item);
        continue;
      }
    }
    if (suffix === '.csproj') {
      item.iconPath = new vscode.ThemeIcon('file-code');
      projects.set(item.id, item);
    } else {
      roots.push(item);
      if (suffix === '.sln' || suffix === '.slnx') solutions.push({ marker, item, suffix });
    }
  }
  const grouped = new Set();
  await Promise.all(solutions.map(async ({ marker, item, suffix }) => {
    const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(marker));
    const references = suffix === '.sln'
      ? source.matchAll(/^Project\("[^"]+"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/gim)
      : source.matchAll(/<Project\b[^>]*\bPath\s*=\s*["']([^"']+\.csproj)["']/gi);
    item.iconPath = new vscode.ThemeIcon('project');
    item.projects = [];
    for (const [, reference] of references) {
      const projectUri = vscode.Uri.joinPath(item.uri, reference.replace(/\\/g, '/'));
      const key = projectUri.toString();
      const project = projects.get(key) ?? node(projectUri.with({ path: path.dirname(projectUri.path) }), true, path.basename(projectUri.path), true);
      if (item.projects.some(child => child.id === `${item.id}#${key}`)) continue;
      grouped.add(key);
      const child = node(project.uri, true, project.label, true);
      child.id = `${item.id}#${key}`;
      child.launchName = launchNames.get(key);
      child.iconPath = new vscode.ThemeIcon('file-code');
      child.tooltip = vscode.workspace.asRelativePath(projectUri, true);
      item.projects.push(child);
    }
    if (!item.projects.length) delete item.projects;
  }));
  roots.push(...[...projects.values()].filter(project => !grouped.has(project.id)));
  const compare = (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
  const groups = [...toolGroups.values()];
  for (const group of groups) group.projects.sort(compare);
  return [...roots.sort(compare), ...groups.sort(compare)];
}

async function launch(item, noDebug) {
  if (!item) return;
  const folder = vscode.workspace.getWorkspaceFolder(item.uri);
  if (item.contextValue === 'polyglotGoMain') {
    if (!vscode.extensions.getExtension('golang.go')) {
      await vscode.window.showInformationMessage('请先安装 VS Code 官方 Go 扩展。');
      return;
    }
    const program = item.uri.with({ path: path.dirname(item.uri.path) }).fsPath;
    await vscode.debug.startDebugging(folder, {
      name: `Go: ${path.basename(program)}`, type: 'go', request: 'launch', mode: 'debug', program, cwd: program
    }, { noDebug });
    return;
  }
  const configs = vscode.workspace.getConfiguration('launch', item.uri).get('configurations', []);
  const launchConfigs = configs.filter(config => config.request === 'launch' && config.name);
  if (item.launchName) {
    const config = launchConfigs.find(config => config.name === item.launchName);
    if (config) {
      await vscode.debug.startDebugging(folder, config, { noDebug });
      return;
    }
    void vscode.window.showWarningMessage(`找不到启动配置「${item.launchName}」，请检查 polyglot-projects.json 中的绑定。`);
  }
  const choices = launchConfigs.map(config => ({ label: config.name, description: config.type, config }));
  if (!choices.length) {
    await vscode.window.showInformationMessage('当前工作区没有启动配置，请先在「运行和调试」中添加。');
    return;
  }
  const choice = await vscode.window.showQuickPick(choices, { placeHolder: '选择要启动的配置' });
  if (choice) await vscode.debug.startDebugging(folder, choice.config, { noDebug });
}

async function runCode(item) {
  if (!item) return;
  const runner = vscode.extensions.getExtension('formulahendry.code-runner');
  if (!runner) {
    await vscode.window.showInformationMessage('请先安装 Code Runner 扩展。');
    return;
  }
  await runner.activate();
  await vscode.commands.executeCommand('code-runner.run', item.uri);
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
    vscode.commands.registerCommand('polyglotProjects.runCode', runCode),
    vscode.commands.registerCommand('polyglotProjects.run', item => launch(item, true)),
    vscode.commands.registerCommand('polyglotProjects.debug', item => launch(item, false)));
}

module.exports = { activate };
