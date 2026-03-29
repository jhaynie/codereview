import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// --- Git command helper ---

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Run git command, return empty string on failure */
function gitSafe(args: string[], cwd: string): Promise<string> {
  return git(args, cwd).catch(() => "");
}

// --- Types ---

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface FileDiff {
  path: string;
  repo?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  oldContent: string;
  newContent: string;
  hunks: DiffHunk[];
}

export interface RepoInfo {
  repo: string;
  branch: string;
}

// --- Repo info ---

export async function getRepoInfo(dir: string): Promise<RepoInfo> {
  let repo = "";
  let branch = "";

  try {
    const remoteUrl = (await git(["config", "--get", "remote.origin.url"], dir)).trim();
    const match = remoteUrl.match(/[:\/]([^\/]+\/[^\/]+?)(?:\.git)?$/);
    repo = match ? match[1] : remoteUrl;
  } catch {
    // no remote
  }

  try {
    branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();
  } catch {
    branch = "unknown";
  }

  return { repo, branch };
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const toplevel = (await git(["rev-parse", "--show-toplevel"], dir)).trim();
    return resolve(toplevel) === resolve(dir);
  } catch {
    return false;
  }
}

/**
 * Detect the default branch (main, master, etc.) for a repo.
 * Checks remote HEAD first, then falls back to checking if main/master exist.
 */
export async function getDefaultBranch(dir: string): Promise<string | null> {
  // Try remote HEAD
  try {
    const ref = (await git(["symbolic-ref", "refs/remotes/origin/HEAD"], dir)).trim();
    const branch = ref.replace("refs/remotes/origin/", "");
    if (branch) return branch;
  } catch {
    // no remote HEAD set
  }

  // Fall back: check if main or master exists
  const branches = await getBranches(dir);
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";

  return null;
}

