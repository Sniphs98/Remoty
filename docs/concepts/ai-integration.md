# Konzept: AI-Hilfe im Terminal

> Status: 🚧 Phase 1 und Phase 2 (Abo über Claude Code und die Codex-CLI) umgesetzt (README → *AI helper*);
> ChatGPT-Direktlogin und Phase 3–4 offen.

## Stand der Umsetzung (Phase 1)

Gebaut ist der Chat mit API-Key — Claude (Anthropic API) und OpenAI (Responses API):

- **Settings → AI:** Anbieter, API-Key (verschlüsselt wie Host-Passwörter oder als 1Password-Referenz), Modell,
  *„Answer right after a command ran“*, *Test connection*. Code: `packages/electron/src/core/config/ai.ts`,
  `packages/ui/src/lib/components/AiSettings.svelte`.
- **Chat neben dem Terminal** (✨-Knopf oben rechts oder `Ctrl+Shift+A`), Befehlskarten mit *Run / Insert / Copy / Skip*,
  gefährliche Befehle mit zweitem Klick, Ausgabe-Mitschnitt ohne Shell-Integration (Prompt wieder da + Ruhe,
  sonst nach 10 s Ruhe, *Done* von Hand). Code: `AiPanel.svelte`, `AiCommandCard.svelte`, `aiCapture.ts`.
- **Probleme pro Host in `ai.sqlite`**, Liste, *New problem*, *Mark as solved*, Umbenennen, Löschen, Weitermachen in einer
  neuen Sitzung (mit Hinweis an die AI). Code: `packages/electron/src/core/ai/` (`store.ts`, `engine.ts`).
- **Sicherheit:** Maskierung (`mask.ts`), lokale Risiko-Regeln (`risk.ts`), die AI hat nur `propose_command`.

Abweichungen vom Konzept unten:

- **SQLite über sql.js** (WebAssembly) statt `better-sqlite3`: kein natives Modul, das für Electron neu gebaut werden
  müsste. Die Datenbank liegt im Speicher und wird nach jeder Änderung als Ganzes geschrieben — **als Ganzes
  verschlüsselt**, wenn der OS-Schlüsselspeicher verfügbar ist.
- **Titel** = erste Zeile der ersten Nachricht (umbenennbar), nicht von der AI erzeugt — spart eine Anfrage.
- **OpenAI-Paket 7.x**, seit Remoty auf Electron 44 (Node 24) läuft; mit Electron 33 (Node 20) ging nur 6.x.
- **Claude:** Standardmodell `claude-opus-5-5`, adaptive Thinking mit `effort: medium`, Server-Fallback bei einer
  Ablehnung (`fallbacks: "default"`), Prompt-Caching; der Verlauf wird nur angehängt, nie umgeschrieben.
- Noch nicht drin: Zusammenfassen sehr langer Probleme, Token-Kosten in Euro, Auto-Löschen gelöster Probleme.

## Stand der Umsetzung (Phase 2: Abo über die CLI)

*Settings → AI → Provider Claude/OpenAI → Sign in with **Subscription*** nutzt das Claude-Pro/Max- bzw.
ChatGPT-Abo über die CLI, die der Nutzer selbst installiert und angemeldet hat (`claude auth login`,
`codex login`). Die Einstellungen zeigen, ob die CLI gefunden wurde (PATH plus die üblichen Installationsorte,
oder ein eingetragener Pfad), welche Version und ob sie angemeldet ist. Code: `core/ai/claudeCli.ts`,
`core/ai/codexCli.ts`, `core/ai/cliProcess.ts`.

Abweichungen vom Konzept unten (*Weg 2*):

- **Kein MCP-Server.** Statt eines `propose_command`-Werkzeugs antworten die CLIs mit **strukturierter
  Ausgabe** nach Remotys Schema `{text, commands[]}` (`claude -p --json-schema …`, `codex exec --output-schema …`).
  Jeder Eintrag in `commands` wird eine Befehlskarte wie ein `propose_command`-Aufruf. Die Ergebnisse gehen mit
  der nächsten Nachricht als Text an die CLI. Das ist einfacher, braucht keinen offenen Port und funktioniert
  mit beiden CLIs gleich.
- **Die CLIs bekommen keinerlei eigene Werkzeuge:** Claude Code mit `--tools ""`, ohne MCP-Server, Einstellungen
  und Slash-Befehle; Codex mit abgeschalteter Shell, Browser, Apps, Plugins und Websuche, Sandbox `read-only`,
  ohne die `config.toml` des Nutzers. Beide laufen in einem eigenen leeren Ordner (`<Config>/ai-cli`).
- **Sitzungen:** Pro Problem und CLI merkt sich `ai.sqlite` (Tabelle `cli_sessions`) die Sitzung (Claude Code
  `--session-id`/`--resume`, Codex `exec resume <thread>`) und bis zu welchem Eintrag sie den Verlauf kennt.
  Eine Folgeanfrage schickt nur, was danach kam. Ist die Sitzung weg, startet Remoty eine neue und gibt den ganzen
  Verlauf aus SQLite mit; das gilt auch nach einem Wechsel des Anbieters.
