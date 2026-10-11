# Konzept: AI-Hilfe im Terminal

> Status: 💡 Konzept, noch nicht umgesetzt (README → *AI integration*).

## Ziel

Hilfe direkt dort, wo man arbeitet, ohne den Tab zu verlassen:

1. **Befehl aus Beschreibung:** „zeig mir die 10 größten Dateien in /var/log“ → Vorschlag `du -ah /var/log | sort -rh | head -10`.
2. **Ausgabe/Fehler erklären:** markierten Text oder den letzten Befehl samt Output erklären lassen.
3. **Fix vorschlagen:** nach einem fehlgeschlagenen Befehl einen korrigierten vorschlagen.

Grundregel: **Die AI schreibt nie selbst in die Shell.** Jeder Befehl wird nur vorgeschlagen und
erst nach einem Klick/Enter des Nutzers eingefügt, nie automatisch ausgeführt.

---

## Bedienung (UX)

### 1. Befehlsleiste im Tab (`Ctrl+Shift+Space`)

Eine schmale Eingabezeile blendet sich unten im Terminal-Tab ein (wie die Suche im Browser).

```
┌ web-1 ─────────────────────────────────────────────────────┐
│ user@web-1:~$                                              │
│                                                            │
├────────────────────────────────────────────────────────────┤
│ ✨ größte Dateien in /var/log                        [Esc] │
│ → du -ah /var/log 2>/dev/null | sort -rh | head -10        │
│   Listet alle Dateien mit Größe, sortiert absteigend.      │
│   [Enter] einfügen   [Ctrl+Enter] einfügen + ausführen  ⚠  │
└────────────────────────────────────────────────────────────┘
```

- **Enter** schreibt den Befehl in die Eingabezeile der Shell (ohne `\n`), der Nutzer kann ihn noch ändern.
- **Ctrl+Enter** fügt ein und führt aus, nur wenn der Befehl nicht als riskant markiert ist (s. Sicherheit).
- **Esc** schließt die Leiste, der Fokus geht zurück ins Terminal.

### 2. Kontextmenü „Mit AI erklären“

Rechtsklick auf eine Markierung → **Erklären** / **Fehler beheben**. Antwort erscheint in einer
Seitenleiste rechts im Tab (einklappbar), damit das Terminal sichtbar bleibt. Passt zum bestehenden
Rechtsklick-Verhalten: Der Eintrag erscheint nur im Menü-Modus bzw. per `Shift+Rechtsklick`.

### 3. Seitenleiste (Chat pro Tab)

Optionaler Verlauf pro Terminal-Tab für Rückfragen („und nur .gz-Dateien?“). Codeblöcke in Antworten
haben einen Button **In Terminal einfügen** und **Als Snippet speichern** (Brücke zu Snippets & Automations).

### 4. Hinweis nach Fehler (optional, standardmäßig aus)

Wenn ein Befehl mit Exit-Code ≠ 0 endet (nur erkennbar mit Shell-Integration, s. unten), zeigt ein kleiner
Chip `✨ Fehler erklären?` an. Kein automatischer API-Aufruf, erst der Klick sendet etwas.

---

## Kontext: was die AI zu sehen bekommt

Gute Vorschläge brauchen Kontext, aber nur so viel wie nötig. Der Kontext wird **im Renderer**
zusammengestellt und vor dem Senden angezeigt („Gesendet wird: …“, aufklappbar).

| Kontext | Quelle | Standard |
|---|---|---|
| Betriebssystem/Distro, Shell | Dashboard-Metriken des Hosts (OS wird schon erkannt) bzw. lokales Profil (PowerShell, WSL, bash…) | an |
| Erkannte Dienste (Docker, nginx, PostgreSQL…) | Dashboard | an |
| Aktuelles Verzeichnis | Prompt-Zeile bzw. OSC 7 der Shell-Integration | an |
| Markierter Text | xterm.js-Selection | wenn markiert |
| Letzte N Zeilen Terminal-Output | xterm.js-Buffer (`term.buffer.active`), max. ~100 Zeilen | nur bei „Erklären/Fix“ |
| Hostname, IP, Benutzername | Host-Config | **aus** |

Wichtig: Das Shell-Betriebssystem bestimmt die Syntax. PowerShell, `cmd`, bash im WSL und bash auf
einem Alpine-Server brauchen unterschiedliche Befehle — der Shell-Typ gehört immer in den Prompt.

### Optional: Shell-Integration (OSC 133 / OSC 7)

Um „letzter Befehl + sein Output + Exit-Code“ sauber abzugrenzen, kann Remoty (opt-in, pro Host)
Markierungen aktivieren, wie es VS Code und Windows Terminal tun: `PROMPT_COMMAND`/`precmd` gibt
`OSC 133;A/B/C/D;<exit>` und `OSC 7` (cwd) aus. xterm.js parst das über `registerOscHandler`.
Ohne Integration wird einfach der sichtbare Buffer bzw. die Markierung genommen — das Feature
funktioniert also auch ohne.

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
  task: 'suggest' | 'explain' | 'fix' | 'chat';
  shell: { kind: string; os?: string; cwd?: string };
  input: string;            // Nutzerfrage
  context?: string;         // Markierung / Output (bereits gekürzt + maskiert)
  history?: { role: 'user' | 'assistant'; text: string }[];
}
```

- **Anthropic (Claude)** über die offizielle API, Standard-Modell konfigurierbar.
- **OpenAI-kompatibel** (eine Base-URL + Key): deckt OpenAI, Azure, OpenRouter, LM Studio u. a. ab.
- **Ollama / lokal** (`http://localhost:11434`): nichts verlässt den Rechner — wichtig für Arbeit
  mit Firmen-Servern.

