# cite.seoryon.com — AI Citability Grader

A free, **100% client-side** SEOryon lead-magnet tool. You **paste an article or draft** and get a
**Citability Score (0–100)** — a *heuristic estimate* of whether AI search engines (ChatGPT, Perplexity,
Gemini, Google AI) are likely to **quote** it — plus a **per-factor breakdown** and a **prioritized,
copy-paste fix-list**.

Sibling of `score.seoryon.com` / `roi.seoryon.com` / `inspect.seoryon.com` — same brand system (tokens,
Geist / Plus Jakarta Sans, Oryon gradient, cards, S-mark favicon) and the same EN/DE/FR i18n pattern.

## Lane (how it differs from score.seoryon.com)

- **score** = the **page/technical layer**: give it a **URL**, it audits crawlability, meta, schema and
  on-page signals of a live page.
- **cite** (this tool) = the **content/writing layer**: **paste text**, it grades whether the *prose* is
  structured and phrased to be quoted.

They are complementary companions and cross-linked as such. This tool deliberately does **not** re-check
any URL/technical/schema signals.

## How the score works (honest by design)

Deterministic, in-browser, LLM-free. Seven documented content factors, weighted (sum = 100):

| Factor | Weight | What it checks |
|---|---|---|
| Answer-first | 20 | Leads with a direct answer near the top; answers the target question early |
| Q&A / FAQ structure | 18 | Question-style headings with self-contained answers |
| Extractable passages | 15 | Self-contained, quotable sentences vs. context-dependent prose |
| Data & statistics | 15 | Density of concrete numbers / stats |
| Scannability | 12 | Headings, lists, tables, short paragraphs |
| Readability | 12 | Flesch reading ease (EN) / language-agnostic length measure (DE/FR) |
| Direct-answer sentences | 8 | Short declarative / definitional sentences liftable verbatim |

Each factor → a 0–1 sub-score shown as pass (≥0.70) / warn (≥0.45) / fail. The weighted sum is the
0–100 grade (rounded, no fake precision). Verdict bands: ≥75 "Likely to be cited", 50–74 "Needs work",
<50 "AI will probably skip this". Every non-passing factor becomes a specific fix, ordered by
`weight × (1 − sub-score)`.

The rules follow the public GEO/AEO findings behind open-source auditors (Auriti-Labs/geo-optimizer,
Canonry/aeo-audit, both MIT) — reimplemented in our own code, no third-party brand shipped. The score is
labelled a **heuristic estimate**, never a guarantee.

Edge cases degrade calmly: empty → "paste some content"; `< 40 words` → "too short to grade reliably";
never NaN.

## Privacy / static

No backend, no API, no key, no network call for the scoring, no analytics. Content never leaves the
browser. Only the language choice is stored (localStorage).

## Structure

```
web/
  index.html   # markup + data-i18n hooks + JSON-LD
  style.css    # brand system (shared with score/roi)
  app.js       # scoring engine + EN/DE/FR i18n + render
  robots.txt   sitemap.xml
  logo.png  favicon.ico  favicon-32.png  apple-touch-icon.png  seoryon-mark.svg
  citehero.png # ← hero image (title-left / image-right). Drop it in; layout is fine if missing.
vercel.json    # static build + CSP/security headers
```

## Hero image

Drop a hero preview at `web/citehero.png` (aspect ≈ 1672×941). It's referenced by the hero; the layout
reserves the box and renders fine if it's briefly missing.

## Deploy

Static build on Vercel. Domain: **cite.seoryon.com** →
Cloudflare CNAME `cite` → `cname.vercel-dns.com` (DNS-only / grey cloud).

```
npx vercel deploy --prod
```
