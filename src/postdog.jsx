import { createRoot } from "react-dom/client";
import { Toaster } from "react-hot-toast";
import PostdogPanel from "./component/postdog/PostdogPanel";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <>
    <Toaster />
    <PostdogPanel />
  </>
);
