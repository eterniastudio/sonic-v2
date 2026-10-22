---
name: Sonic
description: A promo white label for every track; tempo and key printed in the mark of where they came from.
colors:
  stamp-blue: "#2f3bbf"
  stamp-blue-lifted: "#8a92ff"
  stamp-ink-on-lifted: "#0b0d33"
  promo-red: "#c4232f"
  promo-red-lifted: "#ff7b80"
  label-stock: "#f4f4f1"
  label-stock-deep: "#e9e9e4"
  transport-stock: "#ebebe6"
  transport-vinyl: "#171717"
  label-sheet: "#fbfbf9"
  label-stock-2: "#e8e8e3"
  label-stock-3: "#dcdcd5"
  stock-rule: "#d6d6cf"
  stock-rule-strong: "#a9a9a0"
  ink-black: "#151515"
  ink-muted: "#45453f"
  ink-subtle: "#64645d"
  vinyl-black: "#131313"
  vinyl-deep: "#0c0c0c"
  vinyl-sheet: "#1a1a19"
  vinyl-2: "#232322"
  vinyl-3: "#2e2e2c"
  vinyl-rule: "#2b2b29"
  vinyl-rule-strong: "#4a4a45"
  label-white: "#efefe9"
  label-white-muted: "#b9b9b1"
  label-white-subtle: "#918f88"
  pressing-black: "#0a0a0a"
  pressed-green: "#1b6e44"
  pressed-green-lifted: "#6fd39f"
  test-press-amber: "#9a5a00"
  test-press-amber-lifted: "#f0b45a"
typography:
  display:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI Variable Text', system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "0.005em"
    fontVariation: "'wdth' 72"
  headline:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI Variable Text', system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.2
    fontVariation: "'wdth' 85"
  body:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI Variable Text', system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "'tnum' 1"
  label:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI Variable Text', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0"
  marker:
    fontFamily: "'Shantell Sans Variable', 'Segoe Print', cursive"
    fontWeight: 750
    letterSpacing: "0"
    fontVariation: "'INFM' 100"
rounded:
  none: "0px"
  control: "2px"
  lg: "3px"
  xl: "4px"
  record: "9999px"
spacing:
  hair: "1px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  page-x: "28px"
components:
  button-primary:
    backgroundColor: "{colors.stamp-blue}"
    textColor: "{colors.label-sheet}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-black}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.label-stock-2}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    size: "32px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.promo-red}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink-black}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  input-focus:
    backgroundColor: "{colors.label-sheet}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.label-stock-2}"
    textColor: "{colors.ink-black}"
  filter-chip-active:
    backgroundColor: "{colors.label-stock-2}"
    textColor: "{colors.stamp-blue}"
    rounded: "{rounded.control}"
  badge-neutral:
    backgroundColor: "{colors.label-stock-2}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "24px"
  playback-dock:
    backgroundColor: "{colors.transport-stock}"
    textColor: "{colors.ink-black}"
    padding: "12px 20px"
  label-disc:
    backgroundColor: "{colors.ink-black}"
    rounded: "{rounded.record}"
    width: "176px"
---

# Design System: Sonic

## Overview

**Creative North Star: "The Promo White Label"**

Every track in Sonic arrives the way an unreleased promo does: black vinyl, a blank white label, and whatever facts somebody printed, stamped or scrawled on it. The interface is that label. Facts are ink on stock; colour is spent only where it carries meaning. A tempo or key value is never just a number: it is drawn in the mark of where it came from, so the producer can read provenance at a glance in a dense table at 2 a.m.

The world has two first-class pressings. Dark is vinyl black under label-white type; light is the label stock itself under ink black. Both use one-pixel rules, square-cut surfaces with a 2px pressed corner on controls, and no glows or gradient fills. Circles belong to records and their labels. Type is Archivo throughout, with condensed caps for pressing-plant headings and figures; Shantell Sans at full informality appears only where the producer's own hand corrected a value.

The system explicitly refuses the category default for audio tools: graphite panels, rounded cards and a violet or blue accent glowing everywhere. Motion is equally restrained: the record on the platter turns at 33⅓ rpm while audio plays and settles when it stops; everything else moves only in response to the user.

