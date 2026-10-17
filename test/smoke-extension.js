'use strict';
// Smoke test for extension.js with a mocked `vscode` module (no VS Code needed).
// Writes only into a temp folder it creates and deletes.
//   node test/smoke-extension.js              (Salesforce CLI stubbed)
//   node test/smoke-extension.js --live p2    (compare goes through the real sf CLI against
//                                             that org: read-only, logged to logs/org_actions.jsonl;
//                                             needs the test flow from test/org-deploy-versions.js)

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfflow-smoke-'));
const wsRoot = path.join(tmp, 'ws');
const flowDir = path.join(wsRoot, 'force-app', 'main', 'default', 'flows');
fs.mkdirSync(flowDir, { recursive: true });
const flowFile = path.join(flowDir, 'Kitchen_Sink.flow-meta.xml');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'Kitchen_Sink.flow-meta.xml'), flowFile);
const complex = require('./org-flows/complexFlow');
const complexFile = path.join(flowDir, complex.API_NAME + '.flow-meta.xml');
fs.writeFileSync(complexFile, complex.build(4)); // "this file" = v4 content
const liveIdx = process.argv.indexOf('--live');
const liveOrg = liveIdx > 0 ? process.argv[liveIdx + 1] : null;

// ---------- Salesforce CLI ----------
const sfCli = require('../src/sfCli');
if (liveOrg) {
    const orglog = require('../scripts/orglog');
    const runId = 'smoke-live-' + new Date().toISOString().replace(/[:.]/g, '-');
    // log every real org call made through the extension
    for (const name of ['listFlowVersions', 'fetchFlowMetadata', 'userNames', 'retrieveFlowVersionXml']) {
        const real = sfCli[name];
        sfCli[name] = (...args) => {
            // copy the options: the extension reuses one options object for several calls
            const opts = args[args.length - 1] || {};
            args[args.length - 1] = {
                ...opts,
                onLog: e => { if (opts.onLog) opts.onLog(e); orglog.log({ ...e, org: liveOrg, source: 'test/smoke-extension.js --live', runId }); }
            };
            return real(...args);
        };
    }
} else {
    const { parseFlowXml } = require('../src/flowXml');
    sfCli.listOrgs = async () => [{ alias: 'p2', username: 'tester@example.com', instanceUrl: 'https://example.my.salesforce.com', isSandbox: false, isScratchOrg: false, isExpired: false }];
    sfCli.listFlowVersions = async () => [5, 4, 3, 2, 1].map(v => ({
        id: '301000000000000AA' + v, versionNumber: v, status: v === 5 ? 'Draft' : v === 4 ? 'Active' : 'Obsolete',
        label: 'SFFlowPreview Test Complex', lastModifiedDate: '2026-11-08T01:2' + v + ':00.000+0000', lastModifiedById: '005000000000001AAA'
    }));
    sfCli.userNames = async () => ({ '005000000000001AAA': 'Test User' });
    sfCli.fetchFlowMetadata = async (org, id) => parseFlowXml(complex.build(Number(id.slice(-1))));
    sfCli.retrieveFlowVersionXml = async (org, name, v) => complex.build(Number(v));
}
// count XML retrieves (stubbed or live) to check the cache
let retrieveCount = 0;
{
    const counted = sfCli.retrieveFlowVersionXml;
    sfCli.retrieveFlowVersionXml = (...args) => { retrieveCount++; return counted(...args); };
}

// ---------- mock ----------
const commands = new Map();
const executed = [];
let warningChoice; // what a modal warning (confirmation) returns
const contextKeys = {};
const posted = [];
const messages = [];
let quickPickChoice = null;
let clipboard = '';
let messageHandler = null;
const opened = []; // URLs passed to env.openExternal
let saveTarget = 'out.md';
let compareChooser = null; // (items, title) => item
const configOverrides = {}; // sfflowPreview.* settings changed by a test step
const outputLines = [];
const workspaceStore = {};

