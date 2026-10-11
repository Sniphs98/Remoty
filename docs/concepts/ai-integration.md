# Konzept: AI-Hilfe im Terminal

> Status: 💡 Konzept, noch nicht umgesetzt (README → *AI integration*).

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
- **Titel** vergibt die AI nach der ersten Nachricht automatisch, umbenennen geht per Klick.
- **Übersicht** über alle Hosts zusätzlich unter *Settings → AI → Probleme* (suchen, löschen, exportieren).

**Speicherung:** eine SQLite-Datei `ai.sqlite` im App-Ordner (neben `hosts.toml` usw.), über
`better-sqlite3`. Electron 33 bringt Node 20 mit, das eingebaute `node:sqlite` gibt es dort noch nicht;
`better-sqlite3` ist ein natives Modul wie `node-pty` und `ssh2`, die der Build schon mitbaut.

```sql
CREATE TABLE problems (
  id            TEXT PRIMARY KEY,
  host_name     TEXT,             -- SSH-Host aus hosts.toml …
  local_profile TEXT,             -- … oder lokales Shell-Profil
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,    -- open | solved | archived
  summary       TEXT,             -- Zusammenfassung beim Lösen
  provider      TEXT,             -- anthropic | openai | chatgpt (zuletzt benutzt)
  model         TEXT,
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

Die Datenbank ist die **einzige Quelle der Wahrheit** (die APIs merken sich nichts): Auch wenn man
den Anbieter wechselt (Claude ↔ OpenAI ↔ ChatGPT-Abo), baut Remoty den Verlauf aus SQLite wieder auf. Bei sehr langen
Problemen gehen ältere Teile als Zusammenfassung mit, die letzten Schritte vollständig.

Gespeichert wird nur, was ohnehin an die AI ging, also bereits **maskiert** (keine Passwörter/Tokens).
Ausgaben und Nachrichten werden zusätzlich mit `secretCipher` verschlüsselt (wie Host-Passwörter), damit
die Datei allein nichts preisgibt. Gelöste Probleme lassen sich automatisch nach *n* Tagen löschen (Standard: nie).

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

Remoty spricht die APIs **direkt** an, ohne fremde CLI dazwischen. Das hält Installation, Code und
Verhalten in Remotys Hand: eigener kurzer Systemprompt, genau ein Werkzeug, eine Schleife.

| Phase | Anbieter | Anmeldung | Abrechnung |
|---|---|---|---|
| **1** | Claude (Anthropic API) | API-Key | pro Anfrage, über die Anthropic Console |
| **1** | OpenAI (API) | API-Key | pro Anfrage, über die OpenAI Platform |
| **2** | ChatGPT (Abo Plus/Pro) | „Mit ChatGPT anmelden“ im Browser | über das Abo |
| — | Claude mit Abo | **nicht vorgesehen** | Anthropic erlaubt Abo-Logins in fremden Apps nicht ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)) |

### Gemeinsames Interface

```ts
// packages/electron/src/core/ai/provider.ts
export interface AiProvider {
  id: 'anthropic' | 'openai' | 'chatgpt';
  /** Ein Schritt der Schleife: Verlauf rein, Text-Stream + evtl. Befehlsvorschläge raus. */
  turn(req: AiTurn, signal: AbortSignal): AsyncIterable<AiEvent>;
}

export interface AiTurn {
  model: string;
  system: string;               // Remotys Systemprompt (Shell, OS, Dienste, Regeln)
  messages: AiMessage[];        // aus SQLite, ältere Teile zusammengefasst
}

export type AiEvent =
  | { type: 'text'; delta: string }
  | { type: 'propose'; id: string; command: string; explanation: string; risk: 'safe' | 'caution' | 'danger' }
  | { type: 'done'; usage?: { input: number; output: number } };
```

**Die Schleife** liegt einmal in Remoty, nicht pro Anbieter:

1. `turn()` mit dem Verlauf aufrufen → Text streamt in den Chat.
2. Ruft das Modell das Werkzeug `propose_command` auf, wird daraus eine Befehlskarte. Die Schleife wartet.
3. Klick auf *▶ Ausführen* → Ausgabe + Exit-Code werden das Ergebnis des Werkzeugaufrufs →
   bei *„AI antwortet direkt auf das Ergebnis“* sofort zurück zu 1, sonst mit der nächsten Nachricht.
4. *Überspringen* liefert „vom Nutzer übersprungen“ als Ergebnis.

`propose_command` ist das **einzige** Werkzeug, das Remoty dem Modell gibt, und es führt nichts aus.

### Phase 1: API-Key (Claude + OpenAI)

- **Claude:** offizielles SDK `@anthropic-ai/sdk`, Messages API mit Streaming und Tool Use.
  Systemprompt und Werkzeugdefinition bleiben über ein Problem hinweg gleich → Prompt-Caching spart
  bei langen Problemen den Großteil der Eingabe-Tokens.
- **OpenAI:** offizielles SDK `openai`, Responses API mit Streaming und Function Calling.
- **Key-Speicherung** wie das GitHub-Token (`core/config/github.ts`): verschlüsselt über `secretCipher`
  (DPAPI/Keychain/libsecret) **oder** als 1Password-Referenz `op://…`, gelesen erst beim Senden. Der Key
  verlässt nie den Main-Prozess.
