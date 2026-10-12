'use strict';
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { parseFlowXml, looksLikeFlow, flowApiName, findElementRange } = require('./src/flowXml');
const { buildFlowModel } = require('./src/flowModel');
const render = require('./src/render');
const { askWithAi } = require('./src/ai');
const orgCompare = require('./src/orgCompare');
const fileCompare = require('./src/fileCompare');
const { checkFlow } = require('./src/flowLint');
const { renderDiagramSvg } = require('./src/diagram');
const language = require('./src/language');
const { giveFeedback } = require('./src/feedback');
const { MAX_XML_CHARS } = require('./src/limits');

const VIEW_TYPE = 'sfflowPreview';
const previews = new Map(); // source uri string -> FlowPreview
let activePreview;

function setContext(key, value) {
    return vscode.commands.executeCommand('setContext', key, value);
}

function isFlowDocument(doc) {
    if (!doc || doc.uri.scheme === 'output') return false;
    const head = doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 10), 0));
    return looksLikeFlow(doc.fileName, head);
}

class FlowPreview {
    constructor(context, sourceUri, panel) {
        this.context = context;
        this.sourceUri = sourceUri;
        this.model = null;
        this.definition = null;
        this.xml = '';
        this.issues = [];
        this.view = 'table';    // 'table' | 'diagram' (the diagram is only built while shown)
        this.comparison = null; // set by "Compare with org version" / "Compare with local file"
        this.disposables = [];
        this.panel = panel || vscode.window.createWebviewPanel(
            VIEW_TYPE, 'Flow preview', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
        );
        this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
        this.panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
        this.panel.webview.html = this.shellHtml();

        this.disposables.push(
            this.panel.onDidDispose(() => this.dispose()),
            this.panel.onDidChangeViewState(e => {
                if (e.webviewPanel.active) activePreview = this;
                setContext('sfflowPreview.hasPreview', previews.size > 0);
            }),
            this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg)),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === this.sourceUri.toString()) this.scheduleUpdate();
            })
        );

        // changes made outside the editor (sf project retrieve, git checkout)
        if (sourceUri.scheme === 'file') {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(path.dirname(sourceUri.fsPath)), path.basename(sourceUri.fsPath)));
            watcher.onDidChange(() => this.scheduleUpdate());
            watcher.onDidCreate(() => this.scheduleUpdate());
            this.disposables.push(watcher);
        }

        previews.set(sourceUri.toString(), this);
        activePreview = this;
        setContext('sfflowPreview.hasPreview', true);
    }

    static show(context, sourceUri) {
        const existing = previews.get(sourceUri.toString());
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Beside, true);
            existing.update();
            return existing;
        }
        const preview = new FlowPreview(context, sourceUri);
        preview.update();
        return preview;
    }

    scheduleUpdate() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.update(), 300);
    }

    async readSource() {
        const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === this.sourceUri.toString());
        if (open) return open.getText(); // includes unsaved edits
        const bytes = await vscode.workspace.fs.readFile(this.sourceUri);
        return Buffer.from(bytes).toString('utf8');
    }

    async update() {
        const apiName = flowApiName(this.sourceUri.path);
        try {
            const xml = await this.readSource();
            if (xml.length > MAX_XML_CHARS) {
                // stop instead of freezing on a huge file
                throw new Error(`Stopped: this file is ${(xml.length / 1048576).toFixed(1)} MB; the preview reads flows up to ${MAX_XML_CHARS / 1048576} MB.`);
            }
            const definition = parseFlowXml(xml);
            this.model = buildFlowModel(definition, apiName);
            this.definition = definition;
            this.xml = xml;
            const cfg = vscode.workspace.getConfiguration('sfflowPreview');
            try {
                this.issues = cfg.get('checks.enabled', true) ? checkFlow(this.model, definition, xml) : [];
            } catch (e) {
                this.issues = [];
            }
            if (this.comparison && this.comparison.kind === 'file') {
                // the other file may have changed too; keep the last good copy if it no longer parses
                try { this.comparison.before.model = await fileCompare.loadModel(this.comparison.before.uri); } catch (e) { /* keep */ }
            }
            this.panel.title = `Flow: ${this.model.label}`;
            this.post({
                type: 'render',
                html: render.renderBodyHtml(this.model, this.renderOptions()),
                comparing: Boolean(this.comparison),
                showResources: vscode.workspace.getConfiguration('sfflowPreview').get('showResources', true)
            });
        } catch (e) {
            const text = e && e.message ? e.message : String(e);
            if (this.model) {
                // mid-edit: keep the last valid table and say so
                this.post({ type: 'error', keep: true, text: `${text}\nShowing the last valid version of the flow.` });
            } else {
                this.panel.title = `Flow: ${apiName}`;
                this.post({ type: 'error', text });
            }
        }
    }

    // Compare section + "added/changed" row badges, recomputed on every update so
    // edits to the file show up against the org version straight away.
    // forExport: the saved HTML page always gets the diagram (built now) and no view tabs.
    renderOptions(forExport = false) {
        if (!this.model) return {};
        const opts = { issues: this.issues, view: this.view };
        if (this.comparison) {
            const compare = orgCompare.compareState(this.comparison, this.model);
            opts.compare = compare;
            opts.compareLabel = compare.beforeLabel;
            if (compare.afterIsFile) opts.changes = new Map(compare.diff.elements.map(e => [e.name, e.change]));
        }
        if (forExport || this.view === 'diagram') {
            try {
                const issuesMap = new Map();
                this.issues.forEach(i => { if (i.element) (issuesMap.get(i.element) || issuesMap.set(i.element, []).get(i.element)).push(i); });
                opts.diagram = renderDiagramSvg(this.model, { changes: opts.changes, issues: issuesMap });
            } catch (e) {
                opts.diagram = { stopped: `the diagram could not be drawn (${e.message}).` };
            }
        }
        return opts;
    }

    // kind: 'org' (version in the default org) or 'file' (another flow file on disk)
    async startCompare(kind = 'org') {
        if (!this.model) {
            vscode.window.showWarningMessage('SF Flow: the flow could not be read, so there is nothing to compare.');
            return;
        }
        const comparison = kind === 'file'
            ? await fileCompare.chooseComparison(this.sourceUri, this.model.apiName)
            : await orgCompare.chooseComparison(this.context, this.sourceUri, this.model.apiName,
                vscode.workspace.asRelativePath(this.sourceUri, false));
        if (!comparison) return;
        this.comparison = comparison;
        await this.update();
    }

    post(message) {
        // sourceUri lets the webview save it in its state, so the serializer can restore the panel
        this.panel.webview.postMessage({ ...message, sourceUri: this.sourceUri.toString() });
    }

    async onMessage(msg) {
        switch (msg && msg.type) {
            case 'ready':
                if (msg.view === 'diagram' || msg.view === 'table') this.view = msg.view;
                this.update();
                break;
            case 'view':
                this.view = msg.view === 'diagram' ? 'diagram' : 'table';
                if (this.view === 'diagram') await this.update(); // build the diagram only when it is shown
                break;
            case 'reveal':
                await this.revealElement(msg.name);
                break;
            case 'askAi':
                await this.askAi(msg.question);
                break;
            case 'saveMarkdown':
                await this.saveAs('markdown');
                break;
            case 'saveHtml':
                await this.saveAs('html');
                break;
            case 'compare':
                await this.startCompare('org');
                break;
            case 'compareFile':
                await this.startCompare('file');
                break;
            case 'compareChange':
                await this.startCompare(this.comparison ? this.comparison.kind : 'org');
                break;
            case 'compareClose':
                this.comparison = null;
                await this.update();
                break;
            case 'compareXmlDiff':
                if (this.comparison) await orgCompare.openXmlDiff(this.context, this.comparison, this.sourceUri);
                break;
            case 'openSource':
                await this.openSource();
                break;
            case 'feedback':
                await giveFeedback(msg.kind);
                break;
            default:
                break;
        }
    }

    // Opens an XML document beside the preview (never on top of it).
    async openDocument(uri, selection) {
        const doc = await vscode.workspace.openTextDocument(uri);
        const visible = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
        const column = visible ? visible.viewColumn : (this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
        return vscode.window.showTextDocument(doc, { viewColumn: column, selection, preserveFocus: false, preview: false });
    }

    openSource(selection) {
        return this.openDocument(this.sourceUri, selection);
    }

    // From the main table (always this file): select the element's whole block in the XML.
    async revealElement(name) {
        const uri = this.sourceUri;
        const doc = await vscode.workspace.openTextDocument(uri);
        const found = findElementRange(doc.getText(), name);
        if (!found) {
            vscode.window.showWarningMessage(`SF Flow: could not find "${name}" in ${path.basename(uri.fsPath)}.`);
            return;
        }
        // select the whole element block and show it from its first line
        const range = new vscode.Range(doc.positionAt(found.start), doc.positionAt(found.end));
        const editor = await this.openDocument(uri, range);
        editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
    }

    async askAi(question) {
        if (!this.model) {
            vscode.window.showWarningMessage('SF Flow: nothing to send; the flow could not be read.');
            return;
        }
        const sourcePath = vscode.workspace.asRelativePath(this.sourceUri, false);
        await askWithAi({
            context: this.context,
            sourceUri: this.sourceUri,
            apiName: this.model.apiName,
            summaryMarkdown: render.renderAiSummary(this.model, sourcePath, this.renderOptions()),
            question,
            post: m => this.post(m)
        });
    }

    // kind: 'markdown' (table as .md) or 'html' (self-contained page that opens in any browser)
    async saveAs(kind) {
        if (!this.model) {
            vscode.window.showWarningMessage('SF Flow: nothing to save; the flow could not be read.');
            return;
        }
        const isHtml = kind === 'html';
        const dir = this.sourceUri.scheme === 'file' ? path.dirname(this.sourceUri.fsPath) : undefined;
        const fileName = `${this.model.apiName || this.model.label} - flowDefinition.${isHtml ? 'html' : 'md'}`;
        const target = await vscode.window.showSaveDialog({
            defaultUri: dir ? vscode.Uri.file(path.join(dir, fileName)) : undefined,
            filters: isHtml ? { HTML: ['html', 'htm'] } : { Markdown: ['md'] },
            title: isHtml ? 'Save flow table as HTML' : 'Save flow table as Markdown'
        });
        if (!target) return;

        let content;
        if (isHtml) {
            const cssBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.css'));
            content = render.renderStandaloneHtml(this.model, Buffer.from(cssBytes).toString('utf8'),
                vscode.workspace.asRelativePath(this.sourceUri, false), this.renderOptions(true));
        } else {
            content = render.renderMarkdown(this.model, this.renderOptions());
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));

        const actions = isHtml ? ['Open in Browser', 'Open'] : ['Open'];
        const choice = await vscode.window.showInformationMessage(`SF Flow: saved ${path.basename(target.fsPath)}.`, ...actions);
        if (choice === 'Open in Browser') {
            await vscode.env.openExternal(target);
        } else if (choice === 'Open') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
        }
    }

    shellHtml() {
        const webview = this.panel.webview;
        const nonce = crypto.randomBytes(16).toString('base64');
        const media = file => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('preview.css')}">
