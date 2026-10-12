'use strict';
// Plain Node tests for the parser and renderers (no VS Code needed).
//   node test/run.js                      fixtures only
//   node test/run.js <folder> [<folder>]  also parse every *.flow-meta.xml under those folders (read-only)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseFlowXml, flowApiName, looksLikeFlow } = require('../src/flowXml');
const { buildFlowModel } = require('../src/flowModel');
const render = require('../src/render');
const { normalizeToolingMetadata, diffModels, diffLines, canonical } = require('../src/flowDiff');
const complex = require('./org-flows/complexFlow');
const version = v => buildFlowModel(parseFlowXml(complex.build(v)), complex.API_NAME);

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log('  ok   ' + name);
    } catch (e) {
        failures++;
        console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e));
    }
}

function load(file) {
    const xml = fs.readFileSync(file, 'utf8');
    return buildFlowModel(parseFlowXml(xml), flowApiName(file));
}

// every Markdown table row must have exactly 5 cells (escaped \| does not count)
function checkMarkdownTable(md) {
    md.split('\n').filter(l => l.startsWith('|')).forEach(line => {
        const pipes = (line.replace(/\\\|/g, '').match(/\|/g) || []).length;
        assert.strictEqual(pipes, 6, 'row does not have 5 cells: ' + line);
    });
}

function checkCommon(model) {
    const md = render.renderMarkdown(model);
    const html = render.renderBodyHtml(model);
    checkMarkdownTable(md);
    assert(!/\bundefined\b/.test(md), 'Markdown contains "undefined":\n' + md.split('\n').filter(l => /\bundefined\b/.test(l)).join('\n'));
    assert(!/\[object Object\]/.test(md), 'Markdown contains [object Object]');
    assert(!/<script/i.test(html), 'HTML contains a script tag');
    assert(model.elements[0].name === 'Start', 'first row is Start');
    return { md, html };
}

console.log('fixtures');
const sinkFile = path.join(__dirname, 'fixtures', 'Kitchen_Sink.flow-meta.xml');
const sink = load(sinkFile);
const byName = n => sink.elements.find(e => e.name === n);

test('header facts', () => {
    assert.strictEqual(sink.apiName, 'Kitchen_Sink');
    assert.strictEqual(sink.label, 'Kitchen Sink');
    assert.strictEqual(sink.processType, 'AutoLaunchedFlow');
    assert.strictEqual(sink.object, 'Opportunity');
});

test('single-entry lists are arrays (one recordLookup, one rule, one filter)', () => {
    assert.strictEqual(byName('Get_Accounts').type, 'recordLookup');
    assert(byName('Get_Accounts').parameters.includes('1. Id = $Record.AccountId'));
    assert.strictEqual(byName('Check_Amount').branches.length, 2);
});

test('execution order follows branches from Start', () => {
    const order = sink.elements.map(e => e.name);
    assert(order.indexOf('Get_Accounts') < order.indexOf('Check_Amount'));
    assert(order.indexOf('Check_Amount') < order.indexOf('Loop_Accounts'));
    assert(order.indexOf('Loop_Accounts') < order.indexOf('Set_Rating'));
});

test('unreached step goes after reached steps, resources last', () => {
    const orphan = byName('Orphan_Screen');
    assert.strictEqual(orphan.reached, false);
    const order = sink.elements.map(e => e.name);
    assert(order.indexOf('Orphan_Screen') > order.indexOf('Create_Task'));
    assert(order.indexOf('accountsToUpdate') > order.indexOf('Orphan_Screen'));
    assert.strictEqual(byName('accountsToUpdate').kind, 'resource');
});

test('start: trigger, filters and scheduled path', () => {
    const start = byName('Start');
    assert(start.parameters.includes('Type = RecordAfterSave CreateAndUpdate'));
    assert(start.parameters.includes('1. StageName = Closed Won'));
    assert.strictEqual(start.branches.length, 2);
    assert.strictEqual(start.branches[1].next, 'Notify_Owner');
    assert(/3 Days CloseDate/.test(start.branches[1].label));
});

