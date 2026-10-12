'use strict';
// Renders the flow model as (1) HTML for the preview webview, (2) a Markdown
// table (same columns as the Chrome extension's download) and (3) the Markdown
// summary handed to AI agents.

const COLUMNS = ['Element name', 'Type', 'Parameters', 'Condition', 'Condition next element'];

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function anchorId(name) {
    return 'el-' + String(name).replace(/[^A-Za-z0-9_-]/g, '_');
}

// The "Condition next element" cell of one outcome row of an element
function branchId(name, index) {
    return `br-${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}-${index}`;
}

// Port of rainbow(): colours nested brackets in decision condition logic by depth
// and breaks the line after top-level groups. Input must already be HTML-escaped.
function rainbow(escapedText) {
    let depth = 0;
    let result = '';
    for (let i = 0; i < escapedText.length; i++) {
        const char = escapedText[i];
        if (char === '(') {
            const level = depth % 6;
            result += `<span class="lvl lvl-${level}" title="Level ${level}: opening bracket">(</span>`;
            depth++;
        } else if (char === ')') {
            depth = Math.max(0, depth - 1);
            const level = depth % 6;
            result += `<span class="lvl lvl-${level}" title="Level ${level}: closing bracket">)</span>`;
            const nextChar = escapedText[i + 1];
            if (nextChar === ')') {
                if (level === 0) result += '<br>';
            } else if (i !== escapedText.length - 1 && (level === 0 || level === 1)) {
                result += '<br>';
            }
        } else {
            result += char;
        }
    }
    return `<span class="cond-logic">${result}</span>`;
}

// One block per parameter/condition line, so each assignment sits on its own line;
// a long line wraps with a hanging indent instead of running into the next one.
// "Input assignments:"-style lines become group headings.
function htmlLines(lines) {
    if (!lines.length) return '';
    let inGroup = false;
    const items = lines.map(line => {
        const text = esc(line);
        if (/:$/.test(line)) {
            inGroup = true;
            return `<div class="phead">${text}</div>`;
        }
        return `<div class="pl${inGroup ? ' grouped' : ''}">${text}</div>`;
    });
    return `<div class="plist">${items.join('')}</div>`;
}

// Link to a cell of the table. In the webview the links have NO href: VS Code's webview
// host scrolls to the top on any click on href="#" (even after preventDefault), so the
// script handles them (data-target). In a saved HTML file a #fragment link works on its own.
function gotoLink(name, opts, targetId = anchorId(name), text = esc(name)) {
    const id = esc(targetId);
    return opts.standalone
        ? `<a href="#${id}" class="goto">${text}</a>`
        : `<a class="goto" role="link" tabindex="0" data-target="${id}">${text}</a>`;
}

function nextCell(branch, opts) {
    if (!branch.next) return '';
    const note = branch.nextNote ? ` <span class="muted">(${esc(branch.nextNote)})</span>` : '';
    if (branch.nextExists) {
        return `${gotoLink(branch.next, opts)}${note}`;
    }
    return `${esc(branch.next)}${note} <span class="muted" title="Not an element in this flow">(?)</span>`;
}

function conditionCell(branch) {
    let html = esc(branch.label);
    if (branch.logic && branch.logic !== 'and' && branch.logic !== 'or') {
        html += '<br>' + rainbow(esc(branch.logic));
    } else if (branch.logic) {
        html += ` <span class="muted">[${esc(branch.logic.toUpperCase())}]</span>`;
    }
    if (branch.conditions.length) html += htmlLines(branch.conditions);
    return html;
}

