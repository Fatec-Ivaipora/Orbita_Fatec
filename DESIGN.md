---
name: BANCO MED-FATEC
description: Item-bank sub-brand layer for Órbita's Medicina question bank module
colors:
  med-azul-escuro: "#004F9F"
  med-azul-claro: "#009FE3"
  med-azul-escuro-hover: "#003D7A"
  perigo: "#B91C1C"
  card-bg: "#FFFFFF"
  bg-color: "#F4F7FB"
  border-color: "#E5E7EB"
typography:
  body:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "0.88rem"
    fontWeight: 400
    lineHeight: 1.4
  titulo:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 700
    lineHeight: 1.35
rounded:
  control: "10px"
  card: "14px"
  modal: "16px"
  pill: "999px"
spacing:
  row-padding: "0.95rem 1.25rem"
  toolbar-padding: "1rem 1.1rem"
components:
  toolbar:
    backgroundColor: "{colors.med-azul-escuro}"
    rounded: "{rounded.card}"
    padding: "{spacing.toolbar-padding}"
  button-on-blue-primary:
    backgroundColor: "#FFFFFF"
    textColor: "{colors.med-azul-escuro}"
    rounded: "{rounded.control}"
  button-primary:
    backgroundColor: "{colors.med-azul-escuro}"
    textColor: "#FFFFFF"
    rounded: "{rounded.control}"
  button-primary-hover:
    backgroundColor: "{colors.med-azul-escuro-hover}"
  icon-button:
    backgroundColor: "#FFFFFF"
    textColor: "#64748B"
    rounded: "{rounded.control}"
---

# Design System: BANCO MED-FATEC

## Overview

**Creative North Star: "The Item Bank"**