<title>Flow preview</title>
</head>
<body>
<div id="toolbar">
  <input id="question" type="text" placeholder="Ask about this flow, or leave blank for the default summary prompt" aria-label="Question for AI">
  <button id="askAi" class="primary" title="Send the flow summary to an AI agent in VS Code">Ask with AI</button>
  <span class="sep"></span>
  <input id="filter" type="search" placeholder="Filter rows" aria-label="Filter rows">
  <label class="check"><input id="showResources" type="checkbox"> Resources</label>
  <button id="compare" title="Compare this file with a version of the flow in your default org (read-only)">Compare with org…</button>
  <button id="compareFile" title="Compare this file with another flow file on disk">Compare with file…</button>
  <button id="saveMd" title="Save the table as a Markdown file">Save Markdown</button>
  <button id="saveHtml" title="Save the table as an HTML page that opens in any browser">Save HTML</button>
  <button id="openSource" title="Open the flow XML">Open XML</button>
</div>
<section id="ai" hidden>
  <div class="ai-head"><strong>AI answer</strong> <span id="aiModel" class="muted"></span><button id="aiClose" class="link" title="Hide">Hide</button></div>
  <div id="aiText"></div>
</section>
<div id="error" hidden></div>
<main id="content"><p class="muted">Reading flow…</p></main>
<footer id="feedback" class="muted">Feedback?
  <a role="link" tabindex="0" data-feedback="bug">Report a problem</a> ·
  <a role="link" tabindex="0" data-feedback="idea">Suggest a feature</a> ·
  <a role="link" tabindex="0" data-feedback="discuss">Questions and feedback</a></footer>