function elementCell(el, opts) {
    const small = [el.label, el.description].filter(Boolean).join(' / ');
    let html = opts.standalone
        ? `<strong>${esc(el.name)}</strong>`
        : `<a class="reveal" role="link" tabindex="0" data-name="${esc(el.name)}" title="Show in XML">${esc(el.name)}</a>`;
    if (small) html += `<br><span class="small">${esc(small)}</span>`;
    if (!el.reached && el.kind === 'step' && el.name !== 'Start') {
        html += '<br><span class="badge warn" title="No path from Start reaches this element">not connected</span>';
    }
    const change = opts.changes && opts.changes.get(el.name);
    if (change === 'added' || change === 'changed') {
        html += `<br><span class="badge chg-${change}" title="Compared with ${esc(opts.compareLabel || 'the other version')}">${change}</span>`;
    }
    if (el.from.length) {
        // each entry jumps to the exact outcome row of the element that leads here
        html += `<div class="from"><span class="muted">From:</span> `
            + el.from.map(f => {
                // "Is Hot (Is_Hot)" -> "Is Hot": the API name in brackets is noise here
                const label = String(f.label || '').replace(/\s*\([A-Za-z][A-Za-z0-9_]*\)$/, '');
                const outcome = label && label !== 'success' ? ` <span class="small">(${esc(label)})</span>` : '';
                return gotoLink(f.name, opts, branchId(f.name, f.branch), esc(f.name) + outcome);
            }).join(', ')
            + '</div>';
    }
    // checks for this element (rule names, details in the tooltip and the Checks section)
    const issues = (opts.issuesByName && opts.issuesByName.get(el.name)) || [];
    if (issues.length) {
        html += '<div class="lint-badges">' + issues.slice(0, 3).map(i =>
            `<span class="badge lint-${i.severity}" title="${esc(i.message)}">${i.severity === 'warning' ? '⚠' : 'ℹ'} ${esc(i.rule)}</span>`).join(' ')
            + (issues.length > 3 ? ` <span class="small">+${issues.length - 3}</span>` : '') + '</div>';
    }
    return html;
}

function issuesByName(issues) {
    const map = new Map();
    (issues || []).forEach(i => {
        if (!i.element) return;
        if (!map.has(i.element)) map.set(i.element, []);
        map.get(i.element).push(i);
    });
    return map;
}

// ---------- checks ----------

function renderChecksHtml(issues, opts) {
    if (!issues || !issues.length) {
        return opts.standalone ? '' : '<section class="checks"><span class="muted">Checks: no findings.</span></section>';
    }
    const warnings = issues.filter(i => i.severity === 'warning').length;
    const infos = issues.length - warnings;
    const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1));
    const rows = sorted.map(i => {
        const where = i.element ? gotoLink(i.element, opts) : '<span class="muted">flow</span>';
        return `<tr class="lint-${i.severity}"><td class="sev">${i.severity === 'warning' ? '⚠' : 'ℹ'}</td><td class="el">${where}</td>`
            + `<td>${esc(i.message)} <span class="small rule">${esc(i.rule)}</span></td></tr>`;
    }).join('');
    return `<section class="checks"><details${warnings ? ' open' : ''}>
  <summary><strong>Checks</strong> <span class="muted">${warnings} warning${warnings === 1 ? '' : 's'} · ${infos} info</span>
    <span class="small muted" title="Quick built-in checks. The full scan with more rules: SFDX: Scan Current File with Code Analyzer.">same rule names as Salesforce Code Analyzer</span></summary>
  <table class="checks-table"><tbody>${rows}</tbody></table>
</details></section>`;
}

function renderChecksMarkdown(issues) {
    if (!issues || !issues.length) return '';
    const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1));
    return '## Checks\n\n' + sorted.map(i => `- ${i.severity === 'warning' ? 'Warning' : 'Info'} (${i.rule})${i.element ? ` ${i.element}` : ''}: ${i.message}`).join('\n') + '\n\n';
}

// ---------- table / diagram views ----------

