import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { HOTFIX_REGISTRY, type HotfixId } from "./fixes/registry.js";

const enabledSchema = z.object({
  browserNoDrag: z.boolean(),
  browserPointerFocus: z.boolean(),
});

export const rpcContract = defineRpcContract({
  get_enabled: {
    input: z.null(),
    output: z.object({
      enabled: enabledSchema,
    }),
  },
});

function findFix(id: HotfixId) {
  const fix = HOTFIX_REGISTRY.find((entry) => entry.id === id);
  if (!fix) throw new Error(`Missing hotfix definition: ${id}`);
  return fix;
}

export default async function plugin(bb: BbPluginApi) {
  const noDrag = findFix("browserNoDrag");
  const pointerFocus = findFix("browserPointerFocus");

  const settings = bb.settings.define({
    browserNoDrag: {
      type: "boolean",
      label: noDrag.label,
      description: `${noDrag.description} (${noDrag.upstreamRef})`,
      default: noDrag.defaultEnabled,
    },
    browserPointerFocus: {
      type: "boolean",
      label: pointerFocus.label,
      description: `${pointerFocus.description} (${pointerFocus.upstreamRef})`,
      default: pointerFocus.defaultEnabled,
    },
  });

  const current = await settings.get();
  const enabled: Record<HotfixId, boolean> = {
    browserNoDrag: current.browserNoDrag,
    browserPointerFocus: current.browserPointerFocus,
  };

  bb.rpc.register(rpcContract, {
    get_enabled: async () => ({ enabled }),
  });

  bb.log.info(
    `loaded hotfixes: ${HOTFIX_REGISTRY.filter((fix) => enabled[fix.id])
      .map((fix) => fix.id)
      .join(", ") || "none"}`,
  );
}
