'use strict';
// Editor features for flow XML files: hover, Go to Definition (incl. subflow files),
// Find All References, Outline, and the checks in the Problems panel.
// Each document is parsed once per version and cached; every provider catches its own
// errors (a provider must never break the editor) and files over MAX_XML_CHARS are skipped.

const vscode = require('vscode');
const { parseFlowXml, looksLikeFlow, flowApiName, indexElements } = require('./flowXml');
const { buildFlowModel } = require('./flowModel');
const { checkFlow } = require('./flowLint');
const { MAX_XML_CHARS } = require('./limits');

const SELECTOR = [{ language: 'xml' }, { pattern: '**/*.flow' }, { pattern: '**/*.flow-meta.xml' }];
const cache = new Map(); // uri -> { version, info }

// { xml, definition, model, index, byName, issues } or null (not a flow / too large / invalid)
function flowInfo(doc) {
    if (!doc) return null;
    const key = doc.uri.toString();
    const hit = cache.get(key);
    if (hit && hit.version === doc.version) return hit.info;
    let info = null;
    try {
        const xml = doc.getText();
        const head = xml.substring(0, 600);
        if (xml.length <= MAX_XML_CHARS && looksLikeFlow(doc.fileName, head) && /<Flow[\s>]/.test(head)) {
            const definition = parseFlowXml(xml);
            const model = buildFlowModel(definition, flowApiName(doc.fileName));
            const index = indexElements(xml);
            info = {
                xml, definition, model, index,
                byName: new Map(model.elements.map(e => [e.name, e])),
                indexByName: new Map(index.filter(e => e.name).map(e => [e.name, e]))
            };
        }
    } catch (e) {
        info = null; // invalid XML while typing: no features until it parses again
    }
    cache.set(key, { version: doc.version, info });
    return info;
}

function lazyIssues(info) {
    if (!info.issues) {
        try { info.issues = checkFlow(info.model, info.definition, info.xml); } catch (e) { info.issues = []; }
    }
    return info.issues;
}

// The element/resource name under the cursor: "Get_Account.Id" -> Get_Account,
// "{!Var}" -> Var; "$Record.X" and unknown words -> null.
function nameAt(doc, position, info) {
    const range = doc.getWordRangeAtPosition(position, /[A-Za-z_$][A-Za-z0-9_$.]*/);
    if (!range) return null;
    const word = doc.getText(range);
    if (word.startsWith('$')) return null;
    const base = word.split('.')[0];
    return info.byName.has(base) ? { name: base, range } : null;
}

function rangeOf(doc, start, end) {
    return new vscode.Range(doc.positionAt(start), doc.positionAt(end));
}

function hoverMarkdown(el, issues) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**');
    md.appendText(el.name);
    md.appendMarkdown('** · `' + el.type + '`');
    if (el.label && el.label !== el.name) { md.appendMarkdown(' · '); md.appendText(el.label); }
    md.appendMarkdown('\n\n');
    if (el.description) { md.appendText(el.description); md.appendMarkdown('\n\n'); }
    const params = el.parameters.slice(0, 14);
    if (params.length) {
        md.appendCodeblock(params.join('\n') + (el.parameters.length > params.length ? `\n… ${el.parameters.length - params.length} more` : ''), 'text');
    }
    const outs = el.branches.filter(b => b.label || b.next).slice(0, 10);
    if (outs.length) {
        md.appendMarkdown('**Outcomes**\n');
        outs.forEach(b => {
            md.appendMarkdown('- ');
            md.appendText(`${b.label || 'next'}${b.logic ? ` [${b.logic}]` : ''} → ${b.next || '(end)'}`);
            md.appendMarkdown('\n');
        });
    }
    if (el.from.length) {
        md.appendMarkdown('\n**From** ');
        md.appendText(el.from.slice(0, 12).map(f => f.name + (f.label && f.label !== 'success' ? ` (${f.label.replace(/\s*\([A-Za-z][A-Za-z0-9_]*\)$/, '')})` : '')).join(', '));
        md.appendMarkdown('\n');
    }
    issues.forEach(i => {
        md.appendMarkdown(`\n${i.severity === 'warning' ? '$(warning)' : '$(info)'} `);
        md.appendText(`${i.rule}: ${i.message}`);
    });
    md.supportThemeIcons = true;
    return md;
}

const SYMBOL_KIND = {
    start: 'Event', decision: 'Enum', loop: 'Event', assignment: 'Field', screen: 'Interface',
    recordLookup: 'Method', recordCreate: 'Method', recordUpdate: 'Method', recordDelete: 'Method',
    actionCall: 'Function', subflow: 'Module', apexPluginCall: 'Function', variable: 'Variable',
    formula: 'Constant', constant: 'Constant', textTemplate: 'String', choice: 'EnumMember'
};

