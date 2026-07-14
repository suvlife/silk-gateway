// =============================================================================
// RTK (Token Saver) - Self-contained port for SilkGateway
// =============================================================================
// Compresses tool_result content (git diff, grep, ls, build output, etc.) in LLM
// request bodies before forwarding to upstream providers. Saves 20-40% input
// tokens. Fail-open: errors never break the request.
//
// Ported from /tmp/9router/open-sse/rtk/ (originally a Rust project, rtk).
// All source files (constants, autodetect, applyFilter, registry, index, and 12
// filter files) combined into this single ES module. Zero external dependencies.
// =============================================================================

// -----------------------------------------------------------------------------
// constants.js  - RTK port constants (mirror Rust defaults)
// -----------------------------------------------------------------------------

const RAW_CAP = 10 * 1024 * 1024;      // 10 MiB
const MIN_COMPRESS_SIZE = 500;          // bytes; skip tiny blobs
const DETECT_WINDOW = 1024;             // autodetect peeks first N chars
const GIT_DIFF_HUNK_MAX_LINES = 100;    // per-hunk line cap
const GIT_DIFF_CONTEXT_KEEP = 3;        // context lines around changes
const GIT_LOG_MAX_LINES = 200;          // gitLog line cap
const DEDUP_LINE_MAX = 2000;            // dedupLog truncation cap

// Rust pipe_cmd.rs parity caps
const GREP_PER_FILE_MAX = 10;           // match rust: matches.iter().take(10)
const FIND_PER_DIR_MAX = 10;            // match rust: files.iter().take(10)
const FIND_TOTAL_DIR_MAX = 20;          // match rust: dirs.iter().take(20)

// git status caps (rust config::limits())
const STATUS_MAX_FILES = 10;            // config::limits().status_max_files
const STATUS_MAX_UNTRACKED = 10;        // config::limits().status_max_untracked

// ls compact_ls (rtk/src/cmds/system/ls.rs)
const LS_EXT_SUMMARY_TOP = 5;           // top-N extensions in summary
const LS_NOISE_DIRS = [
  "node_modules", ".git", "target", "__pycache__",
  ".next", "dist", "build", ".cache", ".turbo",
  ".vercel", ".pytest_cache", ".mypy_cache", ".tox",
  ".venv", "venv",
  "env", // Python legacy virtualenv; .env (dotenv) intentionally excluded
  "coverage", ".nyc_output", ".DS_Store", "Thumbs.db",
  ".idea", ".vscode", ".vs", "*.egg-info", ".eggs"
];

// tree filter_tree_output cap (no rust cap, we add one to be safe)
const TREE_MAX_LINES = 200;

// Cursor Glob "Result of search in '...' (total N files):" list
const SEARCH_LIST_PER_DIR_MAX = 10;
const SEARCH_LIST_TOTAL_DIR_MAX = 20;

// Smart truncate (port of filter.rs smart_truncate fallback)
const SMART_TRUNCATE_HEAD = 120;        // lines kept from top
const SMART_TRUNCATE_TAIL = 60;         // lines kept from bottom
const SMART_TRUNCATE_MIN_LINES = 250;   // only kick in above this

// readNumbered (files with "  N|content" lines, e.g. Cursor read_file)
const READ_NUMBERED_MIN_HIT_RATIO = 0.7;

// Filter name strings (Rust parity + JS extras)
const FILTERS = {
  GIT_DIFF: "git-diff",
  GIT_STATUS: "git-status",
  GIT_LOG: "git-log",
  GREP: "grep",
  FIND: "find",
  LS: "ls",
  TREE: "tree",
  DEDUP_LOG: "dedup-log",
  SMART_TRUNCATE: "smart-truncate",
  READ_NUMBERED: "read-numbered",
  SEARCH_LIST: "search-list",
  BUILD_OUTPUT: "build-output"
};

// -----------------------------------------------------------------------------
// filters/gitDiff.js - Port of Rust git::compact_diff (src/cmds/git/git.rs L325-413)
// Compacts unified diff: file headers, hunk-level truncation at 100 lines,
// +/-/context counting
// -----------------------------------------------------------------------------

