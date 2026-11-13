# Drawpane product designs

156 artboards covering every screen, panel and state in Drawpane, built from the [design system](../design-system/README.md) using its real components (`window.Drawpane`). Each artboard has a light (Paper) and dark (Graphite) theme.

## Viewing them

Serve the repository root over HTTP and open the browse page:

```sh
python3 -m http.server 8000      # from the repo root
# then open http://localhost:8000/designs/
```

- `index.html` lists every artboard by page and section, with Previous/Next (← →), a theme toggle and fit-to-width.
- Each artboard also opens on its own, e.g. `designs/Main.dc.html?theme=dark`. Any top-level prop can be set from the query string.
- `Coverage.dc.html` is the designers' own index: one line per artboard, listing the screens and states it shows.
- The viewer loads React 18 from cdn.jsdelivr.net and fonts from Google Fonts, so it needs network access.

## Files

| Path | What it is |
| --- | --- |
| `*.dc.html` | One artboard per file, in the Design Component format (below) |
| `Part*.dc.html` | Shared building blocks (top bar, layers pane, inspector, sample board) mounted by other artboards with `<dc-import>` |
| `canvas.json` | The canvas index: every artboard's frame (`x`, `y`, `w`, `h`), title, page, page list and section titles (`notes`) |
| `ui.css` | Shared layout helpers (`u-*` classes). Colors, radii and shadows come only from design-system tokens |
| `ds/drawpane` | Symlink to [`../design-system`](../design-system): tokens, `components/bundle.js` and `bundle.css` |
| `support.js` | A small local runtime that renders the format in a normal browser. It replaces the hosted canvas editor's runtime |

### The Design Component format

Each artboard is plain HTML with a template inside `<x-dc>` and a logic class in `<script type="text/x-dc" data-dc-script>`:

- `{{path}}` holes are dotted lookups into the object `renderVals()` returns. They are never expressions.
- `<sc-for list="{{items}}" as="item">` repeats (`{{$index}}` in scope). `<sc-if value="{{flag}}">` branches.
- `<x-import component-from-global-scope="Drawpane.Button" variant="primary">Save</x-import>` mounts a design-system React component. Attributes are props (kebab-case → camelCase), and content is `children`.
- `<dc-import name="PartTopBar" branch="main"></dc-import>` mounts the sibling `PartTopBar.dc.html`, with its other attributes as props.
- `<helmet>` holds head content (font links, `body{margin:0}`).
- `data-props` on the logic script declares tweakable props (e.g. `theme`: `light` | `dark`) and `$preview` size.

When implementing the real product, treat these files as the visual and behavioral spec. Their markup is a mock-up, not production code.

## Artboards by page


### Coverage index (1)


**Every artboard in Drawpane, by area**


- [Coverage index](Coverage.dc.html) · 1440 × 3720

### AI agents (36)


**Agents work beside you, on their own branch**


- [Agent pane · working on a branch](AgentPane.dc.html) · 1440 × 900
- [Start an agent](AgentStart.dc.html) · 1440 × 900
- [Agent asks a question mid-run](AgentQuestion.dc.html) · 1440 × 900

**Watching and steering a run**


- [Follow an agent live](AgentFollow.dc.html) · 1440 × 900
- [Agent checks its own render](AgentRenderCheck.dc.html) · 1440 × 900
- [When an agent run fails](AgentFailure.dc.html) · 1440 × 900

**Reviewing and merging agent work**


