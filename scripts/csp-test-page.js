const status = document.querySelector("#csp-status");
const counter = document.querySelector("#counter");
const result = document.querySelector("#result");
const increment = document.querySelector("#increment-button");
const reset = document.querySelector("#reset-button");

function probe(label, callback) {
  try {
    callback();
    return `${label}: unexpectedly allowed`;
  } catch (error) {
    return `${label}: blocked (${error.name})`;
  }
}

status.textContent = [
  probe("eval()", () => eval("1 + 1")),
  probe("Function()", () => new Function("return 1")),
  "Inline scripts are rejected by script-src 'self' (inspect DevTools Console to confirm)."
].join("\n");

increment.addEventListener("click", () => {
  counter.textContent = String(Number(counter.textContent) + 1);
  result.textContent = `Counter incremented to ${counter.textContent}.`;
});

reset.addEventListener("click", () => {
  counter.textContent = "0";
  result.textContent = "Counter reset.";
});
