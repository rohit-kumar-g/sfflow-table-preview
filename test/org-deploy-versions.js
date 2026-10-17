'use strict';
// Deploys the test flow SFFlowPreview_Test_Complex to an org once per version (v1..v5),
// so the org holds several versions to compare. WRITES TO THE ORG: creates/updates
// only that flow. Each deploy is logged to logs/org_actions.jsonl (write: true), and the
// generated XML + results are kept in runs/<time>_deploy-<org>/.
//   node test/org-deploy-versions.js <org> [fromVersion] [toVersion]
// Remove afterwards: Setup > Flows > SFFlowPreview Test Complex > delete each version.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sf = require('../src/sfCli');
const orglog = require('../scripts/orglog');
const { build, API_NAME, VERSIONS } = require('./org-flows/complexFlow');

const [org, fromArg, toArg] = process.argv.slice(2);
if (!org) {
    console.error('usage: node test/org-deploy-versions.js <org> [fromVersion] [toVersion]');
    process.exit(1);
}
const from = Number(fromArg || 1), to = Number(toArg || VERSIONS);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runId = `deploy-${stamp}`;
const runDir = path.join(__dirname, '..', 'runs', `${stamp}_deploy-${org}`);
fs.mkdirSync(runDir, { recursive: true });

(async () => {
    const orgs = await sf.listOrgs();
    const me = orgs.find(o => o.alias.split(',').includes(org) || o.username === org);
    if (!me) throw new Error(`org ${org} is not authorized in the sf CLI`);
    const onLog = e => orglog.log({ ...e, org, username: me.username, source: 'test/org-deploy-versions.js', runId });

    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sfflow-deploy-'));
    const flowDir = path.join(project, 'force-app', 'main', 'default', 'flows');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(project, 'sfdx-project.json'),
        JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '62.0' }));

    const results = [];
    try {
        for (let v = from; v <= to; v++) {
            const xml = build(v);
            fs.writeFileSync(path.join(runDir, `${API_NAME}.v${v}.flow-meta.xml`), xml);
            fs.writeFileSync(path.join(flowDir, `${API_NAME}.flow-meta.xml`), xml);
            process.stdout.write(`deploy v${v} ... `);
            let entry;
            try {
                const r = await sf.runSf(['project', 'deploy', 'start', '--metadata', `Flow:${API_NAME}`,
                    '--target-org', org, '--wait', '15', '--ignore-conflicts'], {
                    cwd: project, timeoutMs: 20 * 60 * 1000,
                    onLog: e => onLog({ ...e, write: true }),
                    logAction: 'deploy test flow version',
                    details: { flow: API_NAME, generatorVersion: v, status: v >= 5 ? 'Draft' : 'Active' }
                });
                entry = { version: v, status: r.status, id: r.id, success: r.success };
            } catch (e) {
                entry = { version: v, error: e.message };
            }
            results.push(entry);
            console.log(entry.error ? 'FAILED: ' + entry.error : entry.status);
            if (entry.error) break;
        }
    } finally {
        fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));
        fs.rmSync(project, { recursive: true, force: true });
    }
    console.log('run folder: ' + runDir);
})().catch(e => {
    console.error('DEPLOY SCRIPT FAILED: ' + e.message);
    process.exitCode = 1;
});
