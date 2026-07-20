import { Switch, Label, Header } from "@/components";
import { useApp } from "@/contexts";

interface AppIconToggleProps {
  className?: string;
}

export const AppIconToggle = ({ className }: AppIconToggleProps) => {
  const { customizable, toggleAppIconVisibility } = useApp();

  const handleSwitchChange = async (checked: boolean) => {
    await toggleAppIconVisibility(checked);
  };

  return (
    <div className={`space-y-2 ${className}`}>
      <Header
        title="App Icon Visibility"
        description="Control whether the dock/taskbar icon is shown when the window is hidden"
        isMainTitle
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div>
            <Label className="text-sm font-medium">
              {!customizable.appIcon.isVisible
                ? "Show Icon in Dock/Taskbar"
                : "Hide Icon from Dock/Taskbar"}
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              {`Toggle to make App Icon ${
                !customizable.appIcon.isVisible ? "Visible" : "Hidden"
              }`}
            </p>
          </div>
        </div>
        <Switch
          checked={customizable.appIcon.isVisible}
          onCheckedChange={handleSwitchChange}
          aria-label="Toggle app icon visibility"
        />
      </div>
    </div>
  );
};
