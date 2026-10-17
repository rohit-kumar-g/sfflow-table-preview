'use strict';
// "Compare with Org Version": picks an org and a version of this flow, loads it
// (read-only, via the Salesforce CLI) and returns what the preview needs to show
// the changes. Also opens VS Code's side-by-side diff of the real XML.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const sf = require('./sfCli');
const { buildFlowModel } = require('./flowModel');
const { normalizeToolingMetadata, diffModels } = require('./flowDiff');
const { parseFlowXml } = require('./flowXml');

const LAST_ORG_KEY = 'sfflowPreview.lastOrg';

let output;
function channel() {
    if (!output) output = vscode.window.createOutputChannel('SF Flow');
    return output;
}

// Every org call is listed in the "SF Flow" output panel (never tokens or raw output).
function onLog(entry) {
    const result = entry.result && entry.result.error ? `ERROR ${entry.result.error}` : JSON.stringify(entry.result);
    channel().appendLine(`${new Date().toISOString()}  ${entry.org}  read  ${entry.action}  ${JSON.stringify(entry.details)}  -> ${result} (${entry.ms} ms)`);
}

function cliOptions(cwd, signal) {
    return { sfPath: vscode.workspace.getConfiguration('sfflowPreview').get('sfPath') || 'sf', cwd, onLog, signal };
}

// Progress notification with a Cancel button that really stops the sf process.
// fn(signal) gets an AbortSignal to pass to the CLI calls.
function withOrgProgress(title, fn) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
        const controller = new AbortController();
        const sub = token && token.onCancellationRequested ? token.onCancellationRequested(() => controller.abort()) : null;
        return Promise.resolve(fn(controller.signal)).finally(() => { if (sub) sub.dispose(); });
    });
}

function isCancel(e) {
    return e && /^Cancelled\.?$/.test(e.message);
}

function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).replace(/\+0000$/, 'Z'));
    return isNaN(d) ? String(iso) : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function versionLabel(org, v) {
    return `${org} · v${v.versionNumber} (${v.status}${v.lastModifiedDate ? ', ' + shortDate(v.lastModifiedDate) : ''})`;
}

// Default: the org the sf CLI would use here (project target-org, else the global one).
// No default org -> an error notification and no pickers.
async function defaultOrg(sourceUri) {
    const project = sourceUri.scheme === 'file' ? sf.findProject(sourceUri.fsPath) : null;
    const found = sf.defaultOrgFor(project);
    if (found) return { org: found.org, project, source: found.source };
    const choice = await vscode.window.showErrorMessage(
        'SF Flow: no default org is set, so there is no org to compare with. '
        + 'Set one with "sf config set target-org <alias>" (or "SFDX: Set a Default Org"), '
        + 'or turn on the setting "Compare: Choose Org" to pick an org each time.',
        'Open Settings');
    if (choice === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'sfflowPreview.compare');
    }
    return null;
}

// Only with the setting "Compare: Choose Org" on.
async function pickOrg(context, sourceUri) {
    const project = sourceUri.scheme === 'file' ? sf.findProject(sourceUri.fsPath) : null;
    const projectOrg = (sf.defaultOrgFor(project) || {}).org;
    const lastOrg = context.workspaceState.get(LAST_ORG_KEY);
    let orgs = [];
    try {
        orgs = await sf.listOrgs(cliOptions(project || undefined));
    } catch (e) {
        vscode.window.showErrorMessage(`SF Flow: could not list orgs from the Salesforce CLI. ${e.message}`);
        return null;
    }
    if (!orgs.length) {
        vscode.window.showWarningMessage('SF Flow: no orgs are authorized in the Salesforce CLI. Run "sf org login web" first.');
        return null;
    }
    const isOrg = (o, name) => name && (o.username === name || o.alias.split(',').includes(name));
    const items = orgs.map(o => {
        const name = o.alias ? o.alias.split(',')[0] : o.username;
        const tags = [];
        if (isOrg(o, projectOrg)) tags.push('default org of this project');
        if (isOrg(o, lastOrg)) tags.push('last used');
        if (o.isExpired) tags.push('EXPIRED');
        return {
            label: `$(cloud) ${name}`, org: name,
            description: [o.username !== name ? o.username : '', tags.join(', ')].filter(Boolean).join('  ·  '),
            detail: o.instanceUrl.replace(/^https:\/\//, '') + (o.isSandbox ? ' (sandbox)' : o.isScratchOrg ? ' (scratch org)' : ''),
            rank: isOrg(o, projectOrg) ? 0 : isOrg(o, lastOrg) ? 1 : 2
        };
    }).sort((a, b) => a.rank - b.rank || a.org.localeCompare(b.org));
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Compare with org version: which org?',
        placeHolder: 'Org to read the flow versions from (read-only)',
        matchOnDescription: true, matchOnDetail: true
    });
    if (!picked) return null;
    await context.workspaceState.update(LAST_ORG_KEY, picked.org);
    return { org: picked.org, project };
}

