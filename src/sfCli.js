'use strict';
// Thin wrapper around the Salesforce CLI (`sf`), used read-only:
//   sf org list auth --json                       (local auth cache, no network)
//   sf data query --use-tooling-api --json ...    (Flow versions and their Metadata)
// Every org call goes through onLog so it can be shown/recorded. Raw output is
// never logged: `org list auth` contains access tokens.

const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const ORG = /^[\w.@+-]+$/;

function quoteArg(arg) {
    const s = String(arg);
    if (process.platform === 'win32') {
        // cmd.exe: inside double quotes these are still special or break quoting
        if (/["%\r\n]/.test(s)) throw new Error(`Refusing to pass an unsafe argument to sf: ${s}`);
        return `"${s}"`;
    }
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs `sf <args> --json` and returns `result`, or throws with sf's error message.
 * @param {string[]} args
 * @param {{ sfPath?: string, cwd?: string, timeoutMs?: number,
 *           onLog?: (entry: object) => void, logAction?: string, org?: string, details?: object }} opts
 */
function runSf(args, opts = {}) {
    const sfPath = opts.sfPath || 'sf';
    const command = [sfPath === 'sf' ? 'sf' : quoteArg(sfPath), ...args.map(quoteArg), '--json'].join(' ');
    const started = Date.now();
    return new Promise((resolve, reject) => {
        if (opts.signal && opts.signal.aborted) {
            reject(new Error('Cancelled.'));
            return;
        }
        exec(command, {
            cwd: opts.cwd,
            signal: opts.signal,             // Cancel on the progress notification kills sf
            killSignal: 'SIGTERM',
            timeout: opts.timeoutMs || 120000, // and a hard timeout: stop rather than hang
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, SF_AUTOUPDATE_DISABLE: 'true', SF_DISABLE_TELEMETRY: 'true', FORCE_COLOR: '0' }
        }, (error, stdout, stderr) => {
            if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
                if (opts.onLog && opts.logAction) {
                    opts.onLog({ org: opts.org || null, action: opts.logAction, write: false, details: opts.details || {}, result: { error: 'cancelled by user' }, ms: Date.now() - started });
                }
                reject(new Error('Cancelled.'));
                return;
            }
            if (error && error.killed) {
                reject(new Error(`sf did not answer within ${Math.round((opts.timeoutMs || 120000) / 1000)} s and was stopped.`));
                return;
            }
            let json = null;
            try {
                const text = String(stdout || '');
                json = JSON.parse(text.substring(text.indexOf('{')));
            } catch (e) {
                // not JSON (sf missing, crash)
            }
            const ok = json && json.status === 0;
            const failure = ok ? null : (json && (json.message || componentProblems(json) || json.name))
                || (error && /not recognized|not found|ENOENT/i.test(String(stderr) + error.message)
                    ? `Salesforce CLI not found ("${sfPath}"). Install it or set sfflowPreview.sfPath.`
                    : (String(stderr || '').trim() || (error ? error.message : 'sf returned no JSON')));
            if (opts.onLog && opts.logAction) {
                opts.onLog({
                    org: opts.org || null,
                    action: opts.logAction,
                    write: false,
                    details: opts.details || {},
                    result: ok ? summarize(json.result) : { error: String(failure).substring(0, 300) },
                    ms: Date.now() - started
                });
            }
            if (ok) resolve(json.result);
            else reject(new Error(failure));
        });
    });
}

// Deploy/retrieve failures carry no top-level message; the reasons are per component.
function componentProblems(json) {
    const details = (json.result || json.data || {}).details || {};
    const failures = [].concat(details.componentFailures || []);
    const problems = failures.filter(f => f && f.problem).map(f => `${f.fullName || f.fileName}: ${f.problem}`);
    return problems.length ? problems.join('\n') : null;
}

// Short, secret-free description of a result for the log
function summarize(result) {
    if (result && Array.isArray(result.records)) return { records: result.records.length };
    if (Array.isArray(result)) return { items: result.length };
    return 'ok';
}

// Orgs known to the CLI (local cache only). Never returns tokens.
async function listOrgs(opts = {}) {
    const result = await runSf(['org', 'list', 'auth'], { ...opts, logAction: null });
    return (result || []).map(o => ({
        alias: o.alias || '',
        username: o.username,
        instanceUrl: o.instanceUrl || '',
        isSandbox: Boolean(o.isSandbox),
        isScratchOrg: Boolean(o.isScratchOrg),
        isExpired: Boolean(o.isExpired)
    })).filter(o => o.username);
}

// The project's default org: nearest sfdx project folder's .sf/config.json (target-org)
// or legacy .sfdx/sfdx-config.json (defaultusername).
function findProject(startFile) {
    let dir = path.dirname(startFile);
    for (let i = 0; i < 30; i++) {
        if (fs.existsSync(path.join(dir, 'sfdx-project.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

// Resolved like the sf CLI does: the project's config first, then the global one in the
// user's home folder. Returns { org, source: 'project' | 'global' } or null.
function defaultOrgFor(projectDir, homeDir = os.homedir()) {
    const read = (dir, f) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return null; }
    };
    const lookup = dir => {
        if (!dir) return null;
        const sfConfig = read(dir, path.join('.sf', 'config.json'));
        if (sfConfig && sfConfig['target-org']) return sfConfig['target-org'];
        const legacy = read(dir, path.join('.sfdx', 'sfdx-config.json'));
        return (legacy && legacy.defaultusername) || null;
    };
    const fromProject = lookup(projectDir);
    if (fromProject) return { org: fromProject, source: 'project' };
    const fromHome = lookup(homeDir);
    return fromHome ? { org: fromHome, source: 'global' } : null;
}

// All versions of one flow in an org, newest first.
async function listFlowVersions(org, apiName, opts = {}) {
    if (!ORG.test(org)) throw new Error(`Invalid org alias or username: ${org}`);
    if (!API_NAME.test(apiName)) throw new Error(`Invalid flow API name: ${apiName}`);
    const soql = 'SELECT Id, VersionNumber, Status, MasterLabel, Description, ProcessType, ApiVersion, '
        + 'CreatedDate, LastModifiedDate, LastModifiedById '
        + `FROM Flow WHERE Definition.DeveloperName = '${apiName}' ORDER BY VersionNumber DESC`;
    const result = await runSf(['data', 'query', '--use-tooling-api', '--target-org', org, '--query', soql], {
        ...opts, org, logAction: 'query flow versions', details: { object: 'Flow (Tooling)', flow: apiName }
    });
    return (result.records || []).map(r => ({
        id: r.Id,
        versionNumber: r.VersionNumber,
        status: r.Status,
        label: r.MasterLabel,
        description: r.Description || '',
        processType: r.ProcessType,
        apiVersion: r.ApiVersion,
        createdDate: r.CreatedDate,
        lastModifiedDate: r.LastModifiedDate,
        lastModifiedById: r.LastModifiedById
    }));
}

// Display names for user ids (one query for all of them).
async function userNames(org, ids, opts = {}) {
    const unique = [...new Set(ids.filter(id => SF_ID.test(id || '')))];
    if (!unique.length) return {};
    const soql = `SELECT Id, Name FROM User WHERE Id IN (${unique.map(id => `'${id}'`).join(',')})`;
    try {
        const result = await runSf(['data', 'query', '--target-org', org, '--query', soql], {
            ...opts, org, logAction: 'query user names', details: { object: 'User', ids: unique.length }
        });
        return Object.fromEntries((result.records || []).map(r => [r.Id, r.Name]));
    } catch (e) {
        return {}; // names are a nicety
    }
}

// Flow.Metadata (same shape as the Metadata API XML) for one version. Tooling API only
// allows the Metadata field when the query returns a single row.
async function fetchFlowMetadata(org, flowId, opts = {}) {
    if (!ORG.test(org)) throw new Error(`Invalid org alias or username: ${org}`);
    if (!SF_ID.test(flowId)) throw new Error(`Invalid Flow id: ${flowId}`);
    const result = await runSf(['data', 'query', '--use-tooling-api', '--target-org', org,
        '--query', `SELECT Id, VersionNumber, Status, Metadata FROM Flow WHERE Id = '${flowId}'`], {
        ...opts, org, logAction: 'read flow version metadata', details: { object: 'Flow (Tooling)', id: flowId }
    });
    const record = (result.records || [])[0];
    if (!record || !record.Metadata) throw new Error(`Flow version ${flowId} has no Metadata.`);
    return record.Metadata;
}

// The real XML of one flow version: Metadata API retrieve of "Flow:<ApiName>-<version>".
// Retrieves into a throwaway project under workDir (never the user's project) and
// returns the XML text.
async function retrieveFlowVersionXml(org, apiName, versionNumber, workDir, opts = {}) {
    if (!ORG.test(org)) throw new Error(`Invalid org alias or username: ${org}`);
    if (!API_NAME.test(apiName)) throw new Error(`Invalid flow API name: ${apiName}`);
    if (!Number.isInteger(Number(versionNumber))) throw new Error(`Invalid version: ${versionNumber}`);
    fs.mkdirSync(workDir, { recursive: true });
    const project = fs.mkdtempSync(path.join(workDir, 'retrieve-'));
    try {
        fs.mkdirSync(path.join(project, 'force-app'), { recursive: true });
        fs.writeFileSync(path.join(project, 'sfdx-project.json'),
            JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
        const member = `Flow:${apiName}-${Number(versionNumber)}`;
        await runSf(['project', 'retrieve', 'start', '--metadata', member, '--target-org', org, '--ignore-conflicts'], {
            ...opts, cwd: project, org, timeoutMs: 5 * 60 * 1000,
            logAction: 'retrieve flow version XML', details: { metadata: member }
        });
        const found = [];
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.flow-meta\.xml$/i.test(e.name)) found.push(full);
        });
        walk(path.join(project, 'force-app'));
        if (!found.length) throw new Error(`The org returned no XML for ${member}.`);
        return fs.readFileSync(found[0], 'utf8');
    } finally {
        fs.rmSync(project, { recursive: true, force: true });
    }
}

module.exports = {
    runSf, listOrgs, findProject, defaultOrgFor, listFlowVersions, fetchFlowMetadata, userNames,
    retrieveFlowVersionXml, quoteArg, API_NAME
};