test('decision: rules, logic, operators, default outcome', () => {
    const d = byName('Check_Amount');
    assert.strictEqual(d.branches[0].logic, '1 AND (2 OR (3 AND 4))');
    assert(d.branches[0].conditions.includes('3. $Record.LeadSource NOT = Web'));
    assert(d.branches[0].conditions.includes('1. $Record.Amount GreaterThan 100000.0'));
    assert.strictEqual(d.branches[1].label, 'Default: Small Deal');
    assert.strictEqual(d.branches[1].next, 'Sort_Accounts');
});

test('loop, wait, fault paths', () => {
    const loop = byName('Loop_Accounts');
    assert.deepStrictEqual(loop.branches.map(b => b.next), ['Set_Rating', 'Update_Accounts']);
    const wait = byName('Wait_For_Payment');
    assert.strictEqual(wait.branches[0].next, 'Create_Task');
    assert.strictEqual(wait.branches[1].label, 'Default: Timed out');
    assert(byName('Get_Accounts').branches.some(b => b.label === 'fault' && b.next === 'Show_Error'));
});

test('incoming links ("From") name the exact outcome', () => {
    const from = n => byName(n).from.map(f => `${f.name}#${f.branch}:${f.label}`).sort();
    assert.deepStrictEqual(from('Show_Error'), ['Get_Accounts#1:fault', 'Update_Accounts#1:fault']);
    assert.deepStrictEqual(from('Loop_Accounts'), ['Check_Amount#0:Big Deal (Big_Deal)', 'Set_Rating#0:success']);
});

