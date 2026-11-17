// Runs Code.gs against mocked Apps Script services with a fake clock.
// Usage: node test/harness.js
// Tip: run with a different system time zone (e.g. TZ=Asia/Tokyo) to check that scheduling
// follows the spreadsheet's time zone, not the machine's.
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const MIN = 6e4, DAY = 864e5, ME = 'me@example.com', SHEET_TZ = 'America/New_York';
const RealDate = Date;

/* ---------- time-zone helpers for the Utilities mock ---------- */
function parts(d, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const o = {}; f.formatToParts(d).forEach(p => { o[p.type] = p.value; }); return o;
}
function offset(t, tz) {
  const p = parts(new RealDate(t), tz);
  return RealDate.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
}
function formatDate(d, tz, fmt) {
  const p = parts(d, tz), H = +p.hour, M = +p.month;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const U = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return fmt.replace(/yyyy|MMMM|MMM|MM|M|dd|d|HH|H|hh|h|mm|EEE|u|a/g, t => ({
    yyyy: p.year, MMMM: MONTHS[M - 1], MMM: MONTHS[M - 1].slice(0, 3), MM: p.month, M: String(M),
    dd: p.day, d: String(+p.day), HH: p.hour, H: String(H), hh: String(H % 12 || 12).padStart(2, '0'),
    h: String(H % 12 || 12), mm: p.minute, EEE: p.weekday, u: String(U[p.weekday]), a: H < 12 ? 'AM' : 'PM' }[t]));
}
function parseDate(str, tz) {
  const [y, mo, d, h = 0, mi = 0] = str.match(/\d+/g).map(Number);
  const guess = RealDate.UTC(y, mo - 1, d, h, mi);
  let t = guess - offset(guess, tz);
  t = guess - offset(t, tz);
  return new RealDate(t);
}
const at = s => parseDate(s, SHEET_TZ); // '2026-11-17 09:23' in the sheet's time zone
const wall = d => formatDate(d, SHEET_TZ, 'EEE MMM d HH:mm');
const minutesOfDay = d => { const p = parts(d, SHEET_TZ); return +p.hour * 60 + +p.minute; };
const weekday = d => !/Sat|Sun/.test(parts(d, SHEET_TZ).weekday);
const dayNum = d => Math.round(parseDate(formatDate(d, SHEET_TZ, 'yyyy-MM-dd'), 'UTC') / DAY);

