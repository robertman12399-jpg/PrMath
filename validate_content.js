#!/usr/bin/env node
/* validate_content.js — проверка учебного контента (темы, задания, главы, достижения).
 *
 * Запуск из корня приложения:
 *     node validate_content.js
 *
 * Что делает: загружает те же файлы данных, что и браузер (config.js + data.js +
 * data-geometry.js + data-oge.js) в изолированном контексте, собирает готовый GAME
 * и прогоняет набор проверок целостности. Реальные ошибки (сломанное задание,
 * генератор, выдающий NaN, достижение, ссылающееся на несуществующую тему) —
 * это ERROR (код возврата 1). Спорные вещи — WARN, справочные — INFO (код 0).
 *
 * Никаких зависимостей: только встроенный модуль vm. Годится для запуска руками
 * и для CI (падает с ненулевым кодом при наличии ERROR).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const JS = path.join(__dirname, "web", "js");
const FILES = ["config.js", "data.js", "data-geometry.js", "data-oge.js"];

/* ---------- сбор отчёта ---------- */
const issues = [];
function add(sev, code, msg) { issues.push({ sev, code, msg }); }
const ERROR = (c, m) => add("ERROR", c, m);
const WARN = (c, m) => add("WARN", c, m);
const INFO = (c, m) => add("INFO", c, m);

/* ---------- загрузка данных в песочнице ---------- */
let GAME, APP;
try {
  const parts = FILES.map((f) => {
    const p = path.join(JS, f);
    if (!fs.existsSync(p)) throw new Error(`не найден файл ${p}`);
    return `/* ==== ${f} ==== */\n` + fs.readFileSync(p, "utf8");
  });
  let captured = null;
  const sandbox = { __capture: (o) => { captured = o; }, console };
  const code = parts.join("\n") +
    "\n;__capture({ GAME: (typeof GAME!=='undefined'?GAME:null), APP: (typeof APP!=='undefined'?APP:null) });";
  vm.runInNewContext(code, sandbox, { filename: "content-bundle.js", timeout: 15000 });
  GAME = captured && captured.GAME;
  APP = captured && captured.APP;
  if (!GAME) throw new Error("после загрузки файлов объект GAME не собрался");
} catch (e) {
  console.error("Не удалось загрузить данные:", e.message);
  process.exit(2);
}

/* ---------- утилиты ---------- */
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const arr = (v) => Array.isArray(v) ? v : [];
const TASK_TYPES = new Set(["choice", "input", "error", "explore", "match", "build", "proof", "proofSteps"]);

function dupCheck(list, keyFn, label) {
  const seen = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (k == null) continue;
    if (seen.has(k)) ERROR("dup-id", `Повторяющийся ${label} id: "${k}"`);
    else seen.set(k, true);
  }
}

const topics = arr(GAME.topics);
const chapters = arr(GAME.chapters);
const worlds = arr(GAME.worlds);
const achievements = arr(GAME.achievements);
const theorems = arr(GAME.theorems);

/* ---------- 1. уникальность идентификаторов ---------- */
dupCheck(topics, (t) => t.id, "тема");
dupCheck(chapters, (c) => c.id, "глава");
dupCheck(worlds, (w) => w.id, "мир (world)");
dupCheck(achievements, (a) => a.id, "достижение");
dupCheck(theorems, (t) => t.id, "теорема");

const allTasks = [];
topics.forEach((t) => arr(t.tasks).forEach((task) => allTasks.push({ task, topic: t })));
dupCheck(allTasks.map((x) => x.task), (t) => t.id, "задание");

const allProblems = [];
chapters.forEach((c) => arr(c.problemSet).forEach((p) => allProblems.push({ p, chapter: c })));
dupCheck(allProblems.map((x) => x.p), (p) => p.id, "задача (problemSet)");

/* ---------- 2. индексы для ссылочных проверок ---------- */
const chapterIds = new Set(chapters.map((c) => c.id));
const worldIds = new Set(worlds.map((w) => w.id));
const topicIds = new Set(topics.map((t) => t.id));

/* ---------- 3. проверка тем ---------- */
const danglingWorldBySubject = {};
for (const t of topics) {
  const where = `тема "${t.id || "?"}"` + (t.title ? ` (${t.title})` : "");
  if (!isStr(t.id)) ERROR("topic-id", `${where}: нет корректного id`);
  if (!isStr(t.subject)) WARN("topic-subject", `${where}: нет поля subject`);
  // chapter — используется для группировки экранов, поэтому битая ссылка = ERROR
  if (t.chapter && t.chapter !== "misc" && !chapterIds.has(t.chapter))
    ERROR("topic-chapter", `${where}: chapter "${t.chapter}" не существует среди глав`);
  // world — приложением для навигации не читается, поэтому битая ссылка = WARN (агрегируем)
  if (t.world && !worldIds.has(t.world)) {
    const s = t.subject || "?";
    danglingWorldBySubject[s] = (danglingWorldBySubject[s] || 0) + 1;
  }
  if (!arr(t.theory).length) WARN("topic-theory", `${where}: пустая теория`);
  if (!arr(t.tasks).length) WARN("topic-tasks", `${where}: нет заданий`);
}
for (const [s, n] of Object.entries(danglingWorldBySubject))
  WARN("topic-world", `Раздел "${s}": у ${n} тем поле world ссылается на несуществующий world.id (в текущей версии не используется для навигации, но стоит поправить при слиянии данных)`);

