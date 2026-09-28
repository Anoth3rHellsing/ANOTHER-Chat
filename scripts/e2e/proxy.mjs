// Proxy mínimo que imita el enrutado de Replit (uso: node proxy.mjs <puerto> <puertoApi> <dirFrontend>).
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
const [,, port, apiPort, root] = process.argv;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api")) {
    const upstream = http.request({ host: "127.0.0.1", port: apiPort, path: req.url, method: req.method, headers: req.headers }, r => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.on("error", () => upstream.destroy());
    res.on("error", () => upstream.destroy());
    req.pipe(upstream);
    return;
  }
  let file = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(apiPort, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.on("clientError", (_e, socket) => socket.destroy());
process.on("uncaughtException", err => console.error("proxy error", err.code ?? err.message));
server.listen(port, "127.0.0.1");