- **Systemprompt:** Claude Code bekommt Remotys eingefrorenen Prompt plus einen Zusatz zum Antwortformat
  (`--system-prompt-file`). Codex hat keinen eigenen Schalter dafür, dort steht er am Anfang der ersten Nachricht.
- **Modell:** leer = der Standard der CLI (passt zum Abo); sonst z. B. `opus`/`sonnet` bzw. ein Codex-Modell.
- **Mitstreamen:** Claude Code läuft mit `--output-format stream-json --include-partial-messages`; Remoty liest den
  Text der Antwort aus dem noch unvollständigen JSON und zeigt ihn, während Claude schreibt. `codex exec` gibt die
  Nachricht nur als Ganzes aus — dort erscheint die Antwort, wenn Codex fertig ist (bis dahin „Thinking…“).
- **ChatGPT-Direktlogin (experimentell) noch nicht gebaut:** Die Codex-CLI deckt das ChatGPT-Abo offiziell ab.


## Ziel

Heute läuft Fehlersuche mit AI meist so: Output im Terminal markieren → in ein Chat-Fenster kopieren →
Antwort lesen → Befehl zurück ins Terminal kopieren → ausführen → wieder Output kopieren … Das soll weg.

**Ein normaler Chat neben dem Terminal, der das Terminal kennt:**

1. Man beschreibt das Problem im Chat („nginx startet nach dem Update nicht mehr“).
2. Die AI schlägt einen Befehl vor; ein Klick auf **▶ Ausführen** schickt ihn in den Terminal-Tab.
3. Die Ausgabe dieses Befehls geht **automatisch** zurück in den Chat — kein Markieren, kein Kopieren.
4. Die AI liest die Ausgabe und schlägt den nächsten Schritt vor. So arbeitet man sich gemeinsam durch das Problem.

Grundregel: **Die AI führt nie von sich aus etwas aus.** Jeder Befehl braucht einen Klick des Nutzers,
aber eben nur einen Klick statt zweimal Kopieren.

---

## Bedienung (UX)

### 1. Der Chat neben dem Terminal (Kernfunktion)

Pro Terminal-Tab gibt es eine einklappbare Chat-Seitenleiste (`Ctrl+Shift+A`). Ein Chat ist ein
**Problem** (z. B. „nginx startet nicht“) auf einem Host und wird gespeichert, s. *Probleme speichern*.
Oben in der Leiste: der Titel des Problems, **＋ Neues Problem** und **☰ Probleme** (Liste zum Wechseln).

```
┌ web-1 ────────────────────────────────┬ ✨ AI ──────────────────────────────┐
│ $ systemctl status nginx              │ Du: nginx startet nach dem Update   │
│ ● nginx.service - A high performance  │     nicht mehr                      │
│   Active: failed (Result: exit-code)  │                                     │
│ $ sudo nginx -t                       │ AI: Schauen wir zuerst den Status   │
│ nginx: [emerg] unknown directive      │     an:                             │
│   "http2" in /etc/nginx/sites-enabled │  ┌───────────────────────────────┐  │
│   /app.conf:12                        │  │ systemctl status nginx        │  │
│ nginx: configuration file test failed │  │ ✔ ausgeführt · Exit 3 · 6 Z.  │  │
│ $ █                                   │  └───────────────────────────────┘  │
│                                       │ AI: Der Dienst ist abgestürzt.      │
│                                       │     Prüfen wir die Konfiguration:   │
│                                       │  ┌───────────────────────────────┐  │
│                                       │  │ sudo nginx -t                 │  │
│                                       │  │ ✔ ausgeführt · Exit 1 · 3 Z.  │  │
│                                       │  └───────────────────────────────┘  │
│                                       │ AI: `http2` als eigene Direktive    │
│                                       │     gibt es erst ab nginx 1.25.1.   │
│                                       │     Zeile 12 in app.conf ändern:    │
│                                       │  ┌───────────────────────────────┐  │
│                                       │  │ sudo sed -i '12s/…/…/' …      │  │
│                                       │  │ ⚠ ändert eine Datei           │  │
│                                       │  │ [▶ Ausführen] [✎ Einfügen] [⧉]│  │
│                                       │  └───────────────────────────────┘  │
│                                       │ [ Nachricht …                    ⏎ ]│
│                                       │ 👁 Terminal mitlesen: an            │
└───────────────────────────────────────┴─────────────────────────────────────┘
```

Jeder Befehl in einer Antwort ist eine **Befehlskarte** mit drei Knöpfen:

| Knopf | Wirkung |
|---|---|
| **▶ Ausführen** | Schreibt den Befehl in die Shell und drückt Enter. Die Ausgabe wird mitgeschnitten und an den Chat gehängt (s. „Ausgabe zurück in den Chat“). |
| **✎ Einfügen** | Schreibt den Befehl nur in die Eingabezeile, ohne Enter — zum Anpassen. Wird er dann im Terminal abgeschickt, landet die Ausgabe trotzdem im Chat. |
| **⧉ Kopieren** | Klassisch in die Zwischenablage. |