test('webview links never use href="#" (VS Code scrolls to top on it)', () => {
    const html = render.renderBodyHtml(sink, {
        compare: { diff: diffModels(version(2), version(3)), beforeLabel: 'a', afterLabel: 'b', afterIsFile: true }
    });
    assert(!/href="#/.test(html), 'found an href="#..." link in webview HTML');
    // "From" on Show_Error jumps to the fault row of Get_Accounts, which carries that id
    assert(html.includes('data-target="br-Get_Accounts-1">Get_Accounts <span class="small">(fault)</span></a>'));
    assert(html.includes('<td class="next" id="br-Get_Accounts-1">'));
    // saved HTML keeps real #fragment links
    const page = render.renderStandaloneHtml(sink, '', '');
    assert(page.includes('<a href="#br-Get_Accounts-1" class="goto">'));
});

test('screens strip HTML and include nested section fields', () => {
    const p = byName('Orphan_Screen').parameters;
    assert(p.some(l => l.startsWith('Hello there')), p.join(' | '));
    assert(p.some(l => /Amount Number InputField/.test(l)), p.join(' | '));
});

test('other element types', () => {
    assert(byName('Sort_Accounts').parameters.includes('Sort = Name Asc'));
    assert(byName('Map_Accounts').parameters.includes('Map: Get_Accounts[$EachItem].Name to LastName'));
    assert(byName('Call_Child_Flow').parameters.includes('Flow = Child_Flow'));
    assert(byName('Create_Task').parameters.includes('Subject = Follow up'));
    assert(byName('Notify_Owner').parameters.includes('Component Name = emailSimple'));
    assert(byName('Show_Error').parameters[0].startsWith('Page error = Something failed'));
    assert(byName('accountsToUpdate').parameters[0] === 'Type = Collection of SObject (Account)');
    assert(byName('DaysOpen').parameters.includes('Expression = TODAY() - DATEVALUE({!$Record.CreatedDate})'));
});

test('explanation sentences', () => {
    const text = sink.explanation.join('\n');
    assert(/queries Account at the start/.test(text), text);
    assert(/updates accountsToUpdate/.test(text), text);
    assert(/calls subflow Child_Flow/.test(text), text);
    assert(/calls action Notify Owner at the scheduled path Three Days Later/.test(text), text);
});

test('renderers: markdown cells, escaping, rainbow', () => {
    const { md, html } = checkCommon(sink);
    assert(md.includes('New \\| Upsell'), 'pipe in value is escaped in Markdown');
    assert(html.includes('&lt;p&gt;Deal'), 'text template HTML is escaped in the preview');
    assert(html.includes('class="lvl lvl-1"'), 'nested brackets coloured');
    assert(render.rainbow('((1 AND 2) OR (3 AND (4 OR 5)))').includes('lvl-2'), 'third level coloured');
    assert(html.includes('data-target="el-Show_Error"'), 'next-element links');
    assert(render.renderAiSummary(sink, 'force-app/x.flow-meta.xml').includes('Source metadata: force-app/x.flow-meta.xml'));
});

test('standalone HTML: escaped, links by #fragment, no script', () => {
    const page = render.renderStandaloneHtml(sink, '/* css */', 'x.flow-meta.xml');
    assert(page.includes('href="#el-Loop_Accounts" class="goto"'));
    assert(!page.includes('data-target=') && !page.includes('class="reveal"'));
    assert(page.includes('&lt;p&gt;Deal'), 'text template HTML stays escaped');
    assert(!/<script/i.test(page));
    // webview HTML still uses script-driven links
    assert(render.renderBodyHtml(sink).includes('data-target="el-Loop_Accounts"'));
});

// ---- compare ----

test('normalize Tooling API JSON: nulls/empties dropped, booleans and numbers as text', () => {
    const json = { a: null, b: [], c: {}, d: '', e: true, f: 0, g: 100000, h: [{ x: null }, { y: false }], i: { stringValue: 'S', numberValue: null } };
    assert.deepStrictEqual(normalizeToolingMetadata(json), { e: 'true', f: '0', g: '100000', h: [{ y: 'false' }], i: { stringValue: 'S' } });
});

test('canonical numbers: 100000.0 == 100000, 62.0 == 62', () => {
    assert.strictEqual(canonical('Amount > 100000.0'), canonical('Amount > 100000'));
    assert.strictEqual(canonical('62.0'), '62');
    assert.strictEqual(canonical('1.5'), '1.5');
});

test('line diff keeps order and marks changes', () => {
    assert.deepStrictEqual(diffLines(['a', 'b', 'c'], ['a', 'x', 'c']).map(l => l.op + l.text), [' a', '-b', '+x', ' c']);
});

test('same flow compared with itself has no differences', () => {
    const r = diffModels(version(3), version(3));
    assert.deepStrictEqual([r.counts.added, r.counts.removed, r.counts.changed, r.facts.length], [0, 0, 0, 0]);
});

test('XML vs Tooling JSON of the same version: no false differences', () => {
    // simulate the Tooling API shape: every field present, real booleans/numbers
    const toJsonShape = o => Array.isArray(o) ? o.map(toJsonShape)
        : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toJsonShape(v)]).concat([['extraNull', null]]))
            : o === 'true' ? true : o === 'false' ? false : /^\d+\.0$/.test(o) ? Number(o) : o;
    const fromJson = buildFlowModel(normalizeToolingMetadata(toJsonShape(parseFlowXml(complex.build(4)))), complex.API_NAME);
    const r = diffModels(fromJson, version(4));
    assert.deepStrictEqual(r.elements.filter(e => e.change !== 'unchanged').map(e => e.name), []);
});

test('v1 -> v2: logic, value and new action', () => {
    const r = diffModels(version(1), version(2));
    const el = n => r.elements.find(e => e.name === n);
    assert.strictEqual(el('Notify_Owner').change, 'added');
    const decision = el('Check_Account').lines.filter(l => l.op !== ' ').map(l => l.op + l.text);
    assert(decision.includes('-→ Is Hot (Is_Hot) [1 AND (2 OR 3)]: Get_Open_Opps'), decision.join('\n'));
    assert(decision.includes('+→ Is Hot (Is_Hot) [1 AND (2 OR 3 OR 4)]: Get_Open_Opps'), decision.join('\n'));
    assert(decision.includes('+    4. Get_Account.Industry = Technology'), decision.join('\n'));
    assert(el('Set_Next_Step').lines.some(l => l.op === '+' && l.text.includes('Exec review - priority')));
});

