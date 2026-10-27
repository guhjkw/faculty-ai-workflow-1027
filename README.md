# Faculty Course Studio (live demo)

A working prototype for a business-school faculty member's teaching and research workflows, built from an Upwork job post. It runs in the browser on an invented course (MAN 4720, Chapter 6, Business-Level Strategy):

- **Teaching deck.** A publisher deck, your chapter objectives and your prior materials become a draft deck in your sequence. Student-facing slides stay short; instructor-only content goes to the speaker notes; an answer key is hidden in your copy and removed from the student copy.
- **Vignette and teaching note.** Both come from one master record of facts. The checker blocks real names, instructor-only facts in the student copy, figures that contradict the record, and figures that are in no fact.
- **Research sources.** Each paragraph is tagged as your idea, a verified source, public evidence or AI draft language. Citations not in your verified library cannot reach a final document. One planted fake citation shows the block.
- **Privacy and costs.** Where each kind of material may go, redaction before any model call, and a monthly running-cost estimate.
- **Your approval.** Final files stay locked until every slide is approved. An edit after approval sends that slide back for review.

Downloads are real, editable `.pptx` and `.docx` files written in the browser with no libraries. You can also load your own `.pptx`; it is read in the browser and never uploaded.

## Try it

Open `index.html` (works off disk), or serve the folder: `python3 -m http.server 8801`.

Things to try: set the bullet limit to 3; remove slide 4 from LO6.1; add your example to the empty slide; approve all and download the final decks; type "Bayshore" into the student case; change 27% to 25%; tick "reviewed" on the paragraph citing Whitlow & Haines.

## Files

```
index.src.html          page source (build.py embeds data/course.json into index.html)
index.html              the built page
src/facultyEngine.js    matching, deck, cases, citations, privacy, costs (the logic)
src/ooxml.js            .pptx and .docx writer, .pptx reader (ZIP + Office Open XML, no libraries)
src/ooxml-parts.js      16:9 theme, master, layouts and notes master (from python-pptx's MIT template)
data/course.json        invented sample course
tools/make-parts.py     regenerates src/ooxml-parts.js (needs python-pptx)
tests/verify.js         node tests against src/ (writes sample files to tests/out/)
tests/ooxml-check.py    opens those files with python-pptx and python-docx
tests/browser-check.py  Playwright: drives the page, downloads and opens the files
tests/make-fixture.py   writes tests/fixtures/publisher-short.pptx with python-pptx
```

The page and every test load the same `src/` files. Nothing is duplicated.

## Run the tests

```
node tests/verify.js                 # 91 checks: 91 passed, 0 failed
pip install python-pptx python-docx
python3 tests/ooxml-check.py         # 18 file checks: 18 passed, 0 failed
python3 tests/browser-check.py       # 49 browser checks: 49 passed, 0 failed
```

Saved runs: `tests/test-output.txt`, `tests/ooxml-output.txt`, `tests/browser-output.txt`.

## How the logic works

| Step | What it does |
|---|---|
| Input checks | Empty slides, untitled slides, duplicate numbers, objectives or examples with no text: skipped and reported, never fatal |
| Matching | TF-IDF similarity between each objective and each publisher slide. An objective is covered only if a slide matches what is specific to it, not just the chapter's topic words. Slides are shared out strongest first, each used once. Your corrections (`assign`) win |
| Deck | Your sequence: title, decide-first opener, objectives, then per objective explainer (if a named concept is never explained), concept slides, an example from your bank, a prompt (yours first, else a draft in your style). Objectives with no slide use your vignette's decision point or ask for your material |
| Format | Bullet and word limits; anything trimmed moves to the notes in full. Class minutes shared by segment weight with largest-remainder rounding, so they add up exactly |
| Approval | Each approval stores a fingerprint of the slide. Final export needs every slide approved as it is now, and no gaps |
| Versions | Each change records which slides were added, removed or changed |
| Cases | Disguise map applied longest-first. Every figure (money, percent, year, counts like "three-week") is traced to a fact the reader may see; mismatches are contradictions of the nearest fact or unsupported |
| Citations | Author-year citations parsed (several per bracket, et al., pages). Not in library, not found, or unverified: blocked. Quotations need a page. AI paragraphs need your review |
| Privacy | Student information and interviews restricted; unpublished, confidential or licensed material private; public material public. Redaction of names, IDs, emails and phones |
| Cost | Token estimates per job times Anthropic list prices, plus your server estimate |

Settings (`src/facultyEngine.js` DEFAULTS): bullets per slide, words per bullet, match threshold, slides per objective, class minutes, explainers, segment weights.

## Extending it

- Another workflow: add a builder next to `buildDeck` and give it the same gate.
- Your own template: replace the theme in `tools/make-parts.py` with your university template and regenerate.
- A stricter style: add phrases to `GENERIC` or new checks to `checkCase`.

## What the delivered version adds

Ingestion of your real PowerPoint, Word, PDF and spreadsheet files into a private index (Postgres with pgvector) with metadata and provenance; Claude through the API under business terms for the drafting steps, with these checks run on every draft; n8n workflows; your templates and voice from your own decks; a review studio on your data with sign-in; audit log; administrator documentation and training. All accounts in your name.

Sample data is invented. The Porter (1980, 1985) and Barney (1991) references are real published works; "Whitlow & Haines 2022" is a planted fake.

Built by Taiwo, Pathfinder Automation Solutions.
