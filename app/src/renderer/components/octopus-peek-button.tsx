import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PeekExpression = "open" | "closed" | "look";

export function OctopusPeekButton({
  visible,
  onClick,
  className,
}: {
  visible: boolean;
  onClick: () => void;
  className?: string;
}) {
  const [expression, setExpression] = useState<PeekExpression>("open");
  const [hovered, setHovered] = useState(false);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
  }, []);

  const startReaction = useCallback(() => {
    clearTimers();
    setHovered(true);
    setExpression("closed");
    timers.current = [
      window.setTimeout(() => setExpression("look"), 150),
      window.setTimeout(() => setExpression("closed"), 720),
      window.setTimeout(() => setExpression("look"), 830),
    ];
  }, [clearTimers]);

  const stopReaction = useCallback(() => {
    clearTimers();
    setHovered(false);
    setExpression("open");
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (visible) return;
    stopReaction();
  }, [stopReaction, visible]);

  useEffect(() => {
    if (!visible || hovered) return;
    let reopenTimer = 0;
    const blink = () => {
      setExpression("closed");
      reopenTimer = window.setTimeout(() => setExpression("open"), 145);
    };
    const firstBlink = window.setTimeout(blink, 2_600);
    const interval = window.setInterval(blink, 4_800);
    return () => {
      window.clearTimeout(firstBlink);
      window.clearTimeout(reopenTimer);
      window.clearInterval(interval);
    };
  }, [hovered, visible]);

  const image =
    expression === "closed"
      ? "./octopus-loader/base-closed.png"
      : expression === "look"
        ? "./octopus-loader/base-look-right.png"
        : "./octopus-loader/base-open.png";

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      onMouseEnter={startReaction}
      onMouseLeave={stopReaction}
      onFocus={startReaction}
      onBlur={stopReaction}
      aria-label="返回最新内容"
      aria-hidden={!visible}
      title="返回最新内容"
      tabIndex={visible ? 0 : -1}
      className={cn(
        // `bottom-full -mb-5`：底边压进输入框 20px，章鱼只探出上半截。停靠位置必须用
        // 静态偏移而不是 translate——Button 基础样式带
        // `active:not-aria-[haspopup]:translate-y-px`，选择器优先级高于这里的 translate
        // 工具类，按下时会把按钮瞬间拽回原位，鼠标随之脱离按钮，mouseup 落在别的元素上，
        // click 事件根本不会触发。
        //
        // 刻意不给 z-index：章鱼要沉在输入框后面，压住的那截被输入框盖住。调用方必须把
        // 本组件放在输入框元素**之前**——同为定位元素且 z-index 均为 auto 时按文档顺序
        // 绘制，后面的输入框才会盖在上面。
        "group pointer-events-auto absolute right-5 bottom-full -mb-5 h-16 w-16 overflow-visible rounded-full bg-transparent p-0 shadow-none transition-[opacity,scale] duration-500 ease-out hover:bg-transparent focus-visible:ring-0 motion-reduce:transition-none",
        visible ? "opacity-100" : "pointer-events-none scale-90 opacity-0",
        className,
      )}
    >
      {/*
        水面。没入输入框的那 20px 必须裁掉：输入框是 bg-card/72 + backdrop-blur-xl，
        只挡住 72%，剩下的会把后面的章鱼糊成一团发淡的青色鬼影。
        裁剪框固定在按钮上、不跟着悬停位移走，水线才不会随章鱼一起上浮；
        左右和上方各放 20px 余量，给上浮和右上角那颗装饰点留溢出空间。
      */}
      <span
        aria-hidden
        className="pointer-events-none absolute -top-5 -right-5 -left-5 bottom-5 overflow-hidden"
      >
        <span className="absolute top-5 left-5 block size-16 origin-bottom transition-[translate,rotate,scale] duration-500 ease-out group-hover:-translate-y-3 group-hover:-rotate-6 group-focus-visible:-translate-y-3 group-focus-visible:-rotate-6 group-active:scale-95 motion-reduce:transition-none">
          <img
            src={image}
            alt=""
            draggable={false}
            className="absolute inset-0 size-16 max-w-none object-contain drop-shadow-sm transition-[scale] duration-500 ease-out group-hover:scale-105 group-focus-visible:scale-105"
          />
          <img
            src="./octopus-loader/decor-05.png"
            alt=""
            draggable={false}
            className="absolute top-1 right-0 size-4 translate-x-1 translate-y-2 rotate-12 opacity-0 transition-[opacity,translate,rotate] delay-100 duration-300 group-hover:translate-x-2 group-hover:-translate-y-1 group-hover:rotate-45 group-hover:opacity-100 group-focus-visible:translate-x-2 group-focus-visible:-translate-y-1 group-focus-visible:rotate-45 group-focus-visible:opacity-100"
          />
        </span>
      </span>
    </Button>
  );
}