test('v3 -> v4: flow facts and constant value', () => {
    const r = diffModels(version(3), version(4));
    assert.deepStrictEqual(r.facts.map(f => f.label), ['Label', 'Description']);
    const k = r.elements.find(e => e.name === 'HighValueThreshold').lines.filter(l => l.op !== ' ').map(l => l.op + l.text);
    assert.deepStrictEqual(k, ['-Value = 1000000', '+Value = 2500000']);
});

test('compare renders in HTML (escaped) and Markdown (diff blocks)', () => {
    const cmp = { diff: diffModels(version(2), version(3)), beforeLabel: 'p2 · v2 (Obsolete)', afterLabel: 'this file', afterIsFile: true };
    const changes = new Map(cmp.diff.elements.map(e => [e.name, e.change]));
    const html = render.renderBodyHtml(version(3), { compare: cmp, changes, compareLabel: cmp.beforeLabel });
    assert(html.includes('class="badge chg-removed">removed'));
    assert(html.includes('data-change="added"') && html.includes('data-action="compareXmlDiff"'));
    assert(html.includes('p2 · v2 (Obsolete)'));
    const md = render.renderMarkdown(version(3), { compare: cmp });
    assert(md.includes('## Changes from p2 · v2 (Obsolete) to this file'));
    assert(md.includes('### Update_Account_Description (recordUpdate): removed'));
    assert(md.includes('```diff\n- Label: Update Account Description'));
    checkMarkdownTable(md.substring(md.indexOf('## Step by step')));
    const page = render.renderStandaloneHtml(version(3), '', 'x', { compare: cmp, changes });
    assert(page.includes('class="compare"') && !page.includes('data-action='), 'saved HTML has the changes but no buttons');
});

test('findElementRange: whole top-level block, not nested names', () => {
    const { findElementRange } = require('../src/flowXml');
    const xml = fs.readFileSync(sinkFile, 'utf8');
    const block = n => { const r = findElementRange(xml, n); return r && xml.substring(r.start, r.end); };
    assert(block('Check_Amount').startsWith('<decisions>') && block('Check_Amount').endsWith('</decisions>'));
    assert(block('Check_Amount').includes('<name>Big_Deal</name>'), 'rule inside the decision block');
    assert.strictEqual(findElementRange(xml, 'Big_Deal'), null, 'a rule name is not an element');
    assert.strictEqual(findElementRange(xml, 'Amount_Input'), null, 'a nested screen field is not an element');
    assert(block('Start').startsWith('<start>') && block('Start').endsWith('</start>'));
    assert(block('accountsToUpdate').startsWith('<variables>'));
    // a rule named like another element must not hijack it
    const tricky = xml.replace('<name>Big_Deal</name>', '<name>Loop_Accounts</name>');
    const r = findElementRange(tricky, 'Loop_Accounts');
    assert(tricky.substring(r.start, r.end).startsWith('<loops>'));
    const legacy = '<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><startElementReference>Ask</startElementReference></Flow>';
    const s = findElementRange(legacy, 'Start');
    assert.strictEqual(legacy.substring(s.start, s.end), '<startElementReference>Ask</startElementReference>');
});