Nach dem Ausführen zeigt die Karte Status, Exit-Code und Zeilenanzahl; aufklappbar sieht man genau,
welche Ausgabe die AI bekommen hat.

**„AI antwortet direkt auf das Ergebnis“** (früher „Automatisch weiter“, Standard: an): Was nach dem
Klick auf *▶ Ausführen* passiert:

| | Ablauf |
|---|---|
| **an** | Befehl läuft → Ausgabe geht sofort an die AI → die AI antwortet von selbst („Exit 1, die Konfiguration hat einen Fehler in Zeile 12, prüfen wir …“) mit dem nächsten Vorschlag. Du klickst dich von Schritt zu Schritt. |
| **aus** | Befehl läuft → Ausgabe hängt an der Karte, die AI wartet. Erst wenn du etwas schreibst („das sieht anders aus als erwartet, ich glaube es liegt an Docker“), geht deine Nachricht **zusammen mit** der Ausgabe raus. |

Ausgeführt wird in beiden Fällen nur, was du anklickst — „an“ spart nur das Tippen von „und jetzt?“.

**Mehrere Befehle in einer Antwort** bekommen je eine eigene Karte und werden einzeln ausgeführt — nie als
Block auf einmal, damit man nach jedem Schritt die Ausgabe sieht.

### 2. Terminal mitlesen (auch was man selbst tippt)

Man arbeitet ja nicht nur über den Chat. Mit **👁 Terminal mitlesen** (pro Tab, Standard: an, solange der Chat
offen ist) bekommt die AI mit der nächsten Nachricht automatisch alles, was **seit der letzten Nachricht** im
Terminal passiert ist: selbst getippte Befehle und deren Ausgabe. Man kann also einfach schreiben
„warum geht das nicht?“, ohne etwas zu markieren. Im Chat erscheint dafür ein kleiner Chip
`📎 Terminal: 2 Befehle, 41 Zeilen` — anklickbar, um zu sehen bzw. zu kürzen, was mitgeht.

### 3. Schnellzugriffe

- **Befehlsleiste** (`Ctrl+Shift+Space`): eine Zeile unten im Tab für schnelle Einzelfragen
  („größte Dateien in /var/log“) mit Befehlskarte — landet ebenfalls im Chat-Verlauf des Tabs.
- **Rechtsklick → „Im Chat fragen“** auf eine Markierung: hängt nur diesen Teil an, für den Fall, dass
  es um alten Output weiter oben geht.
- **Fehler-Chip** (optional): endet ein Befehl mit Exit-Code ≠ 0, erscheint `✨ Im Chat fragen?`.
  Erst der Klick sendet etwas.
- **Als Snippet speichern** an jeder Befehlskarte (Brücke zu Snippets & Automations).

---

## Probleme speichern (SQLite)

Ein Problem zieht sich oft über Tage. Darum wird jeder Chat als **Problem** dauerhaft gespeichert und
gehört zu einem Host (bzw. lokalen Shell-Profil), nicht zu einem Tab.

```
┌ ✨ AI · web-1 ───────────────────────── [＋ Neu] [☰] ┐
│ ▾ Probleme auf web-1                                │
│   ● nginx startet nicht            heute, 10:42     │
│   ○ Backup-Cronjob läuft nicht     gestern          │
│   ✔ Disk voll /var/lib/docker      12.09. (gelöst)  │
└─────────────────────────────────────────────────────┘
```

- **Weitermachen an einem anderen Tag:** Öffnet man einen Tab zu `web-1`, bietet der Chat das zuletzt
  offene Problem an („Weiter an: *nginx startet nicht*?“). Der ganze Verlauf samt ausgeführten Befehlen
  und deren Ausgaben ist wieder da. Die AI bekommt dazu den Hinweis, dass es eine neue Terminal-Sitzung
  ist und sich der Stand geändert haben kann — sie prüft also erst einmal nach, statt blind weiterzumachen.
- **＋ Neues Problem:** leerer Chat, das alte bleibt unverändert in der Liste. Zum Zurückkommen einfach in
  der Liste anklicken. Wechseln ist jederzeit möglich, auch mitten im Problem.
- **Von vorne anfangen:** *＋ Neues Problem* — oder im Menü des Problems *„Verlauf leeren“*, wenn Titel und
  Host bleiben sollen.
- **✔ Als gelöst markieren:** Die AI schreibt auf Wunsch eine kurze Zusammenfassung (Ursache, Lösung, die
  entscheidenden Befehle). Gelöste Probleme bleiben durchsuchbar; daraus lässt sich ein Snippet oder eine
  Automation machen.
- **Titel** ist die erste Zeile der ersten Nachricht, umbenennen geht per Klick.
- **Auf anderen Server übernehmen** (s. unten): ein Problem als Vorlage für dasselbe Problem auf einem
  anderen Host verwenden.
- **Übersicht** über alle Hosts zusätzlich unter *Settings → AI → Probleme* (suchen, löschen, exportieren).

### Auf anderen Servern weitermachen

