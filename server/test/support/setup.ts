import { afterAll } from "vitest";
import { assertNoSecretLogged } from "./secrets.js";

// Runs before every Vitest test file (vitest.config.ts). Registered first,
// this runs after the file's own afterAll hooks have stopped its servers and
// tablets, whose logs are kept.
afterAll(() => assertNoSecretLogged());
