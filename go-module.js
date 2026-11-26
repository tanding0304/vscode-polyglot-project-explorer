const vscode = require('vscode');
const path = require('node:path').posix;
const { TextDecoder } = require('node:util');
const { icon } = require('./csharp-solution');

const decoder = new TextDecoder();

function goFileIconFor(filePath) {
  const name = path.basename(filePath).toLowerCase();
  if (name === 'go.mod' || name === 'go.work') return icon('go-mod.svg');
  if (name === 'go.sum' || name === 'go.work.sum') return icon('go-sum.svg');
  if (name === 'main.go') return icon('go-main.svg');
  if (name.endsWith('_test.go')) return icon('go-test.svg');
  if (name.endsWith('.go')) return icon('go.svg');
  return null;
}

function unquote(token) {
  if (!token) return '';
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith('`') && token.endsWith('`'))) {
    return token.slice(1, -1);
  }
  return token;
}

function tokenize(line) {
  const tokens = [];
  const regex = /"[^"]*"|`[^`]*`|\S+/g;
  for (const match of line.matchAll(regex)) {
    tokens.push(unquote(match[0]));
  }
  return tokens;
}

function parseGoMod(content) {
  const result = {
    modulePath: '',
    goVersion: '',
    toolchain: '',
    direct: [],
    indirect: [],
    replaces: []
  };

  let block = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const commentIdx = rawLine.indexOf('//');
    const comment = commentIdx >= 0 ? rawLine.slice(commentIdx + 2).trim() : '';
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();
    if (!line) continue;

    if (block) {
      if (line === ')') {
        block = null;
        continue;
      }
      if (block === 'require') {
        const tokens = tokenize(line);
        if (tokens.length >= 2) {
          const entry = { path: tokens[0], version: tokens[1], indirect: /\bindirect\b/i.test(comment) };
          if (entry.indirect) result.indirect.push(entry);
          else result.direct.push(entry);
        }
      } else if (block === 'replace') {
        const parsed = parseReplaceTokens(tokenize(line));
        if (parsed) result.replaces.push(parsed);
      }
      continue;
    }

    const blockMatch = line.match(/^(require|replace|exclude|retract)\s*\($/);
    if (blockMatch) {
      block = blockMatch[1];
      continue;
    }

    const tokens = tokenize(line);
    if (!tokens.length) continue;

    if (tokens[0] === 'module' && tokens[1]) {
      result.modulePath = tokens[1];
    } else if (tokens[0] === 'go' && tokens[1]) {
      result.goVersion = tokens[1];
    } else if (tokens[0] === 'toolchain' && tokens[1]) {
      result.toolchain = tokens[1];
    } else if (tokens[0] === 'require' && tokens.length >= 3) {
      const entry = { path: tokens[1], version: tokens[2], indirect: /\bindirect\b/i.test(comment) };
      if (entry.indirect) result.indirect.push(entry);
      else result.direct.push(entry);
    } else if (tokens[0] === 'replace') {
      const parsed = parseReplaceTokens(tokens.slice(1));
      if (parsed) result.replaces.push(parsed);
    }
  }

  return result;
}

function parseReplaceTokens(tokens) {
  const arrowIdx = tokens.indexOf('=>');
  if (arrowIdx < 1 || arrowIdx >= tokens.length - 1) return null;
  const left = tokens.slice(0, arrowIdx);
  const right = tokens.slice(arrowIdx + 1);
  return {
    from: left[0],
    fromVersion: left[1] || '',
    to: right[0],
    toVersion: right[1] || ''
  };
}

async function readGoModInfo(goModUri) {
  try {
    const content = decoder.decode(await vscode.workspace.fs.readFile(goModUri));
    return parseGoMod(content);
  } catch {
    return null;
  }
}

function formatGoModuleDescription(info, folderName) {
  if (!info) return '';
  const parts = [];
  if (info.modulePath && info.modulePath !== folderName) parts.push(info.modulePath);
  if (info.goVersion) parts.push(`go ${info.goVersion}`);
  return parts.join(' · ');
}

