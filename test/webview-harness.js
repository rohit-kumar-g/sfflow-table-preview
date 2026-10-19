'use strict';
// Builds a browser page that runs the preview the way VS Code does: inside an iframe,
// with a copy of VS Code's own webview click handler (pre/index.html handleInnerClick:
// a click on href="#" scrolls the webview to the top) attached to the iframe window.
//   node test/webview-harness.js <flow-meta.xml> <out.html> [--old-links]
// --old-links renders links as before 0.3.2 (href="#") to reproduce the scroll-to-top bug.
// Open out.html in a browser; window.measure() clicks every "From"/next/Changes link and
// reports where the target landed relative to the sticky header.

const fs = require('fs');
const path = require('path');
const { parseFlowXml, flowApiName } = require('../src/flowXml');
const { buildFlowModel } = require('../src/flowModel');
const render = require('../src/render');

const [file, out] = process.argv.slice(2);
const oldLinks = process.argv.includes('--old-links');
if (!file || !out) {
    console.error('usage: node test/webview-harness.js <flow-meta.xml> <out.html> [--old-links]');
    process.exit(1);
}
const root = path.join(__dirname, '..');
const xmlText = fs.readFileSync(file, 'utf8');
const definition = parseFlowXml(xmlText);
const model = buildFlowModel(definition, flowApiName(file));
const issues = require('../src/flowLint').checkFlow(model, definition, xmlText);
const showDiagram = process.argv.includes('--diagram');
const issueMap = new Map();
issues.forEach(i => { if (i.element) (issueMap.get(i.element) || issueMap.set(i.element, []).get(i.element)).push(i); });
let body = render.renderBodyHtml(model, {
    issues,
    view: showDiagram ? 'diagram' : 'table',
    diagram: showDiagram ? require('../src/diagram').renderDiagramSvg(model, { issues: issueMap }) : undefined
});
if (oldLinks) {
    body = body.replace(/<a class="(goto|reveal)" role="link" tabindex="0" /g, '<a href="#" class="$1" ');
}
const css = fs.readFileSync(path.join(root, 'media', 'preview.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'media', 'preview.js'), 'utf8');
const theme = render.renderStandaloneHtml(model, '', '').match(/<style>([\s\S]*?)\n\n/)[1];
const shell = fs.readFileSync(path.join(root, 'extension.js'), 'utf8').match(/<body>([\s\S]*?)<script nonce/)[1];

// VS Code's webview default body style: padding 0 20px, margin 0
const startView = showDiagram ? 'diagram' : 'table';
const inner = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0 20px}</style><style>${theme}\n${css}</style></head>
<body>${shell}<script>window.__posted=[];window.acquireVsCodeApi=()=>({getState:()=>({view:${JSON.stringify(startView)}}),setState(){},postMessage(m){window.__posted.push(m)}});<\/script>
<script>${js}<\/script></body></html>`;

const page = `<!doctype html><html><head><meta charset="utf-8"><title>webview harness</title>
<style>body{margin:0;background:#181818;color:#ccc;font:13px sans-serif} iframe{border:0;width:680px;height:600px;display:block}</style></head>
<body><div id="info">${oldLinks ? 'OLD links (href="#")' : 'NEW links (no href)'} · ${model.label}</div>
<iframe id="wv" srcdoc="${inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>
<script>
const wv = document.getElementById('wv');
wv.addEventListener('load', () => {
  const w = wv.contentWindow;
  // copy of VS Code's handleInnerClick (isTrusted check left out so scripted clicks count)
  w.addEventListener('click', event => {
    for (const node of event.composedPath()) {
      if (node.tagName && node.tagName.toLowerCase() === 'a' && node.href) {
        if (node.getAttribute('href') === '#') { event.view.scrollTo(0, 0); }
        else if (node.hash && node.getAttribute('href') === node.hash) {
          const t = event.view.document.getElementById(node.hash.slice(1)); if (t) t.scrollIntoView();
        }
        event.preventDefault();
        return;
      }
    }
  });
  w.__harnessView = ${JSON.stringify(showDiagram ? 'diagram' : 'table')};
  w.postMessage({ type: 'render', showResources: true, html: ${JSON.stringify(body)} }, '*');
  window.__ready = true;
});
// clicks every jump link; smooth scrolling is made instant so results don't depend on animation
window.measure = () => {
  const w = wv.contentWindow, d = w.document;
  const orig = w.scrollTo.bind(w);
  w.scrollTo = (a, b) => (typeof a === 'object' ? orig(a.left || 0, a.top) : orig(a, b));
  const sticky = () => d.getElementById('toolbar').offsetHeight + d.querySelector('#flowTable thead').offsetHeight;
  const maxScroll = () => d.documentElement.scrollHeight - w.innerHeight;
  const results = [...d.querySelectorAll('a.goto')].map(a => {
    const kind = a.closest('.from') ? 'From' : a.closest('.compare') ? 'Changes' : 'next';
    orig(0, Math.max(0, a.getBoundingClientRect().top + w.scrollY - 250));
    a.click();
    const cell = d.getElementById(a.dataset ? a.dataset.target || (a.hash || '').slice(1) : '');
    const top = Math.round(cell.getBoundingClientRect().top);
    const gap = top - sticky();
    const atEnd = Math.abs(w.scrollY - maxScroll()) < 2;
    const ok = gap >= 0 && (gap <= 12 || atEnd) && top < w.innerHeight;
    return { kind, text: a.textContent.trim(), gap, scrollY: Math.round(w.scrollY), atEnd, ok };
  });
  w.scrollTo = orig;
  return results;
};
</script></body></html>`;
fs.writeFileSync(out, page);
console.log(`written ${out} (${oldLinks ? 'old' : 'new'} links, ${model.elements.length} elements)`);