// opts.diagram: { svg, stopped } when rendered; undefined = not built yet (built when the
// Diagram tab is opened). opts.view: 'table' | 'diagram'.
function renderViewsHtml(model, opts) {
    const table = renderTableHtml(model, opts);
    if (opts.standalone) {
        const d = opts.diagram;
        const diagram = d && (d.svg || d.stopped)
            ? `<section class="diagram"><h2>Diagram</h2>${d.svg ? `<div class="diagram-scroll">${d.svg}</div>` : `<p class="muted">${esc(d.stopped)}</p>`}</section>`
            : '';
        return diagram + table;
    }
    const view = opts.view === 'diagram' ? 'diagram' : 'table';
    let diagramInner;
    if (!opts.diagram) diagramInner = '<p class="muted">Drawing the diagram…</p>';
    else if (opts.diagram.stopped) diagramInner = `<p class="stopped">Diagram stopped: ${esc(opts.diagram.stopped)}</p>`;
    else {
        diagramInner = `<div class="diagram-tools">
    <button data-zoom="out" title="Zoom out (Ctrl+wheel)">−</button><button data-zoom="fit" title="Fit to width">Fit</button><button data-zoom="in" title="Zoom in (Ctrl+wheel)">+</button>
    <span class="small muted">Click a box: show it in the table · Ctrl+click: open it in the XML · drag to move</span>
  </div>
  <div class="diagram-scroll">${opts.diagram.svg}</div>`;
    }
    return `<div class="view-tabs" role="tablist">
  <button role="tab" data-view="table" class="${view === 'table' ? 'active' : ''}">Table</button>
  <button role="tab" data-view="diagram" class="${view === 'diagram' ? 'active' : ''}">Diagram</button>
</div>
<section id="diagramView" class="diagram"${view === 'diagram' ? '' : ' hidden'}>${diagramInner}</section>
<div id="tableView"${view === 'table' ? '' : ' hidden'}>${table}</div>`;
}

function renderTableHtml(model, opts = {}) {
    let rows = '';
    for (const el of model.elements) {
        const branches = el.branches.length ? el.branches : [{ label: '', logic: '', conditions: [], next: '' }];
        const span = branches.length;
        const searchText = esc([el.name, el.label, el.description, el.type, ...el.parameters].join(' ').toLowerCase());
        branches.forEach((b, i) => {
            const change = opts.changes ? ` data-change="${esc(opts.changes.get(el.name) || 'unchanged')}"` : '';
            rows += `<tr class="kind-${el.kind}" data-group="${esc(anchorId(el.name))}"${change}${i === 0 ? ` data-search="${searchText}"` : ''}>`;
            if (i === 0) {
                rows += `<td rowspan="${span}" id="${esc(anchorId(el.name))}" class="el">${elementCell(el, opts)}</td>`
                    + `<td rowspan="${span}" class="type"><span class="type-tag type-${esc(el.type)}">${esc(el.type)}</span></td>`
                    + `<td rowspan="${span}" class="params">${htmlLines(el.parameters)}</td>`;
            }
            const nextId = el.branches.length ? ` id="${esc(branchId(el.name, i))}"` : '';
            rows += `<td class="cond">${conditionCell(b)}</td><td class="next"${nextId}>${nextCell(b, opts)}</td></tr>`;
        });
    }
    return `<table id="flowTable"><thead><tr>${COLUMNS.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows}</tbody></table>`;
}

