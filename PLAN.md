# Pi Desk MVP Plan

## Ziel

Ein generisches Pi-Paket, das pro Projekt einen kleinen priorisierten Workspace für Inbox-Einträge führt.

## Paketform

Wie `sheepdog`/`slop`. Der Baum zeigt die Repository-/Quellstruktur, nicht den npm-Tarball:

```text
pi-desk/
├── package.json
├── pi-extension/
│   ├── index.js
│   ├── package.json
│   └── test/
├── CONTEXT.md
└── PLAN.md
```

Root-`package.json`:

- `name`: `pi-desk`
- `keywords`: `pi-package`, `pi`, `workspace`, `inbox`, `prioritization`
- `pi.extensions`: `./pi-extension/index.js`

Kein Web, keine App, kein Sync, keine DB.

## Speicher

Global privat unter `~/.pi/agent/pi-desk/`.

- Projekt-ID: Git-Root; außerhalb von Git fallback auf `cwd`
- Pro Projekt getrennte JSON-Datei: `projects/<hash>.json`
- Kontextauswahl pro Projekt in derselben Datei oder daneben

Offene Einträge sind die Quelle der Wahrheit. Erledigte Einträge werden hart gelöscht.

## Commands

- `/todo` — gespeicherte Rangliste anzeigen, kein Agent
- `/todo all` — offene Inbox-Einträge aus allen gespeicherten Projekten anzeigen, kein Agent
- `/todo <text>` — Inbox-Eintrag nur anhängen, kein Agent
- `/todo sort` — Sort-Agent starten
- `/todo done <id>` — Eintrag hart löschen
- `/todo edit <id> [text]` — einzelnen Eintrag ändern; ohne Text Editor öffnen
- `/todo move <id> <rank>` — manuelle Prioritätsvorgabe setzen; künftige Sortierungen respektieren sie
- `/todo clear` — nur mit Bestätigung
- `/todo setup` — Kontextdateien neu suchen/vorschlagen/bestätigen

## Kontext-Setup

Bei `/todo setup` in einem Projekt:

1. Extension sucht sichere Kontextdateien.
2. Ziel: Docs/Root-Dateien, max. 5 Vorschläge.
3. User bestätigt oder ändert die Auswahl.
4. Auswahl wird pro Projekt gespeichert.

Die Auswahl darf leer bleiben.

## Priorisierung

Nur bei `/todo sort`:

1. Extension startet den Agenten mit Inbox, bestätigten Kontextdateien und aktuellem geladenem Pi-Kontext.
2. Agent sammelt bei Bedarf weiteren Projektkontext über den gefilterten `piDeskContext`-Reader.
3. Bleiben fachliche Fragen offen, nutzt der Agent `askUserQuestions`.
4. Ergebnis ist eine lineare Rangliste, keine Buckets, keine Scores.
5. Anzeige: Rang + Text + kurzer Grund.
6. Gründe folgen der Sprache der Eingabe.
7. Bei Agent-Ausfall bleibt die bestehende Reihenfolge ohne Fake-Gründe erhalten.

## Sicherheitsgrenzen

- Nie `.env`, Credentials, `node_modules`, `.git`, Build-Artefakte oder große Binärdateien als Kontext lesen/vorschlagen.
- `/todo <text>` startet nie einen Agenten.
- Sort-Agent liest Projektkontext nur über `piDeskContext` und speichert nur über `piDeskApplySort`.
- `clear` braucht Bestätigung.

## Tests

Minimal:

- Command-Parser: `/todo`, `/todo text`, `/todo done 3`, `/todo edit 3 text`, `/todo move 2 1`, `/todo clear`, `/todo setup`, `/todo sort`
- Projekt-ID-Ermittlung: Git-Root und cwd-Fallback
- JSON-Store: add/list/edit/done/move/clear
- Kontextfilter: Secrets/ignored dirs ausgeschlossen

## Implementierungsentscheidung

Der Sort-Agent läuft in der aktuellen Pi-Session, kann `askUserQuestions` nutzen und speichert die finale Reihenfolge über `piDeskApplySort`.