- **Modell** pro Anbieter wählbar; Remoty zeigt am Problem die verbrauchten Tokens (aus `usage`), damit
  man die Kosten im Blick hat.
- **Testen der Einstellungen:** Knopf *„Verbindung prüfen“* schickt eine Mini-Anfrage.

### Phase 2: ChatGPT-Abo

Wer ChatGPT Plus/Pro hat, soll das statt eines API-Keys nutzen können. Zwei Wege, gleiches Interface:

**A — Direkter Login in Remoty (wie Pi und die opencode-Plugins)** *(bevorzugt)*

- *Settings → AI → Mit ChatGPT anmelden* öffnet den Browser mit dem OpenAI-Login (OAuth mit PKCE,
  Rückleitung auf einen kurzlebigen `localhost`-Port), so wie es die Codex-CLI macht.
- Remoty bekommt Access- und Refresh-Token, speichert sie verschlüsselt über `secretCipher` und
  erneuert sie selbst. Nichts davon geht in den Renderer.
- Anfragen gehen an dasselbe Backend, das die Codex-CLI nutzt; das Format ist das der Responses API,
  der Code aus Phase 1 (OpenAI) wird also größtenteils wiederverwendet.
- **Risiko, offen benannt:** OpenAI duldet das heute, es ist aber **nicht offiziell dokumentiert**. Login-Ablauf
  oder Backend können sich ohne Ankündigung ändern, und OpenAI könnte es untersagen. Darum:
  - als „experimentell“ gekennzeichnet, mit Hinweis beim Anmelden;
  - eigene Datei `core/ai/chatgptAuth.ts`, damit sich der Weg leicht anpassen oder entfernen lässt;
  - schlägt die Anmeldung fehl, bietet Remoty Weg B oder den API-Key an.

**B — Über die Codex-CLI (Ausweichweg)**

- Nutzer installiert `codex` und meldet sich dort an (`codex login`); Remoty startet sie über
  `@openai/codex-sdk` und bekommt nie ein Token zu sehen.
- Langsamer und mehr Aufwand (eigene Werkzeuge der CLI abschalten, `propose_command` über MCP einhängen),
  dafür nah am offiziellen Weg.

---

## Architektur in Remoty

```
Renderer (Svelte)                                  Main (Electron)
─────────────────                                  ───────────────
TerminalView.svelte                                ipc/ai.ts
  ├─ AiChatPanel.svelte   ── ai_request ─────────▶   ├─ Kontext prüfen, Secrets maskieren
  │   ├─ CommandCard.svelte (▶ / ✎ / ⧉)               ├─ core/ai/loop.ts (Schleife, propose_command)
  │   └─ ProblemList.svelte                            ├─ core/ai/anthropic.ts, openai.ts, chatgpt.ts
                                                     ├─ core/ai/chatgptAuth.ts (Phase 2, Login)
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
  bzw. als 1Password-Referenz, wie das GitHub-Token. Der Renderer sieht nur „angemeldet / nicht angemeldet“.
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
provider = "anthropic"        # anthropic | openai | chatgpt (Phase 2)

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
| **2 – ChatGPT-Abo** | „Mit ChatGPT anmelden“ (direkt, experimentell), Token-Erneuerung, Ausweichweg über die Codex-CLI, Anbieter pro Problem wählbar | mittel |
| **3 – Mitlesen + Shell-Integration** | *Terminal mitlesen*, Rechtsklick „Im Chat fragen“, OSC 133/7 für exakte Abgrenzung + Exit-Code, Fehler-Chip, als gelöst markieren + Zusammenfassung | mittel |
| **4 – Brücken** | Gelöstes Problem → Snippet/Automation, Befehlsleiste, Ollama/lokale Modelle | optional |

Phase 1 ist größer als vorher, weil die Speicherung gleich mit hineinkommt — ohne sie geht der Verlauf bei
jedem Tab-Schließen verloren, und genau das soll ja nicht passieren. Wer Phase 1 kleiner schneiden will:
erst nur Claude, OpenAI direkt danach (gleiche Schleife, zweiter Adapter).

Tests: Unit-Tests (vitest) für Maskierung, Risiko-Regeln, Kürzen, Mitschnitt-Abgrenzung (mit aufgezeichneten Terminal-Streams) und Prompt-Aufbau;
ein Fake-Provider für die Playwright-E2E-Tests, damit keine echte API nötig ist.

## Offene Fragen

- Probleme pro Host oder global (ein Problem über mehrere Server, z. B. Web + DB)?
- Phase 2: reicht der direkte ChatGPT-Login, oder soll der Ausweichweg über die Codex-CLI gleich mitkommen?
- Soll es Firmen-Vorgaben geben (z. B. nur lokale Modelle erlaubt, per Config fest)?
