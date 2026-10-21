---
version: 1
slug: "src-renderer"
primary_target: "src/renderer"
related_targets: []
---

# Surface brief: Sonic renderer (whole app)

Scope: every screen of the Electron renderer (Download, Library, Collections, Settings, dock, title bar, palette, dialogs). Mode: Operate. Users: producers next to their DAW in a dim studio, long sessions. Constraints: keep accessible names/roles used by Playwright specs; Tailwind v4 + CSS tokens; fonts self-hosted (strict CSP); light + dark both first-class; keep the "Sonic" name and level-meter mark.

## Direction contract

THESIS: Every track is a promo white label. Facts printed from the source, tags stamped onto the file, the analyser's measured guess, and the producer's own marker correction each look different, so provenance is visible at a glance. Refuses the category default: graphite panels, rounded cards, one violet/blue accent glowing everywhere.

OWN-WORLD: Dark = vinyl black (#141414) with label-white (#f3f3ef) type; light = label stock (#f4f4f1) with ink black. Stamp blue (#2f3bbf; lifted to #8a92ff on vinyl) is the only accent: selection, primary action, focus. The old five-accent picker is retired; stored ids all resolve to stamp blue. Promo red only for destructive/error. One-pixel rules, square corners (2px max on controls, circles only for labels/records), no glows, no gradients. Archivo (condensed widths for headings and tempo/key figures, normal for body); Shantell Sans at full informality only for manual corrections. Permanent Marker was tried first and dropped: its caps-only figures were illegible at 14px table size (8A and 7A read alike). Three type sizes: 12 / 13.5 / 28 (plus the inspector title at 20).

STORY: The producer pastes links or imports audio, scans the library table for tempo and key, sees instantly which values they corrected, which came from the uploader or the file, and which are estimates with confidence, adopts or corrects, and drags the file into their DAW.

FIRST VIEWPORT: Title bar with SONIC wordmark (condensed caps) left, commands right. Left nav rail 196px, active item on label-stock surface with a 1px stamp-blue rule and a stamp-blue icon (a 2px coloured edge on list items is a craft-floor ban). Library: condensed uppercase heading with count, search + filters toolbar, dense table with small label-disc artwork, BPM/Key columns carrying provenance marks; inspector right with a 176px record: grooves, a centre label carrying the source artwork or, without it, the BPM/key written in their provenance marks with a promo-red PROMO stamp. Bottom dock: spinning record with label, title, transport, waveform.

FORM: White Label, position 3 of the grounded list (1 Liner Notes, 2 Crate dividers, 3 White Label, 4 Blue Note sleeves, 5 Factory catalog numbering, 6 Mixtape covers, 7 Rave flyers). Signature move: provenance marks on BPM/key values (printed / stamped / measured with three confidence dots / marker), taught by a legend above the table at every width. Motion grammar: record spins at 33⅓ rpm while playing, stops with ease-out; nothing else animates unprompted. Raises: one-device-pixel rules and states as printed marks (centre-rail); three-size type scale, rank by weight and case (timetable); accent only where meaningful (monochrome); fixed row furniture (roster). seed:a382c290f45c580c

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
