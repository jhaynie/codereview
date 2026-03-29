#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve, join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { isGitRepo, getAllFileDiffs, getRepoInfo, discoverGitRepos, getMultiRepoDiffs, getBranches, getDefaultBranch, type FileDiff, type RepoInfo } from "./git.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// --- State ---

interface ServerState {
  diffs: FileDiff[];
  repos: Array<{ name: string; info: RepoInfo }>;
  multiRepo: boolean;
  repoNames: string[];
  workDir: string;
  baseRef: string;
}

const state: ServerState = {
  diffs: [],
  repos: [],
  multiRepo: false,
  repoNames: [],
  workDir: process.cwd(),
  baseRef: "",
};

async function loadDiffs(baseRef?: string) {
  const base = baseRef ?? state.baseRef;
  state.baseRef = base;

  if (state.multiRepo) {
    const result = await getMultiRepoDiffs(state.workDir, state.repoNames, base || undefined);
    state.repos = result.repos;
    state.diffs = result.diffs;
  } else {
    const info = await getRepoInfo(state.workDir);
    state.repos = [{ name: "", info }];
    state.diffs = await getAllFileDiffs(state.workDir, undefined, base || undefined);
  }
}

// --- HTTP helpers ---

function jsonResponse(data: unknown, status = 200): { status: number; headers: Record<string, string>; body: string } {
  return { status, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(data) };
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

// --- Markdown generation ---

interface Comment {
  filePath: string;
  repo?: string;
  lineNumber: number;
  lineType: "old" | "new";
  content: string;
  lineContent: string;
}

function generateMarkdown(comments: Comment[]): string {
  if (comments.length === 0) return "";
  const lines: string[] = ["Verify each finding against the current code and only fix it if needed.", ""];
  for (const comment of comments) {
    const filePath = comment.repo ? `${comment.repo}/${comment.filePath}` : comment.filePath;
    lines.push(`In \`${filePath}\` around lines ${comment.lineNumber}, ${comment.content}`);
    lines.push("");
  }
  return lines.join("\n");
}

// --- Main ---

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      port: { type: "string", short: "p", default: "" },
      base: { type: "string", short: "b", default: "" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
codereview - A CLI tool for reviewing git changes

Usage: codereview [options] [directory]

Options:
  -h, --help         Show this help message
  -p, --port         Port to run the UI server (default: random available port)
  -b, --base <ref>   Diff against a base branch (e.g., main). Shows all changes on the branch.
                     Without this flag, only uncommitted changes are shown.

Arguments:
  directory          The git directory or parent of multiple git repos (default: current directory)
`);
    process.exit(0);
  }

  const targetDir = await realpath(resolve(positionals[0] || process.cwd()));
  state.workDir = targetDir;
  state.baseRef = values.base || "";

  if (await isGitRepo(targetDir)) {
    state.multiRepo = false;
    state.repoNames = [];
  } else {
    const repoNames = await discoverGitRepos(targetDir);
    if (repoNames.length === 0) {
      console.error(`Error: ${targetDir} is not a git repository and contains no git repos`);
      process.exit(1);
    }
    console.log(`Found ${repoNames.length} repo(s): ${repoNames.join(", ")}`);
    state.multiRepo = true;
    state.repoNames = repoNames;
  }

  console.log(`Loading git changes${state.baseRef ? ` (base: ${state.baseRef})` : ""}...`);
  await loadDiffs();

  // If no dirty changes and no --base was specified, auto-detect default branch and retry
  if (state.diffs.length === 0 && !state.baseRef) {
    // Find the default branch from any available repo
    let defaultBranch: string | null = null;
    if (state.multiRepo) {
      for (const name of state.repoNames) {
        defaultBranch = await getDefaultBranch(join(state.workDir, name));
        if (defaultBranch) break;
      }
    } else {
      defaultBranch = await getDefaultBranch(state.workDir);
    }

    if (defaultBranch) {
      console.log(`No uncommitted changes. Switching to branch diff (vs ${defaultBranch})...`);
      await loadDiffs(defaultBranch);
    }
  }

  if (state.diffs.length === 0) {
    console.log("No changes to review.");
    process.exit(0);
  }

  const repoCount = state.repos.length;
  console.log(`Found ${state.diffs.length} file(s) with changes${repoCount > 1 ? ` across ${repoCount} repos` : ""}.`);

  // --- Client keepalive tracking ---

  const activeClients = new Set<import("node:http").ServerResponse>();
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  const SHUTDOWN_GRACE_MS = 500;

  function onClientConnect(res: import("node:http").ServerResponse) {
    activeClients.add(res);
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
  }

  function onClientDisconnect(res: import("node:http").ServerResponse) {
    activeClients.delete(res);
    if (activeClients.size === 0 && !shutdownTimer) {
      shutdownTimer = setTimeout(() => {
        console.log("All clients disconnected. Shutting down.");
        process.exit(0);
      }, SHUTDOWN_GRACE_MS);
    }
  }

  // --- Routes ---

  async function handleRequest(req: import("node:http").IncomingMessage): Promise<{ status: number; headers: Record<string, string>; body: string | Buffer }> {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    const method = req.method || "GET";

    // API routes
    if (path === "/api/info" && method === "GET") {
      return jsonResponse({ multiRepo: state.multiRepo, repos: state.repos, baseRef: state.baseRef });
    }
    if (path === "/api/diffs" && method === "GET") {
      return jsonResponse(state.diffs);
    }
    if (path === "/api/branches" && method === "GET") {
      if (state.multiRepo) {
        let common: Set<string> | null = null;
        for (const name of state.repoNames) {
          const branches = new Set(await getBranches(join(state.workDir, name)));
          if (common === null) { common = branches; }
          else { for (const b of common) { if (!branches.has(b)) common.delete(b); } }
        }
        return jsonResponse({ branches: Array.from(common || []).sort() });
      }
      return jsonResponse({ branches: await getBranches(state.workDir) });
    }
    if (path === "/api/reload" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { base: string };
      try {
        await loadDiffs(body.base ?? "");
        return jsonResponse({ success: true, fileCount: state.diffs.length, baseRef: state.baseRef, repos: state.repos });
      } catch (err: any) {
        return jsonResponse({ success: false, error: err.message }, 400);
      }
    }
    if (path === "/api/generate-markdown" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { comments: Comment[] };
      return jsonResponse({ markdown: generateMarkdown(body.comments) });
    }

    // Static files
    const filePath = path === "/" ? "/index.html" : path;
    try {
      const content = await readFile(join(PUBLIC_DIR, filePath));
      const mime = MIME[extname(filePath)] || "application/octet-stream";
      return { status: 200, headers: { "Content-Type": mime }, body: content };
    } catch {
      return { status: 404, headers: { "Content-Type": "text/plain" }, body: "Not Found" };
    }
  }

  // --- Server ---

  const requestedPort = values.port ? parseInt(values.port) : 0;

  const server = createServer(async (req, res) => {
    // SSE keepalive — long-lived connection, tracked for shutdown
    if (req.url === "/api/keepalive" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("data: connected\n\n");
      onClientConnect(res);
      req.on("close", () => onClientDisconnect(res));
      return;
    }

    try {
      const { status, headers, body } = await handleRequest(req);
      res.writeHead(status, headers);
      res.end(body);
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Internal Server Error: ${err.message}`);
    }
  });

  server.listen(requestedPort, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : requestedPort;

    console.log(`\nCode review UI running at http://localhost:${port}`);
    console.log("Press Ctrl+C to stop.\n");

    if (process.env.NO_OPEN !== "true") {
      const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : "start";
      exec(`${opener} http://localhost:${port}`, () => {});
    }
  });
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