Ein Problem gehört zu **einem** Host. Oft muss man aber dasselbe auf mehreren Servern machen (nginx auf
`web-1` repariert, `web-2` und `web-3` haben dasselbe Update bekommen). Dafür: im Menü des Problems
**„Auf anderem Server übernehmen…“** → einen oder mehrere Hosts wählen.

- Für jeden gewählten Host entsteht ein **eigenes, neues Problem** („nginx startet nicht — von web-1“),
  verknüpft mit dem Original (`source_problem_id`). Jeder Server behält seinen eigenen Verlauf und seine eigenen
  Ausgaben — gemischt wird nichts.
- Das neue Problem startet mit einer **Zusammenfassung** des Originals: Ursache, Lösung und die Befehle, die
  dort geholfen haben. Die AI soll damit **erst prüfen**, ob der andere Server wirklich dasselbe Problem hat
  (Version, Konfiguration), und dann die Schritte als Befehlskarten anbieten — angepasst, falls nötig.
- Jeder Befehl braucht auch hier einen Klick, auf jedem Server einzeln. Es gibt bewusst kein „auf allen
  Servern gleichzeitig ausführen“.
- Im Original zeigt eine Zeile, wohin es übernommen wurde (`→ web-2 ✔ gelöst · web-3 ● offen`), jeweils anklickbar.

Mehr nicht: Ein Problem bleibt ein Server. Wer echtes „auf vielen Servern gleich“ braucht, macht aus dem gelösten
Problem eine Automation (Phase 4).

**Speicherung:** eine SQLite-Datei `ai.sqlite` im App-Ordner (neben `hosts.toml` usw.), über **sql.js**
(SQLite als WebAssembly). Electron 33 bringt Node 20 mit, das eingebaute `node:sqlite` gibt es dort noch nicht,
und ein natives Modul wie `better-sqlite3` müsste für jede Electron-Version neu gebaut werden.
Das Schema unten ist der ursprüngliche Entwurf; umgesetzt ist es in `core/ai/store.ts` (Tabellen `problems`,
`entries`, `commands`).

```sql
CREATE TABLE problems (
  id            TEXT PRIMARY KEY,
  host_name     TEXT,             -- SSH-Host aus hosts.toml …
  local_profile TEXT,             -- … oder lokales Shell-Profil
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,    -- open | solved | archived
  summary       TEXT,             -- Zusammenfassung beim Lösen
  provider      TEXT,             -- anthropic | openai | chatgpt | claude-cli | codex-cli (zuletzt benutzt)
  model         TEXT,
  cli_session   TEXT,             -- Sitzungs-ID der CLI zum Fortsetzen (nur CLI-Weg)
  source_problem_id TEXT REFERENCES problems(id),  -- übernommen von einem anderen Server
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  problem_id  TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,      -- user | assistant | terminal (mitgelesener Ausschnitt)
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE commands (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  command     TEXT NOT NULL,
  explanation TEXT,
  risk        TEXT,               -- safe | caution | danger
  state       TEXT NOT NULL,      -- proposed | ran | skipped
  output      TEXT,               -- gekürzt + maskiert, wie an die AI geschickt
  exit_code   INTEGER,
  ran_at      INTEGER
);
CREATE INDEX messages_by_problem ON messages(problem_id, seq);
CREATE INDEX problems_by_host ON problems(host_name, updated_at);
```

Die Datenbank ist die **Quelle der Wahrheit**: Auch wenn die Sitzung einer CLI weg ist oder man
den Anbieter oder Weg wechselt (API-Key ↔ Abo, Claude ↔ ChatGPT), baut Remoty den Verlauf aus SQLite wieder auf. Bei sehr langen
Problemen gehen ältere Teile als Zusammenfassung mit, die letzten Schritte vollständig.

Gespeichert wird nur, was ohnehin an die AI ging, also bereits **maskiert** (keine Passwörter/Tokens).
Die ganze Datei wird zusätzlich mit `secretCipher` verschlüsselt (wie Host-Passwörter), damit
sie allein nichts preisgibt. Gelöste Probleme lassen sich automatisch nach *n* Tagen löschen (Standard: nie).

---

## Ausgabe zurück in den Chat

Kern der Sache ist, die Ausgabe eines Befehls sauber abzugrenzen. Zwei Wege, je nach Shell:

**Mit Shell-Integration (genau):** Die Shell meldet über unsichtbare Escape-Sequenzen, wann ein Prompt
beginnt, wann ein Befehl startet und mit welchem Exit-Code er endet (`OSC 133;A/B/C/D;<exit>`, dazu
`OSC 7` für das aktuelle Verzeichnis) — wie in VS Code und Windows Terminal. Remoty liest das mit
`term.parser.registerOscHandler` und kennt damit für jeden Befehl: Befehlszeile, Ausgabe, Exit-Code, cwd.
Eingerichtet wird es pro Tab mit einem kurzen Snippet beim Start (bash/zsh: `PROMPT_COMMAND`/`precmd`,
PowerShell: `prompt`-Funktion), auf demselben Weg wie heute schon `cd <defaultPath>` und der Startbefehl
eines Hosts — ohne etwas auf dem Server dauerhaft zu ändern.

