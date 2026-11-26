// Adapted from fernandoescolar/vscode-solution-explorer (MIT License)
// Copyright (c) Fernando Escolar

const vscode = require('vscode');
const nodePath = require('node:path');
const path = nodePath.posix;
const { TextDecoder } = require('node:util');

const ICONS_DIR = nodePath.join(__dirname, 'icons');

function icon(lightName, darkName) {
  const light = vscode.Uri.file(nodePath.join(ICONS_DIR, lightName));
  if (!darkName) return light;
  return { light, dark: vscode.Uri.file(nodePath.join(ICONS_DIR, darkName)) };
}

function projectIconFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.fsproj') return icon('fsproj.svg');
  if (ext === '.vbproj') return icon('vbproj.svg');
  return icon('csproj.svg');
}

function fileIconFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.cs': return icon('cs.svg');
    case '.fs': return icon('fs.svg');
    case '.vb': return icon('vb.svg');
    case '.cshtml': return icon('cshtml.svg');
    case '.csproj': return icon('csproj.svg');
    case '.fsproj': return icon('fsproj.svg');
    case '.vbproj': return icon('vbproj.svg');
    case '.sln':
    case '.slnx': return icon('sln.svg');
    default: return null;
  }
}

const SOLUTION_FOLDER_GUID = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}';
const decoder = new TextDecoder();

function normalizePath(value) {
  return value.replace(/\\/g, '/');
}

function parseSln(content) {
  const lines = content.split(/\r?\n/);
  const items = new Map();
  const nested = new Map();

  let current = null;
  let inSolutionItems = false;
  let inNestedProjects = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (current) {
      if (line === 'EndProject') {
        items.set(current.id, current);
        current = null;
        inSolutionItems = false;
        continue;
      }
      if (line.startsWith('ProjectSection(SolutionItems)')) {
        inSolutionItems = true;
        continue;
      }
      if (line === 'EndProjectSection') {
        inSolutionItems = false;
        continue;
      }
      if (inSolutionItems) {
        const eq = line.indexOf('=');
        if (eq > 0) {
          const itemPath = line.slice(0, eq).trim();
          if (itemPath) current.files.push(normalizePath(itemPath));
        }
      }
      continue;
    }

    const projectMatch = line.match(/^Project\("([^"]+)"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/i);
    if (projectMatch) {
      const [, typeGuid, name, rawPath, id] = projectMatch;
      current = {
        id: id.toUpperCase(),
        typeGuid: typeGuid.toUpperCase(),
        name,
        path: normalizePath(rawPath),
        isFolder: typeGuid.toUpperCase() === SOLUTION_FOLDER_GUID,
        files: [],
        children: []
      };
      continue;
    }

    if (line.startsWith('GlobalSection(NestedProjects)')) {
      inNestedProjects = true;
      continue;
    }
    if (inNestedProjects) {
      if (line === 'EndGlobalSection') {
        inNestedProjects = false;
        continue;
      }
      const nestedMatch = line.match(/^(\{[^}]+\})\s*=\s*(\{[^}]+\})/);
      if (nestedMatch) {
        nested.set(nestedMatch[1].toUpperCase(), nestedMatch[2].toUpperCase());
      }
    }
  }

  const roots = [];
  for (const item of items.values()) {
    const parentId = nested.get(item.id);
    if (parentId && items.has(parentId)) {
      items.get(parentId).children.push(item);
    } else {
      roots.push(item);
    }
  }
  return roots;
}

function parseSlnx(content) {
  const roots = [];
  const stack = [{ children: roots, files: [] }];
  const tokenRegex = /<\/Folder\s*>|<Folder\b([^>]*)>|<Project\b([^>]*)\/?>|<File\b([^>]*)\/?>/gi;

  const getAttr = (attrs, name) => {
    const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
    return match ? match[1] : null;
  };

  for (const match of content.matchAll(tokenRegex)) {
    const [full, folderAttrs, projectAttrs, fileAttrs] = match;
    const parent = stack[stack.length - 1];
    if (full.startsWith('</')) {
      if (stack.length > 1) stack.pop();
    } else if (folderAttrs !== undefined) {
      const name = getAttr(folderAttrs, 'Name') || 'Folder';
      const folder = { id: `slnx-folder:${stack.length}:${name}`, name, isFolder: true, files: [], children: [] };
      parent.children.push(folder);
      if (!full.endsWith('/>')) stack.push(folder);
    } else if (projectAttrs !== undefined) {
      const rawPath = getAttr(projectAttrs, 'Path');
      if (rawPath) {
        const norm = normalizePath(rawPath);
        parent.children.push({
          id: `slnx-proj:${norm}`,
          name: path.basename(norm),
          path: norm,
          isFolder: false,
          files: [],
          children: []
        });
      }
    } else if (fileAttrs !== undefined) {
      const rawPath = getAttr(fileAttrs, 'Path');
      if (rawPath) parent.files.push(normalizePath(rawPath));
    }
  }
  return roots;
}

