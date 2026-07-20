import { X } from "lucide-react";
import { Button } from "../ui";

type Props = {
  setupRequired: boolean;
  setIsPopoverOpen: React.Dispatch<React.SetStateAction<boolean>>;
  resizeWindow: (expanded: boolean) => Promise<void>;
  capturing: boolean;
};

export const Header = ({
  setupRequired,
  setIsPopoverOpen,
  resizeWindow,
  capturing,
}: Props) => {
  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-input/50 pb-3 flex justify-between items-start">
        <div>
          <h2 className="font-semibold text-sm">System Audio Capture</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {setupRequired
              ? "Setup required to capture system audio"
              : "Real-time interview AI. Live transcripts from Deepgram, answers from Claude — speak (or play interviewer audio) to test."}
          </p>
        </div>
        {!capturing ? (
          <Button
            size="icon"
            title="Close"
            onClick={() => {
              setIsPopoverOpen(false);
              resizeWindow(false);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
};