/* ---------- 4. проверка заданий (главные проверки) ---------- */
function checkTask(task, topic) {
  const id = isStr(task.id) ? task.id : "(без id)";
  const where = `задание "${id}" в теме "${topic.id}"`;
  if (!isStr(task.id)) ERROR("task-id", `${where}: нет корректного id`);
  if (!isStr(task.q)) ERROR("task-q", `${where}: нет текста вопроса (q)`);
  if (!TASK_TYPES.has(task.type)) { ERROR("task-type", `${where}: неизвестный тип "${task.type}"`); return; }
  if (APP && APP.taskXP && !(task.type in APP.taskXP))
    WARN("task-xp", `${where}: для типа "${task.type}" нет записи в APP.taskXP (XP посчитается по умолчанию 10)`);

  switch (task.type) {
    case "choice":
    case "proof": {
      const opts = arr(task.options);
      if (opts.length < 2) { ERROR("choice-options", `${where}: должно быть ≥2 вариантов (options)`); break; }
      if (opts.some((o) => !isStr(o))) ERROR("choice-options", `${where}: есть пустой/нестроковый вариант ответа`);
      const uniq = new Set(opts.map((o) => String(o).trim()));
      if (uniq.size !== opts.length) WARN("choice-dup", `${where}: среди вариантов ответа есть дубликаты`);
      if (!isInt(task.correct) || task.correct < 0 || task.correct >= opts.length)
        ERROR("choice-correct", `${where}: correct=${JSON.stringify(task.correct)} вне диапазона 0..${opts.length - 1}`);
      break;
    }
    case "error": {
      const labels = arr(task.labels);
      if (labels.length < 2) { ERROR("error-labels", `${where}: должно быть ≥2 вариантов (labels)`); break; }
      let wrongs = 0;
      labels.forEach((l, i) => {
        if (!isStr(l.text)) ERROR("error-label", `${where}: label #${i} без текста`);
        if (typeof l.wrong !== "boolean") ERROR("error-label", `${where}: label #${i} без булева поля wrong`);
        if (l.wrong === true) wrongs++;
      });
      if (wrongs === 0) ERROR("error-nowrong", `${where}: ни один вариант не помечен wrong:true — проверять нечего`);
      break;
    }
    case "input": {
      if (!isNum(task.answer)) ERROR("input-answer", `${where}: answer не число (${JSON.stringify(task.answer)})`);
      if (task.tol == null) WARN("input-tol", `${where}: нет tol (допуска) — сравнение будет строгим`);
      else if (!isNum(task.tol) || task.tol < 0) ERROR("input-tol", `${where}: tol некорректен (${JSON.stringify(task.tol)})`);
      else if (task.tol === 0 && isNum(task.answer) && !isInt(task.answer))
        WARN("input-tol0", `${where}: tol=0 при нецелом ответе ${task.answer} — точное сравнение дробей ненадёжно`);
      break;
    }
    case "match": {
      const pairs = arr(task.pairs);
      if (pairs.length < 2) { ERROR("match-pairs", `${where}: должно быть ≥2 пар (pairs)`); break; }
      pairs.forEach((p, i) => {
        if (!isStr(p.left) || !isStr(p.right)) ERROR("match-pair", `${where}: пара #${i} без left/right`);
      });
      break;
    }
    case "build": {
      if (task.target == null) ERROR("build-target", `${where}: нет target (что построить)`);
      if (task.figure == null) WARN("build-figure", `${where}: нет figure — построение обычно требует чертежа`);
      if (task.target && task.tol == null && task.target.type !== "identity")
        WARN("build-tol", `${where}: нет tol для проверки построения`);
      break;
    }
    case "explore": {
      if (task.figure == null) WARN("explore-figure", `${where}: у explore-задания нет figure для исследования`);
      break;
    }
    case "proofSteps": {
      const steps = arr(task.steps);
      if (steps.length < 2) ERROR("proofsteps", `${where}: нужно ≥2 шагов (steps) в правильном порядке`);
      if (steps.some((s) => !isStr(s))) ERROR("proofsteps", `${where}: есть пустой шаг доказательства`);
      break;
    }
  }
}
allTasks.forEach(({ task, topic }) => checkTask(task, topic));

