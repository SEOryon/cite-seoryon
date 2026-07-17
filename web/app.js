/* ============================================================
   cite.seoryon.com — AI Citability Grader.
   100% client-side. No backend, no API, no network request for the
   scoring, no data stored or transmitted. The only persisted state is
   the chosen language (localStorage), like score/roi/inspect.

   Languages: EN (default, source) · DE (informal "du") · FR (vouvoiement).
   DE/FR are natively localized, not literal translations. Brand and
   technical terms (SEOryon, ChatGPT, Perplexity, Gemini, SEO, GEO, AEO,
   FAQ, Flesch) are kept as-is.

   Honesty:
   - The 0–100 score is a HEURISTIC ESTIMATE, labelled as such — never a
     guarantee of citation. It scores the documented structural content
     factors that research on generative-/answer-engine optimization ties
     to being cited (answer-first, Q&A structure, extractable passages,
     data density, scannability, readability, direct-answer sentences).
   - Deterministic rules only (no LLM, no randomness): same text → same
     score. Rules reimplemented in our own code, following the public
     findings behind Auriti-Labs/geo-optimizer and Canonry/aeo-audit.
   - Weights are documented below and shown per factor in the result.
   - Scores are rounded (whole numbers) — no fake precision.
   - Readability uses an English-tuned Flesch formula for EN and a
     language-agnostic length measure for DE/FR; the result says which.
   ============================================================ */
