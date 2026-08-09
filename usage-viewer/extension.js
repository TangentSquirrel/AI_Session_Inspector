const { commands, workspace, window, StatusBarAlignment } = require('vscode');
const fs = require('fs');
const path = require('path');
let statusBarItem;

//function getUsageLogPath() {
//  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
//  return root ? path.join(root, 'usage.jsonl') : 'usage.jsonl';
//}

function getUsageLogPath(context) {
//  const globalStoragePath = context.globalStorageUri.fsPath;
  const os = require('os');
  const sharedPath = path.join(os.homedir(), '.ai-session-inspector');

  // Ensure directory exists
  if (!fs.existsSync(sharedPath)) {
    fs.mkdirSync(sharedPath, { recursive: true });
  }
  
  return path.join(sharedPath, 'usage.jsonl');
}

function formatEntry(record) {
  const model = record.model ?? 'unknown';
  const ctx = record.context_length ?? '?';
  const sent = record.prompt_tokens ?? '?';
  const total = record.total_tokens ?? '?';
  const cost = record.reported_cost ?? record.computed_cost ?? null;
  const fmtPrice = (v) => v != null ? `$${Number(v).toFixed(8)}` : 'n/a';
  const priceStr = `${fmtPrice(record.price_per_prompt_token)} in / ${fmtPrice(record.price_per_completion_token)} out per tok`;
  const centsStr = cost != null ? `${(cost * 100).toFixed(6)}¢` : 'n/a';
  return `${model} | ctx: ${ctx} | sent: ${sent} | total: ${total} | ${priceStr} | ${centsStr}`;
}

function refreshStatusBar(context) {
  const usagePath = getUsageLogPath(context);
  fs.readFile(usagePath, 'utf8', (err, text) => {
    if (!statusBarItem) return;
    if (err) {
      statusBarItem.text = err.code === 'ENOENT'
        ? '$(circle-slash) Usage: no data yet'
        : '$(error) Usage: error';
      return;
    }
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    if (lines.length === 0) {
      statusBarItem.text = '$(circle-slash) Usage: empty';
      return;
    }
    try {
      const record = JSON.parse(lines[lines.length - 1]);
      statusBarItem.text = `$(graph) ${formatEntry(record)}`;
    } catch (e) {
      statusBarItem.text = '$(error) Usage: parse error';
    }
  });
}

function activate(context) {
  statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100);
  statusBarItem.command = 'logviewer.quickView';
  statusBarItem.text = '$(sync) Usage: loading...';
  statusBarItem.tooltip = 'Model usage (auto-refreshes as usage.jsonl updates)';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(
    commands.registerCommand('logviewer.quickView', () => refreshStatusBar(context))
  );
  const usagePath = getUsageLogPath(context);
  fs.watchFile(usagePath, { interval: 1000 }, () => refreshStatusBar(context));
  context.subscriptions.push({ dispose: () => fs.unwatchFile(usagePath) });
  refreshStatusBar(context);
}

function deactivate() {}

module.exports = { activate, deactivate };

