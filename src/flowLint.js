'use strict';
// Lightweight best-practice checks: pure JavaScript, no external tools, milliseconds.
// Rule names match Salesforce Code Analyzer's flow rules where they overlap, so results
// are recognisable; Code Analyzer ("SFDX: Scan Current File with Code Analyzer") remains
// the full scan with more rules.
//
// checkFlow(model, definition, xmlText) -> [{ rule, severity: 'warning'|'info', element, message }]
// element is an element name, or null for the whole flow.

const { CHECKS_MS } = require('./limits');

const RECORD_OPS = {
    recordCreate: 'Create Records', recordUpdate: 'Update Records',
    recordDelete: 'Delete Records', recordLookup: 'Get Records'
};
const FAULT_CAPABLE = new Set(['recordCreate', 'recordUpdate', 'recordDelete', 'recordLookup', 'actionCall', 'apexPluginCall']);

// A Salesforce record id: 15 or 18 letters/digits, 3-char key prefix, 2-char pod, then "0".
// Must also mix letters and digits, so plain words and numbers don't match.
const ID_RE = /^[a-zA-Z0-9]{5}0[a-zA-Z0-9]{9}(?:[a-zA-Z0-9]{3})?$/;
const QUOTED_ID_RE = /['"]([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)['"]/g;
function looksLikeId(s) {
    return ID_RE.test(s) && /\d.*\d.*\d/.test(s) && /[a-zA-Z]/.test(s);
}

const ELEMENT_LISTS = [
    'recordLookups', 'recordCreates', 'recordUpdates', 'recordDeletes', 'recordRollbacks', 'assignments',
    'decisions', 'screens', 'loops', 'steps', 'subflows', 'actionCalls', 'apexPluginCalls', 'collectionProcessors',
    'transforms', 'waits', 'customErrors', 'dynamicChoiceSets', 'variables', 'textTemplates', 'formulas',
    'constants', 'choices'
];

function asArray(v) {
    return v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v];
}

// Every string inside an object (values only), without recursion limits issues: iterative.
function strings(root) {
    const out = [];
    const stack = [root];
    while (stack.length) {
        const v = stack.pop();
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) stack.push(...v);
        else if (v && typeof v === 'object') stack.push(...Object.values(v));
    }
    return out;
}

// Elements reachable from `from` following every outcome, never entering `stop`.
function reach(byName, from, stop) {
    const seen = new Set();
    const queue = from ? [from] : [];
    for (let head = 0; head < queue.length; head++) { // index pointer: shift() would be quadratic
        const name = queue[head];
        if (name === stop || seen.has(name) || !byName.has(name)) continue;
        seen.add(name);
        for (const b of byName.get(name).branches) if (b.next) queue.push(b.next);
    }
    return seen;
}

function checkFlow(model, definition, xmlText) {
    const started = Date.now();
    const issues = [];
    const add = (rule, severity, element, message) => issues.push({ rule, severity, element, message });
    const overBudget = () => Date.now() - started > CHECKS_MS;
    const byName = new Map(model.elements.map(e => [e.name, e]));

    // DbInLoop: record operations that run once per loop item
    for (const loop of model.elements.filter(e => e.type === 'loop')) {
        if (overBudget()) break;
        const nextValue = loop.branches.find(b => b.label === 'Next value');
        const noMore = loop.branches.find(b => b.label === 'No more values');
        const body = reach(byName, nextValue && nextValue.next, loop.name);
        const after = reach(byName, noMore && noMore.next, loop.name);
        for (const name of body) {
            if (after.has(name)) continue; // also runs after the loop: not clearly inside it
            const el = byName.get(name);
            if (RECORD_OPS[el.type]) {
                add('DbInLoop', 'warning', name,
                    `${RECORD_OPS[el.type]} inside loop ${loop.name}: it runs once per item and can hit governor limits. `
                    + (el.type === 'recordLookup'
                        ? 'Query once before the loop and work on the collection.'
                        : 'Collect the records in the loop and save them once after it.'));
            }
        }
    }

    // MissingFaultHandler: operations that can fail without a fault path
    for (const el of model.elements) {
        if (FAULT_CAPABLE.has(el.type) && el.reached && !el.branches.some(b => b.label === 'fault')) {
            add('MissingFaultHandler', 'info', el.name, 'No fault path: if this fails, the user gets a generic error and the transaction rolls back.');
        }
    }

    // UnreachableElement: steps no path from Start reaches
    for (const el of model.elements) {
        if (el.kind === 'step' && el.name !== 'Start' && !el.reached) {
            add('UnreachableElement', 'warning', el.name, 'No path from Start reaches this element, so it never runs.');
        }
    }

    // HardcodedId: record ids written into values, formulas or text
    if (definition && !overBudget()) {
        const scan = (owner, node) => {
            const found = new Set();
            for (const s of strings(node)) {
                const t = s.trim();
                if (looksLikeId(t)) found.add(t);
                for (const m of t.matchAll(QUOTED_ID_RE)) if (looksLikeId(m[1])) found.add(m[1]);
            }
            for (const id of found) {
                add('HardcodedId', 'warning', owner, `Hard-coded record id ${id}: ids differ between orgs (sandbox vs production). Look the record up, or use a custom setting/metadata.`);
            }
        };
        if (definition.start) scan('Start', definition.start);
        for (const list of ELEMENT_LISTS) {
            for (const raw of asArray(definition[list])) {
                if (raw && raw.name && byName.has(raw.name)) scan(raw.name, raw);
            }
        }
    }

    // UnusedResource: variables, formulas, constants, text templates, choices never referenced
    if (xmlText && !overBudget()) {
        // count every word-like token once: linear in the file size
        const counts = new Map();
        for (const m of xmlText.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
        for (const el of model.elements) {
            if (el.kind !== 'resource') continue;
            const raw = definition && asArray(definition[el.type + 's']).find(r => r && r.name === el.name);
            if (raw && (raw.isInput === 'true' || raw.isOutput === 'true')) continue; // used from outside the flow
            if ((counts.get(el.name) || 0) <= 1) { // only its own <name>
                add('UnusedResource', 'info', el.name, 'This resource is never used in the flow.');
            }
        }
    }

    // MissingDescription: flows without a description are harder to maintain
    if (!model.description) add('MissingDescription', 'info', null, 'The flow has no description.');

    if (overBudget()) add('ChecksStopped', 'info', null, `Checks stopped after ${CHECKS_MS} ms; this flow is very large, so some checks were skipped.`);
    return issues;
}

module.exports = { checkFlow, looksLikeId };