(() => {
  "use strict";

  /* ---------- scoring config ----------
     Weights sum to 100. Each factor produces a 0..1 sub-score; the
     weighted sum is the 0–100 Citability Score. Ordered by weight. */
  const FACTORS = [
    { key: "answerFirst", weight: 20 },
    { key: "qa",          weight: 18 },
    { key: "extractable", weight: 15 },
    { key: "data",        weight: 15 },
    { key: "scan",        weight: 12 },
    { key: "read",        weight: 12 },
    { key: "direct",      weight: 8 },
  ];
  const MIN_WORDS = 40; // below this we won't fake a confident grade

  /* ---------- small multilingual lexicons (structure heuristics) ---------- */
  // Sentence openers that lean on prior context → NOT self-contained/quotable.
  const DEP_OPENERS = new Set([
    // en
    "this","that","these","those","it","they","he","she","however","also","but",
    "and","so","then","therefore","thus","which","such","additionally","moreover",
    "furthermore","meanwhile","instead","besides","hence","consequently",
    // de
    "dies","diese","dieser","dieses","das","es","sie","er","jedoch","aber","und",
    "deshalb","daher","außerdem","zudem","dadurch","somit","trotzdem","dennoch","also",
    // fr
    "ce","cette","ces","cela","ça","il","elle","ils","elles","cependant","mais","et",
    "donc","ainsi","aussi","néanmoins","toutefois","or",
  ]);
  // Throat-clearing intros → weak answer-first.
  const FILLER_INTROS = [
    "in this article","in this post","in this guide","in this blog","in today's",
    "in today","we all know","have you ever","welcome to","let's face it",
    "when it comes to","in the world of","nowadays","in recent years","imagine",
    "in diesem artikel","in diesem beitrag","in diesem leitfaden","willkommen",
    "heutzutage","in der heutigen","hast du dich je","wenn es um","stell dir vor",
    "dans cet article","dans ce guide","dans ce billet","de nos jours","bienvenue",
    "avez-vous déjà","quand il s'agit","à l'heure actuelle","imaginez",
  ];
  // Copulas / definitional verbs near a sentence start → direct/definitional.
  const COPULAS = new Set([
    "is","are","was","were","means","refers","equals","describes","defines",
    "ist","sind","war","waren","bedeutet","bezeichnet","heißt",
    "est","sont","était","signifie","désigne","représente",
  ]);
  // Question-word starts (headings that aren't punctuated with "?").
  const Q_WORDS = new Set([
    "what","how","why","when","where","who","which","whose","can","does","do","is","are","should","will",
    "was","wie","warum","wann","wo","wer","welche","welcher","welches","kann","ist","sind","soll","sollte",
    "que","qu'est","comment","pourquoi","quand","où","qui","quel","quelle","quels","quelles","est-ce","peut","doit",
  ]);
  const Q_STOP = new Set([
    "what","how","why","when","where","who","which","the","a","an","of","to","is","are","do","does","and","or","for","in","on","my","your","this","that","with",
    "was","wie","warum","wann","wo","wer","welche","der","die","das","ein","eine","und","oder","für","mit","mein","dein",
    "que","qu","comment","pourquoi","quand","où","qui","quel","le","la","les","un","une","de","des","et","ou","pour","avec","mon","ton",
  ]);

  /* ============================ text analysis ============================ */
  const wordsIn = (s) => (String(s).match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []);
  const isListItem = (l) => /^\s*(?:[-*•–—]|\d+[.)]|[a-z][.)])\s+/i.test(l);
  const stripMarks = (l) =>
    l.replace(/^#{1,6}\s*/, "")
     .replace(/^\s*[-*•–—]\s+/, "")
     .replace(/^\s*\d+[.)]\s+/, "")
     .replace(/^\s*[a-z][.)]\s+/i, "")
     .replace(/^>+\s*/, "")
     .replace(/[*_`#]+/g, "")
     .trim();

  function isHeadingLine(line) {
    const t = line.trim();
    if (!t) return false;
    if (/^#{1,6}\s+/.test(t)) return true;             // markdown heading
    if (/^<h[1-6][\s>]/i.test(t)) return true;         // pasted HTML heading
    if (isListItem(t)) return false;
    const clean = stripMarks(t);
    if (!clean) return false;
    const wc = wordsIn(clean).length;
    // heading-like: short, few words, no sentence-terminal comma/semicolon/period,
    // and not an obvious quote. Trailing ":" or "?" strongly signals a heading.
    if (/[.,;]$/.test(clean)) return false;
    if (clean.length > 70 || wc > 10 || wc === 0) return false;
    if (/^["'(«]/.test(clean)) return false;
    if (/[:?]$/.test(clean)) return true;
    // Title-ish standalone short line — accept as a soft heading.
    return true;
  }

  function isQuestionLine(line) {
    const clean = stripMarks(line);
    if (!clean) return false;
    if (clean.length > 120) return false;
    if (/\?\s*$/.test(clean)) return true;
    const first = (wordsIn(clean)[0] || "").toLowerCase();
    // A leading question word on a short heading-like line.
    if (Q_WORDS.has(first) && wordsIn(clean).length <= 12) return true;
    if (/^que?st?ions?\b|^faq\b|^häufige fragen|^questions fréquentes/i.test(clean)) return true;
    return false;
  }

  // Break text into structural pieces we can reason about.
  function analyzeStructure(text) {
    const lines = text.split(/\r?\n/);
    const headings = [];
    const questionHeadings = [];
    let listItems = 0;
    let hasTable = false;
    const paragraphs = [];
    let buf = [];

    const flush = () => {
      const p = buf.join(" ").trim();
      if (p) paragraphs.push(p);
      buf = [];
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) { flush(); continue; }
      if (/\|.*\|/.test(line) || /\t.*\t/.test(line)) hasTable = true;
      if (isHeadingLine(line)) {
        flush();
        const clean = stripMarks(line);
        headings.push(clean);
        if (isQuestionLine(line)) questionHeadings.push(clean);
        continue;
      }
      if (isListItem(line)) {
        listItems++;
        // A list item can still hold a self-contained answer sentence.
        buf.push(stripMarks(line));
        continue;
      }
      // Standalone question line that isn't heading-shaped still counts as Q&A.
      if (isQuestionLine(line) && wordsIn(line).length <= 14) {
        questionHeadings.push(stripMarks(line));
      }
      buf.push(line.trim());
    }
    flush();

    return { headings, questionHeadings, listItems, hasTable, paragraphs, lineCount: lines.length };
  }

  // Sentence units for prose-level factors.
  function splitSentences(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      const clean = stripMarks(raw);
      if (!clean) continue;
      for (let s of clean.split(/(?<=[.!?])\s+/)) {
        s = s.trim();
        if (s && wordsIn(s).length >= 2) out.push(s);
      }
    }
    return out;
  }

  const firstWordLower = (s) => {
    const m = String(s).match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/u);
    return m ? m[0].toLowerCase() : "";
  };

  // English syllable estimate (for Flesch, EN only).
  function countSyllables(word) {
    word = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!word) return 0;
    if (word.length <= 3) return 1;
    word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
    const m = word.match(/[aeiouy]{1,2}/g);
    return m ? m.length : 1;
  }

  /* ============================ factor scoring ============================ */
  const clamp01 = (n) => Math.max(0, Math.min(1, n));

  function scoreContent(text, targetQ, lang) {
    const words = wordsIn(text);
    const totalWords = words.length;
    const struct = analyzeStructure(text);
    const sentences = splitSentences(text);
    const sc = Math.max(1, sentences.length);

    // ---- answer-first ----
    const firstChunkCount = Math.max(20, Math.round(totalWords * 0.3));
    const firstChunkText = words.slice(0, firstChunkCount).join(" ").toLowerCase();
    const firstPara = struct.paragraphs[0] || "";
    const firstParaWords = wordsIn(firstPara).length;
    const firstSentence = sentences[0] || "";
    const firstSentWords = wordsIn(firstSentence).length;

    let af = 0.4;
    if (firstParaWords > 0 && firstParaWords <= 45) af += 0.2;
    else if (firstParaWords <= 80) af += 0.08;
    else if (firstParaWords > 140) af -= 0.2;
    if (firstSentWords >= 4 && firstSentWords <= 28 && !/\?\s*$/.test(firstSentence)) af += 0.15;
    const introLC = firstPara.slice(0, 60).toLowerCase();
    if (FILLER_INTROS.some((f) => introLC.startsWith(f) || introLC.includes(" " + f))) af -= 0.28;
    let qOverlap = -1;
    if (targetQ) {
      const qk = [...new Set(wordsIn(targetQ).map((w) => w.toLowerCase()).filter((w) => w.length >= 4 && !Q_STOP.has(w)))];
      if (qk.length) {
        const hit = qk.filter((w) => firstChunkText.includes(w)).length;
        qOverlap = hit / qk.length;
        af += qOverlap * 0.35 - 0.1; // reward early coverage; small nudge down if absent
      }
    }
    const answerFirst = clamp01(af);

    // ---- Q&A / FAQ structure ----
    const qCount = new Set(struct.questionHeadings.map((q) => q.toLowerCase())).size;
    let qa;
    if (qCount >= 3) qa = 1.0;
    else if (qCount === 2) qa = 0.75;
    else if (qCount === 1) qa = 0.5;
    else qa = 0.15;
    // A long doc with zero question structure is worse than a short one.
    if (qCount === 0 && totalWords > 500) qa = 0.1;

    // ---- extractable / self-contained passages ----
    let depOpeners = 0, standalone = 0;
    for (const s of sentences) {
      const fw = firstWordLower(s);
      const wc = wordsIn(s).length;
      const dep = DEP_OPENERS.has(fw);
      if (dep) depOpeners++;
      if (!dep && wc >= 6 && wc <= 32) standalone++;
    }
    const depRatio = depOpeners / sc;
    const selfRatio = standalone / sc;
    const extractable = clamp01(0.2 + selfRatio - 0.6 * depRatio);

    // ---- statistical / data density ----
    const dataMentions = (text.match(/(?<![\p{L}])\d[\d.,]*\s?(?:%|percent|prozent|pour\s?cent)|[$€£¥]\s?\d|\d[\d.,]*\s?(?:x|×|k|m|bn|b= )|\b\d{2,}(?:[.,]\d+)?\b|\b(?:19|20)\d{2}\b/giu) || []).length;
    const per100 = dataMentions / Math.max(1, totalWords / 100);
    const data = clamp01(0.1 + (per100 / 3) * 0.9);

    // ---- scannability / structure ----
    const wall = struct.lineCount <= 2 && struct.paragraphs.length <= 1;
    const expectedHeadings = Math.max(1, Math.round(totalWords / 220));
    const hScore = clamp01(struct.headings.length / expectedHeadings);
    const avgParaWords = struct.paragraphs.length
      ? struct.paragraphs.reduce((a, p) => a + wordsIn(p).length, 0) / struct.paragraphs.length
      : totalWords;
    const paraScore = avgParaWords <= 90 ? 1 : avgParaWords <= 150 ? 0.5 : 0.15;
    let scan = clamp01(0.5 * hScore + (struct.listItems > 0 || struct.hasTable ? 0.25 : 0) + 0.25 * paraScore);
    if (wall) scan = Math.min(scan, 0.2);

    // ---- readability ----
    let read, readMethod;
    const asl = totalWords / sc; // avg sentence length (words)
    if (lang === "en") {
      readMethod = "flesch";
      const syll = words.reduce((a, w) => a + countSyllables(w), 0);
      const ease = 206.835 - 1.015 * asl - 84.6 * (syll / Math.max(1, totalWords));
      read = clamp01((ease - 20) / 45); // ~65+ ease → top marks
    } else {
      readMethod = "length";
      const chars = words.reduce((a, w) => a + w.length, 0);
      const awl = chars / Math.max(1, totalWords);
      const sScore = clamp01((30 - asl) / 16);   // shorter sentences → clearer
      const wScore = clamp01((8 - awl) / 3);     // shorter words → clearer
      read = clamp01(0.6 * sScore + 0.4 * wScore);
    }

    // ---- direct-answer sentences ----
    let shortDecl = 0, defCount = 0;
    for (const s of sentences) {
      const w = wordsIn(s);
      const wc = w.length;
      const fw = firstWordLower(s);
      const declarative = !/\?\s*$/.test(s) && !DEP_OPENERS.has(fw);
      if (declarative && wc >= 4 && wc <= 22) shortDecl++;
      const head = w.slice(0, 6).map((x) => x.toLowerCase());
      if (head.some((x) => COPULAS.has(x))) defCount++;
    }
    const directRatio = shortDecl / sc;
    const direct = clamp01(directRatio * 1.25 + (defCount > 0 ? 0.12 : 0));

    const subs = { answerFirst, qa, extractable, data, scan, read, direct };

    // weighted overall
    let overall = 0;
    for (const f of FACTORS) overall += subs[f.key] * f.weight;
    overall = Math.round(overall);

    return {
      overall,
      subs,
      readMethod,
      meta: { totalWords, sentences: sentences.length, qCount, headings: struct.headings.length,
              listItems: struct.listItems, dataMentions, hasTargetQ: !!targetQ, qOverlap, targetQ },
    };
  }

  const statusOf = (v) => (v >= 0.7 ? "pass" : v >= 0.45 ? "warn" : "fail");

  /* ============================ I18N ============================ */
  const I18N = {
    en: {
      meta_title: "Will AI cite this? · Free AI Citability Grader for your content · SEOryon",
      meta_desc: "Paste your article and get a Citability Score — a heuristic grade of whether AI search engines (ChatGPT, Perplexity, Gemini, Google AI) are likely to quote your content, plus a prioritized rewrite fix-list. Runs entirely in your browser. By SEOryon.",

      nav_how: "How it works",
      nav_faq: "FAQ",
      cta_trial: "Start free trial →",

      hero_pill: "Runs in your browser · Paste-only · Free",
      hero_h1: 'Will AI actually <span class="brand-text">cite your content?</span>',
      hero_sub: "Paste your article and get a Citability Score — a plain-English read on whether ChatGPT, Perplexity, Gemini and Google's AI are likely to quote you. Then get a specific, copy-paste fix-list to make it citable. Nothing is uploaded.",
      hero_img_alt: "Preview of the SEOryon AI Citability Grader — a citability score out of 100, a per-factor breakdown, and a prioritized rewrite fix-list.",

      inp_legend: "Your content",
      q_label: 'Question your content should answer <span class="opt">(optional)</span>',
      q_ph: "e.g. What is generative engine optimization?",
      q_help: "If you give one, we check whether your content answers it up front — the way an AI extracts an answer.",
      content_label: "Paste your article or content",
      content_ph: "Paste the full text of your article, page, or draft here…",
      sample_btn: "Try a sample →",
      assumptions_note: "This grades the <strong>writing</strong> — structure, answer-first phrasing, data, scannability. It does not check your live page's code or SEO tags (that's a different job — see below).",
      calc_privacy: "This grader runs entirely in your browser. Your content is never sent to a server, stored, or shared.",

      wc_empty: "No content yet",
      wc_words: "{n} words",
      wc_short: "{n} words · too short to grade",

      cross_kicker: "CHECKING A LIVE PAGE?",
      cross_body: 'This tool grades your <strong>writing</strong>. To check a <strong>live page\'s</strong> technical AI-search health — crawlability, schema, meta and on-page signals — use its companion.',
      cross_cta: "Score a live page at score.seoryon.com →",

      how_h2: "How it works",
      how1_h3: "You paste your content",
      how1_p: "Drop in an article, page, or draft — optionally the question it should answer. Nothing is uploaded; the text stays in your browser.",
      how2_h3: "We grade it, live",
      how2_p: "A transparent, rule-based check scores the factors AI engines favour when they pick what to quote — answer-first phrasing, Q&A structure, data, scannability, clarity.",
      how3_h3: "You get a fix-list",
      how3_p: "A prioritized, copy-paste list of concrete rewrites — the biggest gaps first — so you know exactly what to change to become more citable.",

      method_kicker: "HOW THIS IS SCORED",
      method_h2: "A heuristic, shown in the open.",
      method_lead: "This is not a guarantee of citation — no tool can promise that. It's a transparent estimate based on the <em>structural content factors</em> that research ties to being cited by AI engines. Studies of generative-engine and answer-engine optimization find that a handful of these factors explain most of the difference between content that gets quoted and content that gets skipped. We score each one and weight them into a single 0–100 grade.",
      method_c1_h: "Answer-first",
      method_c1_p: "AI engines lift the answer from near the top. We check whether your content leads with a direct answer instead of a long wind-up — and, if you gave a target question, whether it's answered early.",
      method_c2_h: "Q&A / FAQ structure",
      method_c2_p: "Question-shaped headings with self-contained answers are cited far more often. We detect question headings and whether each is followed by a clean, standalone answer.",
      method_c3_h: "Extractable passages & data",
      method_c3_p: "Quotable, self-contained sentences and concrete numbers and stats give an engine something to cite. Vague, context-dependent prose gives it nothing to lift.",
      method_c4_h: "Scannability & clarity",
      method_c4_p: "Clear headings, lists and short declarative sentences help. Readability is scored with a standard formula (English-tuned; for DE/FR we fall back to a language-agnostic length measure and say so).",
      method_note: 'The weights are documented in the tool\'s source and shown per factor in your result. Factor selection follows the public findings behind generative-engine optimization (GEO) and answer-engine optimization (AEO) — the same rules used by open-source auditors like <span class="nowrap">Auriti-Labs/geo-optimizer</span> and <span class="nowrap">Canonry/aeo-audit</span>. We reimplemented the rules in our own code; we round every score so it never fakes precision.',

      upsell_h2: 'The grade shows the gap. <span class="brand-text">SEOryon writes content that\'s already citable.</span>',
      upsell_p: "This grader tells you what to fix. SEOryon does it for you — it writes content that's structured to be cited by AI from the first draft: answer-first, Q&A-shaped, backed with data, and clean to scan. It reads real search and AI-citation signals, decides what to publish, writes it, and tracks where you get cited across Google, ChatGPT, Perplexity and Gemini.",
      upsell_cta: "Start your 3-day free trial →",
      upsell_fine: "3-day free trial · 3 published articles · 1 in-depth LLM/GEO audit · Cancel in two clicks.",
      ben1_h: "Citable by default",
      ben1_p: "Every article ships answer-first, Q&A-structured and data-backed — the shape AI engines quote — without you rewriting it.",
      ben2_h: "Agency-scale, not agency-price",
      ben2_p: "One agent runs the whole research-to-publish loop, so you get the output of a content team from €39/month.",
      ben3_h: "You see where you're cited",
      ben3_p: "It tracks your mentions across Google, ChatGPT, Perplexity and Gemini — so the grade becomes a scoreboard.",

      faq_h2: "Questions, answered",
      faq1_q: "Is the Citability Score a guarantee my content will be cited?",
      faq1_a: "No — and any tool that claims to guarantee AI citation is bluffing. The score is a heuristic estimate based on the structural factors research ties to being cited (answer-first phrasing, Q&A structure, extractable passages, data, scannability, clarity). It tells you how well your writing is <em>shaped</em> to be quoted; whether an engine actually quotes it also depends on your topic, authority, and competition.",
      faq2_q: "How is this different from score.seoryon.com?",
      faq2_a: "They're companions. score.seoryon.com checks a <strong>live URL's</strong> technical AI-search health — crawlability, meta tags, schema, on-page signals. This tool grades the <strong>writing itself</strong> — is the prose structured and phrased to be quoted. One is the page layer, one is the content layer. Use both.",
      faq3_q: "What exactly does it check?",
      faq3_a: "Seven content factors: whether you answer up front, Q&A / FAQ structure, whether passages are self-contained and extractable, statistical / data density, heading and list scannability, readability, and the presence of short direct-answer sentences. Each gets a pass / warn / fail with a one-line reason, and every failing factor becomes a fix in your list.",
      faq4_q: "Does it send my content anywhere?",
      faq4_a: "No. There is no server, no API, no upload. The scoring runs as plain JavaScript in your browser, and your text never leaves the page. The only thing stored is your language choice, kept locally in your browser.",
      faq5_q: "Does it work for German and French content?",
      faq5_a: "Yes. The structural checks (answer-first, question headings, self-contained passages, data density, scannability) are language-agnostic. Readability uses an English-tuned formula for English and a language-agnostic length measure for German and French — we flag which one was used in your result so nothing is hidden.",
      faq6_q: "Why does the same text always get the same score?",
      faq6_a: "Because the scoring is deterministic rules, not an AI model. The same content always produces the same grade and the same fix-list — so you can edit, re-paste, and watch the score move as you improve it.",

      footer_score: "Score a live page",
      footer_roi: "SEO ROI calculator",
      footer_note: "A free AI citability grader by SEOryon — your organic growth engine. The score is a heuristic estimate that runs entirely in your browser; nothing is sent to a server.",

      /* result */
      empty_msg: "Paste some content to see your Citability Score.",
      empty_sub: "An article, a page, or a draft — the more complete, the more useful the grade.",
      short_msg: "Too short to grade reliably.",
      short_sub: "You pasted {n} words. Paste at least ~40 words (a few real paragraphs) for a meaningful score.",

      res_kicker: "CITABILITY SCORE",
      verdict_good: "Likely to be cited",
      verdict_mid: "Needs work",
      verdict_bad: "AI will probably skip this",
      verdict_good_sub: "Your content is shaped the way AI engines like to quote. Tidy up anything below to push it further.",
      verdict_mid_sub: "There's citable material here, but the structure is holding it back. The fixes below are where to start.",
      verdict_bad_sub: "As written, there's little for an AI engine to lift. The fixes below are the fastest way to change that.",

      breakdown_title: "Per-factor breakdown",
      fixes_title: "Your fix-list — biggest gaps first",
      fixes_none: "Nice — no major gaps. Your content already hits the structural factors AI engines favour. Keep answers self-contained and up front, and you're in good shape.",

      tag_pass: "Pass",
      tag_warn: "Warn",
      tag_fail: "Fail",

      res_disclaimer: "This is a heuristic estimate of how citable your content is, based on the structural factors AI engines favour — not a guarantee of citation. Same text, same score.",
      res_cta: "Want content that's citable by default? Start your 3-day free trial →",
      res_cta_fine: "3-day free trial · 3 published articles · 1 in-depth LLM/GEO audit · cancel in two clicks.",

      /* factor names + why */
      fac_answerFirst_name: "Answer-first",
      fac_answerFirst_why: "AI engines lift the answer from near the top — a long wind-up buries it.",
      fac_qa_name: "Q&A / FAQ structure",
      fac_qa_why: "Question-shaped headings with clean answers are quoted far more often.",
      fac_extractable_name: "Extractable passages",
      fac_extractable_why: "Self-contained sentences give an engine something it can lift without context.",
      fac_data_name: "Data & statistics",
      fac_data_why: "Concrete numbers and stats are cited more than vague claims.",
      fac_scan_name: "Scannability",
      fac_scan_why: "Headings, lists and short paragraphs let an engine parse and extract.",
      fac_read_name: "Readability",
      fac_read_why_flesch: "Clear, plain sentences are easier to quote (scored with Flesch reading ease).",
      fac_read_why_length: "Clear, plain sentences are easier to quote (scored by sentence/word length — language-agnostic for DE/FR).",
      fac_direct_name: "Direct-answer sentences",
      fac_direct_why: "Short declarative sentences can be lifted verbatim as an answer.",

      /* fixes */
      fix_answerFirst_title: "Lead with the answer",
      fix_answerFirst_text: "Open with a single, direct sentence that answers the main question — before any background or story. Put the payoff in the first 1–2 sentences.",
      fix_answerFirst_text_q: 'Add a one-sentence direct answer to <strong>“{q}”</strong> as your opening line, before any background — that\'s the sentence an AI will lift.',
      fix_qa_title: "Add Q&A / FAQ structure",
      fix_qa_text: "Turn key sections into question-style headings (e.g. “How does X work?”) with a clean, self-contained answer right underneath. Aim for at least 3 real questions.",
      fix_extractable_title: "Make passages self-contained",
      fix_extractable_text: "Rewrite sentences that start with “This”, “That”, “It” or “However” so each stands on its own. An engine quotes one sentence — it should make sense alone.",
      fix_data_title: "Add concrete data",
      fix_data_text: "Back your main claims with specific numbers, stats, dates or amounts. Even one or two figures per section make content far more quotable.",
      fix_scan_title: "Break it up to scan",
      fix_scan_text: "Add descriptive headings every few paragraphs, split walls of text, and use bullet lists or a table where it fits. Short paragraphs beat one long block.",
      fix_read_title: "Tighten the writing",
      fix_read_text: "Shorten long sentences and swap dense wording for plain language. One idea per sentence reads more clearly — and lifts more cleanly.",
      fix_direct_title: "Add direct-answer sentences",
      fix_direct_text: "Include short declarative sentences an engine can quote verbatim — e.g. “X is …”, “The best way to … is …”. Keep them under ~20 words.",

      /* sample */
      sample: "What is generative engine optimization?\n\nIn today's fast-moving world of digital marketing, there are many things a business needs to think about, and one of them has become very important lately. We all know that search is changing, and it is something that everyone is talking about. This is why we wanted to write a long post about it, so that you can understand the background and the history and the context of everything that has been happening in this exciting space over the past few years, and why it might matter to you and your business going forward in the future.\n\nSearch engines used to just show links. Now they are doing other things too. It has changed a lot and it keeps changing all the time, which can be confusing for a lot of people who are trying to keep up with it while also running their business and doing everything else that they have to do every single day of the week.",
    },

    /* ============================ DE (informal "du") ============================ */
    de: {
      meta_title: "Zitiert die KI das? · Kostenloser KI-Zitierbarkeits-Check für deine Inhalte · SEOryon",
      meta_desc: "Füge deinen Artikel ein und erhalte einen Zitierbarkeits-Score — eine heuristische Einschätzung, ob KI-Suchmaschinen (ChatGPT, Perplexity, Gemini, Google AI) deine Inhalte zitieren, plus eine priorisierte Fix-Liste zum Umschreiben. Läuft komplett im Browser. Von SEOryon.",

      nav_how: "So funktioniert’s",
      nav_faq: "FAQ",
      cta_trial: "Kostenlos testen →",

      hero_pill: "Läuft im Browser · Nur Einfügen · Kostenlos",
      hero_h1: 'Zitiert die KI <span class="brand-text">deine Inhalte wirklich?</span>',
      hero_sub: "Füge deinen Artikel ein und erhalte einen Zitierbarkeits-Score — in klarem Deutsch, ob ChatGPT, Perplexity, Gemini und Googles KI dich wahrscheinlich zitieren. Dazu eine konkrete Fix-Liste zum Kopieren, die deinen Text zitierbar macht. Nichts wird hochgeladen.",
      hero_img_alt: "Vorschau des SEOryon KI-Zitierbarkeits-Checks — ein Zitierbarkeits-Score von 100, eine Aufschlüsselung pro Faktor und eine priorisierte Fix-Liste.",

      inp_legend: "Dein Inhalt",
      q_label: 'Frage, die dein Inhalt beantworten soll <span class="opt">(optional)</span>',
      q_ph: "z. B. Was ist Generative Engine Optimization?",
      q_help: "Wenn du eine angibst, prüfen wir, ob dein Inhalt sie weit oben beantwortet — so, wie eine KI eine Antwort herauszieht.",
      content_label: "Füge deinen Artikel oder Inhalt ein",
      content_ph: "Füge hier den vollständigen Text deines Artikels, deiner Seite oder deines Entwurfs ein …",
      sample_btn: "Beispiel ausprobieren →",
      assumptions_note: "Das bewertet den <strong>Text</strong> — Struktur, Antwort-zuerst-Formulierung, Daten, Scanbarkeit. Es prüft nicht den Code oder die SEO-Tags deiner Live-Seite (das ist eine andere Aufgabe — siehe unten).",
      calc_privacy: "Dieser Check läuft komplett in deinem Browser. Dein Inhalt wird nie an einen Server gesendet, gespeichert oder geteilt.",

      wc_empty: "Noch kein Inhalt",
      wc_words: "{n} Wörter",
      wc_short: "{n} Wörter · zu kurz zum Bewerten",

      cross_kicker: "PRÜFST DU EINE LIVE-SEITE?",
      cross_body: 'Dieses Tool bewertet deinen <strong>Text</strong>. Um die technische KI-Such-Gesundheit einer <strong>Live-Seite</strong> zu prüfen — Crawlbarkeit, Schema, Meta und On-Page-Signale — nutze das Companion-Tool.',
      cross_cta: "Live-Seite prüfen auf score.seoryon.com →",

      how_h2: "So funktioniert’s",
      how1_h3: "Du fügst deinen Inhalt ein",
      how1_p: "Wirf einen Artikel, eine Seite oder einen Entwurf hinein — optional die Frage, die er beantworten soll. Nichts wird hochgeladen; der Text bleibt in deinem Browser.",
      how2_h3: "Wir bewerten live",
      how2_p: "Eine transparente, regelbasierte Prüfung bewertet die Faktoren, die KI-Maschinen bevorzugen, wenn sie auswählen, was sie zitieren — Antwort zuerst, Q&A-Struktur, Daten, Scanbarkeit, Klarheit.",
      how3_h3: "Du bekommst eine Fix-Liste",
      how3_p: "Eine priorisierte Liste konkreter Umschreibungen zum Kopieren — die größten Lücken zuerst — damit du genau weißt, was du ändern musst, um zitierbarer zu werden.",

      method_kicker: "WIE HIER BEWERTET WIRD",
      method_h2: "Eine Heuristik, offen gezeigt.",
      method_lead: "Das ist keine Garantie für eine Zitierung — das kann kein Tool versprechen. Es ist eine transparente Einschätzung auf Basis der <em>strukturellen Inhaltsfaktoren</em>, die die Forschung mit Zitierungen durch KI-Maschinen verbindet. Studien zu Generative-Engine- und Answer-Engine-Optimierung zeigen: eine Handvoll dieser Faktoren erklärt den größten Teil des Unterschieds zwischen zitiertem und übergangenem Inhalt. Wir bewerten jeden und gewichten sie zu einem einzigen 0–100-Wert.",
      method_c1_h: "Antwort zuerst",
      method_c1_p: "KI-Maschinen ziehen die Antwort von weit oben. Wir prüfen, ob dein Inhalt mit einer direkten Antwort beginnt statt mit langem Vorlauf — und, falls du eine Zielfrage angibst, ob sie früh beantwortet wird.",
      method_c2_h: "Q&A- / FAQ-Struktur",
      method_c2_p: "Fragen-Überschriften mit eigenständigen Antworten werden weit öfter zitiert. Wir erkennen Fragen-Überschriften und ob auf jede eine saubere, eigenständige Antwort folgt.",
      method_c3_h: "Extrahierbare Passagen & Daten",
      method_c3_p: "Zitierbare, eigenständige Sätze und konkrete Zahlen geben einer Maschine etwas zum Zitieren. Vage, kontextabhängige Prosa bietet nichts zum Herausziehen.",
      method_c4_h: "Scanbarkeit & Klarheit",
      method_c4_p: "Klare Überschriften, Listen und kurze Aussagesätze helfen. Die Lesbarkeit wird mit einer Standardformel bewertet (auf Englisch getrimmt; für DE/FR nutzen wir ein sprachunabhängiges Längenmaß und sagen es).",
      method_note: 'Die Gewichte sind im Quellcode dokumentiert und werden pro Faktor in deinem Ergebnis gezeigt. Die Faktorauswahl folgt den öffentlichen Erkenntnissen hinter Generative Engine Optimization (GEO) und Answer Engine Optimization (AEO) — denselben Regeln wie Open-Source-Auditoren à la <span class="nowrap">Auriti-Labs/geo-optimizer</span> und <span class="nowrap">Canonry/aeo-audit</span>. Wir haben die Regeln in eigenem Code umgesetzt und runden jeden Wert, damit er nie eine Scheingenauigkeit vortäuscht.',

      upsell_h2: 'Der Wert zeigt die Lücke. <span class="brand-text">SEOryon schreibt Inhalte, die schon zitierbar sind.</span>',
      upsell_p: "Dieser Check sagt dir, was zu beheben ist. SEOryon erledigt es für dich — es schreibt Inhalte, die schon im ersten Entwurf so aufgebaut sind, dass die KI sie zitiert: Antwort zuerst, Q&A-förmig, mit Daten gestützt und sauber zu scannen. Es liest echte Such- und KI-Zitat-Signale, entscheidet, was zu veröffentlichen ist, schreibt es und verfolgt, wo du bei Google, ChatGPT, Perplexity und Gemini zitiert wirst.",
      upsell_cta: "3 Tage kostenlos testen →",
      upsell_fine: "3 Tage kostenlos testen · 3 veröffentlichte Artikel · 1 ausführliches LLM/GEO-Audit · In zwei Klicks kündbar.",
      ben1_h: "Standardmäßig zitierbar",
      ben1_p: "Jeder Artikel erscheint mit Antwort zuerst, Q&A-strukturiert und datengestützt — die Form, die KI-Maschinen zitieren — ohne dass du umschreibst.",
      ben2_h: "Agenturniveau, kein Agenturpreis",
      ben2_p: "Ein Agent führt den gesamten Kreislauf von Recherche bis Veröffentlichung, du bekommst den Output eines Content-Teams ab 39 €/Monat.",
      ben3_h: "Du siehst, wo du zitiert wirst",
      ben3_p: "Es verfolgt deine Erwähnungen bei Google, ChatGPT, Perplexity und Gemini — so wird der Wert zur Anzeigetafel.",

      faq_h2: "Antworten auf häufige Fragen",
      faq1_q: "Ist der Zitierbarkeits-Score eine Garantie, dass mein Inhalt zitiert wird?",
      faq1_a: "Nein — und jedes Tool, das eine KI-Zitierung garantiert, blufft. Der Score ist eine heuristische Einschätzung anhand der strukturellen Faktoren, die die Forschung mit Zitierungen verbindet (Antwort zuerst, Q&A-Struktur, extrahierbare Passagen, Daten, Scanbarkeit, Klarheit). Er zeigt, wie gut dein Text zum Zitieren <em>geformt</em> ist; ob eine Maschine ihn wirklich zitiert, hängt auch von Thema, Autorität und Wettbewerb ab.",
      faq2_q: "Wie unterscheidet sich das von score.seoryon.com?",
      faq2_a: "Sie sind Companions. score.seoryon.com prüft die technische KI-Such-Gesundheit einer <strong>Live-URL</strong> — Crawlbarkeit, Meta-Tags, Schema, On-Page-Signale. Dieses Tool bewertet den <strong>Text selbst</strong> — ist die Prosa so strukturiert und formuliert, dass sie zitiert wird. Das eine ist die Seiten-Ebene, das andere die Inhalts-Ebene. Nutze beide.",
      faq3_q: "Was genau wird geprüft?",
      faq3_a: "Sieben Inhaltsfaktoren: ob du weit oben antwortest, Q&A-/FAQ-Struktur, ob Passagen eigenständig und extrahierbar sind, statistische / Datendichte, Scanbarkeit durch Überschriften und Listen, Lesbarkeit und das Vorhandensein kurzer Antwortsätze. Jeder erhält ein Pass / Warnung / Fail mit einer Ein-Zeilen-Begründung, und jeder durchgefallene Faktor wird zu einem Fix in deiner Liste.",
      faq4_q: "Wird mein Inhalt irgendwohin gesendet?",
      faq4_a: "Nein. Es gibt keinen Server, keine API, keinen Upload. Die Bewertung läuft als reines JavaScript in deinem Browser, und dein Text verlässt nie die Seite. Gespeichert wird nur deine Sprachwahl, lokal in deinem Browser.",
      faq5_q: "Funktioniert es für deutsche und französische Inhalte?",
      faq5_a: "Ja. Die strukturellen Prüfungen (Antwort zuerst, Fragen-Überschriften, eigenständige Passagen, Datendichte, Scanbarkeit) sind sprachunabhängig. Die Lesbarkeit nutzt für Englisch eine englisch-getrimmte Formel und für Deutsch und Französisch ein sprachunabhängiges Längenmaß — wir kennzeichnen im Ergebnis, welches verwendet wurde, damit nichts verborgen bleibt.",
      faq6_q: "Warum bekommt derselbe Text immer denselben Score?",
      faq6_a: "Weil die Bewertung auf deterministischen Regeln beruht, nicht auf einem KI-Modell. Derselbe Inhalt ergibt immer denselben Wert und dieselbe Fix-Liste — so kannst du bearbeiten, neu einfügen und den Wert steigen sehen, während du verbesserst.",

      footer_score: "Live-Seite prüfen",
      footer_roi: "SEO-ROI-Rechner",
      footer_note: "Ein kostenloser KI-Zitierbarkeits-Check von SEOryon — deiner Engine für organisches Wachstum. Der Score ist eine heuristische Einschätzung, die komplett in deinem Browser läuft; nichts wird an einen Server gesendet.",

      empty_msg: "Füge Inhalt ein, um deinen Zitierbarkeits-Score zu sehen.",
      empty_sub: "Ein Artikel, eine Seite oder ein Entwurf — je vollständiger, desto aussagekräftiger die Bewertung.",
      short_msg: "Zu kurz für eine verlässliche Bewertung.",
      short_sub: "Du hast {n} Wörter eingefügt. Füge mindestens ~40 Wörter (ein paar echte Absätze) ein, um einen aussagekräftigen Score zu erhalten.",

      res_kicker: "ZITIERBARKEITS-SCORE",
      verdict_good: "Wird wahrscheinlich zitiert",
      verdict_mid: "Ausbaufähig",
      verdict_bad: "Die KI überspringt das wohl",
      verdict_good_sub: "Dein Inhalt ist so geformt, wie KI-Maschinen gern zitieren. Räum auf, was unten steht, um ihn noch weiter zu bringen.",
      verdict_mid_sub: "Hier steckt zitierbares Material, aber die Struktur bremst es. Die Fixes unten sind der Startpunkt.",
      verdict_bad_sub: "So geschrieben gibt es für eine KI-Maschine wenig herauszuziehen. Die Fixes unten sind der schnellste Weg, das zu ändern.",

      breakdown_title: "Aufschlüsselung pro Faktor",
      fixes_title: "Deine Fix-Liste — größte Lücken zuerst",
      fixes_none: "Stark — keine großen Lücken. Dein Inhalt trifft schon die strukturellen Faktoren, die KI-Maschinen bevorzugen. Halte Antworten eigenständig und weit oben, dann bist du gut aufgestellt.",

      tag_pass: "Pass",
      tag_warn: "Warnung",
      tag_fail: "Fail",

      res_disclaimer: "Das ist eine heuristische Einschätzung, wie zitierbar dein Inhalt ist, basierend auf den strukturellen Faktoren, die KI-Maschinen bevorzugen — keine Garantie für eine Zitierung. Gleicher Text, gleicher Score.",
      res_cta: "Willst du Inhalte, die standardmäßig zitierbar sind? Starte deinen 3-tägigen Gratis-Test →",
      res_cta_fine: "3 Tage kostenlos testen · 3 veröffentlichte Artikel · 1 ausführliches LLM/GEO-Audit · in zwei Klicks kündbar.",

      fac_answerFirst_name: "Antwort zuerst",
      fac_answerFirst_why: "KI-Maschinen ziehen die Antwort von weit oben — ein langer Vorlauf vergräbt sie.",
      fac_qa_name: "Q&A- / FAQ-Struktur",
      fac_qa_why: "Fragen-Überschriften mit sauberen Antworten werden weit öfter zitiert.",
      fac_extractable_name: "Extrahierbare Passagen",
      fac_extractable_why: "Eigenständige Sätze geben einer Maschine etwas, das sie ohne Kontext herausziehen kann.",
      fac_data_name: "Daten & Statistiken",
      fac_data_why: "Konkrete Zahlen und Statistiken werden öfter zitiert als vage Aussagen.",
      fac_scan_name: "Scanbarkeit",
      fac_scan_why: "Überschriften, Listen und kurze Absätze helfen einer Maschine beim Parsen und Extrahieren.",
      fac_read_name: "Lesbarkeit",
      fac_read_why_flesch: "Klare, einfache Sätze lassen sich leichter zitieren (bewertet mit Flesch-Lesbarkeit).",
      fac_read_why_length: "Klare, einfache Sätze lassen sich leichter zitieren (bewertet nach Satz-/Wortlänge — sprachunabhängig für DE/FR).",
      fac_direct_name: "Direkte Antwortsätze",
      fac_direct_why: "Kurze Aussagesätze lassen sich wortwörtlich als Antwort herausziehen.",

      fix_answerFirst_title: "Beginne mit der Antwort",
      fix_answerFirst_text: "Beginne mit einem einzigen, direkten Satz, der die Hauptfrage beantwortet — vor jedem Hintergrund oder jeder Geschichte. Pack die Pointe in die ersten 1–2 Sätze.",
      fix_answerFirst_text_q: 'Füge als ersten Satz eine direkte Ein-Satz-Antwort auf <strong>„{q}“</strong> ein, vor jedem Hintergrund — genau diesen Satz zieht eine KI heraus.',
      fix_qa_title: "Füge Q&A- / FAQ-Struktur hinzu",
      fix_qa_text: "Mach aus Kernabschnitten Fragen-Überschriften (z. B. „Wie funktioniert X?“) mit einer sauberen, eigenständigen Antwort direkt darunter. Ziel: mindestens 3 echte Fragen.",
      fix_extractable_title: "Mach Passagen eigenständig",
      fix_extractable_text: "Schreib Sätze um, die mit „Dies“, „Das“, „Es“ oder „Jedoch“ beginnen, sodass jeder für sich steht. Eine Maschine zitiert einen Satz — er sollte allein Sinn ergeben.",
      fix_data_title: "Füge konkrete Daten hinzu",
      fix_data_text: "Stütze deine Kernaussagen mit konkreten Zahlen, Statistiken, Daten oder Beträgen. Schon ein bis zwei Zahlen pro Abschnitt machen Inhalt weit zitierbarer.",
      fix_scan_title: "Gliedere es zum Scannen",
      fix_scan_text: "Setz alle paar Absätze aussagekräftige Überschriften, teile Textwände auf und nutze Aufzählungen oder eine Tabelle, wo es passt. Kurze Absätze schlagen einen langen Block.",
      fix_read_title: "Straffe den Text",
      fix_read_text: "Kürze lange Sätze und ersetze dichte Formulierungen durch einfache Sprache. Ein Gedanke pro Satz liest sich klarer — und lässt sich sauberer herausziehen.",
      fix_direct_title: "Füge direkte Antwortsätze hinzu",
      fix_direct_text: "Baue kurze Aussagesätze ein, die eine Maschine wortwörtlich zitieren kann — z. B. „X ist …“, „Der beste Weg, … ist …“. Halte sie unter ~20 Wörtern.",

      sample: "Was ist Generative Engine Optimization?\n\nIn der heutigen schnelllebigen Welt des digitalen Marketings gibt es viele Dinge, über die ein Unternehmen nachdenken muss, und eines davon ist in letzter Zeit sehr wichtig geworden. Wir alle wissen, dass sich die Suche verändert, und es ist etwas, worüber gerade alle reden. Deshalb wollten wir einen langen Beitrag darüber schreiben, damit du den Hintergrund und die Geschichte und den Kontext von allem verstehst, was in diesem spannenden Bereich in den letzten Jahren passiert ist, und warum es für dich und dein Unternehmen in Zukunft wichtig sein könnte.\n\nSuchmaschinen haben früher einfach nur Links angezeigt. Jetzt tun sie auch andere Dinge. Es hat sich stark verändert und verändert sich ständig weiter, was für viele Leute verwirrend sein kann, die versuchen, mitzuhalten, während sie gleichzeitig ihr Unternehmen führen und alles andere erledigen, was sie jeden einzelnen Tag der Woche tun müssen.",
    },

    /* ============================ FR (vouvoiement) ============================ */
    fr: {
      meta_title: "L'IA va-t-elle citer ceci ? · Analyseur de citabilité IA gratuit pour vos contenus · SEOryon",
      meta_desc: "Collez votre article et obtenez un score de citabilité — une estimation heuristique de la probabilité que les moteurs de recherche IA (ChatGPT, Perplexity, Gemini, Google AI) citent votre contenu, plus une liste de corrections priorisée. Tourne entièrement dans votre navigateur. Par SEOryon.",

      nav_how: "Comment ça marche",
      nav_faq: "FAQ",
      cta_trial: "Essai gratuit →",

      hero_pill: "Tourne dans votre navigateur · Sans envoi · Gratuit",
      hero_h1: 'L\'IA va-t-elle vraiment <span class="brand-text">citer votre contenu ?</span>',
      hero_sub: "Collez votre article et obtenez un score de citabilité — en clair, la probabilité que ChatGPT, Perplexity, Gemini et l'IA de Google vous citent. Puis une liste de corrections concrètes à copier pour rendre votre texte citable. Rien n'est envoyé.",
      hero_img_alt: "Aperçu de l'analyseur de citabilité IA de SEOryon — un score de citabilité sur 100, une répartition par facteur et une liste de corrections priorisée.",

      inp_legend: "Votre contenu",
      q_label: 'Question à laquelle votre contenu doit répondre <span class="opt">(facultatif)</span>',
      q_ph: "ex. Qu'est-ce que la generative engine optimization ?",
      q_help: "Si vous en donnez une, nous vérifions si votre contenu y répond dès le début — comme une IA extrait une réponse.",
      content_label: "Collez votre article ou contenu",
      content_ph: "Collez ici le texte complet de votre article, page ou brouillon…",
      sample_btn: "Essayer un exemple →",
      assumptions_note: "Ceci évalue le <strong>texte</strong> — structure, formulation réponse-d'abord, données, lisibilité. Cela ne vérifie pas le code ni les balises SEO de votre page en ligne (c'est un autre travail — voir plus bas).",
      calc_privacy: "Cet analyseur tourne entièrement dans votre navigateur. Votre contenu n'est jamais envoyé à un serveur, stocké ni partagé.",

      wc_empty: "Aucun contenu",
      wc_words: "{n} mots",
      wc_short: "{n} mots · trop court pour évaluer",

      cross_kicker: "VOUS VÉRIFIEZ UNE PAGE EN LIGNE ?",
      cross_body: 'Cet outil évalue votre <strong>texte</strong>. Pour vérifier la santé technique en recherche IA d\'une <strong>page en ligne</strong> — indexabilité, schema, balises meta et signaux on-page — utilisez l\'outil complémentaire.',
      cross_cta: "Analyser une page en ligne sur score.seoryon.com →",

      how_h2: "Comment ça marche",
      how1_h3: "Vous collez votre contenu",
      how1_p: "Déposez un article, une page ou un brouillon — et, si vous voulez, la question qu'il doit traiter. Rien n'est envoyé ; le texte reste dans votre navigateur.",
      how2_h3: "Nous évaluons, en direct",
      how2_p: "Une vérification transparente et fondée sur des règles évalue les facteurs que les moteurs IA privilégient pour choisir ce qu'ils citent — réponse d'abord, structure Q&R, données, lisibilité, clarté.",
      how3_h3: "Vous obtenez une liste de corrections",
      how3_p: "Une liste priorisée de réécritures concrètes à copier — les plus gros écarts d'abord — pour savoir exactement quoi changer afin de devenir plus citable.",

      method_kicker: "COMMENT C'EST NOTÉ",
      method_h2: "Une heuristique, à découvert.",
      method_lead: "Ce n'est pas une garantie de citation — aucun outil ne peut la promettre. C'est une estimation transparente fondée sur les <em>facteurs structurels de contenu</em> que la recherche relie au fait d'être cité par les moteurs IA. Les travaux sur la generative engine optimization et l'answer engine optimization montrent qu'une poignée de ces facteurs expliquent l'essentiel de la différence entre un contenu cité et un contenu ignoré. Nous notons chacun et les pondérons en une seule note de 0 à 100.",
      method_c1_h: "Réponse d'abord",
      method_c1_p: "Les moteurs IA extraient la réponse près du début. Nous vérifions si votre contenu ouvre par une réponse directe plutôt qu'une longue introduction — et, si vous donnez une question cible, si elle est traitée tôt.",
      method_c2_h: "Structure Q&R / FAQ",
      method_c2_p: "Les titres en forme de question suivis de réponses autonomes sont cités bien plus souvent. Nous détectons les titres-questions et si chacun est suivi d'une réponse propre et autonome.",
      method_c3_h: "Passages extractibles & données",
      method_c3_p: "Des phrases autonomes et citables et des chiffres concrets donnent au moteur de quoi citer. Une prose vague et dépendante du contexte ne lui offre rien à extraire.",
      method_c4_h: "Lisibilité & clarté",
      method_c4_p: "Des titres clairs, des listes et des phrases déclaratives courtes aident. La lisibilité est notée avec une formule standard (calibrée pour l'anglais ; pour le DE/FR, nous utilisons une mesure de longueur indépendante de la langue et le signalons).",
      method_note: 'Les pondérations sont documentées dans le code de l\'outil et affichées par facteur dans votre résultat. Le choix des facteurs suit les résultats publics derrière la generative engine optimization (GEO) et l\'answer engine optimization (AEO) — les mêmes règles que des auditeurs open source comme <span class="nowrap">Auriti-Labs/geo-optimizer</span> et <span class="nowrap">Canonry/aeo-audit</span>. Nous avons réimplémenté les règles dans notre propre code ; nous arrondissons chaque note pour ne jamais feindre la précision.',

      upsell_h2: 'La note montre l\'écart. <span class="brand-text">SEOryon écrit du contenu déjà citable.</span>',
      upsell_p: "Cet analyseur vous dit quoi corriger. SEOryon le fait pour vous — il rédige un contenu structuré pour être cité par l'IA dès le premier jet : réponse d'abord, en forme de Q&R, appuyé par des données et facile à parcourir. Il lit de vrais signaux de recherche et de citation IA, décide quoi publier, l'écrit, et suit où vous êtes cité sur Google, ChatGPT, Perplexity et Gemini.",
      upsell_cta: "Démarrer l'essai gratuit de 3 jours →",
      upsell_fine: "Essai gratuit de 3 jours · 3 articles publiés · 1 audit LLM/GEO approfondi · Annulable en deux clics.",
      ben1_h: "Citable par défaut",
      ben1_p: "Chaque article part réponse-d'abord, structuré en Q&R et appuyé par des données — la forme que les moteurs IA citent — sans que vous réécriviez.",
      ben2_h: "Échelle d'agence, pas prix d'agence",
      ben2_p: "Un seul agent gère toute la boucle recherche-à-publication : vous obtenez la production d'une équipe de contenu à partir de 39 €/mois.",
      ben3_h: "Vous voyez où vous êtes cité",
      ben3_p: "Il suit vos mentions sur Google, ChatGPT, Perplexity et Gemini — la note devient un tableau de bord.",

      faq_h2: "Vos questions, nos réponses",
      faq1_q: "Le score de citabilité garantit-il que mon contenu sera cité ?",
      faq1_a: "Non — et tout outil qui prétend garantir une citation IA bluffe. Le score est une estimation heuristique fondée sur les facteurs structurels que la recherche relie au fait d'être cité (réponse d'abord, structure Q&R, passages extractibles, données, lisibilité, clarté). Il indique à quel point votre texte est <em>façonné</em> pour être cité ; qu'un moteur le cite vraiment dépend aussi de votre sujet, de votre autorité et de la concurrence.",
      faq2_q: "En quoi est-ce différent de score.seoryon.com ?",
      faq2_a: "Ce sont des compléments. score.seoryon.com vérifie la santé technique en recherche IA d'une <strong>URL en ligne</strong> — indexabilité, balises meta, schema, signaux on-page. Cet outil évalue le <strong>texte lui-même</strong> — la prose est-elle structurée et formulée pour être citée. L'un est la couche page, l'autre la couche contenu. Utilisez les deux.",
      faq3_q: "Que vérifie-t-il exactement ?",
      faq3_a: "Sept facteurs de contenu : si vous répondez dès le début, la structure Q&R / FAQ, si les passages sont autonomes et extractibles, la densité statistique / de données, la lisibilité par titres et listes, la lisibilité du texte, et la présence de phrases-réponses courtes. Chacun reçoit un réussi / attention / échec avec une raison d'une ligne, et chaque facteur en échec devient une correction dans votre liste.",
      faq4_q: "Est-ce que mon contenu est envoyé quelque part ?",
      faq4_a: "Non. Il n'y a pas de serveur, pas d'API, pas d'envoi. La notation s'exécute en JavaScript dans votre navigateur, et votre texte ne quitte jamais la page. La seule chose stockée est votre choix de langue, conservé localement dans votre navigateur.",
      faq5_q: "Fonctionne-t-il pour du contenu en allemand et en français ?",
      faq5_a: "Oui. Les vérifications structurelles (réponse d'abord, titres-questions, passages autonomes, densité de données, lisibilité par structure) sont indépendantes de la langue. La lisibilité du texte utilise une formule calibrée pour l'anglais, et une mesure de longueur indépendante de la langue pour l'allemand et le français — nous indiquons laquelle a servi dans votre résultat, pour que rien ne soit caché.",
      faq6_q: "Pourquoi le même texte obtient-il toujours le même score ?",
      faq6_a: "Parce que la notation repose sur des règles déterministes, pas sur un modèle d'IA. Le même contenu produit toujours la même note et la même liste de corrections — vous pouvez éditer, recoller et voir la note monter à mesure que vous améliorez.",

      footer_score: "Analyser une page",
      footer_roi: "Calculateur de ROI SEO",
      footer_note: "Un analyseur de citabilité IA gratuit par SEOryon — votre moteur de croissance organique. Le score est une estimation heuristique qui tourne entièrement dans votre navigateur ; rien n'est envoyé à un serveur.",

      empty_msg: "Collez du contenu pour voir votre score de citabilité.",
      empty_sub: "Un article, une page ou un brouillon — plus c'est complet, plus la note est utile.",
      short_msg: "Trop court pour évaluer de façon fiable.",
      short_sub: "Vous avez collé {n} mots. Collez au moins ~40 mots (quelques vrais paragraphes) pour un score significatif.",

      res_kicker: "SCORE DE CITABILITÉ",
      verdict_good: "Sera probablement cité",
      verdict_mid: "À retravailler",
      verdict_bad: "L'IA va sans doute l'ignorer",
      verdict_good_sub: "Votre contenu est façonné comme les moteurs IA aiment citer. Corrigez ce qui suit pour aller encore plus loin.",
      verdict_mid_sub: "Il y a de la matière citable ici, mais la structure la freine. Les corrections ci-dessous sont le point de départ.",
      verdict_bad_sub: "En l'état, un moteur IA a peu à extraire. Les corrections ci-dessous sont le moyen le plus rapide de changer ça.",

      breakdown_title: "Répartition par facteur",
      fixes_title: "Votre liste de corrections — plus gros écarts d'abord",
      fixes_none: "Beau travail — aucun écart majeur. Votre contenu coche déjà les facteurs structurels que les moteurs IA privilégient. Gardez des réponses autonomes et placées en tête, et vous êtes en bonne posture.",

      tag_pass: "Réussi",
      tag_warn: "Attention",
      tag_fail: "Échec",

      res_disclaimer: "Ceci est une estimation heuristique de la citabilité de votre contenu, fondée sur les facteurs structurels que les moteurs IA privilégient — pas une garantie de citation. Même texte, même score.",
      res_cta: "Vous voulez un contenu citable par défaut ? Démarrez votre essai gratuit de 3 jours →",
      res_cta_fine: "Essai gratuit de 3 jours · 3 articles publiés · 1 audit LLM/GEO approfondi · annulable en deux clics.",

      fac_answerFirst_name: "Réponse d'abord",
      fac_answerFirst_why: "Les moteurs IA extraient la réponse près du début — une longue intro l'enterre.",
      fac_qa_name: "Structure Q&R / FAQ",
      fac_qa_why: "Les titres-questions suivis de réponses propres sont cités bien plus souvent.",
      fac_extractable_name: "Passages extractibles",
      fac_extractable_why: "Des phrases autonomes donnent au moteur de quoi extraire sans contexte.",
      fac_data_name: "Données & statistiques",
      fac_data_why: "Les chiffres et statistiques concrets sont cités plus que les affirmations vagues.",
      fac_scan_name: "Lisibilité de structure",
      fac_scan_why: "Titres, listes et paragraphes courts aident le moteur à analyser et extraire.",
      fac_read_name: "Lisibilité du texte",
      fac_read_why_flesch: "Des phrases claires et simples se citent plus facilement (notées avec la lisibilité Flesch).",
      fac_read_why_length: "Des phrases claires et simples se citent plus facilement (notées par longueur de phrase/mot — indépendant de la langue pour DE/FR).",
      fac_direct_name: "Phrases-réponses directes",
      fac_direct_why: "Des phrases déclaratives courtes peuvent être extraites telles quelles comme réponse.",

      fix_answerFirst_title: "Commencez par la réponse",
      fix_answerFirst_text: "Ouvrez par une seule phrase directe qui répond à la question principale — avant tout contexte ou récit. Mettez l'essentiel dans les 1 à 2 premières phrases.",
      fix_answerFirst_text_q: 'Ajoutez en première ligne une réponse directe d\'une phrase à <strong>« {q} »</strong>, avant tout contexte — c\'est cette phrase qu\'une IA extraira.',
      fix_qa_title: "Ajoutez une structure Q&R / FAQ",
      fix_qa_text: "Transformez les sections clés en titres-questions (ex. « Comment fonctionne X ? ») avec une réponse propre et autonome juste en dessous. Visez au moins 3 vraies questions.",
      fix_extractable_title: "Rendez les passages autonomes",
      fix_extractable_text: "Réécrivez les phrases qui commencent par « Cela », « Ce », « Il » ou « Cependant » pour que chacune tienne seule. Un moteur cite une phrase — elle doit avoir du sens isolée.",
      fix_data_title: "Ajoutez des données concrètes",
      fix_data_text: "Appuyez vos affirmations clés avec des chiffres, statistiques, dates ou montants précis. Même un ou deux chiffres par section rendent le contenu bien plus citable.",
      fix_scan_title: "Aérez pour parcourir",
      fix_scan_text: "Ajoutez des titres descriptifs tous les quelques paragraphes, cassez les blocs de texte et utilisez des listes à puces ou un tableau si c'est pertinent. Les paragraphes courts battent un long bloc.",
      fix_read_title: "Resserrez l'écriture",
      fix_read_text: "Raccourcissez les phrases longues et remplacez le vocabulaire dense par un langage simple. Une idée par phrase se lit plus clairement — et s'extrait plus proprement.",
      fix_direct_title: "Ajoutez des phrases-réponses directes",
      fix_direct_text: "Insérez des phrases déclaratives courtes qu'un moteur peut citer telles quelles — ex. « X est… », « La meilleure façon de… est… ». Gardez-les sous ~20 mots.",

      sample: "Qu'est-ce que la generative engine optimization ?\n\nÀ l'heure actuelle, dans le monde en mouvement rapide du marketing digital, il y a beaucoup de choses auxquelles une entreprise doit penser, et l'une d'elles est devenue très importante récemment. Nous savons tous que la recherche change, et c'est un sujet dont tout le monde parle en ce moment. C'est pourquoi nous avons voulu écrire un long billet à ce propos, afin que vous puissiez comprendre le contexte et l'histoire et l'arrière-plan de tout ce qui s'est passé dans ce domaine passionnant ces dernières années, et pourquoi cela pourrait compter pour vous et votre entreprise à l'avenir.\n\nLes moteurs de recherche se contentaient d'afficher des liens. Maintenant ils font aussi d'autres choses. Cela a beaucoup changé et cela continue de changer tout le temps, ce qui peut être déroutant pour beaucoup de gens qui essaient de suivre tout en gérant leur entreprise et en faisant tout le reste qu'ils doivent faire chaque jour de la semaine.",
    },
  };

  const SUPPORTED = ["en", "de", "fr"];
  const STORAGE_KEY = "seoryon_lang";
  let currentLang = "en";

  /* ---------- language ---------- */
  const pickInitialLang = () => {
    try {
      const q = new URLSearchParams(window.location.search).get("lang");
      if (q && SUPPORTED.includes(q.toLowerCase())) return q.toLowerCase();
    } catch (_) { /* ignore */ }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.includes(saved)) return saved;
    } catch (_) { /* localStorage may be blocked */ }
    const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
    return SUPPORTED.includes(nav) ? nav : "en";
  };

  const applyLang = (lang) => {
    currentLang = SUPPORTED.includes(lang) ? lang : "en";
    const dict = I18N[currentLang] || I18N.en;

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const v = dict[el.getAttribute("data-i18n")];
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const v = dict[el.getAttribute("data-i18n-html")];
      if (v != null) el.innerHTML = v;
    });
    document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
      const v = dict[el.getAttribute("data-i18n-alt")];
      if (v != null) el.setAttribute("alt", v);
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      const v = dict[el.getAttribute("data-i18n-ph")];
      if (v != null) el.setAttribute("placeholder", v);
    });

    if (dict.meta_title) document.title = dict.meta_title;
    const md = document.querySelector('meta[name="description"]');
    if (md && dict.meta_desc) md.setAttribute("content", dict.meta_desc);
    document.documentElement.setAttribute("lang", currentLang);

    document.querySelectorAll(".lang-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-lang") === currentLang);
    });

    try { localStorage.setItem(STORAGE_KEY, currentLang); } catch (_) { /* ignore */ }

    updateWordcount();
    render();
  };

  /* ---------- helpers ---------- */
  const t = (str, vars) =>
    String(str).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const numFmt = (n) => {
    try { return new Intl.NumberFormat(currentLang, { maximumFractionDigits: 0 }).format(n); }
    catch (_) { return String(Math.round(n)); }
  };

  /* ---------- elements ---------- */
  const contentEl = document.getElementById("content");
  const targetEl = document.getElementById("targetQ");
  const wcEl = document.getElementById("wordcount");
  const out = document.getElementById("result");
  const sampleBtn = document.getElementById("sampleBtn");
  const form = document.getElementById("citeForm");

  /* ---------- wordcount ---------- */
  function updateWordcount() {
    if (!wcEl || !contentEl) return;
    const dict = I18N[currentLang] || I18N.en;
    const n = wordsIn(contentEl.value).length;
    if (n === 0) { wcEl.textContent = dict.wc_empty; wcEl.classList.remove("warn"); return; }
    if (n < MIN_WORDS) { wcEl.textContent = t(dict.wc_short, { n: numFmt(n) }); wcEl.classList.add("warn"); return; }
    wcEl.textContent = t(dict.wc_words, { n: numFmt(n) }); wcEl.classList.remove("warn");
  }

  /* ---------- result markup ---------- */
  const emptyHtml = (mark, msg, sub) =>
    `<div class="res-empty"><div class="res-empty-mark">${mark}</div><p>${esc(msg)}</p>${sub ? `<p class="res-empty-sub">${esc(sub)}</p>` : ""}</div>`;

  const RING_C = 2 * Math.PI * 48;

  function factorHtml(dict, f, subVal, readMethod) {
    const st = statusOf(subVal);
    const icon = st === "pass" ? "✓" : st === "warn" ? "!" : "✕";
    const name = dict["fac_" + f.key + "_name"];
    let why;
    if (f.key === "read") why = dict[readMethod === "flesch" ? "fac_read_why_flesch" : "fac_read_why_length"];
    else why = dict["fac_" + f.key + "_why"];
    const tag = st === "pass" ? dict.tag_pass : st === "warn" ? dict.tag_warn : dict.tag_fail;
    const pctLabel = Math.round(subVal * 100) + " / 100";
    return `
      <div class="factor ${st}">
        <div class="factor-icon" aria-hidden="true">${icon}</div>
        <div class="factor-body">
          <div class="factor-name">${esc(name)}</div>
          <div class="factor-why">${esc(why)}</div>
        </div>
        <div class="factor-score">${pctLabel}<br><span class="factor-tag">${esc(tag)}</span></div>
      </div>`;
  }

  function fixHtml(dict, f, rank, res) {
    const title = dict["fix_" + f.key + "_title"];
    let text;
    if (f.key === "answerFirst" && res.meta.hasTargetQ) {
      text = t(dict.fix_answerFirst_text_q, { q: esc(res.meta.targetQ) });
    } else {
      text = dict["fix_" + f.key + "_text"];
    }
    return `
      <div class="fix">
        <div class="fix-rank">${rank}</div>
        <div class="fix-body">
          <div class="fix-title">${esc(title)}</div>
          <div class="fix-text">${text}</div>
        </div>
      </div>`;
  }

  /* ---------- render ---------- */
  function render() {
    if (!out) return;
    const dict = I18N[currentLang] || I18N.en;
    const text = (contentEl ? contentEl.value : "").trim();
    const targetQ = (targetEl ? targetEl.value : "").trim();

    if (!text) { out.innerHTML = emptyHtml("?", dict.empty_msg, dict.empty_sub); return; }

    const wordCount = wordsIn(text).length;
    if (wordCount < MIN_WORDS) {
      out.innerHTML = emptyHtml("···", dict.short_msg, t(dict.short_sub, { n: numFmt(wordCount) }));
      return;
    }

    const res = scoreContent(text, targetQ, currentLang);
    const score = res.overall;
    const band = score >= 75 ? "good" : score >= 50 ? "mid" : "bad";
    const verdictLabel = dict["verdict_" + band];
    const verdictSub = dict["verdict_" + band + "_sub"];
    const dash = RING_C * (1 - score / 100);

    // factors (fixed display order = weight order)
    const factorsHtml = FACTORS.map((f) => factorHtml(dict, f, res.subs[f.key], res.readMethod)).join("");

    // fixes: non-pass factors, prioritized by weight × gap
    const nonPass = FACTORS
      .filter((f) => statusOf(res.subs[f.key]) !== "pass")
      .map((f) => ({ f, prio: f.weight * (1 - res.subs[f.key]) }))
      .sort((a, b) => b.prio - a.prio)
      .slice(0, 6);
    const fixesHtml = nonPass.length
      ? `<div class="fixes">${nonPass.map((x, i) => fixHtml(dict, x.f, i + 1, res)).join("")}</div>`
      : `<div class="fixes-none">${esc(dict.fixes_none)}</div>`;

    out.innerHTML = `
      <div class="res-kicker">${esc(dict.res_kicker)}</div>
      <div class="score-head verdict-${band}">
        <div class="score-ring" role="img" aria-label="${score} / 100">
          <svg viewBox="0 0 108 108" aria-hidden="true">
            <defs>
              <linearGradient id="scoreGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#9A88FF"/>
                <stop offset="42%" stop-color="#6D5AF6"/>
                <stop offset="100%" stop-color="#4A35E8"/>
              </linearGradient>
            </defs>
            <circle class="ring-bg" cx="54" cy="54" r="48"></circle>
            <circle class="ring-fg" cx="54" cy="54" r="48"
              stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${dash.toFixed(1)}"></circle>
          </svg>
          <div class="ring-num">${score}</div>
        </div>
        <div class="score-verdict">
          <div class="verdict-label">${esc(verdictLabel)}</div>
          <div class="verdict-sub">${esc(verdictSub)}</div>
        </div>
      </div>

      <div class="res-divider"></div>
      <div class="res-block-title">${esc(dict.breakdown_title)}</div>
      <div class="factors">${factorsHtml}</div>

      <div class="res-divider"></div>
      <div class="res-block-title">${esc(dict.fixes_title)}</div>
      ${fixesHtml}

      <p class="res-disclaimer">${esc(dict.res_disclaimer)}</p>
      <a class="res-cta" href="https://app.seoryon.com/signup?utm_source=citability-grader&utm_medium=tool&utm_campaign=trial">${esc(dict.res_cta)}</a>
      <p class="res-cta-fine">${esc(dict.res_cta_fine)}</p>`;
  }

  /* ---------- wiring ---------- */
  if (contentEl) contentEl.addEventListener("input", () => { updateWordcount(); render(); });
  if (targetEl) targetEl.addEventListener("input", render);
  if (sampleBtn) sampleBtn.addEventListener("click", () => {
    const dict = I18N[currentLang] || I18N.en;
    if (contentEl) contentEl.value = dict.sample;
    if (targetEl && !targetEl.value) {
      targetEl.value = currentLang === "de" ? "Was ist Generative Engine Optimization?"
        : currentLang === "fr" ? "Qu'est-ce que la generative engine optimization ?"
        : "What is generative engine optimization?";
    }
    updateWordcount();
    render();
  });
  if (form) form.addEventListener("submit", (e) => { e.preventDefault(); render(); });
  document.querySelectorAll(".lang-btn").forEach((b) => {
    b.addEventListener("click", () => applyLang(b.getAttribute("data-lang")));
  });

  /* ---------- boot ---------- */
  applyLang(pickInitialLang());
})();
