# Development notes

Not shipped in the extension package (see `.vscodeignore`). The Marketplace README is `README.md`.

Origin: a VS Code port of the Chrome extension "Salesforce Flow Extension" v1.1.7 by Fernando
Fernandez (MIT). `src/flowModel.js` is a port of its `FlowParser` (`scripts/popup.js`).

## Files

```
extension.js           commands, preview panel, live update, reveal in XML, Markdown/HTML save
src/flowXml.js         XML -> flow definition (same shape as the Tooling API Metadata JSON); element index
src/flowModel.js       port of FlowParser: parameters, branches, execution order, explanation
src/render.js          HTML table, standalone HTML page, Markdown table, AI summary, Changes, Checks
src/ai.js              Ask with AI: summary file + targets
src/flowDiff.js        element-by-element diff; Tooling API JSON -> XML-shaped data
src/sfCli.js           read-only Salesforce CLI calls (validated arguments, secret-free logging, cancel)
src/orgCompare.js      Compare with org: pickers, loading versions, XML diff, cache
src/fileCompare.js     Compare with local file
src/flowLint.js        the checks
src/diagram.js         diagram layout (layered, no library) and SVG
src/language.js        hover, Go to Definition, references, Outline, Problems panel
src/limits.js          hard limits (stop instead of freezing)
media/preview.js/.css  webview UI (VS Code theme colours)
media/icon.svg         logo source; media/icon.png is rendered from it (scripts/build-icon.js)
test/run.js            parser/renderer/diff/checks/diagram/limits tests; pass folders to also check real flows (read-only)
test/smoke-extension.js  runs extension.js against a mocked vscode module; --live <org> uses the real sf CLI
test/fixtures/         synthetic flow covering most element types
test/webview-harness.js  browser page running the preview like VS Code does (iframe + VS Code's
                       click handler); window.measure() checks every jump link; --diagram, --old-links
test/org-flows/complexFlow.js  generator for the 5-version test flow SFFlowPreview_Test_Complex
test/org-deploy-versions.js    deploys those versions to a dev org (WRITES; logged)
test/org-live.js       read-only live check: org versions vs deployed XML, version-to-version diffs
test/org-probe.js      read-only: list flows with several versions / save a version's metadata
scripts/orglog.js      org action log: logs/org_actions.jsonl  (node scripts/orglog.js --show [--writes])
scripts/build-icon.js  renders media/icon.svg to media/icon.png (dev dependency @resvg/resvg-js)
runs/                  per-deploy folders with the XML that was deployed and the results
```

Every org action taken while developing/testing (deploys of the test flow, live tests) is logged in
`logs/org_actions.jsonl`.

## Commands

```sh
npm install
npm test                                     # fixtures
node test/run.js <folder>                    # + every *.flow-meta.xml under a folder (read-only)
node test/smoke-extension.js                 # extension wiring with a mocked VS Code
node test/smoke-extension.js --live <org>    # same, compare goes to a real org (read-only, logged)
node test/org-deploy-versions.js <org>       # deploy the 5-version test flow (WRITES, dev org only)
node test/org-live.js <org>                  # live compare checks (read-only, logged)
node test/webview-harness.js <flow> <out.html> [--diagram]
node scripts/build-icon.js [previewDir]      # rebuild the icon
npm run package                              # builds sfflow-table-preview-<version>.vsix
```

To try it without installing: open this folder in VS Code and press F5 (Extension Development Host).

## AI handoffs

Claude Code and Agentforce have no public "send a prompt" API. The extension uses their internal
commands, checked with Claude Code 2.1.319 and Agentforce for Developers 3.40.0:

- `claude-vscode.editor.open(sessionId?, initialPrompt?)`: opens a new Claude Code tab with the
  prompt. If it throws, the prompt is copied to the clipboard and Claude Code is opened.
- `agentforce.injectPromptToInput({ prompt })`.

Re-check both after major updates of those extensions.

## Publishing (publisher `rohit-kumar-g`)

Publishing uses Marketplace **trusted publishing** from GitHub Actions
(`.github/workflows/publish.yml`, `vsce publish --oidc`): no Personal Access Token.

One-time setup, at https://marketplace.visualstudio.com/manage/publishers/rohit-kumar-g >
Trusted publishing > Create: provider GitHub Actions, owner `rohit-kumar-g`, repository
`sfflow-table-preview`, workflow `publish.yml`, environment empty.

Each release:

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `npm test && node test/smoke-extension.js`
3. `npm run package` and install the `.vsix` locally once (`code --install-extension <file>`).
4. Commit, push, then create a GitHub release with tag `v<version>` and the `.vsix` attached
   (`gh release create v<version> <file>.vsix --notes-file <notes>`). Publishing the release runs
   the workflow, which checks the tag matches `package.json`, runs the tests and publishes.
   The workflow can also be started by hand: `gh workflow run publish.yml`.

Fallback without GitHub Actions: upload the `.vsix` at
https://marketplace.visualstudio.com/manage/publishers/rohit-kumar-g.
