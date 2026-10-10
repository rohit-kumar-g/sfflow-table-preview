'use strict';
// Port of FlowParser from the Chrome extension (scripts/popup.js).
// Same table columns, parameters and plain-English explanation, but it returns
// data instead of writing to the DOM, so the webview, the Markdown export and
// the AI summary are all built from one model.

const START = 'start';

// element list name in the metadata -> singular type shown in the table
const ELEMENT_LISTS = [
    'recordLookups', 'recordCreates', 'recordUpdates', 'recordDeletes', 'recordRollbacks',
    'assignments', 'decisions', 'screens', 'loops', 'steps', 'subflows', 'actionCalls',
    'apexPluginCalls', 'collectionProcessors', 'transforms', 'waits', 'customErrors',
    'dynamicChoiceSets', 'variables', 'textTemplates', 'formulas', 'constants', 'choices'
];

const RESOURCE_TYPES = new Set([
    'variable', 'textTemplate', 'formula', 'constant', 'choice', 'dynamicChoiceSet'
]);

function asArray(value) {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value : [value];
}

function defined(value) {
    return value !== undefined && value !== null && value !== '';
}

// "Label = value", or null when the value is missing (the Chrome version printed "undefined")
function kv(label, value) {
    return defined(value) ? `${label} = ${value}` : null;
}

