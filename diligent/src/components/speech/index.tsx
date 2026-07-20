import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  ScrollArea,
} from "@/components/ui";
import {
  HeadphonesIcon,
  AlertCircleIcon,
  LoaderIcon,
  AudioLinesIcon,
} from "lucide-react";
import { Header } from "./Header";
import { SetupInstructions } from "./SetupInstructions";
import { OperationSection } from "./OperationSection";
import { Context } from "./Context";
import { InterviewControls } from "./InterviewControls";
import { WindowControls } from "./WindowControls";
import { useSystemAudioType } from "@/hooks";

export const SystemAudio = ({
  capturing,
  isInitializing,
  isProcessing,
  isAIProcessing,
  lastTranscription,
  lastAIResponse,
  interimText,
  error,
  setupRequired,
  startCapture,
  stopCapture,
  isPopoverOpen,
  setIsPopoverOpen,
  useSystemPrompt,
  setUseSystemPrompt,
  contextContent,
  setContextContent,
  startNewConversation,
  conversation,
  resizeWindow,
  handleSetup,
  quickActions,
  addQuickAction,
  removeQuickAction,
  isManagingQuickActions,
  setIsManagingQuickActions,
  showQuickActions,
  setShowQuickActions,
  handleQuickActionClick,
  interviewModel,
  setInterviewModel,
  useWorkspaceContext,
  setUseWorkspaceContext,
  audioSource,
  setAudioSource,
  swapAudioSource,
  isSwappingSource,
  ignoreSpeaker,
  setIgnoreSpeaker,
  knownSpeakers,
  codeLanguage,
  setCodeLanguage,
  captureAndAnalyzeScreen,
  exportConversation,
}: useSystemAudioType) => {
  const platform = navigator.platform.toLowerCase();
  const handleToggleCapture = async () => {
    if (isInitializing) return; // ignore extra clicks while warming up
    if (capturing) {
      await stopCapture();
    } else {
      await startCapture();
    }
  };

  const getButtonIcon = () => {
    if (setupRequired) return <AlertCircleIcon className="text-orange-500" />;
    if (error && !setupRequired)
      return <AlertCircleIcon className="text-red-500" />;
    if (isInitializing) return <LoaderIcon className="animate-spin text-blue-500" />;
    if (isProcessing) return <LoaderIcon className="animate-spin" />;
    if (capturing)
      return <AudioLinesIcon className="text-green-500 animate-pulse" />;
    return <HeadphonesIcon />;
  };

  const getButtonTitle = () => {
    if (setupRequired) return "Setup required - Click for instructions";
    if (error && !setupRequired) return `Error: ${error}`;
    if (isInitializing) return "Starting audio capture...";
    if (isProcessing) return "Transcribing audio...";
    if (capturing) return "Stop system audio capture";
    return "Start system audio capture";
  };

  return (
    <Popover
      open={isPopoverOpen}
      onOpenChange={(open) => {
        // Don't allow closing the popover when capturing is active OR while
        // we're still booting up (close-while-init would orphan the Rust task).
        if ((capturing || isInitializing) && !open) {
          return;
        }
        setIsPopoverOpen(open);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="icon"
          title={getButtonTitle()}
          onClick={handleToggleCapture}
          disabled={isInitializing}
          className={`${capturing ? "bg-green-50 hover:bg-green-100" : ""} ${
            error ? "bg-red-100 hover:bg-red-200" : ""
          } ${isInitializing ? "opacity-70 cursor-wait" : ""}`}
        >
          {getButtonIcon()}
        </Button>
      </PopoverTrigger>

      {capturing || isInitializing || setupRequired || error ? (
        <PopoverContent
          align="end"
          side="bottom"
          className="select-none w-screen p-0 border overflow-hidden border-input/50"
          sideOffset={8}
        >
          {/* Persistent drag bar + click-through toggle. Outside the scroll
              area so it's always visible no matter how long the conversation
              gets. */}
          <WindowControls />
          {/* `100vh - 7rem` accounts for:
              - The popover's offset below the trigger (~50px)
              - The WindowControls bar at the top of the popover (~30px)
              - The PopoverContent's rounded border at the bottom (~8px)
              Total ~7rem of vertical space the ScrollArea can't use.
              Previously `4rem` left ~24-36px clipped at the bottom when
              the user scrolled all the way down. */}
          <ScrollArea className="h-[calc(100vh-7rem)]">
            {/* `max-w-[100vw] overflow-x-hidden` here is what keeps the
                Mermaid diagram (and any other wide content) from pushing
                the whole popover sideways. Radix ScrollArea wraps children
                in an internal `display: table` div that grows to fit the
                widest descendant — capping THIS wrapper at viewport width
                and clipping its horizontal overflow stops that cascade.
                The MermaidBlock's own `overflow-x-auto` then handles the
                diagram's internal scroll so only the diagram scrolls,
                not the body.
                `pb-12` adds a comfortable breathing-room margin at the
                bottom of the scrollable content so the last lines aren't
                flush against the popover's rounded corner. */}
            <div
              className={`p-6 pb-12 max-w-[100vw] overflow-x-hidden ${
                !lastTranscription && !lastAIResponse
                  ? "space-y-6"
                  : "space-y-4"
              }`}
            >
              {/* Header - Hide when there are messages to save space */}
              {!lastTranscription && !lastAIResponse && (
                <Header
                  setupRequired={setupRequired}
                  setIsPopoverOpen={setIsPopoverOpen}
                  resizeWindow={resizeWindow}
                  capturing={capturing}
                />
              )}

              {/* Error Display - Show simple error messages for non-setup issues */}
              {error && !setupRequired && (
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <AlertCircleIcon className="w-5 h-5 text-red-500 mt-1 flex-shrink-0" />
                    <div className="space-y-2 w-full">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-semibold text-xs text-red-700">
                          {/* Capture errors during a code-screenshot turn
                              come from the JPEG/Anthropic path; everything
                              else is audio/transcription. The category
                              prefix from Rust (e.g. "CaptureFailed:") gives
                              the user a hint of what to retry. */}
                          {error.startsWith("CaptureFailed") ||
                          error.startsWith("MonitorEnum") ||
                          error.startsWith("EmptyImage") ||
                          error.startsWith("CannotCompress") ||
                          error.startsWith("Anthropic")
                            ? "Screenshot capture error"
                            : "Audio capture error"}
                        </h3>
                        {capturing && captureAndAnalyzeScreen && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            onClick={() => captureAndAnalyzeScreen()}
                            disabled={isAIProcessing}
                          >
                            Retry capture
                          </Button>
                        )}
                      </div>
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                        <p className="text-xs text-red-800">{error}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {setupRequired ? (
                // Setup Instructions Section
                <SetupInstructions
                  setupRequired={setupRequired}
                  handleSetup={handleSetup}
                />
              ) : (
                <>
                  {/* Booting-up indicator — visible during the ~0.5-2s window
                      between user click and the Deepgram WS being live. */}
                  {isInitializing && !capturing && (
                    <div className="flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 py-2.5">
                      <LoaderIcon className="h-4 w-4 animate-spin text-blue-500" />
                      <div className="flex flex-col">
                        <span className="text-xs font-semibold text-blue-700 dark:text-blue-400">
                          Starting interview capture…
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Checking audio access + opening Deepgram WebSocket
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Live "listening" indicator once capture is active. */}
                  {capturing && (
                    <div className="flex items-center gap-3 rounded-xl border border-green-500/30 bg-green-500/10 px-3 py-2.5">
                      <AudioLinesIcon className="h-4 w-4 text-green-500 animate-pulse" />
                      <span className="text-xs font-semibold text-green-700 dark:text-green-400">
                        Listening — speak naturally
                      </span>
                    </div>
                  )}

                  {/* Interview model + workspace context controls */}
                  {capturing && (
                    <InterviewControls
                      interviewModel={interviewModel}
                      setInterviewModel={setInterviewModel}
                      useWorkspaceContext={useWorkspaceContext}
                      setUseWorkspaceContext={setUseWorkspaceContext}
                      audioSource={audioSource}
                      setAudioSource={setAudioSource}
                      swapAudioSource={swapAudioSource}
                      isSwappingSource={isSwappingSource}
                      codeLanguage={codeLanguage}
                      setCodeLanguage={setCodeLanguage}
                      ignoreSpeaker={ignoreSpeaker}
                      setIgnoreSpeaker={setIgnoreSpeaker}
                      knownSpeakers={knownSpeakers}
                      disabled={isAIProcessing}
                      capturing={capturing}
                      onCaptureCode={() => captureAndAnalyzeScreen()}
                    />
                  )}

                  {/* Live interim transcript — faded line so the user
                      knows we're hearing them in real-time. */}
                  {interimText && (
                    <div className="rounded-lg border border-input/30 bg-muted/10 px-3 py-1.5">
                      <p className="text-xs text-muted-foreground italic line-clamp-2">
                        {interimText}…
                      </p>
                    </div>
                  )}

                  {/* Operation Section */}
                  <OperationSection
                    lastTranscription={lastTranscription}
                    lastAIResponse={lastAIResponse}
                    isAIProcessing={isAIProcessing}
                    conversation={conversation}
                    startNewConversation={startNewConversation}
                    exportConversation={exportConversation}
                    quickActions={quickActions}
                    addQuickAction={addQuickAction}
                    removeQuickAction={removeQuickAction}
                    isManagingQuickActions={isManagingQuickActions}
                    setIsManagingQuickActions={setIsManagingQuickActions}
                    showQuickActions={showQuickActions}
                    setShowQuickActions={setShowQuickActions}
                    handleQuickActionClick={handleQuickActionClick}
                  />
                  {/* Context Settings */}
                  <Context
                    useSystemPrompt={useSystemPrompt}
                    setUseSystemPrompt={setUseSystemPrompt}
                    contextContent={contextContent}
                    setContextContent={setContextContent}
                  />
                </>
              )}
              {!setupRequired && platform.includes("mac") && (
                <SetupInstructions
                  setupRequired={setupRequired}
                  handleSetup={handleSetup}
                />
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      ) : null}
    </Popover>
  );
};