test('Changes table: names jump to the main table row; only the main table opens the XML', () => {
    const cmp = { diff: diffModels(version(2), version(3)), beforeLabel: 'p2 · v2', afterLabel: 'this file', afterIsFile: true };
    const html = render.renderCompareHtml(cmp, {});
    assert(html.includes('<a class="goto" role="link" tabindex="0" data-target="el-Filter_Big_Opps">Filter_Big_Opps</a>'), 'added -> its row');
    assert(html.includes('<a class="goto" role="link" tabindex="0" data-target="el-Check_Account">Check_Account</a>'), 'changed -> its row');
    assert(/>Update_Account_Description<br><span class="small">not in this file<\/span>/.test(html), 'removed: plain name');
    assert(!html.includes('class="reveal"'), 'no XML links in the Changes table');
    assert(!html.includes('onlyChanged') && !html.includes('type="checkbox"'), 'no "Only changed rows" checkbox');
    const body = render.renderBodyHtml(version(3), { compare: cmp });
    assert(body.includes('<a class="reveal" role="link" tabindex="0" data-name="Filter_Big_Opps"'), 'main table names open the XML');
    const twoVersions = render.renderCompareHtml({ ...cmp, afterIsFile: false }, {});
    assert(!twoVersions.includes('class="goto'), 'comparing two org versions: no rows to jump to');
});

// ---- checks ----
const { checkFlow, looksLikeId } = require('../src/flowLint');
const lint = xml => { const d = parseFlowXml(xml); const m = buildFlowModel(d, 'T'); return checkFlow(m, d, xml); };
const flowXml = body => `<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><label>T</label><description>d</description><processType>AutoLaunchedFlow</processType>${body}</Flow>`;

test('checks: DbInLoop for record operations inside the loop body only', () => {
    // Start -> L; body: Q -> U -> L; after the loop: After -> U (so U also runs after the loop)
    const xml = flowXml(`
      <start><connector><targetReference>L</targetReference></connector></start>
      <loops><name>L</name><label>L</label><collectionReference>c</collectionReference>
        <nextValueConnector><targetReference>Q</targetReference></nextValueConnector>
        <noMoreValuesConnector><targetReference>After</targetReference></noMoreValuesConnector></loops>
      <recordLookups><name>Q</name><label>Q</label><object>Account</object><connector><targetReference>U</targetReference></connector><faultConnector><targetReference>Done</targetReference></faultConnector></recordLookups>
      <recordUpdates><name>U</name><label>U</label><inputReference>x</inputReference><connector><targetReference>L</targetReference></connector><faultConnector><targetReference>Done</targetReference></faultConnector></recordUpdates>
      <recordUpdates><name>After</name><label>After</label><inputReference>x</inputReference><connector><targetReference>U</targetReference></connector><faultConnector><targetReference>Done</targetReference></faultConnector></recordUpdates>
      <assignments><name>Done</name><label>Done</label></assignments>
      <variables><name>c</name><dataType>String</dataType><isCollection>true</isCollection><isInput>false</isInput><isOutput>false</isOutput></variables>
      <variables><name>x</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>false</isOutput></variables>`);
    const issues = lint(xml);
    const db = issues.filter(i => i.rule === 'DbInLoop').map(i => i.element).sort();
    assert.deepStrictEqual(db, ['Q'], 'U also runs after the loop, so only Q is clearly inside: ' + JSON.stringify(issues));
    assert(!issues.some(i => i.rule === 'MissingFaultHandler'), 'all have fault paths');
});

test('checks: hard-coded ids, unused resources, unreachable, missing description', () => {
    assert(looksLikeId('001Dn00000AbCdE') && looksLikeId('500Ab00000Xy1zQAAQ'));
    assert(!looksLikeId('001Dn00000AbCdEfG'), '17 characters is not an id');
    assert(!looksLikeId('ExecutiveReview01') && !looksLikeId('123456789012345') && !looksLikeId('Opportunity_Main'));
    const xml = `<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><label>T</label><processType>AutoLaunchedFlow</processType>
      <start><connector><targetReference>A</targetReference></connector></start>
      <assignments><name>A</name><label>A</label><assignmentItems><assignToReference>used</assignToReference><operator>Assign</operator><value><stringValue>001Dn00000AbCdE</stringValue></value></assignmentItems></assignments>
      <assignments><name>Lost</name><label>Lost</label></assignments>
      <formulas><name>F</name><dataType>Boolean</dataType><expression>{!used} = '0058c00000AbCdEFAA'</expression></formulas>
      <variables><name>used</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>false</isOutput></variables>
      <variables><name>unused</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>false</isOutput></variables>
      <variables><name>inputVar</name><dataType>String</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>false</isOutput></variables>
    </Flow>`;
    const issues = lint(xml);
    const by = r => issues.filter(i => i.rule === r).map(i => i.element);
    assert.deepStrictEqual(by('HardcodedId').sort(), ['A', 'F']);
    assert.deepStrictEqual(by('UnusedResource').sort(), ['F', 'unused'], 'inputVar is used from outside; F is never referenced');
    assert.deepStrictEqual(by('UnreachableElement'), ['Lost']);
    assert.deepStrictEqual(by('MissingDescription'), [null]);
});

