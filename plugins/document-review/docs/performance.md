# HTML review performance, 0.7.2

Measured on 2026-10-17 using the installed BB plugin and a desktop browser session.
The affected review was the Going Norrath flexible worship system overview:
210,404 characters, 386 rendered elements, 11 comments, and an atomic HTML proposal
with 240,205 characters of original source.

## Cause and fixes

The main lag was repeated CPU work, rather than a confirmed heap leak. Every
highlight update recomputed a source diff with an 800 ms timeout. Scrolls,
right-click menus, selected comments, and drafts could all trigger it. Building a
comment target also reparsed the whole HTML once or twice for every scope option.

The preview now caches a diff with a 24 ms computation budget and uses already
parsed targets when constructing anchors. Large rewrites can fall back to broader
outlines. Exact source and accept/reject behavior are unchanged; source reconciliation
retains its existing diff budget. Sibling indexing and bounded text summaries avoid
repeated full-subtree/sibling scans during parsing.

Element and text-range bindings are cached per iframe load. Geometry updates are
coalesced once per animation frame, offscreen highlights are omitted, and identical
geometry does not trigger a render. Images, fonts, and size changes update outlines.
Cleanup removes handlers from the same window they were attached to, disconnects
observers, cancels queued frames, and releases pointer/selection references. The
cross-component diff cache uses weak keys rather than retaining closed reviews.

Unrelated reviews no longer trigger document refreshes. The hidden home screen
stops fetching full inventories during edits. Equal revisions preserve cached
render state; duplicate reads coalesce and catch up if another revision arrives
while a read is pending. Focus refreshes the current document. Inventory sweeps
from list refreshes run at most once a minute; explicit activation still forces one.

## Live results

| Interaction | Before | After |
| --- | ---: | ---: |
| Worship overview: context-menu event to two animation frames | 873.8 ms | 16.2 ms |
| Worship overview: context-menu handler | 66.5 ms | 0.4 ms |
| Worship overview: open comment draft and focus textarea | — | 14 ms |
| Worship overview: 12 scrolling frames | — | 10 ms median, 10.4 ms maximum; none over 50 ms |
| Stress page: 365 KB source, 3,306 elements, pending rewrite; open comment menu | — | 9.2 ms |
| Stress page: submit comment to visible sidebar card | — | 66.1 ms |

A final repeat after the 0.7.2 reload measured 23.1, 19.4, and 19.8 ms for the
worship overview menu, with all 11 comments and its pending proposal preserved.

These are local measurements under the current system load, not guarantees for
arbitrary HTML. The existing 500,000-character document limit remains. The real
review's source, pending proposal, and comments were not edited during these checks;
the posted test comment was on a disposable stress review.

## Regression checks

115 tests pass and TypeScript is clean. Added coverage verifies that scrolling,
selecting, and opening comment menus do not recompute diffs; anchor construction
reuses parsed targets; iframe listeners are removed on unmount; 400 comments produce
only visible highlight elements; unrelated events do not read documents; active
editors do not scan global inventories; and a revision arriving during a coalesced
refresh is eventually displayed. Existing persistence and outside-edit tests pass.
