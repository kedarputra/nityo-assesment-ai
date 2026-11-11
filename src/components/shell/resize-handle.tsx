"use client";

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";

export interface ResizeHandleProps {
  // The custom property that sets the column's width on the app's body, such as --list.
  cssVar: "--sidebar" | "--list";
  // The column being resized, measured when a drag starts.
  measure: string;
  min: number;
  max: number;
  label: string;
  className: string;
}

const APP = ".app-body";
const STEP = 16;
const storageKey = (cssVar: string) => `hp.width${cssVar.replace("--", ".")}`;

// A handle between two columns that a person drags left or right to make one wider or narrower
// (as in Outlook). Arrow keys move it too, a double-click puts it back, and the width is
// remembered in this browser. It sets a custom property; the grid does the rest.
export function ResizeHandle({ cssVar, measure, min, max, label, className }: ResizeHandleProps) {
  const handle = useRef<HTMLDivElement>(null);

  // A width remembered from an earlier visit applies as the page appears.
  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey(cssVar)));
      if (stored >= min && stored <= max) {
        document.querySelector<HTMLElement>(APP)?.style.setProperty(cssVar, `${stored}px`);
        handle.current?.setAttribute("aria-valuenow", String(stored));
      }
    } catch {
      // Not remembered; the default width stands.
    }
  }, [cssVar, min, max]);

  function current(): number {
    return document.querySelector(measure)?.getBoundingClientRect().width ?? min;
  }

  function apply(width: number): number {
    const clamped = Math.round(Math.min(max, Math.max(min, width)));
    document.querySelector<HTMLElement>(APP)?.style.setProperty(cssVar, `${clamped}px`);
    handle.current?.setAttribute("aria-valuenow", String(clamped));
    return clamped;
  }

  function remember(width: number) {
    try {
      window.localStorage.setItem(storageKey(cssVar), String(width));
    } catch {
      // Applied for this visit only.
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = current();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    document.body.dataset.resizing = "true";
    let width = startWidth;
    const move = (moveEvent: globalThis.PointerEvent) => {
      width = apply(startWidth + moveEvent.clientX - startX);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      delete document.body.dataset.resizing;
      remember(width);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    remember(apply(current() + (event.key === "ArrowRight" ? STEP : -STEP)));
  }

  function reset() {
    document.querySelector<HTMLElement>(APP)?.style.removeProperty(cssVar);
    try {
      window.localStorage.removeItem(storageKey(cssVar));
    } catch {
      // Nothing was remembered.
    }
  }

  return (
    <div
      ref={handle}
      className={`resize-handle ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={reset}
    />
  );
}
