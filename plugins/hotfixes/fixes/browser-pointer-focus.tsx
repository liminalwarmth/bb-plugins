import { useEffect, useState } from "react";
import {
  useRpc,
  type ExperimentalPluginBrowserToolbarActionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.js";

const FOCUS_REQUEST_TYPE = "bb-hotfix:browser-pointer-focus";

const INSTALL_LISTENER_EXPRESSION = `(() => {
  const key = "__bbHotfixBrowserPointerFocus";
  if (window[key]) return true;
  window[key] = true;
  const requestFocusIfUnfocused = () => {
    if (!document.hasFocus()) {
      bb.postMessage({ type: ${JSON.stringify(FOCUS_REQUEST_TYPE)} });
    }
  };
  window.addEventListener(
    "pointerdown",
    () => {
      requestFocusIfUnfocused();
      setTimeout(requestFocusIfUnfocused, 25);
    },
    true,
  );
  return true;
})()`;

interface BbDesktopBrowserWindow extends Window {
  bbDesktop?: {
    browser?: {
      focus?: (tabId: string) => void;
    };
  };
}

function isFocusRequestMessage(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === FOCUS_REQUEST_TYPE
  );
}

export function BrowserPointerFocusFix({
  tabId,
  url,
  experimental_page: page,
}: ExperimentalPluginBrowserToolbarActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    rpc
      .call("get_enabled", null)
      .then((result) => {
        if (!cancelled) {
          setEnabled(result.enabled.browserPointerFocus);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => {
    if (!enabled || page === null || url.length === 0) {
      return;
    }
    const desktopWindow = window as BbDesktopBrowserWindow;
    const unsubscribe = page.onMessage((data) => {
      if (isFocusRequestMessage(data)) {
        desktopWindow.bbDesktop?.browser?.focus?.(tabId);
      }
    });

    const install = () => {
      page.evaluate(INSTALL_LISTENER_EXPRESSION, { world: "isolated" }).catch(() => {});
    };

    install();
    const retryTimer = window.setTimeout(install, 400);
    const lateRetryTimer = window.setTimeout(install, 1500);

    return () => {
      window.clearTimeout(retryTimer);
      window.clearTimeout(lateRetryTimer);
      unsubscribe();
    };
  }, [enabled, page, tabId, url]);

  return null;
}
