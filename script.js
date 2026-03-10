const menuBtn = document.querySelector("[data-menu-btn]");
const nav = document.querySelector("[data-nav]");

if (menuBtn && nav) {
  menuBtn.addEventListener("click", () => {
    nav.classList.toggle("open");
  });
}

const accButtons = document.querySelectorAll("[data-acc]");
accButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const item = btn.closest(".acc-item");
    if (item) item.classList.toggle("open");
  });
});

const checks = document.querySelectorAll("[data-step-check]");
const status = document.querySelector("[data-step-status]");
const STORAGE_KEY = "pep-step-progress-v1";

function refreshProgress() {
  if (!checks.length || !status) return;
  const done = [...checks].filter((c) => c.checked).length;
  status.textContent = `${done} of ${checks.length} workflow checkpoints marked complete.`;
}

if (checks.length) {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  checks.forEach((check) => {
    if (saved[check.id]) check.checked = true;
    check.addEventListener("change", () => {
      const next = {};
      checks.forEach((c) => {
        next[c.id] = c.checked;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      refreshProgress();
    });
  });
  refreshProgress();
}
