/**
 * Sheet Sequencer: personalized Gmail outreach with automatic follow-ups, run from a Google Sheet.
 * https://github.com/tmoula/gmail-followup-sequencer  (MIT License)
 *
 * Each row is a person. You write an intro and any number of follow-ups (columns "Follow-up 1",
 * "Follow-up 2", ...). Every email goes out at a random weekday-morning time, follow-ups are sent
 * as replies in the same Gmail thread, and the sequence stops as soon as the person replies.
 *
 * Setup: open the sheet, use the "Sequencer" menu > "Set up this sheet". See README.md.
 */

/* ============================================================== settings */

// Defaults, used when the Settings tab is missing a value.
const DEFAULTS = {
  mode: 'draft',            // 'draft' = follow-ups wait in Gmail Drafts; 'send' = sent automatically
  days: [3, 7, 14],         // days after the intro for each follow-up
  windowStart: '8:30',      // random send time window (24h, spreadsheet time zone)
  windowEnd: '11:30',
  skipWeekends: true,
  summaryEmail: true,       // email yourself when follow-up drafts are ready
  maxPerDay: 50,            // safety cap on emails sent per day
};

const SETTINGS_SHEET = 'Settings';
const SETTINGS_ROWS = [
  ['Follow-up mode', 'draft',
    '"draft" = each follow-up is created in your Gmail Drafts for you to review and send. "send" = follow-ups go out automatically.'],
  ['Follow-up days', '3, 7, 14',
    'Days after the intro for each follow-up, in order. One number per "Follow-up" column.'],
  ['Send window start', '8:30', 'Every email gets a random time between start and end (24-hour clock, this spreadsheet\'s time zone).'],
  ['Send window end', '11:30', ''],
  ['Skip weekends', true, 'Never send on Saturday or Sunday; moves to Monday.'],
  ['Email me a summary', true, 'In draft mode, email yourself when follow-up drafts are ready.'],
  ['Max emails per day', 50, 'Safety cap. Gmail allows roughly 100/day on free accounts and 1,500/day on Google Workspace.'],
];

// Columns the script adds and maintains on each campaign tab.
const TRACK = {
  status: 'Status',
  threadId: 'Thread ID',
  introSent: 'Intro Sent',
  step: 'Follow-ups Done',
  nextSend: 'Next Send At',
};
const PLAN_HEADER = k => `FU${k + 1} Planned`;

const FINISHED = /replied|bounced|done|stop|not found/i;
const CHECK_EVERY_MINUTES = 5;
const LATE_GRACE_MINUTES = 30;   // a send more than this late (scheduler was off) is moved to the next window
const DATE_FORMAT = 'ddd mmm d, h:mm am/pm';

/* ================================================================== menu */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Sequencer')
    .addItem('Set up this sheet', 'setup')
    .addSeparator()
    .addItem('Schedule intros for next weekday morning', 'scheduleIntros')
    .addItem('Send intros now', 'sendIntrosNow')
    .addItem('Preview: send the first row\'s sequence to me', 'previewToMe')
    .addSeparator()
    .addItem('Pause all sending', 'pause')
    .addItem('Resume sending', 'resume')
    .addItem('Run check now', 'tick')
    .addToUi();
}

/* ================================================================= setup */

