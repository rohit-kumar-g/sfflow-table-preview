'use strict';
const { DIFF_MAX_CELLS } = require('./limits');
// Compares two flow models (from src/flowModel.js) element by element.
// Elements are matched by API name; each element is turned into canonical text
// lines (type, label, parameters, outcomes) and the lines are diffed, so the
// result says what changed inside an element, not just that it changed.

// Tooling API Flow.Metadata (JSON) -> the shape parseFlowXml returns for the same flow:
// nulls, empty strings, empty arrays and empty objects dropped; booleans and numbers as text.
function normalizeToolingMetadata(value) {
    if (value === null || value === undefined || value === '') return undefined;
    if (Array.isArray(value)) {
        const items = value.map(normalizeToolingMetadata).filter(v => v !== undefined);
        return items.length ? items : undefined;
    }
    if (typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) {
            const v = normalizeToolingMetadata(value[key]);
            if (v !== undefined) out[key] = v;
        }
        return Object.keys(out).length ? out : undefined;
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    return value;
}

// Same value written two ways by the XML file and the Tooling API JSON
// (100000.0 vs 100000, 62.0 vs 62) must not count as a change.
function canonical(text) {
    const s = String(text);
    const indent = /^ */.exec(s)[0]; // keeps conditions indented under their outcome
    return indent + s.replace(/(\d+)\.0+(?!\d)/g, '$1').replace(/\s+/g, ' ').trim();
}

function elementLines(el) {
    const lines = [];
    if (el.label) lines.push(`Label: ${el.label}`);
    if (el.description) lines.push(`Description: ${el.description}`);
    el.parameters.forEach(p => lines.push(p));
    el.branches.forEach(b => {
        const head = [b.label, b.logic ? `[${b.logic}]` : ''].filter(Boolean).join(' ');
        lines.push(`→ ${head || 'next'}: ${b.next || '(end)'}${b.nextNote ? ` (${b.nextNote})` : ''}`);
        b.conditions.forEach(c => lines.push(`    ${c}`));
    });
    return lines.map(canonical);
}

// Line diff (LCS). Returns [{ op: ' ' | '-' | '+', text }].
function diffLines(before, after) {
    const n = before.length, m = after.length;
    if (n * m > DIFF_MAX_CELLS) {
        // very large element: a set comparison (linear) instead of the quadratic LCS table
        const inAfter = new Set(after), inBefore = new Set(before);
        return [
            ...before.map(text => ({ op: inAfter.has(text) ? ' ' : '-', text })),
            ...after.filter(text => !inBefore.has(text)).map(text => ({ op: '+', text }))
        ];
    }
    const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (before[i] === after[j]) { out.push({ op: ' ', text: before[i] }); i++; j++; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ op: '-', text: before[i] }); i++; }
        else { out.push({ op: '+', text: after[j] }); j++; }
    }
    while (i < n) out.push({ op: '-', text: before[i++] });
    while (j < m) out.push({ op: '+', text: after[j++] });
    return out;
}

const FACTS = [
    ['label', 'Label'], ['description', 'Description'], ['processType', 'Type'], ['triggerType', 'Trigger'],
    ['object', 'Object'], ['status', 'Status'], ['apiVersion', 'API version']
];

/**
 * @returns {{ facts: {label, before, after}[], elements: object[], counts: {added, removed, changed, unchanged} }}
 * elements: in the "after" flow's execution order, removed ones after them; each has
 *   { name, type, typeBefore, change: 'added'|'removed'|'changed'|'unchanged', lines: [{op,text}] }
 */
function diffModels(before, after) {
    const facts = FACTS
        .map(([key, label]) => ({ label, before: canonical(before[key] ?? ''), after: canonical(after[key] ?? '') }))
        .filter(f => f.before !== f.after);

    const beforeByName = new Map(before.elements.map(e => [e.name, e]));
    const afterNames = new Set(after.elements.map(e => e.name));
    const elements = [];

    for (const el of after.elements) {
        const old = beforeByName.get(el.name);
        if (!old) {
            elements.push({ name: el.name, type: el.type, kind: el.kind, change: 'added', lines: elementLines(el).map(text => ({ op: '+', text })) });
            continue;
        }
        const a = elementLines(old), b = elementLines(el);
        const typeChanged = old.type !== el.type;
        const same = !typeChanged && a.length === b.length && a.every((line, i) => line === b[i]);
        const lines = diffLines(a, b);
        if (typeChanged) lines.unshift({ op: '-', text: `Type: ${old.type}` }, { op: '+', text: `Type: ${el.type}` });
        elements.push({ name: el.name, type: el.type, typeBefore: old.type, kind: el.kind, change: same ? 'unchanged' : 'changed', lines });
    }
    for (const old of before.elements) {
        if (!afterNames.has(old.name)) {
            elements.push({ name: old.name, type: old.type, kind: old.kind, change: 'removed', lines: elementLines(old).map(text => ({ op: '-', text })) });
        }
    }

    const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
    elements.forEach(e => { counts[e.change]++; });
    return { facts, elements, counts };
}

module.exports = { normalizeToolingMetadata, diffModels, diffLines, elementLines, canonical };
