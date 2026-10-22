'use strict';
// "SF Flow: Give Feedback or Report an Issue": opens the GitHub issue forms / Discussions,
// with the extension and VS Code versions already filled into a bug report.

const vscode = require('vscode');
const pkg = require('../package.json');

const REPO = 'https://github.com/rohit-kumar-g/sfflow-table-preview';
const MARKETPLACE = 'https://marketplace.visualstudio.com/items?itemName=rohit-kumar-g.sfflow-table-preview&ssr=false#review-details';

function urlFor(kind) {
    // only digits, dots, letters and dashes in prefilled values: nothing that needs escaping
    const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    switch (kind) {
        case 'bug':
            return `${REPO}/issues/new?` + q({
                template: 'bug_report.yml',
                'ext-version': pkg.version,
                'vscode-version': vscode.version,
                os: `${process.platform}-${process.arch}`
            });
        case 'idea':
            return `${REPO}/issues/new?` + q({ template: 'feature_request.yml', 'ext-version': pkg.version });
        case 'discuss':
            return `${REPO}/discussions`;
        case 'rate':
            return MARKETPLACE;
        default:
            return REPO;
    }
}

async function giveFeedback(kind) {
    let target = kind;
    if (!target) {
        const picked = await vscode.window.showQuickPick([
            { label: '$(bug) Report a problem', detail: 'Opens a GitHub issue with your extension and VS Code versions filled in.', kind: 'bug' },
            { label: '$(lightbulb) Suggest a feature', detail: 'Opens a GitHub feature request.', kind: 'idea' },
            { label: '$(comment-discussion) Ask a question or share feedback', detail: 'GitHub Discussions.', kind: 'discuss' },
            { label: '$(star) Rate the extension', detail: 'VS Code Marketplace review.', kind: 'rate' }
        ], { title: 'Flow Table Preview for Salesforce: feedback' });
        if (!picked) return;
        target = picked.kind;
    }
    await vscode.env.openExternal(vscode.Uri.parse(urlFor(target)));
}

module.exports = { giveFeedback, urlFor, REPO };
