"""Arda Güler gol/asist botu.

GitHub Actions cron ile çalışır. Takip edilen takımların (Real Madrid, Türkiye)
canlı maçlarını ESPN'den okur, Arda Güler'in yeni gol/asistini bulunca ntfy
kanalına bildirim gönderir. Görülen olay id'leri state/seen.json içinde tutulur.
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

ATHLETE_ID = "310452"
TEAM_IDS = {"86", "465"}
TOPIC = os.environ.get("NTFY_TOPIC", "arda-guler-gol-mmk34")
NTFY_URL = os.environ.get("NTFY_URL", "https://ntfy.sh")
STATE_PATH = os.path.join(os.path.dirname(__file__), "..", "state", "seen.json")
RUN_BUDGET_SEC = int(os.environ.get("RUN_BUDGET_SEC", "270"))  # cron 5 dk; ~4.5 dk canlı izle
LIVE_INTERVAL = 30
UA = "arda-guler-bildirim (+https://github.com/MMK-34/arda-guler-bildirim)"

SB = "https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates={d}&limit=1000"
SUM = "https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event={id}"


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"seen": []}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    state["seen"] = state["seen"][-500:]
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=0)


def dates_to_check():
    now = datetime.now(timezone.utc)
    out = [now.strftime("%Y%m%d")]
    if now.hour < 4:
        out.append((now - timedelta(days=1)).strftime("%Y%m%d"))
    return out


def tracked_events():
    found = {}
    for d in dates_to_check():
        try:
            sb = get_json(SB.format(d=d))
        except Exception as e:
            print("scoreboard error", d, e)
            continue
        for ev in sb.get("events", []):
            comp = ev.get("competitions", [{}])[0]
            ids = {str(c.get("team", {}).get("id")) for c in comp.get("competitors", [])}
            if ids & TEAM_IDS:
                found[ev["id"]] = ev
    return list(found.values())


def state_of(ev):
    st = ev.get("status", {}).get("type") or ev["competitions"][0].get("status", {}).get("type") or {}
    return st.get("state", "pre")


def minutes_to(ev):
    dt = datetime.strptime(ev["date"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    return (dt - datetime.now(timezone.utc)).total_seconds() / 60


def should_scan(ev):
    s = state_of(ev)
    if s == "in":
        return True
    if s == "post":
        return minutes_to(ev) > -200
    return False


def match_name(ev):
    comp = ev["competitions"][0]
    home = next(c for c in comp["competitors"] if c.get("homeAway") == "home")
    away = next(c for c in comp["competitors"] if c.get("homeAway") == "away")
    n = lambda c: c["team"].get("shortDisplayName") or c["team"].get("displayName")
    return f"{n(home)} - {n(away)}"


def scan(ev, seen):
    try:
        sm = get_json(SUM.format(id=ev["id"]))
    except Exception as e:
        print("summary error", ev["id"], e)
        return []
    link = (ev.get("links") or [{}])[0].get("href") or f"https://www.espn.com/soccer/match/_/gameId/{ev['id']}"
    out = []
    for ke in sm.get("keyEvents", []):
        if not ke.get("scoringPlay"):
            continue
        typ = (ke.get("type") or {}).get("text", "")
        if "own goal" in typ.lower():
            continue
        ps = ke.get("participants") or []
        scorer = (ps[0].get("athlete") if len(ps) > 0 else None) or {}
        assister = (ps[1].get("athlete") if len(ps) > 1 else None) or {}
        if str(scorer.get("id")) == ATHLETE_ID:
            kind = "gol"
        elif str(assister.get("id")) == ATHLETE_ID:
            kind = "asist"
        else:
            continue
        key = f"ke:{ke.get('id')}"
        if key in seen:
            continue
        seen.append(key)
        minute = (ke.get("clock") or {}).get("displayValue", "")
        text = ke.get("text") or ""
        score = ""
        if text.startswith("Goal!"):
            score = text.split(".")[0].replace("Goal!", "").strip()
        detail = ""
        if kind == "gol" and "penalty" in typ.lower():
            detail = "Penaltı"
        elif kind == "asist" and scorer.get("displayName"):
            detail = f"Gol: {scorer['displayName']}"
        out.append({"kind": kind, "minute": minute, "match": match_name(ev), "score": score, "detail": detail, "link": link})
    return out


def push(item):
    title = f"⚽ GOOOL! Arda Güler {item['minute']}" if item["kind"] == "gol" else f"🎯 ASİST! Arda Güler {item['minute']}"
    body = item["match"]
    if item["score"]:
        body += " · " + item["score"]
    if item["detail"]:
        body += " · " + item["detail"]
    payload = {
        "topic": TOPIC,
        "title": title,
        "message": body,
        "priority": 5,
        "tags": ["soccer"],
        "click": item["link"],
    }
    req = urllib.request.Request(NTFY_URL, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "User-Agent": UA}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        print("ntfy", r.status, title, body)


def main():
    state = load_state()
    seen = state.setdefault("seen", [])
    before = len(seen)
    start = time.time()

    events = tracked_events()
    print("tracked events:", [(e["id"], e["name"], state_of(e)) for e in events])
    scan_list = [e for e in events if should_scan(e)]
    if not scan_list:
        print("no live/recent match; exit")
        return finish(state, before)

    while True:
        for ev in scan_list:
            for item in scan(ev, seen):
                try:
                    push(item)
                except Exception as e:
                    print("ntfy error", e)
        live = [e for e in scan_list if state_of(e) == "in"]
        if not live or time.time() - start > RUN_BUDGET_SEC:
            break
        time.sleep(LIVE_INTERVAL)
        # durumları tazele
        fresh = {e["id"]: e for e in tracked_events()}
        scan_list = [fresh.get(e["id"], e) for e in scan_list]
    return finish(state, before)


def finish(state, before):
    changed = len(state["seen"]) != before
    if changed:
        save_state(state)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
    print("changed:", changed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
