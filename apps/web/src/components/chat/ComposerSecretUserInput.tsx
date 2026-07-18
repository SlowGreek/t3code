import { memo } from "react";
import { cn } from "~/lib/utils";

export const ComposerSecretUserInput = memo(function ComposerSecretUserInput({
  label,
  value,
  disabled,
  mobileActions,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly mobileActions: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <input
      autoComplete="off"
      aria-label={label}
      className={cn(
        "min-h-14 w-full bg-transparent px-4 py-3 text-sm text-foreground outline-none",
        mobileActions && "max-sm:pb-11",
      )}
      disabled={disabled}
      name="codex-secret-response"
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder="Enter a secret response"
      type="password"
      value={value}
    />
  );
});