/* ---------- fake Apps Script environment ---------- */
function makeEnv(opts = {}) {
  const env = { clock: at(opts.start || '2026-11-16 19:30'), threads: {}, drafts: [], log: [], alerts: [], triggers: [], props: {} };
  let threadSeq = 0, idSeq = 0;
  env.msg = (from, o = {}) => {
    const date = new RealDate(env.clock.getTime()), id = `<m${idSeq++}@x>`;
    return { from, date, draft: false, subject: o.subject || 'Hello', auto: o.auto || '',
      getFrom() { return this.from; }, getDate() { return this.date; }, isDraft() { return this.draft; },
      getSubject() { return this.subject; },
      getHeader(h) { return h === 'Message-ID' ? id : h === 'Auto-Submitted' ? this.auto : ''; } };
  };
  const newThread = to => { const id = 't' + threadSeq++;
    return (env.threads[id] = { id, to, msgs: [], getId: () => id, getMessages() { return this.msgs; } }); };
  env.threadOf = email => Object.values(env.threads).find(t => t.to === email);
  const decode = raw => { const [h, b] = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n');
    return { headers: h, body: Buffer.from(b.replace(/\r\n/g, ''), 'base64').toString('utf8') }; };

  function makeSheet(name, grid) {
    const sh = { name, grid, formats: {},
      getName: () => sh.name,
      getLastRow: () => { let n = sh.grid.length; while (n && sh.grid[n - 1].every(v => v === '' || v == null)) n--; return n; },
      getLastColumn: () => Math.max(0, ...sh.grid.map(r => { let n = r.length; while (n && (r[n - 1] === '' || r[n - 1] == null)) n--; return n; })),
      getRange: (r, c, nr = 1, nc = 1) => {
        const cell = (i, j) => { while (sh.grid.length < i) sh.grid.push([]); return [i - 1, j - 1]; };
        const rng = {
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (sh.grid[r - 1 + i] || [])[c - 1 + j] ?? '')),
          setValue(v) { const [i, j] = cell(r, c); sh.grid[i][j] = v; return rng; },
          setValues(vs) { vs.forEach((row, i) => row.forEach((v, j) => { const [a, b] = cell(r + i, c + j); sh.grid[a][b] = v; })); return rng; },
          setNumberFormat(f) { sh.formats[`${r},${c}`] = f; return rng; },
          setFontWeight: () => rng, setWrap: () => rng, setVerticalAlignment: () => rng, insertCheckboxes: () => rng,
        };
        return rng;
      },
      setFrozenRows() {}, setColumnWidth() {},
    };
    return sh;
  }
  env.sheets = (opts.sheets || [['Sheet1', []]]).map(([n, g]) => makeSheet(n, g));
  let active = env.sheets[0];
  const ss = {
    getSheets: () => env.sheets, getActiveSheet: () => active, setActiveSheet: s => { active = s; },
    getSheetByName: n => env.sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = makeSheet(n, []); env.sheets.push(s); return s; },
    getSpreadsheetTimeZone: () => SHEET_TZ, toast() {},
  };
  env.sheet = n => env.sheets.find(s => s.name === n);

  const gmail = {
    Users: {
      Messages: { send: m => { const t = env.threads[m.threadId], d = decode(m.raw); t.msgs.push(env.msg(ME));
        env.log.push({ at: new RealDate(env.clock), to: t.to, kind: 'followup', ...d }); } },
      Drafts: { create: r => { const d = decode(r.message.raw); env.drafts.push({ threadId: r.message.threadId });
        env.log.push({ at: new RealDate(env.clock), to: env.threads[r.message.threadId].to, kind: 'draft', ...d }); } },
    },
  };
  class FakeDate extends RealDate { constructor(...a) { a.length ? super(...a) : super(env.clock.getTime()); } static now() { return env.clock.getTime(); } }
  const ctx = {
    console, Math, String, Number, Object, Error, Set, Array, isNaN, Date: FakeDate,
    SpreadsheetApp: { getActive: () => ss,
      getUi: () => ({ alert: (t, m) => { env.alerts.push({ t, m }); return 'YES'; }, ButtonSet: { OK: 0, YES_NO: 1 }, Button: { YES: 'YES' },
        createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => ME }), getScriptTimeZone: () => 'Etc/UTC' },
    ScriptApp: { getProjectTriggers: () => env.triggers.map(h => ({ getHandlerFunction: () => h, h })),
      deleteTrigger: tr => { env.triggers = env.triggers.filter(h => h !== tr.h); },
      newTrigger: h => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => env.triggers.push(h) }) }) }) },
    GmailApp: {
      getAliases: () => [],
      createDraft: (to, subject, body) => ({ send() {
        const t = newThread(to); t.msgs.push(env.msg(ME, { subject }));
        env.log.push({ at: new RealDate(env.clock), to, kind: 'intro', subject, body }); return { getThread: () => t }; } }),
      getDrafts: () => env.drafts.map(d => ({ getMessage: () => ({ getThread: () => ({ getId: () => d.threadId }) }) })),
      getThreadById: id => env.threads[id], search: () => [],
      sendEmail: (to, s) => env.log.push({ at: new RealDate(env.clock), to, kind: 'summary', subject: s }),
    },
    MailApp: { getRemainingDailyQuota: () => 100 },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => env.props[k] ?? null, setProperty: (k, v) => { env.props[k] = v; } }) },
    Utilities: { Charset: { UTF_8: 'utf8' }, formatDate, parseDate, sleep() {},
      base64Encode: s => Buffer.from(s, 'utf8').toString('base64'),
      base64EncodeWebSafe: s => Buffer.from(s, 'utf8').toString('base64url') },
    Logger: { log() {} },
  };
  if (opts.gmailService !== false) ctx.Gmail = gmail;
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  env.run = code => vm.runInContext(code, ctx);
  env.ctx = ctx;
  env.tickUntil = (until) => { while (env.clock < until) { env.clock = new RealDate(env.clock.getTime() + 5 * MIN); env.run('tick()'); } };
  return env;
}
const HEAD = ['First Name', 'Last Name', 'Email', 'Company', 'Subject', 'Intro', 'Follow-up 1', 'Follow-up 2', 'Follow-up 3'];
const person = (first, email, company = 'Co') =>
  [first, 'X', email, company, 'Hi {{First Name}}', `intro for {{first name}} at {{Company}}`, `${first}1 é`, `${first}2`, `${first}3`];
const col = (sh, name) => sh.grid[0].indexOf(name);
const cell = (sh, first, name) => sh.grid.find(r => r[0] === first)[col(sh, name)];
const setCell = (sh, first, name, v) => { sh.grid.find(r => r[0] === first)[col(sh, name)] = v; };
const settingsGrid = rows => [['Setting', 'Value', 'What it does'], ...rows.map(([k, v]) => [k, v, ''])];

