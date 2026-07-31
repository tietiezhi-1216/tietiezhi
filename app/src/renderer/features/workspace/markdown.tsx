import { memo, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const block = String(children).includes("\n") || /language-/.test(className ?? "");
    if (!block) {
      return <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>;
    }
    return <CodeBlock language={/language-(\w+)/.exec(className ?? "")?.[1]}>{children}</CodeBlock>;
  },
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-[15px] font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-muted-foreground/30 text-muted-foreground my-2 border-l-2 pl-3">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border my-4" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-border bg-muted/50 border px-2.5 py-1.5 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-border border px-2.5 py-1.5">{children}</td>,
};

export const Markdown = memo(function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn("text-sm break-words select-text", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

function CodeBlock({
  language,
  children,
}: {
  language?: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const text = String(children).replace(/\n$/, "");
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    });
  };

  return (
    <div className="bg-muted/40 my-3 overflow-hidden rounded-lg border select-none">
      <div className="bg-muted/60 flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-muted-foreground font-mono text-[11px]">{language ?? "code"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="复制代码"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed select-text">
        <code>{text}</code>
      </pre>
    </div>
  );
}
