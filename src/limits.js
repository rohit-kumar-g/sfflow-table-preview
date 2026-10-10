'use strict';
// Hard limits: past these the extension stops and says why instead of working on
// (a stopped feature is better than a frozen editor). Everything else is linear or close.

module.exports = {
    // flows larger than this are not parsed live (preview, hover, checks, outline)
    MAX_XML_CHARS: 5 * 1024 * 1024,
    // the diagram is not drawn above this many steps
    DIAGRAM_MAX_NODES: 400,
    // crossing reduction in the diagram layout stops after this long
    DIAGRAM_LAYOUT_MS: 150,
    // line-by-line diff of one element: above this lines(before) x lines(after) a simple
    // set comparison is used instead
    DIFF_MAX_CELLS: 250000,
    // checks stop after this long and report that they were cut short
    CHECKS_MS: 300
};
