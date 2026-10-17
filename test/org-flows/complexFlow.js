'use strict';
// Builds the XML of the test flow SFFlowPreview_Test_Complex, version 1..5.
// Autolaunched (no trigger), standard objects only, so deploying it to a dev org
// never runs on real records. Each version changes something the compare view must show.
//   v1 Active  base flow
//   v2 Active  decision logic gets a 4th condition, assignment value changes, email action added
//   v3 Active  Warm branch's update + text template removed and rewired, filter element added
//   v4 Active  flow label/description, extra lookup filter, sort order and constant value change
//   v5 Draft   "Has Opps" decision inserted before the update

const API_NAME = 'SFFlowPreview_Test_Complex';

const val = v => {
    if (typeof v === 'number') return `<numberValue>${v.toFixed(1)}</numberValue>`;
    if (typeof v === 'boolean') return `<booleanValue>${v}</booleanValue>`;
    if (v && v.ref) return `<elementReference>${v.ref}</elementReference>`;
    return `<stringValue>${v}</stringValue>`;
};
const ref = r => ({ ref: r });
const loc = '<locationX>0</locationX>\n        <locationY>0</locationY>';
const head = (name, label) => `<name>${name}</name>\n        <label>${label}</label>\n        ${loc}`;
const connector = (tag, target) => (target ? `<${tag}>\n            <targetReference>${target}</targetReference>\n        </${tag}>` : '');
const condition = (left, op, right) => `<conditions>
            <leftValueReference>${left}</leftValueReference>
            <operator>${op}</operator>
            <rightValue>${val(right)}</rightValue>
        </conditions>`;
const filter = (field, op, value) => `<filters>
            <field>${field}</field>
            <operator>${op}</operator>
            <value>${val(value)}</value>
        </filters>`;
const assign = (field, value) => `<inputAssignments>
            <field>${field}</field>
            <value>${val(value)}</value>
        </inputAssignments>`;

