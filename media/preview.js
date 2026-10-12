// Webview side of the flow preview. Receives rendered HTML from the extension; handles the
// Table/Diagram tabs, diagram zoom and drag, links between elements, filtering and AI answers.
(function () {
    const vscode = acquireVsCodeApi();
    const state = vscode.getState() || {};
    const $ = id => document.getElementById(id);
    const content = $('content');
    const errorBox = $('error');
    const filter = $('filter');
    const showResources = $('showResources');
    const question = $('question');
    const aiBox = $('ai');
    const aiText = $('aiText');
    const aiModel = $('aiModel');

    filter.value = state.filter || '';
    question.value = state.question || '';
    if (typeof state.showResources === 'boolean') showResources.checked = state.showResources;

    function save(patch) {
        Object.assign(state, patch);
        vscode.setState(state);
    }

    function applyFilters() {
        const needle = filter.value.trim().toLowerCase();
        const groups = new Map();
        content.querySelectorAll('#flowTable tbody tr').forEach(tr => {
            const g = tr.dataset.group;
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(tr);
        });
        let shown = 0;
        groups.forEach(rows => {
            const first = rows[0];
            const isResource = first.classList.contains('kind-resource');
            const text = (first.dataset.search || '') + ' ' + rows.map(r => r.textContent.toLowerCase()).join(' ');
            const visible = (!isResource || showResources.checked) && (!needle || text.includes(needle));
            rows.forEach(r => { r.hidden = !visible; });
            if (visible) shown++;
        });
        const count = $('rowCount');
        if (count) count.textContent = needle ? `${shown} matching` : '';
    }

    function flash(el) {
        el.classList.remove('flash');
        void el.offsetWidth; // restart animation
        el.classList.add('flash');
    }

    // ---------- Table | Diagram ----------
    function setView(view, tell = true) {
        state.view = view === 'diagram' ? 'diagram' : 'table';
        save({ view: state.view });
        const table = $('tableView'), diagram = $('diagramView');
        if (table) table.hidden = state.view !== 'table';
        if (diagram) diagram.hidden = state.view !== 'diagram';
        content.querySelectorAll('.view-tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
        // the extension builds the diagram only when it is shown
        if (tell) vscode.postMessage({ type: 'view', view: state.view });
    }

    // show a table cell (switches from the diagram to the table if needed)
    function gotoCell(id) {
        const cell = document.getElementById(id);
        if (!cell) return;
        if (state.view === 'diagram') setView('table');
        const row = cell.closest('tr');
        if (row && row.hidden) { // make sure the target is visible
            filter.value = '';
            if (row.classList.contains('kind-resource')) showResources.checked = true;
            save({ filter: '', showResources: showResources.checked });
            applyFilters();
        }
        scrollToCell(cell);
        if (cell.classList.contains('next')) {
            // an outcome row ("From" link): highlight that outcome and where it goes
            cell.parentElement.querySelectorAll('td.cond, td.next').forEach(flash);
        } else {
            flash(cell);
        }
    }

    // zoom: the SVG keeps its viewBox; only its displayed width changes
    function applyZoom() {
        const svg = content.querySelector('#diagramView svg.flow-diagram');
        if (!svg) return;
        const base = Number(svg.getAttribute('width')) || svg.viewBox.baseVal.width;
        const scroller = svg.closest('.diagram-scroll');
        // "Fit" = the inner width of the scroll area (border and scrollbar excluded); measured
        // twice because shrinking can remove/add the vertical scrollbar
        for (let pass = 0; pass < 2; pass++) {
            const zoom = state.zoom || Math.min(1, (scroller.clientWidth - 2) / base);
            svg.style.width = Math.max(50, Math.round(base * zoom)) + 'px';
            svg.style.height = 'auto';
        }
    }
    function zoomBy(kind) {
        const svg = content.querySelector('#diagramView svg.flow-diagram');
        if (!svg) return;
        const base = Number(svg.getAttribute('width'));
        const current = svg.getBoundingClientRect().width / base;
        const next = kind === 'fit' ? null : Math.min(3, Math.max(0.2, current * (kind === 'in' ? 1.25 : 0.8)));
        save({ zoom: next });
        applyZoom();
    }

    // drag to pan inside the diagram; a drag never counts as a click on a box
    let drag = null;
    content.addEventListener('mousedown', e => {
        const scroller = e.target.closest('.diagram-scroll');
        if (!scroller || e.button !== 0) return;
        drag = { scroller, x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, moved: false };
    });
    window.addEventListener('mousemove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
            drag.scroller.scrollLeft = drag.left - dx;
            drag.scroller.scrollTop = drag.top - dy;
            drag.scroller.classList.add('dragging');
        }
    });
    window.addEventListener('mouseup', () => {
        if (drag) drag.scroller.classList.remove('dragging');
        setTimeout(() => { drag = null; }, 0);
    });
    content.addEventListener('wheel', e => {
        if (!(e.ctrlKey || e.metaKey) || !e.target.closest('.diagram-scroll')) return;
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 'in' : 'out');
    }, { passive: false });

    content.addEventListener('click', e => {
        const tab = e.target.closest('.view-tabs button[data-view]');
        if (tab) {
            setView(tab.dataset.view);
            return;
        }
        const zoom = e.target.closest('button[data-zoom]');
        if (zoom) {
            zoomBy(zoom.dataset.zoom);
            return;
        }
        const node = e.target.closest('g.node[data-name]');
        if (node) {
            if (drag && drag.moved) return;
            const name = node.dataset.name;
            if (e.ctrlKey || e.metaKey) vscode.postMessage({ type: 'reveal', name });
            else gotoCell('el-' + name.replace(/[^A-Za-z0-9_-]/g, '_'));
            return;
        }
        const action = e.target.closest('button[data-action]');
        if (action) {
            vscode.postMessage({ type: action.dataset.action });
            return;
        }
        const goto = e.target.closest('a.goto');
        if (goto) {
            e.preventDefault();
            gotoCell(goto.dataset.target);
            return;
        }
        const reveal = e.target.closest('a.reveal');
        if (reveal) {
            e.preventDefault(); // opens the XML; the preview itself does not move
            vscode.postMessage({ type: 'reveal', name: reveal.dataset.name });
        }
    });

    // In-page links have no href (see render.js gotoLink), so make them keyboard-usable
    content.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('a.goto, a.reveal')) {
            e.preventDefault();
            e.target.click();
        }
    });

    // Sticky toolbar + sticky table header cover the top of the page. Their real height
    // (the toolbar wraps on narrow panels) is kept in --sticky-top for the CSS and the jumps.
    const toolbar = $('toolbar');
    function stickyHeights() {
        const thead = content.querySelector('#flowTable thead');
        return { toolbar: toolbar.offsetHeight, header: thead ? thead.offsetHeight : 0 };
    }
    function updateStickyTop() {
        document.documentElement.style.setProperty('--sticky-top', toolbar.offsetHeight + 'px');
    }
    if (window.ResizeObserver) new ResizeObserver(updateStickyTop).observe(toolbar);
    updateStickyTop();

    // Put the top of the element's row just below the sticky toolbar and table header.
    // (scrollIntoView centred the cell, so a tall cell's top ended up under the header.)
    function scrollToCell(cell) {
        const { toolbar: t, header: h } = stickyHeights();
        const top = cell.getBoundingClientRect().top + window.scrollY - t - h - 6;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }

    filter.addEventListener('input', () => { save({ filter: filter.value }); applyFilters(); });
    showResources.addEventListener('change', () => { save({ showResources: showResources.checked }); applyFilters(); });
    question.addEventListener('input', () => save({ question: question.value }));
    question.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); $('askAi').click(); }
    });

    $('askAi').addEventListener('click', () => vscode.postMessage({ type: 'askAi', question: question.value }));
    $('saveMd').addEventListener('click', () => vscode.postMessage({ type: 'saveMarkdown' }));
    $('saveHtml').addEventListener('click', () => vscode.postMessage({ type: 'saveHtml' }));
    $('openSource').addEventListener('click', () => vscode.postMessage({ type: 'openSource' }));
    $('compare').addEventListener('click', () => vscode.postMessage({ type: 'compare' }));
    $('compareFile').addEventListener('click', () => vscode.postMessage({ type: 'compareFile' }));
    // footer feedback links (no href: the extension opens the GitHub page)
    const feedback = $('feedback');
    feedback.addEventListener('click', e => {
        const a = e.target.closest('a[data-feedback]');
        if (a) vscode.postMessage({ type: 'feedback', kind: a.dataset.feedback });
    });
    feedback.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('a[data-feedback]')) { e.preventDefault(); e.target.click(); }
    });
    window.addEventListener('resize', () => { if (!state.zoom) applyZoom(); });
    $('aiClose').addEventListener('click', () => { aiBox.hidden = true; });

    window.addEventListener('message', event => {
        const msg = event.data || {};
        if (msg.sourceUri) save({ sourceUri: msg.sourceUri });
        switch (msg.type) {
            case 'render': {
                // re-renders (typing in the XML, closing a comparison...) keep the scroll position
                const scrollY = window.scrollY;
                errorBox.hidden = true;
                if (typeof state.showResources !== 'boolean') showResources.checked = Boolean(msg.showResources);
                content.innerHTML = msg.html;
                const facts = content.querySelector('.facts');
                if (facts && !$('rowCount')) {
                    const span = document.createElement('span');
                    span.id = 'rowCount';
                    span.className = 'fact muted';
                    facts.appendChild(span);
                }
                applyFilters();
                setView(state.view || 'table', false);
                applyZoom();
                window.scrollTo(0, scrollY);
                break;
            }
            case 'error':
                errorBox.textContent = msg.text;
                errorBox.hidden = false;
                if (!msg.keep) content.innerHTML = '';
                break;
            case 'aiStart':
                aiBox.hidden = false;
                aiBox.classList.add('busy');
                aiModel.textContent = msg.model || '';
                aiText.textContent = '';
                break;
            case 'aiChunk':
                aiText.textContent += msg.text;
                break;
            case 'aiDone':
                aiBox.classList.remove('busy');
                break;
            case 'aiError':
                aiBox.hidden = false;
                aiBox.classList.remove('busy');
                aiText.textContent += (aiText.textContent ? '\n\n' : '') + 'Error: ' + msg.text;
                break;
        }
    });

    vscode.postMessage({ type: 'ready', view: state.view || 'table' });
})();