/* ---------- tests ---------- */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('setup on a blank spreadsheet builds Settings, a template row and turns on the scheduler', () => {
  const env = makeEnv();
  env.run('setup()');
  const settings = env.sheet('Settings');
  assert(settings && settings.grid.length === 8, 'settings tab with 7 settings');
  const sh = env.sheet('Sheet1');
  assert.deepStrictEqual(sh.grid[0].slice(0, 9), HEAD);
  assert.strictEqual(sh.grid[1][2], ME, 'example row is addressed to you, so nothing goes to a stranger by accident');
  ['Status', 'Next Send At', 'FU1 Planned', 'FU3 Planned'].forEach(h => assert(sh.grid[0].includes(h), h));
  assert.deepStrictEqual(env.triggers, ['tick']);
  assert(/set up/i.test(env.alerts.at(-1).t));
});

test('setup never overwrites a tab that already has other data', () => {
  const env = makeEnv({ sheets: [['Notes', [['my', 'notes']]]] });
  env.run('setup()');
  assert.deepStrictEqual(env.sheet('Notes').grid, [['my', 'notes']]);
  assert(env.sheet('Campaign'), 'template went to a new Campaign tab');
});

test('setup explains how to enable the Gmail service when it is off', () => {
  const env = makeEnv({ gmailService: false });
  env.run('setup()');
  assert(/Gmail service/.test(env.alerts.at(-1).t));
  assert.deepStrictEqual(env.triggers, [], 'scheduler not turned on until Gmail is enabled');
});

test('full sequence: random morning times, pinned times, placeholders, replies, bounces, out-of-office', () => {
  const env = makeEnv({ sheets: [['Leads', [HEAD, person('Ada', 'ada@example.com'), person('Ben', 'ben@example.com'),
    person('Cy', 'cy@example.com'), person('Dee', 'dee@example.org'), person('Eli', 'eli@example.org', '')]],
    ['Settings', settingsGrid([['Follow-up mode', 'send']])]] });
  const sh = env.sheet('Leads');
  env.run('scheduleIntros()');
  for (const r of sh.grid.slice(1)) {
    const times = ['Next Send At', 'FU1 Planned', 'FU2 Planned', 'FU3 Planned'].map(h => r[col(sh, h)]);
    assert(times.every(t => t instanceof RealDate && weekday(t) && minutesOfDay(t) >= 510 && minutesOfDay(t) < 690), `${r[0]} times in window`);
    assert.strictEqual(formatDate(times[0], SHEET_TZ, 'yyyy-MM-dd'), '2026-11-17', 'intro tomorrow');
    assert(dayNum(times[1]) - dayNum(times[0]) >= 3 && dayNum(times[2]) - dayNum(times[1]) >= 4 && dayNum(times[3]) - dayNum(times[2]) >= 7);
  }
  setCell(sh, 'Ada', 'Next Send At', at('2026-11-17 09:23'));
  setCell(sh, 'Ada', 'FU1 Planned', at('2026-11-20 10:47'));
  const planned = Object.fromEntries(sh.grid.slice(1).map(r => [r[2], ['Next Send At', 'FU1 Planned', 'FU2 Planned', 'FU3 Planned'].map(h => r[col(sh, h)])]));

  env.tickUntil(at('2026-11-17 12:00'));
  const intros = env.log.filter(l => l.kind === 'intro');
  assert.strictEqual(intros.length, 4, 'four intros; Eli is held back');
  intros.forEach(l => { const lag = (l.at - planned[l.to][0]) / MIN; assert(lag >= 0 && lag <= 5, `${l.to} intro lag ${lag}`); });
  const ada = intros.find(l => l.to === 'ada@example.com');
  assert(wall(ada.at).slice(-5) >= '09:23' && wall(ada.at).slice(-5) <= '09:28', 'pinned 9:23');
  assert.strictEqual(ada.subject, 'Hi Ada');
  assert.strictEqual(ada.body, 'intro for Ada at Co', 'placeholders are case/space-insensitive');
  assert(/Needs fix: \{\{Company\}\}/.test(cell(sh, 'Eli', 'Status')), 'empty placeholder blocks the send');

  env.clock = at('2026-11-18 14:00');
  env.threadOf('ben@example.com').msgs.push(env.msg('Ben <ben@example.com>'));
  env.threadOf('cy@example.com').msgs.push(env.msg('Mail Delivery <mailer-daemon@google.com>'));
  env.threadOf('dee@example.org').msgs.push(env.msg('dee@example.org', { subject: 'Automatic reply: Hi Dee', auto: 'auto-replied' }));
  env.tickUntil(at('2026-12-12 00:00'));

  const fus = env.log.filter(l => l.kind === 'followup');
  const byTo = e => fus.filter(l => l.to === e);
  assert.strictEqual(byTo('ben@example.com').length + byTo('cy@example.com').length, 0, 'reply and bounce stop the sequence');
  for (const e of ['ada@example.com', 'dee@example.org']) {
    const seq = byTo(e);
    assert.strictEqual(seq.length, 3, `${e} 3 follow-ups`);
    seq.forEach((s, k) => { const lag = (s.at - planned[e][k + 1]) / MIN; assert(lag >= 0 && lag <= 5, `${e} FU${k + 1} at planned time (lag ${lag})`); });
    assert(/Subject: Re: Hi /.test(seq[0].headers) && /In-Reply-To: <m\d+@x>/.test(seq[0].headers), 'threaded reply');
  }
  assert.strictEqual(byTo('ada@example.com')[0].body, 'Ada1 é', 'UTF-8 intact');
  assert(/^Replied/.test(cell(sh, 'Ben', 'Status')) && /^Bounced/.test(cell(sh, 'Cy', 'Status')));
  assert.strictEqual(cell(sh, 'Ben', 'FU1 Planned'), '', 'stopped rows clear their unsent times');
  assert.strictEqual(cell(sh, 'Ada', 'Status'), 'Done - no reply');
});

