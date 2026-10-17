'use strict';
// Live, read-only check of "compare with org versions" against a real org.
// Every org call is logged to logs/org_actions.jsonl.
//   node test/org-live.js <org>
// Needs the test flow deployed by test/org-deploy-versions.js. Checks:
//   1. each org version (Tooling API JSON) equals the XML that was deployed for it (no false diffs)
//   2. consecutive org versions differ exactly as the generator intends

const assert = require('assert');
const sf = require('../src/sfCli');
const orglog = require('../scripts/orglog');
const { parseFlowXml } = require('../src/flowXml');
const { buildFlowModel } = require('../src/flowModel');
const { normalizeToolingMetadata, diffModels } = require('../src/flowDiff');
const { build, API_NAME, VERSIONS } = require('./org-flows/complexFlow');

const org = process.argv[2];
if (!org) {
    console.error('usage: node test/org-live.js <org>');
    process.exit(1);
}
const runId = 'live-' + new Date().toISOString().replace(/[:.]/g, '-');
let failures = 0;
const check = (name, fn) => {
    try { fn(); console.log('  ok   ' + name); } catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n').join('\n       ')); }
};

(async () => {
    const orgs = await sf.listOrgs();
    const me = orgs.find(o => o.alias.split(',').includes(org) || o.username === org);
    const onLog = e => orglog.log({ ...e, org, username: me ? me.username : null, source: 'test/org-live.js', runId });

    const versions = (await sf.listFlowVersions(org, API_NAME, { onLog })).sort((a, b) => a.versionNumber - b.versionNumber);
    console.log(`${API_NAME}: ${versions.map(v => `v${v.versionNumber} ${v.status}`).join(', ')}`);
    assert(versions.length >= VERSIONS, `expected ${VERSIONS}+ versions; deploy them with test/org-deploy-versions.js`);

    const latest = versions.slice(-VERSIONS); // the last VERSIONS deploys are generator v1..v5
    const orgModels = [];
    for (let i = 0; i < latest.length; i++) {
        const md = await sf.fetchFlowMetadata(org, latest[i].id, { onLog });
        orgModels.push(buildFlowModel(normalizeToolingMetadata(md), API_NAME));
    }

    console.log('\norg version vs deployed XML (must be identical)');
    orgModels.forEach((orgModel, i) => {
        const fileModel = buildFlowModel(parseFlowXml(build(i + 1)), API_NAME);
        check(`org v${latest[i].versionNumber} == generator v${i + 1}`, () => {
            const r = diffModels(orgModel, fileModel);
            const noise = r.elements.filter(e => e.change !== 'unchanged')
                .map(e => `${e.name} ${e.change}: ` + e.lines.filter(l => l.op !== ' ').map(l => l.op + l.text).join(' | '));
            // older versions become Obsolete after they were deployed Active: a real change, not noise
            const facts = r.facts.filter(f => !(f.label === 'Status' && f.before === 'Obsolete')).map(f => `${f.label}: ${f.before} -> ${f.after}`);
            assert.deepStrictEqual([...facts, ...noise], []);
        });
    });

    console.log('\nconsecutive org versions');
    const expected = [
        { added: ['HotEmailBody', 'Notify_Owner'], removed: [], changed: ['Check_Account', 'Create_Followup_Task', 'Set_Next_Step'] },
        { added: ['Filter_Big_Opps', 'currentItem_Filter_Big_Opps'], removed: ['Update_Account_Description', 'WarmText'], changed: ['Check_Account', 'Loop_Opps', 'Sort_Opps'] },
        { added: [], removed: [], changed: ['Get_Open_Opps', 'HighValueThreshold', 'Sort_Opps'] },
        { added: ['Has_Opps'], removed: [], changed: ['Loop_Opps'] }
    ];
    for (let i = 1; i < orgModels.length; i++) {
        check(`v${latest[i - 1].versionNumber} -> v${latest[i].versionNumber}`, () => {
            const r = diffModels(orgModels[i - 1], orgModels[i]);
            const names = change => r.elements.filter(e => e.change === change).map(e => e.name).sort();
            assert.deepStrictEqual({ added: names('added'), removed: names('removed'), changed: names('changed') }, expected[i - 1]);
        });
    }

    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exitCode = failures ? 1 : 0;
})().catch(e => {
    console.error('LIVE TEST FAILED: ' + e.message);
    process.exitCode = 1;
});