**Key Characteristics:**
- One accent (stamp blue) for selection, the primary action and focus; promo red only for loss and error.
- Provenance marks: printed, stamped, measured (with three confidence dots), marker.
- One-pixel rules, square surfaces, 2px corners on controls, circles only for records.
- Three-size type ramp (12 / 13.5 / 28, plus the 20px inspector title); rank by weight, width and case.
- Dense, fixed row furniture; tabular figures everywhere.
- The record is the signature object: label disc in the inspector, spinning platter in the dock, blank label as the artwork placeholder.

## Colors

Ink on stock, with a single stamp-blue ink for meaning and promo red reserved for loss.

### Primary
- **Stamp Blue** (stamp-blue on stock; stamp-blue-lifted on vinyl): the only accent. Marks selection (1px rule on the active nav item and inspected row), the primary action, focus outlines, text selection, the stamped provenance mark, and active filter chips. On vinyl it is lifted to a pale periwinkle so it reads at the same weight, with deep stamp ink (stamp-ink-on-lifted) for text on it. Tints are mixed from it in OKLab: soft 14%, softer 7%, line 40%, ring 45%; hover darkens to 86% toward black on stock and 84% toward white on vinyl.

### Secondary
- **Promo Red** (promo-red / promo-red-lifted): destructive buttons, error text and alerts, and the PROMO stamp on a label without artwork. Never decorative.

### Tertiary
- **Pressed Green** (pressed-green / pressed-green-lifted) and **Test-Press Amber** (test-press-amber / test-press-amber-lifted): status only (engine ready, completed jobs; setup required, unsaved state). Used as small dots, text, or 8% tinted badges with 20% borders.

### Neutral
- **Label Stock** (label-stock): light-theme page ground. **Label Stock Deep** (label-stock-deep) is the recessed ground; **Transport Stock** (transport-stock; transport-vinyl in the dark theme) is the playback dock ground; **Label Sheet** (label-sheet) is the raised surface (panels, dialogs, menus, focused inputs); **Label Stock 2 / 3** are hover, selected-row and active-nav fills.
- **Stock Rule** / **Stock Rule Strong**: one-pixel dividers and control outlines respectively.
- **Ink Black** / **Ink Muted** / **Ink Subtle**: primary text, secondary text, and tertiary text plus icons and the measured underline.
- **Vinyl Black** (vinyl-black): dark-theme page ground, with **Vinyl Deep**, **Vinyl Sheet**, **Vinyl 2 / 3** and **Vinyl Rule / Rule Strong** mirroring the stock roles.
- **Label White** / **Muted** / **Subtle**: dark-theme text roles.
- **Pressing Black** (pressing-black on vinyl; ink-black on stock): the record itself, behind every label disc and platter. The label (label-sheet / label-white) sits on it.

### Named Rules
**The One Ink Rule.** Stamp blue is the only accent. The retired five-accent picker resolves every stored id to stamp blue; no second hue, no per-feature colour.

**The Ink Means Something Rule.** Colour appears only for selection, primary action, focus, status or loss. If a surface is coloured and none of those is true, it is wrong.

## Typography

**Display Font:** Archivo Variable (self-hosted, with Segoe UI Variable Text and system-ui fallbacks), condensed via the width axis
**Body Font:** Archivo Variable at normal width
**Label/Mono Font:** Shantell Sans Variable (Informal axis at 100) for manual corrections only; Cascadia Code is available for code-like strings

**Character:** One family doing pressing-plant work: condensed heavy caps for titles and figures, a plain grotesque for reading, and a single handwritten face that means "the producer wrote this".

### Hierarchy
- **Display** (800, 28px, 1.05, 72% width, uppercase): page titles, the library heading with its count. Stays 28px in the compact layout.
- **Headline** (700, 20px, 1.2, 85% width): the inspector track title only; drops to 16px and clamps to three lines when the window is shorter than 760px.
- **Body** (400–700, 13.5px, 1.45, tabular figures): row titles (600), dock title (700), buttons, nav labels, descriptions (line-height 1.6).
- **Label** (500–600, 12px, 1.5): section labels, metadata, timestamps, badges, inputs, toolbar chips. Sentence case, no tracking.
- **Label type** (800, 72% width, uppercase, 0.02em): the SONIC wordmark and stamped lettering.
- **Marker** (Shantell Sans 750, Informal 100): the manual-correction provenance mark, nowhere else.

