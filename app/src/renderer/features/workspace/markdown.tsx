import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Assistant replies are markdown. Every element is styled with Tailwind classes
 * via the `components` override (no typography plugin, no stylesheet of our
 * own); syntax-highlight token colours live in index.css, themed off the
 * shadcn palette.
 */

/** A fenced code block: language label, copy button, highlighted body. */
function CodeBlock({ language, children }: { language?: string; children: React.ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = preRef.current?.textContent ?? "";
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="bg-muted/40 my-3 overflow-hidden rounded-lg border select-none">
      <div className="bg-muted/60 flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-muted-foreground font-mono text-[11px]">{language ?? "code"}</span>
        <button
          onClick={copy}
          aria-label="复制代码"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre ref={preRef} className="overflow-x-auto p-3 text-xs leading-relaxed select-text">
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  // `pre` is a passthrough: the `code` handler renders the whole block wrapper
  // so it can own the copy button and language label.
  pre: ({ children }) => <>{children}</>,

  code: ({ className, children }) => {
    // rehype-highlight marks fenced blocks with `hljs` / `language-x`; anything
    // without those is inline code.
    const isBlock = /(^|\s)(hljs|language-)/.test(className ?? "");
    if (!isBlock) {
      return (
        <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>
      );
    }
    const language = /language-(\w+)/.exec(className ?? "")?.[1];
    return (
      <CodeBlock language={language}>
        <code className={className}>{children}</code>
      </CodeBlock>
    );
  },

  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-[15px] font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h4>,

  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,

  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2"
    >
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
  th: ({ children }) => (
    <th className="border-border bg-muted/50 border px-2.5 py-1.5 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-border border px-2.5 py-1.5">{children}</td>,
};

/**
 * rehype plugin: wrap each word (outside code) in `<span class="token-in">` so
 * newly streamed words fade up from transparent. Append-only streaming keeps the
 * leading spans stable, so React reuses them and only new words animate. Enabled
 * only while a reply is streaming.
 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

// Tokenize for the streaming fade: each CJK character is its own token (Chinese
// has no spaces, so per-word would never fade mid-paragraph), other scripts stay
// per whitespace-delimited word, and whitespace runs are preserved verbatim.
const CJK = "\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
const FADE_TOKEN_RE = new RegExp(`\\s+|[${CJK}]|[^\\s${CJK}]+`, "g");

export const fadeTokens = (value: string): string[] => value.match(FADE_TOKEN_RE) ?? [];
export const isFadeSpace = (token: string): boolean => /^\s+$/.test(token);

function rehypeFadeWords() {
  const walk = (node: HastNode, inCode: boolean) => {
    if (!Array.isArray(node.children)) return;
    const insideCode = inCode || node.tagName === "pre" || node.tagName === "code";
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && !insideCode && child.value) {
        for (const part of fadeTokens(child.value)) {
          next.push(
            isFadeSpace(part)
              ? { type: "text", value: part }
              : {
                  type: "element",
                  tagName: "span",
                  properties: { className: ["token-in"] },
                  children: [{ type: "text", value: part }],
                },
          );
        }
      } else {
        if (child.type === "element") walk(child, insideCode);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: HastNode) => walk(tree, false);
}

export function Markdown({
  content,
  className,
  streaming = false,
}: {
  content: string;
  className?: string;
  streaming?: boolean;
}) {
  return (
    <div className={cn("text-sm break-words select-text", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
          ...(streaming ? [rehypeFadeWords] : []),
        ]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