/**
 * Default: uses the default org and asks only for the version, compared with this file.
 * Settings (off by default) add an org picker (compare.chooseOrg) and a second picker to
 * compare two org versions with each other (compare.allowVersionToVersion).
 * @returns {Promise<null | { org, apiName, before: {model, label, version}, after: {model?, label, version?, isFile} }>}
 */
async function chooseComparison(context, sourceUri, apiName, fileLabel) {
    if (!sf.API_NAME.test(apiName || '')) {
        vscode.window.showWarningMessage(`SF Flow: "${apiName}" is not a flow API name the org can be searched for.`);
        return null;
    }
    const cfg = vscode.workspace.getConfiguration('sfflowPreview');
    const chooseOrg = cfg.get('compare.chooseOrg', false);
    const versionToVersion = cfg.get('compare.allowVersionToVersion', false);

    const target = chooseOrg ? await pickOrg(context, sourceUri) : await defaultOrg(sourceUri);
    if (!target) return null;
    const { org, project } = target;
    const orgNote = target.source === 'project' ? 'default org of this project'
        : target.source === 'global' ? 'global default org' : '';
    let versions;
    try {
        versions = await withOrgProgress(`SF Flow: reading versions of ${apiName} from ${org}…`, async signal => {
            const opts = cliOptions(project || undefined, signal);
            const list = await sf.listFlowVersions(org, apiName, opts);
            const names = await sf.userNames(org, list.map(v => v.lastModifiedById), opts);
            list.forEach(v => { v.lastModifiedBy = names[v.lastModifiedById] || ''; });
            return list;
        });
    } catch (e) {
        if (!isCancel(e)) vscode.window.showErrorMessage(`SF Flow: could not read flow versions from ${org}. ${e.message}`);
        return null;
    }
    if (!versions.length) {
        vscode.window.showWarningMessage(`SF Flow: ${org} has no flow named ${apiName}.`);
        return null;
    }

    const versionItems = versions.map(v => ({
        label: `Version ${v.versionNumber}`,
        description: [v.status, shortDate(v.lastModifiedDate), v.lastModifiedBy].filter(Boolean).join(' · '),
        detail: [v.label, v.description].filter(Boolean).join(' — '),
        version: v
    }));
    const first = await vscode.window.showQuickPick(versionItems, {
        title: `Compare with org version: which version of ${apiName} in ${org}${orgNote ? ` (${orgNote})` : ''}?`,
        placeHolder: versionToVersion ? 'Version to compare (newest first)' : 'Version to compare with this file (newest first)',
        matchOnDescription: true, matchOnDetail: true
    });
    if (!first) return null;

    let second = { isFile: true };
    if (versionToVersion) {
        second = await vscode.window.showQuickPick([
            { label: '$(file-code) This file', description: fileLabel, isFile: true },
            ...versionItems.filter(i => i.version.id !== first.version.id)
        ], { title: `Compare with org version: compare Version ${first.version.versionNumber} with…`, placeHolder: 'Usually this file' });
        if (!second) return null;
    }

    let older = first.version, newer = second.isFile ? null : second.version;
    if (newer && newer.versionNumber < older.versionNumber) [older, newer] = [newer, older];

    try {
        return await withOrgProgress(`SF Flow: loading ${apiName} from ${org}…`, async signal => {
            const opts = cliOptions(project || undefined, signal);
            const load = async v => buildFlowModel(normalizeToolingMetadata(await sf.fetchFlowMetadata(org, v.id, opts)), apiName);
            const before = { model: await load(older), label: versionLabel(org, older), version: older };
            const after = newer
                ? { model: await load(newer), label: versionLabel(org, newer), version: newer, isFile: false }
                : { label: 'this file', isFile: true };
            return { kind: 'org', org, project, apiName, before, after };
        });
    } catch (e) {
        if (!isCancel(e)) vscode.window.showErrorMessage(`SF Flow: could not load the flow version from ${org}. ${e.message}`);
        return null;
    }
}

