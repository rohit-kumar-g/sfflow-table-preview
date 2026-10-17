'use strict';
// Read-only probe of an org's flow versions, used to learn the real Tooling API shapes.
// Every org call is logged to logs/org_actions.jsonl.
//   node test/org-probe.js <org> [<FlowApiName>]
// Without a flow name it lists flows that have 2+ versions. With one, it lists the
// versions and saves the Metadata JSON of the newest two to a temp folder (path printed).

const fs = require('fs');
const os = require('os');
const path = require('path');
const sf = require('../src/sfCli');
const orglog = require('../scripts/orglog');

const [org, flowName] = process.argv.slice(2);
if (!org) {
    console.error('usage: node test/org-probe.js <org> [<FlowApiName>]');
    process.exit(1);
}
const runId = 'probe-' + new Date().toISOString().replace(/[:.]/g, '-');

(async () => {
    const orgs = await sf.listOrgs();
    const me = orgs.find(o => o.alias.split(',').includes(org) || o.username === org);
    const onLog = e => orglog.log({ ...e, org, username: me ? me.username : null, source: 'test/org-probe.js', runId });

    if (!flowName) {
        const result = await sf.runSf(['data', 'query', '--use-tooling-api', '--target-org', org, '--query',
            'SELECT DeveloperName, LatestVersion.VersionNumber, ActiveVersion.VersionNumber FROM FlowDefinition ORDER BY DeveloperName'],
        { org, onLog, logAction: 'query flow definitions', details: { object: 'FlowDefinition (Tooling)' } });
        const rows = result.records.map(r => ({
            name: r.DeveloperName,
            latest: r.LatestVersion ? r.LatestVersion.VersionNumber : null,
            active: r.ActiveVersion ? r.ActiveVersion.VersionNumber : null
        }));
        console.log(`${rows.length} flows; with 2+ versions:`);
        rows.filter(r => r.latest >= 2).forEach(r => console.log(`  ${r.name}  latest v${r.latest}  active v${r.active ?? '-'}`));
        return;
    }

    const versions = await sf.listFlowVersions(org, flowName, { onLog });
    const names = await sf.userNames(org, versions.map(v => v.lastModifiedById), { onLog });
    versions.forEach(v => console.log(`  v${v.versionNumber} ${v.status} ${v.lastModifiedDate} ${names[v.lastModifiedById] || v.lastModifiedById} ${v.id}`));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfflow-probe-'));
    for (const v of versions.slice(0, 2)) {
        const md = await sf.fetchFlowMetadata(org, v.id, { onLog });
        const file = path.join(outDir, `${flowName}-v${v.versionNumber}.json`);
        fs.writeFileSync(file, JSON.stringify(md, null, 2));
        console.log('saved ' + file);
    }
})().catch(e => {
    console.error('PROBE FAILED: ' + e.message);
    process.exitCode = 1;
});