function renderBodyHtml(model, opts = {}) {
    if (opts.issues && !opts.issuesByName) opts = { ...opts, issuesByName: issuesByName(opts.issues) };
    const facts = [
        ['API name', model.apiName], ['Type', model.processType], ['Trigger', model.triggerType],
        ['Object', model.object], ['Status', model.status], ['API version', model.apiVersion]
    ].filter(([, v]) => v);
    const factsHtml = facts.map(([k, v]) => `<span class="fact"><span class="muted">${esc(k)}:</span> ${esc(v)}</span>`).join('');
    const explanation = model.explanation.length
        ? `<ul class="explain">${model.explanation.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
        : '<p class="muted">No record changes, actions, subflows or screens found on any path from Start.</p>';
    const counts = `${model.counts.steps} steps`
        + (model.counts.unreached ? `, ${model.counts.unreached} not connected` : '')
        + `, ${model.counts.resources} resources`;

    return `<header>
  <h1>${esc(model.label)}</h1>
  ${model.description ? `<p class="description">${esc(model.description)}</p>` : ''}
  <div class="facts">${factsHtml}<span class="fact muted">${esc(counts)}</span></div>
</header>
<section class="summary"><h2>This flow</h2>${explanation}</section>
${opts.issues ? renderChecksHtml(opts.issues, opts) : ''}
${opts.compare ? renderCompareHtml(opts.compare, opts) : ''}
${renderViewsHtml(model, opts)}`;
}

// ---------- compare with another version ----------

function countsText(counts) {
    return `${counts.added} added · ${counts.removed} removed · ${counts.changed} changed · ${counts.unchanged} unchanged`;
}

function diffLinesHtml(lines) {
    const changed = lines.filter(l => l.op !== ' ');
    const same = lines.length - changed.length;
    const body = changed.map(l => `<div class="dl ${l.op === '+' ? 'dl-add' : 'dl-del'}"><span class="dl-op">${l.op}</span>${esc(l.text)}</div>`).join('');
    return `<div class="dlist">${body}${same ? `<div class="dl muted">${same} unchanged line${same === 1 ? '' : 's'}</div>` : ''}</div>`;
}

/**
 * cmp: { diff (flowDiff.diffModels), beforeLabel, afterLabel, afterIsFile }
 * opts.standalone: saved HTML file (no buttons, #fragment links)
 */
function renderCompareHtml(cmp, opts = {}) {
    const { diff } = cmp;
    const buttons = opts.standalone ? '' : `
    <span class="compare-actions">
      <button data-action="compareXmlDiff" title="Open VS Code's side-by-side diff of the two XML files">Side-by-side XML diff</button>
      <button data-action="compareChange" title="Compare with a different version or file">Change…</button>
      <button data-action="compareClose" title="Stop comparing">Close</button>
    </span>`;
    let html = `<section class="compare">
  <div class="compare-head">
    <h2>Changes</h2>
    <span>from <strong>${esc(cmp.beforeLabel)}</strong> to <strong>${esc(cmp.afterLabel)}</strong></span>
    <span class="muted">${esc(countsText(diff.counts))}</span>${buttons}
  </div>`;

    if (diff.facts.length) {
        html += `<table class="facts-diff"><thead><tr><th>Property</th><th>Before</th><th>After</th></tr></thead><tbody>`
            + diff.facts.map(f => `<tr><td>${esc(f.label)}</td><td class="dl-del">${esc(f.before || '(none)')}</td><td class="dl-add">${esc(f.after || '(none)')}</td></tr>`).join('')
            + '</tbody></table>';
    }

    const changed = diff.elements.filter(e => e.change !== 'unchanged');
    if (!changed.length) {
        html += `<p class="muted">No element differences.${diff.facts.length ? '' : ' The two versions are the same.'}</p></section>`;
        return html;
    }
    html += '<table class="changes"><thead><tr><th>Element</th><th>Type</th><th>Change</th><th>Details</th></tr></thead><tbody>';
    for (const e of changed) {
        // The main table below is always this file: names jump to their row there
        // (the main table's names open the XML). Removed elements have no row; their
        // old content is in the "-" lines.
        const linkable = cmp.afterIsFile && e.change !== 'removed';
        let name = linkable ? gotoLink(e.name, opts) : esc(e.name);
        if (e.change === 'removed' && cmp.afterIsFile) name += '<br><span class="small">not in this file</span>';
        const type = e.typeBefore && e.typeBefore !== e.type ? `${esc(e.typeBefore)} → ${esc(e.type)}` : esc(e.type);
        html += `<tr><td class="el">${name}</td><td><span class="type-tag type-${esc(e.type)}">${type}</span></td>`
            + `<td><span class="badge chg-${e.change}">${e.change}</span></td><td>${diffLinesHtml(e.lines)}</td></tr>`;
    }
    return html + '</tbody></table></section>';
}

function renderCompareMarkdown(cmp) {
    const { diff } = cmp;
    let md = `## Changes from ${cmp.beforeLabel} to ${cmp.afterLabel}\n\n${countsText(diff.counts)}\n\n`;
    if (diff.facts.length) {
        md += '|Property|Before|After|\n|-|-|-|\n'
            + diff.facts.map(f => `|${mdCell(f.label)}|${mdCell(f.before || '(none)')}|${mdCell(f.after || '(none)')}|`).join('\n') + '\n\n';
    }
    const changed = diff.elements.filter(e => e.change !== 'unchanged');
    if (!changed.length) return md + 'No element differences.\n';
    for (const e of changed) {
        md += `### ${e.name} (${e.typeBefore && e.typeBefore !== e.type ? `${e.typeBefore} → ${e.type}` : e.type}): ${e.change}\n\n`
            + '```diff\n' + e.lines.filter(l => l.op !== ' ').map(l => `${l.op} ${l.text}`).join('\n') + '\n```\n\n';
    }
    return md;
}