function gitDiff(diff, maxLines = 500) {
  const result = [];
  let currentFile = "";
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let hunkShown = 0;
  let hunkSkipped = 0;
  let wasTruncated = false;
  const maxHunkLines = GIT_DIFF_HUNK_MAX_LINES;

  const lines = diff.split("\n");

  outer: for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      if (currentFile && (added > 0 || removed > 0)) {
        result.push(`  +${added} -${removed}`);
      }
      const parts = line.split(" b/");
      currentFile = parts.length > 1 ? parts.slice(1).join(" b/") : "unknown";
      result.push(`\n${currentFile}`);
      added = 0;
      removed = 0;
      inHunk = false;
      hunkShown = 0;
    } else if (line.startsWith("@@")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      inHunk = true;
      hunkShown = 0;
      result.push(`  ${line}`);
    } else if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        added += 1;
        if (hunkShown < maxHunkLines) {
          result.push(`  ${line}`);
          hunkShown += 1;
        } else {
          hunkSkipped += 1;
        }
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removed += 1;
        if (hunkShown < maxHunkLines) {
          result.push(`  ${line}`);
          hunkShown += 1;
        } else {
          hunkSkipped += 1;
        }
      } else if (hunkShown < maxHunkLines && !line.startsWith("\\")) {
        if (hunkShown > 0) {
          result.push(`  ${line}`);
          hunkShown += 1;
        }
      }
    }

    if (result.length >= maxLines) {
      result.push("\n... (more changes truncated)");
      wasTruncated = true;
      break outer;
    }
  }

  if (hunkSkipped > 0) {
    result.push(`  ... (${hunkSkipped} lines truncated)`);
    wasTruncated = true;
  }

  if (currentFile && (added > 0 || removed > 0)) {
    result.push(`  +${added} -${removed}`);
  }

  if (wasTruncated) {
    result.push("[full diff: rtk git diff --no-compact]");
  }

  return result.join("\n");
}

gitDiff.filterName = "git-diff";

// -----------------------------------------------------------------------------
// filters/gitStatus.js - Port of git::format_status_output
// (rtk/src/cmds/git/git.rs:619-730)
// Output format:
//   * <branch>
//   + Staged: N files
//      path1
//      ... +K more
//   ~ Modified: N files
//   ? Untracked: N files
//   conflicts: N files
//   clean - nothing to commit
// -----------------------------------------------------------------------------

function gitStatus(input) {
  const lines = input.split("\n");
  if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
    return "Clean working tree";
  }

  let branch = "";
  const stagedFiles = [];
  const modifiedFiles = [];
  const untrackedFiles = [];
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const raw of lines) {
    if (!raw.trim()) continue;

    // Long-form branch detection (LLM usually sends this, not porcelain)
    const longBranch = raw.match(/^On branch (\S+)/);
    if (longBranch) { branch = longBranch[1]; continue; }

    // Porcelain branch header: "## main...origin/main"
    if (raw.startsWith("##")) { branch = raw.replace(/^##\s*/, ""); continue; }

    // Porcelain status (2 chars + space + path)
    if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const x = raw[0];
      const y = raw[1];
      const file = raw.slice(3);

      if (raw.slice(0, 2) === "??") {
        untracked++;
        untrackedFiles.push(file);
        continue;
      }

      if ("MADRC".includes(x)) {
        staged++;
        stagedFiles.push(file);
      } else if (x === "U") {
        conflicts++;
      }

      if (y === "M" || y === "D") {
        modified++;
        modifiedFiles.push(file);
      }
      continue;
    }

    // Long form fallback ("modified:   path", "new file:   path", ...)
    const longMatch = raw.match(/^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/);
    if (longMatch) {
      const kind = longMatch[1];
      const path = longMatch[2].trim();
      if (kind === "both modified") { conflicts++; }
      else if (kind === "modified" || kind === "deleted") { modified++; modifiedFiles.push(path); }
      else if (kind === "new file" || kind === "renamed") { staged++; stagedFiles.push(path); }
      continue;
    }

    // "Untracked files:" section - gather bare paths after this marker
    // Handled implicitly: plain paths without markers are skipped (safer).
  }

  let out = "";
  if (branch) out += `* ${branch}\n`;

  if (staged > 0) {
    out += `+ Staged: ${staged} files\n`;
    for (const f of stagedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}\n`;
    if (stagedFiles.length > STATUS_MAX_FILES) {
      out += `   ... +${stagedFiles.length - STATUS_MAX_FILES} more\n`;
    }
  }

  if (modified > 0) {
    out += `~ Modified: ${modified} files\n`;
    for (const f of modifiedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}\n`;
    if (modifiedFiles.length > STATUS_MAX_FILES) {
      out += `   ... +${modifiedFiles.length - STATUS_MAX_FILES} more\n`;
    }
  }

  if (untracked > 0) {
    out += `? Untracked: ${untracked} files\n`;
    for (const f of untrackedFiles.slice(0, STATUS_MAX_UNTRACKED)) out += `   ${f}\n`;
    if (untrackedFiles.length > STATUS_MAX_UNTRACKED) {
      out += `   ... +${untrackedFiles.length - STATUS_MAX_UNTRACKED} more\n`;
    }
  }

  if (conflicts > 0) {
    out += `conflicts: ${conflicts} files\n`;
  }

  if (staged === 0 && modified === 0 && untracked === 0 && conflicts === 0) {
    out += "clean - nothing to commit\n";
  }

  return out.replace(/\n+$/, "");
}

