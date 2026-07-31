import { useEffect } from "react";

const SCROLL_HIDE_DELAY = 700;

const SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

export function ScrollbarVisibility() {
  useEffect(() => {
    const root = document.documentElement;
    let hideTimer = 0;

    const showScrollbar = () => {
      root.dataset.scrolling = "true";
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        delete root.dataset.scrolling;
      }, SCROLL_HIDE_DELAY);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) showScrollbar();
    };

    const scrollOptions: AddEventListenerOptions = {
      capture: true,
      passive: true,
    };
    const passiveOptions: AddEventListenerOptions = { passive: true };

    document.addEventListener("scroll", showScrollbar, scrollOptions);
    document.addEventListener("wheel", showScrollbar, passiveOptions);
    document.addEventListener("touchmove", showScrollbar, passiveOptions);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(hideTimer);
      delete root.dataset.scrolling;
      document.removeEventListener("scroll", showScrollbar, scrollOptions);
      document.removeEventListener("wheel", showScrollbar, passiveOptions);
      document.removeEventListener("touchmove", showScrollbar, passiveOptions);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return null;
}
