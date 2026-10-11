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

Pro Terminal-Tab gibt es eine einklappbare Chat-Seitenleiste (`Ctrl+Shift+A`). Der Chat gehört zu
genau diesem Tab, also zu genau dieser Shell auf genau diesem Host.

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

**Weitermachen:** Nach einem ausgeführten Befehl schickt Remoty die Ausgabe automatisch an die AI,
und die AI antwortet mit dem nächsten Schritt (Einstellung *„Nach Ausführen automatisch weiter“*, Standard: an).
Wer lieber erst selbst schaut, schaltet das aus; dann hängt die Ausgabe an der nächsten eigenen Nachricht.

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

Ein schmales Interface im Electron-Main-Prozess, mehrere Implementierungen:

```ts
// packages/electron/src/core/ai/provider.ts
export interface AiProvider {
  id: 'anthropic' | 'openai-compatible' | 'ollama';
  complete(req: AiRequest, signal: AbortSignal): AsyncIterable<string>; // Streaming
}

export interface AiRequest {
  shell: { kind: string; os?: string; cwd?: string; services?: string[] };
  messages: AiMessage[];    // Chat-Verlauf des Tabs, inkl. Befehlsergebnisse
}

export type AiMessage =
  | { role: 'user'; text: string; terminal?: string }        // + „seit letzter Nachricht“ (gekürzt, maskiert)
  | { role: 'assistant'; text: string; commands?: ProposedCommand[] }
  | { role: 'result'; commandId: string; output: string; exitCode?: number; truncated: boolean };
```

- **Anthropic (Claude)** über die offizielle API, Standard-Modell konfigurierbar.
- **OpenAI-kompatibel** (eine Base-URL + Key): deckt OpenAI, Azure, OpenRouter, LM Studio u. a. ab.
- **Ollama / lokal** (`http://localhost:11434`): nichts verlässt den Rechner — wichtig für Arbeit
  mit Firmen-Servern.

**Befehle als Tool-Call, nicht als Text:** Das Modell bekommt ein Tool `propose_command`
(`command`, `explanation`, `risk`). Jeder Aufruf wird zu einer Befehlskarte im Chat. Das Tool-Ergebnis
ist das, was nach *Ausführen* zurückkommt (Ausgabe + Exit-Code) — oder „vom Nutzer übersprungen“.
Damit ist der Ablauf „vorschlagen → Nutzer klickt → Ergebnis → nächster Schritt“ genau die normale
Tool-Schleife der APIs, nur dass zwischen Vorschlag und Ausführung immer der Klick des Nutzers steht.
Modelle ohne Tool-Support (manche lokale) liefern stattdessen Codeblöcke, aus denen die UI Karten macht.

---

## Architektur in Remoty

```
Renderer (Svelte)                                  Main (Electron)
─────────────────                                  ───────────────
TerminalView.svelte                                ipc/ai.ts
  ├─ AiChatPanel.svelte   ── ai_request ─────────▶   ├─ Kontext prüfen, Secrets maskieren
  │   └─ CommandCard.svelte (▶ / ✎ / ⧉)               ├─ core/ai/provider*.ts (HTTP, Streaming)
  ├─ AiCommandBar.svelte                             └─ core/config/ai.ts  (ai.toml)
  ├─ aiCapture.ts   (Ausgabe pro Befehl mitschneiden: OSC 133 bzw. Fallback)
  └─ aiContext.ts   (Buffer seit letzter Nachricht, Selection, Kürzen)
        ◀── ai-stream-<requestId> (Event) ────────
        ── ai_cancel ──────────────────────────▶
```

Das folgt den vorhandenen Mustern:

- **IPC:** `ipcMain.handle('ai_request', …)` wie in `ipc/terminal.ts`; die Antwort streamt über ein
  Event pro Anfrage (`ai-stream-<id>`), genau wie Terminal-Output über `terminal-output-<id>`.
- **API-Key nie im Renderer:** Der Key bleibt im Main-Prozess. Speicherung wie das GitHub-Token
  (`core/config/github.ts`): `ai.toml`, verschlüsselt über `secretCipher` (DPAPI/Keychain/libsecret)
  **oder** eine 1Password-Referenz `op://…`, die beim Bedarf gelesen wird.
