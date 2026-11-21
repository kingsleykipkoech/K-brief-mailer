let emails = [];
let activeId = null;
let openedMail = null;

const $ = (s) => document.querySelector(s);
const inboxList = $("#inbox-list");
const summaryBox = $("#summary-box");
const fullBox = $("#full-box");
const syncBtn = $("#sync-btn");
const profileModal = $("#profile-modal");
const accountEmail = $("#account-email");

const make = (tag, className, text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const setNote = (el, text) => el.replaceChildren(make("p", "empty-note", text));

async function apiFetch(url, options = {}, fallback = "Request failed.") {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = "/UIUX/html/landing.html";
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || fallback);
  return data;
}

function showInbox() {
  const prevScroll = inboxList.scrollTop;
  const items = emails.map((mail) => {
    const item = make("li");
    const btn = make("button", mail.id === activeId ? "mail-btn active" : "mail-btn");
    btn.type = "button";

    const top = make("div", "mail-top");
    top.append(make("span", "mail-sender", mail.sender), make("span", "mail-time", mail.time));

    btn.append(top, make("div", "mail-subject", mail.subject));
    btn.onclick = () => {
      activeId = mail.id;
      openedMail = null;
      draw();
      summarizeOnDemand(mail);
    };

    item.append(btn);
    return item;
  });
  inboxList.replaceChildren(...items);
  inboxList.scrollTop = prevScroll;
}

function showSummary() {
  const mail = emails.find((m) => m.id === activeId);
  if (!mail) return setNote(summaryBox, "No summarized emails yet.");

  const list = make("ul", "summary-list");
  mail.points.forEach((p) => list.append(make("li", "", p)));

  const readBtn = make("button", "read-btn", "Full Read");
  readBtn.type = "button";
  readBtn.onclick = () => loadFullMail(mail.id);

  summaryBox.replaceChildren(
    make("h3", "mail-title", mail.subject),
    make("p", "mail-meta", `${mail.sender} • ${mail.time}`),
    list,
    readBtn
  );
}

function showFullMail() {
  if (!openedMail) return setNote(fullBox, 'Select "Full Read" to view the entire email here.');
  fullBox.replaceChildren(
    make("h3", "mail-title", openedMail.subject),
    make("p", "mail-meta full-meta", `From: ${openedMail.sender} • ${openedMail.time}`),
    make("pre", "mail-body", openedMail.body)
  );
}

function draw() {
  showInbox();
  showSummary();
  showFullMail();
}

async function summarizeOnDemand(mail) {
  if (mail.summarized !== false || mail._summarizing) return;
  mail._summarizing = true;
  mail.points = ["Generating summary..."];
  if (activeId === mail.id) showSummary();
  try {
    const data = await apiFetch(`/api/emails/${mail.id}/summarize`, { method: "POST" }, "Could not generate summary.");
    if (!data) return;
    mail.points = Array.isArray(data.points) ? data.points : ["Summary unavailable for this message."];
    mail.summarized = true;
  } catch (err) {
    mail.points = [err.message || "Summary unavailable for this message."];
  } finally {
    mail._summarizing = false;
    if (activeId === mail.id) showSummary();
  }
}

async function loadFullMail(id) {
  setNote(fullBox, "Loading full email...");
  try {
    const data = await apiFetch(`/api/emails/${id}/full`, {}, "Could not load email.");
    if (!data || activeId !== id) return;
    openedMail = data;
    showFullMail();
  } catch (err) {
    if (activeId === id) setNote(fullBox, err.message);
  }
}

async function loadEmails(isSync = false) {
  if (!isSync) setNote(summaryBox, "Loading summaries...");
  try {
    const data = await apiFetch(isSync ? "/api/sync" : "/api/emails", { method: isSync ? "POST" : "GET" }, "Failed to load emails.");
    if (!data) return;
    emails = Array.isArray(data.emails) ? data.emails : [];
    activeId = emails.length ? emails[0].id : null;
    openedMail = null;
    draw();
    if (emails.length) summarizeOnDemand(emails[0]);
  } catch (err) {
    setNote(summaryBox, err.message);
  }
}

async function init() {
  try {
    const me = await apiFetch("/api/me");
    if (!me) return;
    accountEmail.textContent = me.email || "Connected";
    await loadEmails(false);
  } catch {
    window.location.href = "/UIUX/html/landing.html";
  }
}

syncBtn.onclick = async () => {
  syncBtn.textContent = "Syncing...";
  syncBtn.disabled = true;
  try {
    await loadEmails(true);
  } finally {
    syncBtn.textContent = "SYNC mail";
    syncBtn.disabled = false;
  }
};

$(".settings-btn").onclick = () => profileModal.classList.remove("hidden");
$("#close-profile").onclick = () => profileModal.classList.add("hidden");
profileModal.onclick = (e) => {
  if (e.target === profileModal) profileModal.classList.add("hidden");
};
document.onkeydown = (e) => {
  if (e.key === "Escape") profileModal.classList.add("hidden");
};

init();