test('checks render: section, badges, Markdown', () => {
    const issues = checkFlow(sink, parseFlowXml(fs.readFileSync(sinkFile, 'utf8')), fs.readFileSync(sinkFile, 'utf8'));
    const html = render.renderBodyHtml(sink, { issues });
    assert(html.includes('<section class="checks"><details open>'), 'open when there are warnings');
    assert(/Orphan_Screen[\s\S]{0,600}lint-warning/.test(html));
    assert(render.renderMarkdown(sink, { issues }).includes('## Checks\n\n- Warning (UnreachableElement) Orphan_Screen'));
});

// ---- diagram ----
const { renderDiagramSvg, layoutFlow } = require('../src/diagram');

test('diagram: every step drawn once, outcomes as arrows, loop return detected, no overlaps', () => {
    const r = renderDiagramSvg(version(5));
    const steps = version(5).elements.filter(e => e.kind === 'step');
    assert.strictEqual((r.svg.match(/<g class="node /g) || []).length, steps.length);
    const l = layoutFlow(version(5));
    assert(l.edges.some(e => e.back), 'Set_Next_Step -> Loop_Opps is a loop return');
    assert(r.svg.includes('class="edge fault"') && r.svg.includes('>fault</text>'));
    const real = l.nodes.filter(n => !n.dummy);
    for (const a of real) for (const b of real) {
        if (a !== b && a.rank === b.rank) assert(Math.abs(a.x - b.x) >= 210, `${a.name} overlaps ${b.name}`);
    }
    assert(!/<script/i.test(r.svg));
});

test('diagram: loop-return arrows run outside every box they pass', () => {
    const files = [
        path.join(__dirname, 'fixtures', 'Kitchen_Sink.flow-meta.xml'),
        ...[1, 2, 3, 4, 5].map(v => ({ v }))
    ];
    const { __routeBackEdges } = require('../src/diagram');
    const W = 210;
    for (const f of files) {
        const m = f.v ? version(f.v) : load(f);
        const l = layoutFlow(m);
        const back = l.edges.filter(e => e.back);
        if (!back.length) continue;
        __routeBackEdges(l); // sets side, lane and outerX on each loop-return edge
        const { nodes } = l;
        for (const e of back) {
            const lo = Math.min(nodes[e.from].rank, nodes[e.to].rank), hi = Math.max(nodes[e.from].rank, nodes[e.to].rank);
            for (const n of nodes.filter(x => !x.dummy && x.rank >= lo && x.rank <= hi)) {
                assert(e.outerX <= n.x - W / 2 || e.outerX >= n.x + W / 2, `${m.label}: ${nodes[e.from].name}->${nodes[e.to].name} passes through ${n.name}`);
            }
        }
    }
});

test('diagram: names are escaped; compare and check badges', () => {
    const m = version(3);
    const evil = { ...m, elements: m.elements.map(e => (e.name === 'Get_Account' ? { ...e, label: '<img src=x onerror=alert(1)>' } : e)) };
    const r = renderDiagramSvg(evil, { changes: new Map([['Get_Account', 'changed']]), issues: new Map([['Get_Account', [{ severity: 'warning', message: 'x' }]]]) });
    assert(!r.svg.includes('<img') && r.svg.includes('&lt;img'));
    assert(r.svg.includes('node type-recordLookup chg-changed') && r.svg.includes('node-badge warn'));
});

// ---- limits: stop instead of freezing ----
test('limits: huge flow stops the diagram fast; checks and model stay fast', () => {
    const N = 5000;
    let body = '<start><connector><targetReference>E0</targetReference></connector></start>';
    for (let i = 0; i < N; i++) {
        body += `<assignments><name>E${i}</name><label>E${i}</label>${i < N - 1 ? `<connector><targetReference>E${i + 1}</targetReference></connector>` : ''}</assignments>`;
    }
    const xml = flowXml(body);
    let t = Date.now();
    const d = parseFlowXml(xml);
    const m = buildFlowModel(d, 'Big'); // iterative numbering: no stack overflow on a 5000-step chain
    const modelMs = Date.now() - t;
    assert.strictEqual(m.elements.filter(e => e.reached).length, N + 1);
    t = Date.now();
    checkFlow(m, d, xml);
    const checksMs = Date.now() - t;
    t = Date.now();
    const r = renderDiagramSvg(m);
    const diagramMs = Date.now() - t;
    assert(r.stopped && /5001 steps/.test(r.stopped), r.stopped);
    assert(diagramMs < 50 && checksMs < 1000 && modelMs < 3000, `model ${modelMs} ms, checks ${checksMs} ms, diagram ${diagramMs} ms`);
    console.log(`       (5000-step flow: model ${modelMs} ms, checks ${checksMs} ms, diagram stopped in ${diagramMs} ms)`);
});

test('limits: very large element diff falls back to a linear comparison', () => {
    const a = Array.from({ length: 1000 }, (_, i) => 'line ' + i);
    const b = [...a.slice(0, 500), 'new', ...a.slice(500)];
    const t = Date.now();
    const out = diffLines(a, b);
    assert(Date.now() - t < 200);
    assert.deepStrictEqual(out.filter(l => l.op !== ' ').map(l => l.op + l.text), ['+new']);
});

test('legacy flow with startElementReference and no <start>', () => {
    const xml = `<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata">
      <label>Legacy</label><processType>Flow</processType><startElementReference>Ask</startElementReference>
      <screens><name>Ask</name><label>Ask</label><fields><name>Q</name><fieldText>Name?</fieldText><fieldType>InputField</fieldType><dataType>String</dataType></fields></screens>
    </Flow>`;
    const m = buildFlowModel(parseFlowXml(xml), 'Legacy');
    checkCommon(m);
    assert.strictEqual(m.elements[1].name, 'Ask');
    assert(m.explanation[0].startsWith('prompts screen Ask'));
});

test('rejects non-flow XML', () => {
    assert.throws(() => parseFlowXml('<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"/>'), /not Salesforce Flow/);
    assert.throws(() => parseFlowXml('<Flow><label>broken'), /./);
});

test('file detection', () => {
    assert(looksLikeFlow('a/b/My.flow-meta.xml', ''));
    assert(looksLikeFlow('a/b/My.flow', ''));
    assert(looksLikeFlow('x.xml', '<?xml version="1.0"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">'));
    assert(!looksLikeFlow('x.xml', '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">'));
    assert.strictEqual(flowApiName('C:\\p\\Update_X.flow-meta.xml'), 'Update_X');
});

// ---- optional: real flows (read-only) ----
const folders = process.argv.slice(2);
if (folders.length) {
    const files = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.flow-meta\.xml$/i.test(entry.name)) files.push(full);
        }
    };
    folders.forEach(walk);
    console.log(`\nreal flows (${files.length} files, read-only)`);
    for (const file of files) {
        test(path.relative(process.cwd(), file), () => {
            const m = load(file);
            checkCommon(m);
            const unknownTargets = m.elements.flatMap(e => e.branches.filter(b => b.next && !b.nextExists).map(b => `${e.name} -> ${b.next}`));
            assert.deepStrictEqual(unknownTargets, [], 'connectors pointing at unknown elements');
        });
    }
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
