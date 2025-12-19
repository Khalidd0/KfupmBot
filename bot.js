const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) throw new Error("Missing TELEGRAM_TOKEN env var");

const bot = new TelegramBot(TOKEN, { polling: true });

// KFUPM Banner registration host (adjust if needed)
const BASE = "https://banner9-registration.kfupm.edu.sa";
const TERM_SEARCH_URL = `${BASE}/StudentRegistrationSsb/ssb/term/search`;
const SEARCH_URL = `${BASE}/StudentRegistrationSsb/ssb/searchResults/searchResults`;

// In-memory store: chatId -> array of tracked items
// item: { term, subject, courseNumber, section, crn, lastStatus }
const trackedByChat = new Map();

function normalizeSection(sec) {
  return String(sec).padStart(2, "0");
}

function getChatList(chatId) {
  if (!trackedByChat.has(chatId)) trackedByChat.set(chatId, []);
  return trackedByChat.get(chatId);
}

function esc(s) {
  // For MarkdownV2
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

async function bannerSearch(term, subject, courseNumber) {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true, timeout: 20000 }));

  // 1) declare term (creates session cookies)
  await client.post(
    TERM_SEARCH_URL,
    new URLSearchParams({
      term,
      studyPath: "",
      studyPathText: "",
      startDatepicker: "",
      endDatepicker: "",
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  // 2) fetch sections
  const resp = await client.get(SEARCH_URL, {
    params: {
      txt_subject: subject,
      txt_courseNumber: courseNumber,
      txt_term: term,
      startDatepicker: "",
      endDatepicker: "",
      pageOffset: 0,
      pageMaxSize: 50,
      sortColumn: "subjectDescription",
      sortDirection: "asc",
    },
  });

  const data = resp.data;
  if (!data || data.success !== true) return [];
  return data.data || [];
}

function computeStatus(bannerRow) {
  // Seats & flags vary slightly; these are common Banner fields:
  const seats = bannerRow?.seatsAvailable ?? null;
  const openSection = bannerRow?.openSection ?? false;

  const available = openSection === true && (seats === null || seats > 0);

  // Waiting list fields differ by school; we’ll show Closed unless explicitly true
  const waitOpen =
    bannerRow?.waitAvailable === true ||
    bannerRow?.waitCount > 0 ||
    bannerRow?.waitCapacity > 0;

  return {
    availableSeats: seats ?? 0,
    waitingListOpen: Boolean(waitOpen),
    isOpen: Boolean(available),
  };
}

function statusEmoji(isOpen) {
  return isOpen ? "🟢" : "🔴";
}

function renderTrackedMessage(items) {
  if (!items.length) return "Your tracking list is empty. Use /track";

  let text =
    "Here is the list of your currently tracked sections:\n\n" +
    "click on the CRN to copy it to your clipboard\n\n";

  for (const it of items) {
    // Example format: ENGL214-02 - 30577
    const line1 = `${esc(it.subject)}${esc(it.courseNumber)}-${esc(it.section)}  -  ${esc(it.crn)}`;
    const seatsLine = `Available Seats: ${esc(it.availableSeats ?? 0)}`;
    const waitLine = `Waiting list: ${statusEmoji(it.waitingListOpen)} ${it.waitingListOpen ? "Open" : "Closed"}`;

    text += `${line1}\n${seatsLine}\n${waitLine}\n\n`;
  }
  return text.trim();
}

function renderCRNKeyboard(items) {
  // One button per tracked item: tap -> bot replies with CRN to copy
  return {
    inline_keyboard: items.map((it) => [
      { text: `Copy CRN ${it.crn}`, callback_data: `COPYCRN:${it.crn}` },
    ]),
  };
}

// ----- Commands -----

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Commands:\n" +
      "/help\n" +
      "/tracked\n" +
      "/track <term> <subject> <courseNumber> <section> <crn>\n" +
      "/untrack <crn>\n" +
      "/clear"
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Commands:\n" +
      "/tracked - list tracked sections\n" +
      "/track <term> <subject> <courseNumber> <section> <crn>\n" +
      "   example: /track 252 ENGL 214 02 30577\n" +
      "/untrack <crn>\n" +
      "/clear"
  );
});

