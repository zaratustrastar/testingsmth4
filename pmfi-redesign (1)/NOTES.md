# PMFI V2.2 — Frontend overhaul notes

Frontend only. No Solidity, ABIs, `config.js`, or contract call ordering changed.
Still vanilla JS, no framework. Build and `node --test` suite stay green (21/21).

## Files changed
- `src/styles.css` — new dark, crypto-native design system (replaces prior styles).
- `src/main.js` — rewritten render/UX layer. All contract logic and the
  recheck → approve → create ordering preserved exactly.

## The bug that was killing conversions
On the Borrow tab, dragging the **Amount to lock** slider wrote the value back
through `fmt()`, which inserts thousands separators (e.g. `18,267.50`). Then:
- `isBorrowFormReady()` ran `Number("18,267.50")` → `NaN` → **Create button stayed
  disabled on the happy path**, with no explanation.
- `money()` returned `0`, so the preview read "Collateral locked 0".
- At submit, `parseUnits()` would have thrown on the comma.

### Fix
- `plain()` writes comma-free values into inputs.
- `parseAmount()` / `numFrom()` strip separators defensively before any `Number()`
  or `parseUnits()` call.
- `borrowBlockReason()` now surfaces *why* the button is disabled as an inline hint
  instead of silently disabling it.

## Other UX changes
- Two-way slider/input sync (no more "0%" shown next to a filled amount) + 25/50/75/Max chips.
- Borrow preview now shows borrow cost and implied APR.
- Plain-language P/N explainer + a "collateral splits into P and N" diagram, replacing
  the cryptic "You keep N reclaim right" copy.
- Per-tab hero with live aggregate stats.
- Lend tab: APR-sorted position cards + an inviting empty state that points to Borrow.
- Portfolio: status badges, clearer "Nothing to do yet" / empty-state copy with CTAs.
- Basescan links in the footer for the factory and marketplace.

## Design language
Deep blue-black surfaces. Two accents map to the protocol's core split:
mint-green for **P** (lender / yield), violet for **N** (borrower / reclaim).
Tabular mono numerals for all financial figures.

## preview.html
Standalone, wallet-free mock of all three tabs using the real stylesheet.
Open it directly in a browser — no server or wallet needed. Not part of the build.
