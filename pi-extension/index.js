import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_STORE_DIR = path.join(homedir(), ".pi", "agent", "pi-desk");
export const MAX_CONTEXT_BYTES = 100_000;

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".venv",
  "venv",
  "out",
  "target",
]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".json", ".yaml", ".yml", ".toml"]);
const SECRET_NAME = /(^|[._-])(env|secret|secrets|credential|credentials|token|tokens|private[_-]?key|api[_-]?key)([._-]|$)/i;
const SECRET_CONTENT = /("type"\s*:\s*"service_account"|["']?(api[_-]?key|token|password|secret|secret[_-]?key|client[_-]?secret|private[_-]?key|private[_-]?key_id)["']?\s*[:=]|AWS_SECRET_ACCESS_KEY|BEGIN [A-Z ]*PRIVATE KEY)/i;
const CONTEXT_CHARS_PER_FILE = 30_000;
const CONTEXT_CHARS_TOTAL = 80_000;

export function parseTodoCommand(args = "") {
  const text = String(args ?? "").trim();
  if (!text) return { type: "list" };

  if (/^sort$/i.test(text)) return { type: "sort" };
  if (/^all$/i.test(text)) return { type: "all" };
  if (/^setup$/i.test(text)) return { type: "setup" };
  if (/^clear$/i.test(text)) return { type: "clear" };

  let match = text.match(/^edit\s+(\d+)(?:\s+([\s\S]+))?$/i);
  if (match) return { type: "edit", id: Number(match[1]), text: String(match[2] ?? "").trim() };
  if (/^edit\b/i.test(text)) return { type: "invalid", error: "Usage: /todo edit <id> [text]" };

  match = text.match(/^done\s+(\d+)$/i);
  if (match) return { type: "done", id: Number(match[1]) };
  if (/^done\b/i.test(text)) return { type: "invalid", error: "Usage: /todo done <id>" };

  match = text.match(/^move\s+(\d+)\s+(\d+)$/i);
  if (match) return { type: "move", id: Number(match[1]), rank: Number(match[2]) };
  if (/^move\b/i.test(text)) return { type: "invalid", error: "Usage: /todo move <id> <rank>" };

  return { type: "add", text };
}

export function findProjectRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  try {
    if (!statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    return dir;
  }

  const fallback = dir;
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}

export function projectHash(projectRoot) {
  return crypto.createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 16);
}

export function projectFileFor(projectRoot, baseDir = DEFAULT_STORE_DIR) {
  return path.join(baseDir, "projects", `${projectHash(projectRoot)}.json`);
}

function emptyProject(projectRoot) {
  return {
    version: 1,
    id: projectHash(projectRoot),
    projectRoot: path.resolve(projectRoot),
    setupComplete: false,
    contextFiles: [],
    nextId: 1,
    items: [],
  };
}

function normalizeProject(raw, projectRoot, options = {}) {
  const project = emptyProject(projectRoot);
  if (!raw || typeof raw !== "object") return project;

  project.setupComplete = raw.setupComplete === true;
  project.contextFiles = options.skipContextFiles
    ? []
    : Array.isArray(raw.contextFiles)
      ? sanitizeContextFiles(project.projectRoot, raw.contextFiles)
      : [];
  project.nextId = Number.isInteger(raw.nextId) && raw.nextId > 0 ? raw.nextId : 1;
  project.items = Array.isArray(raw.items)
    ? raw.items
        .filter((item) => Number.isInteger(item?.id) && typeof item?.text === "string" && item.text.trim())
        .map((item) => ({
          id: item.id,
          text: item.text.trim(),
          reason: typeof item.reason === "string" ? item.reason.trim() : "",
          ...(Number.isInteger(item.manualRank) && item.manualRank > 0 ? { manualRank: item.manualRank } : {}),
        }))
    : [];

  const maxId = project.items.reduce((max, item) => Math.max(max, item.id), 0);
  project.nextId = Math.max(project.nextId, maxId + 1);
  return project;
}

export function loadProject(cwd = process.cwd(), baseDir = DEFAULT_STORE_DIR) {
  const projectRoot = findProjectRoot(cwd);
  const file = projectFileFor(projectRoot, baseDir);
  if (!existsSync(file)) return emptyProject(projectRoot);
  ensurePrivateDir(baseDir);
  ensurePrivateDir(path.dirname(file));
  if (!lstatSync(file).isFile()) return emptyProject(projectRoot);
  chmodSync(file, 0o600);
  return normalizeProject(JSON.parse(readFileSync(file, "utf8")), projectRoot);
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe store directory: ${dir}`);
  chmodSync(dir, 0o700);
}

export function loadAllProjects(baseDir = DEFAULT_STORE_DIR) {
  const dir = path.join(baseDir, "projects");
  if (!existsSync(dir)) return [];
  ensurePrivateDir(baseDir);
  ensurePrivateDir(dir);

  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        const fullPath = path.join(dir, file);
        if (!lstatSync(fullPath).isFile()) return null;
        chmodSync(fullPath, 0o600);
        const raw = JSON.parse(readFileSync(fullPath, "utf8"));
        return raw?.projectRoot ? normalizeProject(raw, raw.projectRoot, { skipContextFiles: true }) : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));
}

export function saveProject(project, baseDir = DEFAULT_STORE_DIR) {
  const dir = path.join(baseDir, "projects");
  ensurePrivateDir(baseDir);
  ensurePrivateDir(dir);
  const file = path.join(dir, `${project.id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(project, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return file;
}

function clearReasons(project) {
  for (const item of project.items) item.reason = "";
}

export function addItem(project, text) {
  const clean = String(text ?? "").trim();
  if (!clean) return undefined;
  const item = { id: project.nextId, text: clean, reason: "" };
  project.nextId += 1;
  project.items.push(item);
  return item;
}

export function doneItem(project, id) {
  const index = project.items.findIndex((item) => item.id === id);
  if (index === -1) return false;
  project.items.splice(index, 1);
  clearReasons(project);
  return true;
}

export function editItem(project, id, text) {
  const item = project.items.find((entry) => entry.id === id);
  const clean = String(text ?? "").trim();
  if (!item || !clean) return false;
  item.text = clean;
  delete item.manualRank;
  clearReasons(project);
  return true;
}

export function clearItems(project) {
  const count = project.items.length;
  project.items = [];
  return count;
}

export function moveItem(project, id, rank) {
  const index = project.items.findIndex((item) => item.id === id);
  if (index === -1) return false;
  const [item] = project.items.splice(index, 1);
  const target = Math.max(1, Math.min(Math.trunc(rank), project.items.length + 1));
  item.manualRank = target;
  project.items.splice(target - 1, 0, item);
  clearReasons(project);
  return true;
}

export function applyRanking(project, rankedItems) {
  if (!Array.isArray(rankedItems) || rankedItems.length !== project.items.length) return false;

  const byId = new Map(project.items.map((item) => [item.id, item]));
  const rankedIds = [];
  const reasons = new Map();
  const seen = new Set();

  for (const ranked of rankedItems) {
    const id = Number(ranked?.id);
    if (!Number.isInteger(id) || !byId.has(id) || seen.has(id)) return false;
    seen.add(id);
    rankedIds.push(id);

    const reason = typeof ranked.reason === "string" ? ranked.reason.replace(/\s+/g, " ").trim() : "";
    if (reason) reasons.set(id, reason.slice(0, 180));
  }

  const ordered = rankedIds.map((id) => byId.get(id));
  const manualIds = new Set(project.items.filter((item) => Number.isInteger(item.manualRank)).map((item) => item.id));
  const final = Array(project.items.length).fill(null);

  const place = (item, wantedIndex = 0) => {
    for (let i = Math.max(0, wantedIndex); i < final.length; i += 1) {
      if (!final[i]) {
        final[i] = item;
        return;
      }
    }
    for (let i = Math.min(final.length - 1, wantedIndex); i >= 0; i -= 1) {
      if (!final[i]) {
        final[i] = item;
        return;
      }
    }
  };

  for (const item of project.items
    .filter((entry) => Number.isInteger(entry.manualRank))
    .sort((a, b) => a.manualRank - b.manualRank)) {
    place(item, Math.max(0, Math.min(item.manualRank - 1, final.length - 1)));
  }
  for (const item of ordered) {
    if (!manualIds.has(item.id)) place(item, 0);
  }

  project.items = final.filter(Boolean);
  for (const item of project.items) {
    item.reason = reasons.get(item.id) || "";
  }
  return true;
}

export function renderList(project) {
  if (!project.items.length) return "Keine offenen Inbox-Einträge.";
  return project.items
    .map((item, index) => {
      const reason = item.reason ? ` — ${item.reason}` : "";
      return `${index + 1}. #${item.id} ${item.text}${reason}`;
    })
    .join("\n");
}

export function renderAllProjects(projects) {
  const active = projects.filter((project) => project.items.length);
  if (!active.length) return "Keine offenen Inbox-Einträge in gespeicherten Projekten.";

  return active
    .map((project) => {
      const title = path.basename(project.projectRoot) || project.projectRoot;
      return [`${title} — ${project.projectRoot}`, renderList(project)].join("\n");
    })
    .join("\n\n");
}

export function toProjectRelative(projectRoot, candidate) {
  const raw = String(candidate ?? "").trim();
  if (!raw) return undefined;
  const relative = path.isAbsolute(raw) ? path.relative(projectRoot, raw) : raw;
  const normalized = path.normalize(relative).replaceAll("\\", "/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized;
}

function hasUnsafeContextPart(relative) {
  return relative.split("/").some((part) => IGNORE_DIRS.has(part) || SECRET_NAME.test(part));
}

export function isSafeContextFile(projectRoot, candidate) {
  const relative = toProjectRelative(projectRoot, candidate);
  if (!relative) return false;

  if (hasUnsafeContextPart(relative)) return false;
  if (!DOC_EXTENSIONS.has(path.extname(relative).toLowerCase())) return false;

  const fullPath = path.join(projectRoot, relative);
  let content;
  try {
    const linkStat = lstatSync(fullPath);
    if (linkStat.isSymbolicLink()) return false;

    const rootReal = realpathSync(projectRoot);
    const fileReal = realpathSync(fullPath);
    const realRelative = path.relative(rootReal, fileReal).replaceAll("\\", "/");
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return false;
    if (hasUnsafeContextPart(realRelative)) return false;

    const stat = statSync(fullPath);
    if (!stat.isFile() || stat.size > MAX_CONTEXT_BYTES) return false;
    content = readFileSync(fullPath);
  } catch {
    return false;
  }

  if (content.includes(0)) return false;
  return !SECRET_CONTENT.test(content.toString("utf8"));
}

export function sanitizeContextFiles(projectRoot, files) {
  const seen = new Set();
  const selected = [];
  for (const file of files) {
    const relative = toProjectRelative(projectRoot, file);
    if (!relative || seen.has(relative) || !isSafeContextFile(projectRoot, relative)) continue;
    seen.add(relative);
    selected.push(relative);
  }
  return selected;
}

function contextScore(relative) {
  const base = path.basename(relative).toLowerCase();
  if (base === "context.md") return 0;
  if (base === "plan.md") return 1;
  if (base === "readme.md") return 2;
  if (base === "agents.md" || base === "claude.md") return 3;
  if (base === "todo.md") return 4;
  return relative.startsWith("docs/") ? 10 : 20;
}

export function suggestContextFiles(projectRoot, max = 5) {
  const suggestions = [];
  const seen = new Set();
  const add = (relative) => {
    const clean = toProjectRelative(projectRoot, relative);
    if (!clean || seen.has(clean) || !isSafeContextFile(projectRoot, clean)) return;
    seen.add(clean);
    suggestions.push({ path: clean, score: contextScore(clean) });
  };

  try {
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (entry.isFile()) add(entry.name);
    }
  } catch {
    return [];
  }

  const walkDocs = (dir, depth = 0) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(path.join(projectRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walkDocs(relative, depth + 1);
      } else if (entry.isFile()) {
        add(relative);
      }
    }
  };

  for (const dir of ["docs", "doc"]) walkDocs(dir);

  return suggestions
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .slice(0, max)
    .map((entry) => entry.path);
}

export function readContextFiles(project) {
  const result = [];
  let remaining = CONTEXT_CHARS_TOTAL;
  for (const relative of project.contextFiles) {
    if (remaining <= 0 || !isSafeContextFile(project.projectRoot, relative)) continue;
    const fullPath = path.join(project.projectRoot, relative);
    const text = readFileSync(fullPath, "utf8").slice(0, Math.min(CONTEXT_CHARS_PER_FILE, remaining));
    remaining -= text.length;
    result.push({ path: relative, text });
  }
  return result;
}

function loadedContextFiles(ctx, projectRoot, usedChars = 0) {
  const options = ctx?.getSystemPromptOptions?.();
  const files = Array.isArray(options?.contextFiles) ? options.contextFiles : [];
  const result = [];
  let remaining = Math.max(0, CONTEXT_CHARS_TOTAL - usedChars);

  for (const file of files) {
    if (remaining <= 0) break;
    const relative = toProjectRelative(projectRoot, file?.path);
    const text = file?.content;
    if (!relative || !isSafeContextFile(projectRoot, relative)) continue;
    if (typeof text !== "string" || !text || text.includes("\0") || SECRET_CONTENT.test(text)) continue;
    const clipped = text.slice(0, Math.min(CONTEXT_CHARS_PER_FILE, remaining));
    remaining -= clipped.length;
    result.push({ path: relative, text: clipped });
  }

  return result;
}

function collectContextFiles(ctx, project) {
  const selected = readContextFiles(project);
  const used = selected.reduce((sum, file) => sum + file.text.length, 0);
  const seen = new Set(selected.map((file) => file.path));
  const loaded = loadedContextFiles(ctx, project.projectRoot, used).filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
  return [...selected, ...loaded];
}

function buildSortAgentPrompt(project, contextFiles) {
  const inbox = project.items.map((item) => ({
    id: item.id,
    text: item.text,
    manualRank: Number.isInteger(item.manualRank) ? item.manualRank : null,
  }));
  const context = contextFiles.map((file) => `# ${file.path}\n${file.text}`).join("\n\n---\n\n") || "(kein gespeicherter Kontext)";

  return `Sortiere die Pi-Desk-Inbox für ${project.projectRoot}.\n\nArbeite read-only. Nutze piDeskContext, wenn du weiteren sicheren Projektkontext listen oder lesen musst.\nWenn nach der Kontextsicht fachliche Fragen offen bleiben, nutze askUserQuestions mit kurzen offenen Fragen.\nWenn du genug weißt, rufe piDeskApplySort genau einmal mit allen offenen IDs in finaler Reihenfolge auf.\nRespektiere manualRank exakt. Gründe kurz in der Sprache der Inbox-Einträge.\n\nBekannter Kontext:\n${context}\n\nInbox:\n${JSON.stringify(inbox, null, 2)}`;
}

function emit(ctx, text, level = "info") {
  ctx?.ui?.notify?.(text, level);
  return text;
}

async function startSortAgent(pi, ctx, project) {
  if (!pi?.sendUserMessage || !pi?.prepareSortTools) {
    emit(ctx, "Sort-Agent nicht verfügbar; bestehende Reihenfolge beibehalten.", "warning");
    return false;
  }

  let contextFiles = [];
  try {
    contextFiles = collectContextFiles(ctx, project);
  } catch {
    contextFiles = readContextFiles(project);
  }

  let restoreSortTools;
  try {
    restoreSortTools = pi.prepareSortTools();
    if (!restoreSortTools) throw new Error("sort tool allowlist unavailable");
    const prompt = buildSortAgentPrompt(project, contextFiles);
    if (ctx?.isIdle?.() === false) pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    else pi.sendUserMessage(prompt);
    return true;
  } catch {
    restoreSortTools?.();
    emit(ctx, "Sort-Agent nicht verfügbar; bestehende Reihenfolge beibehalten.", "warning");
    return false;
  }
}

async function setupContext(ctx, project) {
  const suggestions = suggestContextFiles(project.projectRoot);
  let selected = suggestions;

  if (ctx?.hasUI) {
    const summary = suggestions.length ? suggestions.join("\n") : "Keine sicheren Kontextdateien gefunden.";
    const choice = await ctx.ui.select?.("Pi Desk context", ["Vorschläge nutzen", "Keine Kontextdateien", "Auswahl bearbeiten"]);

    if (choice === "Keine Kontextdateien" || !choice) {
      selected = [];
    } else if (choice === "Auswahl bearbeiten") {
      const edited = await ctx.ui.editor?.("Eine Kontextdatei pro Zeile", summary === "Keine sicheren Kontextdateien gefunden." ? "" : summary);
      selected = String(edited ?? "")
        .split(/\r?\n|,/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
  } else {
    selected = [];
  }

  project.contextFiles = sanitizeContextFiles(project.projectRoot, selected).slice(0, 5);
  project.setupComplete = true;
  return project.contextFiles;
}

const CONTEXT_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "read"] },
    path: { type: "string" },
  },
  required: ["action"],
  additionalProperties: false,
};

