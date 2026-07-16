# Documentation website

This directory contains the Next.js and Fumadocs application used to render the pi-computer-use documentation website. The content, navigation, generated references, and visual system are maintained specifically for pi-computer-use.

## Run locally

Install the website dependencies once:

```bash
npm install --prefix docs
```

Start the preview from the repository root:

```bash
npm run docs:dev
```

Open http://localhost:8080/docs.

Build and validate it with:

```bash
npm run docs:build
npm run docs:site:check
```

## Content model

Public content lives in `content/docs/` and follows Diátaxis:

- `tutorials/` teaches through a guided first success.
- `how-to-guides/` gives steps for one operational goal.
- `explanation/` builds understanding of architecture and tradeoffs, organized by runtime concern.
- `reference/` provides exact interface, configuration, and platform lookup, organized by implementation boundary.

Navigation opens only the active branch. Platform reference should expose concrete subsystems rather than hiding them in one page; for example, macOS separates Accessibility and AX, capture and OCR, actions and input delivery, and the complete implementation inventory.

Every page below `reference/` is generated. Exact tool schemas come from `../extensions/computer-use.ts`; behavioral reference prose is extracted from marked documentation blocks in the source file that owns the behavior; navigation and the codebase inventory are derived from generator metadata and the repository tree. `../scripts/docs-generators/reference-evidence.json` independently lists required source symbols. Run `npm run docs:generate` after changing code-owned reference documentation, and `npm run docs:check` to detect output or evidence drift.

## Visual system

The website uses the quiet systems language: near-black olive surfaces, warm off-white text, sparse amber and green signals, square geometry, technical mono labels, condensed display typography, and a restrained 12-column editorial rhythm. Structure and reading order take priority over decoration.

Theme implementation lives in `src/app/global.css`. Keep new components responsive, maintain 44px interaction targets, and respect reduced-motion preferences.
