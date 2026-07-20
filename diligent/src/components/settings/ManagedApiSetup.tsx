import { useState, useEffect, useRef } from "react";
import { Button, Header, Switch } from "@/components";
import { ChevronDown, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useApp } from "@/contexts";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components";

interface Model {
  provider: string;
  name: string;
  id: string;
  model: string;
  description: string;
  modality: string;
  isAvailable: boolean;
}

const SELECTED_MANAGED_MODEL_STORAGE_KEY = "selected_managed_model";

export const ManagedApiSetup = () => {
  const { managedApiEnabled, setManagedApiEnabled } = useApp();
  const [models, setModels] = useState<Model[]>([]);
  const [isModelsLoading, setIsModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const fetchInitiated = useRef(false);
  const commandListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const savedModel = localStorage.getItem(SELECTED_MANAGED_MODEL_STORAGE_KEY);
    if (savedModel) {
      try {
        setSelectedModel(JSON.parse(savedModel));
      } catch {
        setSelectedModel(null);
      }
    }

    if (!fetchInitiated.current) {
      fetchInitiated.current = true;
      fetchModels();
    }
  }, []);

  useEffect(() => {
    if (commandListRef.current) {
      commandListRef.current.scrollTop = 0;
    }
  }, [searchValue]);

  const fetchModels = async () => {
    setIsModelsLoading(true);
    try {
      const fetchedModels = await invoke<Model[]>("fetch_models");
      setModels(fetchedModels);
    } catch (error) {
      console.error("Failed to fetch models:", error);
      setModels([]);
    } finally {
      setIsModelsLoading(false);
    }
  };

  const handleModelSelect = (model: Model) => {
    setSelectedModel(model);
    setIsPopoverOpen(false);
    setSearchValue("");
    localStorage.setItem(SELECTED_MANAGED_MODEL_STORAGE_KEY, JSON.stringify(model));
  };

  const handlePopoverOpenChange = (open: boolean) => {
    setIsPopoverOpen(open);
    if (open) {
      setSearchValue("");
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2 flex flex-row items-center justify-between border-b pb-2">
        <Header
          title="Managed API"
          description="Use built-in managed AI/STT endpoints, or disable to use only your custom providers."
        />
        <Button
          size="sm"
          variant="outline"
          onClick={fetchModels}
          disabled={isModelsLoading}
        >
          <RefreshCw
            className={`h-4 w-4 ${isModelsLoading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      <Header
        title={
          isModelsLoading
            ? "Loading models..."
            : `Available managed models: ${models.length}`
        }
        description="Model selection is optional and does not lock app features."
      />

      <Popover
        modal={true}
        open={isPopoverOpen}
        onOpenChange={handlePopoverOpenChange}
      >
        <PopoverTrigger
          asChild
          disabled={isModelsLoading}
          className="cursor-pointer flex justify-start"
        >
          <Button
            variant="outline"
            className="h-11 text-start shadow-none w-full"
          >
            {selectedModel ? selectedModel.name : "Select managed model"}{" "}
            <ChevronDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="bottom"
          className="w-[calc(100vw-4rem)] h-[46vh]"
        >
          <Command shouldFilter={true}>
            <CommandInput
              placeholder="Search model..."
              value={searchValue}
              onValueChange={setSearchValue}
            />
            <CommandList
              ref={commandListRef}
              className="overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-muted [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/30"
            >
              <CommandEmpty>No models found.</CommandEmpty>
              <CommandGroup>
                {models.map((model, index) => (
                  <CommandItem
                    disabled={!model?.isAvailable}
                    key={`${model?.id}-${index}`}
                    className="cursor-pointer"
                    onSelect={() => handleModelSelect(model)}
                  >
                    <div className="flex flex-col">
                      <div className="flex flex-row items-center gap-2">
                        <p className="text-sm font-medium">{`${model?.name} - (${model?.modality})`}</p>
                        <div className="text-xs text-orange-600 bg-white rounded-full px-2">
                          {model?.provider}
                        </div>
                      </div>
                      <p
                        className="text-sm text-muted-foreground line-clamp-2"
                        title={model?.description}
                      >
                        {model?.description}
                      </p>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <div className="flex justify-between items-center">
        <Header
          title={`${managedApiEnabled ? "Disable" : "Enable"} Managed API`}
          description={
            managedApiEnabled
              ? "Managed mode is active for AI and speech processing."
              : "Custom providers are used for AI and speech processing."
          }
        />
        <Switch checked={managedApiEnabled} onCheckedChange={setManagedApiEnabled} />
      </div>
    </div>
  );
};