function build(version) {
    const v = version;
    // Sort works in place (no output collection), so the loop/filter read Get_Open_Opps
    const loopSource = v >= 3 ? 'Filter_Big_Opps' : 'Get_Open_Opps';
    const afterLoop = v >= 5 ? 'Has_Opps' : 'Update_Opps';
    const warmTarget = v >= 3 ? 'Create_Followup_Task' : 'Update_Account_Description';

    const actionCalls = v >= 2 ? `    <actionCalls>
        ${head('Notify_Owner', 'Notify Owner')}
        <actionName>emailSimple</actionName>
        <actionType>emailSimple</actionType>
        <flowTransactionModel>CurrentTransaction</flowTransactionModel>
        <inputParameters>
            <name>emailAddresses</name>
            <value>${val('owner-alerts@example.com')}</value>
        </inputParameters>
        <inputParameters>
            <name>emailSubject</name>
            <value>${val('Hot account needs review')}</value>
        </inputParameters>
        <inputParameters>
            <name>emailBody</name>
            <value>${val(ref('HotEmailBody'))}</value>
        </inputParameters>
        <nameSegment>emailSimple</nameSegment>
        <storeOutputAutomatically>true</storeOutputAutomatically>
    </actionCalls>
` : '';

    const filterProcessor = v >= 3 ? `    <collectionProcessors>
        <name>Filter_Big_Opps</name>
        <elementSubtype>FilterCollectionProcessor</elementSubtype>
        <label>Filter Big Opps</label>
        ${loc}
        <assignNextValueToReference>currentItem_Filter_Big_Opps</assignNextValueToReference>
        <collectionProcessorType>FilterCollectionProcessor</collectionProcessorType>
        <collectionReference>Get_Open_Opps</collectionReference>
        <conditionLogic>and</conditionLogic>
        ${condition('currentItem_Filter_Big_Opps.Amount', 'GreaterThanOrEqualTo', 10000)}
        ${connector('connector', 'Loop_Opps')}
    </collectionProcessors>
` : '';

    const hasOpps = v >= 5 ? `    <decisions>
        ${head('Has_Opps', 'Has Opps')}
        ${connector('defaultConnector', 'Create_Followup_Task')}
        <defaultConnectorLabel>Nothing to update</defaultConnectorLabel>
        <rules>
            <name>Opps_Found</name>
            <conditionLogic>and</conditionLogic>
            ${condition('oppsToUpdate', 'IsNull', false)}
            ${connector('connector', 'Update_Opps')}
            <label>Opps Found</label>
        </rules>
    </decisions>
` : '';

    const hotConditions = [
        condition('Get_Account.Rating', 'EqualTo', 'Hot'),
        condition('Get_Account.AnnualRevenue', 'GreaterThan', ref('HighValueThreshold')),
        condition('Get_Account.NumberOfEmployees', 'GreaterThan', 500)
    ];
    if (v >= 2) hotConditions.push(condition('Get_Account.Industry', 'EqualTo', 'Technology'));

    const updateDescription = v < 3 ? `    <recordUpdates>
        ${head('Update_Account_Description', 'Update Account Description')}
        <filterLogic>and</filterLogic>
        ${filter('Id', 'EqualTo', ref('Get_Account.Id'))}
        ${assign('Description', ref('WarmText'))}
        <object>Account</object>
    </recordUpdates>
` : '';

    const warmText = v < 3 ? `    <textTemplates>
        <name>WarmText</name>
        <isViewedAsPlainText>true</isViewedAsPlainText>
        <text>Warm account reviewed on {!$Flow.CurrentDate}</text>
    </textTemplates>
` : '';

    const hotEmail = v >= 2 ? `    <textTemplates>
        <name>HotEmailBody</name>
        <isViewedAsPlainText>true</isViewedAsPlainText>
        <text>Account {!Get_Account.Name} is hot. Open opportunities were moved to executive review.</text>
    </textTemplates>
` : '';

    const filterVariable = v >= 3 ? `    <variables>
        <name>currentItem_Filter_Big_Opps</name>
        <dataType>SObject</dataType>
        <isCollection>false</isCollection>
        <isInput>false</isInput>
        <isOutput>false</isOutput>
        <objectType>Opportunity</objectType>
    </variables>
` : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
${actionCalls}    <apiVersion>62.0</apiVersion>
    <assignments>
        ${head('Set_Next_Step', 'Set Next Step')}
        <assignmentItems>
            <assignToReference>currentOpp.NextStep</assignToReference>
            <operator>Assign</operator>
            <value>${val(v >= 2 ? 'Exec review - priority' : 'Executive review')}</value>
        </assignmentItems>
        <assignmentItems>
            <assignToReference>oppsToUpdate</assignToReference>
            <operator>Add</operator>
            <value>${val(ref('currentOpp'))}</value>
        </assignmentItems>
        ${connector('connector', 'Loop_Opps')}
    </assignments>
${filterProcessor}    <collectionProcessors>
        <name>Sort_Opps</name>
        <elementSubtype>SortCollectionProcessor</elementSubtype>
        <label>Sort Opps</label>
        ${loc}
        <collectionProcessorType>SortCollectionProcessor</collectionProcessorType>
        <collectionReference>Get_Open_Opps</collectionReference>
        ${connector('connector', v >= 3 ? 'Filter_Big_Opps' : 'Loop_Opps')}
        <sortOptions>
            <doesPutEmptyStringAndNullFirst>false</doesPutEmptyStringAndNullFirst>
            <sortField>Amount</sortField>
            <sortOrder>${v >= 4 ? 'Asc' : 'Desc'}</sortOrder>
        </sortOptions>
    </collectionProcessors>
    <constants>
        <name>HighValueThreshold</name>
        <dataType>Number</dataType>
        <value>${val(v >= 4 ? 2500000 : 1000000)}</value>
    </constants>
    <decisions>
        ${head('Check_Account', 'Check Account')}
        <defaultConnectorLabel>Not a target</defaultConnectorLabel>
        <rules>
            <name>Is_Hot</name>
            <conditionLogic>${v >= 2 ? '1 AND (2 OR 3 OR 4)' : '1 AND (2 OR 3)'}</conditionLogic>
            ${hotConditions.join('\n            ')}
            ${connector('connector', 'Get_Open_Opps')}
            <label>Is Hot</label>
        </rules>
        <rules>
            <name>Is_Warm</name>
            <conditionLogic>and</conditionLogic>
            ${condition('Get_Account.Rating', 'EqualTo', 'Warm')}
            ${connector('connector', warmTarget)}
            <label>Is Warm</label>
        </rules>
    </decisions>
${hasOpps}    <description>${v >= 4
        ? 'Test flow for Salesforce Flow Table Preview (compare with org versions). Safe to delete. Reviews hot and warm accounts.'
        : 'Test flow for Salesforce Flow Table Preview (compare with org versions). Safe to delete.'}</description>
    <environments>Default</environments>
    <formulas>
        <name>FollowUpDate</name>
        <dataType>Date</dataType>
        <expression>TODAY() + 7</expression>
    </formulas>
    <interviewLabel>SFFlowPreview Test Complex {!$Flow.CurrentDateTime}</interviewLabel>
    <label>${v >= 4 ? 'SFFlowPreview Test Complex (account review)' : 'SFFlowPreview Test Complex'}</label>
    <loops>
        ${head('Loop_Opps', 'Loop Opps')}
        <assignNextValueToReference>currentOpp</assignNextValueToReference>
        <collectionReference>${loopSource}</collectionReference>
        <iterationOrder>Asc</iterationOrder>
        ${connector('nextValueConnector', 'Set_Next_Step')}
        ${connector('noMoreValuesConnector', afterLoop)}
    </loops>
    <processMetadataValues>
        <name>BuilderType</name>
        <value>
            <stringValue>LightningFlowBuilder</stringValue>
        </value>
    </processMetadataValues>
    <processMetadataValues>
        <name>CanvasMode</name>
        <value>
            <stringValue>AUTO_LAYOUT_CANVAS</stringValue>
        </value>
    </processMetadataValues>
    <processMetadataValues>
        <name>OriginBuilderType</name>
        <value>
            <stringValue>LightningFlowBuilder</stringValue>
        </value>
    </processMetadataValues>
    <processType>AutoLaunchedFlow</processType>
    <recordCreates>
        ${head('Create_Error_Task', 'Create Error Task')}
        ${assign('Subject', 'Flow error: {!$Flow.FaultMessage}')}
        ${assign('WhatId', ref('Get_Account.Id'))}
        <object>Task</object>
        <storeOutputAutomatically>true</storeOutputAutomatically>
    </recordCreates>
    <recordCreates>
        ${head('Create_Followup_Task', 'Create Follow-up Task')}
        ${connector('connector', v >= 2 ? 'Notify_Owner' : null)}
        ${assign('ActivityDate', ref('FollowUpDate'))}
        ${assign('OwnerId', ref('Get_Account.OwnerId'))}
        ${assign('Subject', 'Review hot account')}
        ${assign('WhatId', ref('Get_Account.Id'))}
        <object>Task</object>
        <storeOutputAutomatically>true</storeOutputAutomatically>
    </recordCreates>
    <recordLookups>
        ${head('Get_Account', 'Get Account')}
        <assignNullValuesIfNoRecordsFound>false</assignNullValuesIfNoRecordsFound>
        ${connector('connector', 'Check_Account')}
        <filterLogic>and</filterLogic>
        ${filter('Id', 'EqualTo', ref('recordId'))}
        <getFirstRecordOnly>true</getFirstRecordOnly>
        <object>Account</object>
        <storeOutputAutomatically>true</storeOutputAutomatically>
    </recordLookups>
    <recordLookups>
        ${head('Get_Open_Opps', 'Get Open Opps')}
        <assignNullValuesIfNoRecordsFound>false</assignNullValuesIfNoRecordsFound>
        ${connector('connector', 'Sort_Opps')}
        <filterLogic>and</filterLogic>
        ${filter('AccountId', 'EqualTo', ref('Get_Account.Id'))}
        ${filter('IsClosed', 'EqualTo', false)}${v >= 4 ? '\n        ' + filter('StageName', 'NotEqualTo', 'Prospecting') : ''}
        <getFirstRecordOnly>false</getFirstRecordOnly>
        <object>Opportunity</object>
        <storeOutputAutomatically>true</storeOutputAutomatically>
    </recordLookups>
${updateDescription}    <recordUpdates>
        ${head('Update_Opps', 'Update Opps')}
        ${connector('connector', 'Create_Followup_Task')}
        ${connector('faultConnector', 'Create_Error_Task')}
        <inputReference>oppsToUpdate</inputReference>
    </recordUpdates>
    <start>
        <locationX>0</locationX>
        <locationY>0</locationY>
        ${connector('connector', 'Get_Account')}
    </start>
    <status>${v >= 5 ? 'Draft' : 'Active'}</status>
${hotEmail}${warmText}${filterVariable}    <variables>
        <name>currentOpp</name>
        <dataType>SObject</dataType>
        <isCollection>false</isCollection>
        <isInput>false</isInput>
        <isOutput>false</isOutput>
        <objectType>Opportunity</objectType>
    </variables>
    <variables>
        <name>oppsToUpdate</name>
        <dataType>SObject</dataType>
        <isCollection>true</isCollection>
        <isInput>false</isInput>
        <isOutput>false</isOutput>
        <objectType>Opportunity</objectType>
    </variables>
    <variables>
        <name>recordId</name>
        <dataType>String</dataType>
        <isCollection>false</isCollection>
        <isInput>true</isInput>
        <isOutput>false</isOutput>
    </variables>
</Flow>
`.replace(/\n\s*\n(\s*<)/g, '\n$1'); // drop blank lines left by empty optional parts
}

module.exports = { build, API_NAME, VERSIONS: 5 };
