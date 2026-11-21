let emails = [];
let activeId = null;
let openedMail = null;
let currentUserEmail = "";
let searchText = "";
let mailFilter = "all";
let mailSort = "newest";
const summarizingIds = new Set();

const inboxList = document.getElementById("inbox-list");
const summaryBox = document.getElementById("summary-box");
const fullBox = document.getElementById("full-box");
const syncBtn = document.getElementById("sync-btn");
const profileModal = document.getElementById("profile-modal");
const accountEmail = document.getElementById("account-email");
const filterBtns = document.querySelectorAll(".filter-btn");

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function setNote(box, text) {
  box.replaceChildren(makeEl("p", "empty-note", text));
}

async function apiFetch(url, options, fallback) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = "/UIUX/html/landing.html";
    return null;
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || fallback || "Request failed.");
  return data;
}

function getVisibleEmails() {
  const query = searchText.toLowerCase();
  const today = new Date().toDateString();
  const visible = [];
  for (const mail of emails) {
    if (mailFilter === "today" && (!mail.receivedAt || new Date(mail.receivedAt).toDateString() !== today)) continue;
    if (query) {
      const sender = (mail.sender || "").toLowerCase();
      const subject = (mail.subject || "").toLowerCase();
      if (!sender.includes(query) && !subject.includes(query)) continue;
    }
    visible.push(mail);
  }
  visible.sort((a, b) => {
    if (mailSort === "sender") return (a.sender || "").localeCompare(b.sender || "");
    const timeA = Date.parse(a.receivedAt) || 0;
    const timeB = Date.parse(b.receivedAt) || 0;
    if (mailSort === "oldest") return timeA - timeB;
    return timeB - timeA;
  });
  return visible;
}

function showInbox() {
  const prevScroll = inboxList.scrollTop;
  const visible = getVisibleEmails();
  if (visible.length === 0 && emails.length > 0) {
    inboxList.replaceChildren(makeEl("li", "empty-note", "No matching emails."));
    return;
  }
  inboxList.textContent = "";
  for (const mail of visible) {
    const item = makeEl("li");
    const btn = makeEl("button", mail.id === activeId ? "mail-btn active" : "mail-btn");
    btn.type = "button";
    const top = makeEl("div", "mail-top");
    top.append(makeEl("span", "mail-sender", mail.sender), makeEl("span", "mail-time", mail.time));
    btn.append(top, makeEl("div", "mail-subject", mail.subject));
    btn.onclick = () => selectMail(mail);
    item.append(btn);
    inboxList.append(item);
  }
  inboxList.scrollTop = prevScroll;
}

function showSummary() {
  const mail = emails.find((m) => m.id === activeId);
  if (!mail) {
    setNote(summaryBox, "No summarized emails yet.");
    return;
  }
  const list = makeEl("ul", "summary-list");
  if (Array.isArray(mail.points)) {
    for (const point of mail.points) list.append(makeEl("li", "", point));
  }
  const readBtn = makeEl("button", "read-btn", "Full Read");
  readBtn.type = "button";
  readBtn.onclick = () => loadFullMail(mail.id);
  summaryBox.replaceChildren(
    makeEl("h3", "mail-title", mail.subject),
    makeEl("p", "mail-meta", `${mail.sender} • ${mail.time}`),
    list,
    readBtn
  );
}

function showFullMail() {
  if (!openedMail) {
    setNote(fullBox, 'Select "Full Read" to view the entire email here.');
    return;
  }
  fullBox.replaceChildren(
    makeEl("h3", "mail-title", openedMail.subject),
    makeEl("p", "mail-meta full-meta", `From: ${openedMail.sender} • ${openedMail.time}`),
    makeEl("pre", "mail-body", openedMail.body)
  );
}

function selectMail(mail) {
  activeId = mail ? mail.id : null;
  openedMail = null;
  showInbox();
  showSummary();
  showFullMail();
  if (mail) summarizeOnDemand(mail);
}

