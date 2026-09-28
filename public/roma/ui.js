"use strict";
// Existing shared chat and privacy-safe analytics are reused unchanged.
const resetChatButton = document.getElementById("reset-chat");
resetChatButton.addEventListener("click", () => {
  if (sendButton.disabled || !config) return;
  messages.replaceChildren();
  addMessage(config.greeting, "bot");
  if (typeof renderDemoFlowLauncher === "function") renderDemoFlowLauncher();
  input.value = "";
  input.focus();
});
