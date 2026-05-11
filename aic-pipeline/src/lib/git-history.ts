/**
 * File version history helpers — read-only views into the env-repo.
 *
 * The env-repo (settings.targetDir) commits every pull / push / promote /
 * manual snapshot, so per-file history is just `git log <path>` and per-version
 * content is `git show <sha>:<path>`. These helpers wrap that with path
 * normalisation and op-kind classification so the Browse tab can show a
 * "Versions" dropdown without re-implementing git plumbing.
 */
import path from "path";
import {
  loadSettings,
  resolveTargetDir,
  targetHasGit,
  runGit,
} from "@/lib/git-settings";

export type OpKind =
  | "pull"
  | "push"
  | "promote"
  | "manual"
  | "auto"
  | "merge"
  | "other";

export interface FileCommit {
  sha: string;
  shortSha: string;
  isoDate: string;
  author: string;
  subject: string;
  opKind: OpKind;
}

export interface ReadAtSha {
  ok: boolean;
  exists: boolean;
  content: string;
  error?: string;
}

/**
 * Convert an absolute filesystem path into a forward-slash path relative to
 * the env-repo root. Returns `null` when the file is outside the repo or git
 * isn't initialised — callers should treat that as "no history available".
 */
export function repoRelativePath(absPath: string): string | null {
  if (!targetHasGit()) return null;
  const root = resolveTargetDir();
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * Classify a commit subject into a coarse op-kind so the UI can color the
 * timeline (pulls = blue, pushes = green, promotes = purple, etc.). Subjects
 * follow the conventions written by the pull / push / promote pipelines.
 */
export function classifyCommitSubject(subject: string): OpKind {
  const s = subject.trim();
  if (s.startsWith("pull(")) return "pull";
  if (s.startsWith("promote(")) return "promote";
  if (s.startsWith("auto:")) return "auto";
  if (s.startsWith("Merge ")) return "merge";
  if (
    s.startsWith("Snapshot before push") ||
    s === "Manual snapshot from Settings" ||
    s === "Initial environments snapshot"
  ) {
    return s.startsWith("Snapshot before push") ? "push" : "manual";
  }
  return "other";
}

/**
 * Return the commits that touched `repoRelPath`, newest first. Uses
 * `--follow` so renames don't truncate history. Each row is parsed from a
 * `\x1f`-separated record so commit subjects with newlines / pipes survive.
 */
export function listFileCommits(
  repoRelPath: string,
  limit = 50,
): { ok: boolean; entries: FileCommit[]; error?: string } {
  if (!targetHasGit()) {
    return { ok: false, entries: [], error: "Env repo is not a git repository." };
  }
  const cwd = resolveTargetDir();
  const SEP = "\x1f";
  const FMT = ["%H", "%h", "%cI", "%an", "%s"].join(SEP);
  const res = runGit(
    [
      "log",
      `--max-count=${limit}`,
      "--follow",
      `--pretty=format:${FMT}`,
      "--",
      repoRelPath,
    ],
    cwd,
  );
  if (!res.ok) {
    return { ok: false, entries: [], error: res.stderr || "git log failed" };
  }
  const entries: FileCommit[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(SEP);
    if (parts.length < 5) continue;
    const [sha, shortSha, isoDate, author, ...rest] = parts;
    const subject = rest.join(SEP);
    entries.push({
      sha,
      shortSha,
      isoDate,
      author,
      subject,
      opKind: classifyCommitSubject(subject),
    });
  }
  return { ok: true, entries };
}

/**
 * Return the file content at a specific commit. `exists: false` when the path
 * was not in the tree at that commit (file was added later or deleted).
 */
export function readFileAtSha(sha: string, repoRelPath: string): ReadAtSha {
  if (!targetHasGit()) {
    return { ok: false, exists: false, content: "", error: "Env repo is not a git repository." };
  }
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    return { ok: false, exists: false, content: "", error: "Invalid commit sha." };
  }
  const cwd = resolveTargetDir();
  const res = runGit(["show", `${sha}:${repoRelPath}`], cwd);
  if (!res.ok) {
    const stderr = res.stderr || "";
    if (
      /does not exist/i.test(stderr) ||
      /exists on disk, but not in/i.test(stderr) ||
      /unknown revision or path/i.test(stderr) ||
      /Path .* does not exist in/i.test(stderr)
    ) {
      return { ok: true, exists: false, content: "" };
    }
    return { ok: false, exists: false, content: "", error: stderr || "git show failed" };
  }
  return { ok: true, exists: true, content: res.stdout };
}