// ---------- standalone HTML file ----------

// Stand-ins for the VS Code theme variables preview.css uses: light by default,
// dark when the reader's system is dark.
const EXPORT_THEME = `
:root {
  --vscode-foreground: #1f1f1f; --vscode-editor-background: #ffffff;
  --vscode-font-family: "Segoe UI", system-ui, -apple-system, sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, "Courier New", monospace;
  --vscode-descriptionForeground: #616161; --vscode-panel-border: #d4d4d4;
  --vscode-textLink-foreground: #005fb8; --vscode-textLink-activeForeground: #004a8f;
  --vscode-badge-background: #e0e0e0; --vscode-badge-foreground: #333333;
  --vscode-charts-red: #c72e0f; --vscode-charts-blue: #1a6fd6; --vscode-charts-yellow: #c59a00;
  --vscode-charts-orange: #d18616; --vscode-charts-green: #6cbf68; --vscode-charts-purple: #7a4bb0;
  --vscode-textCodeBlock-background: #f2f2f2; --vscode-editorWidget-background: #f8f8f8;
  --vscode-editorWarning-foreground: #9a6b00; --vscode-editor-findMatchHighlightBackground: #f8d97a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --vscode-foreground: #cccccc; --vscode-editor-background: #1f1f1f;
    --vscode-descriptionForeground: #9d9d9d; --vscode-panel-border: #3c3c3c;
    --vscode-textLink-foreground: #4daafc; --vscode-textLink-activeForeground: #7cc0ff;
    --vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8;
    --vscode-charts-red: #f14c4c; --vscode-charts-blue: #3794ff; --vscode-charts-yellow: #cca700;
    --vscode-charts-orange: #d18616; --vscode-charts-green: #89d185; --vscode-charts-purple: #b180d7;
    --vscode-textCodeBlock-background: #2b2b2b; --vscode-editorWidget-background: #252526;
    --vscode-editorWarning-foreground: #cca700; --vscode-editor-findMatchHighlightBackground: #623315;
  }
}`;

const EXPORT_OVERRIDES = `
body { padding: 8px 24px 32px; }
#flowTable th { top: 0; }
/* #fragment jumps: land below the sticky column header, not under it */
#flowTable td.el, #flowTable td.next { scroll-margin-top: 48px; }
#flowTable td.el:target, #flowTable td.next:target { animation: flash 1.6s ease-out; }
footer { margin-top: 16px; font-size: 0.85em; }
@media print {
  #flowTable th { position: static; }
  #flowTable tr { break-inside: avoid; }
  a { color: inherit; }
}`;