/** One-click setup: Settings tab, campaign columns (with an example row), Gmail check, scheduler. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  ensureSettingsSheet_(ss);

  let sheet = ss.getActiveSheet();
  if (sheet.getName() === SETTINGS_SHEET) {
    sheet = ss.getSheets().find(s => s.getName() !== SETTINGS_SHEET) || ss.insertSheet(freeName_(ss, 'Campaign'));
  }
  if (!campaign_(sheet)) {
    // Never overwrite a tab that already has data: start the template on a new tab instead.
    if (sheet.getLastRow() > 0) sheet = ss.insertSheet(freeName_(ss, 'Campaign'));
    writeTemplate_(sheet);
  }
  campaign_(sheet); // adds the tracking columns
  styleCampaign_(sheet);
  ss.setActiveSheet(sheet);

  if (!gmailServiceOn_()) {
    ui.alert('One more step: turn on the Gmail service',
      'Follow-ups are sent as replies in the same thread, which needs Gmail\'s advanced service.\n\n' +
      '1. Extensions > Apps Script\n' +
      '2. In the left sidebar, click "+" next to "Services"\n' +
      '3. Choose "Gmail API" and click "Add"\n\n' +
      'Then run "Set up this sheet" again.', ui.ButtonSet.OK);
    return;
  }
  installTrigger_();
  ui.alert('You\'re set up',
    `Campaign tab: "${sheet.getName()}". Settings tab: "${SETTINGS_SHEET}".\n\n` +
    '1. Fill in one row per person (keep the column names). Use {{Column Name}} to personalize.\n' +
    '2. Sequencer > Preview: sends the first row\'s whole sequence to you.\n' +
    '3. Sequencer > Schedule intros: picks a random morning time for each person.\n\n' +
    'Every email\'s time is shown in "Next Send At" and the "FU Planned" columns. Edit any of them to move an email. ' +
    'Type "stop" in someone\'s Status to stop their sequence.', ui.ButtonSet.OK);
}

function ensureSettingsSheet_(ss) {
  let sh = ss.getSheetByName(SETTINGS_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(SETTINGS_SHEET);
  sh.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'What it does']]).setFontWeight('bold');
  sh.getRange(2, 2, SETTINGS_ROWS.length, 1).setNumberFormat('@'); // keep "8:30" and "3, 7, 14" as text
  sh.getRange(2, 1, SETTINGS_ROWS.length, 3).setValues(SETTINGS_ROWS);
  SETTINGS_ROWS.forEach((r, i) => {
    if (typeof r[1] === 'boolean') sh.getRange(i + 2, 2).setNumberFormat('General').insertCheckboxes().setValue(r[1]);
    if (typeof r[1] === 'number') sh.getRange(i + 2, 2).setNumberFormat('0').setValue(r[1]);
  });
  sh.setColumnWidth(1, 170); sh.setColumnWidth(2, 110); sh.setColumnWidth(3, 560);
  sh.getRange(2, 3, SETTINGS_ROWS.length, 1).setWrap(true);
  sh.setFrozenRows(1);
  return sh;
}

function writeTemplate_(sheet) {
  const me = Session.getEffectiveUser().getEmail();
  const headers = ['First Name', 'Last Name', 'Email', 'Company', 'Subject', 'Intro', 'Follow-up 1', 'Follow-up 2', 'Follow-up 3'];
  const example = ['Sam', 'Example', me, 'Acme', 'Quick question, {{First Name}}',
    'Hi {{First Name}},\n\nGreat meeting you last week. I\'d love to hear how {{Company}} handles this today.\n\nWould you be open to a 20-minute call?\n\nBest,\nYour Name',
    'Hi {{First Name}} - following up on my note below. Would a quick call next week work?',
    'Hi {{First Name}} - one more idea I thought {{Company}} might find useful: ...',
    'Hi {{First Name}} - last note from me. If now isn\'t the right time, no worries at all.'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(2, 1, 1, example.length).setValues([example]);
}

function styleCampaign_(sheet) {
  const lastCol = sheet.getLastColumn();
  sheet.getRange(1, 1, 1, lastCol).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).setVerticalAlignment('top');
}

function freeName_(ss, base) {
  let name = base;
  for (let i = 2; ss.getSheetByName(name); i++) name = `${base} ${i}`;
  return name;
}

function gmailServiceOn_() {
  return typeof Gmail !== 'undefined' && Gmail.Users && Gmail.Users.Messages;
}

/* ================================================================ intros */

function pendingIntros_(c) {
  return c.rows.filter(r =>
    r.get('email') && r.get('intro') && !r.get('threadId') && !FINISHED.test(r.get('status')));
}

