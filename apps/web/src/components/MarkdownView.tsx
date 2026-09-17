import { useMemo, useState } from 'react';
import { marked } from 'marked';

interface MarkdownViewProps {
  content: string;
  isLatest?: boolean;
}

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function MarkdownView({ content, isLatest }: MarkdownViewProps) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const html = useMemo(() => {
    if (!content) return '';
    try {
      return marked.parse(content) as string;
    } catch {
      return content;
    }
  }, [content]);

  return (
    <div className="markdown-view-container">
      <div
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {isLatest && <span className="cursor-blink" />}
    </div>
  );
}
