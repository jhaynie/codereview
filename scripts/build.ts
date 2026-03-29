#!/usr/bin/env bun
/**
 * Build script — uses Bun to bundle the CLI and frontend.
 * Output goes to dist/ which is what gets published/installed.
 *
 * dist/
 *   cli.mjs          — Node-compatible CLI entry point
 *   git.mjs          — Git utilities (imported by CLI)
 *   public/
 *     index.html     — Frontend HTML
 *     app.js         — Bundled React app
 *     styles.css     — Styles
 */
import { mkdir, cp, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const PUBLIC = join(DIST, "public");

async function build() {
  console.log("Cleaning dist/...");
  await rm(DIST, { recursive: true, force: true });
  await mkdir(PUBLIC, { recursive: true });

  // 1. Bundle the frontend React app
  console.log("Bundling frontend...");
  const frontendResult = await Bun.build({
    entrypoints: [join(ROOT, "src/ui/app.tsx")],
    outdir: PUBLIC,
    naming: "app.js",
    minify: true,
    target: "browser",
  });

  if (!frontendResult.success) {
    console.error("Frontend build failed:");
    for (const msg of frontendResult.logs) console.error(msg);
    process.exit(1);
  }

  // 2. Copy CSS
  console.log("Copying styles...");
  await cp(join(ROOT, "src/ui/styles.css"), join(PUBLIC, "styles.css"));

  // 3. Write production HTML
  console.log("Writing index.html...");
  await writeFile(join(PUBLIC, "index.html"), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Review</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="root"></div>
  <script src="/app.js"></script>
</body>
</html>
`);

  // 4. Bundle the CLI (Node-compatible)
  console.log("Bundling CLI...");
  const cliResult = await Bun.build({
    entrypoints: [join(ROOT, "src/cli.ts")],
    outdir: DIST,
    naming: "cli.mjs",
    target: "node",
    external: ["node:*"],
    minify: false, // keep readable for debugging
  });

  if (!cliResult.success) {
    console.error("CLI build failed:");
    for (const msg of cliResult.logs) console.error(msg);
    process.exit(1);
  }

  // 5. Prepend shebang to CLI
  const cliPath = join(DIST, "cli.mjs");
  const cliContent = await Bun.file(cliPath).text();
  if (!cliContent.startsWith("#!")) {
    await writeFile(cliPath, `#!/usr/bin/env node\n${cliContent}`);
  }

  // Make executable
  const { chmod } = await import("node:fs/promises");
  await chmod(cliPath, 0o755);

  console.log("\nBuild complete!");
  console.log("  dist/cli.mjs        — CLI entry point");
  console.log("  dist/public/         — Frontend assets");
}

build().catch((err) => {
  console.error("Build error:", err);
  process.exit(1);
});