**Ohne Shell-Integration (Fallback):** Remoty merkt sich die Buffer-Zeile beim Klick auf *Ausführen* und
nimmt alles bis dahin, wo wieder ein Prompt erscheint bzw. die Ausgabe ~2 s ruhig ist. Kein Exit-Code,
aber für die meisten Fälle gut genug. Ein Knopf **„Fertig“** an der Karte beendet das Mitschneiden von Hand
(z. B. bei `tail -f`).

**Lange oder interaktive Befehle:**
- Lange Ausgaben werden gekürzt (Anfang + Ende, z. B. 50 + 150 Zeilen, Mitte als „… 3 200 Zeilen ausgelassen“).
- Vollbild-Programme (`vim`, `htop`, `less` — erkennbar am Alternate Screen) werden nicht mitgeschnitten;
  die AI soll hier nicht-interaktive Varianten vorschlagen (`--no-pager`, `top -bn1`, `journalctl --no-pager -n 100`).
  Das steht so auch im System-Prompt.
- Passwort-Abfragen (`sudo`) tippt der Nutzer selbst im Terminal; der Fokus springt dafür ins Terminal.
  Eingaben bei ausgeschaltetem Echo werden nie mitgeschnitten.
- Läuft im Terminal gerade etwas, ist *Ausführen* gesperrt (nur *Einfügen*), damit nichts in ein laufendes Programm getippt wird.

---

## Kontext: was die AI zu sehen bekommt

Gute Vorschläge brauchen Kontext, aber nur so viel wie nötig. Der Kontext wird **im Renderer**
zusammengestellt; was mitgeht, ist an jeder Nachricht als Chip sichtbar und aufklappbar.

| Kontext | Quelle | Standard |
|---|---|---|
| Betriebssystem/Distro, Shell | Dashboard-Metriken des Hosts (OS wird schon erkannt) bzw. lokales Profil (PowerShell, WSL, bash…) | an |
| Erkannte Dienste (Docker, nginx, PostgreSQL…) | Dashboard | an |
| Aktuelles Verzeichnis | Prompt-Zeile bzw. OSC 7 der Shell-Integration | an |
| Markierter Text | xterm.js-Selection | wenn markiert |
| Ausgabe der über den Chat ausgeführten Befehle | Mitschnitt (s. oben) | immer |
| Was seit der letzten Nachricht im Terminal passiert ist | xterm.js-Buffer (`term.buffer.active`), gekürzt | „Terminal mitlesen“ |
| Bisheriger Chat-Verlauf des Tabs | Seitenleiste | immer (ältere Teile werden zusammengefasst) |
| Hostname, IP, Benutzername | Host-Config | **aus** |

Wichtig: Das Shell-Betriebssystem bestimmt die Syntax. PowerShell, `cmd`, bash im WSL und bash auf
einem Alpine-Server brauchen unterschiedliche Befehle — der Shell-Typ gehört immer in den Prompt.

---

## Anbieter

Zwei Arten, an ein Modell zu kommen — hinter **einem** Interface, damit Chat, Befehlskarten und
SQLite davon nichts wissen müssen:

- **Direkt:** Remoty spricht die API selbst an (Phase 1 mit API-Key, Phase 2 ChatGPT-Login).
- **Über eine CLI:** Remoty startet die offizielle CLI des Anbieters, in der sich der Nutzer mit seinem Abo
  angemeldet hat (Phase 2: Claude Code und Codex). Remoty sieht dabei nie ein Token.

| Phase | Anbieter | Weg | Anmeldung | Abrechnung | Status |
|---|---|---|---|---|---|
| **1** | Claude | direkt (Anthropic API) | API-Key | pro Anfrage | offiziell |
| **1** | OpenAI | direkt (OpenAI API) | API-Key | pro Anfrage | offiziell |
| **2** | ChatGPT Plus/Pro | direkt | „Mit ChatGPT anmelden“ in Remoty | Abo | geduldet, nicht dokumentiert → *experimentell* |
| **2** | ChatGPT Plus/Pro | Codex-CLI | `codex login` | Abo | offizielle CLI |
| **2** | Claude Pro/Max | Claude-Code-CLI | `claude` → `/login` | Abo | erlaubt, solange das unveränderte Claude Code läuft ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)) |

Claude mit Abo gibt es **nur** über die CLI: Anthropic verbietet fremden Apps, selbst einen Claude-Login
anzubieten oder Abo-Tokens zu verwenden. Erlaubt ist ausdrücklich, dass der Nutzer sich im originalen
Claude Code mit seinem Abo anmeldet — und genau das startet Remoty.

### Gemeinsames Interface

Das Interface liegt eine Ebene über einzelnen API-Aufrufen, denn eine CLI führt ihre Schleife selbst:

