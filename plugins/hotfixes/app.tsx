import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BrowserNoDragFix } from "./fixes/browser-no-drag.js";
import { BrowserPointerFocusFix } from "./fixes/browser-pointer-focus.js";

export default definePluginApp((app) => {
  app.slots.experimental_browserToolbarAction({
    id: "browser-no-drag",
    title: "Hotfix: Desktop Browser no-drag",
    component: BrowserNoDragFix,
  });
  app.slots.experimental_browserToolbarAction({
    id: "browser-pointer-focus",
    title: "Hotfix: Desktop Browser pointer focus",
    component: BrowserPointerFocusFix,
  });
});
