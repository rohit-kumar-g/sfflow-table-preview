'use strict';
// Flow diagram: a small layered ("Sugiyama-style") layout written for flows, no library.
//   1. back edges (loop returns) found with an iterative DFS from Start
//   2. layers by longest path over the remaining (acyclic) edges
//   3. waypoints for edges that skip layers
//   4. a few barycenter sweeps to reduce crossings, stopped by a time budget
//   5. static SVG (also used in the saved HTML page)
// Linear-ish in the number of elements; above DIAGRAM_MAX_NODES it stops and says why.

const { DIAGRAM_MAX_NODES, DIAGRAM_LAYOUT_MS } = require('./limits');

const NODE_W = 210, NODE_H = 54, GAP_X = 36, GAP_Y = 64, MARGIN = 24, BACK_GAP = 14;

function esc(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function clip(text, max) {
    const s = String(text ?? '');
    return s.length > max ? s.substring(0, max - 1) + '…' : s;
}
// Short arrow label: drop "(ApiName)" and the default "success"
function edgeLabel(branch) {
    const label = String(branch.label || '').replace(/\s*\([A-Za-z][A-Za-z0-9_]*\)$/, '');
    return label === 'success' || label === 'Runs immediately' ? '' : label;
}

function layoutFlow(model) {
    const steps = model.elements.filter(e => e.kind === 'step');
    if (steps.length > DIAGRAM_MAX_NODES) {
        return { stopped: `This flow has ${steps.length} steps; the diagram is drawn up to ${DIAGRAM_MAX_NODES}. Use the table instead.` };
    }
    const started = Date.now();
    const index = new Map(steps.map((e, i) => [e.name, i]));
    const nodes = steps.map((e, i) => ({ id: i, name: e.name, el: e, rank: 0, order: 0, dummy: false }));
    const edges = [];
    steps.forEach((e, i) => e.branches.forEach(b => {
        if (b.next && index.has(b.next)) {
            edges.push({ from: i, to: index.get(b.next), label: edgeLabel(b), fault: b.label === 'fault', back: false });
        }
    }));

    // 1. back edges: iterative DFS from Start, then from anything not reached
    const out = nodes.map(() => []);
    edges.forEach((ed, k) => out[ed.from].push(k));
    const state = new Array(nodes.length).fill(0); // 0 new, 1 on stack, 2 done
    const dfs = root => {
        const stack = [[root, 0]];
        state[root] = 1;
        while (stack.length) {
            const top = stack[stack.length - 1];
            const [n, i] = top;
            if (i >= out[n].length) {
                state[n] = 2;
                stack.pop();
                continue;
            }
            top[1]++;
            const ed = edges[out[n][i]];
            if (state[ed.to] === 1) ed.back = true;
            else if (state[ed.to] === 0) {
                state[ed.to] = 1;
                stack.push([ed.to, 0]);
            }
        }
    };
    if (index.has('Start')) dfs(index.get('Start'));
    nodes.forEach(n => { if (state[n.id] === 0) dfs(n.id); });

    // 2. layers: longest path over forward edges (Kahn topological order)
    const fwd = edges.filter(e => !e.back && e.from !== e.to);
    const indeg = new Array(nodes.length).fill(0);
    fwd.forEach(e => indeg[e.to]++);
    const fwdOut = nodes.map(() => []);
    fwd.forEach(e => fwdOut[e.from].push(e.to));
    const queue = nodes.filter(n => indeg[n.id] === 0).map(n => n.id);
    for (let h = 0; h < queue.length; h++) {
        const n = queue[h];
        for (const t of fwdOut[n]) {
            nodes[t].rank = Math.max(nodes[t].rank, nodes[n].rank + 1);
            if (--indeg[t] === 0) queue.push(t);
        }
    }

    // 3. waypoints (dummy nodes) for forward edges that skip layers
    const segments = []; // [{from, to}] between adjacent layers, for ordering
    for (const e of fwd) {
        e.path = [e.from];
        let prev = e.from;
        for (let r = nodes[e.from].rank + 1; r < nodes[e.to].rank; r++) {
            const d = { id: nodes.length, name: null, rank: r, order: 0, dummy: true };
            nodes.push(d);
            segments.push({ from: prev, to: d.id });
            e.path.push(d.id);
            prev = d.id;
        }
        segments.push({ from: prev, to: e.to });
        e.path.push(e.to);
    }

    // 4. order inside layers: start from execution order, then barycenter sweeps
    const layers = [];
    nodes.forEach(n => { (layers[n.rank] = layers[n.rank] || []).push(n); });
    layers.forEach(l => l.forEach((n, i) => { n.order = i; }));
    const preds = nodes.map(() => []), succs = nodes.map(() => []);
    segments.forEach(s => { preds[s.to].push(s.from); succs[s.from].push(s.to); });
    const sweep = (layer, neighbours) => {
        layer.forEach(n => {
            const ns = neighbours[n.id];
            n.bary = ns.length ? ns.reduce((sum, m) => sum + nodes[m].order, 0) / ns.length : n.order;
        });
        layer.sort((a, b) => a.bary - b.bary || a.order - b.order);
        layer.forEach((n, i) => { n.order = i; });
    };
    let budgetHit = false;
    for (let pass = 0; pass < 6; pass++) {
        if (Date.now() - started > DIAGRAM_LAYOUT_MS) { budgetHit = true; break; }
        if (pass % 2 === 0) for (let r = 1; r < layers.length; r++) sweep(layers[r] || [], preds);
        else for (let r = layers.length - 2; r >= 0; r--) sweep(layers[r] || [], succs);
    }

    // 5. coordinates: layers centred on the widest one
    const widest = Math.max(1, ...layers.map(l => (l || []).length));
    const colW = NODE_W + GAP_X;
    layers.forEach((layer = []) => {
        const offset = (widest - layer.length) * colW / 2;
        layer.forEach(n => {
            n.x = MARGIN + offset + n.order * colW + NODE_W / 2;
            n.y = MARGIN + n.rank * (NODE_H + GAP_Y);
        });
    });
    const width = MARGIN * 2 + widest * colW - GAP_X;
    const height = MARGIN * 2 + layers.length * (NODE_H + GAP_Y) - GAP_Y;
    return { nodes, edges, width, height, budgetHit, ms: Date.now() - started };
}

// Loop returns (and self loops) leave the source sideways, run up outside every box in
// the rows they span, and enter the target from the same side. The side is the one whose
// horizontal parts cross fewer boxes in the source and target rows.
function routeBackEdges(layout) {
    const { nodes } = layout;
    const real = nodes.filter(n => !n.dummy);
    const lanes = { left: 0, right: 0 };
    for (const e of layout.edges.filter(x => x.back || x.from === x.to)) {
        const a = nodes[e.from], b = nodes[e.to];
        const lo = Math.min(a.rank, b.rank), hi = Math.max(a.rank, b.rank);
        const span = nodes.filter(n => n.rank >= lo && n.rank <= hi);
        const crossings = side => real.filter(n => (n.rank === a.rank && n !== a && (side === 'right' ? n.x > a.x : n.x < a.x))
            || (n.rank === b.rank && n !== b && (side === 'right' ? n.x > b.x : n.x < b.x))).length;
        e.side = crossings('left') < crossings('right') ? 'left' : 'right';
        e.lane = lanes[e.side]++ % 8;
        e.outerX = e.side === 'right'
            ? Math.max(...span.map(n => n.x + (n.dummy ? 6 : NODE_W / 2))) + BACK_GAP * (e.lane + 1)
            : Math.min(...span.map(n => n.x - (n.dummy ? 6 : NODE_W / 2))) - BACK_GAP * (e.lane + 1);
    }
    const minX = Math.min(MARGIN, ...layout.edges.filter(x => x.side === 'left').map(x => x.outerX - 30));
    const maxX = Math.max(layout.width, ...layout.edges.filter(x => x.side === 'right').map(x => x.outerX + 60));
    return { shiftX: MARGIN - minX, width: maxX + (MARGIN - minX) };
}

function edgePath(layout, e) {
    const { nodes } = layout;
    if (e.back || e.from === e.to) {
        const a = nodes[e.from], b = nodes[e.to];
        const dir = e.side === 'left' ? -1 : 1;
        const x1 = a.x + dir * NODE_W / 2, x2 = b.x + dir * NODE_W / 2, xo = e.outerX;
        const y1 = a.y + NODE_H / 2 + (e.lane % 2 ? 6 : 0), y2 = b.y + NODE_H / 2 - (e.lane % 2 ? 6 : 0);
        const r = Math.min(12, Math.abs(y1 - y2) / 2 || 12);
        const up = y2 < y1 ? -1 : 1;
        return {
            d: `M${x1},${y1} L${xo - dir * r},${y1} Q${xo},${y1} ${xo},${y1 + up * r} L${xo},${y2 - up * r} Q${xo},${y2} ${xo - dir * r},${y2} L${x2},${y2}`,
            lx: xo + dir * 4, ly: (y1 + y2) / 2, anchor: dir > 0 ? 'start' : 'end'
        };
    }
    const pts = e.path.map(id => nodes[id]);
    let d = `M${pts[0].x},${pts[0].y + NODE_H}`;
    for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        const y0 = i === 1 ? p.y + NODE_H : p.y + NODE_H / 2;
        const y1 = i === pts.length - 1 ? q.y : q.y + NODE_H / 2;
        const mid = (y0 + y1) / 2;
        d += ` C${p.x},${mid} ${q.x},${mid} ${q.x},${y1}`;
    }
    const first = pts[0], second = pts[1];
    return { d, lx: (first.x + second.x) / 2, ly: first.y + NODE_H + GAP_Y / 2 - 6 };
}