const ASK_USER_QUESTIONS_PARAMETERS = {
  type: "object",
  properties: {
    questions: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
  },
  required: ["questions"],
  additionalProperties: false,
};

const APPLY_SORT_PARAMETERS = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

export async function handleTodoCommand(args, ctx, pi, options = {}) {
  const baseDir = options.baseDir || DEFAULT_STORE_DIR;
  const cwd = options.cwd || ctx?.cwd || process.cwd();
  const command = parseTodoCommand(args);

  if (command.type === "all") {
    const project = emptyProject(findProjectRoot(cwd));
    return { ok: true, command, project, message: emit(ctx, renderAllProjects(loadAllProjects(baseDir))) };
  }

  const project = loadProject(cwd, baseDir);

  if (command.type === "invalid") {
    return { ok: false, command, project, message: emit(ctx, command.error, "error") };
  }

  if (command.type === "list") {
    return { ok: true, command, project, message: emit(ctx, renderList(project)) };
  }

  if (command.type === "setup") {
    await setupContext(ctx, project);
    saveProject(project, baseDir);
    const message = project.contextFiles.length
      ? `Kontext gespeichert:\n${project.contextFiles.join("\n")}`
      : "Kontext gespeichert: keiner.";
    return { ok: true, command, project, message: emit(ctx, message) };
  }

  if (command.type === "clear") {
    const confirmed = ctx?.hasUI && (await ctx.ui?.confirm?.("Pi Desk clear", "Alle offenen Inbox-Einträge hart löschen?"));
    if (!confirmed) return { ok: false, command, project, message: emit(ctx, "Clear abgebrochen.", "warning") };
    const count = clearItems(project);
    saveProject(project, baseDir);
    return { ok: true, command, project, message: emit(ctx, `${count} Inbox-Einträge gelöscht.`) };
  }

  if (command.type === "done") {
    const ok = doneItem(project, command.id);
    if (ok) saveProject(project, baseDir);
    return {
      ok,
      command,
      project,
      message: emit(ctx, ok ? renderList(project) : `Inbox-Eintrag #${command.id} nicht gefunden.`, ok ? "info" : "warning"),
    };
  }

  if (command.type === "edit") {
    const item = project.items.find((entry) => entry.id === command.id);
    if (!item) {
      return { ok: false, command, project, message: emit(ctx, `Inbox-Eintrag #${command.id} nicht gefunden.`, "warning") };
    }

    const text = command.text || (ctx?.hasUI ? String((await ctx.ui?.editor?.(`Inbox-Eintrag #${command.id}`, item.text)) ?? "").trim() : "");
    const ok = editItem(project, command.id, text);
    if (ok) saveProject(project, baseDir);
    return {
      ok,
      command,
      project,
      message: emit(ctx, ok ? renderList(project) : "Edit abgebrochen.", ok ? "info" : "warning"),
    };
  }

  if (command.type === "move") {
    const ok = moveItem(project, command.id, command.rank);
    if (ok) saveProject(project, baseDir);
    return {
      ok,
      command,
      project,
      message: emit(ctx, ok ? renderList(project) : `Inbox-Eintrag #${command.id} nicht gefunden.`, ok ? "info" : "warning"),
    };
  }

  if (command.type === "add") {
    addItem(project, command.text);
    saveProject(project, baseDir);
    return { ok: true, command, project, message: emit(ctx, renderList(project)) };
  }

  if (command.type === "sort") {
    if (project.items.length < 2) return { ok: true, command, project, message: emit(ctx, renderList(project)) };
    const started = await startSortAgent(pi, ctx, project);
    return { ok: started, command, project, message: emit(ctx, started ? "Sort-Agent gestartet." : renderList(project), started ? "info" : "warning") };
  }

  return { ok: false, command, project, message: emit(ctx, "Unbekannter /todo Befehl.", "error") };
}

