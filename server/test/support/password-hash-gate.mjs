// Preloaded by startTestServer({ passwordHashGate }), so every scrypt hash the
// server starts waits while the gate file exists, and the server's output
// reports each hash started and finished with how many are running. A test can
// then hold password checks and count the hashes the server starts.

import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const gate = process.env.TEST_PASSWORD_HASH_GATE;
const scrypt = crypto.scrypt;
let running = 0;

crypto.scrypt = (...args) => {
  const callback = args.pop();
  running++;
  console.log(`[password hash] started, ${running} running`);
  const proceed = () => {
    if (fs.existsSync(gate)) return void setTimeout(proceed, 10);
    scrypt(...args, (error, key) => {
      running--;
      console.log(`[password hash] finished, ${running} running`);
      callback(error, key);
    });
  };
  proceed();
};
// The server imports scrypt by name.
syncBuiltinESMExports();