This is a sub-brand layer inside the larger Órbita Fatec institutional shell (sidebar, header, and base tokens come from `core/layout.css` and are out of scope here — this file documents only what `banco-med-fatec/*` adds on top). The module's job is to feel like purpose-built assessment software — a working item bank a professor scans and picks from — not a generic admin CRUD screen. The direction was pinned directly by the institution's TI lead against a real reference (quiz.one's Item Bank screen: a solid-color toolbar holding search + filter chips + actions, followed by dense list rows) and translated into the module's own extracted brand color instead of the reference's blue.

**Key characteristics:**
- One solid-color (MED FATEC blue) toolbar block per view, carrying every filter/search/action control as white pill or ghost elements.
- Content is list rows, never card grids — a row is a checkbox, badges, title, meta line, and quiet trailing icon actions.
- Bulk selection (checkbox per row) drives a contextual action bar, the same interaction grammar as a real item bank: mark several, act on the group at once.
- Real inline SVG icons only — never emoji or unicode glyphs standing in for an icon system.

## Colors

The palette is drawn straight from the MED FATEC logo (`img/medfatec-logo.png`), kept deliberately separate from Órbita's own institutional blue (`--primary-blue #0F4EB8` in `core/layout.css`) — the same relationship the "Ferida" module keeps between its clinical marker color and the institutional brand.

### Primary
- **MED Azul Escuro** (#004F9F): toolbar background, primary button fill, active tab, focus accents.
- **MED Azul Claro** (#009FE3): focus rings, checkbox/radio accent color, hover accents on the blue toolbar.

### Neutral
- **Card / Surface** (#FFFFFF): list container, modal, row background.
- **Page background** (#F4F7FB): inherited from Órbita's `--bg-color`.
- **Border** (#E5E7EB): hairline row dividers, list/card outline.
- **Perigo** (#B91C1C): destructive text/icon color. Chosen over the more common `#EF4444` specifically because white-on-#EF4444 and #EF4444-on-white both fail WCAG AA (3.8:1); `#B91C1C` clears it.

### Named Rules
**The One Bar Rule.** Every list view (Banco de Questões, Provas) gets exactly one solid-color toolbar bar carrying its controls — never a second competing color block on the same screen.

## Typography

**Body/Display Font:** Inter (inherited from Órbita's institutional stack; not changed for this module — see Do's and Don'ts).

**Character:** Workhorse, high-legibility system sans. This module is Operate-mode: typography plays a supporting role to scanability, not a stylistic lead.

### Hierarchy
- **Row title** (700, 0.95rem, 1.35 line-height, 2-line clamp): the question/prova title, the primary scan target of a row.
- **Row meta** (600, 0.78rem): secondary line — disciplina, período, autor, counts.
- **Badge label** (800, 0.7rem, uppercase, 0.3px tracking): dificuldade/tipo tags.

## Layout

Single-column content, `max-width: 1180px`, centered. One toolbar bar per view, directly followed by its list — no stat cards or intermediate summary block between them. Mobile (`≤720px`): toolbar controls and filters stack to full width; row actions wrap below the row content.

## Elevation & Depth

Mostly flat, bordered surfaces (list container, rows) — elevation is reserved for the modal layer only, which uses shadow alone (no border), per **The Ghost-Card Rule** below.

### Shadow Vocabulary
- **Modal elevation** (`box-shadow: 0 24px 60px -12px rgba(3,20,38,0.35)`): the only shadow in the module; marks the one surface that floats above the page.

### Named Rules
**The Ghost-Card Rule.** A surface declares elevation once — border OR shadow, never both. Rows and the list container use a border only; the modal uses a shadow only.

## Shapes

Controls: 10px radius. List/card containers: 14px. Modals: 16px. Pills (filter selects, search field, badges, tab-count badge): fully rounded (999px) — pills are reserved for small controls and tags, never for row or card containers.

## Components

### Toolbar
- **Character:** a solid block of brand color, not a bar of individually-bordered white fields.
- **Background:** `{colors.med-azul-escuro}`, 14px radius.
- **Contents:** pill-shaped white selects/search input; a ghost outline button (secondary action, e.g. "Importar do AVA") and a solid-white button (primary action, e.g. "+ Nova Questão") — colors invert relative to the rest of the module because the ground itself is now blue.

### Buttons
- **Shape:** 10px radius, no pill (pills are reserved for filters/tags/badges).
- **Primary** (on white ground): `{colors.med-azul-escuro}` fill, white text.
- **Primary (on-blue)**: white fill, `{colors.med-azul-escuro}` text — used only inside the toolbar.
- **Ghost (on-blue):** `rgba(255,255,255,0.12)` fill, `rgba(255,255,255,0.4)` border, white text — secondary actions inside the toolbar.
- **Icon-only:** 38×38px, white fill, 1.5px border, neutral icon color; hover tints toward brand blue (or `{colors.perigo}` for destructive actions).

### List rows
- **Container:** white, 14px radius, 1px border, no shadow; rows separated by 1px hairline dividers, last row has none.
- **Row:** checkbox (optional, only when bulk-select is a real feature) → badges + title + meta stacked → trailing icon actions.
- **Hover:** faint brand-tinted background wash (`rgba(0,79,159,0.035)`), never a shadow-lift.

### Badges
- **Style:** pill, 0.7rem uppercase bold, colored by semantic meaning (dificuldade: verde/azul/âmbar/vermelho; tipo: neutral gray).

### Selection bar (bulk actions)
- **Style:** light brand-tinted panel (`rgba(0,79,159,0.06)` background, `rgba(0,79,159,0.25)` border), appears only when ≥1 row is checked; carries a count, a clear action, and the bulk action itself.

## Do's and Don'ts

### Do:
- **Do** keep the toolbar as one solid brand-color block — search, filters, and actions all live inside it.
- **Do** use real inline SVG for every icon (search, plus, upload/download, edit, trash, image, confirm) — never emoji or a bare Unicode glyph.
- **Do** use `#B91C1C` for destructive red text/icons on white, not `#EF4444` (contrast).
- **Do** keep list rows as the only content pattern for scannable collections in this module (no card grids).

### Don't:
- **Don't** change the base font away from Inter for this module alone — it is Órbita's institutional stack, shared across every other module; a per-module font swap would break platform consistency, even though a generic slop-detector flags Inter as overused.
- **Don't** combine a hairline border with a wide diffuse shadow on the same surface — pick one per the Ghost-Card Rule.
- **Don't** add a card grid back for the question/prova lists — the item-bank list is the pinned reference's whole point.
- **Don't** add a bulk-select checkbox to a list that has no bulk action wired to it — a control with no function is worse than no control.