// One self-contained file: styles inline, no scripts, links between rows work offline.
function renderStandaloneHtml(model, previewCss, generatedFrom, opts = {}) {
    const footer = `Generated by Salesforce Flow Table Preview${generatedFrom ? ' from ' + esc(generatedFrom) : ''} on ${esc(new Date().toLocaleString())}.`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Flow: ${esc(model.label)}</title>
<style>${EXPORT_THEME}
${previewCss}
${EXPORT_OVERRIDES}</style>
</head>
<body>
<main id="content">
${renderBodyHtml(model, { ...opts, standalone: true })}
</main>
<footer class="muted">${footer}</footer>
</body>
</html>
`;
}

// ---------- Markdown ----------

function mdCell(text) {
    return String(text ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

// Lines inside one Markdown table cell: <br> renders each on its own line in
// GitHub, VS Code and most Markdown viewers.
const MD_LINE_BREAK = '<br>';

function mdCondition(b) {
    const parts = [b.label];
    if (b.logic) parts.push(`Logic: ${b.logic}`);
    return parts.concat(b.conditions).filter(Boolean).map(mdCell).join(MD_LINE_BREAK);
}

function renderMarkdownTable(model) {
    let md = `|${COLUMNS.join('|')}|\n|-|-|-|-|-|\n`;
    for (const el of model.elements) {
        const name = [el.name, el.label ? `(${el.label})` : '', el.description ? `/ ${el.description}` : ''].filter(Boolean).join(' ');
        const branches = el.branches.length ? el.branches : [{ label: '', logic: '', conditions: [], next: '' }];
        branches.forEach((b, i) => {
            const next = b.next ? b.next + (b.nextNote ? ` (${b.nextNote})` : '') : '';
            const lead = i === 0
                ? `|${mdCell(name)}|${mdCell(el.type)}|${el.parameters.map(mdCell).join(MD_LINE_BREAK)}|`
                : '||||';
            md += `${lead}${mdCondition(b)}|${mdCell(next)}|\n`;
        });
    }
    return md;
}

function renderHeaderMarkdown(model) {
    let md = `# Flow: ${model.label}\n\n`;
    if (model.description) md += `Description: ${model.description}\n\n`;
    const facts = [
        ['API name', model.apiName], ['Type', model.processType], ['Trigger', model.triggerType],
        ['Object', model.object], ['Status', model.status], ['API version', model.apiVersion]
    ].filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
    if (facts.length) md += facts.join('\n') + '\n\n';
    return md;
}

// opts.compare: include the changes from the compared version
function renderMarkdown(model, opts = {}) {
    return renderHeaderMarkdown(model)
        + '## This flow\n\n'
        + (model.explanation.length ? model.explanation.map(l => `- ${l}`).join('\n') : '- (no record changes, actions or screens found)')
        + '\n\n'
        + renderChecksMarkdown(opts.issues)
        + (opts.compare ? renderCompareMarkdown(opts.compare) : '')
        + '## Step by step\n\n'
        + renderMarkdownTable(model);
}

// What AI agents read: the same Markdown plus notes on how to read the table.
function renderAiSummary(model, sourcePath, opts = {}) {
    return renderMarkdown(model, opts)
        + '\n## How to read the table\n\n'
        + '- Rows are in execution order, following every branch from Start; elements no path reaches come next, then resources (variables, formulas, constants, text templates, choices).\n'
        + '- An element with several outcomes has one row per outcome: Condition is the outcome, Condition next element is where it goes.\n'
        + '- In conditions, "1. Field = value" lines are numbered so the decision logic (e.g. "1 AND (2 OR 3)") can refer to them.\n'
        + (opts.compare ? '- "Changes" lists what differs from the compared version: "-" lines are only in the older version, "+" lines only in the newer one.\n' : '')
        + (opts.issues && opts.issues.length ? '- "Checks" are quick best-practice findings (rule names as in Salesforce Code Analyzer).\n' : '')
        + (sourcePath ? `- Source metadata: ${sourcePath}\n` : '');
}

module.exports = {
    renderBodyHtml, renderTableHtml, renderMarkdown, renderMarkdownTable, renderAiSummary, renderStandaloneHtml,
    renderCompareHtml, renderCompareMarkdown, renderChecksHtml, renderChecksMarkdown,
    rainbow, esc, anchorId, branchId
};
