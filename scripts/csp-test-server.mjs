import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 4179;
const pagePath = fileURLToPath(new URL("./csp-test-page.html", import.meta.url));
const pageScriptPath = fileURLToPath(new URL("./csp-test-page.js", import.meta.url));
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-elem 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'"
].join("; ");

const page = await readFile(pagePath);
const pageScript = await readFile(pageScriptPath);
const server = createServer((request, response) => {
  if (request.url === "/csp-test-page.js") {
    response.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(pageScript);
    return;
  }
  if (request.url !== "/" && request.url !== "/csp-test") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "Cache-Control": "no-store"
  });
  response.end(page);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`CSP test page: http://127.0.0.1:${PORT}/csp-test`);
  console.log("CSP blocks inline scripts, eval(), and Function(). Press Ctrl+C to stop.");
});
