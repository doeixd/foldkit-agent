# Third-party notices

`foldkit-remote-drizzle` adapts Drizzle query-compilation logic from **fate**'s
Drizzle integration (`packages/fate/src/server/drizzle.ts` and its tests), used
under the MIT License.

- Source: https://github.com/nkzw-tech/fate
- Files adapted: `packages/fate/src/server/drizzle.ts`,
  `packages/fate/src/server/connection.ts`
- Adapted here: `src/cursor.ts` (lexicographic keyset predicates and
  direction-aware ordering), `src/columns.ts` (required-column projection),
  `src/pagination.ts` (page-size-plus-one page boundaries), `src/window.ts`
  (forward/backward direction and page size from connection args), and
  `src/page.ts` (connection item + pagination metadata, re-expressed as Remote
  `QueryPage` boundaries).

## fate license

```
The MIT License (MIT)

Copyright (c) 2025 Nakazawa Tech

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
