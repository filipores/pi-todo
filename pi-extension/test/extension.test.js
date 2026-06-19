import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import piTodoExtension, {
  addItem,
  applyRanking,
  clearItems,
  doneItem,
  findProjectRoot,
  handleTodoCommand,
  isSafeContextFile,
  loadProject,
  moveItem,
  parseTodoCommand,
  saveProject,
  suggestContextFiles,
} from "../index.js";

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-todo-"));
  t?.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("package registers the pi extension", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "pi-todo");
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.ok(pkg.keywords.includes("todo"));
  assert.deepEqual(pkg.pi.extensions, ["./pi-extension/index.js"]);

  const registered = [];
  piTodoExtension({ registerCommand: (name, options) => registered.push({ name, options }) });
  assert.equal(registered[0].name, "todo");
  assert.equal(typeof registered[0].options.handler, "function");
});

test("parses todo commands", () => {
  assert.deepEqual(parseTodoCommand(""), { type: "list" });
  assert.deepEqual(parseTodoCommand("buy milk"), { type: "add", text: "buy milk" });
  assert.deepEqual(parseTodoCommand("sort"), { type: "sort" });
  assert.deepEqual(parseTodoCommand("setup"), { type: "setup" });
  assert.deepEqual(parseTodoCommand("clear"), { type: "clear" });
  assert.deepEqual(parseTodoCommand("done 3"), { type: "done", id: 3 });
  assert.deepEqual(parseTodoCommand("move 2 1"), { type: "move", id: 2, rank: 1 });
  assert.equal(parseTodoCommand("done nope").type, "invalid");
  assert.equal(parseTodoCommand("move 2").type, "invalid");
});

test("finds git root and falls back to cwd", (t) => {
  const root = tempDir(t);
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, "a", "b"), { recursive: true });
  assert.equal(findProjectRoot(path.join(root, "a", "b")), root);

  const noGit = tempDir(t);
  mkdirSync(path.join(noGit, "sub"));
  assert.equal(findProjectRoot(path.join(noGit, "sub")), path.join(noGit, "sub"));
});

test("stores add list done move clear as project JSON", (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  mkdirSync(path.join(root, ".git"));

  const project = loadProject(root, store);
  addItem(project, "first");
  addItem(project, "second");
  addItem(project, "third");
  assert.deepEqual(project.items.map((item) => item.text), ["first", "second", "third"]);

  assert.equal(moveItem(project, 2, 1), true);
  assert.deepEqual(project.items.map((item) => item.id), [2, 1, 3]);
  assert.equal(project.items[0].manualRank, 1);

  assert.equal(doneItem(project, 1), true);
  assert.deepEqual(project.items.map((item) => item.id), [2, 3]);

  saveProject(project, store);
  const loaded = loadProject(root, store);
  assert.deepEqual(loaded.items.map((item) => item.id), [2, 3]);
  assert.equal(loaded.nextId, 4);

  assert.equal(clearItems(loaded), 2);
  assert.equal(loaded.items.length, 0);
});

test("item changes clear stale ranking reasons", () => {
  const project = { items: [], nextId: 1 };
  addItem(project, "first");
  addItem(project, "second");
  project.items.forEach((item) => { item.reason = "old"; });

  addItem(project, "third");
  assert.deepEqual(project.items.map((item) => item.reason), ["", "", ""]);

  project.items.forEach((item) => { item.reason = "old"; });
  doneItem(project, 3);
  assert.deepEqual(project.items.map((item) => item.reason), ["", ""]);

  project.items.forEach((item) => { item.reason = "old"; });
  moveItem(project, 2, 1);
  assert.deepEqual(project.items.map((item) => item.reason), ["", ""]);
});

test("ranking respects manual ranks", () => {
  const project = { items: [], nextId: 1 };
  addItem(project, "first");
  addItem(project, "second");
  addItem(project, "third");
  moveItem(project, 2, 1);

  applyRanking(project, [
    { id: 3, reason: "now" },
    { id: 1, reason: "later" },
    { id: 2, reason: "manual" },
  ]);

  assert.deepEqual(project.items.map((item) => item.id), [2, 3, 1]);
  assert.equal(project.items[1].reason, "now");
});

test("ranking clears stale reasons when agent omits them", () => {
  const project = { items: [], nextId: 1 };
  addItem(project, "first");
  addItem(project, "second");
  project.items[0].reason = "old";
  project.items[1].reason = "older";

  assert.equal(applyRanking(project, [{ id: 2 }, { id: 1 }]), true);
  assert.deepEqual(project.items.map((item) => item.reason), ["", ""]);
});

test("ranking rejects incomplete or invalid agent output", () => {
  const project = { items: [], nextId: 1 };
  addItem(project, "first");
  addItem(project, "second");
  const order = project.items.map((item) => item.id);

  assert.equal(applyRanking(project, [{ id: 2, reason: "only one" }]), false);
  assert.deepEqual(project.items.map((item) => item.id), order);
  assert.equal(applyRanking(project, [{ id: 2 }, { id: 2 }]), false);
  assert.deepEqual(project.items.map((item) => item.id), order);
  assert.equal(applyRanking(project, [{ id: 2 }, { id: 999 }]), false);
  assert.deepEqual(project.items.map((item) => item.id), order);
});

