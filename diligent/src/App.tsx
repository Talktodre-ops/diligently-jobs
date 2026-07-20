import { useEffect, useState } from "react";
import { Card, Settings, SystemAudio, Updater } from "./components";
import { AppDragControls } from "./components/AppDragControls";
import { ToastProvider, useGlobalToastListeners } from "./components/Toast";
import { Completion } from "./components/completion";
import { ChatHistory } from "./components/history";
import { AudioVisualizer } from "./components/speech/audio-visualizer";
import { StatusIndicator } from "./components/speech/StatusIndicator";
import { useTitles } from "./hooks";
import { useSystemAudio } from "./hooks/useSystemAudio";
import { useWindowResize } from "./hooks/useWindow";
import { listen } from "@tauri-apps/api/event";
import type { ChatConversation } from "./types";
import { Briefcase, Send, Sparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Popover, PopoverContent, PopoverTrigger } from "./components/ui";
import { JobModePanel } from "./components/job/JobModePanel";
import { UpworkModePanel } from "./components/upwork/UpworkModePanel";

const AppInner = () => {
  const systemAudio = useSystemAudio();
  const [isHidden, setIsHidden] = useState(false);
  const [jobModeOpen, setJobModeOpen] = useState(false);
  const [upworkModeOpen, setUpworkModeOpen] = useState(false);
  const { resizeWindow } = useWindowResize();
  // Initialize title management
  useTitles();
  // Surface global Tauri events (toast events from Rust, shortcut conflicts)
  useGlobalToastListeners();
  const handleSelectConversation = (conversation: ChatConversation) => {
    // Use localStorage to communicate the selected conversation to Completion component
    localStorage.setItem("selectedConversation", JSON.stringify(conversation));
    // Trigger a custom event to notify Completion component
    window.dispatchEvent(
      new CustomEvent("conversationSelected", {
        detail: conversation,
      })
    );
  };

  const handleNewConversation = () => {
    // Clear any selected conversation and trigger new conversation
    localStorage.removeItem("selectedConversation");
    window.dispatchEvent(new CustomEvent("newConversation"));
  };

  // WINDOWS HIDE/SHOW TOGGLE WINDOW WORKAROUND FOR SHORTCUTS
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<boolean>("toggle-window-visibility", (event) => {
      const platform = navigator.platform.toLowerCase();
      if (typeof event.payload === "boolean" && platform.includes("win")) {
        setIsHidden(!event.payload);
        const popover = document.getElementById("popover-content");
        if (popover) {
          popover.style.setProperty("display", "none", "important");
          popover.setAttribute("data-state", "closed");
          const popoverTriggers = document.querySelectorAll(
            '[data-slot="popover-trigger"]'
          );
          popoverTriggers.forEach((trigger) => {
            trigger.setAttribute("data-state", "closed");
          });
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  return (
    <div
      className={`w-screen h-screen flex overflow-hidden justify-center items-start ${
        isHidden ? "hidden pointer-events-none" : ""
      }`}
    >
      {/* `data-tauri-drag-region` on the Card means any empty space between
          buttons is a drag handle. Buttons (form controls) are automatically
          excluded from drag by Tauri, so they still click normally. */}
      <Card
        data-tauri-drag-region
        className="w-full flex flex-row items-center gap-2 p-2"
      >
        <AppDragControls />
        <SystemAudio {...systemAudio} />
        {systemAudio?.capturing ? (
          <div className="flex flex-row items-center gap-2 justify-between w-full">
            <div className="flex flex-1 items-center gap-2">
              <AudioVisualizer isRecording={systemAudio?.capturing} />
            </div>
            <div className="flex !w-fit items-center gap-2">
              <StatusIndicator
                setupRequired={systemAudio.setupRequired}
                error={systemAudio.error}
                isProcessing={systemAudio.isProcessing}
                isAIProcessing={systemAudio.isAIProcessing}
                capturing={systemAudio.capturing}
              />
            </div>
          </div>
        ) : null}

        <div
          className={`${
            systemAudio?.capturing
              ? "hidden w-full fade-out transition-all duration-300"
              : "w-full flex flex-row gap-2 items-center"
          }`}
        >
          <Completion isHidden={isHidden} />
          <ChatHistory
            onSelectConversation={handleSelectConversation}
            onNewConversation={handleNewConversation}
            currentConversationId={null}
          />
          <Popover
            open={jobModeOpen}
            onOpenChange={(open) => {
              setJobModeOpen(open);
              resizeWindow(open);
            }}
          >
            <PopoverTrigger asChild>
              <Button
                size="icon"
                aria-label="Job Copilot"
                className="cursor-pointer"
                title="Job Copilot"
              >
                <Briefcase className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="bottom"
              className="select-none w-screen p-0 border overflow-hidden border-input/50"
              sideOffset={8}
            >
              <JobModePanel />
            </PopoverContent>
          </Popover>
          <Popover
            open={upworkModeOpen}
            onOpenChange={(open) => {
              setUpworkModeOpen(open);
              resizeWindow(open);
            }}
          >
            <PopoverTrigger asChild>
              <Button
                size="icon"
                aria-label="Upwork Proposals"
                className="cursor-pointer"
                title="Upwork Proposals"
              >
                <Send className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="bottom"
              className="select-none w-screen p-0 border overflow-hidden border-input/50"
              sideOffset={8}
            >
              <UpworkModePanel />
            </PopoverContent>
          </Popover>
          <Button
            size="icon"
            aria-label="RealmQ Studio"
            className="cursor-pointer"
            title="RealmQ Studio"
            onClick={() => {
              invoke("open_realmq_window").catch((e) =>
                console.error("[realmq] open_realmq_window failed:", e)
              );
            }}
          >
            <Sparkles className="h-4 w-4" />
          </Button>
          <Settings />
        </div>

        <Updater capturing={systemAudio?.capturing} />
      </Card>
    </div>
  );
};

// Wrap the app in ToastProvider so every component can call useToast(). The
// provider also renders the toast viewport (fixed bottom-right).
const App = () => (
  <ToastProvider>
    <AppInner />
  </ToastProvider>
);

export default App;
