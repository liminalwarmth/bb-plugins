export interface HotfixDefinition {
  id: HotfixId;
  label: string;
  description: string;
  upstreamRef: string;
  defaultEnabled: boolean;
}

export const HOTFIX_IDS = ["browserNoDrag", "browserPointerFocus"] as const;
export type HotfixId = (typeof HOTFIX_IDS)[number];

export const HOTFIX_REGISTRY: readonly HotfixDefinition[] = [
  {
    id: "browserNoDrag",
    label: "Desktop Browser: disable page -webkit-app-region: drag",
    description:
      "Overrides page CSS -webkit-app-region / app-region with no-drag so Electron-targeted sites like Linear don't turn issue panes into BB window drag handles.",
    upstreamRef: "get-bb/bb#5862",
    defaultEnabled: true,
  },
  {
    id: "browserPointerFocus",
    label: "Desktop Browser: focus tab on pointer press",
    description:
      "Ensures clicking inside an unfocused desktop Browser tab transfers native keyboard focus to the page.",
    upstreamRef: "get-bb/bb#8030",
    defaultEnabled: true,
  },
];