test('Settings tab: custom days, window and number of follow-ups', () => {
  const head = ['First Name', 'Email', 'Subject', 'Intro', 'Follow-up 1', 'Follow-up 2'];
  const env = makeEnv({ start: '2026-11-20 16:00', sheets: [['C', [head, ['Ann', 'ann@example.com', 'S', 'i', 'a', 'b']]],
    ['Settings', settingsGrid([['Follow-up mode', 'send'], ['Follow-up days', '2, 5'], ['Send window start', '1:00 PM'], ['Send window end', '14:00']])]] });
  env.run('scheduleIntros()');
  const sh = env.sheet('C');
  assert(!sh.grid[0].includes('FU3 Planned'), 'only as many plan columns as follow-up columns');
  const intro = cell(sh, 'Ann', 'Next Send At');
  assert.strictEqual(formatDate(intro, SHEET_TZ, 'EEE'), 'Mon', 'Friday + 1 day rolls over the weekend to Monday');
  env.tickUntil(at('2026-12-05 00:00'));
  const sent = env.log.filter(l => l.to === 'ann@example.com');
  assert.strictEqual(sent.length, 3);
  sent.forEach(l => assert(minutesOfDay(l.at) >= 780 && minutesOfDay(l.at) <= 845, `in 13:00-14:00 window: ${wall(l.at)}`));
  assert(dayNum(sent[1].at) - dayNum(sent[0].at) >= 2 && dayNum(sent[2].at) - dayNum(sent[1].at) >= 3);
});

test('daily cap postpones the extra emails to the next weekday morning', () => {
  const env = makeEnv({ sheets: [['L', [HEAD, person('A', 'a@x.com'), person('B', 'b@x.com'), person('C', 'c@x.com')]],
    ['Settings', settingsGrid([['Max emails per day', 2]])]] });
  const sh = env.sheet('L');
  env.run('tick()'); // adds the tracking columns
  ['A', 'B', 'C'].forEach((n, i) => setCell(sh, n, 'Next Send At', at(`2026-11-17 09:0${i}`)));
  env.clock = at('2026-11-17 08:55');
  env.tickUntil(at('2026-11-17 12:00'));
  assert.strictEqual(env.log.filter(l => l.kind === 'intro').length, 2);
  assert.strictEqual(formatDate(cell(sh, 'C', 'Next Send At'), SHEET_TZ, 'yyyy-MM-dd'), '2026-11-18', 'third one moved to tomorrow');
  env.tickUntil(at('2026-11-18 12:00'));
  assert.strictEqual(env.log.filter(l => l.kind === 'intro').length, 3);
});

