'use strict';
// "Compare with Local File": compare this flow file with another flow file on disk
// (e.g. the same flow retrieved into another project folder). Local only, no org.

const vscode = require('vscode');
const path = require('path');
const { parseFlowXml, flowApiName } = require('./flowXml');
const { buildFlowModel } = require('./flowModel');
const { MAX_XML_CHARS } = require('./limits');

function displayPath(uri) {
    const rel = vscode.workspace.asRelativePath(uri, true);
    return rel === uri.fsPath ? uri.fsPath : rel;
}

// Other copies of the same flow in the workspace (bounded search), plus Browse…
async function chooseFile(sourceUri, apiName) {
    let candidates = [];
    try {
        const found = await vscode.workspace.findFiles(`**/${apiName}.flow-meta.xml`, '**/node_modules/**', 50);
        candidates = found.filter(u => u.toString() !== sourceUri.toString());
    } catch (e) {
        candidates = [];
    }
    const browse = async () => {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            defaultUri: sourceUri.scheme === 'file' ? vscode.Uri.file(path.dirname(sourceUri.fsPath)) : undefined,
            filters: { 'Flow metadata': ['xml', 'flow'] },
            openLabel: 'Compare with this file',
            title: `Compare ${apiName} with…`
        });
        return picked && picked[0];
    };
    if (!candidates.length) return browse();
    const items = candidates.map(uri => ({ label: `$(file-code) ${path.basename(uri.fsPath)}`, description: displayPath(uri), uri }));
    items.push({ label: '$(folder-opened) Browse…', description: 'pick any flow file on disk', browse: true });
    const picked = await vscode.window.showQuickPick(items, {
        title: `Compare with local file: which copy of ${apiName}?`,
        placeHolder: 'Other copies of this flow in the workspace',
        matchOnDescription: true
    });
    if (!picked) return undefined;
    return picked.browse ? browse() : picked.uri;
}

// Reads and parses the other file. Throws with a readable message.
async function loadModel(uri) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.length > MAX_XML_CHARS) throw new Error(`${path.basename(uri.fsPath)} is too large to compare (${Math.round(bytes.length / 1048576)} MB).`);
    return buildFlowModel(parseFlowXml(Buffer.from(bytes).toString('utf8')), flowApiName(uri.path));
}

/** @returns {Promise<null | { kind: 'file', apiName, before: {model, label, uri}, after: {label, isFile} }>} */
async function chooseComparison(sourceUri, apiName) {
    const uri = await chooseFile(sourceUri, apiName);
    if (!uri) return null;
    if (uri.toString() === sourceUri.toString()) {
        vscode.window.showWarningMessage('SF Flow: that is this file; pick another copy to compare with.');
        return null;
    }
    try {
        const model = await loadModel(uri);
        return { kind: 'file', apiName, before: { model, label: displayPath(uri), uri }, after: { label: 'this file', isFile: true } };
    } catch (e) {
        vscode.window.showErrorMessage(`SF Flow: could not read ${path.basename(uri.fsPath)}. ${e.message}`);
        return null;
    }
}

module.exports = { chooseComparison, loadModel };
