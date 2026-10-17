'use strict';
// Append-only log of every action run against a Salesforce org while developing/testing
// this extension: logs/org_actions.jsonl (one JSON object per line: time, org, username,
// source, runId, action, write, details, result). Tokens are never written. The log is
// git-ignored: it stays on the developer's machine.
//
//   node scripts/orglog.js --show [--writes] [--org <alias>]
//   node scripts/orglog.js --org p2 --action "manual query" --detail soql="SELECT ..." --read

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'org_actions.jsonl');

function log({ org, username = null, source = 'manual', runId = null, action, write = false, details = {}, result = null, reconstructed }) {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const entry = {
        time: new Date().toISOString(),
        org, username, source, runId, action, write, details, result,
        by: os.userInfo().username
    };
    if (reconstructed) entry.reconstructed = true;
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

function show({ org, writesOnly } = {}) {
    if (!fs.existsSync(LOG_FILE)) {
        console.log('No log yet: ' + LOG_FILE);
        return;
    }
    for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)) {
        const e = JSON.parse(line);
        if (org && e.org !== org) continue;
        if (writesOnly && !e.write) continue;
        console.log(`${e.time}  ${String(e.org).padEnd(8)} ${e.write ? 'WRITE' : 'read '}  ${String(e.action).padEnd(30)} `
            + `${JSON.stringify(e.details).substring(0, 150)}  ${e.result === null ? '' : JSON.stringify(e.result).substring(0, 100)}`);
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const get = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    if (args.includes('--show')) {
        show({ org: get('--org'), writesOnly: args.includes('--writes') });
    } else {
        const details = {};
        args.forEach((a, i) => {
            if (a === '--detail') {
                const [k, ...v] = args[i + 1].split('=');
                details[k] = v.join('=');
            }
        });
        if (!get('--org') || !get('--action')) {
            console.error('usage: --org <alias> --action <text> [--detail k=v] [--read] | --show [--writes] [--org x]');
            process.exit(1);
        }
        log({ org: get('--org'), action: get('--action'), write: !args.includes('--read'), details, result: get('--result') ?? null });
    }
}

module.exports = { log, show, LOG_FILE };