<script nonce="${nonce}" src="${media('preview.js')}"></script>
</body>
</html>`;
    }

    dispose() {
        clearTimeout(this.timer);
        previews.delete(this.sourceUri.toString());
        if (activePreview === this) activePreview = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        setContext('sfflowPreview.hasPreview', previews.size > 0);
    }
}

function currentPreview() {
    return activePreview || [...previews.values()].pop();
}

// Compare from a command (title bar, right-click, palette): opens the preview first if needed.
async function compareCommand(context, uri, kind) {
    let p = uri instanceof vscode.Uri ? previews.get(uri.toString()) : currentPreview();
    if (!p) {
        const editor = vscode.window.activeTextEditor;
        const target = uri instanceof vscode.Uri ? uri : (editor && isFlowDocument(editor.document) ? editor.document.uri : undefined);
        if (!target) {
            vscode.window.showWarningMessage('SF Flow: open a flow metadata file (*.flow-meta.xml) first.');
            return;
        }
        p = FlowPreview.show(context, target);
        await p.update();
    }
    await p.startCompare(kind);
}

function activate(context) {
    const updateIsFlow = editor => setContext('sfflowPreview.isFlow', Boolean(editor && isFlowDocument(editor.document)));
    updateIsFlow(vscode.window.activeTextEditor);

    // hover, Go to Definition, Find All References, Outline, checks in the Problems panel
    language.register(context);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateIsFlow),

        vscode.commands.registerCommand('sfflowPreview.preview', async (uri) => {
            let target = uri instanceof vscode.Uri ? uri : undefined;
            if (!target) {
                const editor = vscode.window.activeTextEditor;
                if (editor && isFlowDocument(editor.document)) target = editor.document.uri;
            }
            if (!target) {
                vscode.window.showWarningMessage('SF Flow: open a flow metadata file (*.flow-meta.xml) first.');
                return;
            }
            FlowPreview.show(context, target);
        }),

        vscode.commands.registerCommand('sfflowPreview.askAi', async () => {
            const p = currentPreview();
            if (p) await p.askAi('');
        }),

        vscode.commands.registerCommand('sfflowPreview.saveMarkdown', async () => {
            const p = currentPreview();
            if (p) await p.saveAs('markdown');
        }),

        vscode.commands.registerCommand('sfflowPreview.saveHtml', async () => {
            const p = currentPreview();
            if (p) await p.saveAs('html');
        }),

        vscode.commands.registerCommand('sfflowPreview.compareOrgVersion', uri => compareCommand(context, uri, 'org')),
        vscode.commands.registerCommand('sfflowPreview.compareLocalFile', uri => compareCommand(context, uri, 'file')),

        vscode.commands.registerCommand('sfflowPreview.clearOrgVersionCache', () => orgCompare.clearCache(context)),
        vscode.commands.registerCommand('sfflowPreview.feedback', () => giveFeedback()),

        vscode.commands.registerCommand('sfflowPreview.openSource', async () => {
            const p = currentPreview();
            if (p) await p.openSource();
        }),

        // restore previews after VS Code restarts
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(panel, state) {
                if (!state || !state.sourceUri) {
                    panel.dispose();
                    return;
                }
                const preview = new FlowPreview(context, vscode.Uri.parse(state.sourceUri), panel);
                preview.update();
            }
        }),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('sfflowPreview.showResources') || e.affectsConfiguration('sfflowPreview.checks')) {
                previews.forEach(p => p.update());
            }
        })
    );
}

function deactivate() {
    previews.forEach(p => p.panel.dispose());
}

module.exports = { activate, deactivate };