/** Gives every unsent row on the active tab a random time on the next weekday morning. */
function scheduleIntros() {
  const s = settings_();
  const c = activeCampaign_();
  if (!c) return;
  const rows = pendingIntros_(c);
  if (!rows.length) return toast_('No new rows to schedule.');
  const day = nextWorkday_(addDays_(new Date(), 1), s);
  const lines = rows.map(r => {
    const at = randomTimeOn_(day, s);
    r.set('nextSend', at);
    r.set('status', 'Intro scheduled');
    plan_(r, c, s, at, 0);
    const fus = c.plans.map((_, k) => `FU${k + 1} ${fmt_(toDate_(r.get('plan', k)))}`);
    return `${label_(r)}: intro ${fmt_(at)}${fus.length ? '\n    ' + fus.join(' | ') : ''}`;
  });
  installTrigger_();
  alert_('Intros scheduled', lines.join('\n') +
    `\n\nTo change a time, edit "Next Send At" or an "FU Planned" cell (e.g. ${fmtDay_(day)} 9:23).` +
    '\nTo cancel someone, type "stop" in their Status cell.');
}

/** Sends every unsent intro on the active tab right now (after confirmation). */
function sendIntrosNow() {
  const s = settings_();
  const c = activeCampaign_();
  if (!c) return;
  const rows = pendingIntros_(c);
  if (!rows.length) return toast_('No new rows to send.');
  const ui = SpreadsheetApp.getUi();
  const names = rows.map(r => `${label_(r)} <${r.get('email')}>`).join('\n');
  if (ui.alert('Send these intros right now?', names, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const now = new Date();
  let sent = 0;
  rows.forEach(r => { if (sendIntro_(r, c, s, now)) sent++; });
  installTrigger_();
  toast_(`Sent ${sent} intro(s). Follow-ups are scheduled.`);
}

function sendIntro_(r, c, s, now) {
  const subject = render_(r.get('subject'), r, c);
  const body = render_(r.get('intro'), r, c);
  const missing = subject.missing.concat(body.missing);
  if (missing.length) { r.set('status', needsFix_(missing)); return false; }
  if (!underDailyCap_(s)) { postpone_(r, c, s, now); return false; }

  const msg = GmailApp.createDraft(r.get('email'), subject.text, body.text).send();
  countSend_();
  r.set('threadId', msg.getThread().getId());
  r.set('introSent', now);
  r.set('step', 0);
  r.set('status', `Intro sent ${fmt_(now)}`);
  if (c.plans.length) {
    plan_(r, c, s, now, 0);
    r.set('nextSend', toDate_(r.get('plan', 0)));
  } else {
    r.set('nextSend', randomTimeOn_(nextWorkday_(addDays_(now, 7), s), s));
  }
  return true;
}

/* ============================================================= scheduler */

/** Runs every few minutes from a trigger. Sends whatever is due on every campaign tab. */
function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  const started = Date.now();
  try {
    const s = settings_();
    const now = new Date();
    const ctx = { me: null, draftThreads: null, queued: [] };

    campaigns_().forEach(c => {
      const active = c.rows.filter(r => r.get('email') && !FINISHED.test(r.get('status')));
      // Scheduled-but-unsent intros: make sure their whole follow-up plan is filled in and visible.
      active.forEach(r => {
        const introAt = !r.get('threadId') && toDate_(r.get('nextSend'));
        if (introAt) plan_(r, c, s, introAt, 0);
      });

      active.forEach(r => {
        if (Date.now() - started > 4.5 * 60 * 1000) return; // stay under Apps Script's 6-minute limit
        const at = dueAt_(r, c);
        if (!at || at > now) return;
        // Way past due (scheduler was paused or off): don't send at an odd hour, move it to the next window.
        if (now - at > LATE_GRACE_MINUTES * 60 * 1000) return postpone_(r, c, s, now);

        if (!r.get('threadId')) return sendIntro_(r, c, s, now);
        ctx.me = ctx.me || myAddresses_();
        ctx.draftThreads = ctx.draftThreads ||
          new Set(GmailApp.getDrafts().map(d => d.getMessage().getThread().getId()));
        followUp_(r, c, s, now, ctx);
      });
    });

    if (ctx.queued.length && s.mode === 'draft' && s.summaryEmail) {
      GmailApp.sendEmail(ctx.me[0], `Follow-up drafts ready (${ctx.queued.length})`,
        'These follow-ups are waiting in your Drafts, already threaded under your intro:\n\n' +
        ctx.queued.map(q => `- ${q}`).join('\n') +
        '\n\nReview and send: https://mail.google.com/mail/u/0/#drafts');
    }
  } finally {
    lock.releaseLock();
  }
}

/** When this row's next action is due. */
function dueAt_(r, c) {
  if (!r.get('threadId')) return toDate_(r.get('nextSend'));
  const step = Number(r.get('step')) || 0;
  if (step >= c.plans.length) return toDate_(r.get('nextSend')); // final reply check
  const at = toDate_(r.get('plan', step)) || toDate_(r.get('nextSend'));
  if (at) r.set('nextSend', at); // keep "Next Send At" in sync if a plan cell was edited
  return at;
}

function followUp_(r, c, s, now, ctx) {
  const threadId = r.get('threadId');
  const thread = GmailApp.getThreadById(threadId);
  if (!thread) return finish_(r, c, 'Thread not found');

  const outcome = detectReply_(thread, r.get('email').toLowerCase(), ctx.me, toDate_(r.get('introSent')));
  if (outcome) return finish_(r, c, `${outcome} ${fmtDay_(now)}`);

  const step = Number(r.get('step')) || 0;
  if (step >= c.plans.length) return finish_(r, c, 'Done - no reply');

  // A follow-up drafted earlier hasn't been sent yet: wait for you.
  if (ctx.draftThreads.has(threadId)) return r.set('status', `FU${step} draft waiting in Gmail`);

  // Count the gap from the last email actually sent (matters in draft mode, where you may send late).
  const lastMine = lastSentByMe_(thread, ctx.me) || now;
  const earliest = dayStart_(addDays_(lastMine, gapBefore_(s, step)));
  if (dayStart_(now) < earliest) {
    plan_(r, c, s, lastMine, step);
    return r.set('nextSend', toDate_(r.get('plan', step)));
  }

  const raw = r.get('fu', step);
  if (raw) {
    const body = render_(raw, r, c);
    if (body.missing.length) return r.set('status', needsFix_(body.missing));
    const asDraft = s.mode === 'draft';
    if (!asDraft && !underDailyCap_(s)) return postpone_(r, c, s, now);
    replyInThread_(thread, r.get('email'), render_(r.get('subject'), r, c).text, body.text, asDraft);
    if (!asDraft) countSend_();
    r.set('status', `FU${step + 1} ${asDraft ? 'drafted' : 'sent'} ${fmt_(now)}`);
    ctx.queued.push(`${label_(r)} - follow-up ${step + 1}`);
  } else {
    r.set('status', `FU${step + 1} is empty - skipped`);
  }
  r.set('step', step + 1);

  // Next follow-up, or one last check a week later to record Replied / Done.
  if (step + 1 < c.plans.length) {
    plan_(r, c, s, now, step + 1);
    r.set('nextSend', toDate_(r.get('plan', step + 1)));
  } else {
    r.set('nextSend', randomTimeOn_(nextWorkday_(addDays_(now, 7), s), s));
  }
}

/**
 * Makes sure follow-ups startStep..end each have a planned time, at least the right number of days
 * after the previous email. Keeps times that are already valid, including ones typed by hand.
 */
function plan_(r, c, s, from, startStep) {
  let prev = from;
  for (let k = startStep; k < c.plans.length; k++) {
    const earliest = dayStart_(addDays_(prev, gapBefore_(s, k)));
    let at = toDate_(r.get('plan', k));
    if (!at || at < earliest) {
      at = randomTimeOn_(nextWorkday_(earliest, s), s);
      r.set('plan', at, k);
    }
    prev = at;
  }
}

/** Days between follow-up k and the email before it. Extra follow-ups beyond the settings list are a week apart. */
function gapBefore_(s, k) {
  const day = i => (i < s.days.length ? s.days[i] : s.days[s.days.length - 1] + 7 * (i - s.days.length + 1));
  return k === 0 ? day(0) : day(k) - day(k - 1);
}

/** Moves a row's next email to a random time on the next weekday morning (cap reached or too late). */
function postpone_(r, c, s, now) {
  const at = randomTimeOn_(nextWorkday_(addDays_(now, 1), s), s);
  const step = Number(r.get('step')) || 0;
  if (r.get('threadId') && step < c.plans.length) {
    r.set('plan', at, step);
    plan_(r, c, s, at, step + 1);
  } else if (!r.get('threadId')) {
    plan_(r, c, s, at, 0);
  }
  r.set('nextSend', at);
}

/** Stops the sequence: records the status and clears times for emails that will no longer go out. */
function finish_(r, c, status) {
  r.set('status', status);
  r.set('nextSend', '');
  for (let k = Number(r.get('step')) || 0; k < c.plans.length; k++) r.set('plan', '', k);
}

/* ========================================================= reply checks */

/** Returns 'Replied', 'Replied (separate email)', 'Bounced', or '' if no reply yet. */
function detectReply_(thread, email, me, introSent) {
  for (const m of thread.getMessages()) {
    if (m.isDraft()) continue;
    const from = addr_(m.getFrom());
    if (/mailer-daemon|postmaster/.test(from)) return 'Bounced';
    if (me.indexOf(from) !== -1) continue;
    if (isAutoReply_(m)) continue; // out-of-office etc. doesn't stop the sequence
    return 'Replied';
  }
  // They may have answered with a brand-new email instead of replying in the thread.
  if (introSent) {
    const since = Math.floor(introSent.getTime() / 1000);
    const hits = GmailApp.search(`from:${email} after:${since}`, 0, 5);
    if (hits.some(th => th.getMessages().some(m => addr_(m.getFrom()) === email && !isAutoReply_(m)))) {
      return 'Replied (separate email)';
    }
  }
  return '';
}

function isAutoReply_(m) {
  const auto = (m.getHeader('Auto-Submitted') || '').toLowerCase();
  if (auto && auto !== 'no') return true;
  return /^(automatic reply|auto(-| )?reply|out of (the )?office)/i.test(m.getSubject());
}

function lastSentByMe_(thread, me) {
  const mine = thread.getMessages().filter(m => !m.isDraft() && me.indexOf(addr_(m.getFrom())) !== -1);
  return mine.length ? mine[mine.length - 1].getDate() : null;
}

/* ============================================================== sending */

/**
 * Sends (or drafts) a reply inside the existing thread, addressed to the contact.
 * Uses the Gmail advanced service because GmailApp's reply() on your own sent
 * message would address it back to you.
 */
function replyInThread_(thread, to, subject, body, asDraft) {
  if (!gmailServiceOn_()) throw new Error('Turn on the Gmail service: Extensions > Apps Script > Services > + > Gmail API.');
  const msgs = thread.getMessages().filter(m => !m.isDraft());
  const ids = msgs.map(msgId_).filter(Boolean);
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeHeader_(subj)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (ids.length) {
    headers.push(`In-Reply-To: ${ids[ids.length - 1]}`);
    headers.push(`References: ${ids.join(' ')}`);
  }
  const encodedBody = Utilities.base64Encode(body, Utilities.Charset.UTF_8).replace(/(.{76})/g, '$1\r\n');
  const mime = headers.join('\r\n') + '\r\n\r\n' + encodedBody;
  const message = {
    raw: Utilities.base64EncodeWebSafe(mime, Utilities.Charset.UTF_8),
    threadId: thread.getId(),
  };
  if (asDraft) Gmail.Users.Drafts.create({ message: message }, 'me');
  else Gmail.Users.Messages.send(message, 'me');
}

function underDailyCap_(s) {
  if (MailApp.getRemainingDailyQuota() < 1) return false;
  const n = Number(PropertiesService.getScriptProperties().getProperty(sentKey_()) || 0);
  return n < s.maxPerDay;
}

function countSend_() {
  const props = PropertiesService.getScriptProperties();
  const key = sentKey_();
  props.setProperty(key, String(Number(props.getProperty(key) || 0) + 1));
}

function sentKey_() {
  return 'sent:' + ymd_(new Date());
}

/* =========================================================== templating */

/**
 * Replaces {{Column Name}} with that row's value (case and spacing don't matter).
 * Returns { text, missing } where missing lists placeholders with no value.
 */
function render_(text, r, c) {
  const missing = [];
  const out = String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (all, name) => {
    const col = c.byName[norm_(name)];
    const v = col === undefined ? '' : r.raw(col);
    const str = v instanceof Date ? Utilities.formatDate(v, tz_(), 'MMMM d') : String(v == null ? '' : v).trim();
    if (!str) missing.push(`{{${name}}}`);
    return str;
  });
  return { text: out, missing };
}