export default function piTodoExtension(pi) {
  let restoreTools;
  const restoreSortTools = () => {
    if (!restoreTools) return;
    pi.setActiveTools?.(restoreTools);
    restoreTools = undefined;
  };
  pi.on?.("agent_end", restoreSortTools);

  pi.registerTool?.({
    name: "piDeskContext",
    label: "Pi Desk Context",
    description: "List or read safe project context files for Pi Desk sorting.",
    promptSnippet: "List/read only files that pass Pi Desk's context safety filter.",
    parameters: CONTEXT_TOOL_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const project = loadProject(ctx?.cwd || process.cwd());
      if (params?.action === "list") {
        const files = [...new Set([...project.contextFiles, ...suggestContextFiles(project.projectRoot, 10)])]
          .filter((file) => isSafeContextFile(project.projectRoot, file));
        return {
          content: [{ type: "text", text: files.length ? files.join("\n") : "Keine sicheren Kontextdateien gefunden." }],
          details: { files },
        };
      }

      const relative = toProjectRelative(project.projectRoot, params?.path);
      if (params?.action !== "read" || !relative || !isSafeContextFile(project.projectRoot, relative)) {
        return { content: [{ type: "text", text: "Kontextdatei nicht erlaubt oder nicht gefunden." }], details: { ok: false } };
      }

      const text = readFileSync(path.join(project.projectRoot, relative), "utf8").slice(0, CONTEXT_CHARS_PER_FILE);
      return { content: [{ type: "text", text: `# ${relative}\n${text}` }], details: { ok: true, path: relative } };
    },
  });

  pi.registerTool?.({
    name: "askUserQuestions",
    label: "Ask User Questions",
    description: "Ask the user open questions needed to sort the Pi Desk inbox.",
    promptSnippet: "Ask concise open questions when Pi Desk sorting lacks enough context.",
    parameters: ASK_USER_QUESTIONS_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const questions = (Array.isArray(params?.questions) ? params.questions : [])
        .map((question) => String(question ?? "").trim())
        .filter(Boolean)
        .slice(0, 4);
      if (!questions.length) return { content: [{ type: "text", text: "Keine Fragen angegeben." }], details: { questions, answers: "" } };

      if (!ctx?.hasUI && ctx?.mode !== "tui") {
        return { content: [{ type: "text", text: `UI nicht verfügbar. Offene Fragen:\n${questions.join("\n")}` }], details: { questions, answers: "" } };
      }

      const prompt = questions.map((question, index) => `${index + 1}. ${question}\nA:`).join("\n\n");
      const answers = ctx.ui?.editor
        ? await ctx.ui.editor("Pi Desk Sort Fragen", prompt)
        : await ctx.ui?.input?.("Pi Desk Sort Frage", questions.join("\n"));
      const text = String(answers ?? "").trim();
      return { content: [{ type: "text", text: text ? `Antworten:\n${text}` : "Keine Antwort gegeben." }], details: { questions, answers: text } };
    },
  });

  pi.registerTool?.({
    name: "piDeskApplySort",
    label: "Apply Pi Desk Sort",
    description: "Persist the final sorted Pi Desk inbox order.",
    parameters: APPLY_SORT_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const project = loadProject(ctx?.cwd || process.cwd());
      const ok = applyRanking(project, params?.items);
      if (ok) saveProject(project);
      const text = ok ? renderList(project) : "Sortierung abgelehnt: IDs fehlen oder sind doppelt.";
      ctx?.ui?.notify?.(text, ok ? "info" : "warning");
      return { content: [{ type: "text", text }], details: { ok, projectId: project.id } };
    },
  });

  pi.registerCommand("todo", {
    description: "Pi Desk: project-scoped priority workspace",
    getArgumentCompletions: (prefix) => {
      const commands = ["all", "sort", "setup", "clear", "done ", "edit ", "move "];
      const filtered = commands.filter((command) => command.startsWith(prefix));
      return filtered.length ? filtered.map((command) => ({ value: command, label: command.trim() || command })) : null;
    },
    handler: async (args, ctx) => {
      const result = await handleTodoCommand(args, ctx, {
        sendUserMessage: (...params) => pi.sendUserMessage(...params),
        prepareSortTools: () => {
          if (!pi.getActiveTools || !pi.setActiveTools) return undefined;
          restoreTools ||= pi.getActiveTools();
          const available = new Set((pi.getAllTools?.() || []).map((tool) => tool.name));
          const tools = ["piDeskContext", "askUserQuestions", "piDeskApplySort"]
            .filter((name) => !available.size || available.has(name));
          pi.setActiveTools(tools);
          return restoreSortTools;
        },
      });
      pi.sendMessage?.({ customType: "pi-desk", content: result.message, display: true, details: { ok: result.ok } });
    },
  });
}
