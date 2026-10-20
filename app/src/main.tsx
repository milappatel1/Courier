import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { App } from "./App";
import { getState, init } from "./state/store";
import { ComposePage, EmlPage, PrintPage, ThreadPage } from "./Windows";

const q = new URLSearchParams(location.search);
const root = createRoot(document.getElementById("root")!);

if (q.get("compose")) root.render(<ComposePage id={q.get("compose")!} />);
else if (q.get("thread")) root.render(<ThreadPage id={q.get("thread")!} />);
else if (q.get("print")) root.render(<PrintPage id={q.get("print")!} />);
else if (q.get("eml")) root.render(<EmlPage id={q.get("eml")!} />);
else {
  console.info("[flash-probe] before render", document.documentElement.dataset.family ?? "(none)", getComputedStyle(document.body).backgroundColor);
  requestAnimationFrame(() =>
    console.info(
      "[flash-probe] first frame",
      document.documentElement.dataset.family ?? "(none)",
      getComputedStyle(document.querySelector(".app") ?? document.body).backgroundColor,
    ),
  );
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  void init().then(async () => {
    console.info(
      "[flash-probe] after init",
      document.documentElement.dataset.family ?? "(none)",
      getComputedStyle(document.querySelector(".app") ?? document.body).backgroundColor,
    );
    if (getState().info?.e2e || q.get("e2e") === "1") {
      const { runE2E } = await import("./e2e/run");
      void runE2E();
    }
  });
}
