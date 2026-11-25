// Serves a built site from `dist` at the path `base`, as GitHub Pages does,
// for the tests that open it in a browser.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
};

/**
 * @param {string} dist
 * @param {string} base such as `/decent-sync`
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} `url` is the home page's address
 */
export async function serve(dist, base) {
    const server = createServer((request, response) => {
        const { pathname } = new URL(request.url ?? "/", "http://localhost");
        let file;
        if (pathname === base || pathname.startsWith(`${base}/`)) {
            file = join(dist, normalize(decodeURIComponent(pathname.slice(base.length))));
            if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
        }
        if (!file || !file.startsWith(dist) || !existsSync(file)) {
            response.writeHead(404).end("Not found");
            return;
        }
        response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
        createReadStream(file).pipe(response);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    return {
        url: `http://127.0.0.1:${port}${base}/`,
        close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
    };
}
