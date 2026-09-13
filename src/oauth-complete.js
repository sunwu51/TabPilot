const params = new URLSearchParams(location.search);
const status = params.get("status") || "pending";
document.getElementById("title").textContent = status === "success"
  ? "OpenAI 登录成功"
  : (status === "error" ? "OpenAI 登录失败" : "正在完成登录...");
document.getElementById("message").textContent = status === "success"
  ? "凭据已经保存，可以关闭此页面并返回 TabPilot。"
  : (status === "error" ? (params.get("message") || "请返回 TabPilot 后重试。") : "正在交换登录凭据，请稍候。");
