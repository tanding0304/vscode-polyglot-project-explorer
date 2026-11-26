const vscode = require('vscode');
const nodePath = require('node:path');
const path = nodePath.posix;
const { TextDecoder } = require('node:util');
const {
  icon,
  fileIconFor,
  parseSln,
  parseSlnx,
  buildSolutionTreeNodes,
  buildCsprojDependenciesNode
} = require('./csharp-solution');
const {
  goFileIconFor,
  readGoModInfo,
  formatGoModuleDescription,
  buildGoExternalLibrariesNode
} = require('./go-module');

const ignored = new Set(['.git', '.gocache', '.gomodcache', 'node_modules', 'vendor', 'bin', 'obj']);

function node(uri, directory, label, project = false) {
  const item = new vscode.TreeItem(label ?? path.basename(uri.path), directory
    ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  item.uri = uri;
  item.resourceUri = uri;
  item.iconPath = directory ? vscode.ThemeIcon.Folder : (goFileIconFor(uri.path) ?? fileIconFor(uri.path) ?? vscode.ThemeIcon.File);
  if (!directory) item.command = { command: 'vscode.open', title: '打开文件', arguments: [uri] };
  if (project) item.contextValue = 'polyglotProject';
  if (!directory && path.basename(uri.path) === 'main.go') item.contextValue = 'polyglotGoMain';
  else if (!directory && path.basename(uri.path) === 'go.mod') item.contextValue = 'polyglotGoModFile';
  else if (!directory && uri.path.endsWith('_test.go')) item.contextValue = 'polyglotGoTest';
  else if (!directory) item.contextValue = 'polyglotSource';
  return item;
}

function isProjectPath(entry) {
  return typeof entry === 'string' && !path.isAbsolute(entry) && !entry.split('/').includes('..') &&
    /(?:^|\/)go\.mod$|\.(?:slnx?|csproj)$/.test(entry);
}

function normalizeLaunchNames(value) {
  if (typeof value === 'string' && value.trim()) return [value];
  if (Array.isArray(value) && value.length && value.every(name => typeof name === 'string' && name.trim())) return value;
  return null;
}

async function children(item) {
  if (item?.projects) return item.projects;
  if (item) {
    const entries = await vscode.workspace.fs.readDirectory(item.uri);
    const fsChildren = entries.filter(([name, type]) => !ignored.has(name) && !(type & vscode.FileType.SymbolicLink))
      .map(([name, type]) => {
        const isDir = Boolean(type & vscode.FileType.Directory);
        const child = node(vscode.Uri.joinPath(item.uri, name), isDir);
        if (isDir && (item.csprojUri || item.isCsharpDir)) {
          child.isCsharpDir = true;
          child.iconPath = icon('folder.svg');
        } else if (isDir && (item.goModUri || item.isGoDir)) {
          child.isGoDir = true;
          child.iconPath = icon('go-folder.svg');
        }
        return child;
      })
      .sort((left, right) => right.collapsibleState - left.collapsibleState || left.label.localeCompare(right.label));
    if (item.csprojUri) {
      const depsNode = await buildCsprojDependenciesNode(item.csprojUri, item.id);
      if (depsNode) return [depsNode, ...fsChildren];
    }
    if (item.goModUri) {
      const extLibsNode = await buildGoExternalLibrariesNode(item.goModUri, item.id, item.goModInfo);
      if (extLibsNode) return [...fsChildren, extLibsNode];
    }
    return fsChildren;
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
      if (!bindings) throw new Error('launch 必须是工程相对路径到启动配置名称的映射');
      for (const [entry, value] of bindings) {
        const names = normalizeLaunchNames(value);
        if (!isProjectPath(entry) || !names) {
          throw new Error('launch 必须是工程相对路径到启动配置名称或名称数组的映射');
        }
        launchNames.set(vscode.Uri.joinPath(workspace.uri, entry).toString(), names);
      }
    } catch (error) {
      if (error.code !== 'FileNotFound') vscode.window.showErrorMessage(`${workspace.name}/polyglot-projects.json：${error.message}`);
    }
  }
  const projects = new Map();
  const solutions = [];
  const goModules = [];
  const roots = [];
  const toolGroups = new Map();
  for (const marker of markers) {
    const folder = marker.with({ path: path.dirname(marker.path) });
    const name = path.basename(marker.path);
    const suffix = path.extname(name);
    const label = name === 'go.mod'
      ? path.basename(folder.path)
      : /\.(?:slnx?|csproj|fsproj|vbproj)$/i.test(name)
        ? path.basename(name, suffix)
        : name;
    const item = node(folder, true, label, suffix !== '.sln' && suffix !== '.slnx');
    item.id = marker.toString();
    item.launchNames = launchNames.get(item.id);
    if (item.launchNames && !item.contextValue) item.contextValue = 'polyglotProject';
    item.tooltip = vscode.workspace.asRelativePath(marker, true);
    if (name === 'go.mod') {
      item.goModUri = marker;
      item.isGoDir = true;
      item.contextValue = 'polyglotGoModule';
      item.iconPath = icon('go-module.svg');
      goModules.push({ marker, item, label });
      const workspace = vscode.workspace.getWorkspaceFolder(marker);
      const tools = workspace && vscode.Uri.joinPath(workspace.uri, 'tools');
      if (tools && folder.path.startsWith(`${tools.path}/`)) {
        const key = tools.toString();
        if (!toolGroups.has(key)) {
          const group = node(tools, true, 'Go · Tools');
          group.id = key;
          group.iconPath = icon('go-folder.svg');
          group.projects = [];
          toolGroups.set(key, group);
        }
        toolGroups.get(key).projects.push(item);
        continue;
      }
    }
    if (suffix === '.csproj') {
      item.csprojUri = marker;
      item.contextValue = 'polyglotCsharpProject';
      item.iconPath = icon('csproj.svg');
      projects.set(item.id, item);
    } else {
      roots.push(item);
      if (suffix === '.sln' || suffix === '.slnx') {
        item.solutionUri = marker;
        item.contextValue = 'polyglotCsharpSolution';
        solutions.push({ marker, item, suffix });
      }
    }
  }
  const grouped = new Set();
  await Promise.all([
    ...solutions.map(async ({ marker, item, suffix }) => {
      const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(marker));
      const parsed = suffix === '.sln' ? parseSln(source) : parseSlnx(source);
      item.iconPath = icon('sln.svg');
      item.projects = buildSolutionTreeNodes(parsed, item.uri, item.id, {
        makeNode: node,
        launchNames,
        groupedProjects: grouped
      });
      if (!item.projects.length) delete item.projects;
    }),
    ...goModules.map(async ({ marker, item, label }) => {
      const info = await readGoModInfo(marker);
      if (!info) return;
      item.goModInfo = info;
      const desc = formatGoModuleDescription(info, label);
      if (desc) item.description = desc;
      const tipParts = [vscode.workspace.asRelativePath(marker, true)];
      if (info.modulePath) tipParts.push(`module ${info.modulePath}`);
      if (info.goVersion) tipParts.push(`go ${info.goVersion}`);
      item.tooltip = tipParts.join('\n');
    })
  ]);
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
  let targetConfigs = launchConfigs;
  if (item.launchNames) {
    const matched = item.launchNames.map(name => launchConfigs.find(config => config.name === name)).filter(Boolean);
    if (matched.length === 1) {
      await vscode.debug.startDebugging(folder, matched[0], { noDebug });
      return;
    }
    if (matched.length > 1) {
      targetConfigs = matched;
    } else {
      void vscode.window.showWarningMessage(`找不到启动配置「${item.launchNames.join(' / ')}」，请检查 polyglot-projects.json 中的绑定。`);
    }
  }
  const choices = targetConfigs.map(config => ({ label: config.name, description: config.type, config }));
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

