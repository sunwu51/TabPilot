import { createRoot } from "react-dom/client";
import { Toaster } from "react-hot-toast";
import PostdogPanel from "./component/postdog/PostdogPanel";
import { LocaleProvider } from "./i18n";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <LocaleProvider>
    <Toaster position="bottom-right" />
    <PostdogPanel />
  </LocaleProvider>
);
