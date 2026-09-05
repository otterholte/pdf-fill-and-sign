import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
export function serve(port = 8766) {
  return http
    .createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(
          new URL(req.url, "http://localhost").pathname,
        );
        const file = path.resolve(
          root,
          "." + (pathname === "/" ? "/index.html" : pathname),
        );
        if (!file.startsWith(root + path.sep)) {
          res.writeHead(403).end();
          return;
        }
        const bytes = await readFile(file);
        res
          .writeHead(200, {
            "Content-Type":
              mime[path.extname(file)] || "application/octet-stream",
            "Cache-Control": "no-store",
          })
          .end(bytes);
      } catch {
        res.writeHead(404).end();
      }
    })
    .listen(port, "127.0.0.1");
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  serve(Number(process.env.PORT) || 8766);