test("filters unsafe context and suggests root/docs files", (t) => {
  const root = tempDir(t);
  writeFileSync(path.join(root, "CONTEXT.md"), "context");
  writeFileSync(path.join(root, "README.md"), "readme");
  writeFileSync(path.join(root, "service-account.json"), `${"x".repeat(5000)}{"type":"service_account","private_key":"no"}`);
  writeFileSync(path.join(root, "config.json"), '{"api_key":"no"}');
  writeFileSync(path.join(root, "settings.yml"), "client_secret: no");
  writeFileSync(path.join(root, "notes.md"), "JWT_SECRET=no");
  writeFileSync(path.join(root, ".env"), "SECRET=1");
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, ".git", "notes.md"), "no");
  mkdirSync(path.join(root, "node_modules"));
  writeFileSync(path.join(root, "node_modules", "README.md"), "no");
  mkdirSync(path.join(root, "docs", "secrets"), { recursive: true });
  writeFileSync(path.join(root, "docs", "usage.md"), "docs");
  writeFileSync(path.join(root, "docs", "secrets", "notes.md"), "no");
  symlinkSync(path.join(root, ".env"), path.join(root, "docs", "linked.md"));
  symlinkSync(path.join(root, ".git"), path.join(root, "docs", "gitlink"));
  writeFileSync(path.join(root, "image.png"), "not docs");

  assert.equal(isSafeContextFile(root, "CONTEXT.md"), true);
  assert.equal(isSafeContextFile(root, ".env"), false);
  assert.equal(isSafeContextFile(root, "service-account.json"), false);
  assert.equal(isSafeContextFile(root, "config.json"), false);
  assert.equal(isSafeContextFile(root, "settings.yml"), false);
  assert.equal(isSafeContextFile(root, "notes.md"), false);
  assert.equal(isSafeContextFile(root, "docs/linked.md"), false);
  assert.equal(isSafeContextFile(root, "docs/gitlink/notes.md"), false);
  assert.equal(isSafeContextFile(root, "docs/secrets/notes.md"), false);
  assert.equal(isSafeContextFile(root, "node_modules/README.md"), false);
  assert.equal(isSafeContextFile(root, "image.png"), false);
  assert.deepEqual(suggestContextFiles(root), ["CONTEXT.md", "README.md", "docs/usage.md"]);
});

test("sort prioritizes automatically with loaded Pi context", async (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  let prompt = "";
  const pi = {
    exec: async (_command, args) => {
      prompt = args.at(-1);
      return { code: 0, stdout: '{"items":[{"id":2,"reason":"blocks work"},{"id":1,"reason":"later"}]}' };
    },
  };
  const ctx = {
    cwd: root,
    hasUI: false,
    ui: { notify: () => {} },
    getSystemPromptOptions: () => ({ contextFiles: [{ path: "CONTEXT.md", content: "Loaded project context" }] }),
  };

  await handleTodoCommand("nice to have", ctx, pi, { baseDir: store });
  const result = await handleTodoCommand("blocking bug", ctx, pi, { baseDir: store });

  assert.equal(result.ok, true);
  assert.deepEqual(result.project.items.map((item) => item.id), [2, 1]);
  assert.match(prompt, /Loaded project context/);
  assert.doesNotMatch(prompt, /Priorisierungskriterium/);
});

test("sort failure keeps order without fake reasons", async (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  const messages = [];
  const ctx = { cwd: root, hasUI: false, ui: { notify: (message) => messages.push(message) } };

  await handleTodoCommand("first", ctx, {}, { baseDir: store });
  await handleTodoCommand("second", ctx, {}, { baseDir: store });
  const result = await handleTodoCommand("sort", ctx, {}, { baseDir: store });

  assert.equal(result.ok, false);
  assert.deepEqual(result.project.items.map((item) => item.text), ["first", "second"]);
  assert.deepEqual(result.project.items.map((item) => item.reason), ["", ""]);
  assert.ok(messages.some((message) => /Priorisierung-Agent nicht verfügbar/.test(message)));
});

test("command flow adds, lists, confirms clear", async (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  const messages = [];
  const ctx = { cwd: root, hasUI: false, ui: { notify: (message) => messages.push(message) } };

  let result = await handleTodoCommand("ship MVP", ctx, {}, { baseDir: store });
  assert.equal(result.ok, true);
  assert.equal(result.project.items.length, 1);
  assert.equal(result.project.items[0].reason, "");

  result = await handleTodoCommand("", ctx, {}, { baseDir: store });
  assert.match(result.message, /#1 ship MVP/);

  const no = { cwd: root, hasUI: true, ui: { notify: () => {}, confirm: async () => false } };
  result = await handleTodoCommand("clear", no, {}, { baseDir: store });
  assert.equal(result.ok, false);
  assert.equal(loadProject(root, store).items.length, 1);

  const yes = { cwd: root, hasUI: true, ui: { notify: () => {}, confirm: async () => true } };
  result = await handleTodoCommand("clear", yes, {}, { baseDir: store });
  assert.equal(result.ok, true);
  assert.equal(loadProject(root, store).items.length, 0);
});