function parseCsprojDependencies(content) {
  const packages = [];
  const projects = [];
  const assemblies = [];

  const getAttr = (attrs, name) => {
    const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
    return match ? match[1] : null;
  };

  for (const match of content.matchAll(/<PackageReference\b([^>]*)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi)) {
    const [, attrs, body = ''] = match;
    const name = getAttr(attrs, 'Include') || getAttr(attrs, 'Update');
    let version = getAttr(attrs, 'Version');
    if (!version && body) {
      const verMatch = body.match(/<Version>([^<]+)<\/Version>/i);
      if (verMatch) version = verMatch[1].trim();
    }
    if (name) packages.push({ name, version: version || '' });
  }

  for (const match of content.matchAll(/<ProjectReference\b([^>]*)\/?>/gi)) {
    const include = getAttr(match[1], 'Include');
    if (include) projects.push(normalizePath(include));
  }

  for (const match of content.matchAll(/<Reference\b([^>]*)(?:\/>|>[\s\S]*?<\/Reference>)/gi)) {
    const include = getAttr(match[1], 'Include');
    if (include) assemblies.push(include.split(',')[0].trim());
  }

  return { packages, projects, assemblies };
}

function createInfoItem(id, label, iconPath, description = '') {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.id = id;
  item.iconPath = iconPath;
  if (description) item.description = description;
  item.contextValue = 'polyglotDependency';
  return item;
}

function createGroupItem(id, label, iconPath, children) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = id;
  item.iconPath = iconPath;
  item.projects = children;
  item.contextValue = 'polyglotDependencyGroup';
  return item;
}

async function buildCsprojDependenciesNode(csprojUri, parentId) {
  try {
    const content = decoder.decode(await vscode.workspace.fs.readFile(csprojUri));
    const { packages, projects, assemblies } = parseCsprojDependencies(content);
    const groups = [];

    if (packages.length) {
      const pkgItems = packages
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(pkg => createInfoItem(`${parentId}#pkg:${pkg.name}`, pkg.name, icon('PackageReference.svg', 'PackageReference-dark.svg'), pkg.version));
      groups.push(createGroupItem(`${parentId}#packages`, 'Packages', icon('packages.svg'), pkgItems));
    }

    if (projects.length) {
      const projDir = csprojUri.with({ path: path.dirname(csprojUri.path) });
      const projItems = projects
        .sort((a, b) => a.localeCompare(b))
        .map(ref => {
          const targetUri = vscode.Uri.joinPath(projDir, ref);
          const item = new vscode.TreeItem(path.basename(ref, path.extname(ref)), vscode.TreeItemCollapsibleState.None);
          item.id = `${parentId}#projref:${ref}`;
          item.uri = targetUri;
          item.resourceUri = targetUri;
          item.iconPath = icon('referenced-project.svg');
          item.tooltip = vscode.workspace.asRelativePath(targetUri, true);
          item.command = { command: 'vscode.open', title: '打开文件', arguments: [targetUri] };
          item.contextValue = 'polyglotDependency';
          return item;
        });
      groups.push(createGroupItem(`${parentId}#projects`, 'Projects', icon('references.svg'), projItems));
    }

    if (assemblies.length) {
      const asmItems = assemblies
        .sort((a, b) => a.localeCompare(b))
        .map(asm => createInfoItem(`${parentId}#asm:${asm}`, asm, icon('Application.svg', 'Application-dark.svg')));
      groups.push(createGroupItem(`${parentId}#assemblies`, 'Assemblies', icon('Application.svg', 'Application-dark.svg'), asmItems));
    }

    if (!groups.length) return null;
    return createGroupItem(`${parentId}#dependencies`, 'Dependencies', icon('ReferenceGroup.svg', 'ReferenceGroup-dark.svg'), groups);
  } catch {
    return null;
  }
}

function buildSolutionTreeNodes(nodes, solutionDirUri, solutionId, { makeNode, launchNames, groupedProjects }) {
  const result = [];
  for (const entry of nodes) {
    if (entry.isFolder) {
      const folderItem = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
      folderItem.id = `${solutionId}#folder:${entry.id}`;
      folderItem.iconPath = icon('folder.svg');
      folderItem.contextValue = 'polyglotSolutionFolder';

      const subChildren = buildSolutionTreeNodes(entry.children, solutionDirUri, solutionId, {
        makeNode, launchNames, groupedProjects
      });
      const fileItems = entry.files.map(filePath => {
        const fileUri = vscode.Uri.joinPath(solutionDirUri, filePath);
        const item = makeNode(fileUri, false, path.basename(filePath), false);
        item.id = `${folderItem.id}#file:${filePath}`;
        item.tooltip = vscode.workspace.asRelativePath(fileUri, true);
        return item;
      });
      folderItem.projects = [...subChildren, ...fileItems];
      result.push(folderItem);
    } else if (/\.(?:csproj|fsproj|vbproj)$/i.test(entry.path)) {
      const projectUri = vscode.Uri.joinPath(solutionDirUri, entry.path);
      const key = projectUri.toString();
      groupedProjects.add(key);

      const projectDir = projectUri.with({ path: path.dirname(projectUri.path) });
      const projectName = path.basename(entry.path, path.extname(entry.path));
      const child = makeNode(projectDir, true, projectName, true);
      child.id = `${solutionId}#${key}`;
      child.csprojUri = projectUri;
      child.contextValue = 'polyglotCsharpProject';
      child.launchNames = launchNames.get(key);
      child.iconPath = projectIconFor(entry.path);
      child.tooltip = vscode.workspace.asRelativePath(projectUri, true);
      result.push(child);
    }
  }

  return result.sort((a, b) => {
    const aFolder = a.contextValue === 'polyglotSolutionFolder' ? 0 : 1;
    const bFolder = b.contextValue === 'polyglotSolutionFolder' ? 0 : 1;
    if (aFolder !== bFolder) return aFolder - bFolder;
    return String(a.label).localeCompare(String(b.label));
  });
}

module.exports = {
  icon,
  fileIconFor,
  parseSln,
  parseSlnx,
  buildSolutionTreeNodes,
  buildCsprojDependenciesNode
};