class Uri {
    constructor(fsPath, scheme = 'file') { this.fsPath = path.resolve(fsPath); this.scheme = scheme; this.path = this.fsPath.replace(/\\/g, '/'); }
    static file(p) { return new Uri(p); }
    static parse(s) {
        if (/^https?:/.test(s)) return { scheme: s.split(':')[0], raw: s, toString: () => s }; // web links (feedback)
        return new Uri(s.replace(/^file:\/\//, ''));
    }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    toString() { return 'file://' + this.path; }
}
class Position { constructor(line, character) { this.line = line; this.character = character; } }
// Range(Position, Position) or Range(l1, c1, l2, c2); a/b = start/end, c = end line (old helpers)
class Range {
    constructor(a, b, c, d) {
        if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); this.c = c; }
        else { this.start = a; this.end = b; this.c = b && b.line; }
        this.a = this.start; this.b = this.end;
    }
}
class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
class Location { constructor(uri, where) { this.uri = uri; this.range = where; } }
class MarkdownString {
    constructor() { this.value = ''; }
    appendMarkdown(t) { this.value += t; return this; }
    appendText(t) { this.value += t; return this; }
    appendCodeblock(t) { this.value += '\n```\n' + t + '\n```\n'; return this; }
}
class DocumentSymbol { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange, children: [] }); } }
class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
const providers = {};
const diagnosticsByUri = new Map();
const docEvents = {};
const disposable = { dispose() {} };
const event = () => () => disposable;

function makeDoc(uri) {
    const text = fs.readFileSync(uri.fsPath, 'utf8');
    const lines = text.split('\n');
    const offsetAt = pos => lines.slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.character;
    const doc = {
        uri, fileName: uri.fsPath, languageId: 'xml', lineCount: lines.length, version: 1,
        getText: (range) => {
            if (!range) return text;
            if (range.start && range.end && range.start.line !== undefined && range.c === undefined) return text.substring(offsetAt(range.start), offsetAt(range.end));
            if (range.start && range.end) return text.substring(offsetAt(range.start), offsetAt(range.end));
            return lines.slice(0, range.c).join('\n');
        },
        positionAt: (offset) => {
            const before = text.substring(0, offset).split('\n');
            return new Position(before.length - 1, before[before.length - 1].length);
        },
        offsetAt,
        lineAt: n => ({ text: lines[n] }),
        getWordRangeAtPosition: (pos, re) => {
            const g = new RegExp(re.source, 'g');
            for (const m of lines[pos.line].matchAll(g)) {
                if (m.index <= pos.character && pos.character <= m.index + m[0].length) {
                    return new Range(new Position(pos.line, m.index), new Position(pos.line, m.index + m[0].length));
                }
            }
            return undefined;
        }
    };
    return doc;
}