function register(context) {
    const diagnostics = vscode.languages.createDiagnosticCollection('sfflow');
    context.subscriptions.push(diagnostics);
    const cfg = () => vscode.workspace.getConfiguration('sfflowPreview');

    context.subscriptions.push(
        vscode.languages.registerHoverProvider(SELECTOR, {
            provideHover(doc, position) {
                try {
                    const info = flowInfo(doc);
                    const hit = info && nameAt(doc, position, info);
                    if (!hit) return null;
                    const el = info.byName.get(hit.name);
                    const issues = lazyIssues(info).filter(i => i.element === hit.name);
                    return new vscode.Hover(hoverMarkdown(el, issues), hit.range);
                } catch (e) { return null; }
            }
        }),

        vscode.languages.registerDefinitionProvider(SELECTOR, {
            async provideDefinition(doc, position) {
                try {
                    const info = flowInfo(doc);
                    if (!info) return null;
                    // <flowName>Other_Flow</flowName> in a subflow: open that flow's file
                    const line = doc.lineAt(position.line).text;
                    const flowName = /<flowName>\s*([A-Za-z][A-Za-z0-9_]*)\s*<\/flowName>/.exec(line);
                    if (flowName) {
                        const files = await vscode.workspace.findFiles(`**/${flowName[1]}.flow-meta.xml`, '**/node_modules/**', 5);
                        return files.map(uri => new vscode.Location(uri, new vscode.Position(0, 0)));
                    }
                    const hit = nameAt(doc, position, info);
                    const target = hit && info.indexByName.get(hit.name);
                    return target ? new vscode.Location(doc.uri, rangeOf(doc, target.nameStart, target.nameEnd)) : null;
                } catch (e) { return null; }
            }
        }),

        vscode.languages.registerReferenceProvider(SELECTOR, {
            provideReferences(doc, position, refContext) {
                try {
                    const info = flowInfo(doc);
                    const hit = info && nameAt(doc, position, info);
                    if (!hit) return [];
                    const own = info.indexByName.get(hit.name);
                    const re = new RegExp(`(?<![A-Za-z0-9_$])${hit.name}(?![A-Za-z0-9_])`, 'g');
                    const out = [];
                    for (const m of info.xml.matchAll(re)) {
                        if (!refContext.includeDeclaration && own && m.index === own.nameStart) continue;
                        out.push(new vscode.Location(doc.uri, rangeOf(doc, m.index, m.index + hit.name.length)));
                    }
                    return out;
                } catch (e) { return []; }
            }
        }),

        vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
            provideDocumentSymbols(doc) {
                try {
                    const info = flowInfo(doc);
                    if (!info) return [];
                    const groups = new Map();
                    for (const entry of info.index) {
                        if (!entry.name) continue;
                        const el = info.byName.get(entry.name);
                        const type = el ? el.type : entry.tag;
                        const kind = vscode.SymbolKind[SYMBOL_KIND[type] || 'Object'];
                        const sym = new vscode.DocumentSymbol(entry.name, el && el.label && el.label !== entry.name ? el.label : type,
                            kind, rangeOf(doc, entry.start, entry.end), rangeOf(doc, entry.nameStart, entry.nameEnd));
                        if (!groups.has(entry.tag)) groups.set(entry.tag, []);
                        groups.get(entry.tag).push(sym);
                    }
                    return [...groups.entries()].map(([tag, children]) => {
                        const first = children[0], last = children[children.length - 1];
                        const group = new vscode.DocumentSymbol(tag, `${children.length}`, vscode.SymbolKind.Namespace,
                            new vscode.Range(first.range.start, last.range.end), first.selectionRange);
                        group.children = children;
                        return group;
                    });
                } catch (e) { return []; }
            }
        })
    );

    // checks in the Problems panel, debounced per document
    const timers = new Map();
    const refresh = doc => {
        try {
            if (!cfg().get('checks.enabled', true) || !cfg().get('checks.showInProblems', true)) {
                diagnostics.delete(doc.uri);
                return;
            }
            const info = flowInfo(doc);
            if (!info) { diagnostics.delete(doc.uri); return; }
            const labelEntry = info.index.find(e => e.tag === 'label');
            const list = lazyIssues(info).map(i => {
                const at = i.element ? info.indexByName.get(i.element) : labelEntry;
                const range = at && at.nameStart >= 0 ? rangeOf(doc, at.nameStart, at.nameEnd)
                    : at ? rangeOf(doc, at.start, at.end) : new vscode.Range(0, 0, 0, 0);
                const d = new vscode.Diagnostic(range, i.message,
                    i.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
                d.source = 'SF Flow';
                d.code = i.rule;
                return d;
            });
            diagnostics.set(doc.uri, list);
        } catch (e) {
            diagnostics.delete(doc.uri);
        }
    };
    const schedule = doc => {
        const key = doc.uri.toString();
        clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => { timers.delete(key); refresh(doc); }, 400));
    };
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => { if (looksLikeFlow(doc.fileName, '') || doc.languageId === 'xml') schedule(doc); }),
        vscode.workspace.onDidChangeTextDocument(e => { if (cache.has(e.document.uri.toString()) || looksLikeFlow(e.document.fileName, '')) schedule(e.document); }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            diagnostics.delete(doc.uri);
            cache.delete(doc.uri.toString());
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('sfflowPreview.checks')) vscode.workspace.textDocuments.forEach(refresh);
        }),
        { dispose: () => timers.forEach(t => clearTimeout(t)) }
    );
    vscode.workspace.textDocuments.forEach(schedule);
}

module.exports = { register, flowInfo };