test('a send that is hours overdue (scheduler was paused) moves to the next window instead of going out at night', () => {
  const env = makeEnv({ sheets: [['L', [HEAD, person('A', 'a@x.com')]]] });
  const sh = env.sheet('L');
  env.run('tick()');
  setCell(sh, 'A', 'Next Send At', at('2026-11-17 09:30'));
  env.clock = at('2026-11-17 22:00');
  env.run('tick()');
  assert.strictEqual(env.log.length, 0, 'nothing sent at 10pm');
  const moved = cell(sh, 'A', 'Next Send At');
  assert(formatDate(moved, SHEET_TZ, 'yyyy-MM-dd') === '2026-11-18' && minutesOfDay(moved) >= 510 && minutesOfDay(moved) < 690);
});

test('every campaign tab is processed', () => {
  const env = makeEnv({ sheets: [['One', [HEAD, person('A', 'a@x.com')]], ['Two', [HEAD, person('B', 'b@x.com')]]] });
  env.run('tick()');
  setCell(env.sheet('One'), 'A', 'Next Send At', at('2026-11-17 09:00'));
  setCell(env.sheet('Two'), 'B', 'Next Send At', at('2026-11-17 09:10'));
  env.clock = at('2026-11-17 08:55');
  env.tickUntil(at('2026-11-17 10:00'));
  assert.deepStrictEqual(env.log.filter(l => l.kind === 'intro').map(l => l.to), ['a@x.com', 'b@x.com']);
});

test('daylight saving: follow-ups keep morning times across the clock change', () => {
  const env = makeEnv({ start: '2026-10-29 12:00', sheets: [['L', [HEAD, person('A', 'a@x.com')]], ['Settings', settingsGrid([['Follow-up mode', 'send']])]] });
  env.run('tick()');
  setCell(env.sheet('L'), 'A', 'Next Send At', at('2026-10-30 10:00')); // Friday before DST ends (Nov 1)
  env.tickUntil(at('2026-11-30 00:00'));
  const sent = env.log.filter(l => l.to === 'a@x.com');
  assert.strictEqual(sent.length, 4);
  sent.forEach(l => assert(weekday(l.at) && minutesOfDay(l.at) >= 510 && minutesOfDay(l.at) <= 695, `morning: ${wall(l.at)}`));
});

test('draft mode waits for you to send, then counts the gap from when you actually did', () => {
  const env = makeEnv({ start: '2026-12-14 08:00', sheets: [['L', [HEAD, person('Eve', 'eve@example.com')]]] });
  env.run('tick()');
  setCell(env.sheet('L'), 'Eve', 'Next Send At', at('2026-12-14 09:23'));
  env.tickUntil(at('2026-12-17 12:00'));
  const drafts = () => env.log.filter(l => l.kind === 'draft');
  assert.strictEqual(drafts().length, 1, 'FU1 drafted');
  assert(env.log.some(l => l.kind === 'summary'), 'summary email sent');
  env.tickUntil(at('2026-12-21 12:00'));
  assert.strictEqual(drafts().length, 1, 'no pile-up while the draft is unsent');
  assert(/draft waiting/.test(cell(env.sheet('L'), 'Eve', 'Status')));
  env.clock = at('2026-12-21 12:05');
  env.drafts.length = 0; env.threadOf('eve@example.com').msgs.push(env.msg(ME));
  env.tickUntil(at('2026-12-30 12:00'));
  assert(drafts()[1] && dayNum(drafts()[1].at) - dayNum(at('2026-12-21 12:05')) >= 4, 'FU2 is 4+ days after you sent FU1');
});

test('old-style sheets keep working (headers with extra words, no Settings tab)', () => {
  const head = ['First Name', 'Last Name', 'Email', 'Subject', 'Intro (send today)', 'Follow-up 1 (day 3)', 'Follow-up 2 (day 7)', 'Follow-up 3 (day 14)', 'Notes'];
  const env = makeEnv({ sheets: [['Sheet1', [head, ['Al', 'B', 'al@x.com', 'S', 'hello', 'f1', 'f2', 'f3', 'n']]]] });
  env.run('tick()'); // fills Status/plan columns
  setCell(env.sheet('Sheet1'), 'Al', 'Next Send At', at('2026-11-17 09:00'));
  env.clock = at('2026-11-17 08:55');
  env.tickUntil(at('2026-11-17 09:30'));
  assert.strictEqual(env.log.filter(l => l.kind === 'intro')[0].body, 'hello');
  assert(cell(env.sheet('Sheet1'), 'Al', 'FU3 Planned') instanceof RealDate);
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`  ✓ ${t.name}`); } catch (e) { failed++; console.log(`  ✗ ${t.name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); }
}
console.log(failed ? `\n${failed} failed` : `\nAll ${tests.length} tests passed.`);
process.exit(failed ? 1 : 0);
