import { Header } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";

export const AIProviders = (settings: UseSettingsReturn) => {
  return (
    <div className="space-y-3">
      <Header
        title="AI Provider"
        description="Diligently uses Claude (Anthropic). Enter your API key below, or set ANTHROPIC_API_KEY in src-tauri/.env."
        isMainTitle
      />

      {/* Provider key + model */}
      <Providers {...settings} />
    </div>
  );
};
