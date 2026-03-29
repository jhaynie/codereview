import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChevronLeft, ChevronRight, Sun, Moon, Monitor, X, SquareUserRound } from "lucide-react";
import type { FileDiff as FileDiffType } from "../git";

interface Comment {
  id: string;
  fileKey: string; // unique key: "repo:path" or just "path"
  filePath: string;
  repo?: string;
  lineNumber: number;
  lineType: "old" | "new";
  content: string;
  lineContent: string;
}

type EditingLine = {
  fileKey: string;
  filePath: string;
  repo?: string;
  lineNumber: number;
  lineType: "old" | "new";
  lineContent: string;
} | null;

interface InfoResponse {
  multiRepo: boolean;
  repos: Array<{ name: string; info: { repo: string; branch: string } }>;
  baseRef: string;
}

function makeFileKey(diff: FileDiffType): string {
  return diff.repo ? `${diff.repo}:${diff.path}` : diff.path;
}

function App() {
  const [diffs, setDiffs] = useState<FileDiffType[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [comments, setComments] = useState<Comment[]>([]);
  const [editing, setEditing] = useState<EditingLine>(null);
  const [editText, setEditText] = useState("");
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: string } | null>(null);
  const [info, setInfo] = useState<InfoResponse>({ multiRepo: false, repos: [], baseRef: "" });
  const [branches, setBranches] = useState<string[]>([]);
  const [reloading, setReloading] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("codereview:sidebar-width");
    return saved ? parseInt(saved, 10) : 280;
  });
  const [showSlideover, setShowSlideover] = useState(false);
  const [generateModal, setGenerateModal] = useState<string | null>(null);
  const [themePref, setThemePref] = useState<"light" | "dark" | "system">(() => {
    const saved = localStorage.getItem("codereview:theme");
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    return "system";
  });
  const isDragging = useRef(false);
  const mainRef = useRef<HTMLDivElement>(null);
  const diffContentRef = useRef<HTMLDivElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);

  // Resolve effective theme from preference
  const resolvedTheme = useMemo(() => {
    if (themePref !== "system") return themePref;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }, [themePref]);

  // Apply theme + listen for system changes
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    localStorage.setItem("codereview:theme", themePref);
  }, [resolvedTheme, themePref]);

  useEffect(() => {
    if (themePref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => {
      document.documentElement.setAttribute("data-theme", mq.matches ? "light" : "dark");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themePref]);

  const cycleTheme = useCallback(() => {
    setThemePref((t) => {
      if (t === "system") return "light";
      if (t === "light") return "dark";
      return "system";
    });
  }, []);

  // Resize handle drag
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !mainRef.current) return;
      const rect = mainRef.current.getBoundingClientRect();
      const newWidth = Math.min(Math.max(e.clientX - rect.left, 160), 600);
      setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // Persist sidebar width — read from the DOM since state is stale in this closure
        const sidebar = mainRef.current?.querySelector(".sidebar") as HTMLElement | null;
        if (sidebar) {
          localStorage.setItem("codereview:sidebar-width", String(sidebar.offsetWidth));
        }
      }
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleDragStart = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // Fetch diffs + repo info + branches
  useEffect(() => {
    Promise.all([
      fetch("/api/diffs").then((res) => res.json()),
      fetch("/api/info").then((res) => res.json()),
      fetch("/api/branches").then((res) => res.json()),
    ])
      .then(([diffsData, infoData, branchData]) => {
        setDiffs(diffsData);
        setInfo(infoData);
        setBranches(branchData.branches || []);
        setLoading(false);
        setTimeout(() => {
          const first = document.querySelector(".file-item") as HTMLElement | null;
          first?.focus();
        }, 50);
      })
      .catch(() => setLoading(false));
  }, []);

  const showToast = useCallback((message: string, type: string = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const currentDiff = useMemo(() => diffs[selectedIndex], [diffs, selectedIndex]);

  const handlePrev = useCallback(() => {
    setSelectedIndex((i) => Math.max(0, i - 1));
  }, []);

  const handleNext = useCallback(() => {
    setSelectedIndex((i) => Math.min(diffs.length - 1, i + 1));
  }, [diffs.length]);

  const handleSelectFile = useCallback((index: number) => {
    setSelectedIndex(index);
  }, []);

  // Inline comment: open editor
  const handleLineClick = useCallback((
    fileKey: string,
    filePath: string,
    repo: string | undefined,
    lineNumber: number,
    lineType: "old" | "new",
    lineContent: string
  ) => {
    const existing = comments.find(
      (c) => c.fileKey === fileKey && c.lineNumber === lineNumber && c.lineType === lineType
    );
    setEditing({ fileKey, filePath, repo, lineNumber, lineType, lineContent });
    setEditText(existing?.content || "");
  }, [comments]);

  // Save inline comment (Cmd+Enter)
  const handleSaveInline = useCallback(() => {
    if (!editing) return;
    if (editText.trim()) {
      const existing = comments.find(
        (c) => c.fileKey === editing.fileKey && c.lineNumber === editing.lineNumber && c.lineType === editing.lineType
      );
      const newComment: Comment = {
        id: existing?.id || crypto.randomUUID(),
        fileKey: editing.fileKey,
        filePath: editing.filePath,
        repo: editing.repo,
        lineNumber: editing.lineNumber,
        lineType: editing.lineType,
        content: editText.trim(),
        lineContent: editing.lineContent,
      };
      setComments((prev) => {
        const filtered = prev.filter(
          (c) => !(c.fileKey === editing.fileKey && c.lineNumber === editing.lineNumber && c.lineType === editing.lineType)
        );
        return [...filtered, newComment];
      });
    }
    setEditing(null);
    setEditText("");
  }, [editing, editText, comments]);

  // Cancel inline edit (Escape)
  const handleCancelInline = useCallback(() => {
    setEditing(null);
    setEditText("");
  }, []);

  // Delete comment
  const handleDeleteComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // Change base branch and reload diffs
  const handleBaseChange = useCallback(async (base: string) => {
    setReloading(true);
    try {
      const res = await fetch("/api/reload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base }),
      });
      const result = await res.json();
      if (result.success) {
        // Reload diffs
        const diffsRes = await fetch("/api/diffs");
        const diffsData = await diffsRes.json();
        setDiffs(diffsData);
        setInfo((prev) => ({ ...prev, baseRef: result.baseRef, repos: result.repos }));
        setSelectedIndex(0);
        showToast(`Loaded ${result.fileCount} file(s)${base ? ` (vs ${base})` : " (uncommitted only)"}`);
      } else {
        showToast(`Error: ${result.error}`, "error");
      }
    } catch {
      showToast("Failed to reload", "error");
    }
    setReloading(false);
  }, [showToast]);

  // Generate markdown
  const handleGenerate = useCallback(async () => {
    if (comments.length === 0) {
      showToast("No comments to generate", "error");
      return;
    }
    const res = await fetch("/api/generate-markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comments }),
    });
    const { markdown } = await res.json();
    setGenerateModal(markdown);
  }, [comments, showToast]);

  // Navigate to comment from slideover
  const handleGoToComment = useCallback((comment: Comment) => {
    const idx = diffs.findIndex((d) => makeFileKey(d) === comment.fileKey);
    if (idx !== -1) {
      setSelectedIndex(idx);
      setShowSlideover(false);
      setTimeout(() => {
        const el = document.querySelector(`[data-line-key="${comment.fileKey}:${comment.lineNumber}:${comment.lineType}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);
    }
  }, [diffs]);

  const getComment = useCallback((fileKey: string, lineNumber: number, lineType: "old" | "new") => {
    return comments.find((c) => c.fileKey === fileKey && c.lineNumber === lineNumber && c.lineType === lineType);
  }, [comments]);

  const getFileComments = useCallback((fileKey: string) => {
    return comments.filter((c) => c.fileKey === fileKey);
  }, [comments]);

  const isEditing = useCallback((fileKey: string, lineNumber: number, lineType: "old" | "new") => {
    return editing?.fileKey === fileKey && editing.lineNumber === lineNumber && editing.lineType === lineType;
  }, [editing]);

  // Group diffs by repo for sidebar
  const diffsByRepo = useMemo(() => {
    const map = new Map<string, { index: number; diff: FileDiffType }[]>();
    diffs.forEach((diff, index) => {
      const repo = diff.repo || "";
      const arr = map.get(repo) || [];
      arr.push({ index, diff });
      map.set(repo, arr);
    });
    return map;
  }, [diffs]);

  if (loading) {
    return (
      <div className="app">
        <div className="loading">
          <div className="loading-spinner" />
        </div>
      </div>
    );
  }

  if (diffs.length === 0) {
    return (
      <div className="app">
        <div className="empty-state">
          <div className="empty-state-icon">📝</div>
          <div className="empty-state-text">No changes to review</div>
        </div>
      </div>
    );
  }

  // Group comments by file for slideover
  const commentsByFile = new Map<string, Comment[]>();
  for (const c of comments) {
    const label = c.repo ? `${c.repo}/${c.filePath}` : c.filePath;
    const arr = commentsByFile.get(label) || [];
    arr.push(c);
    commentsByFile.set(label, arr);
  }

  return (
    <div className="app">
      <div className="toolbar">
        <div className="toolbar-title"><SquareUserRound size={18} /> Human Code Reviewer</div>
        <div className="base-selector">
          <button
            type="button"
            className={`base-toggle ${!info.baseRef ? "active" : ""}`}
            onClick={() => handleBaseChange("")}
            disabled={reloading || !info.baseRef}
          >
            dirty
          </button>
          <button
            type="button"
            className={`base-toggle ${info.baseRef === "main" ? "active" : ""}`}
            onClick={() => handleBaseChange("main")}
            disabled={reloading || info.baseRef === "main"}
          >
            vs main
          </button>
          {reloading && <div className="loading-spinner-small" />}
        </div>
        <div className="toolbar-spacer" />
        {comments.length > 0 && (
          <button
            type="button"
            className="comments-pill"
            onClick={() => setShowSlideover(true)}
            title="View all comments"
          >
            <span className="comments-pill-icon">●</span>
            {comments.length} {comments.length === 1 ? "comment" : "comments"}
          </button>
        )}
        <button
          type="button"
          className="btn-generate"
          onClick={handleGenerate}
          disabled={comments.length === 0}
        >
          Generate
        </button>
        <div className="toolbar-nav">
          <button
            type="button"
            className="toolbar-btn"
            onClick={handlePrev}
            disabled={selectedIndex === 0}
            title="Previous file"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="toolbar-file-info">
            {selectedIndex + 1} / {diffs.length}
          </span>
          <button
            type="button"
            className="toolbar-btn"
            onClick={handleNext}
            disabled={selectedIndex === diffs.length - 1}
            title="Next file"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="main-content" ref={mainRef}>
        <div className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
          <div className="sidebar-header">Files ({diffs.length})</div>
          <div className="file-list" role="listbox" ref={fileListRef}>
            {Array.from(diffsByRepo.entries()).map(([repo, items]) => (
              <div key={repo || "__single__"}>
                {info.multiRepo && repo && (
                  <div className="file-list-repo-header">{repo}</div>
                )}
                {items.map(({ index, diff }) => {
                  const fk = makeFileKey(diff);
                  return (
                    <button
                      type="button"
                      key={fk}
                      role="option"
                      aria-selected={index === selectedIndex}
                      className={`file-item ${index === selectedIndex ? "active" : ""}`}
                      ref={(el) => {
                        if (index === selectedIndex && el && el.closest(".file-list")?.contains(document.activeElement)) {
                          el.focus();
                        }
                      }}
                      onClick={() => handleSelectFile(index)}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          if (index < diffs.length - 1) handleSelectFile(index + 1);
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          if (index > 0) handleSelectFile(index - 1);
                        } else if (e.key === "ArrowRight") {
                          e.preventDefault();
                          diffContentRef.current?.focus();
                        }
                      }}
                    >
                      <span className={`file-status-icon ${diff.status}`}>
                        {getStatusIcon(diff.status)}
                      </span>
                      <span className="file-info">
                        <span className="file-name">{splitPath(diff.path).name}</span>
                        {splitPath(diff.path).dir && (
                          <span className="file-dir">{splitPath(diff.path).dir}</span>
                        )}
                      </span>
                      {getFileComments(fk).length > 0 && (
                        <span className="comments-badge">{getFileComments(fk).length}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="sidebar-footer">
            <div className="sidebar-footer-info">
              {info.repos.length === 1 && (
                <>
                  {info.repos[0].info.repo && <span className="sidebar-footer-repo">{info.repos[0].info.repo}</span>}
                  {info.repos[0].info.branch && <span className="sidebar-footer-branch">{info.repos[0].info.branch}</span>}
                </>
              )}
              {info.repos.length > 1 && (
                <div className="sidebar-footer-multi">
                  <span className="sidebar-footer-repo">{info.repos.length} repositories</span>
                  <div className="sidebar-footer-tooltip">
                    {info.repos.map((r) => (
                      <div key={r.name} className="sidebar-footer-tooltip-row">
                        <span className="sidebar-footer-tooltip-name">{r.name}</span>
                        <span className="sidebar-footer-tooltip-branch">{r.info.branch}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              className="toolbar-btn"
              onClick={cycleTheme}
              title={`Theme: ${themePref}`}
            >
              {themePref === "light" && <Sun size={14} />}
              {themePref === "dark" && <Moon size={14} />}
              {themePref === "system" && <Monitor size={14} />}
            </button>
          </div>
        </div>

        <div
          className="resize-handle"
          role="separator"
          aria-valuenow={sidebarWidth}
          aria-valuemin={160}
          aria-valuemax={600}
          tabIndex={0}
          onMouseDown={handleDragStart}
        />

        <DiffViewer
          diff={currentDiff}
          onLineClick={handleLineClick}
          getComment={getComment}
          isEditing={isEditing}
          editText={editText}
          setEditText={setEditText}
          onSaveInline={handleSaveInline}
          onCancelInline={handleCancelInline}
          onDeleteComment={handleDeleteComment}
          diffContentRef={diffContentRef}
          onFocusSidebar={() => {
            const active = fileListRef.current?.querySelector(".file-item.active") as HTMLElement | null;
            active?.focus();
          }}
        />
      </div>

      {showSlideover && (
        <CommentSlideover
          commentsByFile={commentsByFile}
          onClose={() => setShowSlideover(false)}
          onGoToComment={handleGoToComment}
          onDeleteComment={handleDeleteComment}
        />
      )}

      {generateModal !== null && (
        <GenerateModal
          markdown={generateModal}
          onClose={() => setGenerateModal(null)}
          onCopy={(text) => {
            copyToClipboard(text);
            showToast("Copied to clipboard");
            setGenerateModal(null);
          }}
        />
      )}

      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

// --- Utilities ---

function copyToClipboard(text: string) {
  try {
    navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "added": return "A";
    case "deleted": return "D";
    case "modified": return "M";
    case "renamed": return "R";
    default: return "?";
  }
}

function splitPath(filepath: string): { name: string; dir: string } {
  const lastSlash = filepath.lastIndexOf("/");
  if (lastSlash === -1) return { name: filepath, dir: "" };
  return { name: filepath.slice(lastSlash + 1), dir: filepath.slice(0, lastSlash) };
}

// --- Generate Modal ---

interface GenerateModalProps {
  markdown: string;
  onClose: () => void;
  onCopy: (text: string) => void;
}

function GenerateModal({ markdown, onClose, onCopy }: GenerateModalProps) {
  const [text, setText] = useState(markdown);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="comment-modal-overlay">
      <div className="generate-modal">
        <div className="comment-modal-header">
          <div className="comment-modal-title">Review Feedback</div>
          <button type="button" className="comment-modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="generate-modal-body">
          <textarea
            className="generate-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="comment-modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onCopy(text)}>Copy to Clipboard</button>
        </div>
      </div>
    </div>
  );
}

// --- Comment Slideover ---

interface CommentSlideoverProps {
  commentsByFile: Map<string, Comment[]>;
  onClose: () => void;
  onGoToComment: (comment: Comment) => void;
  onDeleteComment: (id: string) => void;
}

function CommentSlideover({ commentsByFile, onClose, onGoToComment, onDeleteComment }: CommentSlideoverProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="slideover-backdrop">
      <div className="slideover">
        <div className="slideover-header">
          <div className="slideover-title">All Comments</div>
          <button type="button" className="comment-modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="slideover-body">
          {Array.from(commentsByFile.entries()).map(([filePath, fileComments]) => (
            <div key={filePath} className="slideover-file-group">
              <div className="slideover-file-name">{filePath}</div>
              {fileComments.map((comment) => (
                <div key={comment.id} className="slideover-comment">
                  <button
                    type="button"
                    className="slideover-comment-body"
                    onClick={() => onGoToComment(comment)}
                  >
                    <span className="slideover-comment-line">Line {comment.lineNumber}</span>
                    <span className="slideover-comment-text">{comment.content}</span>
                  </button>
                  <button
                    type="button"
                    className="slideover-comment-delete"
                    onClick={() => onDeleteComment(comment.id)}
                    title="Delete comment"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Inline Comment Editor ---

interface InlineEditorProps {
  text: string;
  setText: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function InlineEditor({ text, setText, onSave, onCancel }: InlineEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }, [onSave, onCancel]);

  return (
    <div className="inline-editor">
      <textarea
        ref={textareaRef}
        className="inline-editor-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment… (⌘+Enter to save, Esc to cancel)"
        rows={2}
      />
      <div className="inline-editor-hint">⌘+Enter to save · Esc to cancel</div>
    </div>
  );
}

// --- Inline Comment Display ---

interface InlineCommentProps {
  comment: Comment;
  onEdit: () => void;
  onDelete: () => void;
}

function InlineComment({ comment, onEdit, onDelete }: InlineCommentProps) {
  return (
    <div className="inline-comment">
      <div className="inline-comment-bar" />
      <button type="button" className="inline-comment-body" onClick={onEdit}>
        {comment.content}
      </button>
      <button type="button" className="inline-comment-delete" onClick={onDelete} title="Delete"><X size={14} /></button>
    </div>
  );
}

// --- Diff Viewer ---

function emitCollapsedRegion(
  result: DiffLine[],
  regionId: string,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
  totalCount: number,
  oldLines: string[],
  newLines: string[],
  expandedCounts: Map<string, number>,
) {
  const revealedDown = expandedCounts.get(`${regionId}:down`) || 0;
  const revealedUp = expandedCounts.get(`${regionId}:up`) || 0;

  // Emit revealed lines from the top
  const downCount = Math.min(revealedDown, totalCount);
  for (let i = 0; i < downCount; i++) {
    const oN = oldStart + i;
    const nN = newStart + i;
    const content = oldLines[oN - 1] ?? newLines[nN - 1] ?? "";
    result.push({ id: `exp-${regionId}-d${i}`, type: "context", oldLine: oN, newLine: nN, content, rawContent: content });
  }

  // Emit revealed lines from the bottom
  const upCount = Math.min(revealedUp, totalCount - downCount);
  const remainingAfterDown = totalCount - downCount;
  const hiddenCount = remainingAfterDown - upCount;

  // Collapsed marker for whatever is still hidden
  if (hiddenCount > 0) {
    result.push({
      id: regionId,
      type: "collapsed",
      content: "",
      rawContent: "",
      collapsedOldStart: oldStart + downCount,
      collapsedOldEnd: oldEnd - upCount,
      collapsedNewStart: newStart + downCount,
      collapsedNewEnd: newEnd - upCount,
      collapsedCount: hiddenCount,
    });
  }

  // Emit revealed lines from the bottom (in order)
  for (let i = upCount - 1; i >= 0; i--) {
    const oN = oldEnd - i;
    const nN = newEnd - i;
    const content = oldLines[oN - 1] ?? newLines[nN - 1] ?? "";
    result.push({ id: `exp-${regionId}-u${i}`, type: "context", oldLine: oN, newLine: nN, content, rawContent: content });
  }
}

interface DiffLine {
  id: string;
  type: "hunk" | "added" | "removed" | "context" | "collapsed";
  oldLine?: number;
  newLine?: number;
  content: string;
  rawContent: string;
  // For collapsed lines
  collapsedOldStart?: number;
  collapsedOldEnd?: number;
  collapsedNewStart?: number;
  collapsedNewEnd?: number;
  collapsedCount?: number;
}

interface DiffViewerProps {
  diff: FileDiffType;
  onLineClick: (fileKey: string, filePath: string, repo: string | undefined, lineNumber: number, lineType: "old" | "new", lineContent: string) => void;
  getComment: (fileKey: string, lineNumber: number, lineType: "old" | "new") => Comment | undefined;
  isEditing: (fileKey: string, lineNumber: number, lineType: "old" | "new") => boolean;
  editText: string;
  setEditText: (text: string) => void;
  onSaveInline: () => void;
  onCancelInline: () => void;
  onDeleteComment: (id: string) => void;
  diffContentRef: React.RefObject<HTMLDivElement>;
  onFocusSidebar: () => void;
}

function DiffViewer({ diff, onLineClick, getComment, isEditing, editText, setEditText, onSaveInline, onCancelInline, onDeleteComment, diffContentRef, onFocusSidebar }: DiffViewerProps) {
  // Track how many lines revealed per collapsed region
  const [expandedCounts, setExpandedCounts] = useState<Map<string, number>>(new Map());

  // Reset when file changes
  const diffPath = diff?.path;
  useEffect(() => {
    setExpandedCounts(new Map());
  }, [diffPath]);

  const EXPAND_STEP = 10;

  const handleExpand = useCallback((regionId: string, direction: "down" | "up") => {
    setExpandedCounts((prev) => {
      const next = new Map(prev);
      const key = `${regionId}:${direction}`;
      next.set(key, (next.get(key) || 0) + EXPAND_STEP);
      return next;
    });
  }, []);

  const lines = useMemo((): DiffLine[] => {
    if (!diff) return [];
    const result: DiffLine[] = [];
    const oldLines = diff.oldContent ? diff.oldContent.split("\n") : [];
    const newLines = diff.newContent ? diff.newContent.split("\n") : [];

    if (diff.status === "added" && diff.newContent) {
      let n = 1;
      for (const line of newLines) {
        result.push({ id: `new-${n}`, type: "added", newLine: n, content: line, rawContent: line });
        n++;
      }
    } else if (diff.status === "deleted" && diff.oldContent) {
      let n = 1;
      for (const line of oldLines) {
        result.push({ id: `old-${n}`, type: "removed", oldLine: n, content: line, rawContent: line });
        n++;
      }
    } else if (diff.hunks && diff.hunks.length > 0) {
      let hi = 0;

      for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
        const hunk = diff.hunks[hunkIndex];
        const prevHunk = hunkIndex > 0 ? diff.hunks[hunkIndex - 1] : null;

        // Collapsed region before this hunk
        let collapsedOldStart: number;
        let collapsedNewStart: number;
        if (prevHunk) {
          collapsedOldStart = prevHunk.oldStart + prevHunk.oldLines;
          collapsedNewStart = prevHunk.newStart + prevHunk.newLines;
        } else {
          collapsedOldStart = 1;
          collapsedNewStart = 1;
        }
        const collapsedOldEnd = hunk.oldStart - 1;
        const collapsedNewEnd = hunk.newStart - 1;
        const collapsedCount = collapsedOldEnd - collapsedOldStart + 1;
        const regionId = `collapse-${hunkIndex}`;

        if (collapsedCount > 0) {
          emitCollapsedRegion(result, regionId, collapsedOldStart, collapsedOldEnd, collapsedNewStart, collapsedNewEnd, collapsedCount, oldLines, newLines, expandedCounts);
        }

        // Hunk header
        result.push({
          id: `hunk-${hi}`,
          type: "hunk",
          content: `Lines ${hunk.newStart}–${hunk.newStart + hunk.newLines - 1}`,
          rawContent: "",
        });
        hi++;

        // Hunk content
        let oldN = hunk.oldStart;
        let newN = hunk.newStart;
        const hunkContentLines = hunk.content.split("\n").slice(1);
        let li = 0;
        for (const line of hunkContentLines) {
          if (line.startsWith("+")) {
            result.push({ id: `h${hi}-a${li}`, type: "added", newLine: newN, content: line.slice(1), rawContent: line.slice(1) });
            newN++;
          } else if (line.startsWith("-")) {
            result.push({ id: `h${hi}-r${li}`, type: "removed", oldLine: oldN, content: line.slice(1), rawContent: line.slice(1) });
            oldN++;
          } else if (line.startsWith(" ")) {
            result.push({ id: `h${hi}-c${li}`, type: "context", oldLine: oldN, newLine: newN, content: line.slice(1), rawContent: line.slice(1) });
            oldN++;
            newN++;
          }
          li++;
        }

        // Collapsed region after the last hunk
        if (hunkIndex === diff.hunks.length - 1) {
          const afterOldStart = hunk.oldStart + hunk.oldLines;
          const afterNewStart = hunk.newStart + hunk.newLines;
          const afterOldEnd = oldLines.length;
          const afterNewEnd = newLines.length;
          const afterCount = afterOldEnd - afterOldStart + 1;
          const afterRegionId = `collapse-after`;

          if (afterCount > 0) {
            emitCollapsedRegion(result, afterRegionId, afterOldStart, afterOldEnd, afterNewStart, afterNewEnd, afterCount, oldLines, newLines, expandedCounts);
          }
        }
      }
    } else {
      const max = Math.max(oldLines.length, newLines.length);
      for (let i = 0; i < max; i++) {
        const ol = oldLines[i];
        const nl = newLines[i];
        if (ol !== undefined && nl !== undefined) {
          if (ol === nl) {
            result.push({ id: `ctx-${i}`, type: "context", oldLine: i + 1, newLine: i + 1, content: ol, rawContent: ol });
          } else {
            result.push({ id: `rem-${i}`, type: "removed", oldLine: i + 1, content: ol, rawContent: ol });
            result.push({ id: `add-${i}`, type: "added", newLine: i + 1, content: nl, rawContent: nl });
          }
        } else if (ol !== undefined) {
          result.push({ id: `rem-${i}`, type: "removed", oldLine: i + 1, content: ol, rawContent: ol });
        } else if (nl !== undefined) {
          result.push({ id: `add-${i}`, type: "added", newLine: i + 1, content: nl, rawContent: nl });
        }
      }
    }
    return result;
  }, [diff, expandedCounts]);

  // Compute diff stats from ALL lines (not just visible/expanded)
  const stats = useMemo(() => {
    if (!diff) return { additions: 0, deletions: 0 };
    let additions = 0;
    let deletions = 0;

    if (diff.status === "added" && diff.newContent) {
      additions = diff.newContent.split("\n").length;
    } else if (diff.status === "deleted" && diff.oldContent) {
      deletions = diff.oldContent.split("\n").length;
    } else if (diff.hunks && diff.hunks.length > 0) {
      for (const hunk of diff.hunks) {
        for (const line of hunk.content.split("\n").slice(1)) {
          if (line.startsWith("+")) additions++;
          else if (line.startsWith("-")) deletions++;
        }
      }
    }
    return { additions, deletions };
  }, [diff]);

  if (!diff) {
    return (
      <div className="diff-container">
        <div className="empty-state">
          <div className="empty-state-icon">📄</div>
          <div className="empty-state-text">Select a file to view diff</div>
        </div>
      </div>
    );
  }

  return (
    <div className="diff-container">
      <div className="diff-header">
        {diff.repo && <span className="diff-repo-badge">{diff.repo}</span>}
        <span className="diff-path">{diff.path}</span>
        <span className={`diff-status-badge ${diff.status}`}>{diff.status}</span>
        {diff.oldPath && diff.oldPath !== diff.path && (
          <span className="diff-path" style={{ color: "var(--text-muted)", fontSize: "12px" }}>
            (was {diff.oldPath})
          </span>
        )}
        <div className="diff-header-spacer" />
        <div className="diff-stats">
          {stats.additions > 0 && <span className="diff-stat-added">+{stats.additions}</span>}
          {stats.deletions > 0 && <span className="diff-stat-deleted">−{stats.deletions}</span>}
        </div>
      </div>
      <div
        className="diff-content"
        ref={diffContentRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" && !(e.target instanceof HTMLTextAreaElement)) {
            e.preventDefault();
            onFocusSidebar();
          }
        }}
      >
        {lines.map((line) => {
          if (line.type === "hunk") {
            return <div key={line.id} className="diff-hunk-header">{line.content}</div>;
          }

          if (line.type === "collapsed") {
            const count = line.collapsedCount!;
            const showBoth = count > EXPAND_STEP;
            return (
              <div key={line.id} className="diff-collapsed">
                <div className="diff-collapsed-gutter" />
                {showBoth ? (
                  <>
                    <button type="button" className="diff-collapsed-btn" onClick={() => handleExpand(line.id, "down")} title="Expand down">
                      ↕ Show {Math.min(EXPAND_STEP, count)} lines below
                    </button>
                    <span className="diff-collapsed-count">{count} lines hidden</span>
                    <button type="button" className="diff-collapsed-btn" onClick={() => handleExpand(line.id, "up")} title="Expand up">
                      ↕ Show {Math.min(EXPAND_STEP, count)} lines above
                    </button>
                  </>
                ) : (
                  <button type="button" className="diff-collapsed-btn diff-collapsed-btn-full" onClick={() => handleExpand(line.id, "down")} title="Expand all">
                    ↕ Show {count} hidden line{count === 1 ? "" : "s"}
                  </button>
                )}
              </div>
            );
          }

          const fk = makeFileKey(diff);
          const lineType = line.type === "removed" ? "old" as const : "new" as const;
          const lineNumber = line.type === "removed" ? line.oldLine : line.newLine;
          const comment = lineNumber ? getComment(fk, lineNumber, lineType) : undefined;
          const editing = lineNumber ? isEditing(fk, lineNumber, lineType) : false;

          return (
            <div key={line.id} data-line-key={`${fk}:${lineNumber}:${lineType}`}>
              <div className={`diff-line diff-line-${line.type}`}>
                <div className="diff-line-num">{line.oldLine || ""}</div>
                <div className="diff-line-num">{line.newLine || ""}</div>
                <button
                  type="button"
                  className={`comment-indicator ${comment ? "has-comment" : ""}`}
                  onClick={() => {
                    if (lineNumber !== undefined) {
                      onLineClick(fk, diff.path, diff.repo, lineNumber, lineType, line.rawContent);
                    }
                  }}
                  title={comment ? "Edit comment" : "Add comment"}
                >
                  {comment ? "●" : "+"}
                </button>
                <div className="diff-line-content">
                  {line.type === "added" && "+"}
                  {line.type === "removed" && "-"}
                  {line.type === "context" && " "}
                  {line.content}
                </div>
              </div>

              {editing && (
                <InlineEditor
                  text={editText}
                  setText={setEditText}
                  onSave={onSaveInline}
                  onCancel={onCancelInline}
                />
              )}

              {!editing && comment && (
                <InlineComment
                  comment={comment}
                  onEdit={() => onLineClick(fk, diff.path, diff.repo, lineNumber!, lineType, line.rawContent)}
                  onDelete={() => onDeleteComment(comment.id)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Keepalive SSE — server exits when all clients disconnect
new EventSource("/api/keepalive");

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