let revealedSelection = null;
let revealedDoc = null;
// text of the editor selection made by the last reveal (Range(start, end) of Positions)
function selectedText() {
    const lines = revealedDoc.getText().split('\n');
    const { a, b } = revealedSelection;
    if (a.line === b.line) return lines[a.line].substring(a.character, b.character);
    return [lines[a.line].substring(a.character), ...lines.slice(a.line + 1, b.line), lines[b.line].substring(0, b.character)].join('\n');
}
const vscode = {
    Uri, Range, Position, Hover, Location, MarkdownString, DocumentSymbol, Diagnostic,
    SymbolKind: new Proxy({}, { get: (t, k) => (typeof k === 'string' ? k : undefined) }),
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: {
        registerHoverProvider: (sel, p) => { providers.hover = p; return disposable; },
        registerDefinitionProvider: (sel, p) => { providers.definition = p; return disposable; },
        registerReferenceProvider: (sel, p) => { providers.references = p; return disposable; },
        registerDocumentSymbolProvider: (sel, p) => { providers.symbols = p; return disposable; },
        createDiagnosticCollection: () => ({
            set: (uri, list) => diagnosticsByUri.set(uri.toString(), list),
            delete: uri => diagnosticsByUri.delete(uri.toString()),
            dispose() {}
        })
    },
    ViewColumn: { One: 1, Two: 2, Beside: -2 },
    TextEditorRevealType: { InCenter: 2 },
    ProgressLocation: { Notification: 15 },
    RelativePattern: class { constructor(b, p) { this.b = b; this.p = p; } },
    CancellationTokenSource: class { constructor() { this.token = {}; } dispose() {} },
    LanguageModelChatMessage: { User: t => ({ role: 'user', t }) },
    commands: {
        registerCommand: (id, fn) => { commands.set(id, fn); return disposable; },
        executeCommand: async (id, ...args) => {
            if (id === 'setContext') { contextKeys[args[0]] = args[1]; return; }
            executed.push({ id, args });
        },
        getCommands: async () => ['claude-vscode.editor.open', 'agentforce.injectPromptToInput', 'workbench.action.chat.open']
    },
    extensions: { getExtension: id => (['anthropic.claude-code', 'salesforce.salesforcedx-einstein-gpt'].includes(id) ? { id } : undefined) },
    lm: { selectChatModels: async () => [] },
    version: '1.132.0',
    env: { clipboard: { writeText: async t => { clipboard = t; } }, openExternal: async uri => { opened.push(uri.raw || uri.fsPath); return true; } },
    window: {
        activeTextEditor: undefined,
        visibleTextEditors: [],
        onDidChangeActiveTextEditor: event(),
        showWarningMessage: async (m) => { messages.push(m); return warningChoice; },
        showInformationMessage: async (m) => { messages.push(m); },
        showQuickPick: async (items, opts) => (opts && /^Compare/.test(opts.title || '') && compareChooser
            ? compareChooser(items, opts.title)
            : items.find(i => i.id === quickPickChoice)),
        showErrorMessage: (m) => { messages.push('ERROR ' + m); },
        withProgress: async (o, fn) => fn({ report() {} }),
        createOutputChannel: () => ({ appendLine: l => outputLines.push(l), dispose() {} }),
        showSaveDialog: async () => Uri.file(path.join(tmp, saveTarget)),
        showTextDocument: async (doc, opts) => {
            revealedSelection = opts && opts.selection;
            revealedDoc = doc;
            return { revealRange() {}, document: doc };
        },
        registerWebviewPanelSerializer: () => disposable,
        createWebviewPanel: () => ({
            title: '', viewColumn: 2, iconPath: null,
            webview: {
                cspSource: 'vscode-resource:', html: '', options: {},
                asWebviewUri: u => 'webview://' + u.path,
                postMessage: m => { posted.push(m); return Promise.resolve(true); },
                onDidReceiveMessage: h => { messageHandler = h; return disposable; }
            },
            onDidDispose: event(), onDidChangeViewState: event(), reveal() {}, dispose() {}
        })
    },
    workspace: {
        textDocuments: [],
        getConfiguration: () => ({ get: (k, d) => ({ aiTarget: 'ask', summaryFolder: '.sfflow', showResources: true, defaultPrompt: 'DEFAULT PROMPT', ...configOverrides })[k] ?? d }),
        onDidChangeTextDocument: event(),
        onDidOpenTextDocument: h => { docEvents.open = h; return disposable; },
        onDidCloseTextDocument: h => { docEvents.close = h; return disposable; },
        // bounded file search like VS Code's: glob "**/<name>" under the workspace
        findFiles: async (glob, exclude, max) => {
            const want = glob.replace(/^\*\*\//, '');
            const out = [];
            const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
                const full = path.join(d, e.name);
                if (e.isDirectory()) walk(full); else if (e.name === want && out.length < (max || 1e9)) out.push(Uri.file(full));
            });
            walk(wsRoot);
            return out;
        },
        onDidChangeConfiguration: event(),
        createFileSystemWatcher: () => ({ onDidChange: event(), onDidCreate: event(), dispose() {} }),
        getWorkspaceFolder: uri => (uri.fsPath.startsWith(wsRoot) ? { uri: Uri.file(wsRoot) } : undefined),
        asRelativePath: uri => path.relative(wsRoot, uri.fsPath).replace(/\\/g, '/'),
        openTextDocument: async uri => makeDoc(uri),
        fs: {
            readFile: async uri => fs.readFileSync(uri.fsPath),
            writeFile: async (uri, data) => fs.writeFileSync(uri.fsPath, data),
            createDirectory: async uri => fs.mkdirSync(uri.fsPath, { recursive: true }),
            stat: async uri => fs.statSync(uri.fsPath)
        }
    }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

