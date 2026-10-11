// The AI's answers are plain text with a little Markdown in them — code blocks and
// `inline code` mostly. They are split into parts the panel renders as elements (never
// as HTML), so nothing in an answer can inject markup.

export type AiTextPart = { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'block'; text: string };

export function aiTextParts(text: string): AiTextPart[] {
  const parts: AiTextPart[] = [];
  const blocks = text.split(/```[^\n`]*\n?/);
  blocks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const code = chunk.replace(/\n$/, '');
      if (code) parts.push({ kind: 'block', text: code });
      return;
    }
    chunk.split(/(`[^`\n]+`)/).forEach((piece) => {
      if (!piece) return;
      if (piece.length > 2 && piece.startsWith('`') && piece.endsWith('`')) parts.push({ kind: 'code', text: piece.slice(1, -1) });
      else parts.push({ kind: 'text', text: piece.replace(/\*\*([^*\n]+)\*\*/g, '$1') });
    });
  });
  return parts;
}

/** "3 lines", "1 line". */
export function lineCount(text: string | undefined): string {
  const n = text ? text.split('\n').length : 0;
  return `${n} line${n === 1 ? '' : 's'}`;
}

/** "today, 10:42", "yesterday", "12 Sep". */
export function relativeDay(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days === 0) return `today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
