/**
 * スケジュールチェッカー（クラウド版 / Google Apps Script）
 *
 * 指定した人のGoogleカレンダーから今週・来週の予定を取得し、
 * 4カテゴリに仕分けして Google Chat に投稿します。
 *
 *   ●外部とのアポイント       ... 社外の相手とのアポ
 *   ◎リモートの外部アポイント ... 上記のうちオンライン実施のもの
 *   ◯内部ミーティング         ... 社内メンバー中心の打ち合わせ
 *   それ以外                  ... 終日・個人ブロックなど
 *
 * 使い方は同じフォルダの README_GAS.md を参照してください。
 */

// ============================================================
//  設定（ここだけ書き換えればOK）
// ============================================================

// チェックしたい人のメールアドレス（＝カレンダーID）
const TARGET_CALENDARS = [
  'takeda.ranza@lm-sg.com',
  'wang.yinghui@lm-sg.com',
];

// 「自社（内部）」とみなすメールのドメイン
const INTERNAL_DOMAINS = ['lm-sg.com'];

// 「リモート（オンライン）」と判定する手がかりワード
const ONLINE_KEYWORDS = [
  'zoom', 'meet', 'teams', 'webex', 'online', 'リモート',
  'オンライン', 'web会議', 'ウェブ', 'skype', 'hangout',
];

// タイトル等に含まれていたら「外部アポ」とみなす手がかりワード
const EXTERNAL_KEYWORDS = [
  '訪問', '商談', '来社', '来訪', '面談', 'アポ', '御社', '貴社',
];

// 取得する期間（今週の月曜から数えた週数）。2 なら今週＋来週。
const WEEKS = 2;

// Google Chat の Webhook URL（手順でコピーしたものを貼り付け）
const CHAT_WEBHOOK_URL = 'ここにGoogle ChatのWebhook URLを貼り付ける';

// ============================================================
//  ここから下は基本さわらなくてOK
// ============================================================

const CATEGORY_LABELS = [
  ['external', '●外部とのアポイント'],
  ['remote_external', '◎リモートの外部アポイント'],
  ['internal', '◯内部ミーティング'],
  ['other', 'それ以外'],
];

const TZ = 'Asia/Tokyo';
const WEEKDAY_JP = { '1': '月', '2': '火', '3': '水', '4': '木', '5': '金', '6': '土', '7': '日' };

/**
 * メインの処理。これを実行（またはトリガーで自動実行）する。
 */
function checkSchedules() {
  const { start, end } = weekRange_();
  let report = '📅 スケジュール仕分け（'
    + Utilities.formatDate(start, TZ, 'M/d') + '〜'
    + Utilities.formatDate(new Date(end.getTime() - 86400000), TZ, 'M/d')
    + ' 今週＋来週）';

  for (const cal of TARGET_CALENDARS) {
    report += '\n\n■ ' + cal + '\n--------------------\n';
    report += reportForCalendar_(cal, start, end);
  }

  postToChat_(report);
}

/**
 * 今週の月曜0:00 〜 WEEKS週間後の月曜0:00 を返す。
 */
function weekRange_() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  // 月曜まで戻す（getDay: 0=日,1=月,...,6=土）
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(end.getDate() + 7 * WEEKS);
  return { start: start, end: end };
}

function reportForCalendar_(calId, start, end) {
  const calendar = CalendarApp.getCalendarById(calId);
  if (!calendar) {
    return '　　⚠ このカレンダーにアクセスできません（共有設定を確認してください）\n';
  }

  const events = calendar.getEvents(start, end);
  const buckets = { external: [], remote_external: [], internal: [], other: [] };
  for (const ev of events) {
    buckets[categorize_(ev, calId)].push(ev);
  }

  let out = '';
  for (const pair of CATEGORY_LABELS) {
    const key = pair[0];
    const label = pair[1];
    out += '\n' + label + '\n';
    const items = buckets[key];
    if (items.length === 0) {
      out += '　　（なし）\n';
      continue;
    }
    items.sort(function (a, b) { return a.getStartTime() - b.getStartTime(); });
    for (const ev of items) {
      out += '　　- ' + fmtWhen_(ev) + '  ' + (ev.getTitle() || '(無題)') + '\n';
    }
  }
  return out;
}

function categorize_(ev, ownerEmail) {
  const guests = ev.getGuestList().map(function (g) { return g.getEmail(); })
    .filter(function (e) { return e; });
  const text = ((ev.getTitle() || '') + ' ' + (ev.getLocation() || '') + ' '
    + (ev.getDescription() || '')).toLowerCase();

  const hasExternalGuest = guests.some(function (e) { return !isInternal_(e); });
  const hasExternalKeyword = EXTERNAL_KEYWORDS.some(function (k) {
    return text.indexOf(k.toLowerCase()) >= 0;
  });

  if (hasExternalGuest || hasExternalKeyword) {
    return looksOnline_(text) ? 'remote_external' : 'external';
  }

  const others = guests.filter(function (e) {
    return e.toLowerCase() !== ownerEmail.toLowerCase();
  });
  return others.length > 0 ? 'internal' : 'other';
}

function isInternal_(email) {
  const at = email.indexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return INTERNAL_DOMAINS.indexOf(domain) >= 0;
}

function looksOnline_(text) {
  return ONLINE_KEYWORDS.some(function (k) { return text.indexOf(k.toLowerCase()) >= 0; });
}

function fmtWhen_(ev) {
  if (ev.isAllDayEvent()) {
    const d = ev.getAllDayStartDate();
    return Utilities.formatDate(d, TZ, 'M/d')
      + '(' + WEEKDAY_JP[Utilities.formatDate(d, TZ, 'u')] + ') 終日';
  }
  const s = ev.getStartTime();
  const e = ev.getEndTime();
  return Utilities.formatDate(s, TZ, 'M/d')
    + '(' + WEEKDAY_JP[Utilities.formatDate(s, TZ, 'u')] + ') '
    + Utilities.formatDate(s, TZ, 'HH:mm') + '–' + Utilities.formatDate(e, TZ, 'HH:mm');
}

function postToChat_(text) {
  if (!CHAT_WEBHOOK_URL || CHAT_WEBHOOK_URL.indexOf('http') !== 0) {
    Logger.log('Webhook URLが未設定です。結果をログに表示します:\n\n' + text);
    return;
  }
  // Google Chat は1メッセージ約4096文字まで。安全のため分割して送る。
  const chunks = splitMessage_(text, 3800);
  for (const chunk of chunks) {
    UrlFetchApp.fetch(CHAT_WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify({ text: chunk }),
    });
  }
}

function splitMessage_(text, limit) {
  if (text.length <= limit) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * 毎週月曜の朝8時台に自動実行する設定を作る。
 * （1回だけ手動で実行すればOK）
 */
function createWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkSchedules') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('checkSchedules')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();
  Logger.log('毎週月曜の朝8時台に自動実行するよう設定しました。');
}
