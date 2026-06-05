#!/usr/bin/env python3
"""指定した人のGoogleカレンダーを取得し、今週・来週の予定をカテゴリ分けして表示するツール。

カテゴリー:
  ●外部とのアポイント        ... 社外の相手とのアポ
  ◎リモートの外部アポイント  ... 上記のうちオンライン実施のもの
  ◯内部ミーティング          ... 社内メンバー中心の打ち合わせ
  それ以外                   ... 上記に当てはまらない予定（終日・個人ブロック等）

使い方:
  1) README.md の手順で credentials.json を用意する
  2) python schedule_checker.py を実行する
  3) 初回はブラウザでGoogleにログインして「許可」を押す
"""

import datetime
import os
import sys
from collections import defaultdict
from zoneinfo import ZoneInfo

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# ============================================================
#  設定（ここを書き換えるだけで使えます）
# ============================================================

# チェックしたい人のメールアドレス（＝GoogleカレンダーのカレンダーID）
TARGET_CALENDARS = [
    "takeda.ranza@lm-sg.com",
    "wang.yinghui@lm-sg.com",
]

# 「自社（内部）」とみなすメールのドメイン。複数あれば足してください。
INTERNAL_DOMAINS = [
    "lm-sg.com",
]

# 「リモート（オンライン）」と判定するための手がかりワード
ONLINE_KEYWORDS = [
    "zoom", "meet", "teams", "webex", "online", "リモート",
    "オンライン", "web会議", "ウェブ", "skype", "hangout", "google meet",
]

# タイトル等に含まれていたら「外部アポ」とみなす手がかりワード
# （参加者に社外の人がいなくても、タイトルで外部アポと分かる場合に拾う）
EXTERNAL_KEYWORDS = [
    "訪問", "商談", "来社", "来訪", "面談", "アポ", "御社", "貴社",
]

# 期間: 今日を含む「今週の月曜」から数えて2週間分（今週＋来週）
WEEKS = 2

TIMEZONE = "Asia/Tokyo"
SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]

# ============================================================
#  ここから下は基本さわらなくてOK
# ============================================================

JP_WEEK = ["月", "火", "水", "木", "金", "土", "日"]

CATEGORY_LABELS = [
    ("external", "●外部とのアポイント"),
    ("remote_external", "◎リモートの外部アポイント"),
    ("internal", "◯内部ミーティング"),
    ("other", "それ以外"),
]


def get_service():
    """Googleカレンダーに接続する。初回はブラウザでログインを求める。"""
    creds = None
    if os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists("credentials.json"):
                sys.exit(
                    "credentials.json が見つかりません。\n"
                    "README.md の手順に従ってGoogleからダウンロードし、"
                    "このスクリプトと同じフォルダに置いてください。"
                )
            flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
            creds = flow.run_local_server(port=0)
        with open("token.json", "w") as token:
            token.write(creds.to_json())
    return build("calendar", "v3", credentials=creds)


def time_bounds():
    """今週の月曜0時 〜 WEEKS週間後の月曜0時（JST）を返す。"""
    tz = ZoneInfo(TIMEZONE)
    today = datetime.datetime.now(tz).date()
    monday = today - datetime.timedelta(days=today.weekday())
    end = monday + datetime.timedelta(days=7 * WEEKS)
    start_dt = datetime.datetime.combine(monday, datetime.time.min, tz)
    end_dt = datetime.datetime.combine(end, datetime.time.min, tz)
    return start_dt, end_dt


def domain_of(email):
    return email.split("@")[-1].lower() if email and "@" in email else ""


def is_internal(email):
    return domain_of(email) in INTERNAL_DOMAINS


def real_attendees(event):
    """会議室などのリソースを除いた、実在の参加者だけを返す。"""
    return [
        a for a in event.get("attendees", [])
        if a.get("email") and not a.get("resource")
    ]


def has_external(attendees):
    return any(not is_internal(a.get("email", "")) for a in attendees)


def event_text(event):
    return " ".join([
        event.get("summary", "") or "",
        event.get("location", "") or "",
        event.get("description", "") or "",
    ]).lower()


def looks_online(event):
    if event.get("hangoutLink") or event.get("conferenceData"):
        return True
    text = event_text(event)
    return any(k.lower() in text for k in ONLINE_KEYWORDS)


def categorize(event, owner_email):
    attendees = real_attendees(event)
    text = event_text(event)
    external = has_external(attendees) or any(k.lower() in text for k in EXTERNAL_KEYWORDS)

    if external:
        return "remote_external" if looks_online(event) else "external"

    # 社外の人がいない場合
    others = [
        a for a in attendees
        if a.get("email", "").lower() != owner_email.lower()
    ]
    if others:
        return "internal"
    return "other"


def fmt_when(event):
    """予定の日時を「6/9(月) 14:00–15:00」の形にする。"""
    start = event["start"]
    if "date" in start:  # 終日予定
        d = datetime.date.fromisoformat(start["date"])
        return f"{d.month}/{d.day}({JP_WEEK[d.weekday()]}) 終日"
    sd = datetime.datetime.fromisoformat(start["dateTime"])
    ed = datetime.datetime.fromisoformat(event["end"]["dateTime"])
    return f"{sd.month}/{sd.day}({JP_WEEK[sd.weekday()]}) {sd:%H:%M}–{ed:%H:%M}"


def fetch_events(service, calendar_id, start_dt, end_dt):
    events_result = service.events().list(
        calendarId=calendar_id,
        timeMin=start_dt.isoformat(),
        timeMax=end_dt.isoformat(),
        singleEvents=True,
        orderBy="startTime",
    ).execute()
    return events_result.get("items", [])


def main():
    service = get_service()
    start_dt, end_dt = time_bounds()
    last_day = end_dt - datetime.timedelta(days=1)

    print("=" * 50)
    print("  Googleカレンダー 予定カテゴリ分け")
    print(f"  期間: {start_dt.month}/{start_dt.day} 〜 {last_day.month}/{last_day.day}"
          f"（今週＋来週）")
    print("=" * 50)

    for cal in TARGET_CALENDARS:
        print(f"\n\n■ {cal}")
        print("-" * 50)
        try:
            events = fetch_events(service, cal, start_dt, end_dt)
        except HttpError as err:
            print(f"  ⚠ このカレンダーを取得できませんでした: {err}")
            print("    → 共有設定（あなたへの閲覧権限）を確認してください。")
            continue

        buckets = defaultdict(list)
        for ev in events:
            if ev.get("status") == "cancelled":
                continue
            buckets[categorize(ev, cal)].append(ev)

        for key, label in CATEGORY_LABELS:
            print(f"\n{label}")
            items = buckets.get(key, [])
            if not items:
                print("　　（なし）")
                continue
            for ev in items:
                print(f"　　- {fmt_when(ev)}  {ev.get('summary', '(無題)')}")

    print("\n")


if __name__ == "__main__":
    main()