gitStatus.filterName = "git-status";

// -----------------------------------------------------------------------------
// filters/gitLog.js - JS-native git-log filter
// Compresses `git log` output: keeps commit headers, subjects, Author/Date;
// drops body padding, decoration, embedded diff lines.
// -----------------------------------------------------------------------------

function gitLog(text, maxLines = GIT_LOG_MAX_LINES) {
  if (!text) return "";

  const input = String(text);
  const lines = input.split("\n");
  const out = [];
  let skipped = 0;
  let inCommit = false;
  let subjectSeen = false;

  function pushLine(l) {
    if (out.length < maxLines) {
      out.push(l);
      return true;
    }
    skipped++;
    return false;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // commit <sha> header - starts new commit entry
    // Also matched with leading graph decoration (`*   commit abc1234...` - --graph without --oneline)
    if (/^commit [0-9a-f]{7,40}$/i.test(trimmed) || /^[*|/\\ ]+commit [0-9a-f]{7,40}/i.test(trimmed)) {
      inCommit = true;
      subjectSeen = false;
      pushLine(line);
      continue;
    }

    if (inCommit) {
      // Author / Date - keep as-is (already column 0 in raw, or graph-prefix stripped by commit-header match)
      if (/^[*|/\\ ]*(Author|Date):/i.test(trimmed)) {
        pushLine(trimmed);
        continue;
      }
      // blank - skip
      if (trimmed === "") continue;
      // indented subject (4 spaces, optionally preceded by graph decoration) - first one is subject
      if (!subjectSeen && /^[*|/\\ ]*    \S/.test(line)) {
        pushLine("  Subject: " + trimmed);
        subjectSeen = true;
        continue;
      }
      // stat summary: "N file(s) changed, N insertions(+), N deletions(-)"
      if (/^\d+ file\w* changed/.test(trimmed)) {
        pushLine("  " + trimmed);
        continue;
      }
      // embedded diff header - one-line marker
      if (/^diff --git /.test(trimmed)) {
        pushLine("  ... diff body omitted");
        continue;
      }
      // everything else in commit body - drop
      continue;
    }

    // Not in a commit block (--oneline / --graph modes):

    // Graph decoration + sha + subject: "*|/\\ <sha7> <subject>"
    const graphMatch = trimmed.match(/^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i);
    if (graphMatch) {
      pushLine(graphMatch[1]);
      continue;
    }

    // Plain oneline: "<sha7> <subject>"
    if (/^[0-9a-f]{7,40}\s+/.test(trimmed)) {
      pushLine(trimmed);
      continue;
    }

    // Pure graph decoration (no sha) - drop
    if (/^[*|/\\ ]+$/.test(trimmed) && /[*|/\\]/.test(trimmed)) {
      continue;
    }

    // catch-all pass-through
    pushLine(trimmed);
  }

  if (skipped > 0) out.push(`... (${skipped} more lines)`);

  const result = out.join("\n");
  if (!result && input) return input;
  if (result.length > input.length) return input;
  return result;
}

gitLog.filterName = "git-log";

// -----------------------------------------------------------------------------
// filters/grep.js - Port of grep_wrapper (rtk/src/cmds/system/pipe_cmd.rs:50-86)
// Input format: "file:lineno:content" - splitn(3, ':') in Rust
// -----------------------------------------------------------------------------

function grep(input) {
  const byFile = new Map();
  let total = 0;

  for (const line of input.split("\n")) {
    // splitn(3, ':') - only split on first 2 colons
    const first = line.indexOf(":");
    if (first === -1) continue;
    const second = line.indexOf(":", first + 1);
    if (second === -1) continue;
    const file = line.slice(0, first);
    const lineNumStr = line.slice(first + 1, second);
    const content = line.slice(second + 1);
    // Rust: parts[1].parse::<usize>().is_ok()
    if (!/^\d+$/.test(lineNumStr)) continue;
    total++;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push([lineNumStr, content]);
  }

  if (total === 0) return input;

  // Rust: files.sort_by_key(|(f, _)| *f)
  const files = Array.from(byFile.keys()).sort();
  let out = `${total} matches in ${files.length}F:\n\n`;

  for (const file of files) {
    const matches = byFile.get(file);
    out += `[file] ${file} (${matches.length}):\n`;
    const show = matches.slice(0, GREP_PER_FILE_MAX);
    for (const [lineNum, content] of show) {
      // Rust: format!("  {:>4}: {}", line_num, content.trim())
      out += `  ${lineNum.padStart(4)}: ${content.trim()}\n`;
    }
    if (matches.length > GREP_PER_FILE_MAX) {
      out += `  +${matches.length - GREP_PER_FILE_MAX}\n`;
    }
    out += "\n";
  }

  return out;
}