function needsFix_(missing) {
  return `Needs fix: ${missing.join(', ')} is empty or not a column`;
}

function norm_(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ============================================================== preview */

/** Sends the first row's intro and all follow-ups to you right now, so you can check wording and threading. */
function previewToMe() {
  const c = activeCampaign_();
  if (!c) return;
  const r = c.rows.find(x => x.get('intro'));
  if (!r) return toast_('No row with an intro to preview.');
  const me = myAddresses_()[0];
  const subject = render_(r.get('subject'), r, c);
  const intro = render_(r.get('intro'), r, c);
  const thread = GmailApp.createDraft(me, `[PREVIEW] ${subject.text}`, intro.text).send().getThread();
  const missing = subject.missing.concat(intro.missing);
  c.plans.forEach((_, k) => {
    const raw = r.get('fu', k);
    if (!raw) return;
    const body = render_(raw, r, c);
    missing.push(...body.missing);
    Utilities.sleep(1500);
    replyInThread_(GmailApp.getThreadById(thread.getId()), me, `[PREVIEW] ${subject.text}`, body.text, false);
  });
  alert_('Preview sent', `Check your inbox (${me}) for "[PREVIEW] ${subject.text}", using ${label_(r)}'s row.` +
    (missing.length ? `\n\nWarning: these placeholders were empty: ${[...new Set(missing)].join(', ')}` : ''));
}

/* ============================================================= triggers */

function resume() {
  if (!gmailServiceOn_()) return alert_('Gmail service is off', 'Run Sequencer > Set up this sheet first.');
  installTrigger_();
  toast_(`Sending is on. Checking every ${CHECK_EVERY_MINUTES} minutes.`);
}

function pause() {
  removeTriggers_();
  toast_('Paused. Nothing will be sent until you choose Resume sending.');
}

function installTrigger_() {
  removeTriggers_();
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(CHECK_EVERY_MINUTES).create();
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(tr => ['tick', 'runFollowUps'].indexOf(tr.getHandlerFunction()) !== -1)
    .forEach(tr => ScriptApp.deleteTrigger(tr));
}

/* ============================================================ sheet I/O */

/** All tabs that look like campaigns (have Email + Intro columns). */
function campaigns_() {
  return SpreadsheetApp.getActive().getSheets()
    .filter(sh => sh.getName() !== SETTINGS_SHEET)
    .map(campaign_)
    .filter(Boolean);
}

function activeCampaign_() {
  const c = campaign_(SpreadsheetApp.getActive().getActiveSheet());
  if (!c) alert_('Not a campaign tab', 'Open a tab with "Email" and "Intro" columns, or run Sequencer > Set up this sheet.');
  return c;
}

/** Reads a campaign tab. Returns null if it doesn't have the required columns. */
function campaign_(sheet) {
  if (!sheet || sheet.getName() === SETTINGS_SHEET || sheet.getLastColumn() < 1 || sheet.getLastRow() < 1) return null;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const findFirst = test => headers.findIndex(h => test(h.toLowerCase()));
  const emailCol = findFirst(h => h === 'email' || h.startsWith('email '));
  const introCol = findFirst(h => h.startsWith('intro'));
  if (emailCol < 0 || introCol < 0) return null;

  // Follow-up columns: "Follow-up 1", "Followup 2 (day 7)", "Follow up 3", ... in number order.
  const fu = headers
    .map((h, i) => ({ i, m: h.match(/^follow[\s-]?up\s*(\d+)/i) }))
    .filter(x => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map(x => x.i);

  const wanted = Object.values(TRACK).concat(fu.map((_, k) => PLAN_HEADER(k)));
  wanted.forEach(h => {
    if (headers.indexOf(h) === -1) {
      headers.push(h);
      sheet.getRange(1, headers.length).setValue(h).setFontWeight('bold');
    }
  });

  const idx = {
    first: findFirst(h => h.startsWith('first name') || h === 'first' || h === 'name'),
    email: emailCol,
    subject: findFirst(h => h.startsWith('subject')),
    intro: introCol,
    fu,
    plan: fu.map((_, k) => headers.indexOf(PLAN_HEADER(k))),
  };
  Object.keys(TRACK).forEach(k => { idx[k] = headers.indexOf(TRACK[k]); });

  const byName = {};
  headers.forEach((h, i) => { if (byName[norm_(h)] === undefined) byName[norm_(h)] = i; });

  const n = sheet.getLastRow() - 1;
  const values = n > 0 ? sheet.getRange(2, 1, n, headers.length).getValues() : [];
  const colOf = (key, k) => (Array.isArray(idx[key]) ? idx[key][k] : idx[key]);
  const same = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

  const rows = values.map((row, i) => ({
    raw: col => row[col],
    get: (key, k) => {
      const c = colOf(key, k);
      if (c === undefined || c < 0) return '';
      const v = row[c];
      return v instanceof Date ? v : String(v == null ? '' : v).trim();
    },
    set: (key, v, k) => {
      const c = colOf(key, k);
      if (same(row[c], v)) return;
      row[c] = v;
      const cell = sheet.getRange(i + 2, c + 1);
      cell.setValue(v);
      if (v instanceof Date) cell.setNumberFormat(DATE_FORMAT);
    },
  }));
  return { sheet, rows, plans: idx.plan, byName };
}

/** Reads the Settings tab, falling back to DEFAULTS for anything missing or invalid. */
function settings_() {
  const s = Object.assign({}, DEFAULTS);
  const sh = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
  if (!sh || sh.getLastRow() < 2) return s;
  const map = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(([k, v]) => { map[norm_(k)] = v; });
  const has = k => map[k] !== undefined && map[k] !== '';

  if (has('followupmode')) s.mode = /send|auto/i.test(String(map.followupmode)) ? 'send' : 'draft';
  if (has('followupdays')) {
    const days = String(map.followupdays).split(/[^0-9]+/).filter(Boolean).map(Number);
    if (days.length && days.every((d, i) => d > 0 && (i === 0 || d > days[i - 1]))) s.days = days;
  }
  if (has('sendwindowstart')) s.windowStart = timeText_(map.sendwindowstart) || s.windowStart;
  if (has('sendwindowend')) s.windowEnd = timeText_(map.sendwindowend) || s.windowEnd;
  if (has('skipweekends')) s.skipWeekends = bool_(map.skipweekends);
  if (has('emailmeasummary')) s.summaryEmail = bool_(map.emailmeasummary);
  if (has('maxemailsperday') && Number(map.maxemailsperday) > 0) s.maxPerDay = Number(map.maxemailsperday);
  if (parseHM_(s.windowEnd) <= parseHM_(s.windowStart)) { s.windowStart = DEFAULTS.windowStart; s.windowEnd = DEFAULTS.windowEnd; }
  return s;
}

function timeText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'H:mm');
  const m = String(v).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return '';
  let h = Number(m[1]);
  if (m[3] && /pm/i.test(m[3]) && h < 12) h += 12;
  if (m[3] && /am/i.test(m[3]) && h === 12) h = 0;
  return `${h}:${m[2] || '00'}`;
}