Für `suggest` antwortet das Modell in einem festen JSON-Format, damit die UI Befehl, Erklärung und
Risiko getrennt darstellen kann:

```json
{ "command": "du -ah /var/log | sort -rh | head -10",
  "explanation": "…",
  "risk": "safe" }
```

---

## Architektur in Remoty

```
Renderer (Svelte)                                  Main (Electron)
─────────────────                                  ───────────────
TerminalView.svelte                                ipc/ai.ts
  ├─ AiCommandBar.svelte  ── ai_request ─────────▶   ├─ Kontext prüfen, Secrets maskieren
  ├─ AiSidePanel.svelte                              ├─ core/ai/provider*.ts (HTTP, Streaming)
  └─ aiContext.ts (Buffer/Selection lesen)           └─ core/config/ai.ts  (ai.toml)
        ◀── ai-stream-<requestId> (Event) ────────
        ── ai_cancel ──────────────────────────▶
```

Das folgt den vorhandenen Mustern:

- **IPC:** `ipcMain.handle('ai_request', …)` wie in `ipc/terminal.ts`; die Antwort streamt über ein
  Event pro Anfrage (`ai-stream-<id>`), genau wie Terminal-Output über `terminal-output-<id>`.
- **API-Key nie im Renderer:** Der Key bleibt im Main-Prozess. Speicherung wie das GitHub-Token
  (`core/config/github.ts`): `ai.toml`, verschlüsselt über `secretCipher` (DPAPI/Keychain/libsecret)
  **oder** eine 1Password-Referenz `op://…`, die beim Bedarf gelesen wird.
- **Einfügen in die Shell:** über den bestehenden `sendInput`-Pfad in `TerminalView.svelte`
  (wie der Startbefehl eines Hosts), mit Bracketed Paste, damit mehrzeilige Befehle nicht sofort laufen.

### Einstellungen (`Settings → AI`)

```toml
# ai.toml
enabled = false               # aus, bis der Nutzer es aktiviert
provider = "anthropic"        # anthropic | openai-compatible | ollama
model = "claude-sonnet-…"
baseUrl = ""                  # für openai-compatible / ollama
apiKey = "<verschlüsselt>"    # oder:
apiKeyRef = "op://Private/Anthropic/credential"
sendOutputLines = 100
maskSecrets = true
errorHint = false             # Chip nach fehlgeschlagenem Befehl
disabledHosts = ["prod-db"]   # hier nie etwas senden
```

---

## Sicherheit & Datenschutz

1. **Opt-in.** AI ist standardmäßig aus. Beim Aktivieren ein kurzer Hinweis, welche Daten wohin gehen.
2. **Nie automatisch ausführen.** Vorschläge werden eingefügt, nicht ausgeführt; `Ctrl+Enter` ist bei
   Risiko gesperrt.
3. **Risiko-Erkennung lokal, nicht nur durch das Modell:** eine einfache Regelliste markiert gefährliche
   Muster unabhängig von der Modell-Antwort (`rm -rf`, `mkfs`, `dd of=/dev/`, `chmod -R 777`,
   `> /etc/…`, `curl … | sh`, `DROP TABLE`, `shutdown`/`reboot`, `Remove-Item -Recurse -Force`).
   Solche Befehle bekommen ein rotes ⚠ und brauchen eine Bestätigung.
4. **Secrets maskieren, bevor etwas den Rechner verlässt:** Regex-Filter für private Keys
   (`-----BEGIN … PRIVATE KEY-----`), Token-Formate (`ghp_`, `sk-`, `AKIA…`, JWTs), `password=`/`PASSWORD:`
   und Werte aus `.env`-Zeilen → `[REDACTED]`. Gespeicherte Host-Passwörter werden zusätzlich exakt
   gesucht und ersetzt.
5. **Pro Host abschaltbar** (`disabledHosts`) — z. B. Produktionsdatenbanken.
6. **Vorschau des Kontexts** vor dem Senden, und lokale Modelle (Ollama) als gleichwertige Option.
7. **Keine Speicherung** von Anfragen/Antworten auf der Platte; der Chat-Verlauf lebt nur im Tab.

---

## Umsetzung in Schritten

| Phase | Inhalt | Aufwand |
|---|---|---|
| **1 – MVP** | `ai.toml` + Settings-Seite, ein Anbieter (Anthropic), Befehlsleiste „Befehl aus Beschreibung“, Einfügen ohne Ausführen, lokale Risiko-Regeln | klein |
| **2 – Erklären** | Kontextmenü „Erklären / Fehler beheben“ für Markierung + letzte Zeilen, Seitenleiste mit Streaming, Secret-Maskierung | mittel |
| **3 – Anbieter** | OpenAI-kompatibel + Ollama, 1Password-Referenz für den Key, `disabledHosts` | klein |
| **4 – Shell-Integration** | OSC 133/7 opt-in, „letzter Befehl“ exakt, Fehler-Chip, cwd-Kontext | mittel |
| **5 – Brücken** | „Als Snippet speichern“, Hilfe in der SFTP-Ansicht und im Monaco-Editor (Config-Dateien erklären) | optional |

Tests: Unit-Tests (vitest) für Maskierung, Risiko-Regeln, Prompt-Aufbau und das Parsen der JSON-Antwort;
ein Fake-Provider für die Playwright-E2E-Tests, damit keine echte API nötig ist.

## Offene Fragen

- Welcher Anbieter zuerst — eigener API-Key (Anthropic/OpenAI) oder lokal (Ollama)?
- Reicht die Befehlsleiste als MVP, oder ist „Fehler erklären“ im Alltag wichtiger?
- Soll es Firmen-Vorgaben geben (z. B. nur lokale Modelle erlaubt, per Config fest)?