### Named Rules
**The Three Sizes Rule.** 12, 13.5 and 28 carry the whole interface (20 for the inspector title). Rank by weight, width and case, never by adding a size.

**The Marker Means Manual Rule.** The handwritten face appears only on values the producer corrected. Using it for decoration erases its meaning.

## Layout

A fixed desktop shell in a frameless window: a 48px title bar (wordmark left, theme toggle and command-palette trigger right) over a 196px left nav rail, the workspace, and a persistent playback dock along the bottom. Workspace pages pad 20px × 28px, tightening to 16px × 18px below 1200px wide or 760px tall. The library is a virtualised list with fixed 52px rows (36px circular artwork, title, metadata, BPM/key in provenance marks), a toolbar with search, filter chips and the provenance legend, and the inspector on the right with a 176px label disc (76px and inline in short windows). The dock is a four-column grid: platter and track facts, transport (112px), waveform with seek, volume and repeat/stop. Spacing steps are 4 / 8 / 12 / 16 / 20, with 28px page gutters. The window never scrolls; the shell owns scrolling.

## Elevation & Depth

Flat by default. Panels carry no shadow; depth comes from tonal layering (stock, deep stock, sheet) and one-pixel rules. Only floating layers that detach from the page (dialogs, dropdown menus, tooltips) cast a single soft drop, so they read as a sheet lifted off the stock. Overlays are solid label stock, never frosted glass. Focus is a 2px stamp-blue outline offset by 2px; focused inputs add a 3px 7% stamp-blue halo.

### Shadow Vocabulary
- **Pop, stock** (`box-shadow: 0 10px 28px -10px rgba(21, 21, 21, 0.32)`): dialogs, dropdown menus, tooltips in the light theme.
- **Pop, vinyl** (`box-shadow: 0 14px 36px -12px rgba(0, 0, 0, 0.7)`): the same layers in the dark theme.
- **Record edge** (`box-shadow: inset 0 0 0 1px var(--sonic-border-strong)`): the platter's rim in the dock.

### Named Rules
**The Flat Stock Rule.** Surfaces at rest are flat paper. A shadow means the sheet has physically lifted off the page (a dialog, menu or tooltip); nothing else casts one, and nothing glows.

## Shapes

Label stock is cut square. Controls (buttons, inputs, chips, badges, nav items, menus, dialogs) take a 2px pressed corner; 3–4px exists in the scale but is rare. Rules are one pixel. Circles are reserved for records and their labels: the label disc, the dock platter, circular row artwork, and the blank-label placeholder, each with faint concentric groove rings at 4–7% white. The range slider is a 2px rule with a 4×14px square thumb; scrollbars are square.

## Components

### Buttons
Pressed card, not pill.
- **Shape:** square-cut with a 2px corner; 32px tall (28px extra-small, 44px large); 12px horizontal padding.
- **Primary:** stamp-blue fill, label-sheet text (deep stamp ink on vinyl), semibold 13.5px.
- **Hover / Focus:** primary darkens toward black (toward white on vinyl); all variants press down 1px on active; 2px stamp-blue focus outline offset 2px. Transitions 250ms on the smooth-out curve.
- **Secondary (default):** transparent with a strong-rule outline; hover fills label-stock-2 and darkens the outline.
- **Ghost:** muted ink, no outline; hover fills label-stock-2. Icon buttons are 32px square ghosts.
- **Danger:** promo-red outline and text, 12% red wash on hover.
- **Quiet:** label-stock-2 fill, label-stock-3 on hover.

### Chips
- **Style:** filter chips in the library toolbar are outlined with the rule colour, muted ink text.
- **State:** active chips take the stamp-blue line, 14% stamp-blue wash and stamp-blue text. Collection tabs use a 2px muted-ink underline instead of colour.

