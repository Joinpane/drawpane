/**
 * Copying a value: an invite link, a prototype link, a command. The button
 * says "Copied" for a moment, then goes back, and a clipboard that refuses
 * (an insecure origin, a denied permission) leaves it as it was.
 */
import { Button } from "@drawpane/ui";
import { useCallback, useEffect, useRef, useState } from "react";

const SHOWN_MS = 1600;

/** Which copy just happened (by key), and a function that copies. */
export function useCopy<K extends string = string>(): [
  copied: K | null,
  copy: (text: string, key: K) => Promise<void>,
] {
  const [copied, setCopied] = useState<K | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(async (text: string, key: K) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(key);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied((c) => (c === key ? null : c)), SHOWN_MS);
  }, []);
  return [copied, copy];
}

/** A value shown in mono, with a button that copies it. */
export function CopyField({
  value,
  label = "Copy",
  primary = false,
}: {
  value: string;
  /** The button's label before copying ("Copy link"). */
  label?: string;
  primary?: boolean;
}) {
  const [copied, copy] = useCopy<"value">();
  return (
    <div className="app-copy">
      <code>{value}</code>
      <Button
        size="sm"
        variant={primary ? "primary" : "secondary"}
        onClick={() => void copy(value, "value")}
      >
        {copied ? "Copied" : label}
      </Button>
    </div>
  );
}
