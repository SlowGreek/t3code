import type { ThreadReviewTarget } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { cn } from "~/lib/utils";

type ReviewTargetKind = ThreadReviewTarget["type"];
type ReviewDelivery = "inline" | "detached";
type ReviewTargetInput =
  | { readonly type: "uncommittedChanges" }
  | { readonly type: "baseBranch"; readonly branch: string }
  | { readonly type: "commit"; readonly sha: string; readonly title?: string | null }
  | { readonly type: "custom"; readonly instructions: string };

const TARGETS: ReadonlyArray<{
  readonly type: ReviewTargetKind;
  readonly label: string;
  readonly description: string;
}> = [
  {
    type: "uncommittedChanges",
    label: "Uncommitted",
    description: "Review current working-tree changes.",
  },
  {
    type: "baseBranch",
    label: "Base branch",
    description: "Review changes relative to a branch.",
  },
  {
    type: "commit",
    label: "Commit",
    description: "Review one commit by SHA.",
  },
  {
    type: "custom",
    label: "Custom",
    description: "Give Codex custom review instructions.",
  },
];

export function buildReviewTarget(input: {
  readonly type: ReviewTargetKind;
  readonly value: string;
  readonly commitTitle: string;
}): ReviewTargetInput | null {
  const value = input.value.trim();
  switch (input.type) {
    case "uncommittedChanges":
      return { type: "uncommittedChanges" };
    case "baseBranch":
      return value ? { type: "baseBranch", branch: value } : null;
    case "commit": {
      if (!value) return null;
      const title = input.commitTitle.trim();
      return { type: "commit", sha: value, ...(title ? { title } : {}) };
    }
    case "custom":
      return value ? { type: "custom", instructions: value } : null;
  }
}

export function ReviewStartDialog({
  open,
  onOpenChange,
  onStart,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStart: (input: {
    readonly target: ReviewTargetInput;
    readonly delivery: ReviewDelivery;
  }) => Promise<void>;
}) {
  const [targetType, setTargetType] = useState<ReviewTargetKind>("uncommittedChanges");
  const [value, setValue] = useState("");
  const [commitTitle, setCommitTitle] = useState("");
  const [delivery, setDelivery] = useState<ReviewDelivery>("inline");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTargetType("uncommittedChanges");
    setValue("");
    setCommitTitle("");
    setDelivery("inline");
    setSubmitting(false);
  }, [open]);

  const target = useMemo(
    () => buildReviewTarget({ type: targetType, value, commitTitle }),
    [commitTitle, targetType, value],
  );

  const submit = async () => {
    if (!target || submitting) return;
    setSubmitting(true);
    try {
      await onStart({ target, delivery });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup aria-label="Start Codex review">
        <DialogHeader>
          <DialogTitle>Start Codex review</DialogTitle>
          <DialogDescription>
            Run the app-server&apos;s native review flow against the exact scope you choose.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="grid grid-cols-2 gap-2">
            {TARGETS.map((option) => (
              <button
                key={option.type}
                type="button"
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  targetType === option.type
                    ? "border-primary/50 bg-primary/8"
                    : "border-border/60 hover:bg-muted/40",
                )}
                onClick={() => {
                  setTargetType(option.type);
                  setValue("");
                  setCommitTitle("");
                }}
              >
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {option.description}
                </span>
              </button>
            ))}
          </div>

          {targetType === "baseBranch" ? (
            <Input
              autoFocus
              aria-label="Base branch"
              placeholder="main"
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          ) : targetType === "commit" ? (
            <div className="space-y-2">
              <Input
                autoFocus
                aria-label="Commit SHA"
                placeholder="Commit SHA"
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
              />
              <Input
                aria-label="Commit title"
                placeholder="Optional commit title"
                value={commitTitle}
                onChange={(event) => setCommitTitle(event.currentTarget.value)}
              />
            </div>
          ) : targetType === "custom" ? (
            <Textarea
              autoFocus
              aria-label="Custom review instructions"
              placeholder="Review the authentication changes for correctness and regressions."
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          ) : null}

          <div>
            <div className="mb-2 text-sm font-medium">Delivery</div>
            <div className="grid grid-cols-2 gap-2">
              {(["inline", "detached"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                    delivery === option
                      ? "border-primary/50 bg-primary/8"
                      : "border-border/60 hover:bg-muted/40",
                  )}
                  onClick={() => setDelivery(option)}
                >
                  {option === "inline" ? "Current thread" : "New review thread"}
                </button>
              ))}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!target || submitting} onClick={() => void submit()}>
            {submitting ? "Starting..." : "Start review"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
