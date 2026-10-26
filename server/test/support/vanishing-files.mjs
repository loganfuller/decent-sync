// Preloaded by server/test/management-interface.test.ts, so opening a file
// named `vanishing-*` to read it fails with ENOENT, as for a file of the web
// build that goes after express.static finds it and before it reads it, as in
// a rebuild. Its stat still succeeds, and every other file opens as usual.

import fs from "node:fs";
import path from "node:path";

const open = fs.open;

fs.open = (file, ...args) => {
  if (!path.basename(String(file)).startsWith("vanishing-")) return open(file, ...args);
  const callback = args.pop();
  const error = Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT", errno: -2, syscall: "open", path: String(file) });
  process.nextTick(() => callback(error));
};
