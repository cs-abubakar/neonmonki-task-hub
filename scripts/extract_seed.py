#!/usr/bin/env python3
"""Extract NEONMONKI task data from the two master Excel sheets into data/seed.json.

Source of truth: NEONMONKI_Master_Task_System_V2.xlsx (full Jan-Aug 2026 master).
The May-Aug 2026 file contributes extra Document Links rows (deduped by URL).

Run from repo root:
    PYTHONPATH=.tools python3 clients/neonmonki/task-system/scripts/extract_seed.py
"""
import json
import os
import sys

import openpyxl

BASE = os.path.join(os.path.dirname(__file__), "..", "..", "Tasks-sheet")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "seed.json")
V2 = os.path.join(BASE, "NEONMONKI_Master_Task_System_V2.xlsx")
MAY = os.path.join(BASE, "NEONMONKI_Master_Task_System_May-Aug_2026.xlsx")

# tasks that are internal-only by nature (hiring, candidate evaluation)
INTERNAL_TASKS = {"NM-PM-003", "NM-AI-001", "NM-AI-002", "NM-AI-003", "NM-AI-004"}


def sheet_rows(path, name):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[name]
    rows = []
    for row in ws.iter_rows(values_only=True):
        vals = [("" if v is None else str(v).strip()) for v in row]
        if any(vals):
            rows.append(vals)
    return rows


def table(rows):
    """First row = header; return list of dicts keyed by header."""
    header, body = rows[0], rows[1:]
    out = []
    for r in body:
        d = {}
        for i, h in enumerate(header):
            if h:
                d[h] = r[i] if i < len(r) else ""
        if any(d.values()):
            out.append(d)
    return out


def norm_date(s):
    s = (s or "").strip()
    return s[:10]


def main():
    # ---- Tasks (V2 Master Tasks) ----
    tasks_raw = table(sheet_rows(V2, "Master Tasks"))

    # Next Action / Due Date live on the V2 Active Board, keyed by Task ID.
    board = {r.get("Task ID", ""): r for r in table(sheet_rows(V2, "Active Board"))}

    tasks = []
    for r in tasks_raw:
        tid = r.get("Task ID", "")
        if not tid:
            continue
        b = board.get(tid, {})
        tasks.append({
            "id": tid,
            "title": r.get("Task / Action Item", ""),
            "dateRequested": norm_date(r.get("Date Requested", "")),
            "department": r.get("Department", ""),
            "project": r.get("Project / Area", ""),
            "description": r.get("Task Description", ""),
            "requestedBy": r.get("Requested By", "") or "Adika",
            "owner": r.get("Task Owner", ""),
            "supporting": r.get("Supporting / Dependency Owner", ""),
            "priority": r.get("Priority", "") or "Medium",
            "status": r.get("Workflow Status", "") or "Planned",
            "evidence": r.get("Evidence Status", ""),
            "update": r.get("Current Update", "") or b.get("Current Update", ""),
            "blocker": r.get("Blocker / Dependency", "") or b.get("Blocker", ""),
            "deliverable": r.get("Deliverable", ""),
            "deliverableLink": r.get("Deliverable / Link", ""),
            "nextAction": b.get("Next Action", ""),
            "dueDate": norm_date(b.get("Due Date", "")),
            "source": r.get("Source", ""),
            "visibility": "internal" if tid in INTERNAL_TASKS else "shared",
            "privateFor": "",
            "assignedDept": "",
        })

    # ---- Deliverables ----
    deliverables = []
    for r in table(sheet_rows(V2, "Deliverables")):
        if not r.get("Deliverable ID"):
            continue
        deliverables.append({
            "id": r.get("Deliverable ID", ""),
            "date": norm_date(r.get("Date", "")),
            "title": r.get("Deliverable", ""),
            "workstream": r.get("Workstream", ""),
            "owner": r.get("Owner", ""),
            "recipient": r.get("Recipient", ""),
            "status": r.get("Status", ""),
            "link": r.get("Reference / Link", ""),
        })

    # ---- Decisions & Rules ----
    decisions = []
    for r in table(sheet_rows(V2, "Decisions & Rules")):
        if not r.get("Decision ID"):
            continue
        decisions.append({
            "id": r.get("Decision ID", ""),
            "date": norm_date(r.get("Date", "")),
            "topic": r.get("Topic", ""),
            "rule": r.get("Business Rule / Decision", ""),
            "workstream": r.get("Workstream", ""),
            "owner": r.get("Owner / Applies To", ""),
        })

    # ---- Recurring Work ----
    recurring = []
    for r in table(sheet_rows(V2, "Recurring Work")):
        if not r.get("Recurring ID"):
            continue
        recurring.append({
            "id": r.get("Recurring ID", ""),
            "cadence": r.get("Cadence", ""),
            "activity": r.get("Activity", ""),
            "department": r.get("Department", ""),
            "owner": r.get("Owner", ""),
            "reviewer": r.get("Recipient / Reviewer", ""),
            "definition": r.get("Definition", ""),
        })

    # ---- Team ----
    team = []
    for r in table(sheet_rows(V2, "Team Ownership")):
        if not r.get("Person / Group"):
            continue
        team.append({
            "name": r.get("Person / Group", ""),
            "area": r.get("Primary Area", ""),
            "responsibility": r.get("Responsibilities", ""),
            "role": r.get("Role Type", ""),
        })

    # ---- Document Links: merge V2 + May-Aug (dedupe by URL/file) ----
    links = []

    def add_links(path, sheet, mapping, id_prefix):
        for r in table(sheet_rows(path, sheet)):
            item = {k: r.get(src, "") for k, src in mapping.items()}
            key_src = item.get("url") or item.get("title")
            if not key_src:
                continue
            if any((l["url"] or l["title"]) == key_src for l in links):
                continue
            item["id"] = item.get("id") or f"{id_prefix}-{len(links) + 1:03d}"
            item["date"] = norm_date(item.get("date", ""))
            links.append(item)

    add_links(V2, "Document Links", {
        "id": "Link ID", "taskId": "Task ID", "date": "Date", "workstream": "Workstream",
        "title": "Document / Resource", "url": "URL", "type": "Type",
        "owner": "Owner", "note": "Notes",
    }, "LNK")
    add_links(MAY, "Document Links", {
        "id": "", "taskId": "", "date": "Date", "workstream": "Workstream",
        "title": "Document / Resource", "url": "URL / File", "type": "Type",
        "owner": "Owner", "note": "Why It Matters",
    }, "LNK")

    seed = {
        "tasks": tasks,
        "deliverables": deliverables,
        "decisions": decisions,
        "recurring": recurring,
        "team": team,
        "links": links,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(seed, f, indent=2, ensure_ascii=False)

    print(f"tasks={len(tasks)} deliverables={len(deliverables)} "
          f"decisions={len(decisions)} recurring={len(recurring)} "
          f"team={len(team)} links={len(links)}")
    print("wrote", os.path.relpath(OUT))


if __name__ == "__main__":
    sys.exit(main())