bot.onText(/\/track (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(/\s+/);
  if (parts.length !== 5) {
    return bot.sendMessage(chatId, "Usage: /track <term> <subject> <courseNumber> <section> <crn>");
  }

  const [term, subjectRaw, courseNumberRaw, sectionRaw, crnRaw] = parts;
  const subject = subjectRaw.toUpperCase();
  const courseNumber = String(courseNumberRaw);
  const section = normalizeSection(sectionRaw);
  const crn = String(crnRaw);

  const list = getChatList(chatId);

  // prevent duplicates by CRN
  if (list.some((x) => x.crn === crn)) {
    return bot.sendMessage(chatId, `CRN ${crn} is already tracked. Use /tracked`);
  }

  // Create item; status will be filled by poll
  list.push({
    term,
    subject,
    courseNumber,
    section,
    crn,
    availableSeats: 0,
    waitingListOpen: false,
    isOpen: false,
  });

  bot.sendMessage(chatId, `Added: ${subject}${courseNumber}-${section} - ${crn}`);
});

bot.onText(/\/untrack (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const crn = match[1].trim();

  const list = getChatList(chatId);
  const before = list.length;
  trackedByChat.set(chatId, list.filter((x) => x.crn !== crn));

  bot.sendMessage(chatId, before === trackedByChat.get(chatId).length ? "CRN not found." : `Removed CRN ${crn}.`);
});

bot.onText(/\/clear/, (msg) => {
  trackedByChat.set(msg.chat.id, []);
  bot.sendMessage(msg.chat.id, "Cleared your tracking list.");
});

bot.onText(/\/tracked/, (msg) => {
  const chatId = msg.chat.id;
  const list = getChatList(chatId);

  const text = renderTrackedMessage(list);
  const keyboard = list.length ? renderCRNKeyboard(list) : undefined;

  bot.sendMessage(chatId, text, {
    parse_mode: "MarkdownV2",
    reply_markup: keyboard,
  });
});

// Tap “Copy CRN …”
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data || "";

  if (data.startsWith("COPYCRN:")) {
    const crn = data.split(":")[1];
    await bot.answerCallbackQuery(q.id, { text: "Sent CRN 👇" });
    // send plain text so copying is easy
    await bot.sendMessage(chatId, `CRN: ${crn}`);
  } else {
    await bot.answerCallbackQuery(q.id);
  }
});

// ----- Polling loop -----
async function pollOnce() {
  for (const [chatId, list] of trackedByChat.entries()) {
    for (const it of list) {
      try {
        const rows = await bannerSearch(it.term, it.subject, it.courseNumber);

        // Match exact CRN + section
        const target = rows.find((r) => {
          const crn = String(r.courseReferenceNumber ?? "");
          const sec = normalizeSection(r.sequenceNumber ?? "");
          return crn === it.crn && sec === it.section;
        });

        if (!target) continue;

        const st = computeStatus(target);

        const becameOpen = st.isOpen && !it.isOpen;

        it.availableSeats = st.availableSeats;
        it.waitingListOpen = st.waitingListOpen;
        it.isOpen = st.isOpen;

        if (becameOpen) {
          await bot.sendMessage(
            chatId,
            `✅ OPEN: ${it.subject}${it.courseNumber}-${it.section} - ${it.crn}\nAvailable Seats: ${it.availableSeats}`
          );
        }
      } catch (e) {
        // keep quiet (avoid spam)
      }
    }
  }
}

// every 5 minutes (adjust as you like)
setInterval(pollOnce, 5 * 60 * 1000);
pollOnce();

console.log("Bot running...");
