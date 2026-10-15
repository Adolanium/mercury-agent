import { useState, useCallback } from "react";
import { ChevronDown, Loader2, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import api from "@/lib/api";
import type { ModelsResponse } from "@/lib/api";
import { useChatStore } from "@/stores/chat";

interface ModelSwitcherProps {
  currentProvider: string;
  currentModel: string;
}

export function ModelSwitcher({
  currentProvider,
  currentModel,
}: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const setProvider = useChatStore((s) => s.setProvider);
  const setModel = useChatStore((s) => s.setModel);

  const loadModels = useCallback(async () => {
    // Always refetch: the Ollama model list changes as models are pulled.
    setLoading(!models);
    try {
      const data = await api.chat.models.list();
      setModels(data);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [models]);

  async function handleSwitch(providerName: string, model: string) {
    setSwitching(`${providerName}::${model}`);
    try {
      const res = await api.chat.models.switch(providerName, model);
      if (!res.ok) return;
      // Refresh model list to get new current
      const data = await api.chat.models.list();
      setModels(data);
      setProvider(data.current?.name || providerName);
      setModel(data.current?.model || model);
      setOpen(false);
    } catch {
      // silently fail
    } finally {
      setSwitching(null);
    }
  }

  const displayName =
    currentModel.length > 24
      ? currentModel.slice(0, 22) + "..."
      : currentModel || currentProvider || "Model";

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) loadModels();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <span className="max-w-[140px] truncate">{displayName}</span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <p className="px-2 pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Models
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          </div>
        ) : models ? (
          <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
            {models.providers.map((p) => {
              const key = `${p.name}::${p.model}`;
              const isActive = p.name === currentProvider && p.model === currentModel;
              const isSwitching = switching === key;
              return (
                <button
                  key={key}
                  disabled={!p.available || isSwitching}
                  onClick={() => {
                    if (!isActive && p.available) handleSwitch(p.name, p.model);
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                    p.available
                      ? "hover:bg-muted/60"
                      : "cursor-not-allowed opacity-40",
                    isActive && "bg-primary/10"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-foreground">
                        {p.model}
                      </span>
                      {isActive && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.name}
                    </p>
                  </div>
                  {isSwitching ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Badge
                      variant={p.available ? "success" : "secondary"}
                      className="shrink-0 text-[10px] px-1.5 py-0"
                    >
                      {p.available ? "Ready" : "Unavailable"}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="px-2 py-4 text-center text-sm text-muted-foreground">
            No providers found
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
