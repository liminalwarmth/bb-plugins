import { useEffect, useState } from "react";
import {
  useRpc,
  type ExperimentalPluginBrowserToolbarActionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.js";

const INSTALL_NO_DRAG_EXPRESSION = `(() => {
  const STYLE_ID = "bb-hotfix-browser-no-drag";
  const CSS = "*, *::before, *::after { -webkit-app-region: no-drag !important; app-region: no-drag !important; }";
  const applyToDocument = (doc) => {
    if (!doc) return;
    let style = doc.getElementById(STYLE_ID);
    if (!style) {
      style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      (doc.head || doc.documentElement)?.appendChild(style);
    } else if (style.textContent !== CSS) {
      style.textContent = CSS;
    }
    for (const frame of doc.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) applyToDocument(frame.contentDocument);
      } catch {}
    }
  };
  applyToDocument(document);
  if (!window.__bbHotfixNoDragObserver && document.documentElement) {
    window.__bbHotfixNoDragObserver = new MutationObserver(() => {
      if (!document.getElementById(STYLE_ID)) applyToDocument(document);
    });
    window.__bbHotfixNoDragObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  return true;
})()`;

export function BrowserNoDragFix({
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
          setEnabled(result.enabled.browserNoDrag);
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
    const install = () => {
      page.evaluate(INSTALL_NO_DRAG_EXPRESSION, { world: "isolated" }).catch(() => {});
    };
    install();
    const t1 = window.setTimeout(install, 250);
    const t2 = window.setTimeout(install, 1000);
    const t3 = window.setTimeout(install, 2500);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [enabled, page, url]);

  return null;
}
