# Pull requests

Open a pull request only when asked (`AGENTS.md`). Its description says what changed and why, how it was verified, and what it does not cover.

## Screenshots

A pull request that changes the management interface shows the change in screenshots, embedded in its description under a `## Screenshots` heading placed before the verification section. A line before each image says what it shows, and one line at the top says how the data was seeded.

### Taking them

- Seed the data as Seam 2 does: a fresh test server with simulated tablets running the built plugin (`docs/AI_BUILD_NOTES.md`). Never use a real server or the test tablet. Use made-up hardware ids, and keep tokens, link secrets and session cookies out of view.
- Write a scratch Playwright spec that drives the pages and calls `page.screenshot`, for example `e2e/zz-screenshots.spec.ts`. Write it only in the throwaway worktree you run Playwright from, and never commit it. Playwright needs a path without a dot segment (`docs/AI_BUILD_NOTES.md`).
- Use a 1280 x 800 viewport, and `fullPage: true` for pages. Dialogs animate open, so wait about 600 ms after one appears before capturing it.
- Show each state a reviewer needs, such as the page before and after an action, a confirmation, and what Staff see compared with Admins.
- Open each image and check it before publishing: no half-faded dialogs, raw values or secrets.

### Hosting and embedding them

GitHub's API cannot attach images to a pull request description, so the images go in the repository, on a branch of their own and never on the pull request's branch, so they do not reach `main`. Pushing that branch publishes the images, so it needs the same request as opening the pull request.

1. Make one commit holding only the PNGs, at its root, on an orphan branch named `pr-assets/<pull request number>`, and push it:

   ```sh
   A=$(mktemp -d) && cd "$A" && git init -q && git checkout -q --orphan pr-assets/<number> \
     && cp <screenshot directory>/*.png . && git add -A \
     && git commit -q -m "Screenshots for the #<issue> pull request" \
     && git remote add origin https://github.com/loganfuller/decent-sync.git \
     && git push -q origin pr-assets/<number> && git rev-parse HEAD
   ```

2. Embed each image by that commit's id, which keeps working after the branch is deleted:

   ```md
   ![Conflicts page](https://github.com/loganfuller/decent-sync/raw/<commit id>/1-conflicts-page.png)
   ```

   Edit the description with `gh pr edit <number> --body-file <file>`, after reading the current one with `gh pr view <number> --json body --jq .body`.

3. To replace screenshots, such as after review changes the interface, push a new commit to the same branch and update the commit ids in the description.

The branch can be deleted once the pull request is merged. Pull requests #38 and #115 show the pattern.