function isLocalPath(target) {
  return target.startsWith('./') || target.startsWith('../') || target === '.' || target === '..';
}

function createGoGroupItem(id, label, iconPath, children, description = '') {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = id;
  item.iconPath = iconPath;
  if (description) item.description = description;
  item.projects = children;
  item.contextValue = 'polyglotDependencyGroup';
  return item;
}

function createGoDepItem(id, label, iconPath, description = '', targetUri = null) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.id = id;
  item.iconPath = iconPath;
  if (description) item.description = description;
  if (targetUri) {
    item.uri = targetUri;
    item.resourceUri = targetUri;
    item.tooltip = vscode.workspace.asRelativePath(targetUri, true);
    item.command = { command: 'vscode.open', title: '打开文件', arguments: [targetUri] };
  }
  item.contextValue = 'polyglotDependency';
  return item;
}

async function buildGoExternalLibrariesNode(goModUri, parentId, cachedInfo) {
  const info = cachedInfo ?? await readGoModInfo(goModUri);
  if (!info) return null;

  const modDir = goModUri.with({ path: path.dirname(goModUri.path) });
  const replaceMap = new Map(info.replaces.map(rep => [rep.from, rep]));
  const sections = [];

  if (info.goVersion) {
    sections.push(createGoDepItem(
      `${parentId}#go-sdk`,
      `Go SDK ${info.goVersion}`,
      icon('go-sdk.svg'),
      info.toolchain || ''
    ));
  }

  const makeDepItem = (dep, prefix) => {
    const rep = replaceMap.get(dep.path);
    const desc = rep
      ? `${dep.version} → ${rep.to}${rep.toVersion ? ` ${rep.toVersion}` : ''}`
      : dep.version;
    const localUri = rep && isLocalPath(rep.to)
      ? vscode.Uri.joinPath(modDir, rep.to, 'go.mod')
      : null;
    return createGoDepItem(
      `${parentId}#${prefix}:${dep.path}@${dep.version}`,
      dep.path,
      icon('go-package.svg'),
      desc,
      localUri
    );
  };

  const directItems = [...info.direct]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(dep => makeDepItem(dep, 'direct'));

  const indirectItems = [...info.indirect]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(dep => makeDepItem(dep, 'indirect'));

  if (directItems.length || indirectItems.length) {
    const modChildren = [...directItems];
    if (indirectItems.length) {
      modChildren.push(createGoGroupItem(
        `${parentId}#go-indirect`,
        'Indirect',
        icon('go-folder.svg'),
        indirectItems,
        `${indirectItems.length}`
      ));
    }
    const countDesc = indirectItems.length
      ? `${directItems.length} direct, ${indirectItems.length} indirect`
      : `${directItems.length}`;
    sections.push(createGoGroupItem(
      `${parentId}#go-modules`,
      'Go Modules',
      icon('go-package.svg'),
      modChildren,
      countDesc
    ));
  }

  if (info.replaces.length) {
    const replaceItems = [...info.replaces]
      .sort((a, b) => a.from.localeCompare(b.from))
      .map(rep => {
        const target = `${rep.to}${rep.toVersion ? ` ${rep.toVersion}` : ''}`;
        const localUri = isLocalPath(rep.to)
          ? vscode.Uri.joinPath(modDir, rep.to, 'go.mod')
          : null;
        return createGoDepItem(
          `${parentId}#replace:${rep.from}`,
          rep.from,
          icon('go-mod.svg'),
          `→ ${target}`,
          localUri
        );
      });
    sections.push(createGoGroupItem(
      `${parentId}#go-replaces`,
      'Replaces',
      icon('go-mod.svg'),
      replaceItems,
      `${replaceItems.length}`
    ));
  }

  if (!sections.length) return null;
  return createGoGroupItem(
    `${parentId}#external-libraries`,
    'External Libraries',
    icon('go-library.svg'),
    sections
  );
}

module.exports = {
  goFileIconFor,
  parseGoMod,
  readGoModInfo,
  formatGoModuleDescription,
  buildGoExternalLibrariesNode
};
