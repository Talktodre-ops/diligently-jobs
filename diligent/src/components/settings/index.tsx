import { useSettings } from "@/hooks";
import { SettingsIcon } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
  ScrollArea,
} from "@/components";
import { Disclaimer } from "./Disclaimer";
import { SystemPrompt } from "./SystemPrompt";
import { ScreenshotConfigs } from "./ScreenshotConfigs";
import { AppIconToggle } from "./AppIconToggle";
import { AlwaysOnTopToggle } from "./AlwaysOnTopToggle";
import { TitleToggle } from "./TitleToggle";
import { AIProviders } from "./ai-configs";
import { STTProviders } from "./stt-configs";
import { DeleteChats } from "./DeleteChats";
import { ManagedApiSetup } from "./ManagedApiSetup";
import { BackendStatus } from "./BackendStatus";
import { SystemHealth } from "./SystemHealth";

export const Settings = () => {
  const settings = useSettings();

  return (
    <Popover
      open={settings?.isPopoverOpen}
      onOpenChange={settings?.setIsPopoverOpen}
    >
      <PopoverTrigger asChild>
        <Button
          size="icon"
          aria-label="Open Settings"
          className="cursor-pointer [data-state=open]:bg-[red]"
          title="Open Settings"
        >
          <SettingsIcon className="h-4 w-4" />
        </Button>
      </PopoverTrigger>

      {/* Settings Panel */}
      <PopoverContent
        align="end"
        side="bottom"
        className="select-none w-screen p-0 border overflow-hidden border-input/50"
        sideOffset={8}
      >
        <ScrollArea className="h-[calc(100vh-7.2rem)]">
          <div className="p-6 space-y-6">
            {/* System health — diagnostic dashboard for the four subsystems
                interview mode depends on (Anthropic, Deepgram, backend, audio).
                Lets the user see why something isn't working without digging
                through dev tools. */}
            <SystemHealth />

            {/* Backend Sync status (audit log + R2) */}
            <BackendStatus />

            {/* Managed API Setup */}
            <ManagedApiSetup />

            {/* System Prompt */}
            <SystemPrompt {...settings} />

            {/* Screenshot Configs */}
            <ScreenshotConfigs {...settings} />

            {/* App Icon Toggle */}
            <AppIconToggle />

            {/* Always On Top Toggle */}
            <AlwaysOnTopToggle />

            {/* Title Toggle */}
            <TitleToggle />

            {/* Provider Selection */}
            <AIProviders {...settings} />

            {/* STT Providers */}
            <STTProviders {...settings} />

            {/* Disclaimer */}
            <DeleteChats {...settings} />
          </div>

        </ScrollArea>

        <div className="border-t border-input/50">
          <Disclaimer />
        </div>
      </PopoverContent>
    </Popover>
  );
};
