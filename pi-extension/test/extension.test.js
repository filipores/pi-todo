import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import piTodoExtension, {
  addItem,
  applyRanking,
  clearItems,
  doneItem,
  editItem,
  findProjectRoot,
  handleTodoCommand,
  isSafeContextFile,
  loadAllProjects,
  loadProject,
  moveItem,
  parseTodoCommand,
  projectFileFor,
  saveProject,
  suggestContextFiles,
} from "../index.js";

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-desk-"));
  t?.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("package registers the pi extension", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "pi-desk");
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.ok(pkg.keywords.includes("workspace"));
  assert.deepEqual(pkg.pi.extensions, ["./pi-extension/index.js"]);

  const registered = [];
  const tools = [];
  piTodoExtension({
    registerCommand: (name, options) => registered.push({ name, options }),
    registerTool: (tool) => tools.push(tool),
  });
  assert.equal(registered[0].name, "todo");
  assert.equal(typeof registered[0].options.handler, "function");
  assert.deepEqual(tools.map((tool) => tool.name), ["piDeskContext", "askUserQuestions", "piDeskApplySort"]);
});

test("parses todo commands", () => {
  assert.deepEqual(parseTodoCommand(""), { type: "list" });
  assert.deepEqual(parseTodoCommand("buy milk"), { type: "add", text: "buy milk" });
  assert.deepEqual(parseTodoCommand("sort"), { type: "sort" });
  assert.deepEqual(parseTodoCommand("all"), { type: "all" });
  assert.deepEqual(parseTodoCommand("setup"), { type: "setup" });
  assert.deepEqual(parseTodoCommand("clear"), { type: "clear" });
  assert.deepEqual(parseTodoCommand("edit 3 new text"), { type: "edit", id: 3, text: "new text" });
  assert.deepEqual(parseTodoCommand("edit 3"), { type: "edit", id: 3, text: "" });
  assert.deepEqual(parseTodoCommand("done 3"), { type: "done", id: 3 });
  assert.deepEqual(parseTodoCommand("move 2 1"), { type: "move", id: 2, rank: 1 });
  assert.equal(parseTodoCommand("edit nope").type, "invalid");
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

test("stores add list done move clear as private project JSON", (t) => {
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

  const file = saveProject(project, store);
  assert.equal(statSync(store).mode & 0o077, 0);
  assert.equal(statSync(path.dirname(file)).mode & 0o077, 0);
  assert.equal(statSync(file).mode & 0o077, 0);

  chmodSync(store, 0o755);
  chmodSync(path.dirname(file), 0o755);
  chmodSync(file, 0o644);
  const loaded = loadProject(root, store);
  assert.equal(statSync(store).mode & 0o077, 0);
  assert.equal(statSync(path.dirname(file)).mode & 0o077, 0);
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.deepEqual(loaded.items.map((item) => item.id), [2, 3]);
  assert.equal(loaded.nextId, 4);

  assert.equal(clearItems(loaded), 2);
  assert.equal(loaded.items.length, 0);
});

test("all lists open items from every stored project", async (t) => {
  const store = tempDir(t);
  const current = tempDir(t);
  const firstRoot = tempDir(t);
  const secondRoot = tempDir(t);
  const emptyRoot = tempDir(t);
  writeFileSync(path.join(firstRoot, "CONTEXT.md"), "api_key=not-for-all");

  const first = loadProject(firstRoot, store);
  addItem(first, "first project task");
  first.contextFiles = ["CONTEXT.md"];
  saveProject(first, store);

  const second = loadProject(secondRoot, store);
  addItem(second, "second project task");
  saveProject(second, store);

  saveProject(loadProject(emptyRoot, store), store);
  mkdirSync(path.dirname(projectFileFor(current, store)), { recursive: true });
  writeFileSync(projectFileFor(current, store), "{");

  const allProjects = loadAllProjects(store);
  assert.deepEqual(allProjects.find((project) => project.projectRoot === firstRoot).contextFiles, []);

  const result = await handleTodoCommand("all", { cwd: current, hasUI: false, ui: { notify: () => {} } }, {}, { baseDir: store });

  assert.equal(result.ok, true);
  assert.ok(result.message.includes(`${path.basename(firstRoot)} — ${firstRoot}`));
  assert.ok(result.message.includes("#1 first project task"));
  assert.ok(result.message.includes(`${path.basename(secondRoot)} — ${secondRoot}`));
  assert.ok(result.message.includes("#1 second project task"));
  assert.equal(result.message.includes(`${path.basename(emptyRoot)} — ${emptyRoot}`), false);
  assert.equal(result.message.includes("api_key=not-for-all"), false);
});

test("load ignores symlinked project JSON", (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  const target = path.join(tempDir(t), "target.json");
  writeFileSync(target, JSON.stringify({ projectRoot: root, items: [{ id: 1, text: "stolen" }] }));
  chmodSync(target, 0o644);

  const file = projectFileFor(root, store);
  mkdirSync(path.dirname(file), { recursive: true });
  symlinkSync(target, file);

  const loaded = loadProject(root, store);
  assert.deepEqual(loaded.items, []);
  assert.equal(statSync(target).mode & 0o777, 0o644);
});

test("save refuses symlinked projects directory", (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  const target = tempDir(t);
  symlinkSync(target, path.join(store, "projects"));

  const project = loadProject(root, store);
  addItem(project, "do not leak");

  assert.throws(() => saveProject(project, store), /Unsafe store directory/);
  assert.deepEqual(readdirSync(target), []);
});

test("add appends; edit, done and move clear stale ranking reasons", () => {
  const project = { items: [], nextId: 1 };
  addItem(project, "first");
  addItem(project, "second");
  project.items.forEach((item) => { item.reason = "old"; });

  addItem(project, "third");
  assert.deepEqual(project.items.map((item) => item.reason), ["old", "old", ""]);

  project.items[0].manualRank = 1;
  project.items.forEach((item) => { item.reason = "old"; });
  assert.equal(editItem(project, 1, "first edited"), true);
  assert.equal(project.items[0].text, "first edited");
  assert.equal(project.items[0].manualRank, undefined);
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

test("add appends without starting agent", async (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  const pi = { sendUserMessage: () => { throw new Error("agent should not start"); } };
  const ctx = { cwd: root, hasUI: false, ui: { notify: () => {} } };

  await handleTodoCommand("nice to have", ctx, pi, { baseDir: store });
  const result = await handleTodoCommand("blocking bug", ctx, pi, { baseDir: store });

  assert.equal(result.ok, true);
  assert.deepEqual(result.project.items.map((item) => item.text), ["nice to have", "blocking bug"]);
  assert.deepEqual(loadProject(root, store).items.map((item) => item.text), ["nice to have", "blocking bug"]);
});

test("sort starts agent with loaded Pi context", async (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  writeFileSync(path.join(root, "CONTEXT.md"), "safe context file");
  let prompt = "";
  const pi = { sendUserMessage: (message) => { prompt = message; }, prepareSortTools: () => () => {} };
  const ctx = {
    cwd: root,
    hasUI: false,
    isIdle: () => true,
    ui: { notify: () => {} },
    getSystemPromptOptions: () => ({ contextFiles: [{ path: "CONTEXT.md", content: "Loaded project context" }] }),
  };

  await handleTodoCommand("nice to have", ctx, pi, { baseDir: store });
  await handleTodoCommand("blocking bug", ctx, pi, { baseDir: store });
  const result = await handleTodoCommand("sort", ctx, pi, { baseDir: store });

  assert.equal(result.ok, true);
  assert.equal(result.message, "Sort-Agent gestartet.");
  assert.deepEqual(loadProject(root, store).items.map((item) => item.id), [1, 2]);
  assert.match(prompt, /Loaded project context/);
  assert.match(prompt, /piDeskContext/);
  assert.match(prompt, /askUserQuestions/);
  assert.match(prompt, /piDeskApplySort/);
});

test("piDeskContext only reads safe context files", async (t) => {
  const root = tempDir(t);
  writeFileSync(path.join(root, "README.md"), "clean readme");
  writeFileSync(path.join(root, ".env"), "SECRET=1");
  writeFileSync(path.join(root, "config.json"), '{"api_key":"no"}');

  const tools = [];
  piTodoExtension({ registerTool: (tool) => tools.push(tool), registerCommand: () => {}, on: () => {} });
  const contextTool = tools.find((tool) => tool.name === "piDeskContext");

  let result = await contextTool.execute("", { action: "list" }, undefined, undefined, { cwd: root });
  assert.match(result.content[0].text, /README.md/);
  assert.doesNotMatch(result.content[0].text, /.env/);
  assert.doesNotMatch(result.content[0].text, /config.json/);

  result = await contextTool.execute("", { action: "read", path: "README.md" }, undefined, undefined, { cwd: root });
  assert.match(result.content[0].text, /clean readme/);

  result = await contextTool.execute("", { action: "read", path: ".env" }, undefined, undefined, { cwd: root });
  assert.equal(result.details.ok, false);
});

test("sort ignores unsafe loaded Pi context files", async (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, ".env"), "LINKED=secret");
  writeFileSync(path.join(root, "README.md"), "clean readme");
  writeFileSync(path.join(root, "CONTEXT.md"), "safe context file");
  writeFileSync(path.join(root, "ALT.md"), "clean alt");
  symlinkSync(path.join(root, ".env"), path.join(root, "docs", "linked.md"));
  let prompt = "";
  const pi = { sendUserMessage: (message) => { prompt = message; }, prepareSortTools: () => () => {} };
  const ctx = {
    cwd: root,
    hasUI: false,
    ui: { notify: () => {} },
    getSystemPromptOptions: () => ({
      contextFiles: [
        { path: ".env", content: "FOO=bar" },
        { path: "README.md", content: "api_key=secret" },
        { path: "docs/linked.md", content: "LINKED=secret" },
        { path: "ALT.md", text: "ALT via text", contents: "ALT via contents" },
        { path: "CONTEXT.md", content: "safe context" },
      ],
    }),
  };

  await handleTodoCommand("first", ctx, pi, { baseDir: store });
  await handleTodoCommand("second", ctx, pi, { baseDir: store });
  await handleTodoCommand("sort", ctx, pi, { baseDir: store });

  assert.doesNotMatch(prompt, /FOO=bar/);
  assert.doesNotMatch(prompt, /api_key=secret/);
  assert.doesNotMatch(prompt, /LINKED=secret/);
  assert.doesNotMatch(prompt, /ALT via/);
  assert.match(prompt, /safe context/);
});

test("sort starts without loaded Pi context", async (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  let prompt = "";
  const pi = { sendUserMessage: (message) => { prompt = message; }, prepareSortTools: () => () => {} };
  const ctx = {
    cwd: root,
    hasUI: false,
    ui: { notify: () => {} },
    getSystemPromptOptions: () => {
      throw new Error("boom");
    },
  };

  await handleTodoCommand("first", ctx, pi, { baseDir: store });
  await handleTodoCommand("second", ctx, pi, { baseDir: store });
  const result = await handleTodoCommand("sort", ctx, pi, { baseDir: store });

  assert.equal(result.ok, true);
  assert.deepEqual(loadProject(root, store).items.map((item) => item.text), ["first", "second"]);
  assert.match(prompt, /kein gespeicherter Kontext/);
});

test("sort requires tool allowlist before starting agent", async (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  let started = false;
  const pi = { sendUserMessage: () => { started = true; } };
  const ctx = { cwd: root, hasUI: false, ui: { notify: () => {} } };

  await handleTodoCommand("first", ctx, pi, { baseDir: store });
  await handleTodoCommand("second", ctx, pi, { baseDir: store });
  const result = await handleTodoCommand("sort", ctx, pi, { baseDir: store });

  assert.equal(result.ok, false);
  assert.equal(started, false);
  assert.deepEqual(loadProject(root, store).items.map((item) => item.text), ["first", "second"]);
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
  assert.ok(messages.some((message) => /Sort-Agent nicht verfügbar/.test(message)));
});

test("command flow adds, edits, lists, confirms clear", async (t) => {
  const root = tempDir(t);
  const store = tempDir(t);
  const messages = [];
  const ctx = { cwd: root, hasUI: false, ui: { notify: (message) => messages.push(message) } };

  let result = await handleTodoCommand("ship MVP", ctx, {}, { baseDir: store });
  assert.equal(result.ok, true);
  assert.equal(result.project.items.length, 1);
  assert.equal(result.project.items[0].reason, "");

  result = await handleTodoCommand("edit 1 ship MVP today", ctx, {}, { baseDir: store });
  assert.equal(result.ok, true);
  assert.deepEqual(loadProject(root, store).items.map((item) => item.text), ["ship MVP today"]);

  const editorCtx = {
    cwd: root,
    hasUI: true,
    ui: {
      notify: (message) => messages.push(message),
      editor: async (title, initial) => {
        assert.equal(title, "Inbox-Eintrag #1");
        assert.equal(initial, "ship MVP today");
        return "ship MVP tomorrow";
      },
    },
  };
  result = await handleTodoCommand("edit 1", editorCtx, {}, { baseDir: store });
  assert.equal(result.ok, true);
  assert.deepEqual(loadProject(root, store).items.map((item) => item.text), ["ship MVP tomorrow"]);

  result = await handleTodoCommand("", ctx, {}, { baseDir: store });
  assert.match(result.message, /#1 ship MVP tomorrow/);

  const no = { cwd: root, hasUI: true, ui: { notify: () => {}, confirm: async () => false } };
  result = await handleTodoCommand("clear", no, {}, { baseDir: store });
  assert.equal(result.ok, false);
  assert.equal(loadProject(root, store).items.length, 1);

  const yes = { cwd: root, hasUI: true, ui: { notify: () => {}, confirm: async () => true } };
  result = await handleTodoCommand("clear", yes, {}, { baseDir: store });
  assert.equal(result.ok, true);
  assert.equal(loadProject(root, store).items.length, 0);
});