/**
 * opts.changes: Map name -> 'added'|'changed'  (compare badges)
 * opts.issues:  Map name -> [{severity, message}] (checks badges)
 */
function renderDiagramSvg(model, opts = {}) {
    const layout = layoutFlow(model);
    if (layout.stopped) return { svg: '', stopped: layout.stopped };

    // loop returns: pick a side and a lane; the drawing grows to fit them
    const { shiftX, width } = routeBackEdges(layout);
    const W = Math.ceil(width), H = Math.ceil(layout.height);

    let edgesSvg = '', labelsSvg = '';
    for (const e of layout.edges) {
        const { d, lx, ly, anchor } = edgePath(layout, e);
        const cls = e.fault ? 'edge fault' : e.back ? 'edge back' : 'edge';
        const marker = e.fault ? 'arrow-fault' : 'arrow';
        edgesSvg += `<path class="${cls}" d="${d}" marker-end="url(#${marker})"/>`;
        if (e.label) labelsSvg += `<text class="edge-label${e.fault ? ' fault' : ''}" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor || 'middle'}">${esc(clip(e.label, 30))}</text>`;
    }

    let nodesSvg = '';
    for (const n of layout.nodes) {
        if (n.dummy) continue;
        const el = n.el;
        const x = n.x - NODE_W / 2, y = n.y;
        const change = opts.changes && opts.changes.get(el.name);
        const issues = (opts.issues && opts.issues.get(el.name)) || [];
        const warn = issues.some(i => i.severity === 'warning');
        const cls = ['node', `type-${el.type}`, change ? `chg-${change}` : '', el.reached || el.name === 'Start' ? '' : 'unreached'].filter(Boolean).join(' ');
        const title = [el.name + (el.label ? ` (${el.label})` : ''), el.type, ...issues.map(i => `${i.severity === 'warning' ? '⚠' : 'ℹ'} ${i.message}`)].join('\n');
        nodesSvg += `<g class="${cls}" data-name="${esc(el.name)}" transform="translate(${x.toFixed(1)},${y})">`
            + `<title>${esc(title)}</title>`
            + `<rect class="node-box" width="${NODE_W}" height="${NODE_H}" rx="8"/>`
            + `<rect class="node-stripe" width="6" height="${NODE_H}" rx="3"/>`
            + `<text class="node-name" x="14" y="21">${esc(clip(el.name === 'Start' ? 'Start' : (el.label || el.name), 27))}</text>`
            + `<text class="node-type" x="14" y="40">${esc(clip(el.type + (el.label && el.label !== el.name ? ' · ' + el.name : ''), 32))}</text>`
            + (issues.length ? `<text class="node-badge${warn ? ' warn' : ''}" x="${NODE_W - 10}" y="18" text-anchor="end">${warn ? '⚠' : 'ℹ'}${issues.length > 1 ? issues.length : ''}</text>` : '')
            + (change ? `<text class="node-chg" x="${NODE_W - 10}" y="${NODE_H - 8}" text-anchor="end">${change}</text>` : '')
            + '</g>';
    }

    const svg = `<svg class="flow-diagram" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Flow diagram of ${esc(model.label)}">`
        + '<defs>'
        + '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow-head" d="M0,0 L10,5 L0,10 z"/></marker>'
        + '<marker id="arrow-fault" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow-head fault" d="M0,0 L10,5 L0,10 z"/></marker>'
        + '</defs>'
        + `<g transform="translate(${shiftX.toFixed(1)},0)"><g class="edges">${edgesSvg}</g><g class="edge-labels">${labelsSvg}</g><g class="nodes">${nodesSvg}</g></g></svg>`;
    return { svg, width: W, height: H, nodes: layout.nodes.filter(n => !n.dummy).length, edges: layout.edges.length, budgetHit: layout.budgetHit, ms: layout.ms };
}

module.exports = { layoutFlow, renderDiagramSvg, __routeBackEdges: routeBackEdges };
