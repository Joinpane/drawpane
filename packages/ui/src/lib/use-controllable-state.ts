import { useCallback, useState } from "react";

/**
 * State that is controlled when `value` is defined and uncontrolled otherwise. `onChange` is
 * called for every change in both modes.
 */
export function useControllableState<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void,
): [T, (next: T) => void] {
  const [internal, setInternal] = useState(defaultValue);
  const controlled = value !== undefined;
  const setValue = useCallback(
    (next: T) => {
      if (!controlled) setInternal(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [controlled ? value : internal, setValue];
}