```ts
// packages/electron/src/core/ai/backend.ts
export interface AiBackend {
  id: 'anthropic' | 'openai' | 'chatgpt' | 'claude-cli' | 'codex-cli';
  status(): Promise<{ ready: boolean; detail?: string }>;   // Key da? CLI installiert + angemeldet?
  /** Öffnet ein Problem (neu oder fortgesetzt). */
  open(problem: ProblemRef, history: AiMessage[], hooks: AiHooks): Promise<AiSession>;
}

export interface AiSession {
  send(text: string, attachments: Attachment[]): Promise<void>;   // Nachricht + Terminal-Kontext
  cancel(): void;
  close(): void;
}

export interface AiHooks {
  onText(delta: string): void;
  /** Befehlsvorschlag. Wartet, bis der Nutzer ▶ geklickt (→ Ausgabe) oder übersprungen hat. */
  onPropose(cmd: ProposedCommand): Promise<CommandResult>;
  onDone(usage?: Usage): void;
}
```

`propose_command` ist in **allen** Wegen das **einzige** Werkzeug der AI, und es führt nichts aus —
es zeigt nur eine Befehlskarte und liefert das Ergebnis, sobald der Nutzer geklickt hat.

### Weg 1: direkt (API-Key, ChatGPT-Login)

Remoty führt die Schleife selbst (`core/ai/loop.ts`), einmal für alle direkten Anbieter:

1. Verlauf + Systemprompt an die API → Text streamt in den Chat (`onText`).
2. Ruft das Modell `propose_command` auf → `onPropose` → Befehlskarte, die Schleife wartet.
3. Klick auf *▶ Ausführen* → Ausgabe + Exit-Code werden das Ergebnis des Werkzeugaufrufs →
   bei *„AI antwortet direkt auf das Ergebnis“* sofort zurück zu 1, sonst mit der nächsten Nachricht.
4. *Überspringen* liefert „vom Nutzer übersprungen“.

Die Adapter sind dünn: sie übersetzen nur zwischen Remotys Nachrichten und dem API-Format.

- **Claude (Phase 1):** `@anthropic-ai/sdk`, Messages API mit Streaming und Tool Use. Systemprompt und
  Werkzeug bleiben über ein Problem gleich → Prompt-Caching spart bei langen Problemen viel Eingabe.
- **OpenAI (Phase 1):** `openai`, Responses API mit Streaming und Function Calling.
- **ChatGPT-Login (Phase 2, experimentell):** *Settings → AI → Mit ChatGPT anmelden* öffnet den Browser mit dem
  OpenAI-Login (OAuth mit PKCE, Rückleitung auf einen kurzlebigen `localhost`-Port), wie es die Codex-CLI macht
  — und wie es Pi und die opencode-Plugins tun. Remoty speichert Access-/Refresh-Token verschlüsselt und erneuert
  sie selbst. Anfragen gehen an dasselbe Backend wie die Codex-CLI, im Format der Responses API → der
  OpenAI-Adapter aus Phase 1 wird größtenteils wiederverwendet. Eigene Datei `core/ai/chatgptAuth.ts`, damit
  sich der Weg leicht anpassen oder entfernen lässt, falls OpenAI etwas ändert. Schlägt er fehl, bietet Remoty
  die Codex-CLI oder den API-Key an.
- **Keys/Tokens** wie das GitHub-Token (`core/config/github.ts`): verschlüsselt über `secretCipher`
  oder als 1Password-Referenz `op://…`; sie verlassen nie den Main-Prozess.
- Remoty zeigt am Problem die verbrauchten Tokens (aus `usage`), damit man die Kosten im Blick hat.

### Weg 2: über die CLI (Claude Code, Codex)

Die CLI führt die Schleife selbst; Remoty klinkt sich mit einem eigenen **MCP-Server** ein, der genau ein
Werkzeug anbietet: `propose_command`.

```
Remoty (Main)                                   claude / codex (vom Nutzer installiert + angemeldet)
─────────────                                   ───────────────────────────────────────────────────
MCP-Server auf 127.0.0.1:<zufällig>             claude -p --input-format stream-json
  (Bearer-Token pro Sitzung)                           --output-format stream-json
  └─ propose_command ◀── Werkzeugaufruf ──────         --mcp-config <remoty>  --strict-mcp-config
       │ onPropose → Befehlskarte, wartet               --tools ""   (eingebaute Werkzeuge aus)
       └─ Ausgabe + Exit-Code ─── Ergebnis ─────▶       --system-prompt <Remotys Prompt>
                                                        --resume <cli_session>
CliSession ◀──────────── Text-Stream (JSONL) ──
```

- **Claude Code:** Remoty startet `claude` im Druckmodus mit JSON-Streams für Ein- und Ausgabe. Die eingebauten
  Werkzeuge (Shell, Dateien, Web) sind abgeschaltet, Remotys MCP-Server ist der einzige. Remoty ersetzt den
  Systemprompt durch seinen eigenen, damit sich die CLI wie ein Terminal-Helfer verhält und nicht wie ein
  Coding-Agent. Das Programm selbst wird nicht verändert — Bedingung dafür, dass der Abo-Login erlaubt ist.
- **Codex:** über `@openai/codex-sdk` (startet die CLI, JSONL über stdin/stdout). Remotys MCP-Server in der
  Codex-Konfiguration, Sandbox `read-only`, Freigaben aus.
