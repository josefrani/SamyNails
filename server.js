const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT) || 5000;
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(204, { "cache-control": "public, max-age=86400" });
    res.end();
    return;
  }

  if (pathname === "/supabase-config.js" || pathname === "/push-config.js") {
    const config = pathname === "/supabase-config.js"
      ? { url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY }
      : { vapidPublicKey: process.env.VAPID_PUBLIC_KEY };
    if (!config.url && pathname === "/supabase-config.js") {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("Supabase configuration is missing.");
      return;
    }
    if (!config.anonKey && pathname === "/supabase-config.js") {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("Supabase configuration is missing.");
      return;
    }
    if (!config.vapidPublicKey && pathname === "/push-config.js") {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("Push notifications are not configured.");
      return;
    }
    const json = JSON.stringify(config).replace(/</g, "\\u003c");
    const variable = pathname === "/supabase-config.js" ? "SAMY_SUPABASE_CONFIG" : "SAMY_PUSH_CONFIG";
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(`window.${variable}=${json};`);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    res.end("Invalid path");
    return;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const isAllowedAsset = relativePath.startsWith("assets/")
    && !relativePath.split("/").some((part) => part.startsWith("."))
    && /\.(png|jpe?g|webp|svg)$/i.test(relativePath);
  if (!isAllowedAsset && ![
    "index.html", "app.js", "sw.js", "manifest.json", "admin-manual-booking.js", "admin-push.js",
  ].includes(relativePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const headers = {
      "content-type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "x-content-type-options": "nosniff",
    };
    if (["index.html", "app.js", "admin-manual-booking.js", "admin-push.js"].includes(path.basename(filePath))) {
      headers["cache-control"] = "no-store";
    }

    if (path.basename(filePath) === "index.html") {
      fs.readFile(filePath, "utf8", (readError, html) => {
        if (readError) {
          res.writeHead(500);
          res.end("Could not load application.");
          return;
        }
        const scripts = '<script src="/admin-manual-booking.js"></script><script src="/admin-push.js"></script>';
        const body = html.includes("</body>")
          ? html.replace("</body>", `${scripts}</body>`)
          : `${html}${scripts}`;
        res.writeHead(200, headers);
        if (req.method === "HEAD") res.end();
        else res.end(body);
      });
      return;
    }

    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Samy Nails server listening on port ${port}`);
});