let dotnetTerminal;
let goTerminal;

function runDotnet(item, args) {
  const target = item?.csprojUri || item?.solutionUri;
  if (!target) return;
  if (!dotnetTerminal || dotnetTerminal.exitStatus !== undefined) {
    dotnetTerminal = vscode.window.createTerminal('DotNet');
  }
  dotnetTerminal.show(true);
  dotnetTerminal.sendText(`dotnet ${args} "${target.fsPath}"`);
}

function runGo(item, args) {
  const cwd = item?.goModUri
    ? nodePath.dirname(item.goModUri.fsPath)
    : item?.uri
      ? nodePath.dirname(item.uri.fsPath)
      : null;
  if (!cwd) return;
  if (!goTerminal || goTerminal.exitStatus !== undefined) {
    goTerminal = vscode.window.createTerminal('Go');
  }
  goTerminal.show(true);
  goTerminal.sendText(`cd "${cwd}" && go ${args}`);
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
    vscode.commands.registerCommand('polyglotProjects.debug', item => launch(item, false)),
    vscode.commands.registerCommand('polyglotProjects.dotnetBuild', item => runDotnet(item, 'build')),
    vscode.commands.registerCommand('polyglotProjects.dotnetRebuild', item => runDotnet(item, 'build --no-incremental')),
    vscode.commands.registerCommand('polyglotProjects.dotnetClean', item => runDotnet(item, 'clean')),
    vscode.commands.registerCommand('polyglotProjects.dotnetRestore', item => runDotnet(item, 'restore')),
    vscode.commands.registerCommand('polyglotProjects.dotnetTest', item => runDotnet(item, 'test')),
    vscode.commands.registerCommand('polyglotProjects.dotnetPublish', item => runDotnet(item, 'publish')),
    vscode.commands.registerCommand('polyglotProjects.goBuild', item => runGo(item, 'build ./...')),
    vscode.commands.registerCommand('polyglotProjects.goTest', item => runGo(item, 'test ./...')),
    vscode.commands.registerCommand('polyglotProjects.goTestPkg', item => runGo(item, 'test -v .')),
    vscode.commands.registerCommand('polyglotProjects.goVet', item => runGo(item, 'vet ./...')),
    vscode.commands.registerCommand('polyglotProjects.goModTidy', item => runGo(item, 'mod tidy')),
    vscode.commands.registerCommand('polyglotProjects.goModDownload', item => runGo(item, 'mod download')),
    vscode.commands.registerCommand('polyglotProjects.goModVerify', item => runGo(item, 'mod verify')),
    vscode.commands.registerCommand('polyglotProjects.goModVendor', item => runGo(item, 'mod vendor')),
    vscode.commands.registerCommand('polyglotProjects.goModGraph', item => runGo(item, 'mod graph')));
}

module.exports = { activate };
