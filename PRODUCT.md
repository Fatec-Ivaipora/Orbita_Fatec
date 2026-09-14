# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users of the whole Órbita platform are staff of Fatec Ivaiporã (TI, RH, Financeiro, Secretaria, coordenadores, ADM). This record focuses on the **BANCO MED-FATEC** surface specifically: its users are **professores do curso de Medicina da Fatec Ivaiporã**, logged in through the shared Órbita login. They are not necessarily technical; some author exam questions occasionally, others (coordenação) may audit/administer.

## Product Purpose

Órbita is the institution's internal management platform (empréstimos, RH, financeiro, secretaria, avaliação docente, etc.), one module per business need. BANCO MED-FATEC is the newest module: a shared clinical-question bank for the Medicina course, replacing manual question entry directly into the Open LMS (AVA) or ad-hoc spreadsheets/Word docs. Professors author questions once, organize them by disciplina/período, assemble a "prova" from selected questions, and export a Moodle-XML file that imports cleanly into the AVA's question bank. A companion importer ingests existing Moodle-XML exports from the AVA (per disciplina) into the shared bank, with a manual review step before anything becomes visible/usable (never auto-trusted).

## Positioning

Internal tool, not a commercial product — its "competition" is: typing questions straight into Moodle's clunky admin UI, or keeping them in scattered Word/Excel files with no shared history, no reuse across professors, and no institution-wide oversight of what's in the exam bank. Órbita's edge is that this bank plugs into the same login/permissions/audit trail every other institutional module already uses, and the exported file format was validated against a real AVA export rather than assumed.

## Operating Context

- Lives inside Órbita Fatec, a larger suite of internal modules (see `core/permissions.js` for the full module/category list). Shares login, sidebar/header shell (`core/layout.js` + `core/layout.css`), and backend auth (`src/middlewares/auth.js`) with every other module.
- Backend: Node/Express (`api/index.js`, `src/rotas/banco-med-fatec.js`) + Firestore via Admin SDK only — the browser never talks to Firestore directly (`firestore.rules` blocks all client access by design).
- Data: `banco_med_categorias` (disciplina + período, 70 seeded from the real Medicina curriculum, pulled once from the institution's academic Postgres "Edubox"), `banco_med_questoes` (shared question bank, or `status: revisao_importacao` while pending manual categorization), `banco_med_provas` (private per professor — one professor's exams are not visible to others).
- Runs on a tablet/laptop in an office or at home, not on a phone mid-lecture; not time-pressured like a live exam-taking UI.
- Real users at this institution: professors named in this project's context include "Maria Rita" (question author example). No student ever sees this module — it is authoring/admin only, never the exam-taking experience itself.

## Capabilities and Constraints

- Confirmed: período-first cascading disciplina pickers, image upload with client-side compression (Firestore 1MiB document cap — no Firebase Storage, deliberately, mirroring the existing "Ferida" module's pattern), Moodle-XML export validated field-by-field against a real Open LMS export, Moodle-XML import parsed entirely client-side (`DOMParser`), private provas per author, shared question bank across authors.
- Undecided / open: whether a coordinator role should ever see all professors' provas (not requested yet); whether question authoring should ever support true rich text beyond the current plain textarea-as-HTML convention already used elsewhere in Órbita.
- Terminology to keep consistent: "disciplina" (not "matéria"/"categoria" alone), "período" (1º–12º, not "semestre" — semestre is the exam's *application* date, a separate field), "prova" (a saved, exportable set of questions), "AVA" (what staff call the Open LMS/Moodle instance).

## Brand Commitments

- Institution: Fatec Ivaiporã. Órbita's own institutional palette lives in `core/layout.css` (`--primary-blue #0F4EB8`, `--secondary-blue #1E63D6`, dark sidebar).
- This module additionally carries its own sub-brand, "MED FATEC" (logo at `img/medfatec-logo.png`), with its own extracted palette `--med-azul-escuro #004F9F` / `--med-azul-claro #009FE3` — same relationship as the "Ferida" module's clinical marker color living apart from the institutional brand color.

## Evidence on Hand

- Real de-identified sample exam (PDF) and a real Moodle-XML export from the institution's own AVA were used earlier this session to reverse-engineer the exact export schema (category wrapper, `multichoice`/`multichoiceset`/`truefalse`, `@@PLUGINFILE@@` image embedding). No fabricated sample data was carried into the product beyond clearly-labeled test/demo content.
- Real Medicina curriculum (70 disciplinas × 12 períodos, with short codes) was pulled once from the institution's academic database and seeded into `banco_med_categorias`.

## Product Principles

1. Never let unverified content become visible/usable silently — imported questions sit in a review queue until a human assigns the right disciplina.
2. Match the institution's real academic structure (período → disciplina, real curriculum) instead of free-text fields that drift from reality.
3. Reuse the platform's existing conventions (auth, permissions, compression pattern, plain module CSS) rather than inventing a parallel design system, except where this module's own sub-brand explicitly calls for its own accent.
4. Sharing defaults follow what's actually shared in real life: the question bank is departmental property; a professor's own assembled exam is not.
