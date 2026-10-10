'use strict';
// Parses Salesforce Flow metadata XML (*.flow-meta.xml / *.flow) into the same
// object shape the Chrome extension received from the Tooling API (Flow.Metadata),
// so the ported FlowParser logic can read it unchanged.

const { XMLParser, XMLValidator } = require('fast-xml-parser');

// Tags that can repeat. XML has no arrays, so a list with one entry would
// otherwise come back as a plain object; these are always returned as arrays.
const ARRAY_TAGS = new Set([
    // top-level flow elements and resources
    'actionCalls', 'apexPluginCalls', 'assignments', 'choices', 'collectionProcessors',
    'constants', 'customErrors', 'decisions', 'dynamicChoiceSets', 'formulas', 'loops',
    'orchestratedStages', 'recordCreates', 'recordDeletes', 'recordLookups',
    'recordRollbacks', 'recordUpdates', 'screens', 'stages', 'steps', 'subflows',
    'textTemplates', 'transforms', 'variables', 'waits', 'processMetadataValues',
    'customProperties',
    // nested lists
    'rules', 'conditions', 'filters', 'inputAssignments', 'outputAssignments',
    'inputParameters', 'outputParameters', 'assignmentItems', 'fields', 'scheduledPaths',
    'waitEvents', 'transformValues', 'transformValueActions', 'sortOptions',
    'choiceReferences', 'queriedFields', 'dataTypeMappings', 'capabilityTypes',
    'customErrorMessages', 'stageSteps', 'entryActionInputParameters',
    'exitActionInputParameters', 'exitActionOutputParameters', 'connectors',
    'storeOutputParameters'
]);

function parseFlowXml(xmlText) {
    const parser = new XMLParser({
        ignoreAttributes: true,
        parseTagValue: false,      // keep values as written ("001...", "5.0", "true")
        trimValues: true,
        processEntities: true,     // &lt;p&gt; -> <p>
        htmlEntities: true,
        isArray: (tagName) => ARRAY_TAGS.has(tagName)
    });

    // the parser is lenient with broken XML, so validate first to get a clear error
    const valid = XMLValidator.validate(xmlText);
    if (valid !== true) {
        const err = valid.err || {};
        const unclosed = /Invalid '\[([\s\S]*)\]' found/.exec(err.msg || '');
        if (unclosed) {
            err.msg = 'unclosed tag(s): ' + unclosed[1].replace(/["\s]/g, '').split(',').map(t => `<${t}>`).join(', ');
        }
        throw new Error(`The XML is not valid${err.line ? ` (line ${err.line}, column ${err.col})` : ''}: ${err.msg || 'unknown error'}`);
    }

    let parsed;
    try {
        parsed = parser.parse(xmlText);
    } catch (e) {
        throw new Error('The XML could not be parsed: ' + e.message);
    }

    const flow = parsed && parsed.Flow;
    if (!flow || typeof flow !== 'object') {
        throw new Error('This file is not Salesforce Flow metadata (no <Flow> root element).');
    }
    return flow;
}

const FLOW_ROOT_PATTERN = /<Flow\s+xmlns="http:\/\/soap\.sforce\.com\/2006\/04\/metadata"/;
const FLOW_FILE_PATTERN = /\.flow(-meta\.xml)?$/i;

function looksLikeFlow(fileName, headText) {
    return FLOW_FILE_PATTERN.test(fileName || '') || FLOW_ROOT_PATTERN.test(headText || '');
}

// One pass over the XML text: every top-level child of <Flow> with its offsets.
//   { tag, name, start, end, nameStart, nameEnd }
// name is the element's own <name> (only a <name> directly inside the top-level element,
// so a decision rule or screen field is never mistaken for an element); <start> and
// <startElementReference> get the name "Start". Linear in the text size.
function indexElements(xmlText) {
    const tagRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g;
    const out = [];
    let depth = 0;
    let current = null; // top-level element being read
    let m;
    while ((m = tagRe.exec(xmlText))) {
        const [whole, closing, tag, selfClosing] = m;
        if (!tag) continue; // comment, declaration, CDATA
        if (closing) {
            if (depth === 2 && current) {
                current.end = m.index + whole.length;
                if (current.tag === 'start' || current.tag === 'startElementReference') {
                    current.name = 'Start';
                    current.nameStart = current.start;
                    current.nameEnd = current.start + current.tag.length + 2;
                }
                out.push(current);
                current = null;
            }
            depth--;
            continue;
        }
        if (selfClosing) continue;
        depth++;
        if (depth === 2) {
            current = { tag, name: null, start: m.index, end: -1, nameStart: -1, nameEnd: -1 };
        } else if (depth === 3 && tag === 'name' && current && current.name === null) {
            const textStart = m.index + whole.length;
            const textEnd = xmlText.indexOf('<', textStart);
            const raw = xmlText.substring(textStart, textEnd);
            current.name = raw.trim();
            current.nameStart = textStart + (raw.length - raw.trimStart().length);
            current.nameEnd = current.nameStart + current.name.length;
        }
    }
    return out;
}

// Where a flow element sits in the XML text: the whole top-level block
// (e.g. <decisions>...</decisions>) whose own <name> is `name`; "Start" is the
// <start> block or <startElementReference>. Returns { start, end } offsets or null.
function findElementRange(xmlText, name) {
    const found = indexElements(xmlText).find(e => e.name === name);
    return found ? { start: found.start, end: found.end } : null;
}

function flowApiName(fileName) {
    const base = String(fileName || 'Flow').split(/[\\/]/).pop();
    return base.replace(/\.flow-meta\.xml$/i, '').replace(/\.flow$/i, '').replace(/\.xml$/i, '');
}

module.exports = { parseFlowXml, looksLikeFlow, flowApiName, findElementRange, indexElements, ARRAY_TAGS };
