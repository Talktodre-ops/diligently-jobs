import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Briefcase, Code2, Cpu, Loader2, Mic, Speaker, Zap, Award } from "lucide-react";
import { Button, Switch } from "../ui";
import type { InterviewModel } from "@/lib/functions";
import {
  CODE_LANGUAGES,
  CODE_LANGUAGE_LABELS,
  type CodeLanguage,
} from "@/hooks/useSystemAudio";

interface Props {
  interviewModel: InterviewModel;
  setInterviewModel: (m: InterviewModel) => void;
  useWorkspaceContext: boolean;
  setUseWorkspaceContext: (v: boolean) => void;
  audioSource: "system" | "mic";
  setAudioSource: (s: "system" | "mic") => void;
  /** Hot-swap source without stopping capture. Falls back to setAudioSource
   *  while idle (the hook routes the no-capture case anyway). */
  swapAudioSource?: (s: "system" | "mic") => Promise<void> | void;
  /** True during the ~100ms restart window of a hot swap. */
  isSwappingSource?: boolean;
  codeLanguage: CodeLanguage;
  setCodeLanguage: (l: CodeLanguage) => void;
  ignoreSpeaker: number | null;
  setIgnoreSpeaker: (s: number | null) => void;
  knownSpeakers: number[];
  /** When true, the model picker is disabled — settings cannot be changed
   *  mid-stream. */
  disabled?: boolean;
  /** True while audio capture is live. The source toggle is locked once
   *  capture starts — changing it mid-session wouldn't take effect because
   *  the Rust task is bound to whatever source it opened with. User has to
   *  stop, switch, restart. */
  capturing?: boolean;
  /** Trigger a screen capture → Claude vision call for code questions. */
  onCaptureCode?: () => void;
}

const MODELS: Array<{
  id: InterviewModel;
  label: string;
  icon: React.ReactNode;
  blurb: string;
}> = [
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku",
    icon: <Zap className="h-3 w-3" />,
    blurb: "Fast (~250ms)",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet",
    icon: <Cpu className="h-3 w-3" />,
    blurb: "Default (~500ms)",
  },
  {
    id: "claude-opus-4-7",
    label: "Opus",
    icon: <Award className="h-3 w-3" />,
    blurb: "Max quality",
  },
];

/**
 * Compact controls bar for live capture: pick model + toggle workspace
 * context injection. Sits above the conversation in the popover so the
 * user can switch on the fly.
 */