### Badges
- **Style:** 24px (20px small) tall, 2px corner, 12px medium text, tabular figures. Neutral is label-stock-2 with a rule border; status tones are an 8% wash with a 20% border in their own colour.

### Cards / Containers
- **Corner Style:** square to 2px.
- **Background:** transparent on the page or label-sheet (`.panel`) with a one-pixel rule.
- **Shadow Strategy:** none (see Elevation).
- **Internal Padding:** 12–20px.

### Inputs / Fields
- **Style:** transparent ground, 60% strong-rule outline (full strength on hover), 2px corner, 32px tall, 12px text, stamp-blue caret.
- **Focus:** outline turns stamp blue, ground lifts to label sheet, 3px 7% stamp-blue halo.
- **Error / Disabled:** promo-red outline at 50% plus a shake; disabled at 50% opacity.

### Navigation
- **Rail:** 196px, page-ground background, one-pixel right rule. Items are 36px, 13.5px semibold, 16px icons at 1.6 stroke.
- **States:** rest is muted ink with subtle icons; hover fills label-stock-2 at 60%; active fills label-stock-2 with full ink, a 1px inset stamp-blue rule on the left edge and a stamp-blue icon. The engine status sits at the foot as a 6px status dot and 12px label.

### Provenance Marks (signature)
How a tempo or key value arrived, drawn in the value itself, set at 80% width:
- **Printed** (from the uploader's title, description or file name): bold ink.
- **Stamped** (from the file's own embedded tag): stamp-blue text in a 1.5px stamp-blue box, rotated −1.5°.
- **Measured** (Sonic's audio estimate): muted ink with a 1.5px dotted underline, followed by three 3px ink dots for confidence (filled for low / medium / high); never solid, never a percentage.
- **Marker** (the producer's correction, always authoritative): Shantell Sans, informal.
- **None:** subtle ink dash.
A legend spelling out all four sits above the library table at every width.

### Label Disc (signature)
The inspected track as a record: pressing-black disc, three faint groove rings, and a centre label at 58% of the diameter. Source artwork prints onto the label; without it, the label is blank stock carrying the BPM and key in their provenance marks plus a promo-red PROMO stamp rotated −14°. A pressing-black spindle hole sits at the centre.

### Platter (signature)
A 56px record in the dock with a strong-rule rim and groove rings; its 26px centre label (artwork or blank label stock) spins at 33⅓ rpm (one turn per 1.8s, linear) while audio plays and pauses in place when it stops. Beside it sit the title, artist, and BPM/key in provenance marks; a 40px stamp-blue play button anchors the transport, flanked by 32px ghost previous/next buttons.

### Track Artwork
Real source artwork when available; otherwise a blank white label on black vinyl (or plain label stock inside a platter), the way an unreleased promo arrives.

## Do's and Don'ts

### Do:
- **Do** draw every tempo and key value with its provenance mark, and show the legend wherever those values are read.
- **Do** keep stamp blue (stamp-blue / stamp-blue-lifted) for selection, the primary action and focus only.
- **Do** separate surfaces with one-pixel rules and tonal steps between stock, deep stock and sheet.
- **Do** keep controls square with a 2px corner, and reserve circles for records and labels.
- **Do** set headings and stamped lettering in condensed Archivo caps (72% width, 800) and keep figures tabular.
- **Do** let only the platter animate unprompted; every other transition answers user input and honours reduced motion.
- **Do** keep both themes first-class: every token has a stock and a vinyl value.

### Don't:
- **Don't** introduce a second accent hue, a per-feature colour, or an accent picker.
- **Don't** use glows, gradient fills, frosted glass or ambient blurred backgrounds.
- **Don't** use graphite panels with rounded cards; surfaces are cut square.
- **Don't** add type sizes beyond 12 / 13.5 / 28 (and 20 for the inspector title).
- **Don't** use the marker face for anything except a producer's manual correction.
- **Don't** show measured confidence as a percentage or a solid value; it stays dotted with three ink dots.
- **Don't** mark selection with a 2px coloured edge; the selection rule is 1px.
