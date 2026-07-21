import { GithubIcon } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

const REPO_URL = "https://github.com/Talktodre-ops/diligently-jobs";

export const Disclaimer = () => {
  return (
    <div className="flex items-center justify-between py-4 px-4">
      <button
        type="button"
        onClick={() => openUrl(`${REPO_URL}/issues/new`)}
        className="text-muted-foreground hover:text-primary transition-colors text-sm font-medium cursor-pointer"
      >
        Report a bug
      </button>

      <button
        type="button"
        onClick={() => openUrl(REPO_URL)}
        aria-label="Open the GitHub repository"
        className="text-muted-foreground hover:text-primary transition-colors cursor-pointer"
      >
        <GithubIcon className="w-5 h-5" />
      </button>
    </div>
  );
};
