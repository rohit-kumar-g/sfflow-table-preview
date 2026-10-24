# Changelog

## 0.5.0

- New logo.
- Published as **Flow Table Preview for Salesforce** by `rohit-kumar-g` (extension id
  `rohit-kumar-g.sfflow-table-preview`). Settings keep their names (`sfflowPreview.*`).
- Short README (what it does and how to use it); development notes moved to `DEVELOPMENT.md` (not packaged).
- Feedback: **SF Flow: Give Feedback or Report an Issue** and links at the bottom of the preview
  open the GitHub issue forms (bug reports come with the extension and VS Code versions filled in)
  or Discussions. Source, issues and releases: https://github.com/rohit-kumar-g/sfflow-table-preview
- Fixed: the right-click and Command Palette conditions for the compare commands matched any
  character before "flow" (unescaped dots).

## 0.4.0

- **Diagram** tab next to the table: the flow as boxes and arrows (own layered layout, no library),
  outcome labels, dashed fault paths, loop returns routed around the boxes, check and compare
  badges. Click a box: table row; Ctrl+click: XML; zoom and drag. Built only while shown; included
  in saved HTML.
- **Checks**: DbInLoop, HardcodedId, UnreachableElement, MissingFaultHandler, UnusedResource,
  MissingDescription (names as in Salesforce Code Analyzer). In the preview, on rows and boxes, in
  Markdown/AI summaries and in the Problems panel. Settings `checks.enabled`, `checks.showInProblems`.
- **XML editor**: hover summaries, Go to Definition (subflow names open the subflow's file), Find
  All References, Outline.
- **Compare with Local File**: compare with another flow file on disk (other copies in the
  workspace listed, or Browse…); Changes, badges and side-by-side diff as for org versions.
- **Limits** (stop instead of freezing): file size, diagram size, layout time budget, linear diff
  fallback, checks time budget. Org calls have a Cancel button that stops the `sf` process.
- Execution-order numbering no longer recursive (no stack overflow on very long flows).

## 0.3.5

- **SF Flow: Clear Cached Org Versions** (Command Palette): deletes the XML retrieved for
  Side-by-side XML diff, after showing how many files and how much space, and asking to confirm.
- New setting `sfflowPreview.compare.reuseRetrievedVersions` (on): reuse already retrieved
  versions; off = retrieve a fresh copy every time. Its description shows where the cache is and
  has a "Clear cached org versions" link that runs the command.

## 0.3.4

- Removed the "Only changed rows in the table" checkbox: the Changes table already lists exactly
  the changed elements and its names jump to their rows. The added/changed badges in the main
  table stay.

## 0.3.3

- Compare with org: one input. It uses the default org (project `target-org`, else the global
  one, like the sf CLI) and compares the chosen version with this file, so the version picker is
  the only question. No default org: an error notification (with "Open Settings") and no pickers.
- The org picker and comparing two org versions moved behind settings, off by default:
  `sfflowPreview.compare.chooseOrg`, `sfflowPreview.compare.allowVersionToVersion`.

## 0.3.2

- Fixed: clicking element names and links scrolled the preview to the top. VS Code's webview host
  scrolls to the top on every click of a link with `href="#"` (even when the click is handled), so
  0.3.0/0.3.1 jumps were undone right away. In-preview links no longer have an href (they stay
  keyboard-usable: Tab + Enter).
- "From" links point to the exact cell: each entry names the outcome that leads here, e.g.
  `Check_Account (Is Warm)`, `Update_Opps (fault)`, and jumps to that outcome's row, highlighting
  its Condition and Condition next element cells.
- `test/webview-harness.js`: runs the preview inside an iframe with a copy of VS Code's webview click
  handler, to check jumps in a browser (`--old-links` reproduces the bug).

## 0.3.1

- Changes table: element names jump to the element's row in the main table (the main table is
  always this file). Removed elements are plain text marked "not in this file"; their old content
  is in the "-" lines.
- Main table: clicking an element name opens the XML with the whole element block selected
  (e.g. `<decisions>…</decisions>`), not only its `<name>` line.
- Jumps ("From" links, next-element links, Changes table names) land the row's top just below the
  sticky toolbar and column header. Before, tall rows were centred and their top hid under the
  header, and the header position assumed a one-line toolbar.
- Re-rendering (editing the file, opening or closing a comparison) keeps the preview's scroll position.
- Saved HTML: #fragment jumps also land below the sticky header.

## 0.3.0

- **Compare with org version**: pick an org and a version of the flow (status, date, author) and
  compare it with this file or with another version. Shows added / removed / changed elements with
  before/after lines, flow-level changes, row badges and an "only changed rows" filter; updates live
  while editing. **Side-by-side XML diff** retrieves the real XML of that version
  (`Flow:<ApiName>-<n>`) and opens VS Code's diff editor. Read-only, through the Salesforce CLI;
  each call is listed in the "SF Flow" output panel. New setting `sfflowPreview.sfPath`.
- Changes are included in Save Markdown, Save HTML and Ask with AI while comparing.
- Parameters and conditions: each assignment/condition on its own line; long lines wrap with a
  hanging indent, group headings ("Input assignments:") above their items. In Markdown, cell lines
  are separated with `<br>` instead of " / ".

## 0.2.0

- **Save HTML** replaces **Copy Markdown** in the preview toolbar. It writes one self-contained page
  (inline styles, no scripts, light/dark by system setting, working row links, print-friendly) and
  offers to open it in the browser. Also in the preview title bar and as "SF Flow: Save Flow Table as HTML".
- To copy the table, use Ask with AI → Copy prompt to clipboard (prompt plus full table).

## 0.1.0

First VS Code version, ported from the Chrome "Salesforce Flow Extension" 1.1.7.

- **Preview as Table** button on flow metadata files (`*.flow-meta.xml`, `*.flow`, or any XML with a `<Flow>` root).
- Reads the XML on disk; no org connection or session cookie.
- Same table as the Chrome version (element, type, parameters, condition, next element), in execution order, with coloured decision logic, "From" back-links and the plain-English "This flow" summary.
- Live update while editing; invalid XML keeps the last valid table.
- Click an element name to jump to it in the XML.
- Save or copy the table as Markdown.
- **Ask with AI** without API keys: Claude Code, Agentforce, VS Code Chat, any VS Code language model, clipboard, or the saved summary file.

Changes from the Chrome version:

- Missing values are left out instead of printed as `undefined`.
- Decision outcomes are listed before the default outcome.
- Elements no path reaches are marked "not connected" and listed after the reached ones; resources come last and can be hidden.
- Waits show their default path; screen sections show their nested fields; custom error elements are supported.
- The Markdown download no longer contains the internal `boolExpStart`/`boolExpEnd` markers.
- The OpenAI key, model picker and Tooling API call are gone.
