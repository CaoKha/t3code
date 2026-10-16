import { ArrowLeftRightIcon } from "lucide-react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Swaps the diff file tree between the left and right of the diff. Render it only while the tree is open. */
export function FileTreeSideControl() {
  const side = useClientSettings((settings) => settings.fileTreeSide);
  const updateClientSettings = useUpdateClientSettings();
  const label = side === "left" ? "Move file tree to the right" : "Move file tree to the left";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            aria-label={label}
            variant="ghost"
            size="icon-sm"
            onClick={() =>
              updateClientSettings({ fileTreeSide: side === "left" ? "right" : "left" })
            }
          />
        }
      >
        <ArrowLeftRightIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
