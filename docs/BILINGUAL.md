# Bilingual — English / Spanish

The site is two real pages, not a JavaScript text swap.

| URL | File | `lang` |
|---|---|---|
| `/` | `index.html` | `en` |
| `/es/` | `es/index.html` | `es` |

## Why two pages

The previous approach duplicated copy into `.en-text` / `.es-text` spans and swapped
`display` on click. Three problems:

1. **It was broken.** `setLang()` was defined inside the `DOMContentLoaded` callback while
   the buttons called it via `onclick`, which resolves against global scope — every click
   threw a ReferenceError. That is why it worked in an isolated test file and not in the
   site.
2. **Coverage was partial.** 27 elements carried the spans out of ~2,500 words of copy.
3. **Google can't see it.** Text swapped in by JavaScript at click time does not get
   indexed as Spanish. A bilingual site that ranks in one language isn't bilingual where it
   counts — a buyer searching "casas en venta Dorado" would never reach it.

Two indexed URLs with reciprocal `hreflang` tags solve all three. The EN/ES control is now
a plain link between them.

## Editing

`index.html` is the **single source of truth**. `es/index.html` is generated — it carries a
"do not edit" banner.

After any change to `index.html`:

```bash
node scripts/build-es.mjs
```

Then commit both files. Skip this and the two pages drift apart.

New or changed English copy shows up in the build output as an untranslated string:

```
[build-es] 32 untranslated string(s) left in English:
   - Act 60
   - Dorado
   ...
```

Proper nouns living in that list is expected and correct. Anything else means a missing key
in `i18n/es.json`.

## The translation file

`i18n/es.json` maps exact English strings to Spanish. Keys must match the source text
character for character, HTML entities included (`&mdash;`, `&amp;`, `&#243;`). Keys
starting with `_` are section dividers, ignored by the build.

The Spanish is **adapted, not translated literally**. The English page is pitched at
mainland Act 60 relocators; a Spanish-speaking visitor in Puerto Rico is usually a local
buyer or seller. Act 60 remains a service throughout but is not the headline.

### Headings split across tags

Some headings are three fragments — plain, emphasized, plain — and Spanish word order
differs. The dictionary maps them positionally, which is why a few entries look odd in
isolation:

| English fragment | Spanish |
|---|---|
| `Puerto Rico's` | `Las zonas` |
| `most coveted` | `más codiciadas` |
| `corridors` | `de Puerto Rico` |

Renders as "Las zonas **más codiciadas** de Puerto Rico". If you reword one of these
headings in English, check the Spanish still reads as a sentence.

## What is deliberately NOT translated

- **MLS listing remarks.** They arrive from the feed as the listing agent wrote them.
  Altering MLS content is not permitted — it changes material facts about a property.
  The site chrome around them is Spanish; the remarks are verbatim.
- **The MLS Grid attribution paragraph.** "Based on information submitted to the MLS GRID
  as of ___" is a required notice whose wording the IDX rules specify. It stays in English
  on both pages. The friendly "Listados en vivo de Stellar MLS" notice above it is
  translated.
- **Filter option values.** `<option value="Single Family">Casa Unifamiliar</option>` — the
  label is Spanish, the value stays English because it is compared against `PropertyType`
  from the feed. Translating the value would silently break filtering. Any new filter
  option needs an explicit `value` attribute for the same reason.

## Shared assets

Both pages fetch `/listings.json` and photos at `/photos/...` — root-relative, so `/es/`
resolves them. Never make these paths relative again.

## Still open

`<meta name="robots" content="noindex, nofollow">` is on both pages. Until it comes off,
neither language is indexed and the SEO argument above is theoretical. Remove it at launch
and submit both URLs to Search Console.