const cacheKey = () => `kbail_cache_${currentUserEmail}`;

function saveCache() {
  if (!currentUserEmail) return;
  try { localStorage.setItem(cacheKey(), JSON.stringify(emails)); } catch {}
}

async function summarizeOnDemand(mail) {
  if (mail.summarized !== false || summarizingIds.has(mail.id)) return;
  summarizingIds.add(mail.id);
  mail.points = ["Generating summary..."];
  if (activeId === mail.id) showSummary();
  try {
    const data = await apiFetch(
      `/api/emails/${encodeURIComponent(mail.id)}/summarize`,
      { method: "POST" },
      "Could not generate summary."
    );
    if (!data) return;
    mail.points = Array.isArray(data.points) ? data.points : ["Summary unavailable for this message."];
    mail.summarized = true;
    saveCache();
  } catch (err) {
    mail.points = [err.message || "Summary unavailable for this message."];
  } finally {
    summarizingIds.delete(mail.id);
    if (activeId === mail.id) showSummary();
  }
}

async function loadFullMail(id) {
  setNote(fullBox, "Loading full email...");
  try {
    const data = await apiFetch(`/api/emails/${encodeURIComponent(id)}/full`, undefined, "Could not load email.");
    if (!data || activeId !== id) return;
    openedMail = data;
    showFullMail();
  } catch (err) {
    if (activeId === id) setNote(fullBox, err.message);
  }
}

async function loadEmails(isSync) {
  if (!isSync) setNote(summaryBox, "Loading summaries...");
  const cachedMap = {};
  const cachedIds = [];
  let url = "/api/emails";
  let options = {};
  if (isSync) {
    for (const item of emails) {
      cachedMap[item.id] = item;
      if (item.summarized) cachedIds.push(item.id);
    }
    url = "/api/sync";
    options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cachedIds }) };
  }
  try {
    const data = await apiFetch(url, options, "Failed to load emails.");
    if (!data) return;
    const incoming = Array.isArray(data.emails) ? data.emails : [];
    for (const mail of incoming) {
      const prev = cachedMap[mail.id];
      if (mail.summarized === false && prev && prev.summarized) {
        mail.points = prev.points;
        mail.summarized = true;
      }
    }
    emails = incoming;
    saveCache();
    selectMail(emails[0]);
  } catch (err) {
    setNote(summaryBox, err.message);
  }
}

async function init() {
  try {
    const me = await apiFetch("/api/me");
    if (!me) return;
    currentUserEmail = me.email || "Connected";
    accountEmail.textContent = currentUserEmail;
    try {
      const parsed = JSON.parse(localStorage.getItem(cacheKey()) || "[]");
      if (Array.isArray(parsed) && parsed.length > 0) {
        emails = parsed;
        selectMail(emails[0]);
        return;
      }
    } catch {}
    await loadEmails(false);
  } catch {
    window.location.href = "/UIUX/html/landing.html";
  }
}

const closeProfile = () => profileModal.classList.add("hidden");
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
document.querySelector(".logout-btn").onclick = () => { if (currentUserEmail) localStorage.removeItem(cacheKey()); };
document.querySelector(".settings-btn").onclick = () => profileModal.classList.remove("hidden");
document.getElementById("close-profile").onclick = closeProfile;
profileModal.onclick = (e) => { if (e.target === profileModal) closeProfile(); };
document.onkeydown = (e) => { if (e.key === "Escape") closeProfile(); };
document.getElementById("mail-search").oninput = (e) => { searchText = e.target.value.trim(); showInbox(); };
document.getElementById("mail-sort").onchange = (e) => { mailSort = e.target.value; showInbox(); };
for (const btn of filterBtns) {
  btn.onclick = () => {
    mailFilter = btn.dataset.filter;
    for (const other of filterBtns) other.classList.toggle("active", other === btn);
    showInbox();
  };
}

init();