function bool_(v) {
  return v === true || /^(true|yes|y|1|on)$/i.test(String(v).trim());
}

/* ======================================================= time (sheet TZ) */

// All scheduling happens in the spreadsheet's time zone (File > Settings), so the script's own
// time zone doesn't matter and there's nothing to configure.
let TZ_CACHE_ = null;
function tz_() {
  if (!TZ_CACHE_) TZ_CACHE_ = SpreadsheetApp.getActive().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  return TZ_CACHE_;
}

function ymd_(d) {
  return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
}

function atMinute_(ymd, minute) {
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return Utilities.parseDate(`${ymd} ${hh}:${mm}`, tz_(), 'yyyy-MM-dd HH:mm');
}

function dayStart_(d) {
  return Utilities.parseDate(ymd_(d), tz_(), 'yyyy-MM-dd');
}

/** Same wall-clock time, n calendar days later (DST-safe). */
function addDays_(d, n) {
  const [y, m, day] = ymd_(d).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
  return Utilities.parseDate(`${target} ${Utilities.formatDate(d, tz_(), 'HH:mm')}`, tz_(), 'yyyy-MM-dd HH:mm');
}

function isWeekend_(d) {
  return Number(Utilities.formatDate(d, tz_(), 'u')) >= 6; // 1 = Monday ... 7 = Sunday
}