// ---------- run ----------
(async () => {
    const ext = require('../extension.js');
    const context = {
        subscriptions: [],
        extensionUri: Uri.file(path.join(__dirname, '..')),
        globalStorageUri: Uri.file(path.join(tmp, 'global')),
        globalState: { get: () => undefined, update: async () => {} },
        workspaceState: { get: k => workspaceStore[k], update: async (k, v) => { workspaceStore[k] = v; } }
    };
    ext.activate(context);
    for (const id of ['sfflowPreview.preview', 'sfflowPreview.askAi', 'sfflowPreview.saveMarkdown', 'sfflowPreview.openSource']) {
        assert(commands.has(id), 'command registered: ' + id);
    }

    // package.json commands all registered
    const pkg = require('../package.json');
    pkg.contributes.commands.forEach(c => assert(commands.has(c.command), 'contributed command has a handler: ' + c.command));
    // command: links in setting descriptions must point at registered commands
    for (const [key, prop] of Object.entries(pkg.contributes.configuration.properties)) {
        for (const m of (prop.markdownDescription || '').matchAll(/\(command:([\w.]+)\)/g)) {
            assert(commands.has(m[1]), `${key} links to an unknown command ${m[1]}`);
        }
    }

    await commands.get('sfflowPreview.preview')(Uri.file(flowFile));
    await new Promise(r => setTimeout(r, 50));
    const rendered = posted.find(m => m.type === 'render');
    assert(rendered, 'render message posted');
    assert(rendered.html.includes('Kitchen Sink'));
    assert(rendered.sourceUri.endsWith('Kitchen_Sink.flow-meta.xml'));
    console.log('  ok   preview renders');

    await messageHandler({ type: 'reveal', name: 'Check_Amount' });
    assert(revealedSelection && revealedSelection.a.line > 0, 'reveal selects a line');
    assert(/^<decisions>[\s\S]*<name>Check_Amount<\/name>[\s\S]*<\/decisions>$/.test(selectedText()), 'whole decision block selected');
    console.log('  ok   reveal element in XML: whole <decisions> block selected (lines '
        + (revealedSelection.a.line + 1) + '-' + (revealedSelection.b.line + 1) + ')');

    quickPickChoice = 'claudeCode';
    await messageHandler({ type: 'askAi', question: '' });
    const summary = path.join(wsRoot, '.sfflow', 'Kitchen_Sink.flow-summary.md');
    assert(fs.existsSync(summary), 'summary file written');
    assert.strictEqual(fs.readFileSync(path.join(wsRoot, '.sfflow', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
    const claude = executed.find(e => e.id === 'claude-vscode.editor.open');
    assert(claude && claude.args[0] === undefined && claude.args[1].includes('@.sfflow/Kitchen_Sink.flow-summary.md'), JSON.stringify(claude));
    assert(claude.args[1].startsWith('DEFAULT PROMPT'));
    console.log('  ok   Claude Code: ' + JSON.stringify(claude.args[1].split('\n').pop()));

    quickPickChoice = 'agentforce';
    await messageHandler({ type: 'askAi', question: 'What objects does it update?' });
    const af = executed.find(e => e.id === 'agentforce.injectPromptToInput');
    assert(af && af.args[0].prompt.startsWith('What objects does it update?') && af.args[0].prompt.includes('|Element name|'));
    console.log('  ok   Agentforce prompt injected (' + af.args[0].prompt.length + ' chars)');

    quickPickChoice = 'chat';
    await messageHandler({ type: 'askAi', question: '' });
    const chat = executed.find(e => e.id === 'workbench.action.chat.open');
    assert(chat && chat.args[0].isPartialQuery === true && chat.args[0].query.includes('# Flow: Kitchen Sink'));
    console.log('  ok   VS Code Chat opened with query');

    quickPickChoice = 'clipboard';
    await messageHandler({ type: 'askAi', question: '' });
    assert(clipboard.includes('## Step by step'));
    console.log('  ok   clipboard');

    saveTarget = 'out.md';
    await messageHandler({ type: 'saveMarkdown' });
    assert(fs.readFileSync(path.join(tmp, 'out.md'), 'utf8').startsWith('# Flow: Kitchen Sink'));
    console.log('  ok   save Markdown');

    saveTarget = 'out.html';
    await messageHandler({ type: 'saveHtml' });
    const saved = fs.readFileSync(path.join(tmp, 'out.html'), 'utf8');
    assert(saved.startsWith('<!DOCTYPE html>') && saved.includes('<title>Flow: Kitchen Sink</title>'));
    assert(saved.includes('#flowTable') && saved.includes('prefers-color-scheme: dark'), 'styles inlined with light/dark theme');
    assert(saved.includes('href="#el-Show_Error"') && saved.includes('id="el-Show_Error"'), 'row links work without script');
    assert(!/<script/i.test(saved) && !saved.includes('class="reveal"'), 'no scripts or VS Code-only links');
    assert(saved.includes('from force-app/main/default/flows/Kitchen_Sink.flow-meta.xml'));
    console.log('  ok   save HTML (' + saved.length + ' chars, self-contained)');
    assert(saved.includes('<svg class="flow-diagram"'), 'saved HTML includes the diagram');
    assert(saved.includes('class="checks"') && saved.includes('UnreachableElement'), 'saved HTML includes the checks');

    // ---- checks + diagram in the preview (Kitchen Sink) ----
    const sinkRender = posted.filter(m => m.type === 'render').pop();
    assert(sinkRender.html.includes('class="checks"') && sinkRender.html.includes('lint-warning') && sinkRender.html.includes('UnreachableElement'), 'Checks section');
    assert(/data-name="Orphan_Screen"[\s\S]{0,700}badge lint-warning/.test(sinkRender.html), 'warning badge on the unreachable element');
    assert(!sinkRender.html.includes('<svg'), 'no diagram while the Table tab is shown');
    posted.length = 0;
    await messageHandler({ type: 'view', view: 'diagram' });
    const diagramRender = posted.filter(m => m.type === 'render').pop();
    const nodeCount = (diagramRender.html.match(/<g class="node /g) || []).length;
    assert(diagramRender.html.includes('<svg class="flow-diagram"') && nodeCount === 14, 'diagram built when shown: ' + nodeCount);
    assert(diagramRender.html.includes('id="diagramView" class="diagram">'), 'diagram view visible');
    await messageHandler({ type: 'view', view: 'table' });
    console.log(`  ok   preview: Checks section + badges; diagram built only when shown (${nodeCount} boxes)`);

    // ---- editor features on the XML ----
    const sinkDoc = makeDoc(Uri.file(flowFile));
    const sinkText = sinkDoc.getText();
    const posOf = (needle, plus = 0) => sinkDoc.positionAt(sinkText.indexOf(needle) + plus);
    const refPos = posOf('<targetReference>Get_Accounts', '<targetReference>'.length + 3);
    const hover = providers.hover.provideHover(sinkDoc, refPos);
    assert(hover && /Get_Accounts\*\* · `recordLookup`/.test(hover.contents.value) && hover.contents.value.includes('fault → Show_Error'), hover && hover.contents.value);
    const def = await providers.definition.provideDefinition(sinkDoc, refPos);
    assert.strictEqual(sinkDoc.getText(def.range), 'Get_Accounts');
    assert(sinkText.substring(sinkDoc.offsetAt(def.range.start) - 6, sinkDoc.offsetAt(def.range.start)) === '<name>', 'definition = the element\'s own <name>');
    const refs = providers.references.provideReferences(sinkDoc, refPos, { includeDeclaration: true });
    const refsNoDecl = providers.references.provideReferences(sinkDoc, refPos, { includeDeclaration: false });
    assert(refs.length >= 3 && refsNoDecl.length === refs.length - 1, `references ${refs.length}/${refsNoDecl.length}`);
    const exprPos = posOf('{!$Record.CreatedDate}', 3); // $Record: not an element
    assert.strictEqual(providers.hover.provideHover(sinkDoc, exprPos), null);
    const symbols = providers.symbols.provideDocumentSymbols(sinkDoc);
    const decisions = symbols.find(sg => sg.name === 'decisions');
    assert(decisions && decisions.children.some(c => c.name === 'Check_Amount'), 'Outline groups elements by type');
    // subflow name -> that flow's file in the workspace
    const subDir = path.join(wsRoot, 'force-app', 'main', 'default', 'flows');
    fs.writeFileSync(path.join(subDir, 'Child_Flow.flow-meta.xml'), '<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><label>Child</label></Flow>');
    const subDefs = await providers.definition.provideDefinition(sinkDoc, posOf('<flowName>Child_Flow', '<flowName>'.length + 2));
    assert(subDefs.length === 1 && subDefs[0].uri.fsPath.endsWith('Child_Flow.flow-meta.xml'), 'subflow opens its file');
    // Problems panel (debounced)
    docEvents.open(sinkDoc);
    await new Promise(r => setTimeout(r, 500));
    const diags = diagnosticsByUri.get(sinkDoc.uri.toString()) || [];
    const unreachable = diags.find(d => d.code === 'UnreachableElement');
    assert(unreachable && sinkDoc.getText(unreachable.range) === 'Orphan_Screen' && unreachable.source === 'SF Flow', 'diagnostic on the element name');
    configOverrides['checks.showInProblems'] = false;
    sinkDoc.version = 2;
    docEvents.open(sinkDoc);
    await new Promise(r => setTimeout(r, 500));
    assert(!diagnosticsByUri.has(sinkDoc.uri.toString()), 'setting off clears the Problems entries');
    delete configOverrides['checks.showInProblems'];
    console.log(`  ok   editor: hover, Go to Definition (+ subflow file), ${refs.length} references, Outline, ${diags.length} Problems entries`);

    // ---- compare with org version: v2 in the org vs this file (v4 content) ----
    await commands.get('sfflowPreview.preview')(Uri.file(complexFile));
    await new Promise(r => setTimeout(r, 50));
    // the flow sits in an sfdx project; a fake home folder keeps the real global sf config out of the test
    const testOrg = liveOrg || 'p2';
    fs.writeFileSync(path.join(wsRoot, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app","default":true}]}');
    const fakeHome = path.join(tmp, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    // only the default-org lookup sees the fake home; env vars stay real so sf (live mode)
    // still finds the CLI's saved logins
    os.homedir = () => fakeHome;
    const titles = [];
    compareChooser = (items, title) => {
        titles.push(title);
        if (/which org/.test(title)) return items.find(i => i.org === testOrg);
        if (/which version/.test(title)) return items.find(i => i.version.versionNumber === items[0].version.versionNumber - 3); // newest-3 = v2
        return items.find(i => i.isFile);
    };
    const runCompare = async () => {
        titles.length = 0;
        messages.length = 0;
        posted.length = 0;
        await messageHandler({ type: 'compare' });
        await new Promise(r => setTimeout(r, 50));
    };

    // 1. no default org anywhere: an error notification, no pickers
    await runCompare();
    assert.strictEqual(titles.length, 0, 'no pickers: ' + titles.join(' | '));
    assert(messages.some(m => /^ERROR SF Flow: no default org is set/.test(m)), messages.join(' | '));
    console.log('  ok   no default org: error notification, no pickers');

    // 2. only a global default org (home folder): used, one picker
    fs.mkdirSync(path.join(fakeHome, '.sf'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.sf', 'config.json'), JSON.stringify({ 'target-org': testOrg }));
    await runCompare();
    assert.strictEqual(titles.length, 1, 'one picker: ' + titles.join(' | ') + ' ' + messages.join(' | '));
    assert(titles[0].includes(`in ${testOrg} (global default org)`), titles[0]);
    console.log('  ok   global default org used: one picker "' + titles[0] + '"');

    // 3. the project's default org wins over the global one: one picker, compared with this file
    fs.mkdirSync(path.join(wsRoot, '.sf'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, '.sf', 'config.json'), JSON.stringify({ 'target-org': testOrg }));
    await runCompare();
    assert.strictEqual(titles.length, 1, 'only the version picker: ' + titles.join(' | ') + '\n' + messages.join('\n'));
    assert(titles[0].includes('(default org of this project)'), titles[0]);
    console.log('  ok   project default org: only the version picker');
    const cmpRender = posted.filter(m => m.type === 'render').pop();
    assert(cmpRender && cmpRender.comparing, 'render with compare; messages: ' + messages.join(' | '));
    const h = cmpRender.html;
    assert(/from <strong>[^<]*v\d+ \(Obsolete/.test(h), 'before label shows org version');
    assert(h.includes('to <strong>this file</strong>'));
    for (const [name, change] of [['Filter_Big_Opps', 'added'], ['Update_Account_Description', 'removed'], ['Check_Account', 'changed'], ['HighValueThreshold', 'changed']]) {
        assert(new RegExp(name + '[\\s\\S]{0,400}?chg-' + change).test(h), name + ' should be ' + change);
    }
    assert(h.includes('data-change="added"'), 'row badges in the main table');
    console.log('  ok   compare ' + (liveOrg ? 'LIVE ' + liveOrg : '(stubbed sf)') + ': ' + /\d+ added · \d+ removed · \d+ changed · \d+ unchanged/.exec(h)[0]);

    // main table name -> this file's XML, whole element block selected
    await messageHandler({ type: 'reveal', name: 'Filter_Big_Opps' });
    assert.strictEqual(revealedDoc.fileName, path.resolve(complexFile));
    assert(/^<collectionProcessors>[\s\S]*Filter_Big_Opps[\s\S]*<\/collectionProcessors>$/.test(selectedText()));
    console.log('  ok   main table name opens this file at the whole <collectionProcessors> block');

    // AI summary and saved HTML include the changes
    quickPickChoice = 'clipboard';
    await messageHandler({ type: 'askAi', question: 'What changed since the org version?' });
    assert(clipboard.includes('## Changes from') && clipboard.includes('Filter_Big_Opps (collectionProcessor): added'));
    saveTarget = 'cmp.html';
    await messageHandler({ type: 'saveHtml' });
    assert(fs.readFileSync(path.join(tmp, 'cmp.html'), 'utf8').includes('class="compare"'));
    console.log('  ok   changes included in Ask with AI summary and saved HTML');

    // side-by-side XML diff: real XML of the org version vs this file
    await messageHandler({ type: 'compareXmlDiff' });
    const diffCall = executed.filter(e => e.id === 'vscode.diff').pop();
    assert(diffCall, 'vscode.diff opened; messages: ' + messages.join(' | '));
    const leftXml = fs.readFileSync(diffCall.args[0].fsPath, 'utf8');
    assert(leftXml.includes('<Flow xmlns="http://soap.sforce.com/2006/04/metadata">') && leftXml.includes('Update_Account_Description'), 'left side is the v2 XML');
    assert.strictEqual(diffCall.args[1].fsPath, path.resolve(complexFile));
    console.log('  ok   XML diff: ' + path.basename(diffCall.args[0].fsPath) + ' <-> ' + path.basename(complexFile) + ' "' + diffCall.args[2] + '"');

    // cache: reused by default, retrieved again with the setting off
    const cachedFile = diffCall.args[0].fsPath;
    assert(cachedFile.startsWith(path.join(tmp, 'global', 'org-versions')), 'cached in extension storage: ' + cachedFile);
    let n = retrieveCount;
    await messageHandler({ type: 'compareXmlDiff' });
    assert.strictEqual(retrieveCount, n, 'second diff reuses the cached XML');
    configOverrides['compare.reuseRetrievedVersions'] = false;
    await messageHandler({ type: 'compareXmlDiff' });
    assert.strictEqual(retrieveCount, n + 1, 'setting off: retrieved again');
    delete configOverrides['compare.reuseRetrievedVersions'];
    console.log('  ok   cache reused; "Reuse Retrieved Versions" off retrieves again');

    // "Clear Cached Org Versions": Cancel keeps the files, Delete removes the folder
    warningChoice = undefined;
    messages.length = 0;
    assert.strictEqual(await commands.get('sfflowPreview.clearOrgVersionCache')(), 0);
    assert(fs.existsSync(cachedFile), 'cancel keeps the cache');
    assert(/^Delete 1 cached flow version file \(\d+ KB\)\?$/.test(messages[0]), messages.join(' | '));
    warningChoice = 'Delete';
    assert.strictEqual(await commands.get('sfflowPreview.clearOrgVersionCache')(), 1);
    assert(!fs.existsSync(path.join(tmp, 'global', 'org-versions')), 'cache folder removed');
    messages.length = 0;
    await commands.get('sfflowPreview.clearOrgVersionCache')();
    assert(messages.some(m => /no cached org versions/.test(m)), messages.join(' | '));
    warningChoice = undefined;
    console.log('  ok   Clear Cached Org Versions: confirm, delete, then "nothing to clear"');

    // editing the file updates the comparison live
    fs.writeFileSync(complexFile, complex.build(2));
    posted.length = 0;
    await messageHandler({ type: 'ready' });
    await new Promise(r => setTimeout(r, 50));
    const again = posted.filter(m => m.type === 'render').pop();
    assert(again.html.includes('No element differences'), 'file now equals v2');
    console.log('  ok   comparison recomputed after the file changed (now equal to v2)');

    await messageHandler({ type: 'compareClose' });
    await new Promise(r => setTimeout(r, 50));
    const closed = posted.filter(m => m.type === 'render').pop();
    assert(!closed.comparing && !closed.html.includes('class="compare"'));
    console.log('  ok   close comparison');

    // 4. both settings on: org picker + version picker + "compare with" picker (two org versions)
    Object.assign(configOverrides, { 'compare.chooseOrg': true, 'compare.allowVersionToVersion': true });
    compareChooser = (items, title) => {
        titles.push(title);
        if (/which org/.test(title)) return items.find(i => i.org === testOrg);
        if (/which version/.test(title)) return items.find(i => i.version.versionNumber === items[0].version.versionNumber - 3); // v2
        // "compare Version 2 with…": "This file", then the other versions newest first -> the 2nd one is v4
        return items.filter(i => i.version)[1];
    };
    await runCompare();
    assert.strictEqual(titles.length, 3, 'org, version, compare-with: ' + titles.join(' | ') + '\n' + messages.join('\n'));
    const v2v = posted.filter(m => m.type === 'render').pop();
    assert(v2v.comparing && new RegExp(`to <strong>${testOrg} · v\\d+ \\(Active`).test(v2v.html), 'org version vs org version');
    assert(!v2v.html.includes('data-change='), 'no row badges: the main table is this file, not the compared versions');
    console.log('  ok   settings on: 3 pickers, ' + /from <strong>[^<]*<\/strong> to <strong>[^<]*<\/strong>/.exec(v2v.html)[0].replace(/<\/?strong>/g, ''));
    await messageHandler({ type: 'compareClose' });
    for (const k of Object.keys(configOverrides)) delete configOverrides[k];

    // ---- compare with a local file: another copy of the flow (v2) elsewhere in the workspace ----
    fs.writeFileSync(complexFile, complex.build(4));
    const otherDir = path.join(wsRoot, 'other-project', 'flows');
    fs.mkdirSync(otherDir, { recursive: true });
    const otherFile = path.join(otherDir, complex.API_NAME + '.flow-meta.xml');
    fs.writeFileSync(otherFile, complex.build(2));
    const fileTitles = [];
    compareChooser = (items, title) => {
        fileTitles.push(title);
        return items.find(i => i.uri && i.uri.fsPath === path.resolve(otherFile));
    };
    posted.length = 0;
    await messageHandler({ type: 'compareFile' });
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(fileTitles.length, 1, 'one picker: ' + fileTitles.join(' | ') + ' ' + messages.join(' | '));
    const fileCmp = posted.filter(m => m.type === 'render').pop();
    assert(fileCmp && fileCmp.comparing && fileCmp.html.includes('from <strong>other-project/flows/SFFlowPreview_Test_Complex.flow-meta.xml</strong> to <strong>this file</strong>'), 'local compare render');
    assert(/2 added · 2 removed · \d+ changed/.test(fileCmp.html), /\d+ added · \d+ removed · \d+ changed · \d+ unchanged/.exec(fileCmp.html));
    await messageHandler({ type: 'compareXmlDiff' });
    const fileDiff = executed.filter(e => e.id === 'vscode.diff').pop();
    assert.strictEqual(fileDiff.args[0].fsPath, path.resolve(otherFile));
    assert.strictEqual(fileDiff.args[1].fsPath, path.resolve(complexFile));
    // the other file changes -> comparison follows it
    fs.writeFileSync(otherFile, complex.build(4));
    posted.length = 0;
    await messageHandler({ type: 'ready' });
    await new Promise(r => setTimeout(r, 50));
    assert(posted.filter(m => m.type === 'render').pop().html.includes('No element differences'), 'reloaded the other file');
    // "Change…" re-picks the same kind (local file)
    fileTitles.length = 0;
    await messageHandler({ type: 'compareChange' });
    assert(/^Compare with local file/.test(fileTitles[0] || ''), fileTitles.join(' | '));
    await messageHandler({ type: 'compareClose' });
    console.log('  ok   compare with local file: one picker, changes, XML diff of the two files, follows edits to the other file');
    if (outputLines.length) console.log('       SF Flow output: ' + outputLines.length + ' line(s), e.g. ' + outputLines[0].replace(/^\S+\s+/, '').substring(0, 110));

    // feedback: footer links and the command open the GitHub pages
    opened.length = 0;
    await messageHandler({ type: 'feedback', kind: 'bug' });
    await messageHandler({ type: 'feedback', kind: 'discuss' });
    const pkgVersion = require('../package.json').version;
    assert(opened[0].startsWith('https://github.com/rohit-kumar-g/sfflow-table-preview/issues/new?template=bug_report.yml')
        && opened[0].includes(`ext-version=${pkgVersion}`) && opened[0].includes('vscode-version=1.132.0')
        && /os=(win32|darwin|linux)-/.test(opened[0]), opened[0]);
    assert.strictEqual(opened[1], 'https://github.com/rohit-kumar-g/sfflow-table-preview/discussions');
    quickPickChoice = undefined;
    assert(commands.has('sfflowPreview.feedback'));
    console.log('  ok   feedback: bug report prefilled (' + opened[0].split('?')[1] + '), Discussions link');

    // broken XML while a valid model exists keeps the table
    fs.writeFileSync(complexFile, '<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><label>broken');
    posted.length = 0;
    await messageHandler({ type: 'ready' });
    await new Promise(r => setTimeout(r, 50));
    assert(posted[0].type === 'error' && posted[0].keep === true, JSON.stringify(posted[0]));
    console.log('  ok   invalid XML keeps last table: ' + posted[0].text.split('\n')[0]);

    console.log('\nsmoke test passed');
})().catch(e => {
    console.error('SMOKE TEST FAILED\n', e);
    process.exitCode = 1;
}).finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});
