# Astrashop UI: references and direction

The first UI was the generic SaaS card kit: identical rounded white cards, pill badges, one green button style, a big default heading. This redesign takes one specific part from each of five references and builds the rest from the product's own world: a campus stationery counter where students buy exercise books, drawing sheets and lab records.

## What we took, and from where

| Reference (looked at 25 Nov 2026) | Part we took | Where it shows up |
|---|---|---|
| Indian ruled exercise books (Classmate and the like) | Faint blue ruled lines with a red margin line on the left. Every student in India has written on this page. | The catalog sits on a ruled sheet with a red margin rule. Rows of items fall on the lines. This is the one bold element. |
| IKEA product listing and product page | Price as the strongest line on the card: a small currency mark next to a big bold number. Borderless product entries. A "how to get it" line where availability is a coloured dot plus plain words. | Item entries: no box, small ₹ next to a large tabular price. Availability reads "12 on the shelf", "Only 1 left" or "Sold out", with a green, amber or red dot. |
| Teenage Engineering store | Category filter as one line of quiet lowercase text links, the active one dark and the rest grey, with the count on the right. | Course filter under the search: "all, engineering drawing, physics lab…" and "12 items". |
| Apple Wallet pass guidelines | A pass shows only what's needed at the counter, big. Everything else goes elsewhere. | The pickup pass: the 6-digit code very large (grouped 3+3), the item, and "Collect by Thu, 4:17 pm". Notched edges like a ticket stub. |
| MUJI India | Restraint. Colour is used only where it carries meaning; navigation is plain text. | Header nav as two text tabs. Colour only for actions (ink blue), status (dots) and the margin rule. |

Blinkit was on the list for quick-commerce add buttons, but it asks for a delivery location before showing products, so we skipped it rather than enter one.

## Tokens

**Colour**
| Name | Hex | Role |
|---|---|---|
| Paper | `#F7F8FB` | Page background, a cool notebook white (deliberately not cream) |
| Sheet | `#FFFFFF` | The ruled sheet and the passes |
| Ink | `#18213A` | Text: blue-black, like fountain-pen ink |
| Graphite | `#5A6378` | Secondary text |
| Rule | `#D5DEEE` | Ruled lines and dividers |
| Ink blue | `#2D4AA8` | The one accent: buttons, links, focus, the active tab |
| Margin red | `#C9483F` | The margin rule, and "sold out" / errors only |

Status dots: green `#2E8A57` (on the shelf), amber `#B7791F` (only 1 left, expired), margin red (sold out).

**Type:** Bricolage Grotesque (variable, self-hosted through `@fontsource-variable`, so the strict CSP still holds). One family: its optical-size axis makes it tighter at display sizes and more open at text sizes. Weights 400/500/600/700. Tabular figures for prices, stock and codes. Sentence case everywhere, no all-caps labels.

**Layout**

```
┌ astrashop                                 Student  Shop ┐
│                                                         │
│  What do you need for class?                            │
│  ____________________________________________ (search)  │
│  all  engineering drawing  physics lab  …      12 items │
│                                                         │
│ ┃ Engineering Drawing        ┃ Physics Lab   │ PASS     │
│ ┃ Mini drafter               ┃ Lab record…   │ 448 835  │
│ ┃ ₹450        [Reserve]      ┃ ₹90 [Reserve] │ Mini …   │
│ ┃ ● Only 1 left              ┃ ● 12 on shelf │ Collect  │
│ ┃ Counted 3 hours ago        ┃ Counted 2h…   │ by Thu   │
│ ┃─────────────── ruled line ─┃───────────────│          │
└─────────────────────────────────────────────────────────┘
  ┃ = red margin rule                     passes column (sticky)
```

Left-aligned throughout. On phones the passes move above the catalog when you have any, and the catalog becomes one column on the ruled sheet.

**Principles**
1. The ruled sheet is the memorable thing; everything around it stays quiet.
2. Numbers are the content: price, stock, code. They get weight and tabular figures, not decoration.
3. Say availability in words a student would say ("Only 1 left"), not system states.
4. The shop counter is a ledger: same ruled lines, rows you can scan, big codes to match against a phone.

## Checked against generic defaults

- Cream background + serif + clay accent: avoided. The paper is cool white, the type is a grotesque, and the accent is ink blue.
- Hairline-rule broadsheet: we do use rules, but as notebook lines tied to the product. Corners stay rounded on buttons and passes, and there are no dense newspaper columns.
- SaaS card kit: removed. Items are entries on a sheet, not boxes, and only the pickup pass is a raised object, because it's the thing you show at the counter.
- Template chrome: no all-caps eyebrows, no "A · B · C" meta strings, no monospace labels, no arrows appended to buttons.
