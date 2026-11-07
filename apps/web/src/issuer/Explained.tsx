import { Lightbulb } from "lucide-react";

/** One field's live read-out: what the typed value will do. Renders nothing until there is something to say. */
export function Explained({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <p className="flex gap-1.5 text-xs leading-snug text-foreground/80" aria-live="polite">
      <Lightbulb className="mt-px size-3.5 shrink-0 text-primary" aria-hidden />
      <span>{text}</span>
    </p>
  );
}

/** The whole form in a few plain sentences, kept in step with every edit. */
export function Summary({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-4" aria-live="polite">
      <p className="text-sm font-medium">{title}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/85">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
