import { notePreview } from "./notePreview";

export function ConversationNotesPreview({ text }: { text: string }) {
  const preview = notePreview(text);
  if (!preview) return <span className="line-clamp-6 whitespace-pre-wrap break-words text-xs leading-relaxed">{text}</span>;
  return (
    <span className="block space-y-3 break-words text-xs leading-relaxed">
      <span className="line-clamp-2 font-medium text-foreground">{preview.title}</span>
      {preview.sections.map((section, index) => (
        <span key={index} className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{section.label}</span>
          <span className="line-clamp-3 whitespace-pre-wrap">{section.text}</span>
        </span>
      ))}
    </span>
  );
}
