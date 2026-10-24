# Flow Table Preview for Salesforce

Read a Salesforce flow from its metadata XML in VS Code, as a step-by-step table and a diagram,
without opening Flow Builder.

> Community extension, not made or endorsed by Salesforce.

## How to use

1. Open a flow file (`*.flow-meta.xml`) from your Salesforce DX project.
2. Click **Preview as Table** in the editor title bar (or right-click the file).
3. In the preview:
   - **Table | Diagram**: every element in execution order, or the flow as a chart. Click a name to
     open it in the XML.
   - **Checks**: best-practice warnings (e.g. records saved inside a loop, hard-coded ids).
   - **Compare with org…**: pick a version of the flow in your default org and see what changed.
     Needs the Salesforce CLI (`sf`) and a logged-in default org; read-only.
   - **Compare with file…**: compare with another copy of the flow on disk.
   - **Save Markdown / Save HTML**: share the table and diagram.
   - **Ask with AI**: send the flow summary to the AI assistant you use in VS Code (Claude Code,
     Agentforce, Copilot Chat…). No API keys.

In the XML file itself: hover an element name for a summary, **F12** to go to an element,
**Outline** to list them all.

All commands are under **SF Flow** in the Command Palette; options are under **Settings >
Extensions > Flow Table Preview for Salesforce**.

## Privacy

No telemetry. The org is only contacted when you use **Compare with org**, read-only, through your
own Salesforce CLI login. Flow content goes to an AI assistant only when you click **Ask with AI**.

## Feedback and issues

- Something wrong? [Report a bug](https://github.com/rohit-kumar-g/sfflow-table-preview/issues/new?template=bug_report.yml)
- An idea? [Suggest a feature](https://github.com/rohit-kumar-g/sfflow-table-preview/issues/new?template=feature_request.yml)
- Questions or feedback: [Discussions](https://github.com/rohit-kumar-g/sfflow-table-preview/discussions)

Or run **SF Flow: Give Feedback or Report an Issue** in VS Code.

## License

MIT. Based on the Chrome extension "Salesforce Flow Extension" by Fernando Fernandez.