function nextWorkday_(d, s) {
  let x = d;
  while (s.skipWeekends && isWeekend_(x)) x = addDays_(x, 1);
  return x;
}

function parseHM_(str) {
  const [h, m] = String(str).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** A random minute inside the send window on the given day. */
function randomTimeOn_(day, s) {
  const start = parseHM_(s.windowStart);
  const end = parseHM_(s.windowEnd);
  return atMinute_(ymd_(day), start + Math.floor(Math.random() * Math.max(1, end - start)));
}

/* ============================================================== helpers */

function toDate_(v) {
  if (v instanceof Date) return v;
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function label_(r) {
  return r.get('first') || r.get('email');
}

function myAddresses_() {
  return [Session.getEffectiveUser().getEmail()].concat(GmailApp.getAliases()).map(a => a.toLowerCase());
}

function msgId_(m) {
  return m.getHeader('Message-ID') || m.getHeader('Message-Id') || '';
}

function addr_(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim().toLowerCase();
}

function encodeHeader_(s) {
  return /[^\x00-\x7F]/.test(s) ? `=?UTF-8?B?${Utilities.base64Encode(s, Utilities.Charset.UTF_8)}?=` : s;
}

function fmt_(d) {
  return d ? Utilities.formatDate(d, tz_(), 'EEE MMM d, h:mm a') : '';
}

function fmtDay_(d) {
  return Utilities.formatDate(d, tz_(), 'M/d/yyyy');
}

function toast_(msg) {
  try { SpreadsheetApp.getActive().toast(msg, 'Sequencer', 8); } catch (e) { Logger.log(msg); }
}

function alert_(title, msg) {
  try { SpreadsheetApp.getUi().alert(title, msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { Logger.log(`${title}: ${msg}`); }
}