function stripHtml(text) {
    return String(text).replace(/<\/?[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function oneLine(text) {
    return String(text).replace(/[\r\n]+/g, ' ').trim();
}

class FlowParser {
    constructor() {
        this.index = 0;
    }

    parseValue(value) {
        if (value === undefined || value === null) return 'null';
        if (typeof value !== 'object') return String(value);
        const theValue = value.apexValue ?? value.booleanValue ?? value.dateTimeValue
            ?? value.dateValue ?? value.elementReference ?? value.numberValue
            ?? value.sobjectValue ?? value.stringValue ?? value.formulaExpression
            ?? value.transformValueReference;
        if (theValue === undefined || theValue === null) return 'null';
        return theValue === '' ? '""' : String(theValue);
    }

    convertOperator(operator) {
        if (operator === undefined) return '=';
        return (operator.includes('Not') ? 'NOT ' : '')
            + (operator.includes('EqualTo') || operator.includes('Assign') ? '=' : operator.replace(/^Not/, ''));
    }

    // "1. Field = value" lines for filters, conditions and assignment items
    getFieldOperations(fieldOperations) {
        return asArray(fieldOperations).map((f, i) => {
            const field = f.field ?? f.assignToReference ?? f.leftValueReference;
            const value = f.value ?? f.rightValue;
            return `${i + 1}. ${field} ${this.convertOperator(f.operator)} ${this.parseValue(value)}`;
        });
    }

    getFilters(action) {
        const filters = asArray(action.filters);
        if (filters.length === 0) return [];
        const lines = ['Filters:'];
        if (defined(action.filterLogic) && action.filterLogic !== 'and') {
            lines.push(`Filter logic = ${action.filterLogic}`);
        }
        return lines.concat(this.getFieldOperations(filters));
    }

    namedValues(header, list) {
        const items = asArray(list);
        if (items.length === 0) return [];
        return [header].concat(items.map(i => `${i.field ?? i.name ?? i.assignToReference} = ${this.parseValue(i.value ?? i.assignToReference)}`));
    }

    addInputOutputParameters(action) {
        return [
            ...this.namedValues('Input assignments:', action.inputAssignments),
            ...this.namedValues('Output assignments:', action.outputAssignments),
            ...this.getFilters(action),
            ...this.namedValues('Input parameters:', action.inputParameters),
            ...this.namedValues('Output parameters:', action.outputParameters)
        ];
    }

    getStoreOutput(action) {
        return action.storeOutputAutomatically ? [`Store output? = ${action.storeOutputAutomatically}`] : [];
    }

    screenFields(fields, depth = 0) {
        const lines = [];
        asArray(fields).forEach(f => {
            const text = defined(f.fieldText) ? stripHtml(f.fieldText) : (f.name ?? f.extensionName ?? '');
            const parts = [text, f.dataType, f.fieldType, f.extensionName && f.extensionName !== text ? f.extensionName : null,
                f.objectFieldReference].filter(defined);
            lines.push('  '.repeat(depth) + parts.join(' '));
            if (f.fields) lines.push(...this.screenFields(f.fields, depth + 1));
        });
        return lines;
    }

    getParameters(action) {
        const p = [];
        switch (action.type) {
            case START: {
                const type = [action.triggerType, action.recordTriggerType].filter(defined).join(' ');
                p.push(kv('Type', type), kv('Object', action.object),
                    kv('Requires Record Changed To Meet Criteria', action.doesRequireRecordChangedToMeetCriteria));
                p.push(...this.getFilters(action));
                p.push(kv('Filter formula', action.filterFormula));
                if (action.schedule) {
                    p.push(`Schedule = ${[action.schedule.startDate, action.schedule.startTime, action.schedule.frequency].filter(defined).join(' ')}`);
                }
                break;
            }
            case 'assignment':
                p.push(...this.getFieldOperations(action.assignmentItems));
                break;
            case 'variable':
                p.push(`Type = ${(action.isCollection === 'true' ? 'Collection of ' : '') + action.dataType}`
                    + (defined(action.objectType) ? ` (${action.objectType})` : ''));
                p.push(kv('Input', action.isInput), kv('Output', action.isOutput));
                if (action.value) p.push(`Value = ${this.parseValue(action.value)}`);
                break;
            case 'constant':
                p.push(kv('Type', action.dataType), `Value = ${this.parseValue(action.value)}`);
                break;
            case 'textTemplate':
                p.push(kv('Text', defined(action.text) ? oneLine(action.text) : null), kv('Plain Text', action.isViewedAsPlainText));
                break;
            case 'formula':
                p.push(kv('Type', action.dataType), kv('Expression', defined(action.expression) ? oneLine(action.expression) : null));
                break;
            case 'choice':
                p.push(kv('Text', action.choiceText), kv('Type', action.dataType), `Value = ${this.parseValue(action.value)}`);
                break;
            case 'transform':
                p.push(kv('Target', action.objectType ?? action.dataType));
                asArray(action.transformValues).forEach(tv => {
                    asArray(tv.transformValueActions).forEach(ta => {
                        const v = this.parseValue(ta.value);
                        p.push(`${ta.transformType}: ${v !== 'null' ? v : 'formula'}`
                            + (ta.outputFieldApiName ? ' to ' + ta.outputFieldApiName : ''));
                    });
                });
                break;
            case 'collectionProcessor':
                p.push(kv('Collection', action.collectionReference), kv('Processing type', action.collectionProcessorType),
                    kv('Assign next value to', action.assignNextValueToReference), kv('Filter formula', action.formula),
                    kv('Output object', action.outputSObjectType));
                asArray(action.sortOptions).forEach(s => p.push(`Sort = ${s.sortField} ${s.sortOrder}`));
                p.push(...this.getFieldOperations(action.conditions));
                break;
            case 'dynamicChoiceSet':
                p.push(kv('Collection', action.collectionReference), kv('Type', action.dataType), kv('Object', action.object),
                    kv('Picklist object', action.picklistObject), kv('Picklist field', action.picklistField),
                    kv('Display field', action.displayField));
                p.push(...this.getFilters(action));
                break;
            case 'actionCall':
                p.push(kv('Type', action.actionType), ...this.getStoreOutput(action), ...this.addInputOutputParameters(action),
                    kv('Component Name', action.actionName));
                break;
            case 'apexPluginCall':
                p.push(kv('Apex class', action.apexClass), ...this.addInputOutputParameters(action));
                break;
            case 'subflow':
                p.push(kv('Flow', action.flowName), ...this.getStoreOutput(action), ...this.addInputOutputParameters(action));
                break;
            case 'recordLookup':
                p.push(kv('Object', action.object), kv('Assign null if no records?', action.assignNullValuesIfNoRecordsFound),
                    kv('First record only?', action.getFirstRecordOnly), ...this.getStoreOutput(action),
                    kv('Output reference', action.outputReference));
                if (asArray(action.queriedFields).length) p.push(`Fields = ${asArray(action.queriedFields).join(', ')}`);
                p.push(...this.getFilters(action));
                break;
            case 'recordCreate':
                p.push(kv('Object', action.object), kv('Input reference', action.inputReference),
                    kv('Assign id?', action.assignRecordIdToReference), ...this.getStoreOutput(action),
                    ...this.addInputOutputParameters(action));
                break;
            case 'recordUpdate':
                p.push(kv('Reference', action.inputReference), kv('Object', action.object), ...this.addInputOutputParameters(action));
                break;
            case 'recordDelete':
                p.push(kv('Reference', action.inputReference), kv('Object', action.object), ...this.getFilters(action));
                break;
            case 'screen':
                p.push(...this.screenFields(action.fields));
                break;
            case 'loop':
                p.push(kv('Collection', action.collectionReference), kv('Order', action.iterationOrder));
                break;
            case 'customError':
                asArray(action.customErrorMessages).forEach(m => {
                    p.push(`${m.isFieldError === 'true' ? 'Field ' + m.fieldSelection : 'Page'} error = ${oneLine(m.errorMessage ?? '')}`);
                });
                break;
            default:
                break;
        }
        return p.filter(line => line !== null && line !== undefined);
    }

    // Rows of the table for this element: [{ label, logic, conditions, next, nextNote }]
    getBranches(action) {
        const branches = [];
        const next = action.connector?.targetReference ?? action.defaultConnector?.targetReference;

        if (action.type === START) {
            const scheduled = asArray(action.scheduledPaths);
            if (action.connector?.targetReference || scheduled.length === 0) {
                branches.push({ label: 'Runs immediately', next: action.connector?.targetReference });
            }
            scheduled.forEach(s => {
                branches.push({
                    label: `${s.label ?? s.name} / ${s.offsetNumber ?? ''} ${s.offsetUnit ?? ''} `
                        + (s.timeSource === 'RecordField' ? s.recordField : 'RecordTriggerEvent'),
                    next: s.connector?.targetReference
                });
            });
            return branches;
        }

        if (action.type === 'loop') {
            branches.push({ label: 'Next value', next: action.nextValueConnector?.targetReference });
            branches.push({ label: 'No more values', next: action.noMoreValuesConnector?.targetReference });
            return branches;
        }

        if (action.type === 'wait') {
            asArray(action.waitEvents).forEach(w => {
                branches.push({
                    label: `${w.label} / Type: ${w.eventType}`,
                    conditions: this.getFieldOperations(w.conditions),
                    next: w.connector?.targetReference
                });
            });
            branches.push({ label: `Default: ${action.defaultConnectorLabel ?? 'default path'}`, next: action.defaultConnector?.targetReference });
            if (action.faultConnector?.targetReference) branches.push({ label: 'fault', next: action.faultConnector.targetReference });
            return branches;
        }

        if (action.type === 'decision') {
            asArray(action.rules).forEach(rule => {
                branches.push({
                    label: `${rule.label} (${rule.name})`,
                    logic: rule.conditionLogic,
                    conditions: this.getFieldOperations(rule.conditions),
                    next: rule.connector?.targetReference
                });
            });
            branches.push({ label: `Default: ${action.defaultConnectorLabel ?? 'Default Outcome'}`, next: action.defaultConnector?.targetReference });
            return branches;
        }

        if (RESOURCE_TYPES.has(action.type)) return branches;

        branches.push({ label: 'success', next, nextNote: action.defaultConnectorLabel });
        if (action.faultConnector?.targetReference) {
            branches.push({ label: 'fault', next: action.faultConnector.targetReference });
        }
        return branches;
    }

    // Branches used to number elements in execution order (same idea as the Chrome version)
    setExecutionBranches(element) {
        element.branchArray = [];
        element.branchLabelArray = [];
        const push = (target, label) => {
            if (target) {
                element.branchArray.push(target);
                element.branchLabelArray.push(label);
            }
        };
        if (element.type === 'decision') {
            asArray(element.rules).forEach(r => push(r.connector?.targetReference, `condition ${r.label} on ${element.label}`));
            push(element.defaultConnector?.targetReference, `${element.defaultConnectorLabel ?? 'default outcome'} on ${element.label}`);
            return;
        }
        push(element.connector?.targetReference ?? element.defaultConnector?.targetReference,
            element.type === START ? 'start' : `${element.label} succeeds`);
        push(element.faultConnector?.targetReference, `fails on ${element.label}`);
        if (element.type === 'loop') {
            push(element.nextValueConnector?.targetReference, `next value on ${element.label}`);
            push(element.noMoreValuesConnector?.targetReference, `no more values on ${element.label}`);
        }
        if (element.type === 'wait') {
            asArray(element.waitEvents).forEach(w => push(w.connector?.targetReference, `wait event ${w.label}`));
        }
        if (element.type === START) {
            asArray(element.scheduledPaths).forEach(s => push(s.connector?.targetReference, `scheduled path ${s.label ?? s.name}`));
        }
    }

    // Numbers elements in execution order (depth-first along each outcome, like the Chrome
    // version). Iterative with an explicit stack, so very long flows cannot overflow the call stack.
    assignIndexToElements(actionMap, firstElement, parentBranch, conditionLabel) {
        const stack = [];
        const enter = (el, parent, label) => {
            this.index++;
            el.index = this.index;
            el.parentBranch = parent;
            el.conditionLabel = label;
            // an element with 2+ outgoing branches becomes the parent of what follows
            stack.push({ el, i: 0, parentNext: el.branchArray.length > 1 ? el : parent, label });
        };
        enter(firstElement, parentBranch, conditionLabel);
        while (stack.length) {
            const frame = stack[stack.length - 1];
            const count = frame.el.branchArray.length;
            if (frame.i >= count) {
                stack.pop();
                continue;
            }
            const i = frame.i++;
            const target = actionMap.get(frame.el.branchArray[i]);
            if (!target || target.index) continue; // missing or already visited
            enter(target, frame.parentNext, count > 1 ? frame.el.branchLabelArray[i] : frame.label);
        }
    }

    explain(actionMap) {
        const lines = [];
        for (const action of actionMap.values()) {
            if (!action.index) continue;
            const parent = action.parentBranch;
            let parentBranchAction = '';
            if (parent) {
                parentBranchAction = ({
                    decision: 'after checking', start: 'at the', loop: 'when loop has',
                    actionCall: 'after calling action', wait: 'after event'
                })[parent.type] ?? '';
            }
            const conditionExplained = `${parentBranchAction} ${action.conditionLabel ?? ''}`.trim();
            const t = action.type;
            let text = null;
            if (t === 'recordCreate' || t === 'recordUpdate' || t === 'recordDelete' || t === 'recordRollback') {
                text = `${t.replace('record', '').toLowerCase()}s ${action.object ?? action.inputReference ?? ''}`;
            } else if (t === 'recordLookup') {
                text = `queries ${action.object}`;
            } else if (t === 'actionCall') {
                text = `calls action ${action.label}`;
            } else if (t === 'apexPluginCall') {
                text = `calls Apex plugin ${action.apexClass ?? action.label}`;
            } else if (t === 'subflow') {
                text = `calls subflow ${action.flowName ?? action.label}`;
            } else if (t === 'screen') {
                text = `prompts screen ${action.label}`;
            } else if (t === 'customError') {
                text = `shows custom error ${action.label}`;
            } else if (t === 'transform') {
                text = `transforms ${action.objectType ?? action.dataType}`;
            }
            if (text) lines.push(`${text} ${conditionExplained}`.replace(/\s+/g, ' ').trim());
        }
        return lines;
    }

    parse(flowDefinition, apiName) {
        const def = flowDefinition || {};

        // identify initial step (record-triggered/new flows use <start>, legacy ones startElementReference)
        let firstElement = def.start && typeof def.start === 'object' ? { ...def.start } : null;
        if (!firstElement) {
            firstElement = { connector: { targetReference: def.startElementReference } };
        }
        firstElement.name = 'Start';
        firstElement.label = 'Start';
        firstElement.type = START;

        const actionMap = new Map();
        actionMap.set(firstElement.name, firstElement);

        const order = []; // definition order, for elements that are never reached
        for (const listName of ELEMENT_LISTS) {
            asArray(def[listName]).forEach(raw => {
                if (!raw || typeof raw !== 'object' || !raw.name) return;
                const element = { ...raw, type: listName.substring(0, listName.length - 1) };
                actionMap.set(element.name, element);
                order.push(element.name);
            });
        }

        for (const element of actionMap.values()) {
            element.kind = RESOURCE_TYPES.has(element.type) ? 'resource' : 'step';
            element.parameters = this.getParameters(element);
            element.branches = this.getBranches(element);
            this.setExecutionBranches(element);
        }

        this.index = 0;
        this.assignIndexToElements(actionMap, firstElement, firstElement, 'start');

        // order: reached steps by execution index, then unreached steps, then resources
        const rank = e => (e.kind === 'resource' ? 2e9 : (e.index ? e.index : 1e9));
        const sorted = [...actionMap.values()]
            .map((e, i) => ({ e, i }))
            .sort((a, b) => (rank(a.e) - rank(b.e)) || (a.i - b.i))
            .map(x => x.e);
        const ordered = new Map(sorted.map(e => [e.name, e]));

        // who points to each element ("Prev. element" in the Chrome version): one entry per
        // outcome, so a link can go to the exact row of that outcome
        const incoming = new Map();
        for (const e of ordered.values()) {
            e.branches.forEach((b, i) => {
                if (!b.next) return;
                if (!incoming.has(b.next)) incoming.set(b.next, []);
                incoming.get(b.next).push({ name: e.name, branch: i, label: b.label ?? '' });
            });
        }

        const elements = sorted.map(e => ({
            name: e.name,
            label: e.name === 'Start' ? '' : (e.label ?? ''),
            description: defined(e.description) ? oneLine(e.description) : '',
            type: e.type,
            kind: e.kind,
            reached: Boolean(e.index),
            parameters: e.parameters,
            branches: e.branches.map(b => ({
                label: b.label ?? '',
                logic: b.logic ?? '',
                conditions: b.conditions ?? [],
                next: b.next ?? '',
                nextNote: b.nextNote ?? '',
                nextExists: Boolean(b.next && ordered.has(b.next))
            })),
            from: incoming.get(e.name) ?? []
        }));

        return {
            apiName: apiName ?? '',
            label: def.label ?? apiName ?? 'Flow',
            description: defined(def.description) ? oneLine(def.description) : '',
            processType: def.processType ?? '',
            triggerType: def.start?.triggerType ?? '',
            object: def.start?.object ?? '',
            status: def.status ?? '',
            apiVersion: def.apiVersion ?? '',
            explanation: this.explain(ordered),
            elements,
            counts: {
                steps: elements.filter(e => e.kind === 'step' && e.name !== 'Start').length,
                unreached: elements.filter(e => e.kind === 'step' && !e.reached).length,
                resources: elements.filter(e => e.kind === 'resource').length
            }
        };
    }
}

function buildFlowModel(flowDefinition, apiName) {
    return new FlowParser().parse(flowDefinition, apiName);
}

module.exports = { buildFlowModel, FlowParser, asArray };
