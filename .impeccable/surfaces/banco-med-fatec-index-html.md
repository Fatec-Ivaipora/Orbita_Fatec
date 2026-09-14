---
version: 1
slug: "banco-med-fatec-index-html"
primary_target: "banco-med-fatec/index.html"
related_targets: []
---

Scope: BANCO MED-FATEC module (banco-med-fatec/index.html, app.js, banco-med-fatec.css) — Operate mode, internal admin tool for Fatec Ivaiporã Medicina professors.

Audience/job: professors authoring/organizing clinical exam questions, assembling provas, exporting/importing Moodle XML with the AVA.

Constraints: must stay inside the Órbita shell (sidebar/header from core/layout.js are untouched); must keep every existing function (filters, CRUD, import, export, review queue, prova privacy) working exactly as before — this is a visual/structural redesign, not a feature change.

## Direction contract

THESIS: A working item-bank list, not a stat-card dashboard — scanning and picking questions should feel like using purpose-built assessment software, not a generic admin CRUD screen.

OWN-WORLD: A solid MED FATEC blue toolbar (#004F9F/#009FE3) holding search + período/disciplina/dificuldade pill-selects + primary actions; below it, single-column list rows (not a card grid) — checkbox, dificuldade tag, title, disciplina meta, quiet trailing action icons (real SVG, no emoji). 10-14px radii, soft two-layer shadow reserved for the toolbar/modals/hover only, Plus Jakarta Sans/Inter (Órbita's existing stack).

STORY: Professor opens the module, the toolbar alone shows the shape of the whole bank (filters + search + actions), scans a compact list instead of hunting a card grid; the same list grammar carries into Provas and the Revisão de Importação queue so the module reads as one tool, not three bolted-together screens.

FIRST VIEWPORT: MED FATEC lockup, tab strip, one solid-color toolbar bar, then the list directly under it — no stat cards in between.

FORM: pinned directly by the user (https://quiz.one/ Item Bank screen), translated into MED FATEC's own blue instead of QuizOne's blue. No concept-seed roll run: the reference was pinned, not open.

FINISH: unreviewed and undocumented is unfinished; this build ends with a batched screenshot inspection (desktop + mobile), fixes applied in one pass, and this brief updated if the built world changes.
