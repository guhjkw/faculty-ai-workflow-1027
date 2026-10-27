// src/facultyEngine.js: the logic behind the Faculty Course Studio demo. The page and the tests load this
// same file. It turns a publisher deck, chapter objectives and your prior materials into a structured
// teaching-deck draft with instructor-only notes; keeps a disguised case and its teaching note consistent
// with one master record of facts; checks research citations and provenance; and gates every final export
// behind your approval. Nothing here calls a model: in the demo, stored drafts stand in for the model, and
// every check below is the same check the delivered system runs on the model's output.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FacultyEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- settings (how you teach; all tunable) ----------
  const DEFAULTS = {
    maxBullets: 5,          // student-facing bullets per slide; the rest move to your notes
    maxWords: 12,           // words per bullet; longer wording moves to your notes in full
    matchThreshold: 0.12,   // how closely a publisher slide must match an objective to count as covering it
    slidesPerObjective: 2,  // publisher slides kept per objective
    secondaryRatio: 0.45,   // a second slide joins an objective only if it matches at least this share of the best one
    classMinutes: 75,
    explainers: true,       // add a draft explainer when an objective names a concept no slide explains
    // Relative weight of each segment when the class time is shared out (not minutes).
    minutes: { opener: 4, objectives: 2, explainer: 4, concept: 5, example: 4, prompt: 6, decision: 10, activity: 12, exit: 4, gap: 0, title: 0, answerKey: 0 },
  };
  function settings(over) {
    const c = JSON.parse(JSON.stringify(DEFAULTS)), errors = [];
    Object.keys(over || {}).forEach((k) => { if (k === 'minutes') Object.assign(c.minutes, over.minutes); else c[k] = over[k]; });
    const whole = (k, lo, hi) => { if (!Number.isInteger(c[k]) || c[k] < lo || c[k] > hi) errors.push(k + ' must be a whole number from ' + lo + ' to ' + hi); };
    whole('maxBullets', 2, 8); whole('maxWords', 6, 30); whole('slidesPerObjective', 1, 4); whole('classMinutes', 30, 180);
    if (!(typeof c.matchThreshold === 'number' && c.matchThreshold >= 0.02 && c.matchThreshold <= 0.6)) errors.push('matchThreshold must be between 0.02 and 0.6');
    return { cfg: c, errors };
  }

  // ---------- text ----------
  const STOP = new Set(('a an and are as at be by can for from has have how in into is it its of on or that the their them they this to ' +
    'using was were what when where which who why will with your you not but also each than then there these those such our we us do does ' +
    'did being been more most other only own same so too very just over under again once here both any few some no nor all if out up ' +
    'about between through during before after above below one every').split(' '));
  const words = (s) => String(s || '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  function stem(w) {
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
    return w;
  }
  const terms = (s) => words(s).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  function clip(text, n) {
    const w = String(text).trim().split(/\s+/);
    return w.length <= n ? { text: String(text).trim(), cut: false } : { text: w.slice(0, n).join(' ').replace(/[,;:]$/, '') + '…', cut: true };
  }
  // A concept is found when its stemmed words appear in order, so "business-level strategies" finds "business-level strategy".
  function hasConcept(text, term) {
    const t = words(text).map(stem), c = words(term).map(stem);
    for (let i = 0; i + c.length <= t.length; i++) if (c.every((w, j) => t[i + j] === w)) return true;
    return false;
  }
  const conceptsIn = (text, concepts) => concepts.filter((c) => hasConcept(text, c.term)).map((c) => c.term);
  function hash(obj) { // short, stable fingerprint of a slide's content, so an edit after approval is noticed
    const s = JSON.stringify(obj);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  // ---------- retrieval: which publisher slides cover which objective ----------
  function index(docs) {
    const df = new Map();
    docs.forEach((d) => new Set(d).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
    const idf = (t) => Math.log((docs.length + 1) / ((df.get(t) || 0) + 1)) + 1;
    return (d) => {
      const tf = new Map(), v = new Map();
      d.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
      tf.forEach((n, t) => v.set(t, (1 + Math.log(n)) * idf(t)));
      return v;
    };
  }
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    a.forEach((x, t) => { na += x * x; if (b.has(t)) dot += x * b.get(t); });
    b.forEach((y) => { nb += y * y; });
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }
  const META = /^(chapter\s+\d+|learning objectives|objectives|chapter summary|summary|review questions|discussion questions|agenda)\b/i;

  // ---------- input checks: bad rows are skipped and reported, never fatal ----------
  function validate(input) {
    const problems = [];
    const slides = [], seenN = new Set();
    (input.publisherSlides || []).forEach((s, i) => {
      const at = 'publisher slide ' + (s && s.n != null ? s.n : '#' + (i + 1));
      if (!s || typeof s !== 'object') return problems.push(at + ': not a slide, skipped');
      const title = typeof s.title === 'string' ? s.title.trim() : '';
      const bullets = Array.isArray(s.bullets) ? s.bullets.map((b) => (typeof b === 'string' ? b : b && b.text)).filter((b) => typeof b === 'string' && b.trim()) : [];
      if (!title && !bullets.length) return problems.push(at + ': empty slide, skipped');
      if (!title) problems.push(at + ': no title; the first bullet is used as the title');
      const n = Number.isInteger(s.n) && !seenN.has(s.n) ? s.n : slides.length + 1;
      if (s.n != null && n !== s.n) problems.push(at + ': duplicate slide number, renumbered ' + n);
      seenN.add(n);
      slides.push({ n, title: title || bullets[0], bullets: title ? bullets : bullets.slice(1), notes: typeof s.notes === 'string' ? s.notes.trim() : '' });
    });
    const objectives = [];
    (input.objectives || []).forEach((o, i) => {
      if (!o || !String(o.text || '').trim()) return problems.push('objective #' + (i + 1) + ': no text, skipped');
      objectives.push({ id: String(o.id || 'LO' + (i + 1)).trim(), text: String(o.text).trim() });
    });
    const prior = input.prior || {};
    const examples = (prior.examples || []).filter((e, i) => {
      if (!e || !String(e.text || '').trim()) { problems.push('example #' + (i + 1) + ': no text, skipped'); return false; }
      return true;
    });
    return { slides, objectives, examples, problems };
  }

  // Two scores per objective and slide: "full" uses every word of the objective; "specific" drops the
  // chapter's own topic words (for Chapter 6, "business-level strategy"), which every objective shares. An
  // objective counts as covered only if some slide matches what is specific to it. Slides are then shared
  // out by specific + half of full, strongest first, each slide used once. assign = { LO id: [slide n] }
  // is your correction, and wins over the proposal.
  function mapObjectives(objectives, slides, concepts, cfg, chapter, assign) {
    const content = slides.filter((s) => !META.test(s.title) && s.bullets.length);
    const docTerms = content.map((s) => terms(s.title).concat(terms(s.title), terms(s.bullets.join(' ')), terms(s.notes)));
    const vec = index(docTerms), svecs = docTerms.map(vec), topic = new Set(terms(chapter || '').filter((t) => t !== 'chapter'));
    const pairs = [], best = objectives.map(() => 0), problems = [];
    objectives.forEach((o, oi) => {
      const q = terms(o.text), full = vec(q), spec = vec(q.filter((t) => !topic.has(t)));
      content.forEach((s, si) => {
        const f = cosine(full, svecs[si]), sp = cosine(spec, svecs[si]);
        best[oi] = Math.max(best[oi], sp);
        pairs.push({ oi, s, score: sp + f / 2, f, sp });
      });
    });
    const used = new Set(), byLo = objectives.map(() => []), manual = objectives.map(() => false);
    const byNum = new Map(content.map((s) => [s.n, s]));
    objectives.forEach((o, oi) => {
      if (!assign || !Array.isArray(assign[o.id])) return;
      manual[oi] = true;
      assign[o.id].forEach((n) => {
        if (!byNum.has(n)) return problems.push(o.id + ': publisher slide ' + n + ' does not exist or is a title/summary slide');
        if (used.has(n)) return problems.push(o.id + ': publisher slide ' + n + ' is already used');
        used.add(n);
        byLo[oi].push({ n, score: null, yours: true });
      });
    });
    // Strongest first; ties go to the earlier slide, then the earlier objective.
    pairs.sort((a, b) => b.score - a.score || a.s.n - b.s.n || a.oi - b.oi);
    pairs.forEach((p) => {
      if (manual[p.oi] || best[p.oi] < cfg.matchThreshold || p.score < cfg.matchThreshold) return;
      if (used.has(p.s.n) || byLo[p.oi].length >= cfg.slidesPerObjective) return;
      if (byLo[p.oi].length && p.score < byLo[p.oi][0].score * cfg.secondaryRatio) return;
      used.add(p.s.n);
      byLo[p.oi].push({ n: p.s.n, score: Math.round(p.score * 1000) / 1000 });
    });
    byLo.forEach((l) => l.sort((a, b) => a.n - b.n));
    return {
      problems,
      map: objectives.map((o, i) => ({ id: o.id, text: o.text, slides: byLo[i], manual: manual[i], specific: Math.round(best[i] * 1000) / 1000, concepts: conceptsIn(o.text, concepts) })),
      meta: slides.filter((s) => META.test(s.title) || !s.bullets.length).map((s) => s.n),
      unused: content.filter((s) => !used.has(s.n)).map((s) => s.n),
    };
  }
  // Explained = a publisher slide is about it (title) or defines it ("X: ...", "X is ...", "X means ...").
  function explained(term, slides) {
    const re = new RegExp('^' + escapeRe(term).replace(/[- ]/g, '[- ]') + 's?\\s*(:|\\bis\\b|\\bare\\b|\\bmeans\\b|\\brefers to\\b)', 'i');
    return slides.some((s) => hasConcept(s.title, term) || s.bullets.some((b) => re.test(b.trim())));
  }

  // ---------- the deck ----------
  function buildDeck(input, over) {
    const st = settings(over);
    const cfg = st.cfg, v = validate(input), meta = input.meta || {}, prior = input.prior || {};
    const concepts = (input.concepts || []).filter((c) => c && c.term);
    const fills = input.fills || {}, edits = input.edits || {};
    const m = mapObjectives(v.objectives, v.slides, concepts, cfg, meta.chapter, input.assign);
    const problems = v.problems.concat(st.errors, m.problems);
    const byN = new Map(v.slides.map((s) => [s.n, s]));
    const out = [], skipped = [], usedEx = new Set(), usedPrompt = new Set();
    const anticipatedFor = (cs) => (prior.anticipated || []).filter((a) => a.concepts.some((c) => cs.includes(c)));
    const vig = input.vignette;
    const covered = [];

    function push(s) {
      if (fills[s.key] && fills[s.key].skip) { skipped.push({ key: s.key, title: s.title }); return; }
      if (fills[s.key] && (fills[s.key].bullets || []).some((b) => String(b).trim())) {
        s.bullets = fills[s.key].bullets.filter((b) => String(b).trim()).map((t) => ({ text: String(t).trim() }));
        if (fills[s.key].title) s.title = String(fills[s.key].title).trim();
        s.gap = false; s.provenance = 'yours'; s.source = 'Added by you in the studio';
        s.notes = s.notes.filter((n) => !/^Needs your material/.test(n));
      }
      if (edits[s.key]) {
        if (edits[s.key].title) s.title = String(edits[s.key].title).trim();
        if (Array.isArray(edits[s.key].bullets)) s.bullets = edits[s.key].bullets.filter((b) => String(b).trim()).map((t) => ({ text: String(t).trim() }));
        s.edited = true;
      }
      s.instructorOnly = !!s.instructorOnly;
      s.gap = !!s.gap;
      out.push(s);
    }
    const slide = (o) => Object.assign({ bullets: [], notes: [], provenance: 'yours', source: '', lo: null, gap: false }, o);

    push(slide({ key: 'title', kind: 'title', title: meta.deckTitle || 'Untitled deck', subtitle: [meta.course, meta.term].filter(Boolean).join(' · '), source: 'Your course details' }));
    const deckConcepts = conceptsIn(v.objectives.map((o) => o.text).join(' ') + ' ' + v.slides.map((s) => s.title).join(' '), concepts);
    const opener = (prior.openers || []).map((o, i) => ({ o, i, k: o.concepts.filter((c) => deckConcepts.includes(c)).length })).sort((a, b) => b.k - a.k || a.i - b.i)[0];
    if (opener && opener.k > 0) push(slide({ key: 'opener', kind: 'opener', title: 'Decide first', bullets: [{ text: opener.o.text }], notes: ['Purpose: students commit to a choice before the vocabulary arrives; return to it at the end.'], source: opener.o.source }));
    push(slide({ key: 'objectives', kind: 'objectives', title: (prior.voice && prior.voice.objectivesTitle) || 'Learning objectives', bullets: v.objectives.map((o) => ({ text: cap(o.text) })), notes: v.objectives.map((o) => o.id + ': ' + o.text), source: 'Your chapter objectives' }));

    m.map.forEach((lo) => {
      const pub = lo.slides.map((x) => byN.get(x.n));
      const loConcepts = conceptsIn(lo.text + ' ' + pub.map((s) => s.title + ' ' + s.bullets.join(' ')).join(' '), concepts);
      // 1. Explainers for concepts the objective names but no publisher slide explains.
      if (cfg.explainers && pub.length) {
        lo.concepts.filter((t) => !explained(t, v.slides)).forEach((t) => {
          const c = concepts.find((x) => x.term === t);
          const draft = c && Array.isArray(c.draftDefinition) && c.draftDefinition.length;
          push(slide({ key: 'explainer:' + t, kind: 'explainer', lo: lo.id, title: (c && c.explainerTitle) || 'Key idea: ' + cap(t),
            bullets: draft ? c.draftDefinition.map((d) => ({ text: d })) : [],
            notes: draft ? ['AI draft: the publisher deck uses "' + t + '" but never explains it. Review the wording before class.'] : ['Needs your material: write a short definition of "' + t + '".'],
            provenance: draft ? 'ai-draft' : 'gap', gap: !draft, source: draft ? 'AI draft from your glossary request' : 'Needs your definition' }));
        });
      }
      // 2. Concept slides from the matched publisher slides, trimmed to your format; nothing is lost.
      pub.forEach((s) => {
        const notes = [], kept = s.bullets.slice(0, cfg.maxBullets), extra = s.bullets.slice(cfg.maxBullets);
        const bullets = kept.map((b) => {
          const c = clip(b, cfg.maxWords);
          if (c.cut) notes.push('Full wording: ' + b);
          return { text: c.text };
        });
        if (s.notes) notes.unshift('Talking point (publisher notes): ' + s.notes);
        extra.forEach((b) => notes.push('Moved to notes (over your ' + cfg.maxBullets + '-bullet limit): ' + b));
        const here = conceptsIn(s.title + ' ' + s.bullets.join(' '), concepts);
        here.filter((t) => !explained(t, v.slides) && !(cfg.explainers && lo.concepts.includes(t))).forEach((t) => notes.push('Explain first: "' + t + '" is used here but never explained in the publisher deck.'));
        anticipatedFor(here).forEach((a) => {
          notes.push('Anticipate: ' + a.responses.join('; '));
          notes.push('Probe: ' + a.probe);
          notes.push('Watch for: ' + a.misconception);
        });
        push(slide({ key: 'concept:' + s.n, kind: 'concept', lo: lo.id, title: s.title, bullets, notes, provenance: 'publisher', source: 'Publisher slide ' + s.n }));
      });
      // 3. An example from your own bank (most shared concepts, then one not used yet, then bank order).
      if (pub.length) {
        const ranked = v.examples.map((e, i) => ({ e, i, k: (e.concepts || []).filter((c) => loConcepts.includes(c)).length }))
          .filter((x) => x.k > 0).sort((a, b) => b.k - a.k || (usedEx.has(a.e.id) ? 1 : 0) - (usedEx.has(b.e.id) ? 1 : 0) || a.i - b.i);
        if (ranked.length) {
          const e = ranked[0].e;
          usedEx.add(e.id);
          push(slide({ key: 'example:' + lo.id, kind: 'example', lo: lo.id, title: 'Example: ' + e.title.replace(/\s*\(invented\)\s*$/, ''), bullets: [{ text: e.text }], notes: ['Ask: which strategy is this, and what would break it?'], source: e.source }));
        } else {
          push(slide({ key: 'example:' + lo.id, kind: 'example', lo: lo.id, title: 'Example for ' + lo.id, notes: ['Needs your material: none of your examples share a concept with ' + lo.id + '. Add one, or skip the example.'], provenance: 'gap', gap: true, source: 'Needs your example' }));
        }
      }
      // 4. A discussion prompt: yours if one fits, otherwise a draft in your decision-forcing style.
      if (pub.length) {
        const own = (prior.prompts || []).find((p) => !usedPrompt.has(p.text) && p.concepts.some((c) => loConcepts.includes(c)));
        if (own) usedPrompt.add(own.text);
        if (own) push(slide({ key: 'prompt:' + lo.id, kind: 'prompt', lo: lo.id, title: 'Discuss', bullets: [{ text: own.text }], notes: ['Cold-call two students, then open the floor.'].concat(anticipatedFor(loConcepts).slice(0, 1).map((a) => 'Look for: ' + a.misconception)), source: own.source }));
        else {
          const verb = words(lo.text)[0];
          const focus = lo.concepts[0] || loConcepts[0] || 'this idea';
          const text = verb === 'describe' ? 'A Tampa Bay business you know: which of these strategies is it using? Name one sign.'
            : verb === 'explain' ? 'Pick one value chain activity. Would a cost leader and a differentiator run it the same way? Why not?'
            : verb === 'evaluate' ? 'Which risk would worry you most if you ran ' + focus + '? What would you watch for?'
            : 'You advise a local firm on ' + focus + '. What do you recommend first, and why?';
          push(slide({ key: 'prompt:' + lo.id, kind: 'prompt', lo: lo.id, title: 'Discuss', bullets: [{ text }], notes: ['AI draft in your decision-forcing style. Review before class.'], provenance: 'ai-draft', source: 'AI draft' }));
        }
        covered.push({ id: lo.id, by: 'publisher' });
      } else {
        // No publisher slide covers it: your vignette's decision point, or a clear request for material.
        const q = vig && (vig.questions || []).find((x) => x.lo === lo.id);
        if (q) {
          const dec = (vig.facts || []).find((f) => f.kind === 'decision' && f.audience !== 'instructor');
          push(slide({ key: 'decision:' + lo.id, kind: 'decision', lo: lo.id, title: 'Decision point', bullets: [{ text: disguise(dec ? dec.text : '', vig.disguise || []) }, { text: disguise(q.q, vig.disguise || []) }],
            notes: ['From your vignette (disguised). Teaching note analysis: ' + disguise(q.analysis, vig.disguise || [])], source: 'Your vignette, disguised' }));
          covered.push({ id: lo.id, by: 'vignette' });
        } else {
          push(slide({ key: 'gap:' + lo.id, kind: 'gap', lo: lo.id, title: lo.id + ': needs your material', notes: ['Needs your material: no publisher slide covers "' + lo.text + '".'], provenance: 'gap', gap: true, source: 'Needs your material' }));
          covered.push({ id: lo.id, by: 'gap' });
        }
      }
    });

    if (prior.activity) push(slide({ key: 'activity', kind: 'activity', title: 'Activity: ' + prior.activity.title, bullets: prior.activity.student.map((t) => ({ text: t })), notes: prior.activity.instructor.map((t, i) => 'Step ' + (i + 1) + ': ' + t), source: prior.activity.source }));
    if (prior.exit) push(slide({ key: 'exit', kind: 'exit', title: 'Exit ticket', bullets: [{ text: prior.exit.text }], notes: ['Collect on the way out; sort into got it / partly / not yet before next class.'], source: prior.exit.source }));
    const keyLines = [];
    out.filter((s) => s.kind === 'prompt' || s.kind === 'decision').forEach((s) => {
      keyLines.push({ text: (s.lo ? s.lo + ': ' : '') + clip(s.bullets[s.bullets.length - 1].text, 12).text });
      const look = s.notes.find((n) => /^(Look for|From your vignette)/.test(n));
      keyLines.push({ text: look ? look.replace(/^Look for: /, '').replace(/^From your vignette \(disguised\)\. Teaching note analysis: /, '') : 'Strong answers name the strategy and one supporting fact.', lvl: 1 });
    });
    push(slide({ key: 'answerKey', kind: 'answerKey', title: 'Answer key', bullets: keyLines, notes: ['Instructor only: hidden in your copy, removed from the student copy.'], instructorOnly: true, source: 'Built from your prompts and teaching notes' }));

    // Time: class minutes shared out by segment weight, largest remainder first, so they add up exactly.
    const w = out.map((s) => cfg.minutes[s.kind] || 0), total = w.reduce((a, b) => a + b, 0);
    const raw = w.map((x) => (total ? x / total * cfg.classMinutes : 0)), mins = raw.map(Math.floor);
    let left = cfg.classMinutes - mins.reduce((a, b) => a + b, 0);
    raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i).forEach((x) => { if (left > 0 && w[x.i] > 0) { mins[x.i]++; left--; } });
    out.forEach((s, i) => {
      s.minutes = total ? mins[i] : 0;
      if (s.minutes) s.notes.unshift('Time: ' + s.minutes + ' min');
      s.hash = hash([s.title, s.subtitle || '', s.bullets.map((b) => [b.text, b.lvl || 0])]);
    });

    const conceptReport = concepts.map((c) => ({ term: c.term, explained: explained(c.term, v.slides), slides: v.slides.filter((s) => hasConcept(s.title + ' ' + s.bullets.join(' '), c.term)).map((s) => s.n) })).filter((c) => c.slides.length || m.map.some((l) => l.concepts.includes(c.term)));
    return {
      meta, cfg, slides: out, skipped, problems,
      coverage: m.map.map((l) => Object.assign({}, l, covered.find((c) => c.id === l.id) || { by: 'gap' })),
      metaSlides: m.meta, unusedSlides: m.unused, concepts: conceptReport,
      stats: {
        slides: out.length, studentSlides: out.filter((s) => !s.instructorOnly).length, instructorOnly: out.filter((s) => s.instructorOnly).length,
        aiDraft: out.filter((s) => s.provenance === 'ai-draft').length, gaps: out.filter((s) => s.gap).length,
        publisher: out.filter((s) => s.provenance === 'publisher').length, minutes: out.reduce((a, s) => a + s.minutes, 0),
      },
    };
  }

  // ---------- approval and versions ----------
  // approvals: { slideKey: hashWhenApproved }. Final export needs every slide approved as it is now.
  function gate(deck, approvals) {
    const a = approvals || {}, blockers = [];
    let ok = 0;
    deck.slides.forEach((s) => {
      if (s.gap) blockers.push({ key: s.key, title: s.title, reason: 'needs your material' });
      else if (!a[s.key]) blockers.push({ key: s.key, title: s.title, reason: 'not approved yet' });
      else if (a[s.key] !== s.hash) blockers.push({ key: s.key, title: s.title, reason: 'changed since you approved it' });
      else ok++;
    });
    return { final: blockers.length === 0, approved: ok, total: deck.slides.length, blockers };
  }
  function diffDecks(prev, next) {
    const p = new Map(prev.slides.map((s) => [s.key, s])), n = new Map(next.slides.map((s) => [s.key, s]));
    const added = next.slides.filter((s) => !p.has(s.key)).map((s) => s.title);
    const removed = prev.slides.filter((s) => !n.has(s.key)).map((s) => s.title);
    const changed = next.slides.filter((s) => p.has(s.key) && p.get(s.key).hash !== s.hash).map((s) => s.title);
    return { added, removed, changed, same: !added.length && !removed.length && !changed.length };
  }

  // ---------- exports ----------
  const PROV = { publisher: 'Publisher', yours: 'Your material', 'ai-draft': 'AI draft', gap: 'Needs your material' };
  function pptxModel(deck, opts) {
    const o = Object.assign({ version: 'student', final: false, approvals: {} }, opts);
    const g = gate(deck, o.approvals);
    if (o.final && !g.final) return { ok: false, reasons: g.blockers.map((b) => b.title + ': ' + b.reason) };
    const draft = !o.final, instr = o.version === 'instructor', pubName = (deck.meta.publisher || 'the publisher').replace(/\s*\(invented publisher sample\)/, '');
    const slides = deck.slides.filter((s) => instr || !s.instructorOnly).filter((s) => !(s.gap && !instr)).map((s) => {
      let footer = '';
      if (instr) footer = PROV[s.provenance] + (s.source && s.provenance !== 'gap' ? ': ' + s.source : '') + ' · ' + (o.approvals[s.key] === s.hash ? 'approved' : 'not approved yet');
      else if (s.provenance === 'publisher') footer = 'Adapted from ' + pubName + ', ' + s.source.replace('Publisher ', '');
      if (draft) footer = 'DRAFT' + (footer ? ' · ' + footer : '');
      return {
        layout: s.kind === 'title' ? 'title' : 'content', title: s.title, subtitle: s.subtitle, bullets: s.bullets,
        notes: instr ? s.notes : [], hidden: instr && s.instructorOnly,
        tag: instr && s.instructorOnly ? 'INSTRUCTOR ONLY' : instr && s.provenance === 'ai-draft' ? 'AI DRAFT' : null, footer,
      };
    });
    const base = (deck.meta.course || 'course').split(' ').slice(0, 2).join('') + '-' + (deck.meta.deckTitle || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return {
      ok: true, fileName: base + '-' + o.version + (draft ? '-DRAFT' : '-final') + '.pptx',
      deck: { title: deck.meta.deckTitle + (draft ? ' (draft)' : ''), author: deck.meta.author || '', created: o.when, slides },
    };
  }
  function guideDoc(deck, opts) {
    const o = Object.assign({ final: false, approvals: {} }, opts), g = gate(deck, o.approvals);
    if (o.final && !g.final) return { ok: false, reasons: g.blockers.map((b) => b.title + ': ' + b.reason) };
    const b = [];
    b.push({ type: 'title', text: 'Instructor guide: ' + deck.meta.deckTitle });
    b.push({ type: 'source', text: [deck.meta.course, deck.meta.term, o.final ? 'Final (every slide approved)' : 'DRAFT: not every slide is approved'].filter(Boolean).join(' · ') });
    b.push({ type: 'h1', text: 'Learning objectives and coverage' });
    deck.coverage.forEach((c) => b.push({ type: 'bullet', runs: [{ text: c.id + ' ', b: true }, { text: c.text + '. ' }, { text: c.by === 'publisher' ? 'Publisher slide' + (c.slides.length > 1 ? 's ' : ' ') + c.slides.map((x) => x.n).join(', ') : c.by === 'vignette' ? 'Covered by your vignette' : 'Needs your material', i: true }] }));
    b.push({ type: 'h1', text: 'Timing (' + deck.stats.minutes + ' minutes)' });
    const seg = [];
    deck.slides.filter((s) => s.minutes).forEach((s) => {
      const name = s.kind === 'concept' || s.kind === 'explainer' ? 'Concepts' + (s.lo ? ' (' + s.lo + ')' : '') : s.kind === 'example' ? 'Example' + (s.lo ? ' (' + s.lo + ')' : '') : s.kind === 'prompt' ? 'Discussion' + (s.lo ? ' (' + s.lo + ')' : '') : cap(s.kind === 'decision' ? 'Decision point' : s.kind);
      const last = seg[seg.length - 1];
      if (last && last[0] === name) { last[1] += s.minutes; last[2].push(s.title); } else seg.push([name, s.minutes, [s.title]]);
    });
    b.push({ type: 'table', widths: [3, 1, 6], rows: [['Segment', 'Minutes', 'Slides']].concat(seg.map((x) => [x[0], String(x[1]), x[2].join('; ')])) });
    b.push({ type: 'h1', text: 'Discussion flow' });
    deck.slides.filter((s) => s.kind === 'prompt' || s.kind === 'decision' || s.kind === 'activity').forEach((s) => {
      b.push({ type: 'h2', text: s.title + (s.lo ? ' (' + s.lo + ')' : '') + (s.minutes ? ', ' + s.minutes + ' min' : '') });
      s.bullets.forEach((x) => b.push({ type: 'p', text: x.text }));
      s.notes.filter((n) => !/^Time:/.test(n)).forEach((n) => b.push({ type: 'note', text: n }));
    });
    const anticip = deck.slides.filter((s) => s.kind === 'concept').map((s) => s.notes.filter((n) => /^(Anticipate|Probe|Watch for)/.test(n))).filter((n) => n.length);
    if (anticip.length) {
      b.push({ type: 'h1', text: 'Anticipated responses, probes and misconceptions' });
      const seen = new Set();
      anticip.forEach((ns) => ns.forEach((n) => { if (!seen.has(n)) { seen.add(n); b.push({ type: 'bullet', text: n }); } }));
    }
    const unexplained = deck.concepts.filter((c) => !c.explained);
    if (unexplained.length) {
      b.push({ type: 'h1', text: 'Concepts the publisher deck uses but never explains' });
      unexplained.forEach((c) => b.push({ type: 'bullet', text: c.term + (c.slides.length ? ' (publisher slides ' + c.slides.join(', ') + ')' : '') }));
    }
    const key = deck.slides.find((s) => s.kind === 'answerKey');
    if (key) { b.push({ type: 'h1', text: 'Answer key' }); key.bullets.forEach((x) => b.push({ type: 'bullet', text: x.text, lvl: x.lvl || 0 })); }
    b.push({ type: 'h1', text: 'Source record' });
    b.push({ type: 'table', widths: [4, 2, 4, 2], rows: [['Slide', 'Provenance', 'Source', 'Status']].concat(deck.slides.map((s) => [s.title, PROV[s.provenance], s.source, s.gap ? 'needs material' : o.approvals[s.key] === s.hash ? 'approved' : 'not approved'])) });
    return { ok: true, fileName: 'instructor-guide-' + (o.final ? 'final' : 'DRAFT') + '.docx', doc: { title: 'Instructor guide: ' + deck.meta.deckTitle, author: deck.meta.author || '', created: o.when, blocks: b } };
  }

  // ---------- vignettes: one master record, two documents, no contradictions ----------
  function disguise(text, map) {
    let out = String(text || '');
    (map || []).slice().sort((a, b) => b.real.length - a.real.length).forEach((m) => {
      out = out.replace(new RegExp('\\b' + escapeRe(m.real) + '\\b', 'gi'), m.disguised);
    });
    return out;
  }
  const NUMWORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const UNIT = '(mile|week|day|store|month|employee|location|hour)s?';
  function numbersIn(text) {
    const s = String(text || ''), found = [], taken = [];
    const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
    const add = (m, kind, value, unit) => { if (free(m.index, m.index + m[0].length)) { taken.push([m.index, m.index + m[0].length]); found.push({ raw: m[0].trim(), kind, value, unit: unit || '', at: m.index }); } };
    let m;
    const money = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|bn|m|k)?\b/gi;
    while ((m = money.exec(s))) {
      const v = parseFloat(m[1].replace(/,/g, '')), u = (m[2] || '').toLowerCase();
      add(m, 'money', Math.round((u === 'million' || u === 'm' ? v : u === 'billion' || u === 'bn' ? v * 1000 : u === 'thousand' || u === 'k' ? v / 1000 : v / 1e6) * 1e4) / 1e4, '$M');
    }
    const pct = /(\d+(?:\.\d+)?)\s?(%|percent\b)/gi;
    while ((m = pct.exec(s))) add(m, 'percent', parseFloat(m[1]), '%');
    const count = new RegExp('\\b(\\d+(?:\\.\\d+)?|' + Object.keys(NUMWORD).join('|') + ')[\\s-]' + UNIT + '\\b', 'gi');
    while ((m = count.exec(s))) add(m, 'count', NUMWORD[m[1].toLowerCase()] || parseFloat(m[1]), stem(m[2].toLowerCase()));
    const year = /\b(19\d{2}|20\d{2})\b/g;
    while ((m = year.exec(s))) add(m, 'year', +m[1], '');
    return found.sort((a, b) => a.at - b.at);
  }
  const sameNum = (a, b) => a.kind === b.kind && Math.abs(a.value - b.value) < 1e-6 && (a.kind !== 'count' || a.unit === b.unit);

  function buildCase(v) {
    const map = v.disguise || [], facts = v.facts || [];
    const D = (t) => disguise(t, map);
    const shared = facts.filter((f) => f.audience !== 'instructor');
    const para1 = shared.filter((f) => f.kind === 'context' || f.kind === 'event').map((f) => D(f.text)).join(' ');
    const para2 = shared.filter((f) => f.kind === 'number').map((f) => D(f.text)).join(' ');
    const decision = shared.filter((f) => f.kind === 'decision').map((f) => D(f.text)).join(' ');
    const title = D(v.workingTitle || 'Untitled case');
    const qs = (v.questions || []).map((q) => D(q.q));
    const student = [title, para1, para2, 'Decision point', decision, 'Questions'].concat(qs.map((q, i) => (i + 1) + '. ' + q)).join('\n\n');
    const epilogue = facts.filter((f) => f.audience === 'instructor').map((f) => D(f.text));
    const teaching = ['Teaching note: ' + title, 'Synopsis', D(shared.filter((f) => f.kind === 'context')[0] ? shared.filter((f) => f.kind === 'context')[0].text : '') + ' ' + decision,
      'Questions and analysis'].concat((v.questions || []).map((q, i) => (i + 1) + '. ' + D(q.q) + '\nAnalysis: ' + D(q.analysis) + ' (facts ' + q.facts.join(', ') + ')'),
      ['Epilogue (do not share with students)'].concat(epilogue)).join('\n\n');
    return { title, paragraphs: [para1, para2].filter(Boolean), decision, questions: qs, epilogue, studentText: student, teachingText: teaching };
  }
  const GENERIC = ["in today's fast-paced", 'fast-paced world', 'game changer', 'game-changer', 'cutting-edge', 'synergies', 'synergy', 'paradigm shift', 'at the end of the day', 'think outside the box', 'best-in-class', 'world-class', 'move the needle', 'low-hanging fruit', 'navigate the landscape', 'ever-evolving'];
  const COMMON = new Set(['marine', 'supply', 'company', 'group', 'inc', 'llc', 'the', 'and', 'retail', 'store']);
  // role: 'student' (only facts both versions share) or 'teaching' (every fact). Returns blocking issues
  // (name leaks, instructor-only facts in the student copy, contradictions, unsupported figures) and warnings.
  function checkCase(text, v, role) {
    const map = v.disguise || [], s = String(text || ''), issues = [];
    const visible = (v.facts || []).filter((f) => role === 'teaching' || f.audience !== 'instructor');
    const hidden = (v.facts || []).filter((f) => role !== 'teaching' && f.audience === 'instructor');
    const factNums = (fs) => fs.map((f) => ({ f, nums: numbersIn(disguise(f.text, map)) }));
    const vis = factNums(visible), hid = factNums(hidden);
    map.forEach((m) => {
      const tokens = [m.real].concat(m.real.split(/\s+/).filter((t) => /^[A-Z]/.test(t) && t.length >= 4 && !COMMON.has(t.toLowerCase())));
      const hit = tokens.find((t) => new RegExp('\\b' + escapeRe(t) + '\\b', 'i').test(s));
      if (hit) issues.push({ type: 'leak-name', severity: 'block', text: hit, detail: '"' + hit + '" is a real name in your master record; use "' + m.disguised + '"' });
    });
    const sentences = s.split(/(?<=[.!?])\s+|\n+/);
    // Topic words only: digits and number words say nothing about which fact a sentence is about.
    const topic = (t) => terms(t).filter((w) => !/^\d+$/.test(w) && !/^(million|billion|thousand|percent)$/.test(w));
    numbersIn(s).forEach((n) => {
      if (vis.some((x) => x.nums.some((y) => sameNum(n, y)))) return;
      const leak = hid.find((x) => x.nums.some((y) => sameNum(n, y)));
      if (leak) return issues.push({ type: 'leak-instructor', severity: 'block', text: n.raw, fact: leak.f.id, detail: n.raw + ' comes from ' + leak.f.id + ', an instructor-only fact (the epilogue)' });
      const sentence = sentences.find((x) => x.includes(n.raw)) || '';
      const st = new Set(topic(sentence));
      let best = null, score = 0;
      vis.forEach((x) => {
        const ft = new Set(topic(disguise(x.f.text, map)));
        const inter = [...st].filter((t) => ft.has(t)).length, j = inter / Math.max(1, new Set([...st, ...ft]).size);
        if (j > score && x.nums.some((y) => y.kind === n.kind)) { score = j; best = x; }
      });
      if (best && score >= 0.15) {
        const want = best.nums.filter((y) => y.kind === n.kind).map((y) => y.raw).join(' or ');
        issues.push({ type: 'contradiction', severity: 'block', text: n.raw, fact: best.f.id, detail: n.raw + ' contradicts ' + best.f.id + ' in the master record (' + want + ')' });
      } else issues.push({ type: 'unsupported', severity: 'block', text: n.raw, detail: n.raw + ' is not in the master record; add it as a fact with a source, or remove it' });
    });
    const lower = s.toLowerCase(), spans = [];
    GENERIC.map((g) => ({ g, at: lower.indexOf(g) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at || b.g.length - a.g.length).forEach((x) => {
      if (spans.some(([a, b]) => x.at < b && x.at + x.g.length > a)) return; // "in today's fast-paced world" is one phrase, not two
      spans.push([x.at, x.at + x.g.length]);
      issues.push({ type: 'generic', severity: 'warn', text: x.g, detail: '"' + x.g + '" reads as generic; say what actually happened' });
    });
    // Repetition: the same five words three times anywhere, or twice in one paragraph (a question may quote
    // the decision once; a paragraph that says the same thing twice is padding).
    const seen = new Map();
    s.split(/\n{2,}/).forEach((para, pi) => {
      const w = words(para);
      for (let i = 0; i + 5 <= w.length; i++) {
        const k = w.slice(i, i + 5).join(' '), e = seen.get(k) || { n: 0, paras: new Map() };
        e.n++; e.paras.set(pi, (e.paras.get(pi) || 0) + 1); seen.set(k, e);
      }
    });
    const reps = [...seen.entries()].filter(([k, e]) => !/^\d/.test(k) && (e.n >= 3 || [...e.paras.values()].some((x) => x > 1)));
    reps.slice(0, 3).forEach(([k, e]) => issues.push({ type: 'repetition', severity: 'warn', text: k, detail: '"' + k + '" appears ' + e.n + ' times' }));
    return { ok: !issues.some((i) => i.severity === 'block'), issues, numbers: numbersIn(s).length };
  }
  function caseDocs(v, studentText, teachingText, opts) {
    const o = Object.assign({ final: false }, opts), map = v.disguise || [];
    const cs = checkCase(studentText, v, 'student'), ct = checkCase(teachingText, v, 'teaching');
    if (o.final && (!cs.ok || !ct.ok)) return { ok: false, reasons: cs.issues.concat(ct.issues).filter((i) => i.severity === 'block').map((i) => i.detail) };
    const toBlocks = (txt) => String(txt).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const sb = toBlocks(studentText), title = sb.shift() || 'Case';
    const student = [{ type: 'title', text: title }, { type: 'source', text: 'Disguised teaching case. Names and identifying details are changed.' + (o.final ? '' : ' DRAFT.') }];
    sb.forEach((p) => {
      if (/^(Decision point|Questions)$/i.test(p)) student.push({ type: 'h1', text: p });
      else if (/^\d+\.\s/.test(p)) student.push({ type: 'number', text: p.replace(/^\d+\.\s/, '') });
      else student.push({ type: 'p', text: p });
    });
    const tb = toBlocks(teachingText), ttitle = tb.shift() || 'Teaching note';
    const teaching = [{ type: 'title', text: ttitle }, { type: 'source', text: 'Instructor only. Built from the same master record as the student case.' + (o.final ? '' : ' DRAFT.') }];
    tb.forEach((p) => {
      if (/^(Synopsis|Questions and analysis|Epilogue.*)$/i.test(p)) teaching.push({ type: 'h1', text: p });
      else if (/^\d+\.\s/.test(p)) {
        const [q, ...rest] = p.split('\n');
        teaching.push({ type: 'number', text: q.replace(/^\d+\.\s/, '') });
        rest.forEach((r) => teaching.push({ type: 'note', text: r }));
      } else teaching.push({ type: 'p', text: p });
    });
    teaching.push({ type: 'h1', text: 'Master record (disguised)' });
    teaching.push({ type: 'table', widths: [1, 7, 4, 2], rows: [['Fact', 'Statement', 'Source', 'Shown to']].concat((v.facts || []).map((f) => [f.id, disguise(f.text, map), f.source, f.audience === 'instructor' ? 'Instructor' : 'Both'])) });
    return { ok: true, student: { title, author: '', created: o.when, blocks: student }, teaching: { title: ttitle, author: '', created: o.when, blocks: teaching } };
  }

  // ---------- research: provenance and citations ----------
  function citations(text) {
    const out = [];
    const re = /\(([^()]*?\b\d{4}[a-z]?[^()]*)\)/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      m[1].split(/;\s*/).forEach((part) => {
        const c = /^\s*([A-Z][A-Za-z'’-]+(?:\s(?:&|and)\s[A-Z][A-Za-z'’-]+|\set al\.|(?:\s[a-z][A-Za-z'’-]+){1,2})?),?\s+(\d{4}[a-z]?)(?:,\s*(?:p|pp)\.\s*(\d+(?:[-–]\d+)?))?\s*$/.exec(part);
        if (c) out.push({ raw: part.trim(), key: c[1].replace(/\s+and\s+/, ' & ').replace('’', "'") + ' ' + c[2], page: c[3] || null });
      });
    }
    return out;
  }
  const TAG = { mine: 'Your original idea', source: 'Verified source', public: 'Public evidence', ai: 'AI draft language' };
  function checkMemo(memo, library) {
    const lib = new Map((library || []).map((e) => [e.key, e]));
    const rows = [], issues = [];
    (memo || []).forEach((p) => {
      const cites = citations(p.text), pi = [];
      cites.forEach((c) => {
        const e = lib.get(c.key);
        if (!e) pi.push({ severity: 'block', detail: '(' + c.raw + ') is not in your library: it cannot be cited until you add and verify it' });
        else if (e.status === 'not-found') pi.push({ severity: 'block', detail: '(' + c.raw + ') was suggested by an AI search and no database has it: blocked as a likely fabricated citation' });
        else if (e.status !== 'verified') pi.push({ severity: 'block', detail: '(' + c.raw + ') is unverified: check it before final' });
        if (e && e.sensitivity === 'confidential') pi.push({ severity: 'warn', detail: c.key + ' is confidential: it stays in your private workspace and is never sent to a model' });
      });
      if (/["“][^"”]{12,}["”]/.test(p.text) && !cites.some((c) => c.page)) pi.push({ severity: 'block', detail: 'a direct quotation needs a page number in its citation' });
      if (p.tag === 'source' && !cites.length) pi.push({ severity: 'block', detail: 'marked as resting on a source, but cites none' });
      if (p.tag === 'ai' && !p.reviewed) pi.push({ severity: 'block', detail: 'AI draft language: mark it reviewed (or rewrite it) before final' });
      rows.push({ id: p.id, tag: p.tag, label: TAG[p.tag] || p.tag, text: p.text, reviewed: !!p.reviewed, sources: cites.map((c) => c.key), issues: pi });
      pi.forEach((x) => issues.push(Object.assign({ para: p.id }, x)));
    });
    return { rows, issues, final: !issues.some((i) => i.severity === 'block') };
  }
  function memoDoc(memo, library, opts) {
    const o = Object.assign({ final: false }, opts), chk = checkMemo(memo, library);
    if (o.final && !chk.final) return { ok: false, reasons: chk.issues.filter((i) => i.severity === 'block').map((i) => i.para + ': ' + i.detail) };
    const lib = new Map((library || []).map((e) => [e.key, e]));
    const used = [...new Set(chk.rows.flatMap((r) => r.sources))].map((k) => lib.get(k)).filter((e) => e && e.status === 'verified' && e.sensitivity !== 'confidential');
    const blocks = [{ type: 'title', text: 'Research memo: source matrix' }, { type: 'source', text: o.final ? 'Final: every citation verified, every AI paragraph reviewed' : 'DRAFT: open items remain' }, { type: 'h1', text: 'Memo' }];
    chk.rows.forEach((r) => { blocks.push({ type: 'p', text: r.text }); blocks.push({ type: 'source', text: r.id + ' · ' + r.label + (r.tag === 'ai' ? (r.reviewed ? ' · reviewed by you' : ' · not reviewed') : '') }); });
    blocks.push({ type: 'h1', text: 'Source matrix' });
    blocks.push({ type: 'table', widths: [1, 3, 3, 5], rows: [['Para', 'Provenance', 'Sources', 'Open items']].concat(chk.rows.map((r) => [r.id, r.label, r.sources.join('; ') || 'none', r.issues.map((i) => i.detail).join(' | ') || 'none'])) });
    blocks.push({ type: 'h1', text: 'References (verified only)' });
    used.sort((a, b) => a.authors.localeCompare(b.authors) || a.year - b.year).forEach((e) => blocks.push({ type: 'p', text: e.authors + ' (' + e.year + '). ' + e.title + '. ' + e.venue + '.' }));
    return { ok: true, doc: { title: 'Research memo', author: '', created: o.when, blocks }, check: chk };
  }

  // ---------- privacy ----------
  function redact(text, names) {
    const hits = [];
    let out = String(text || '');
    const rule = (type, re, rep) => { out = out.replace(re, (m) => { hits.push({ type, value: m }); return rep; }); };
    rule('email', /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]');
    rule('student ID', /\b[Uu]\d{8}\b/g, '[student ID]');
    rule('phone', /(\+1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]');
    (names || []).slice().sort((a, b) => b.length - a.length).forEach((n) => rule('student name', new RegExp('\\b' + escapeRe(n) + '\\b', 'gi'), '[student]'));
    return { text: out, hits };
  }
  // Where each kind of material may go. Restricted material never leaves your storage unredacted.
  function tierFor(doc) {
    if (doc.studentInfo || doc.interview) return { tier: 'restricted', label: 'Restricted', route: 'Stays in your storage. Only redacted excerpts reach the model, or a local model runs on it.' };
    if (doc.confidential || doc.unpublished || doc.licensed) return { tier: 'private', label: 'Private', route: 'Model API under business terms (not used for training), stored encrypted in your own account.' };
    return { tier: 'public', label: 'Public', route: 'Any step may use it; cited as public evidence.' };
  }

  // ---------- running cost ----------
  // Anthropic list prices per million tokens (input, output), read 27 Oct 2026. Caching lowers them further.
  const PRICES = {
    'claude-opus-5-5': { label: 'Claude Opus 5.5', in: 4, out: 20 },
    'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', in: 2, out: 10 },
    'claude-haiku-5-5': { label: 'Claude Haiku 5.5', in: 0.1, out: 0.5 },
  };
  function monthlyCost(u) {
    const errors = [];
    const n = (k, hi) => { const x = Number(u[k]); if (!Number.isFinite(x) || x < 0 || x > hi) { errors.push(k + ' must be a number from 0 to ' + hi); return 0; } return x; };
    const decks = n('decks', 60), cases = n('cases', 40), memos = n('memos', 60), pages = n('pagesPerDeck', 400), hosting = n('hosting', 500);
    const p = PRICES[u.model];
    if (!p) errors.push('unknown model ' + u.model);
    if (errors.length) return { ok: false, errors };
    // Token estimates per job (assumptions, shown on the page): source pages are about 700 tokens each.
    const jobs = [['Teaching decks', decks, pages * 700 + 15000, 12000], ['Vignettes and teaching notes', cases, 9000, 7000], ['Research memos and source checks', memos, 30000, 6000]];
    const lines = jobs.map(([item, k, tin, tout]) => ({ item, detail: k + ' a month', tokensIn: k * tin, tokensOut: k * tout, usd: Math.round((k * tin * p.in + k * tout * p.out) / 1e6 * 100) / 100 }));
    lines.push({ item: 'Private server (database, search index, workflows)', detail: 'estimate, your account', usd: hosting });
    const total = Math.round(lines.reduce((a, l) => a + l.usd, 0) * 100) / 100;
    return { ok: true, model: p.label, lines, total, perDeck: decks ? Math.round((pages * 700 + 15000) * p.in / 1e6 * 100 + 12000 * p.out / 1e6 * 100) / 100 : 0 };
  }

  return { DEFAULTS, settings, validate, mapObjectives, explained, buildDeck, gate, diffDecks, pptxModel, guideDoc,
    disguise, numbersIn, buildCase, checkCase, caseDocs, citations, checkMemo, memoDoc, redact, tierFor, PRICES, monthlyCost, hasConcept, hash };
});