- **Warum ein MCP-Server über localhost** statt über stdio: Die CLI startet stdio-Server als eigenen Prozess;
  der müsste dann erst wieder mit Remoty reden. Ein HTTP-Server im Main-Prozess hängt direkt an `onPropose`.
  Er lauscht nur auf `127.0.0.1` und verlangt ein zufälliges Token, das nur die eine CLI-Sitzung kennt.
- **Fortsetzen:** Beide CLIs speichern Sitzungen selbst (`claude --resume <id>`, Codex `resumeThread(id)`);
  die ID steht in `problems.cli_session`. Fehlt sie oder ist sie ungültig, startet Remoty eine neue Sitzung
  und gibt den Verlauf aus SQLite als Einstieg mit. SQLite bleibt die Quelle der Wahrheit.
- **Einrichtung:** *Settings → AI* prüft, ob `claude`/`codex` installiert und angemeldet sind
  (`claude --version`, `codex login status`), und öffnet sonst einen lokalen Terminal-Tab mit dem Login-Befehl.
- **Im Prototyp prüfen:** genaue Flags der jeweiligen CLI-Version (Werkzeuge abschalten, MCP über HTTP mit
  Header, Systemprompt ersetzen). Die CLIs ändern sich schnell; die Adapter prüfen beim Start die Version und
  sagen klar, wenn sie zu alt oder zu neu ist.
- **Langsamer als direkt** (CLI-Start ~1–2 s pro Problem, danach ähnlich), dafür ohne Extra-Kosten.

---

## Architektur in Remoty

```
Renderer (Svelte)                                  Main (Electron)
─────────────────                                  ───────────────
TerminalView.svelte                                ipc/ai.ts
  ├─ AiChatPanel.svelte   ── ai_request ─────────▶   ├─ Kontext prüfen, Secrets maskieren
  │   ├─ CommandCard.svelte (▶ / ✎ / ⧉)               ├─ core/ai/backend.ts (Interface)
  │   └─ ProblemList.svelte                            ├─ core/ai/loop.ts + anthropic.ts, openai.ts, chatgpt.ts
                                                     ├─ core/ai/chatgptAuth.ts (Phase 2, Login)
                                                     ├─ core/ai/claudeCli.ts, codexCli.ts (Phase 2)
                                                     ├─ core/ai/mcpServer.ts (Phase 2, propose_command)
  ├─ AiCommandBar.svelte                             ├─ core/ai/store.ts (ai.sqlite)
                                                     └─ core/config/ai.ts  (ai.toml)
  ├─ aiCapture.ts   (Ausgabe pro Befehl mitschneiden: OSC 133 bzw. Fallback)
  └─ aiContext.ts   (Buffer seit letzter Nachricht, Selection, Kürzen)
        ◀── ai-stream-<requestId> (Event) ────────
        ── ai_cancel ──────────────────────────▶
```

Das folgt den vorhandenen Mustern:

- **IPC:** `ipcMain.handle('ai_request', …)` wie in `ipc/terminal.ts`; die Antwort streamt über ein
  Event pro Anfrage (`ai-stream-<id>`), genau wie Terminal-Output über `terminal-output-<id>`.
- **Zugangsdaten nur im Main-Prozess:** API-Keys und ChatGPT-Tokens verschlüsselt über `secretCipher`
  bzw. als 1Password-Referenz, wie das GitHub-Token. Beim CLI-Weg hat Remoty gar keine Zugangsdaten.
  Der Renderer sieht nur „angemeldet / nicht angemeldet“.
- **Eine laufende Schleife pro offenem Problem**, im Main-Prozess; schließt man den Tab, wird eine laufende
  Anfrage abgebrochen, das Problem bleibt in SQLite.
- **Ausführen/Einfügen:** über den bestehenden `sendInput`-Pfad in `TerminalView.svelte`
  (wie der Startbefehl eines Hosts, `typedCommandLine`). *Einfügen* nutzt Bracketed Paste ohne Enter,
  damit mehrzeilige Befehle nicht sofort laufen.
- **Mitschnitt im Renderer:** Der Terminal-Output kommt dort ohnehin an (xterm.js); `aiCapture.ts`
  liest den Buffer statt die Rohbytes, so sind Farben/Escape-Codes schon weg. Main muss dafür nichts
  am PTY ändern, und lokale wie SSH-Tabs funktionieren gleich.
- **Problem pro Tab:** der Sessions-Store merkt sich neben `termId` die ID des offenen Problems; Inhalt kommt aus SQLite.

### Einstellungen (`Settings → AI`)