function compareState(comparison, fileModel) {
    const afterModel = comparison.after.isFile ? fileModel : comparison.after.model;
    const diff = diffModels(comparison.before.model, afterModel);
    return {
        diff,
        beforeLabel: comparison.before.label,
        afterLabel: comparison.after.label,
        afterIsFile: comparison.after.isFile
    };
}

function cacheRoot(context) {
    return path.join(context.globalStorageUri.fsPath, 'org-versions');
}

// Real XML of a version, cached per org/version/last-modified in extension storage.
// With "Compare: Reuse Retrieved Versions" off, it is retrieved again every time.
async function versionXmlUri(context, comparison, v, signal) {
    const root = cacheRoot(context);
    const stamp = String(v.lastModifiedDate || '').replace(/[^0-9]/g, '');
    const file = path.join(root, comparison.org.replace(/[^\w.@+-]/g, '_'),
        `${comparison.apiName}-v${v.versionNumber}-${stamp}.flow-meta.xml`);
    const reuse = vscode.workspace.getConfiguration('sfflowPreview').get('compare.reuseRetrievedVersions', true);
    if (!reuse || !fs.existsSync(file)) {
        const xml = await sf.retrieveFlowVersionXml(comparison.org, comparison.apiName, v.versionNumber,
            path.join(root, 'tmp'), cliOptions(comparison.project || undefined, signal));
        parseFlowXml(xml); // make sure it is a flow before caching it
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, xml, 'utf8');
    }
    return vscode.Uri.file(file);
}

async function openXmlDiff(context, comparison, sourceUri) {
    const title = `${comparison.apiName}: ${comparison.before.label} ↔ ${comparison.after.label}`;
    if (comparison.kind === 'file') { // two local files: nothing to retrieve
        await vscode.commands.executeCommand('vscode.diff', comparison.before.uri, sourceUri, title, { preview: false });
        return;
    }
    try {
        const [left, right] = await withOrgProgress(`SF Flow: retrieving the XML of ${comparison.apiName} from ${comparison.org}…`, async signal => [
            await versionXmlUri(context, comparison, comparison.before.version, signal),
            comparison.after.isFile ? sourceUri : await versionXmlUri(context, comparison, comparison.after.version, signal)
        ]);
        await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
    } catch (e) {
        if (!isCancel(e)) vscode.window.showErrorMessage(`SF Flow: could not retrieve the flow XML. ${e.message}`);
    }
}

// "SF Flow: Clear Cached Org Versions": deletes the retrieved version XML after a confirmation.
async function clearCache(context) {
    const root = cacheRoot(context);
    const files = [];
    const walk = dir => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else files.push({ full, size: fs.statSync(full).size });
        }
    };
    walk(root);
    if (!files.length) {
        vscode.window.showInformationMessage('SF Flow: there are no cached org versions to clear.');
        return 0;
    }
    const kb = Math.max(1, Math.round(files.reduce((s, f) => s + f.size, 0) / 1024));
    const choice = await vscode.window.showWarningMessage(
        `Delete ${files.length} cached flow version file${files.length === 1 ? '' : 's'} (${kb} KB)?`,
        { modal: true, detail: `Folder: ${root}\nThey are retrieved again from the org when you next open a Side-by-side XML diff.` },
        'Delete');
    if (choice !== 'Delete') return 0;
    fs.rmSync(root, { recursive: true, force: true });
    channel().appendLine(`${new Date().toISOString()}  cleared ${files.length} cached org version file(s) from ${root}`);
    vscode.window.showInformationMessage(`SF Flow: cleared ${files.length} cached org version file${files.length === 1 ? '' : 's'}.`);
    return files.length;
}

module.exports = { chooseComparison, compareState, openXmlDiff, clearCache, cacheRoot, channel };
