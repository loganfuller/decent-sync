// Preloaded into every test server by startTestServer, so each secret the
// server hands out, to any client, is known to the test that started it: it
// appends every session cookie it sets, and the token or link in every JSON
// response (a machine entry's token, an invite's or password reset link's
// secret), and the OAuth secrets it issues (a Connected App's access and
// refresh tokens, and the authorization code in an approval's redirect), to
// the file TEST_SECRETS_FILE names, one per line.

import fs from "node:fs";
import http from "node:http";

const file = process.env.TEST_SECRETS_FILE;

function handOut(value) {
  if (file && typeof value === "string" && value) fs.appendFileSync(file, `${value}\n`);
}

const { setHeader, end } = http.ServerResponse.prototype;

http.ServerResponse.prototype.setHeader = function (name, value) {
  if (String(name).toLowerCase() === "set-cookie") {
    for (const cookie of [value].flat()) handOut(String(cookie).split(";")[0].split("=").slice(1).join("="));
  }
  return setHeader.call(this, name, value);
};

http.ServerResponse.prototype.end = function (chunk, ...rest) {
  if ((typeof chunk === "string" || Buffer.isBuffer(chunk)) && /json/.test(String(this.getHeader("content-type") ?? ""))) {
    try {
      const { token, link, access_token, refresh_token, redirect } = JSON.parse(String(chunk)) ?? {};
      handOut(token);
      if (typeof link === "string") handOut(new URL(link).pathname.split("/").at(-1));
      handOut(access_token);
      handOut(refresh_token);
      if (typeof redirect === "string") handOut(new URL(redirect).searchParams.get("code"));
    } catch {
      // Not an object with a token or link.
    }
  }
  return end.call(this, chunk, ...rest);
};