grep.filterName = "grep";

// -----------------------------------------------------------------------------
// filters/find.js - Port of find_wrapper (rtk/src/cmds/system/pipe_cmd.rs:89-128)
// Group by parent dir, show basenames, cap 10/dir and 20 dirs total
// -----------------------------------------------------------------------------

function find(input) {
  const lines = input.split("\n").filter(l => l.trim());
  if (lines.length === 0) return input;

  const byDir = new Map();

  for (const path of lines) {
    // Accept both Unix ("/a/b") and Windows ("C:\a\b") separators
    const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    let dir;
    let basename;
    if (lastSep === -1) {
      dir = ".";
      basename = path;
    } else {
      // Rust: PathBuf::from(path).parent().display() + file_name().display()
      dir = path.slice(0, lastSep) || "/";
      basename = path.slice(lastSep + 1);
    }
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(basename);
  }

  // Rust: dirs.sort_by_key(|(d, _)| d.clone())
  const dirs = Array.from(byDir.keys()).sort();
  let out = `${lines.length} files in ${dirs.length} dirs:\n\n`;

  const showDirs = dirs.slice(0, FIND_TOTAL_DIR_MAX);
  for (const dir of showDirs) {
    const files = byDir.get(dir);
    const dirLabel = dir.replace(/\\/g, "/");
    out += `${dirLabel}/  (${files.length})\n`;
    const showFiles = files.slice(0, FIND_PER_DIR_MAX);
    for (const f of showFiles) out += `  ${f}\n`;
    if (files.length > FIND_PER_DIR_MAX) {
      out += `  +${files.length - FIND_PER_DIR_MAX}\n`;
    }
  }
  if (dirs.length > FIND_TOTAL_DIR_MAX) {
    out += `\n+${dirs.length - FIND_TOTAL_DIR_MAX} more dirs\n`;
  }

  return out;
}

find.filterName = "find";

// -----------------------------------------------------------------------------
// filters/dedupLog.js - Generic fallback: collapse consecutive duplicate lines +
// blank-line dedupe + hard line cap
// -----------------------------------------------------------------------------