- [Reviewing an agent's proposal](AgentReview.dc.html) · 1440 × 900
- [Design-system gate on merge](AgentLintGate.dc.html) · 1440 × 900
- [Approval rules in action](AgentApproval.dc.html) · 1440 × 900

**Asking in plain words**


- [Natural language in the command bar](AgentCommand.dc.html) · 1440 × 900
- [Ask about this file](AgentAsk.dc.html) · 1440 × 900
- [@drawpane in comments](AgentComments.dc.html) · 1440 × 900

**Generating new work**


- [Generate screens from a prompt](AgentGenerate.dc.html) · 1440 × 900
- [Screenshot or URL to editable design](AgentFromScreenshot.dc.html) · 1440 × 900
- [Explore directions in parallel](AgentExplore.dc.html) · 1440 × 900

**Cleaning up and systematizing**


- [File audit with one-click fixes](AgentAudit.dc.html) · 1440 × 900
- [Tidy a file](AgentTidy.dc.html) · 1440 × 900
- [Build a design system from a file](AgentExtractDS.dc.html) · 1440 × 900

**Content, accessibility and flows**


- [Realistic content and translation](AgentContent.dc.html) · 1440 × 900
- [Accessibility review](AgentA11y.dc.html) · 1440 × 900
- [Wire a prototype](AgentPrototype.dc.html) · 1440 × 900

**Agents from outside, over MCP**


- [MCP connections and sessions](AgentConnections.dc.html) · 1440 × 900
- [Claude Code working in your file](AgentExternal.dc.html) · 1440 × 900
- [Authorize an MCP client](AgentConsent.dc.html) · 1440 × 900

**Your team's agents and skills**


- [Team agents](AgentDirectory.dc.html) · 1440 × 900
- [Define a custom agent](AgentEditor.dc.html) · 1440 × 900
- [Skills library and editor](AgentSkills.dc.html) · 1440 × 900

**Runs, cost and governance**


- [Agent runs](AgentRuns.dc.html) · 1440 × 900
- [One run, start to finish](AgentRunDetail.dc.html) · 1440 × 900
- [Models, budgets and approval rules](AgentModels.dc.html) · 1440 × 900

**Design, code and automation**


- [Design and code in sync](AgentCodeSync.dc.html) · 1440 × 900
- [Scheduled automations](AgentAutomations.dc.html) · 1440 × 900
- [Actions console](AgentActions.dc.html) · 1440 × 900

**Setting up and keeping an eye on it**


- [Set up agents](AgentSetup.dc.html) · 1440 × 900
- [Agent usage and cost](AgentUsage.dc.html) · 1440 × 900
- [Phone · agent run](AgentMobile.dc.html) · 390 × 844

### Editor (33)


**The editor: canvas first, chrome last**


- [Editor · Design mode](Main.dc.html) · 1440 × 900
- [Editor · Text in Graphite](EditorText.dc.html) · 1440 × 900
- [Editor · Command bar sets a value](EditorCommand.dc.html) · 1440 × 900

**Precision tools**


- [Editor · Layout X-ray and Explain](EditorXray.dc.html) · 1440 × 900
- [Editor · Focus mode](EditorFocus.dc.html) · 1440 × 900
- [Editor · Zoom and navigation](Navigation.dc.html) · 1440 × 900

**Pages and layers**


- [Editor · Pages and sections](PagesPanel.dc.html) · 1440 × 900
- [Editor · Layers in depth](LayersAdvanced.dc.html) · 1440 × 900
- [Editor · Drop and paste](DropPaste.dc.html) · 1440 × 900

**Drawing and shapes**


- [Editor · Vector editing](VectorEdit.dc.html) · 1440 × 900
- [Editor · Strokes and shapes](StrokesShapes.dc.html) · 1440 × 900
- [Editor · Masks and image crop](MasksCrop.dc.html) · 1440 × 900

**Selecting and editing many things**


- [Editor · Multi-selection and spacing](MultiSelect.dc.html) · 1440 × 900
- [Editor · Selection colors and fonts](BulkEdit.dc.html) · 1440 × 900
- [Sheet · Color, gradient, image and effects](SheetPickers.dc.html) · 1440 × 900

**Type**


- [Editor · Type in depth](TypeDetails.dc.html) · 1440 × 900
- [Editor · Font picker](FontPicker.dc.html) · 1440 × 900

**Measuring and constraining**


- [Editor · Auto layout in depth](AutoLayoutAdvanced.dc.html) · 1440 × 900
- [Editor · Grid layout](GridLayout.dc.html) · 1440 × 900
- [Sheet · Rulers, guides, grids, constraints](SheetGuides.dc.html) · 1440 × 900

**Design systems: components and variants**


- [Component playground](Components.dc.html) · 1440 × 900
- [Editor · Variants and properties](Variants.dc.html) · 1440 × 900
- [Editor · Instance properties and swap](InstanceProps.dc.html) · 1440 × 900

**Tokens and libraries**


- [Tokens](Tokens.dc.html) · 1440 × 900
- [Editor · Token modes and themes](TokenModes.dc.html) · 1440 × 900
- [Publish library](LibraryPublish.dc.html) · 1440 × 900

**Assets, plugins and file**


- [Editor · Assets and library updates](Assets.dc.html) · 1440 × 900
- [Editor · Plugins](Plugins.dc.html) · 1440 × 900
- [Editor · Plugin development](PluginDev.dc.html) · 1440 × 900
- [Editor · File menu and settings](FileSettings.dc.html) · 1440 × 900

**Every popover, menu and dialog**


- [Sheet · Menus and shortcuts](SheetMenus.dc.html) · 1440 × 900
- [Sheet · Export, fonts, find and replace](SheetDialogs.dc.html) · 1440 × 900
- [Editor · Keyboard and screen reader](KeyboardA11y.dc.html) · 1440 × 900

### Collaboration (15)


**Branches and history**


- [Branch review](BranchReview.dc.html) · 1440 × 900
- [Branches and merge conflicts](Branches.dc.html) · 1440 × 900
- [History scrubber](History.dc.html) · 1440 × 900

**Versions and reviews**


- [Compare two versions](CompareVersions.dc.html) · 1440 × 900
- [Review requests and protected main](ReviewRequests.dc.html) · 1440 × 900
- [After working offline](OfflineSync.dc.html) · 1440 × 900

**Being in a file together**


- [Follow mode and spotlight](FollowMode.dc.html) · 1440 × 900
- [Cursor chat and reactions](CursorChat.dc.html) · 1440 × 900
- [File activity](FileActivity.dc.html) · 1440 × 900

**Conversations**


- [Comments](Comments.dc.html) · 1440 × 900
- [All comments](CommentsPanel.dc.html) · 1440 × 900
- [Viewing a file you cannot edit](ViewOnly.dc.html) · 1440 × 900

**Access and notifications**


- [Share](Share.dc.html) · 1440 × 900
- [Access requests and guests](AccessRequests.dc.html) · 1440 × 900
- [Notification emails](Emails.dc.html) · 1440 × 900

### Prototype & handoff (14)


**From design to working product**


- [Prototype mode](Prototype.dc.html) · 1440 × 900
- [Sheet · Overlays, interactive components, variables](SheetPrototype.dc.html) · 1440 × 900
- [Prototype player](PrototypePlayer.dc.html) · 1440 × 900

**Handoff**


- [Inspect mode](Inspect.dc.html) · 1440 × 900
- [Ready for dev and changes since handoff](DevHandoff.dc.html) · 1440 × 900
- [Annotations](Annotations.dc.html) · 1440 × 900

**Code and tokens out**


- [Export a board as code](CodeExport.dc.html) · 1440 × 900
- [Token export and sync](TokenExport.dc.html) · 1440 × 900
- [Spec page](SpecPage.dc.html) · 1440 × 900

**Presenting**


- [Present](Present.dc.html) · 1440 × 900
- [Presenter view](PresenterView.dc.html) · 1440 × 900
- [Publish to web and embed](PublishWeb.dc.html) · 1440 × 900

**Responsive and insight**


- [Breakpoint strip](Breakpoints.dc.html) · 1440 × 900
- [Prototype views and drop-off](ProtoAnalytics.dc.html) · 1440 × 900

### Dashboard & onboarding (22)


**Getting in**


- [Sign in](SignIn.dc.html) · 1440 × 900
- [Create an account](SignUp.dc.html) · 1440 × 900
- [Recover an account](RecoverAccount.dc.html) · 1440 × 900

**Getting set up**


- [Two-step sign-in](TwoStep.dc.html) · 1440 × 900
- [First run](Onboarding.dc.html) · 1440 × 900
- [Create a team](CreateTeam.dc.html) · 1440 × 900

**Finding your files**


- [Dashboard](Dashboard.dc.html) · 1440 × 900
- [Project page · list view](ProjectView.dc.html) · 1440 × 900
- [Drafts, shared and starred](DraftsShared.dc.html) · 1440 × 900

**Searching and starting**


- [Search everything](SearchResults.dc.html) · 1440 × 900
- [New file and templates](NewFile.dc.html) · 1440 × 900
- [Community gallery](CommunityGallery.dc.html) · 1440 × 900

**Migrating and joining**


- [Import from Figma or Penpot](Import.dc.html) · 1440 × 900
- [Import report](ImportReport.dc.html) · 1440 × 900
- [Accept an invite](InviteAccept.dc.html) · 1440 × 900

**Team resources**


- [Team libraries](Libraries.dc.html) · 1440 × 900
- [Team fonts](TeamFonts.dc.html) · 1440 × 900
- [Project settings](ProjectSettings.dc.html) · 1440 × 900

**Around the dashboard**


- [Sheet · Menus, inbox, what's new, trash](SheetDashboard.dc.html) · 1440 × 900
- [Account settings](AccountSettings.dc.html) · 1440 × 900
- [Help and feedback](HelpFeedback.dc.html) · 1440 × 900
- [A brand new workspace](EmptyWorkspace.dc.html) · 1440 × 900

### Self-hosting & admin (17)


**Your instance, your Cloudflare account**


- [Self-host setup](Deploy.dc.html) · 1440 × 900
- [Instance settings](InstanceSettings.dc.html) · 1440 × 900
- [Instance health and cost](Health.dc.html) · 1440 × 900

**Running it**


- [Live rooms and logs](LiveRooms.dc.html) · 1440 × 900
- [Backups, restore and upgrades](Backups.dc.html) · 1440 × 900
- [About this instance](About.dc.html) · 1440 × 900

**Team and personal settings**


- [Team settings](TeamSettings.dc.html) · 1440 × 900
- [Roles and permissions](Roles.dc.html) · 1440 × 900
- [Preferences](Preferences.dc.html) · 1440 × 900

**Security and data**


- [Authentication and account security](AuthSecurity.dc.html) · 1440 × 900
- [Audit log](AuditLog.dc.html) · 1440 × 900
- [Data, retention and export](DataRetention.dc.html) · 1440 × 900

**Connecting other tools**


- [Integrations](Integrations.dc.html) · 1440 × 900
- [API and webhooks](ApiWebhooks.dc.html) · 1440 × 900
- [Instance admin: teams and people](InstanceAdmin.dc.html) · 1440 × 900

**Edges**


- [Sheet · Error and maintenance pages](SheetErrors.dc.html) · 1440 × 900
- [Labs](Labs.dc.html) · 1440 × 900

### States & devices (14)


**Every state**


- [System states](States.dc.html) · 1440 × 900
- [Long strings and right-to-left](Localization.dc.html) · 1440 × 900
- [High contrast and large text](HighContrast.dc.html) · 1440 × 900

**Desktop and tablet**


- [Desktop app window](DesktopApp.dc.html) · 1440 × 940
- [Tablet · Editing with a pencil](Tablet.dc.html) · 1180 × 820
- [Tablet · Reviewing with comments](TabletReview.dc.html) · 1180 × 820

**Phone**


- [Phone · Sign in](MobileSignIn.dc.html) · 390 × 844
- [Phone · Files](MobileDashboard.dc.html) · 390 × 844
- [Phone · Inside a file](MobileFile.dc.html) · 390 × 844
- [Phone · Prototype viewer](MobileViewer.dc.html) · 390 × 844
- [Phone · Comments](MobileComments.dc.html) · 390 × 844
- [Phone · Inbox](MobileNotifications.dc.html) · 390 × 844
- [Phone · Inspect](MobileInspect.dc.html) · 390 × 844
- [Phone · Share](MobileShare.dc.html) · 390 × 844

### Building blocks (4)


**Shared parts imported by the editor screens**


- [Part · Top bar](PartTopBar.dc.html) · 1416 × 40
- [Part · Layers pane](PartLayers.dc.html) · 248 × 824
- [Part · Design inspector](PartInspector.dc.html) · 264 × 824
- [Part · Sample design (Home, iOS)](PartBoard.dc.html) · 340 × 560

## Canvas notes

- Every screen has a Theme tweak (Paper or Graphite). In the original canvas this was flipped from each artboard's Tweaks panel; here, use the theme toggle in `index.html` or add `?theme=dark` to an artboard's URL.