```toml
# ai.toml
enabled = false               # aus, bis der Nutzer es aktiviert
provider = "anthropic"        # anthropic | openai | chatgpt | claude-cli | codex-cli

[anthropic]
apiKey = "<verschlüsselt>"    # oder:
apiKeyRef = "op://Private/Anthropic/credential"
model = ""                    # leer = Remotys Standard

[openai]
apiKey = "<verschlüsselt>"
apiKeyRef = ""
model = ""

[chatgpt]                     # Phase 2, experimentell
refreshToken = "<verschlüsselt>"
model = ""

[cli]                         # Phase 2
claudePath = ""               # leer = im PATH suchen
codexPath = ""

[general]
deleteSolvedAfterDays = 0     # 0 = nie
maxOutputLines = 200          # pro Befehl, Anfang + Ende
replyToResult = true          # „AI antwortet direkt auf das Ergebnis“
watchTerminal = true          # „Terminal mitlesen“ als Standard für neue Chats
shellIntegration = true       # OSC 133/7 beim Öffnen des Chats einrichten
maskSecrets = true
errorHint = false             # Chip nach fehlgeschlagenem Befehl
disabledHosts = ["prod-db"]   # hier nie etwas senden
```

---

## Sicherheit & Datenschutz

1. **Opt-in.** AI ist standardmäßig aus. Beim Aktivieren ein kurzer Hinweis, welche Daten wohin gehen.
2. **Nie ohne Klick ausführen.** Jeder Befehl braucht *▶ Ausführen* vom Nutzer. *AI antwortet direkt auf
   das Ergebnis* heißt nur: das Ergebnis geht an die AI — der nächste Befehl wartet wieder auf einen Klick.
   Es gibt bewusst keinen „alles automatisch ausführen“-Modus.
3. **Risiko-Erkennung lokal, nicht nur durch das Modell:** eine einfache Regelliste markiert gefährliche
   Muster unabhängig von der Modell-Antwort (`rm -rf`, `mkfs`, `dd of=/dev/`, `chmod -R 777`,
   `> /etc/…`, `curl … | sh`, `DROP TABLE`, `shutdown`/`reboot`, `Remove-Item -Recurse -Force`).
   Solche Befehle bekommen ein rotes ⚠; *Ausführen* braucht einen zweiten Klick („Wirklich ausführen“).
4. **Secrets maskieren, bevor etwas den Rechner verlässt:** Regex-Filter für private Keys
   (`-----BEGIN … PRIVATE KEY-----`), Token-Formate (`ghp_`, `sk-`, `AKIA…`, JWTs), `password=`/`PASSWORD:`
   und Werte aus `.env`-Zeilen → `[REDACTED]`. Gespeicherte Host-Passwörter werden zusätzlich exakt
   gesucht und ersetzt.
5. **Pro Host abschaltbar** (`disabledHosts`) — z. B. Produktionsdatenbanken.
6. **Sichtbarer Kontext:** an jeder Nachricht ist aufklappbar, was mitging. *Terminal mitlesen* lässt sich
   pro Tab ausschalten.
7. **Gespeichert wird nur Maskiertes**, verschlüsselt in `ai.sqlite`; Probleme lassen sich einzeln oder alle löschen.
8. **Die AI hat keine eigenen Werkzeuge:** Das einzige Werkzeug ist `propose_command`, und das führt nichts aus,
   sondern zeigt nur eine Karte.

---

## Umsetzung in Schritten

| Phase | Inhalt | Aufwand |
|---|---|---|
| **1 – Chat mit API-Key** | Claude + OpenAI per API-Key (verschlüsselt / 1Password), Schleife mit `propose_command`, Chat-Seitenleiste, Befehlskarten ▶ / ✎ / ⧉, Mitschnitt per Fallback (Prompt/Ruhe/„Fertig“), *AI antwortet direkt auf das Ergebnis*, Risiko-Regeln, Maskierung, `ai.sqlite` mit Problem-Liste, ＋ Neues Problem, Weitermachen nach Neustart | groß |
| **2 – Abos** | ChatGPT direkt („Mit ChatGPT anmelden“, experimentell) · ChatGPT über die Codex-CLI · Claude über die Claude-Code-CLI · MCP-Server mit `propose_command` · Anbieter/Weg pro Problem wählbar · Problem auf andere Server übernehmen | groß |
| **3 – Mitlesen + Shell-Integration** | *Terminal mitlesen*, Rechtsklick „Im Chat fragen“, OSC 133/7 für exakte Abgrenzung + Exit-Code, Fehler-Chip, als gelöst markieren + Zusammenfassung | mittel |
| **4 – Brücken** | Gelöstes Problem → Snippet/Automation, Befehlsleiste, Ollama/lokale Modelle | optional |

Phase 1 ist größer als vorher, weil die Speicherung gleich mit hineinkommt — ohne sie geht der Verlauf bei
jedem Tab-Schließen verloren, und genau das soll ja nicht passieren. Wer Phase 1 kleiner schneiden will:
erst nur Claude, OpenAI direkt danach (gleiche Schleife, zweiter Adapter).

Tests: Unit-Tests (vitest) für Maskierung, Risiko-Regeln, Kürzen, Mitschnitt-Abgrenzung (mit aufgezeichneten Terminal-Streams) und Prompt-Aufbau;
ein Fake-Provider für die Playwright-E2E-Tests, damit keine echte API nötig ist.

## Offene Fragen

- Soll es Firmen-Vorgaben geben (z. B. nur lokale Modelle erlaubt, per Config fest)?
