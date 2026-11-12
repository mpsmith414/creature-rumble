# Drawing test set

Every image here runs through the real creature designer on the **drawing test set** page
(`npm run dev`, then open http://localhost:5200/?dev=drawings and press **Run all**). Each row shows the drawing beside
the fighter that was built from it (the toon fighter standing, from the drawing's angle and from three-quarters).

- The four `.png` files are synthetic crayon drawings made for this project by `npx tsx tools/make-test-drawings.ts`
  (the same files as the valley's test set).
- **Add real drawings:** take a photo of a drawing (flat, good light, the whole page in frame) and drop it here as a
  `.jpg`. Reload the page and it appears as a new row. `.jpg` and `.jpeg` files here are kept out of git, so children's
  drawings stay on this PC.
- Every run makes real designer calls (one read and up to three look-again passes per drawing; `&passes=1` for fewer),
  and each read counts towards the day's creature limit.

## Scoring

Score each creature on the page (it remembers your scores in this browser):

| Score | Meaning |
|---|---|
| 1 😕 | "That's not mine" |
| 2 🙂 | "Kind of" |
| 3 🤩 | "That's MY one!" |

The designer is working when most real drawings score 3.