/* ---------- 5. генераторы: прогоняем и проверяем вывод ---------- */
const GEN_RUNS = 200;
let generatorsChecked = 0;
for (const { task, topic } of allTasks) {
  if (typeof task.generate !== "function") continue;
  generatorsChecked++;
  const where = `генератор задания "${task.id}" (тема "${topic.id}")`;
  for (let i = 0; i < GEN_RUNS; i++) {
    let out;
    try { out = task.generate(); }
    catch (e) { ERROR("gen-throw", `${where}: упал на запуске #${i}: ${e.message}`); break; }
    if (out == null || typeof out !== "object") { ERROR("gen-shape", `${where}: вернул не объект`); break; }
    if (task.type === "input") {
      if (!isNum(out.answer)) { ERROR("gen-answer", `${where}: вернул answer не число (${JSON.stringify(out.answer)}) на запуске #${i}`); break; }
      if (!isStr(out.q)) { ERROR("gen-q", `${where}: вернул пустой q на запуске #${i}`); break; }
      if (out.tol != null && (!isNum(out.tol) || out.tol < 0)) { ERROR("gen-tol", `${where}: вернул некорректный tol на запуске #${i}`); break; }
    } else {
      // для choice/error-генераторов минимальная проверка: непустой q
      if (out.q != null && !isStr(out.q)) { ERROR("gen-q", `${where}: вернул нестроковый q`); break; }
    }
  }
}

/* ---------- 6. достижения: cond не должен падать и должен ссылаться на существующие темы ---------- */
const mockState = {
  data: { stats: { xp: 0, hardTasksSolved: 0, bestExamPct: 0, examsTaken: 0 }, streak: { current: 0, longest: 0 }, progress: {} },
  isTopicDone: () => false,
  topicsDone: () => 0,
};
for (const a of achievements) {
  const where = `достижение "${a.id}"` + (a.title ? ` (${a.title})` : "");
  if (typeof a.cond !== "function") { WARN("ach-cond", `${where}: нет функции cond`); continue; }
  try { a.cond(mockState); }
  catch (e) { ERROR("ach-throw", `${where}: cond падает: ${e.message}`); }
  // Достаём из исходника cond строки, похожие на id тем, и проверяем существование.
  const src = a.cond.toString();
  const referenced = (src.match(/["'`]([a-z]{1,4}(?:_[a-z0-9]+)+)["'`]/gi) || [])
    .map((s) => s.slice(1, -1))
    .filter((s) => /_s\d|_t\d|_ch\d/.test(s)); // похоже на id темы
  for (const rid of new Set(referenced)) {
    if (!topicIds.has(rid))
      ERROR("ach-ref", `${where}: cond ссылается на несуществующую тему "${rid}"`);
  }
}

/* ---------- 7. справочные наблюдения по главам ---------- */
const topicsByChapter = {};
topics.forEach((t) => { if (t.chapter) (topicsByChapter[t.chapter] = topicsByChapter[t.chapter] || []).push(t); });
const emptyChapters = chapters.filter((c) => !(topicsByChapter[c.id] && topicsByChapter[c.id].length));
if (emptyChapters.length)
  INFO("chapter-empty", `Глав без тем (скрыты из списка): ${emptyChapters.length} — ${emptyChapters.map((c) => c.id).join(", ")}`);

const bySubjNoProblems = {};
chapters.forEach((c) => {
  if (!arr(c.problemSet).length) {
    const s = c.subject || "?";
    (bySubjNoProblems[s] = bySubjNoProblems[s] || []).push(c.id);
  }
});
for (const [s, ids] of Object.entries(bySubjNoProblems))
  WARN("chapter-noproblems", `Раздел "${s}": ${ids.length} глав без банка задач (problemSet) — ${ids.join(", ")}`);

/* ---------- сводка по разделам (справочно) ---------- */
const subjects = [...new Set(topics.map((t) => t.subject))];
INFO("summary", "Наполнение по разделам:");
for (const s of subjects) {
  const tp = topics.filter((t) => t.subject === s);
  const tasks = tp.reduce((a, t) => a + arr(t.tasks).length, 0);
  INFO("summary", `  • ${s}: тем ${tp.length}, заданий ${tasks}`);
}
INFO("summary", `  Всего: тем ${topics.length}, заданий ${allTasks.length}, генераторов ${generatorsChecked}, задач в банках ${allProblems.length}, теорем ${theorems.length}, достижений ${achievements.length}`);

/* ---------- вывод отчёта ---------- */
const order = { ERROR: 0, WARN: 1, INFO: 2 };
issues.sort((a, b) => order[a.sev] - order[b.sev]);
const counts = { ERROR: 0, WARN: 0, INFO: 0 };
issues.forEach((i) => counts[i.sev]++);

const mark = { ERROR: "✗ ERROR", WARN: "! WARN ", INFO: "· INFO " };
console.log("\n=== Проверка контента ===\n");
for (const i of issues) console.log(`${mark[i.sev]}  [${i.code}]  ${i.msg}`);
console.log(`\nИтого: ${counts.ERROR} ошибок, ${counts.WARN} предупреждений, ${counts.INFO} справочных.`);
if (counts.ERROR > 0) { console.log("Есть ошибки — их нужно исправить.\n"); process.exit(1); }
console.log("Ошибок не найдено.\n"); process.exit(0);