export const InterviewControls = ({
  interviewModel,
  setInterviewModel,
  useWorkspaceContext,
  setUseWorkspaceContext,
  audioSource,
  setAudioSource,
  swapAudioSource,
  isSwappingSource = false,
  codeLanguage,
  setCodeLanguage,
  ignoreSpeaker,
  setIgnoreSpeaker,
  knownSpeakers,
  disabled = false,
  capturing = false,
  onCaptureCode,
}: Props) => {
  const sources: Array<{
    id: "system" | "mic";
    label: string;
    icon: React.ReactNode;
    blurb: string;
  }> = [
    {
      id: "system",
      label: "System",
      icon: <Speaker className="h-3 w-3" />,
      blurb: "Captures what's playing through your speakers (Zoom/Meet interviewer)",
    },
    {
      id: "mic",
      label: "Mic",
      icon: <Mic className="h-3 w-3" />,
      blurb: "Captures your microphone (in-person interviews or testing solo)",
    },
  ];

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-input/50 bg-muted/20 p-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mr-1">
          Source
        </span>
        {sources.map((s) => {
          const active = s.id === audioSource;
          // Hot-swap path: while capturing, clicking the inactive source
          // cycles the Rust audio task in-place (swapAudioSource). While
          // idle, just flip the persisted preference.
          const isDisabled = disabled || isSwappingSource;
          const handleClick = () => {
            if (active) return;
            if (capturing && swapAudioSource) {
              void swapAudioSource(s.id);
            } else {
              setAudioSource(s.id);
            }
          };
          return (
            <button
              key={s.id}
              type="button"
              disabled={isDisabled}
              onClick={handleClick}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent text-foreground"
              } ${isDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
              title={s.blurb}
            >
              {isSwappingSource && active ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                s.icon
              )}
              {s.label}
            </button>
          );
        })}
        <span className="text-xs text-muted-foreground ml-1">
          {isSwappingSource
            ? "switching…"
            : audioSource === "mic"
              ? "your voice"
              : "interviewer audio"}
        </span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mr-1">
          Model
        </span>
        {MODELS.map((m) => {
          const active = m.id === interviewModel;
          return (
            <button
              key={m.id}
              type="button"
              disabled={disabled}
              onClick={() => setInterviewModel(m.id)}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent text-foreground"
              } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
              title={m.blurb}
            >
              {m.icon}
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Briefcase className="h-3 w-3 text-muted-foreground" />
        <span className="text-xs text-muted-foreground flex-1">
          Use active job workspace context
        </span>
        <Switch
          checked={useWorkspaceContext}
          onCheckedChange={setUseWorkspaceContext}
        />
      </div>
      <AudioLevelMeter />

      {/* Diarization controls — surface ONLY when we've seen 2+ distinct
          speakers, because that's when filtering becomes meaningful (mic
          in a room with the user + interviewer present). */}
      {knownSpeakers.length >= 2 && (
        <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-input/30">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mr-1">
            Voices
          </span>
          {knownSpeakers.map((s) => {
            const ignored = ignoreSpeaker === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setIgnoreSpeaker(ignored ? null : s)}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                  ignored
                    ? "bg-red-500/20 text-red-700 dark:text-red-300 line-through"
                    : "bg-background hover:bg-accent text-foreground"
                }`}
                title={
                  ignored
                    ? `Ignoring speaker ${s} (your own voice). Click to listen again.`
                    : `Click to mark speaker ${s} as your own voice and ignore them.`
                }
              >
                Speaker {s}
              </button>
            );
          })}
          {ignoreSpeaker !== null && (
            <span className="text-xs text-muted-foreground">
              · Speaker {ignoreSpeaker} muted
            </span>
          )}
        </div>
      )}

      {onCaptureCode && (
        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-input/30">
          <Button
            size="sm"
            variant="outline"
            onClick={onCaptureCode}
            disabled={disabled}
            className="text-xs"
            title="Capture the visible screen and ask Claude to solve the coding problem shown"
          >
            <Code2 className="h-3 w-3" />
            Capture code question
          </Button>
          <span className="text-xs text-muted-foreground">in</span>
          <select
            value={codeLanguage}
            onChange={(e) => setCodeLanguage(e.target.value as CodeLanguage)}
            disabled={disabled}
            className="text-xs rounded-md border border-input bg-background px-2 py-1 disabled:opacity-50"
            title="Language Claude uses for code answers (voice + screenshot)"
          >
            {CODE_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {CODE_LANGUAGE_LABELS[l]}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
};

/**
 * Live audio level bar. Listens for the `audio-level` Tauri event emitted
 * from the capture loop (~10Hz, peak RMS over each window). A flat-zero
 * meter with the green badge showing "Listening" is the smoking gun for
 * a silent mic or selected-wrong-input issue.
 */
function AudioLevelMeter() {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await listen<number>("audio-level", (e) => {
        setLevel(Math.min(1, Math.max(0, e.payload ?? 0)));
      });
    })();
    return () => unlisten?.();
  }, []);

  // RMS is rarely > 0.3 for normal speech; scale visually so meaningful
  // levels fill more of the bar. Log-ish curve via sqrt.
  const visual = Math.min(1, Math.sqrt(level / 0.3));
  const color =
    level < 0.005
      ? "bg-zinc-500/40"
      : level < 0.05
        ? "bg-emerald-500"
        : level < 0.2
          ? "bg-yellow-500"
          : "bg-red-500";

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-12">level</span>
      <div className="flex-1 h-1.5 rounded-full bg-input/50 overflow-hidden">
        <div
          className={`h-full transition-[width] duration-100 ${color}`}
          style={{ width: `${visual * 100}%` }}
        />
      </div>
    </div>
  );
}