export async function getBranches(dir: string): Promise<string[]> {
  try {
    const output = (await git(["branch", "--format=%(refname:short)"], dir)).trim();
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// --- Changed files ---

async function getMergeBase(dir: string, baseRef: string): Promise<string> {
  return (await git(["merge-base", baseRef, "HEAD"], dir)).trim();
}

export async function getChangedFiles(dir: string, baseRef?: string): Promise<FileChange[]> {
  const files: FileChange[] = [];

  if (baseRef) {
    const mergeBase = await getMergeBase(dir, baseRef);
    const diffOutput = await git(["diff", "--name-status", mergeBase], dir);

    for (const line of diffOutput.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      const statusCode = parts[0];
      let fileStatus: FileChange["status"] = "modified";
      let oldPath: string | undefined;
      let filePath = parts[1];

      if (statusCode === "A") {
        fileStatus = "added";
      } else if (statusCode === "D") {
        fileStatus = "deleted";
      } else if (statusCode.startsWith("R")) {
        fileStatus = "renamed";
        oldPath = parts[1];
        filePath = parts[2];
      }

      files.push({ path: filePath, status: fileStatus, oldPath });
    }

    // Also include untracked files
    const statusOutput = await gitSafe(["status", "--porcelain"], dir);
    for (const line of statusOutput.split("\n").filter(Boolean)) {
      const status = line.substring(0, 2).trim();
      if (status === "??") {
        const path = line.substring(3);
        if (!files.some((f) => f.path === path)) {
          files.push({ path, status: "added" });
        }
      }
    }
  } else {
    const statusOutput = await git(["status", "--porcelain"], dir);

    for (const line of statusOutput.split("\n").filter(Boolean)) {
      const status = line.substring(0, 2).trim();
      const path = line.substring(3);

      let fileStatus: FileChange["status"] = "modified";
      let oldPath: string | undefined;

      if (status === "A" || status === "??") {
        fileStatus = "added";
      } else if (status === "D") {
        fileStatus = "deleted";
      } else if (status.startsWith("R")) {
        fileStatus = "renamed";
        const parts = path.split(" -> ");
        oldPath = parts[0];
      }

      files.push({
        path: fileStatus === "renamed" ? path.split(" -> ")[1] : path,
        status: fileStatus,
        oldPath,
      });
    }
  }

  return files;
}

// --- File diffs ---

async function readWorkingFile(dir: string, path: string): Promise<string> {
  try {
    return await readFile(join(dir, path), "utf-8");
  } catch {
    return "";
  }
}

export async function getFileDiff(dir: string, file: FileChange, baseRef?: string): Promise<FileDiff> {
  let oldContent = "";
  let newContent = "";
  let hunks: DiffHunk[] = [];
  const oldRef = baseRef ? await getMergeBase(dir, baseRef) : "HEAD";

  if (file.status === "added") {
    try {
      newContent = await git(["show", `:${file.path}`], dir);
    } catch {
      newContent = await readWorkingFile(dir, file.path);
    }
    oldContent = "";
  } else if (file.status === "deleted") {
    oldContent = await gitSafe(["show", `${oldRef}:${file.path}`], dir);
    newContent = "";
  } else {
    oldContent = await gitSafe(["show", `${oldRef}:${file.path}`], dir);
    newContent = await readWorkingFile(dir, file.path);
    if (!newContent) {
      try {
        newContent = await git(["show", `:${file.path}`], dir);
      } catch {
        newContent = await gitSafe(["show", `HEAD:${file.path}`], dir);
      }
    }
  }

  if (file.status !== "added") {
    try {
      const diffResult = await git(["diff", oldRef, "--", file.path], dir);
      hunks = parseDiffHunks(diffResult);
    } catch {
      hunks = [];
    }
  }

  return {
    path: file.path,
    status: file.status,
    oldPath: file.oldPath,
    oldContent,
    newContent,
    hunks,
  };
}

// --- Multi-file / multi-repo ---

export async function getAllFileDiffs(dir: string, repo?: string, baseRef?: string): Promise<FileDiff[]> {
  const files = await getChangedFiles(dir, baseRef);
  const diffs: FileDiff[] = [];

  for (const file of files) {
    const diff = await getFileDiff(dir, file, baseRef);
    if (repo) diff.repo = repo;
    diffs.push(diff);
  }

  return diffs;
}

export async function discoverGitRepos(parentDir: string): Promise<string[]> {
  const entries = await readdir(parentDir, { withFileTypes: true });
  const repos: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      const subDir = join(parentDir, entry.name);
      if (await isGitRepo(subDir)) {
        repos.push(entry.name);
      }
    }
  }

  return repos.sort();
}

export interface MultiRepoResult {
  repos: Array<{ name: string; info: RepoInfo }>;
  diffs: FileDiff[];
}

export async function getMultiRepoDiffs(parentDir: string, repoNames: string[], baseRef?: string): Promise<MultiRepoResult> {
  const repos: Array<{ name: string; info: RepoInfo }> = [];
  const allDiffs: FileDiff[] = [];

  for (const name of repoNames) {
    const repoDir = join(parentDir, name);
    const info = await getRepoInfo(repoDir);
    const diffs = await getAllFileDiffs(repoDir, name, baseRef);

    if (diffs.length > 0) {
      repos.push({ name, info });
      allDiffs.push(...diffs);
    }
  }

  return { repos, diffs: allDiffs };
}

// --- Hunk parser ---

function parseDiffHunks(diffOutput: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffOutput.split("\n");
  let currentHunk: DiffHunk | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk) {
        currentHunk.content = currentContent.join("\n");
        hunks.push(currentHunk);
      }
      currentHunk = {
        oldStart: parseInt(hunkMatch[1]),
        oldLines: parseInt(hunkMatch[2] || "1"),
        newStart: parseInt(hunkMatch[3]),
        newLines: parseInt(hunkMatch[4] || "1"),
        content: "",
      };
      currentContent = [line];
    } else if (currentHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\"))) {
      currentContent.push(line);
    }
  }

  if (currentHunk) {
    currentHunk.content = currentContent.join("\n");
    hunks.push(currentHunk);
  }

  return hunks;
}