function dedupLog(input) {
  const lines = input.split("\n");
  const out = [];
  let prev = null;
  let runCount = 0;
  let blankStreak = 0;

  const flushRun = () => {
    if (prev !== null && runCount > 1) {
      out.push(`  ... (${runCount - 1} duplicate lines)`);
    }
  };

  for (const line of lines) {
    if (line.trim() === "") {
      if (blankStreak < 1) out.push(line);
      blankStreak += 1;
      flushRun();
      prev = null;
      runCount = 0;
      continue;
    }
    blankStreak = 0;
    if (line === prev) {
      runCount += 1;
      continue;
    }
    flushRun();
    out.push(line);
    prev = line;
    runCount = 1;
    if (out.length >= DEDUP_LINE_MAX) {
      out.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`);
      return out.join("\n");
    }
  }
  flushRun();
  return out.join("\n");
}

dedupLog.filterName = "dedup-log";

// -----------------------------------------------------------------------------
// filters/ls.js - Port of compact_ls (rtk/src/cmds/system/ls.rs:154-232)
// Input: `ls -la` style output. Output: compact "name/  (dirs)\nname  size"
// -----------------------------------------------------------------------------

// Rust LS_DATE_RE: month + day + (year|HH:MM)
const LS_DATE_RE = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;

function humanSize(bytes) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

function parseLsLine(line) {
  const m = LS_DATE_RE.exec(line);
  if (!m) return null;
  const name = line.slice(m.index + m[0].length);
  const beforeDate = line.slice(0, m.index);
  const beforeParts = beforeDate.split(/\s+/).filter(Boolean);
  if (beforeParts.length < 4) return null;

  const perms = beforeParts[0];
  const fileType = perms.charAt(0);

  // size = rightmost parseable number before the date
  let size = 0;
  for (let i = beforeParts.length - 1; i >= 0; i--) {
    const n = Number(beforeParts[i]);
    if (Number.isInteger(n) && String(n) === beforeParts[i]) { size = n; break; }
  }
  return { fileType, size, name };
}

function ls(input) {
  const dirs = [];
  const files = [];      // [name, sizeStr]
  const byExt = new Map();

  for (const line of input.split("\n")) {
    if (line.startsWith("total ") || line.length === 0) continue;
    const parsed = parseLsLine(line);
    if (!parsed) continue;
    if (parsed.name === "." || parsed.name === "..") continue;

    // Rust ls.rs: show_all flag respected - for LLM context always skip noise
    if (LS_NOISE_DIRS.includes(parsed.name)) continue;

    if (parsed.fileType === "d") {
      dirs.push(parsed.name);
    } else if (parsed.fileType === "-" || parsed.fileType === "l") {
      const dot = parsed.name.lastIndexOf(".");
      const ext = dot > 0 ? parsed.name.slice(dot) : "no ext";
      byExt.set(ext, (byExt.get(ext) || 0) + 1);
      files.push([parsed.name, humanSize(parsed.size)]);
    }
  }

  if (dirs.length === 0 && files.length === 0) return input;

  let out = "";
  for (const d of dirs) out += `${d}/\n`;
  for (const [name, size] of files) out += `${name}  ${size}\n`;

  // Summary line (Rust port)
  let summary = `\nSummary: ${files.length} files, ${dirs.length} dirs`;
  if (byExt.size > 0) {
    const ext = Array.from(byExt.entries()).sort((a, b) => b[1] - a[1]);
    const parts = ext.slice(0, LS_EXT_SUMMARY_TOP).map(([e, c]) => `${c} ${e}`);
    summary += ` (${parts.join(", ")}`;
    if (ext.length > LS_EXT_SUMMARY_TOP) {
      summary += `, +${ext.length - LS_EXT_SUMMARY_TOP} more`;
    }
    summary += ")";
  }

  return out + summary;
}

ls.filterName = "ls";

// -----------------------------------------------------------------------------
// filters/tree.js - Port of filter_tree_output (rtk/src/cmds/system/tree.rs:65-94)
// Removes summary line (e.g. "5 directories, 23 files") and trailing blanks.
// -----------------------------------------------------------------------------

function tree(input) {
  const lines = input.split("\n");
  if (lines.length === 0) return input;

  const filtered = [];
  for (const line of lines) {
    // Drop "X directories, Y files" summary
    if (line.includes("director") && line.includes("file")) continue;
    // Drop leading blanks
    if (line.trim() === "" && filtered.length === 0) continue;
    filtered.push(line);
  }

  // Drop trailing blanks
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop();
  }

  // Cap overly long trees (JS-only safeguard; Rust has no cap)
  if (filtered.length > TREE_MAX_LINES) {
    const cut = filtered.length - TREE_MAX_LINES;
    return filtered.slice(0, TREE_MAX_LINES).join("\n") + `\n... +${cut} more lines`;
  }

  return filtered.join("\n");
}

tree.filterName = "tree";

// -----------------------------------------------------------------------------
// filters/smartTruncate.js - Port concept of filter::smart_truncate
// (rtk/src/core/filter.rs). Keep HEAD + TAIL lines, replace middle with
// "... +N lines truncated".
// -----------------------------------------------------------------------------

function smartTruncate(input) {
  const lines = input.split("\n");
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;

  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [...head, `... +${cut} lines truncated`, ...tail].join("\n");
}

smartTruncate.filterName = "smart-truncate";

// -----------------------------------------------------------------------------
// filters/readNumbered.js - Handles Cursor/Codex read_file output:
// "  1|content\n  2|content".
// Strategy mirrors Rust filter::smart_truncate (filter.rs): keep head+tail,
// drop middle.
// -----------------------------------------------------------------------------

const READ_NUMBERED_LINE_RE = /^\s*\d+\|/;

function readNumbered(input) {
  const lines = input.split("\n");
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;

  // Count how many lines match "N|content" to verify shape (hit ratio check
  // already done by autodetect; here we just truncate).
  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;

  return [
    ...head,
    `... +${cut} lines truncated (file continues)`,
    ...tail
  ].join("\n");
}

readNumbered.filterName = "read-numbered";

// -----------------------------------------------------------------------------
// filters/searchList.js - Compact "Result of search in '...' (total N files):
// \n- path\n- path" output (Cursor Glob tool). Groups by parent dir like find,
// shows basenames.
// -----------------------------------------------------------------------------

const SEARCH_LIST_HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/;

function searchList(input) {
  const lines = input.split("\n");
  if (lines.length === 0) return input;

  // First line must be the header (validated by autodetect too)
  const header = lines[0] || "";
  const rest = lines.slice(1);

  const paths = [];
  for (const raw of rest) {
    const t = raw.trim();
    if (!t.startsWith("- ")) continue;
    paths.push(t.slice(2));
  }
  if (paths.length === 0) return input;

  const byDir = new Map();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const dir = slash === -1 ? "." : (p.slice(0, slash) || "/");
    const name = slash === -1 ? p : p.slice(slash + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(name);
  }

  const dirs = Array.from(byDir.keys()).sort();
  let out = `${header}\n${paths.length} files in ${dirs.length} dirs:\n\n`;

  for (const dir of dirs.slice(0, SEARCH_LIST_TOTAL_DIR_MAX)) {
    const names = byDir.get(dir);
    out += `${dir}/ (${names.length}):\n`;
    for (const n of names.slice(0, SEARCH_LIST_PER_DIR_MAX)) out += `  ${n}\n`;
    if (names.length > SEARCH_LIST_PER_DIR_MAX) {
      out += `  +${names.length - SEARCH_LIST_PER_DIR_MAX}\n`;
    }
    out += "\n";
  }
  if (dirs.length > SEARCH_LIST_TOTAL_DIR_MAX) {
    out += `+${dirs.length - SEARCH_LIST_TOTAL_DIR_MAX} more dirs\n`;
  }

  return out.replace(/\n+$/, "");
}

searchList.filterName = "search-list";

// -----------------------------------------------------------------------------
// filters/buildOutput.js - Compress build tool output (npm, cargo, pip, maven,
// gradle, etc.)
// Keeps: errors, warnings, final summary
// Strips: progress logs, verbose "Compiling X" lists, download logs
// -----------------------------------------------------------------------------

// Cargo/rustc error continuation: " --> file:line", "  |", "N | code", "  = note: ..."
const RE_CARGO_ERR_CONT = /^\s*(-->|\||\d+\s*\||=)/;
const DEPRECATION_KEEP = 3;

function buildOutput(input) {
  const lines = input.split("\n");
  if (lines.length === 0) return input;

  const errors = [];
  const warnings = [];
  const deprecations = [];
  let summary = null;
  let compilingCount = 0;
  let downloadingCount = 0;
  let inCargoError = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Continuation of cargo error block: keep verbatim while in block
    if (inCargoError) {
      if (!trimmed) { inCargoError = false; continue; }
      if (RE_CARGO_ERR_CONT.test(line)) { errors.push(line); continue; }
      inCargoError = false;
    }

    if (!trimmed) continue;

    if (/^npm (ERR!|error)/i.test(trimmed) || /^yarn error/i.test(trimmed)) {
      errors.push(line);
      continue;
    }

    if (/^npm warn deprecated/i.test(trimmed)) {
      deprecations.push(line);
      continue;
    }
    if (/^npm warn/i.test(trimmed) || /^yarn warn/i.test(trimmed)) {
      warnings.push(line);
      continue;
    }

    if (/^error(\[|:)/i.test(trimmed) || trimmed.startsWith("error -->")) {
      errors.push(line);
      inCargoError = true;
      continue;
    }

    if (/^warning(\[|:)/i.test(trimmed) || trimmed.startsWith("warning -->")) {
      warnings.push(line);
      inCargoError = true;
      continue;
    }

    if (/^ERROR:/i.test(trimmed)) {
      errors.push(line);
      continue;
    }

    if (/^\[ERROR\]/i.test(trimmed) || /^BUILD FAILED/i.test(trimmed)) {
      errors.push(line);
      continue;
    }

    if (/^\[WARNING\]/i.test(trimmed)) {
      warnings.push(line);
      continue;
    }

    if (/^\s*Compiling\s+\S+/i.test(trimmed)) {
      compilingCount++;
      continue;
    }
    if (/^\s*Downloading\s+\S+/i.test(trimmed) || /^Fetching\s+/i.test(trimmed)) {
      downloadingCount++;
      continue;
    }

    if (
      /^(added|removed|changed|audited|installed)\s+\d+\s+package/i.test(trimmed) ||
      /^\s*Finished\s+/i.test(trimmed) ||
      /^BUILD SUCCESS/i.test(trimmed) ||
      /^\d+\s+(vulnerabilities|packages?|warnings?|errors?)/i.test(trimmed) ||
      /^Successfully (installed|built)/i.test(trimmed) ||
      /^To address .* issues/i.test(trimmed) ||
      /^Run `npm (audit|fund)`/i.test(trimmed) ||
      /packages are looking for funding/i.test(trimmed)
    ) {
      summary = summary ? `${summary}\n${line}` : line;
      continue;
    }
  }

  let out = "";

  // Keep first N deprecations verbatim (package name + reason), count the rest
  const keepDep = deprecations.slice(0, DEPRECATION_KEEP);
  for (const d of keepDep) out += `${d}\n`;
  if (deprecations.length > DEPRECATION_KEEP) {
    out += `... +${deprecations.length - DEPRECATION_KEEP} more deprecated packages\n`;
  }

  if (compilingCount > 0) {
    out += `Compiled ${compilingCount} packages\n`;
  }
  if (downloadingCount > 0) {
    out += `Downloaded ${downloadingCount} packages\n`;
  }

  for (const e of errors) out += `${e}\n`;

  const keepWarnings = warnings.slice(0, 5);
  for (const w of keepWarnings) out += `${w}\n`;
  if (warnings.length > 5) {
    out += `... +${warnings.length - 5} more warnings\n`;
  }

  if (summary) out += `${summary}\n`;

  return out.replace(/\n+$/, "") || input;
}

buildOutput.filterName = "build-output";

// -----------------------------------------------------------------------------
// applyFilter.js - Port of apply_filter (rtk/src/cmds/system/pipe_cmd.rs) -
// catch_unwind equivalent
// On panic/error: passthrough raw output + warn to stderr
// -----------------------------------------------------------------------------

function safeApply(fn, text) {
  if (typeof fn !== "function") return text;
  try {
    const out = fn(text);
    if (typeof out !== "string") return text;
    return out;
  } catch (err) {
    // Rust: eprintln!("[rtk] warning: filter panicked - passing through raw output")
    const name = fn.filterName || fn.name || "anonymous";
    console.warn(`[rtk] warning: filter '${name}' panicked - passing through raw output: ${err?.message || err}`);
    return text;
  }
}

// -----------------------------------------------------------------------------
// autodetect.js - Port of auto_detect_filter
// (rtk/src/cmds/system/pipe_cmd.rs:132-188) + JS extras
// Detection order: git-log -> git-diff -> git-status -> build-output -> grep
//                  -> find -> tree -> ls -> search-list -> read-numbered
//                  -> dedup-log -> smart-truncate -> null
// -----------------------------------------------------------------------------

const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_DIFF_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_BUILD_OUTPUT = /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
const RE_TREE_GLYPH = /[├└]──|│  /;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL = /^total \d+$/m;

function autoDetectFilter(text) {
  // Rust: floor_char_boundary to avoid UTF-8 split - JS .slice() by char is safe
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;

  if (RE_GIT_LOG.test(head)) return gitLog;
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) return gitDiff;
  if (RE_GIT_STATUS.test(head)) return gitStatus;

  // Build output BEFORE porcelain check: prevents cargo "Compiling" misdetection as git-status
  if (RE_BUILD_OUTPUT.test(head)) return buildOutput;

  if (isMostlyPorcelain(head)) return gitStatus;

  const lines = head.split("\n");
  const nonEmpty = lines.filter(l => l.trim().length > 0);

  // Rust grep rule: first 5 non-empty lines, ANY matches "file:number:content"
  const first5 = nonEmpty.slice(0, 5);
  if (first5.some(isGrepLine)) return grep;

  // Rust find rule: ALL non-empty lines path-like (no ':'), >=3 lines
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return find;

  // Tree: contains box-drawing glyphs typical of `tree` command
  if (RE_TREE_GLYPH.test(head)) return tree;

  // ls -la: has "total N" header or >=3 rows starting with perms string
  if (RE_LS_TOTAL.test(head) || countMatches(head, RE_LS_ROW) >= 3) return ls;

  // Cursor Glob search list header
  if (SEARCH_LIST_HEADER_RE.test(head)) return searchList;

  // Line-numbered file dump ("  N|content") - fire only if many lines match
  if (lines.length >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(lines)) {
    return readNumbered;
  }

  // Fallback: dedupLog for generic multi-line noise with duplicates
  if (nonEmpty.length >= 5) return dedupLog;

  // Last resort: big blob with no structure - smart truncate
  if (text.split("\n").length >= SMART_TRUNCATE_MIN_LINES) return smartTruncate;

  return null;
}

function isGrepLine(line) {
  // Rust: splitn(3, ':') -> parts.len()==3 && parts[1].parse::<usize>().is_ok()
  const first = line.indexOf(":");
  if (first === -1) return false;
  const second = line.indexOf(":", first + 1);
  if (second === -1) return false;
  const lineno = line.slice(first + 1, second);
  return /^\d+$/.test(lineno);
}

function isPathLike(line) {
  const t = line.trim();
  if (t.length === 0) return false;
  // A drive-letter prefix (e.g. "C:\Users\me" or "C:/Users/me") marks a
  // Windows absolute path, so treat the whole line as path-like. Trailing
  // colons (e.g. "C:\path\file.js:10") are tolerated, matching grep-style
  // suffixes on Windows dumps.
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.includes(":")) return false;
  return t.startsWith(".") || t.startsWith("/") || t.includes("/");
}

function isMostlyPorcelain(head) {
  const lines = head.split("\n").filter(l => l.trim());
  if (lines.length < 3) return false;
  const hits = lines.filter(l => RE_PORCELAIN.test(l)).length;
  return hits / lines.length >= 0.6;
}

function isLineNumbered(lines) {
  let hits = 0;
  let nonEmpty = 0;
  const sample = lines.slice(0, 100);
  for (const l of sample) {
    if (l.length === 0) continue;
    nonEmpty++;
    if (READ_NUMBERED_LINE_RE.test(l)) hits++;
  }
  if (nonEmpty < 5) return false;
  return hits / nonEmpty >= READ_NUMBERED_MIN_HIT_RATIO;
}

function countMatches(text, re) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (text.match(g) || []).length;
}

// -----------------------------------------------------------------------------
// registry.js - named filter lookup
// -----------------------------------------------------------------------------

const REGISTRY = {
  [FILTERS.GIT_DIFF]: gitDiff,
  [FILTERS.GIT_STATUS]: gitStatus,
  [FILTERS.GIT_LOG]: gitLog,
  [FILTERS.GREP]: grep,
  [FILTERS.FIND]: find,
  [FILTERS.DEDUP_LOG]: dedupLog,
  [FILTERS.LS]: ls,
  [FILTERS.TREE]: tree,
  [FILTERS.SMART_TRUNCATE]: smartTruncate,
  [FILTERS.READ_NUMBERED]: readNumbered,
  [FILTERS.SEARCH_LIST]: searchList
};

// Rust resolve_filter aliases (pipe_cmd.rs): grep|rg, find|fd
const ALIASES = {
  rg: grep,
  fd: find
};

function resolveFilter(name) {
  return REGISTRY[name] || ALIASES[name] || null;
}

function allFilters() {
  return REGISTRY;
}

// -----------------------------------------------------------------------------
// index.js - entry point
// RTK port: compress tool_result content in LLM request bodies
// Injected at the top of translateRequest (before any format translation)
// -----------------------------------------------------------------------------

// Compress tool_result content in-place. Returns stats or null if disabled/failed.
export function compressMessages(body, enabled) {
  if (!enabled) return null;
  if (!body) return null;

  // Kiro format: conversationState.history + conversationState.currentMessage
  if (body.conversationState) {
    return compressKiroFormat(body, enabled);
  }

  // Support both OpenAI/Claude "messages" and OpenAI Responses "input"
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!items) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      if (!msg) continue;

      // Shape 4: OpenAI Responses - top-level { type:"function_call_output", output: string | [{type:"input_text", text}] }
      if (msg.type === "function_call_output") {
        if (typeof msg.output === "string") {
          msg.output = compressText(msg.output, stats, "openai-responses-string");
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && part.type === "input_text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "openai-responses-array");
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message - { role:"tool", content: "string" }
      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = compressText(msg.content, stats, "openai-tool");
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Shape 1b: OpenAI tool message - { role:"tool", content:[{type:"text", text:"..."}] }
      if (msg.role === "tool") {
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "openai-tool-array");
          }
        }
        continue;
      }

      // Shape 2/3: blocks array with tool_result entries
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block || block.type !== "tool_result") continue;
        if (block.is_error === true) continue; // preserve error traces

        if (typeof block.content === "string") {
          // Shape 2: claude string form
          block.content = compressText(block.content, stats, "claude-string");
        } else if (Array.isArray(block.content)) {
          // Shape 3: claude array form - compress each text part
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "claude-array");
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressMessages error:", e.message);
    return null;
  }
  return stats;
}

// Compress Kiro format: conversationState.history[].userInputMessage.userInputMessageContext.toolResults[].content[].text
function compressKiroFormat(body, enabled) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    const state = body.conversationState;
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])];
    if (state?.currentMessage) allMessages.push(state.currentMessage);

    for (const msg of allMessages) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (tr.status === "error") continue; // preserve error traces
        if (!Array.isArray(tr.content)) continue;

        for (const part of tr.content) {
          if (part && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "kiro-tool-result");
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressKiroFormat error:", e.message);
    return null;
  }
  return stats;
}

function compressText(text, stats, shape) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const fn = autoDetectFilter(text);
  if (!fn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const out = safeApply(fn, text);

  // Safety: never return empty, never grow the input
  if (!out || out.length === 0 || out.length >= bytesIn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  stats.bytesAfter += out.length;
  stats.hits.push({ shape, filter: fn.filterName || fn.name, saved: bytesIn - out.length });
  return out;
}

// Convenience: format a log line from stats
export function formatRtkLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