- **Ausführen/Einfügen:** über den bestehenden `sendInput`-Pfad in `TerminalView.svelte`
  (wie der Startbefehl eines Hosts, `typedCommandLine`). *Einfügen* nutzt Bracketed Paste ohne Enter,
  damit mehrzeilige Befehle nicht sofort laufen.
- **Mitschnitt im Renderer:** Der Terminal-Output kommt dort ohnehin an (xterm.js); `aiCapture.ts`
  liest den Buffer statt die Rohbytes, so sind Farben/Escape-Codes schon weg. Main muss dafür nichts
  am PTY ändern, und lokale wie SSH-Tabs funktionieren gleich.
- **Chat-Zustand pro Tab:** im bestehenden Sessions-Store neben `termId`; schließt man den Tab, ist der Chat weg.

### Einstellungen (`Settings → AI`)

```toml
# ai.toml
enabled = false               # aus, bis der Nutzer es aktiviert
provider = "anthropic"        # anthropic | openai-compatible | ollama
model = "claude-sonnet-…"
baseUrl = ""                  # für openai-compatible / ollama
apiKey = "<verschlüsselt>"    # oder:
apiKeyRef = "op://Private/Anthropic/credential"
maxOutputLines = 200          # pro Befehl, Anfang + Ende
autoContinue = true           # nach „Ausführen“ Ergebnis direkt an die AI
watchTerminal = true          # „Terminal mitlesen“ als Standard für neue Chats
shellIntegration = true       # OSC 133/7 beim Öffnen des Chats einrichten
maskSecrets = true
errorHint = false             # Chip nach fehlgeschlagenem Befehl
disabledHosts = ["prod-db"]   # hier nie etwas senden
```

---

## Sicherheit & Datenschutz

1. **Opt-in.** AI ist standardmäßig aus. Beim Aktivieren ein kurzer Hinweis, welche Daten wohin gehen.
2. **Nie ohne Klick ausführen.** Jeder Befehl braucht *▶ Ausführen* vom Nutzer. *Automatisch weiter*
   heißt nur: das Ergebnis geht an die AI — der nächste Befehl wartet wieder auf einen Klick.
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
   pro Tab ausschalten, und lokale Modelle (Ollama) sind eine gleichwertige Option.
7. **Keine Speicherung** von Anfragen/Antworten auf der Platte; der Chat-Verlauf lebt nur im Tab.

---

## Umsetzung in Schritten

| Phase | Inhalt | Aufwand |
|---|---|---|
| **1 – Chat + Ausführen** | `ai.toml` + Settings-Seite, ein Anbieter (Anthropic), Chat-Seitenleiste pro Tab, Befehlskarten mit ▶ / ✎ / ⧉, Mitschnitt per Fallback (Prompt/Ruhe/„Fertig“), *Automatisch weiter*, lokale Risiko-Regeln, Secret-Maskierung | mittel |
| **2 – Mitlesen** | *Terminal mitlesen* (alles seit der letzten Nachricht), Rechtsklick „Im Chat fragen“, Kürzen langer Ausgaben, Kontext-Chip | klein |
| **3 – Shell-Integration** | OSC 133/7 für bash/zsh/PowerShell: exakte Abgrenzung, Exit-Code, cwd, Fehler-Chip | mittel |
| **4 – Anbieter** | OpenAI-kompatibel + Ollama, 1Password-Referenz für den Key, `disabledHosts` | klein |
| **5 – Brücken** | Befehlsleiste, „Als Snippet speichern“, ganzen Lösungsweg als Automation speichern, Hilfe im SFTP-Editor | optional |

Tests: Unit-Tests (vitest) für Maskierung, Risiko-Regeln, Kürzen, Mitschnitt-Abgrenzung (mit aufgezeichneten Terminal-Streams) und Prompt-Aufbau;
ein Fake-Provider für die Playwright-E2E-Tests, damit keine echte API nötig ist.

## Offene Fragen

- Welcher Anbieter zuerst — eigener API-Key (Anthropic/OpenAI) oder lokal (Ollama)?
- *Automatisch weiter* standardmäßig an oder aus?
- Soll der Chat beim Schließen des Tabs weg sein, oder als „Lösungsweg“ gespeichert werden können?
- Soll es Firmen-Vorgaben geben (z. B. nur lokale Modelle erlaubt, per Config fest)?
